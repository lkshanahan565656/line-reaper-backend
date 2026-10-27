// Plans on a server with PAYWALL=on and no Stripe keys: /api/plans, /pricing,
// the API's per-plan limits, keys per account, the Discord feed held to Pro,
// and the readiness list on /api/status. (PAYWALL off, everyone keeps the Pro
// limits: publicapi-server.test.js checks 60 a minute there.)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lr-plans-'));
const ADMIN = 'plans-admin-token';
for (const k of ['DATABASE_URL', 'ODDS_API_KEY', 'OWLS_API_KEY', 'ALERT_WEBHOOK_URL', 'PUBLIC_URL', 'STRIPE_SECRET_KEY', 'STRIPE_PRICE_ID', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_INTRO_PRICE_ID',
  'DISCORD_WEBHOOK_URLS', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_IDS', 'LEGAL_EMAIL', 'LEGAL_STATE', 'PRICE_MONTHLY', 'PRICE_INTRO']) delete process.env[k];
Object.assign(process.env, { PAYWALL: 'on', AUTH_SECRET: 'plans-secret', TRACKER_ADMIN_TOKEN: ADMIN, LR_DATA_DIR: DIR, TRACKER_FILE: path.join(DIR, 'picks.json'), USERS_FILE: path.join(DIR, 'users.json'),
  EV_TRACK_FILE: path.join(DIR, 'ev.json'), SPORT_PROPS_FILE: path.join(DIR, 'sport-props.json'), DIGEST_FILE: path.join(DIR, 'digest.json'), API_KEYS_FILE: path.join(DIR, 'api-keys.json'),
  OUT_FEED_FILE: path.join(DIR, 'out-feed.json'), ESPORTS_CALIBRATION: 'off' });
const axios = require('axios');
axios.get = async () => { throw Object.assign(new Error('offline'), { response: { status: 503 } }); };
axios.post = axios.get;
const srv = require('../server');
const cron = require('node-cron');
let server, base;
test.before(async () => { server = srv.app.listen(0); await new Promise(r => server.once('listening', r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => { server?.close(); for (const t of cron.getTasks().values()) t.stop(); fs.rmSync(DIR, { recursive: true, force: true }); setTimeout(() => process.exit(0), 50).unref(); });

const json = async (u, opts = {}) => { const r = await fetch(`${base}${u}`, opts); return { status: r.status, headers: r.headers, body: await r.json().catch(() => null) }; };
const post = (u, body, headers = {}) => json(u, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
const signup = async email => (await post('/api/auth/signup', { email, password: 'long-enough-pw', acceptTerms: true, confirmAge: true })).body.token;

test('/api/plans: the plans, the price, and the viewer on Free', async () => {
  const r = await json('/api/plans');
  assert.equal(r.status, 200);
  assert.equal(r.body.paywall, true);
  assert.equal(r.body.onSale, false, 'no Stripe keys: not on sale');
  assert.deepEqual(r.body.plans.map(p => p.id), ['free', 'pro']);
  assert.equal(r.body.viewer.plan, 'free');
  assert.equal(r.body.price.monthly, 79);
  assert.equal(r.body.price.intro, null, 'no founding price in Stripe: none shown');
  assert.ok(r.body.features.every(f => !('gate' in f)), 'internal notes stay internal');
  const admin = await json('/api/plans', { headers: { 'x-admin-token': ADMIN } });
  assert.equal(admin.body.viewer.plan, 'pro');
});

test('/pricing: renders, links back, and says Pro checkout is not open without Stripe', async () => {
  const r = await fetch(`${base}/pricing`);
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.match(html, /<h1>Free and Pro<\/h1>/);
  assert.match(html, /ASK ABOUT PRO/);
  assert.match(html, /Pro checkout is not open yet/);
  assert.doesNotMatch(html, /id="early"/);
  assert.match(html, /What the record backs today/);
  assert.doesNotMatch(html, /guaranteed|risk[- ]free|undefined|NaN/);
  const sm = await (await fetch(`${base}/sitemap.xml`)).text();
  assert.match(sm, /\/pricing<\/loc>/);
  const landing = await (await fetch(`${base}/`, { headers: { Accept: 'text/html' } })).text();
  assert.match(landing, /href="\/pricing">Compare the plans in full/);
  assert.match(landing, /Sharp Tail \(research\)/);
  assert.doesNotMatch(landing, /\{\{[A-Z_]+\}\}/);
});

test('API keys: a signed-out key is Free (10 a minute); the admin token gets Pro limits', async () => {
  const k = await post('/api/v1/keys', { name: 'anon' }, { 'X-Forwarded-For': '10.1.0.1' });
  assert.equal(k.status, 201);
  assert.equal(k.body.plan, 'free');
  assert.deepEqual(k.body.limits, { perMinute: 10, perDay: 500 });
  const r = await fetch(`${base}/api/v1/states`, { headers: { 'X-API-Key': k.body.key } });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('x-ratelimit-limit'), '10');
  assert.equal(r.headers.get('x-ratelimit-daily-limit'), '500');
  assert.equal(r.headers.get('x-line-reaper-plan'), 'free');
  for (let i = 0; i < 9; i++) await fetch(`${base}/api/v1/states`, { headers: { 'X-API-Key': k.body.key } });
  const over = await json('/api/v1/states', { headers: { 'X-API-Key': k.body.key } });
  assert.equal(over.status, 429);
  assert.match(over.body.error.message, /Pro keys get more: \/pricing/);
  const adm = await fetch(`${base}/api/v1/states`, { headers: { 'X-API-Key': k.body.key, 'x-admin-token': ADMIN } });
  assert.equal(adm.status, 200, 'the admin is not held to the Free limit');
  assert.equal(adm.headers.get('x-ratelimit-limit'), '60');
  const idx = await json('/api/v1');
  assert.deepEqual(idx.body.plans.free, { perMinute: 10, perDay: 500 });
});

test('accounts: Free keeps one key and no Discord feed; a comped account gets Pro limits, five keys and the feed', async () => {
  const token = await signup('free-plan@example.com');
  const auth = { Authorization: `Bearer ${token}` };
  const me = await json('/api/auth/me', { headers: auth });
  assert.equal(me.body.plan, 'free');
  assert.equal(me.body.limits.apiKeys, 1);
  const k1 = await post('/api/v1/keys', { name: 'one' }, { ...auth, 'X-Forwarded-For': '10.1.0.2' });
  assert.equal(k1.status, 201);
  const k2 = await post('/api/v1/keys', { name: 'two' }, { ...auth, 'X-Forwarded-For': '10.1.0.2' });
  assert.equal(k2.status, 403);
  assert.equal(k2.body.error.code, 'plan_limit');
  assert.match(k2.body.error.message, /\/pricing/);
  const key = { 'X-API-Key': k1.body.key };
  const feed = await json('/api/v1/feed/discord', { method: 'PUT', headers: { 'Content-Type': 'application/json', ...key }, body: JSON.stringify({ url: `https://discord.com/api/webhooks/123456789012345678/${'a'.repeat(68)}` }) });
  assert.equal(feed.status, 402);
  assert.equal(feed.body.error.code, 'plan_required');
  const fv = await json('/api/v1/feed', { headers: key });
  assert.equal(fv.body.plan, 'free');
  assert.match(fv.body.planNote, /Pro feature/);
  // comp the account: the same key now has Pro limits, and a second key is allowed
  const comp = await post('/api/admin/comp', { email: 'free-plan@example.com', comp: true }, { 'x-admin-token': ADMIN });
  assert.equal(comp.status, 200);
  const r = await fetch(`${base}/api/v1/states`, { headers: key });
  assert.equal(r.headers.get('x-ratelimit-limit'), '60');
  assert.equal(r.headers.get('x-line-reaper-plan'), 'pro');
  const k3 = await post('/api/v1/keys', { name: 'two' }, { ...auth, 'X-Forwarded-For': '10.1.0.3' });
  assert.equal(k3.status, 201);
  assert.equal(k3.body.plan, 'pro');
  const feed2 = await json('/api/v1/feed/discord', { method: 'PUT', headers: { 'Content-Type': 'application/json', ...key }, body: JSON.stringify({ url: `https://discord.com/api/webhooks/123456789012345678/${'a'.repeat(68)}` }) });
  assert.notEqual(feed2.status, 402, 'Pro gets past the plan check (Discord is offline here)');
  assert.equal((await json('/api/plans', { headers: auth })).body.viewer.plan, 'pro');
});

test('/api/status: the switch to charging lists what is missing, by name only', async () => {
  const s = await json('/api/status');
  const p = s.body.accounts.plans;
  assert.equal(p.ready, false);
  assert.ok(p.missing.includes('STRIPE_SECRET_KEY') && p.missing.includes('DATABASE_URL') && !p.missing.includes('AUTH_SECRET'));
  assert.equal(p.pricing, '/pricing');
});
