// ─── BILLING (STRIPE) ─────────────────────────────────────────────────────────
// Subscriptions through Stripe Checkout and the Stripe customer portal, called
// over Stripe's REST API with the HTTP client we already use (no SDK).
//
//   1. POST /api/billing/checkout {plan, interval} → we create (once) a Stripe
//      customer for the user, then a Checkout Session for that plan's price
//      (Pro monthly STRIPE_PRICE_ID, Pro annual STRIPE_PRICE_ANNUAL_ID, Plus
//      STRIPE_PLUS_PRICE_ID and STRIPE_PLUS_PRICE_ANNUAL_ID); the app redirects.
//      A plan whose price id is not set is not on sale.
//   2. Stripe posts subscription events to /api/billing/webhook; we verify the
//      signature and copy status + period end onto the user.
//   3. POST /api/billing/portal → a portal session where they manage or cancel.
//
// Entitlement is read from the user record (auth.isPro, auth.tierOf), which
// only webhooks write: the tier comes from the price on the subscription, never
// from what the browser asked for. The browser can't grant itself anything.

const crypto = require('crypto');

const STRIPE = 'https://api.stripe.com/v1';

// Shown by Stripe above the subscribe button (max 1200 characters).
function renewalNotice(base) {
  const b = String(base).replace(/\/$/, '');
  return `Your subscription renews automatically at the price above each billing period until you cancel. Cancel anytime in Billing in the app; you keep access until the end of the period you paid for. By subscribing you agree to the Terms (${b}/terms) and the Refund Policy (${b}/refunds).`;
}

// Stripe takes form-encoded bodies with bracketed keys: line_items[0][price]=…
function form(obj, prefix = '', out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    if (v == null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object' && !Array.isArray(v)) form(v, key, out);
    else if (Array.isArray(v)) v.forEach((item, i) => (typeof item === 'object' ? form(item, `${key}[${i}]`, out) : out.append(`${key}[${i}]`, String(item))));
    else out.append(key, String(v));
  }
  return out;
}

// Stripe-Signature: t=<unix>,v1=<hex>[,v1=<hex>…]; signed payload is "<t>.<raw body>"
function verifyWebhook(rawBody, header, secret, { toleranceSec = 300, now = Date.now() } = {}) {
  if (!secret) throw new Error('Webhook secret not configured');
  const parts = String(header || '').split(',').map(p => p.split('='));
  const t = parts.find(([k]) => k === 't')?.[1];
  const sigs = parts.filter(([k]) => k === 'v1').map(([, v]) => v);
  if (!t || !/^\d{1,12}$/.test(t) || !sigs.length) throw new Error('Malformed Stripe-Signature header');
  if (Math.abs(now / 1000 - parseInt(t)) > toleranceSec) throw new Error('Webhook timestamp outside tolerance');
  const payload = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody);
  const want = crypto.createHmac('sha256', secret).update(`${t}.${payload}`).digest();
  const ok = sigs.some(s => {
    const got = Buffer.from(s, 'hex');
    return got.length === want.length && crypto.timingSafeEqual(got, want);
  });
  if (!ok) throw new Error('Webhook signature mismatch');
  return JSON.parse(payload);
}

// The plans on sale and their Stripe price ids. Pro monthly is required
// (configured() is false without it); every other price is optional and its
// plan or interval is simply not offered until its id is set.
const INTERVALS = ['month', 'year'];
const PAID_TIERS = ['plus', 'pro'];
function priceCatalog({ priceId = null, annualPriceId = null, plusPriceId = null, plusAnnualPriceId = null } = {}) {
  const clean = v => (typeof v === 'string' && v.trim() ? v.trim() : null);
  return { pro: { month: clean(priceId), year: clean(annualPriceId) }, plus: { month: clean(plusPriceId), year: clean(plusAnnualPriceId) } };
}

