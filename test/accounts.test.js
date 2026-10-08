const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const A = require('../auth');
const { createBilling, verifyWebhook, form } = require('../billing');

const SECRET = 'test-secret';

test('passwords hash with a salt and verify', () => {
  const h = A.hashPassword('hunter22');
  assert.match(h, /^scrypt\$[0-9a-f]{32}\$[0-9a-f]{128}$/);
  assert.notEqual(h, A.hashPassword('hunter22'), 'salted');
  assert.ok(A.verifyPassword('hunter22', h));
  assert.ok(!A.verifyPassword('hunter23', h));
  assert.ok(!A.verifyPassword('x', 'garbage'));
});

test('tokens verify, expire, and reject tampering', () => {
  const t0 = Date.parse('2026-10-08T00:00:00Z');
  const tok = A.signToken({ sub: 'u1' }, SECRET, t0);
  assert.equal(A.verifyToken(tok, SECRET, t0 + 1000).sub, 'u1');
  assert.equal(A.verifyToken(tok, 'other', t0), null, 'wrong secret');
  assert.equal(A.verifyToken(tok, SECRET, t0 + A.TOKEN_TTL_MS + 1), null, 'expired');
  const [body, sig] = tok.split('.');
  const forged = Buffer.from(JSON.stringify({ sub: 'admin', exp: t0 + 1e12 })).toString('base64url');
  assert.equal(A.verifyToken(`${forged}.${sig}`, SECRET, t0), null, 'body swapped');
  assert.equal(A.verifyToken(`${body}.`, SECRET, t0), null);
  assert.equal(A.verifyToken('nonsense', SECRET, t0), null);
});

test('signup, login, duplicate and bad input', async () => {
  const auth = A.createAuth({ store: A.createMemoryUserStore(), secret: SECRET });
  const s = await auth.signup('  Logan@Example.com ', 'longenough');
  assert.equal(s.user.email, 'logan@example.com');
  assert.equal(s.user.plan, 'free');
  assert.equal(s.user.isPro, false);
  assert.ok(!('passwordHash' in s.user), 'never sent to the client');
  assert.equal((await auth.fromToken(s.token)).email, 'logan@example.com');

  await assert.rejects(auth.signup('logan@example.com', 'longenough'), e => e.status === 409);
  await assert.rejects(auth.signup('not-an-email', 'longenough'), e => e.status === 400);
  await assert.rejects(auth.signup('a@b.co', 'short'), e => e.status === 400);

  const l = await auth.login('LOGAN@example.com', 'longenough');
  assert.equal(l.user.id, s.user.id);
  await assert.rejects(auth.login('logan@example.com', 'wrongpass'), e => e.status === 401 && /Wrong email or password/.test(e.message));
  await assert.rejects(auth.login('nobody@example.com', 'whatever1'), e => e.status === 401 && /Wrong email or password/.test(e.message));
});

test('attach() reads bearer headers and ?token=', async () => {
  const auth = A.createAuth({ store: A.createMemoryUserStore(), secret: SECRET });
  const { token } = await auth.signup('a@b.co', 'longenough');
  const run = async req => { await new Promise(r => auth.attach()(req, {}, r)); return req.user; };
  const hdr = h => ({ get: k => (k === 'authorization' ? h : undefined), query: {} });
  assert.equal((await run(hdr(`Bearer ${token}`))).email, 'a@b.co');
  assert.equal(await run(hdr('Bearer junk')), null);
  assert.equal(await run(hdr(undefined)), null);
  assert.equal((await run({ get: () => undefined, query: { token } })).email, 'a@b.co');
});

test('isPro covers active, trialing, paid-through, comp; not unpaid or lapsed', () => {
  const now = Date.parse('2026-10-08T00:00:00Z');
  const future = new Date(now + 86400000).toISOString(), past = new Date(now - 86400000).toISOString();
  assert.ok(A.isPro({ planStatus: 'active' }, now));
  assert.ok(A.isPro({ planStatus: 'trialing' }, now));
  assert.ok(A.isPro({ planStatus: 'canceled', currentPeriodEnd: future }, now), 'cancelled but paid through');
  assert.ok(A.isPro({ planStatus: 'past_due', currentPeriodEnd: future }, now), 'grace while a card retries');
  assert.ok(!A.isPro({ planStatus: 'unpaid', currentPeriodEnd: future }, now));
  assert.ok(!A.isPro({ planStatus: 'canceled', currentPeriodEnd: past }, now));
  assert.ok(!A.isPro({ plan: 'free' }, now));
  assert.ok(A.isPro({ comp: true }, now));
  assert.ok(!A.isPro(null, now));
});

test('stripe form encoding matches what the API expects', () => {
  const f = form({ mode: 'subscription', line_items: [{ price: 'price_1', quantity: 1 }], metadata: { user_id: 'u1' }, skip: null });
  assert.equal(f.get('mode'), 'subscription');
  assert.equal(f.get('line_items[0][price]'), 'price_1');
  assert.equal(f.get('line_items[0][quantity]'), '1');
  assert.equal(f.get('metadata[user_id]'), 'u1');
  assert.equal(f.has('skip'), false);
});

function sign(payload, secret, t) {
  const sig = crypto.createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex');
  return `t=${t},v1=${sig}`;
}

