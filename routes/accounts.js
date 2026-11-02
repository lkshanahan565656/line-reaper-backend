// Accounts, billing, account sync and plans endpoints
// Moved out of server.js as it was (the route split): mount(ctx) runs where
// the section used to be, so routes keep their order. ctx carries what the
// section reads from server.js; it returns what server.js reads back.
'use strict';

module.exports = function mount(ctx) {
// ctx.claims and ctx.closeBoardFor mount just below (routes/evroutes.js) and
// ctx.evBookProven is replaced on refresh: read per request
const {
  PAYWALL, SYNC, acctSync, app, auth, billing, legal, planOfReq,
  plans, priceNow, publicUser, push, refreshPrices, requireAdmin, security, siteOrigin,
  webhookLicence
} = ctx;

const sendErr = (res, e) => res.status(e.status || 500).json({ error: e.status ? e.message : 'Something went wrong' });

// guessing passwords: per address, and per email whatever the address
const loginByIp = security.createWindowLimiter({ limit: 20, windowMs: 15 * 60e3 });
const loginFailsByEmail = security.createWindowLimiter({ limit: 10, windowMs: 60 * 60e3 });
const signupByIp = security.createWindowLimiter({ limit: 5, windowMs: 60 * 60e3 });
const emailKey = e => (typeof e === 'string' ? e.trim().toLowerCase().slice(0, 254) : '');
app.post('/api/auth/signup', async (req, res) => {
  const lim = security.isLocal(req) ? { ok: true } : signupByIp.take(security.callerIp(req));
  if (!lim.ok) return security.tooMany(res, lim, `Too many new accounts from this address. Try again in ${Math.ceil(lim.retryAfter / 60)} min.`);
  try {
    const consent = { terms: req.body?.acceptTerms === true, age: req.body?.confirmAge === true, version: req.body?.termsVersion, ip: (req.get('x-forwarded-for') || '').split(',')[0].trim() || req.ip };
    res.status(201).json(await auth.signup(req.body?.email, req.body?.password, consent));
  }
  catch (e) { sendErr(res, e); }
});
app.post('/api/auth/login', async (req, res) => {
  const email = emailKey(req.body?.email);
  const local = security.isLocal(req);
  const lim = local ? { ok: true } : loginByIp.take(security.callerIp(req));
  const fails = email && !local ? loginFailsByEmail.peek(email) : 0;
  if (!lim.ok || fails >= 10) return security.tooMany(res, lim.ok ? { retryAfter: 900 } : lim, 'Too many sign-in attempts. Wait a few minutes and try again.');
  try { const out = await auth.login(req.body?.email, req.body?.password); if (email) loginFailsByEmail.reset(email); res.json(out); }
  catch (e) { if (e.status === 401 && email) loginFailsByEmail.take(email); sendErr(res, e); }
});
// Delete your own account (privacy rights). Needs the password, and a paid
// subscription has to be cancelled first so nobody is billed for a deleted account.
app.post('/api/auth/delete', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Log in first' });
  try {
    const out = await auth.deleteAccount(req.user, req.body?.password);
    // the synced bets and settings go with it, and its devices stop following it
    await acctSync.remove(req.user.id).catch(e => console.warn(`Sync: delete failed: ${e.message}`));
    await push.unlinkUser(req.user.id).catch(() => {});
    res.json(out);
  }
  catch (e) { sendErr(res, e); }
});