// introPriceId (optional): the founding price (Pro monthly only), used for
// checkout while introOpen() says seats are left. Stripe's own amounts are read
// once an hour (prices()), so the pricing page shows what Stripe will charge.
function createBilling({ http, secretKey, priceId, annualPriceId = null, plusPriceId = null, plusAnnualPriceId = null, introPriceId = null, introOpen = async () => false, store, trialDays = 0, log = console, now = () => Date.now() }) {
  const headers = () => ({ Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/x-www-form-urlencoded' });
  const post = async (path, body) => (await http.post(`${STRIPE}${path}`, form(body).toString(), { headers: headers(), timeout: 15000 })).data;
  const catalog = priceCatalog({ priceId, annualPriceId, plusPriceId, plusAnnualPriceId });
  const configured = () => !!(secretKey && catalog.pro.month);
  // which plan and interval can be bought: { pro: { month: true, year: false }, plus: {...} }
  const onSale = () => Object.fromEntries(PAID_TIERS.map(t => [t, Object.fromEntries(INTERVALS.map(i => [i, configured() && !!catalog[t][i]]))]));
  // a price id on a subscription → { tier, interval }; the founding price is Pro
  // monthly. An id we don't know (one made by hand in Stripe) counts as Pro,
  // which is what every subscription was before tiers.
  function planOfPrice(id) {
    if (id && introPriceId && id === introPriceId) return { tier: 'pro', interval: 'month', known: true };
    for (const t of PAID_TIERS) for (const i of INTERVALS) if (id && catalog[t][i] === id) return { tier: t, interval: i, known: true };
    return { tier: 'pro', interval: null, known: false };
  }
  const priceCache = new Map();   // id → { at, value }
  // { amount (major units), currency, interval } or null; never throws
  async function priceOf(id) {
    if (!secretKey || !id) return null;
    const hit = priceCache.get(id);
    if (hit && now() - hit.at < 3600e3) return hit.value;
    try {
      const p = (await http.get(`${STRIPE}/prices/${encodeURIComponent(id)}`, { headers: headers(), timeout: 10000 })).data || {};
      const value = Number.isFinite(p.unit_amount) ? { amount: p.unit_amount / 100, currency: String(p.currency || 'usd'), interval: p.recurring?.interval || null, active: p.active !== false } : null;
      priceCache.set(id, { at: now(), value });
      return value;
    } catch (e) {
      log.warn?.(`Billing: could not read price ${id}: ${e.response?.data?.error?.message || e.message}`);
      priceCache.set(id, { at: now() - 3300e3, value: hit?.value || null });   // retry in 5 minutes
      return hit?.value || null;
    }
  }
  // main/intro: Pro monthly and the founding price (as before); the rest by plan
  async function prices() {
    const [main, intro, proYear, plusMonth, plusYear] = await Promise.all([priceOf(catalog.pro.month), introPriceId ? priceOf(introPriceId) : null,
      priceOf(catalog.pro.year), priceOf(catalog.plus.month), priceOf(catalog.plus.year)]);
    return { main, intro, pro: { month: main, year: proYear }, plus: { month: plusMonth, year: plusYear } };
  }

  async function ensureCustomer(user) {
    if (user.stripeCustomerId) return user.stripeCustomerId;
    const c = await post('/customers', { email: user.email, metadata: { user_id: user.id } });
    user.stripeCustomerId = c.id;
    await store.put(user);
    return c.id;
  }

  // plan: 'plus' | 'pro'; interval: 'month' | 'year'. Anything else, or a
  // price that is not set, is a 400: checkout never guesses a price.
  async function checkout(user, { successUrl, cancelUrl, legalUrl = null, plan = 'pro', interval = 'month' } = {}) {
    if (!configured()) throw Object.assign(new Error('Billing is not set up yet'), { status: 503 });
    if (!PAID_TIERS.includes(plan) || !INTERVALS.includes(interval)) throw Object.assign(new Error('Pick Plus or Pro, monthly or annual'), { status: 400 });
    const price = catalog[plan][interval];
    if (!price) throw Object.assign(new Error(`${plan === 'plus' ? 'Plus' : 'Pro'} ${interval === 'year' ? 'annual' : 'monthly'} is not on sale yet`), { status: 400 });
    // a second checkout on a live subscription would charge twice: switching
    // plan or interval happens in Billing (Stripe's portal), which prorates
    if (user.subscriptionId && ['active', 'trialing', 'past_due'].includes(user.planStatus)) throw Object.assign(new Error('This account already has a paid plan. Change or cancel it in Billing.'), { status: 409, billing: true });
    const customer = await ensureCustomer(user);
    // the founding price while seats are left, on Pro monthly only (an account
    // that paid before pays the full price)
    const founding = plan === 'pro' && interval === 'month' && !!introPriceId && !user.subscriptionId && await introOpen(user);
    const session = await post('/checkout/sessions', {
      mode: 'subscription', customer, client_reference_id: user.id,
      line_items: [{ price: founding ? introPriceId : price, quantity: 1 }],
      metadata: { plan, interval, ...(founding ? { founding: '1' } : {}) },
      success_url: successUrl, cancel_url: cancelUrl,
      allow_promotion_codes: 'true',
      // the automatic-renewal terms, right above the pay button (state
      // auto-renewal laws want them clear and next to the consent)
      ...(legalUrl ? { custom_text: { submit: { message: renewalNotice(legalUrl) } } } : {}),
      ...(trialDays > 0 ? { subscription_data: { trial_period_days: trialDays } } : {}),
    });
    return { url: session.url, id: session.id, plan, interval, founding };
  }

  async function portal(user, { returnUrl }) {
    if (!configured()) throw Object.assign(new Error('Billing is not set up yet'), { status: 503 });
    if (!user.stripeCustomerId) throw Object.assign(new Error('No subscription on this account yet'), { status: 400 });
    const s = await post('/billing_portal/sessions', { customer: user.stripeCustomerId, return_url: returnUrl });
    return { url: s.url };
  }

  // Apply a verified webhook event. Returns what changed, for logs and tests.
  async function handleEvent(event) {
    const obj = event?.data?.object || {};
    switch (event?.type) {
      case 'checkout.session.completed': {
        // link the customer if the account didn't have one recorded yet
        const user = obj.client_reference_id ? await store.get(obj.client_reference_id) : null;
        if (user && obj.customer && user.stripeCustomerId !== obj.customer) {
          user.stripeCustomerId = obj.customer;
          await store.put(user);
          return { linked: user.id };
        }
        return { ignored: 'already linked' };
      }
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        const user = await store.byCustomer(obj.customer);
        if (!user) { log.warn?.(`Billing: no user for customer ${obj.customer}`); return { ignored: 'unknown customer' }; }
        // Stripe doesn't guarantee delivery order and retries late; never let an
        // older event (e.g. an 'active' update) overwrite a newer one (a deletion).
        const created = Number(event.created);
        if (isFinite(created) && created > 0 && user.lastEventAt != null) {
          const stale = created < user.lastEventAt
            // same second: a deletion of this subscription wins over an update
            || (created === user.lastEventAt && event.type !== 'customer.subscription.deleted'
                && user.planStatus === 'canceled' && user.subscriptionId === obj.id);
          if (stale) return { ignored: 'stale event', user: user.id };
        }
        if (isFinite(created) && created > 0) user.lastEventAt = created;
        // the tier is whatever price the subscription is on now (a switch in
        // the portal arrives as an update with the new price)
        const item = (obj.items?.data || []).find(i => i?.price?.id) || null;
        const priced = planOfPrice(item?.price?.id || obj.plan?.id || null);
        if (!priced.known && event.type !== 'customer.subscription.deleted') log.warn?.(`Billing: price ${item?.price?.id || obj.plan?.id || 'none'} is not one of ours; counted as Pro`);
        user.plan = event.type === 'customer.subscription.deleted' ? 'free' : priced.tier;
        user.planInterval = event.type === 'customer.subscription.deleted' ? null : (priced.interval || item?.price?.recurring?.interval || null);
        user.planStatus = event.type === 'customer.subscription.deleted' ? 'canceled' : obj.status;
        user.subscriptionId = obj.id;
        // a founding seat is taken for good once a subscription on the intro price exists
        if (introPriceId && event.type !== 'customer.subscription.deleted' && (obj.items?.data || []).some(i => i?.price?.id === introPriceId)) user.founding = true;
        // cancelled in the portal but still inside the paid period
        user.cancelAtPeriodEnd = event.type !== 'customer.subscription.deleted' && !!obj.cancel_at_period_end;
        // after a deletion the paid period is over; don't keep honouring it
        user.currentPeriodEnd = event.type === 'customer.subscription.deleted' || !obj.current_period_end
          ? null : new Date(obj.current_period_end * 1000).toISOString();
        await store.put(user);
        return { user: user.id, status: user.planStatus };
      }
      default:
        return { ignored: event?.type || 'unknown' };
    }
  }

  return { checkout, portal, handleEvent, configured, onSale, planOfPrice, prices, priceOf };
}

module.exports = { createBilling, verifyWebhook, form, renewalNotice, priceCatalog, INTERVALS, PAID_TIERS };
