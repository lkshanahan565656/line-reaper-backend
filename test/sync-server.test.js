// Account sync end to end through server.js with AUTH_SECRET set and no
// Postgres (the file store): sign up, upload, read back from another device,
// stale writes, privacy between accounts, alert devices following the
// account, deleting the account, and the slow-down on wrong passwords.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lr-sync-server-'));
for (const k of Object.keys(process.env)) if (/^(DATABASE_URL|RAILWAY_|PAYWALL|LR_SYNC|VAPID_|STRIPE_)/.test(k)) delete process.env[k];
Object.assign(process.env, {
  AUTH_SECRET: 'sync-test-secret', LR_DATA_DIR: DIR, UPSTREAM_GAP_MS: '0', ALERT_STARTUP: 'off',
  USERS_FILE: path.join(DIR, 'users.json'), TRACKER_FILE: path.join(DIR, 'picks.json'), EV_TRACK_FILE: path.join(DIR, 'ev.json'),
});
const axios = require('axios');
axios.get = async url => { throw Object.assign(new Error(`offline: ${url}`), { code: 'ENOTFOUND' }); };
axios.post = axios.get;

const S = require('../server');
const cron = require('node-cron');
for (const t of cron.getTasks().values()) t.stop();

let srv, base;
test.before(async () => { await new Promise(r => { srv = S.app.listen(0, '127.0.0.1', r); }); base = `http://127.0.0.1:${srv.address().port}`; });
test.after(() => { srv?.closeAllConnections?.(); srv?.close(); for (const t of cron.getTasks().values()) t.stop(); fs.rmSync(DIR, { recursive: true, force: true }); });

const call = async (method, p, body, token, ip) => {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (ip) headers['x-forwarded-for'] = ip;
  const r = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const signup = async email => (await call('POST', '/api/auth/signup', { email, password: 'longenough1', acceptTerms: true, confirmAge: true })).body.token;
const SUB = n => ({ endpoint: `https://push.example.com/send/${n}`, keys: { p256dh: `p256-${n}`, auth: `auth-${n}` } });

test('status says sync is on, with the file store, and lists what syncs', async () => {
  const { status, body } = await call('GET', '/api/sync/status');
  assert.equal(status, 200);
  assert.equal(body.enabled, true);
  assert.equal(body.store, 'file');
  assert.ok(body.keys.some(k => k.key === 'lr_bets'));
  assert.ok(!body.keys.some(k => k.key === 'lr_token'), 'the login token never syncs');
  const st = await call('GET', '/api/status');
  assert.equal(st.body.accounts.sync.enabled, true);
});

test('upload from one device, read it on another, stale write gets 409 with the current copy', async () => {
  assert.equal((await call('GET', '/api/sync')).status, 401);
  const token = await signup('phone@example.com');
  const first = await call('GET', '/api/sync', undefined, token);
  assert.equal(first.status, 200);
  assert.equal(first.body.rev, 0);
  const bets = JSON.stringify([{ id: 'b1', pick: 'Chiefs -3', odds: 1.91, stake: 10, result: 'open' }]);
  const put = await call('PUT', '/api/sync', { rev: 0, keys: { lr_bets: bets, lr_unit_usd: '20' } }, token);
  assert.equal(put.status, 200);
  assert.equal(put.body.rev, 1);
  // the desktop logs in to the same account
  const login = await call('POST', '/api/auth/login', { email: 'phone@example.com', password: 'longenough1' });
  const read = await call('GET', '/api/sync', undefined, login.body.token);
  assert.equal(read.body.keys.lr_bets.v, bets);
  const stale = await call('PUT', '/api/sync', { rev: 0, keys: { lr_unit_usd: '99' } }, login.body.token);
  assert.equal(stale.status, 409);
  assert.equal(stale.body.current.rev, 1);
  assert.equal(stale.body.current.keys.lr_unit_usd.v, '20');
  const bad = await call('PUT', '/api/sync', { rev: 1, keys: { lr_admin_token: 'x' } }, token);
  assert.equal(bad.status, 400);
});

test('one account never sees another account\'s data', async () => {
  const a = await signup('a@example.com'), b = await signup('b@example.com');
  await call('PUT', '/api/sync', { rev: 0, keys: { lr_layout: '{"order":["odds"]}' } }, a);
  const seen = await call('GET', '/api/sync', undefined, b);
  assert.deepEqual(seen.body.keys, {});
  assert.equal((await call('GET', '/api/sync', undefined, 'forged.token')).status, 401);
});

test('alert devices follow the account: both get listed, kinds set on one apply to both', async () => {
  const token = await signup('alerts@example.com');
  for (const n of [1, 2]) {
    const r = await call('POST', '/api/push/subscribe', { subscription: SUB(n), kinds: ['ev', 'sharp'] }, token);
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }
  // a device that turned alerts on before signing in joins when it opens signed in
  await call('POST', '/api/push/subscribe', { subscription: SUB(3), kinds: ['ev'] });
  const list = await call('POST', '/api/sync/devices', { endpoint: SUB(3).endpoint }, token);
  assert.equal(list.status, 200);
  assert.equal(list.body.devices.length, 3);
  assert.equal(list.body.devices.filter(d => d.thisDevice).length, 1);
  assert.ok(!JSON.stringify(list.body).includes('push.example.com'), 'no endpoints sent back');
  const k = await call('POST', '/api/push/kinds', { endpoint: SUB(1).endpoint, kinds: ['tail'] }, token);
  assert.equal(k.body.accountDevices, 3);
  const after = await call('POST', '/api/sync/devices', {}, token);
  assert.ok(after.body.devices.every(d => d.kinds.length === 1 && d.kinds[0] === 'tail'));
  // another account sees none of them
  const other = await signup('other@example.com');
  assert.equal((await call('POST', '/api/sync/devices', {}, other)).body.devices.length, 0);
});

test('deleting the account deletes its synced data and unlinks its devices', async () => {
  const token = await signup('gone@example.com');
  await call('PUT', '/api/sync', { rev: 0, keys: { lr_unit_usd: '5' } }, token);
  await call('POST', '/api/push/subscribe', { subscription: SUB(9) }, token);
  const del = await call('POST', '/api/auth/delete', { password: 'longenough1' }, token);
  assert.equal(del.status, 200);
  const again = await signup('gone@example.com');
  assert.deepEqual((await call('GET', '/api/sync', undefined, again)).body.keys, {});
  assert.equal((await call('POST', '/api/sync/devices', {}, again)).body.devices.length, 0);
});

test('wrong passwords slow down after 10 for one email', async () => {
  await signup('guess@example.com');
  for (let i = 0; i < 10; i++) assert.equal((await call('POST', '/api/auth/login', { email: 'guess@example.com', password: `wrong${i}xxx` }, null, `10.0.0.${i}`)).status, 401);
  const blocked = await call('POST', '/api/auth/login', { email: 'guess@example.com', password: 'longenough1' }, null, '10.0.1.1');
  assert.equal(blocked.status, 429);
  assert.match(blocked.body.error, /Too many sign-in attempts/);
});

test('the merge rules are served to the page', async () => {
  const r = await fetch(`${base}/acctsync.js`);
  assert.equal(r.status, 200);
  assert.match(await r.text(), /root\.LRSync = factory\(\)/);
});