// ── ACCOUNT SYNC ──────────────────────────────────────────────────────────────
// The signed-in user's own bets, slips, favorites, saved views, layout and
// alert kinds (acctsync.js KEYS). Private to that user: every route reads
// req.user and nothing else, and no route lists or shares documents.
app.get('/api/sync/status', (req, res) => res.json({
  enabled: SYNC.enabled, reason: SYNC.reason, store: SYNC.store, signedIn: !!req.user,
  keys: require('../acctsync').KEY_LIST.map(k => ({ key: k, label: require('../acctsync').KEYS[k].label })),
}));
const syncGate = (req, res, next) => {
  if (!SYNC.enabled) return res.status(503).json({ error: SYNC.reason });
  if (!req.user) return res.status(401).json({ error: 'Sign in to sync' });
  res.set('Cache-Control', 'no-store');
  next();
};
app.get('/api/sync', syncGate, async (req, res) => {
  try { res.json(await acctSync.get(req.user.id)); } catch (e) { console.warn(`Sync: read failed: ${e.message}`); sendErr(res, e); }
});
app.put('/api/sync', syncGate, async (req, res) => {
  try { res.json(await acctSync.put(req.user.id, req.body || {})); }
  catch (e) {
    if (e.status === 409) return res.status(409).json({ error: e.message, current: e.current });
    if (!e.status) console.warn(`Sync: write failed: ${e.message}`);
    sendErr(res, e);
  }
});
// this account's alert devices (labels only), and this device joining the account
app.post('/api/sync/devices', syncGate, async (req, res) => {
  try {
    const endpoint = typeof req.body?.endpoint === 'string' ? req.body.endpoint : '';
    if (endpoint) await push.link(endpoint, req.user.id);
    res.json({ devices: await push.accountDevices(req.user.id, endpoint) });
  } catch (e) { sendErr(res, e); }
});
// the terms version the app asks people to accept
app.get('/api/legal', (req, res) => res.json({ termsVersion: legal.TERMS_VERSION, minAge: legal.MIN_AGE, pages: legal.ORDER.map(k => ({ slug: k, path: `/${k}`, title: legal.PAGES[k].title })) }));
app.get('/api/auth/me', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not logged in' });
  res.json({ user: publicUser(req.user), paywall: PAYWALL, billing: billing.configured(), plan: planOfReq(req), limits: plans.limitsOf(planOfReq(req)) });
});
// ── PLANS (plans.js): what Free and Pro get, the price, and this viewer's plan ──
app.get('/api/plans', async (req, res) => {
  await refreshPrices();
  res.set('Cache-Control', 'no-store').json(plans.plansBody({ paywall: PAYWALL, billingConfigured: billing.configured(), price: priceNow(),
    viewerPlan: planOfReq(req), signedIn: !!req.user }));
});
const pricingMemo = require('../ops').createMemo({ ttlMs: 60e3, max: 4 });
// read Stripe's prices once soon after boot, so the first visitor sees them
if (billing.configured()) setTimeout(() => refreshPrices(), 20e3).unref?.();
app.get('/pricing', async (req, res) => {
  try {
    await refreshPrices();
    const origin = siteOrigin(req);
    const html = await pricingMemo(origin, async () => {
      let claimsBody = null;
      try {
        const lic = webhookLicence();
        const [board, txBoard] = await Promise.all([ctx.closeBoardFor(lic, 0, null), ctx.closeBoardFor(lic, 0, 'TX')]);
        claimsBody = ctx.claims.publicClaims({ board, txBoard, alertBooks: ctx.evBookProven });
      } catch (e) { console.warn('Pricing page: record:', e.message); }
      return plans.pricingPage({ origin, paywall: PAYWALL, billingConfigured: billing.configured(), accounts: !!process.env.AUTH_SECRET, price: priceNow(),
        claims: claimsBody, legalEmail: String(process.env.LEGAL_EMAIL || '').trim().replace(/[^\w.+@-]/g, '') });
    });
    res.set('Cache-Control', 'public, max-age=60').type('html').send(html);
  } catch (e) { console.warn('Pricing page:', e.message); res.status(500).type('text/plain').send('The pricing page could not be built just now. Try again in a minute.'); }
});
// where Stripe should send people back to: the page they came from
// (this site only: Stripe must not be told to send a paying customer elsewhere)
function returnUrl(req, fallback = '/') {
  const u = req.body?.returnUrl || req.get('referer') || fallback;
  try { return typeof u === 'string' && new URL(u).host === req.get('host') && /^https?:$/.test(new URL(u).protocol) ? u : fallback; } catch { return fallback; }
}
app.post('/api/billing/checkout', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Log in first' });
  try {
    const back = returnUrl(req, `${req.protocol}://${req.get('host')}/`);
    const sep = back.includes('?') ? '&' : '?';
    const origin = `${(req.get('x-forwarded-proto') || req.protocol).split(',')[0].trim()}://${req.get('host')}`;
    // which plan and period (the price comes from the server's own list, never the body)
    const plan = req.body?.plan === 'plus' ? 'plus' : req.body?.plan == null || req.body.plan === 'pro' ? 'pro' : null;
    const interval = req.body?.interval === 'year' ? 'year' : req.body?.interval == null || req.body.interval === 'month' ? 'month' : null;
    if (!plan || !interval) return res.status(400).json({ error: 'Pick Plus or Pro, monthly or annual' });
    res.json(await billing.checkout(req.user, { successUrl: `${back}${sep}upgraded=1`, cancelUrl: back, legalUrl: origin, plan, interval }));
  } catch (e) { console.error('Checkout failed:', e.response?.data?.error?.message || e.message); sendErr(res, e); }
});
app.post('/api/billing/portal', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Log in first' });
  try { res.json(await billing.portal(req.user, { returnUrl: returnUrl(req, `${req.protocol}://${req.get('host')}/`) })); }
  catch (e) { console.error('Portal failed:', e.response?.data?.error?.message || e.message); sendErr(res, e); }
});
// Give an account Pro without paying (you, testers, friends). body: { email, comp: true|false }
app.post('/api/admin/comp', requireAdmin, async (req, res) => {
  const user = await auth.store.byEmail(String(req.body?.email || '').trim().toLowerCase());
  if (!user) return res.status(404).json({ error: 'No account with that email' });
  user.comp = req.body?.comp !== false;
  await auth.store.put(user);
  res.json({ ok: true, user: publicUser(user) });
});


return {
  sendErr
};
};
