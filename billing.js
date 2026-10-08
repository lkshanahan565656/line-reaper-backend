// ─── BILLING (STRIPE) ─────────────────────────────────────────────────────────
// Subscriptions through Stripe Checkout and the Stripe customer portal, called
// over Stripe's REST API with the HTTP client we already use (no SDK).
//
//   1. POST /api/billing/checkout → we create (once) a Stripe customer for the
//      user, then a Checkout Session for STRIPE_PRICE_ID; the app redirects.
//   2. Stripe posts subscription events to /api/billing/webhook; we verify the
//      signature and copy status + period end onto the user.
//   3. POST /api/billing/portal → a portal session where they manage or cancel.
//
// Entitlement is read from the user record (auth.isPro), which only webhooks
// write. The browser can't grant itself anything.

const crypto = require('crypto');

const STRIPE = 'https://api.stripe.com/v1';

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
  if (!t || !sigs.length) throw new Error('Malformed Stripe-Signature header');
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

function createBilling({ http, secretKey, priceId, store, trialDays = 0, log = console }) {
  const headers = () => ({ Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/x-www-form-urlencoded' });
  const post = async (path, body) => (await http.post(`${STRIPE}${path}`, form(body).toString(), { headers: headers(), timeout: 15000 })).data;
  const configured = () => !!(secretKey && priceId);

  async function ensureCustomer(user) {
    if (user.stripeCustomerId) return user.stripeCustomerId;
    const c = await post('/customers', { email: user.email, metadata: { user_id: user.id } });
    user.stripeCustomerId = c.id;
    await store.put(user);
    return c.id;
  }

  async function checkout(user, { successUrl, cancelUrl }) {
    if (!configured()) throw Object.assign(new Error('Billing is not set up yet'), { status: 503 });
    const customer = await ensureCustomer(user);
    const session = await post('/checkout/sessions', {
      mode: 'subscription', customer, client_reference_id: user.id,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: successUrl, cancel_url: cancelUrl,
      allow_promotion_codes: 'true',
      ...(trialDays > 0 ? { subscription_data: { trial_period_days: trialDays } } : {}),
    });
    return { url: session.url, id: session.id };
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
        user.plan = event.type === 'customer.subscription.deleted' ? 'free' : 'pro';
        user.planStatus = event.type === 'customer.subscription.deleted' ? 'canceled' : obj.status;
        user.subscriptionId = obj.id;
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

  return { checkout, portal, handleEvent, configured };
}

module.exports = { createBilling, verifyWebhook, form };
