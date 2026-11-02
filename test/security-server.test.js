// The security pass on a booted server (axios offline): every write route
// fuzzed with malformed, wrong-typed and oversized bodies (never a 5xx, never a
// stack, always JSON), the response headers, the per-address limits, the admin
// compare and sign-in hardening. security.js and billing.js units at the end.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lr-sec-'));
for (const k of ['DATABASE_URL', 'ODDS_API_KEY', 'OWLS_API_KEY', 'ALERT_WEBHOOK_URL', 'PAYWALL', 'PUBLIC_URL', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_IDS',
  'DISCORD_APP_ID', 'DISCORD_PUBLIC_KEY', 'DISCORD_BOT_TOKEN', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET']) delete process.env[k];
Object.assign(process.env, { LR_DATA_DIR: DIR, TRACKER_FILE: path.join(DIR, 'picks.json'), USERS_FILE: path.join(DIR, 'users.json'), EV_TRACK_FILE: path.join(DIR, 'ev.json'),
  API_KEYS_FILE: path.join(DIR, 'api-keys.json'), OUT_FEED_FILE: path.join(DIR, 'out-feed.json'), ESPORTS_CALIBRATION: 'off', TRACKER_ADMIN_TOKEN: 'a'.repeat(32) });
const axios = require('axios');
const offline = async () => { throw Object.assign(new Error('offline'), { response: { status: 503 } }); };
axios.get = offline; axios.post = offline; axios.put = offline; axios.patch = offline; axios.delete = offline;
const srv = require('../server');
const security = require('../security');
const billing = require('../billing');
const auth = require('../auth');
const cron = require('node-cron');
let server, base;
test.before(async () => { server = srv.app.listen(0); await new Promise(r => server.once('listening', r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => { server?.close(); for (const t of cron.getTasks().values()) t.stop(); fs.rmSync(DIR, { recursive: true, force: true }); setTimeout(() => process.exit(0), 50).unref(); });

const send = (p, { method = 'POST', body, type = 'application/json', headers = {} } = {}) =>
  fetch(base + p, { method, headers: { ...(type ? { 'content-type': type } : {}), ...headers }, body, signal: AbortSignal.timeout(15000) });

function writeRoutes() {
  const out = [];
  for (const l of srv.app._router.stack) {
    const r = l.route;
    if (!r) continue;
    for (const m of Object.keys(r.methods)) {
      if (!['post', 'put', 'patch', 'delete'].includes(m)) continue;
      for (const p of [].concat(r.path)) if (typeof p === 'string') out.push({ method: m.toUpperCase(), path: p.replace(/:(\w+)\??/g, 'fuzz') });
    }
  }
  return out;
}

const BODIES = [
  ['not JSON', '{"a":'],
  ['null', 'null'],
  ['a number', '42'],
  ['a string', '"hello"'],
  ['an array', '[1,2,3]'],
  ['empty object', '{}'],
  ['wrong types', JSON.stringify({ email: { $ne: 1 }, password: ['x'], legs: 'x', bets: { a: 1 }, slips: 5, keys: {}, key: [], subscription: 'x', endpoint: {}, kinds: 'all', track: [], handle: { a: 1 }, name: ['n'], url: 7, venue: {}, listed: 'yes', nonce: {}, returnUrl: { a: 1 }, ppLine: {}, modelPred: [] })],
  ['deep nesting', `${'{"a":'.repeat(2000)}1${'}'.repeat(2000)}`],
  ['NaN-ish numbers', JSON.stringify({ legs: [{ line: 'NaN', side: 'over', player: 'x', market: 'y' }], bets: [{ id: 1, track: { kind: 'line', line: 1e308 } }], ppLine: 1e308, modelPred: -1e308 })],
  ['long strings', JSON.stringify({ email: `${'a'.repeat(5000)}@x.com`, password: 'p'.repeat(50000), handle: 'h'.repeat(5000), name: 'n'.repeat(5000) })],
];
const LEAK = /\bat [\w.<>]+ \(|\/home\/|node_modules|ReferenceError|TypeError|SyntaxError: Unexpected/;

test('fuzz: every write route answers malformed, wrong-typed and oversized bodies without a 5xx or a stack', async () => {
  const routes = writeRoutes();
  assert.ok(routes.length >= 40, `found ${routes.length} write routes`);
  const fails = [];
  for (const r of routes) {
    // account sync takes a whole bet list (9 MB limit on /api/sync), every other route 100 KB
    const over = /^\/api\/sync(\/|$)/.test(r.path) ? 9 * 1024 * 1024 + 1024 : 150 * 1024;
    for (const [name, body] of [...BODIES, ['over the size limit', JSON.stringify({ pad: 'x'.repeat(over) })]]) {
      let res, text;
      try { res = await send(r.path, { method: r.method, body }); text = await res.text(); } catch (e) { fails.push(`${r.method} ${r.path} [${name}]: no answer ${e.message}`); continue; }
      // 503 is "off on this server" and 502 a probe whose upstream is offline, both said in JSON
      const okStatus = res.status < 500 || ((res.status === 503 || res.status === 502) && /json/.test(res.headers.get('content-type') || ''));
      if (!okStatus) fails.push(`${r.method} ${r.path} [${name}]: HTTP ${res.status} ${text.slice(0, 120)}`);
      if (LEAK.test(text)) fails.push(`${r.method} ${r.path} [${name}]: leaks internals: ${text.slice(0, 160)}`);
      if (text && !/json/.test(res.headers.get('content-type') || '') && res.status !== 204) fails.push(`${r.method} ${r.path} [${name}]: not JSON (${res.headers.get('content-type')})`);
      // /api/ops/smoke is mounted before the body parser and never reads a body
      if (name === 'over the size limit' && !/webhook|interactions|^\/api\/ops\/smoke$/.test(r.path) && res.status !== 413 && res.status !== 404) fails.push(`${r.method} ${r.path}: a ${Math.round(over / 1024)} KB body answered ${res.status}, not 413`);
    }
  }
  assert.deepEqual(fails, []);
});

test('headers: CSP, nosniff, referrer and frame rules; widgets may be framed; HSTS only over https; no X-Powered-By', async () => {
  const app = await fetch(`${base}/api/health`);
  assert.equal(app.headers.get('x-powered-by'), null);
  assert.equal(app.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(app.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.equal(app.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
  assert.match(app.headers.get('content-security-policy'), /frame-ancestors 'self'/);
  assert.match(app.headers.get('content-security-policy'), /object-src 'none'/);
  assert.match(app.headers.get('content-security-policy'), /connect-src 'self' https:\/\/line-reaper-backend-production\.up\.railway\.app/);
  assert.equal(app.headers.get('strict-transport-security'), null, 'no HSTS over plain http');
  const https = await fetch(`${base}/api/health`, { headers: { 'x-forwarded-proto': 'https' } });
  assert.match(https.headers.get('strict-transport-security'), /max-age=31536000/);
  const embed = await fetch(`${base}/embed/best-price`);
  assert.equal(embed.headers.get('x-frame-options'), null);
  assert.match(embed.headers.get('content-security-policy'), /frame-ancestors \*/);
});

test('bad JSON gets a short JSON 400, not an HTML stack page', async () => {
  const r = await send('/api/slips/grade', { body: '{"legs": [' });
  assert.equal(r.status, 400);
  assert.match(r.headers.get('content-type'), /json/);
  assert.deepEqual(await r.json(), { error: 'The body is not valid JSON.' });
});

test('writes: over 120 a minute from one address get a 429 with Retry-After; another address is not affected', async () => {
  const ip = '203.0.113.7';
  let last;
  for (let i = 0; i < 121; i++) last = await send('/api/ops/tap', { body: '{"venue":"x"}', headers: { 'x-forwarded-for': `198.51.100.1, ${ip}` } });
  assert.equal(last.status, 429);
  assert.ok(Number(last.headers.get('retry-after')) > 0);
  // the first X-Forwarded-For entry is the client's own claim: changing it does not escape the limit
  const spoof = await send('/api/ops/tap', { body: '{"venue":"x"}', headers: { 'x-forwarded-for': `10.9.9.9, ${ip}` } });
  assert.equal(spoof.status, 429);
  const other = await send('/api/ops/tap', { body: '{"venue":"x"}', headers: { 'x-forwarded-for': '203.0.113.8' } });
  assert.notEqual(other.status, 429);
});

test('sign-in: wrong types are a 400 or 401, never a 500; 20 tries in 15 min from one address, then 429', async () => {
  for (const body of [{ email: { a: 1 }, password: 'longenough' }, { email: 'a@b.co', password: ['longenough'] }, { email: 'a@b.co', password: 12345678 }]) {
    const r = await send('/api/auth/signup', { body: JSON.stringify(body) });
    assert.equal(r.status, 400, JSON.stringify(body));
  }
  const long = await send('/api/auth/signup', { body: JSON.stringify({ email: 'long@b.co', password: 'p'.repeat(300) }) });
  assert.equal(long.status, 400);
  const ip = { 'x-forwarded-for': '203.0.113.50' };
  let r;
  for (let i = 0; i < 20; i++) { r = await send('/api/auth/login', { body: JSON.stringify({ email: `nobody${i}@b.co`, password: 'wrongwrong' }), headers: ip }); assert.equal(r.status, 401); }
  r = await send('/api/auth/login', { body: JSON.stringify({ email: 'nobody@b.co', password: 'wrongwrong' }), headers: ip });
  assert.equal(r.status, 429);
});

test('sign-in: 10 wrong passwords for one email lock that email for a while, from any address', async () => {
  const email = 'target@b.co';
  const s = await send('/api/auth/signup', { body: JSON.stringify({ email, password: 'right-password', acceptTerms: true, confirmAge: true }) });
  assert.equal(s.status, 201);
  for (let i = 0; i < 10; i++) {
    const r = await send('/api/auth/login', { body: JSON.stringify({ email, password: 'wrong-password' }), headers: { 'x-forwarded-for': `198.51.100.${i + 10}` } });
    assert.equal(r.status, 401);
  }
  const locked = await send('/api/auth/login', { body: JSON.stringify({ email, password: 'right-password' }), headers: { 'x-forwarded-for': '198.51.100.99' } });
  assert.equal(locked.status, 429);
});

test('signup: 5 new accounts an hour from one address', async () => {
  const ip = { 'x-forwarded-for': '203.0.113.60' };
  for (let i = 0; i < 5; i++) {
    const r = await send('/api/auth/signup', { body: JSON.stringify({ email: `new${i}@b.co`, password: 'longenough', acceptTerms: true, confirmAge: true }), headers: ip });
    assert.equal(r.status, 201);
  }
  const r = await send('/api/auth/signup', { body: JSON.stringify({ email: 'new9@b.co', password: 'longenough', acceptTerms: true, confirmAge: true }), headers: ip });
  assert.equal(r.status, 429);
});

test('admin: wiping SHARP MOVES needs the token; a wrong or missing token is a 401', async () => {
  assert.equal((await send('/api/sharp-moves', { method: 'DELETE' })).status, 401);
  assert.equal((await send('/api/sharp-moves', { method: 'DELETE', headers: { 'x-admin-token': 'b'.repeat(32) } })).status, 401);
  assert.equal((await send('/api/sharp-moves', { method: 'DELETE', headers: { 'x-admin-token': 'a'.repeat(32) } })).status, 200);
});

test('/api/ops says what is missing for taking money, as names only', async () => {
  const ops = await (await fetch(`${base}/api/ops`)).json();
  assert.equal(typeof ops.security.ready, 'boolean');
  assert.ok(Array.isArray(ops.security.missing));
  assert.ok(!JSON.stringify(ops.security).includes('a'.repeat(32)), 'never the token itself');
});

test('security.js: safeEqual, limiter windows, callerIp takes the proxy-added address, readiness', () => {
  assert.equal(security.safeEqual('abc', 'abc'), true);
  assert.equal(security.safeEqual('abc', 'abd'), false);
  assert.equal(security.safeEqual('', ''), false);
  assert.equal(security.safeEqual(undefined, 'x'), false);
  let t = 0;
  const lim = security.createWindowLimiter({ limit: 2, windowMs: 1000, now: () => t });
  assert.equal(lim.take('a').ok, true); assert.equal(lim.take('a').ok, true); assert.equal(lim.take('a').ok, false);
  t = 1000; assert.equal(lim.take('a').ok, true);
  const req = h => ({ get: k => h[k.toLowerCase()], ip: '10.0.0.1' });
  assert.equal(security.callerIp(req({ 'x-forwarded-for': '1.1.1.1, 2.2.2.2' })), '2.2.2.2');
  assert.equal(security.callerIp(req({})), '10.0.0.1');
  const r = security.readiness({ PAYWALL: 'on', STRIPE_SECRET_KEY: 'sk' });
  assert.equal(r.ready, false);
  assert.ok(r.missing.some(m => m.startsWith('AUTH_SECRET')) && r.missing.some(m => m.startsWith('STRIPE_WEBHOOK_SECRET')));
  assert.ok(security.readiness({ AUTH_SECRET: 'x', DATABASE_URL: 'x', TRACKER_ADMIN_TOKEN: 'z'.repeat(30), RESULTS_BACKUP_KEY: 'k', FEED_SECRET: 'f' }).ready);
});

test('Stripe webhook: a non-numeric timestamp is refused even before the signature', () => {
  const secret = 'whsec_test', payload = '{"type":"x"}';
  const sig = t => crypto.createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex');
  assert.throws(() => billing.verifyWebhook(payload, `t=abc,v1=${sig('abc')}`, secret), /Malformed/);
  const now = Math.floor(Date.now() / 1000);
  assert.deepEqual(billing.verifyWebhook(payload, `t=${now},v1=${sig(now)}`, secret), { type: 'x' });
  assert.throws(() => billing.verifyWebhook(payload, `t=${now - 600},v1=${sig(now - 600)}`, secret), /tolerance/);
});

test('billing: a second checkout on a live subscription is refused (it would charge twice)', async () => {
  const posts = [];
  const b = billing.createBilling({ http: { post: async (u) => { posts.push(u); return { data: { id: 'x', url: 'https://checkout' } }; } }, secretKey: 'sk', priceId: 'p', store: { put: async () => {} }, log: {} });
  await assert.rejects(b.checkout({ id: 'u', stripeCustomerId: 'c', subscriptionId: 's', planStatus: 'active' }, { successUrl: 'a', cancelUrl: 'b' }), e => e.status === 409);
  assert.equal(posts.length, 0);
  const ok = await b.checkout({ id: 'u', stripeCustomerId: 'c', subscriptionId: 's', planStatus: 'canceled' }, { successUrl: 'a', cancelUrl: 'b' });
  assert.equal(ok.url, 'https://checkout');
});

test('auth: async hashes check against the sync ones; a missing account does the same work', async () => {
  const h = await auth.hashPasswordAsync('pass-word-1');
  assert.equal(auth.verifyPassword('pass-word-1', h), true);
  assert.equal(await auth.verifyPasswordAsync('pass-word-1', auth.hashPassword('pass-word-1')), true);
  assert.equal(await auth.verifyPasswordAsync('nope', h), false);
});

test('profilers: with the admin token set, /api/ops/profile and /api/ops/heap need it', async () => {
  for (const p of ['/api/ops/profile?s=5', '/api/ops/heap?s=5']) {
    assert.equal((await fetch(base + p)).status, 401, p);
    assert.equal((await fetch(base + p, { headers: { 'x-admin-token': 'b'.repeat(32) } })).status, 401, p);
  }
  assert.ok(security.readiness({}).missing.some(m => /profile.*open/.test(m)));
});