test('webhook signatures: valid, tampered, stale, malformed', () => {
  const now = Date.parse('2026-10-08T12:00:00Z');
  const t = Math.floor(now / 1000);
  const body = JSON.stringify({ type: 'customer.subscription.updated', data: { object: { id: 'sub_1' } } });
  assert.equal(verifyWebhook(Buffer.from(body), sign(body, 'whsec', t), 'whsec', { now }).type, 'customer.subscription.updated');
  // Stripe may send several v1 signatures during secret rotation
  assert.ok(verifyWebhook(body, `t=${t},v1=${'0'.repeat(64)},${sign(body, 'whsec', t).split(',')[1]}`, 'whsec', { now }));
  assert.throws(() => verifyWebhook(body.replace('sub_1', 'sub_2'), sign(body, 'whsec', t), 'whsec', { now }), /mismatch/);
  assert.throws(() => verifyWebhook(body, sign(body, 'whsec', t - 3600), 'whsec', { now }), /tolerance/);
  assert.throws(() => verifyWebhook(body, 'garbage', 'whsec', { now }), /Malformed/);
  assert.throws(() => verifyWebhook(body, sign(body, 'whsec', t), undefined, { now }), /not configured/);
});

function fakeStripe() {
  const calls = [];
  return {
    calls,
    async post(url, body, opts) {
      calls.push({ url, body: new URLSearchParams(body), auth: opts.headers.Authorization });
      if (url.endsWith('/customers')) return { data: { id: 'cus_123' } };
      if (url.endsWith('/checkout/sessions')) return { data: { id: 'cs_1', url: 'https://checkout.stripe.com/c/pay/cs_1' } };
      if (url.endsWith('/billing_portal/sessions')) return { data: { url: 'https://billing.stripe.com/p/session_1' } };
      throw new Error('unexpected ' + url);
    },
  };
}

test('checkout creates the customer once, then a subscription session', async () => {
  const store = A.createMemoryUserStore();
  const auth = A.createAuth({ store, secret: SECRET });
  const { user } = await auth.signup('a@b.co', 'longenough');
  const http = fakeStripe();
  const billing = createBilling({ http, secretKey: 'sk_test_1', priceId: 'price_pro', store, trialDays: 7 });
  const u = await store.get(user.id);

  const s = await billing.checkout(u, { successUrl: 'https://app/x?upgraded=1', cancelUrl: 'https://app/x' });
  assert.match(s.url, /checkout\.stripe\.com/);
  assert.equal((await store.get(user.id)).stripeCustomerId, 'cus_123');
  const sess = http.calls.find(c => c.url.endsWith('/checkout/sessions'));
  assert.equal(sess.body.get('customer'), 'cus_123');
  assert.equal(sess.body.get('line_items[0][price]'), 'price_pro');
  assert.equal(sess.body.get('client_reference_id'), user.id);
  assert.equal(sess.body.get('subscription_data[trial_period_days]'), '7');
  assert.equal(sess.auth, 'Bearer sk_test_1');

  await billing.checkout(u, { successUrl: 'a', cancelUrl: 'b' });
  assert.equal(http.calls.filter(c => c.url.endsWith('/customers')).length, 1, 'customer reused');

  assert.match((await billing.portal(u, { returnUrl: 'https://app' })).url, /billing\.stripe\.com/);
});

test('billing refuses cleanly when not configured or no customer', async () => {
  const store = A.createMemoryUserStore();
  const off = createBilling({ http: fakeStripe(), secretKey: '', priceId: '', store });
  assert.equal(off.configured(), false);
  await assert.rejects(off.checkout({ id: 'u', email: 'a@b.co' }, {}), e => e.status === 503);
  const on = createBilling({ http: fakeStripe(), secretKey: 'sk', priceId: 'p', store });
  await assert.rejects(on.portal({ id: 'u' }, { returnUrl: 'x' }), e => e.status === 400);
});

test('subscription webhooks drive the plan', async () => {
  const store = A.createMemoryUserStore();
  const auth = A.createAuth({ store, secret: SECRET });
  const { user } = await auth.signup('a@b.co', 'longenough');
  const u = await store.get(user.id);
  u.stripeCustomerId = 'cus_9';
  await store.put(u);
  const billing = createBilling({ http: fakeStripe(), secretKey: 'sk', priceId: 'p', store, log: { warn() {} } });
  const end = Math.floor(Date.now() / 1000) + 30 * 86400;

  await billing.handleEvent({ type: 'customer.subscription.created', data: { object: { id: 'sub_1', customer: 'cus_9', status: 'active', current_period_end: end } } });
  let now = await store.get(user.id);
  assert.equal(now.plan, 'pro');
  assert.ok(A.isPro(now));

  await billing.handleEvent({ type: 'customer.subscription.updated', data: { object: { id: 'sub_1', customer: 'cus_9', status: 'unpaid', current_period_end: end } } });
  assert.ok(!A.isPro(await store.get(user.id)), 'unpaid loses access');

  await billing.handleEvent({ type: 'customer.subscription.deleted', data: { object: { id: 'sub_1', customer: 'cus_9', status: 'canceled', current_period_end: end } } });
  now = await store.get(user.id);
  assert.equal(now.plan, 'free');
  assert.equal(now.currentPeriodEnd, null);
  assert.ok(!A.isPro(now));

  assert.deepEqual(await billing.handleEvent({ type: 'customer.subscription.updated', data: { object: { customer: 'cus_unknown' } } }), { ignored: 'unknown customer' });
  assert.deepEqual(await billing.handleEvent({ type: 'invoice.paid', data: { object: {} } }), { ignored: 'invoice.paid' });

  // checkout completion links a customer the account didn't have yet
  const other = await auth.signup('c@d.co', 'longenough');
  const r = await billing.handleEvent({ type: 'checkout.session.completed', data: { object: { client_reference_id: other.user.id, customer: 'cus_new' } } });
  assert.deepEqual(r, { linked: other.user.id });
  assert.equal((await store.byCustomer('cus_new')).email, 'c@d.co');
});
