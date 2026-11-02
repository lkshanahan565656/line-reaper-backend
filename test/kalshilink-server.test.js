// Kalshi link on the server: connect a read-only key to a published record,
// refuse one that can write, read status, poll, and drop the key on
// unpublish. TEST DATA: the key, the account and its fills are made up here;
// axios is stubbed, so nothing reaches Kalshi.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lr-klink-'));
for (const k of ['DATABASE_URL', 'ODDS_API_KEY', 'OWLS_API_KEY', 'ALERT_WEBHOOK_URL', 'PAYWALL', 'KALSHI_LINK', 'RAILWAY_ENVIRONMENT', 'RAILWAY_PROJECT_ID', 'KALSHI_API_BASE']) delete process.env[k];
Object.assign(process.env, { PUBLIC_URL: 'https://linereaper.example', LR_DATA_DIR: DIR, TRACKER_FILE: path.join(DIR, 'picks.json'), USERS_FILE: path.join(DIR, 'users.json'), EV_TRACK_FILE: path.join(DIR, 'ev.json'),
  PUB_RECORDS_FILE: path.join(DIR, 'pub.json'), KALSHI_LINKS_FILE: path.join(DIR, 'kl.json'), ESPORTS_CALIBRATION: 'off', PUB_RECORDS_PER_HOUR: '1000', AUTH_SECRET: 'klink-secret' });

const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = rsa.privateKey.export({ type: 'pkcs1', format: 'pem' });
const KEY_ID = 'b1b2c3d4-0000-4000-8000-00000000beef';
let scopes = ['read'];
const kalshiCalls = [];
const axios = require('axios');
axios.get = async (url, cfg = {}) => {
  const u = new URL(url);
  if (u.pathname.startsWith('/trade-api/v2/') && cfg.headers?.['KALSHI-ACCESS-KEY']) {
    kalshiCalls.push(u.pathname);
    if (u.pathname.endsWith('/api_keys')) return { data: { api_keys: [{ api_key_id: KEY_ID, scopes }] } };
    if (u.pathname.endsWith('/portfolio/fills')) return { data: { fills: [{ fill_id: 'f1', order_id: 'o1', ticker: 'KXNBAGAME-MADEUP-HOM', outcome_side: 'yes', count_fp: '5.00', yes_price_dollars: '0.5000', no_price_dollars: '0.5000', fee_cost: '0.09', created_time: new Date(Date.now() + 1000).toISOString() }], cursor: '' } };
  }
  throw Object.assign(new Error('offline'), { response: { status: 503 } });
};
axios.post = async () => { throw Object.assign(new Error('offline'), { response: { status: 503 } }); };
const srv = require('../server');
const cron = require('node-cron');
let server, base;
test.before(async () => { server = srv.app.listen(0); await new Promise(r => server.once('listening', r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => { server?.close(); for (const t of cron.getTasks().values()) t.stop(); fs.rmSync(DIR, { recursive: true, force: true }); setTimeout(() => process.exit(0), 50).unref(); });

const call = (u, body, key, method = 'POST') => fetch(base + u, { method, headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) }, body: body ? JSON.stringify(body) : undefined });

test('connect, refuse a key that can write, status, poll, unpublish drops the key', async () => {
  const on = await (await fetch(`${base}/api/kalshi-link`)).json();
  assert.deepEqual([on.enabled, on.scopes], [true, ['read']]);
  const pub = await (await call('/api/records', { handle: 'kalshi_tester' })).json();
  const url = '/api/records/kalshi_tester/kalshi';

  assert.equal((await call(url, { keyId: KEY_ID, privateKey: PEM })).status, 403, 'needs the record key');
  assert.equal((await call('/api/records/nobody_here/kalshi', { keyId: KEY_ID, privateKey: PEM }, pub.token)).status, 404);
  const junk = await call(url, { keyId: KEY_ID, privateKey: 'nope' }, pub.token);
  assert.equal(junk.status, 400);

  scopes = ['read', 'write'];
  const w = await call(url, { keyId: KEY_ID, privateKey: PEM }, pub.token);
  assert.equal(w.status, 400);
  assert.match((await w.json()).error, /read-only/);
  assert.equal((await (await call(url, null, pub.token, 'GET')).json()).connected, false, 'nothing saved');

  scopes = ['read'];
  const ok = await call(url, { keyId: KEY_ID, privateKey: PEM }, pub.token);
  assert.equal(ok.status, 201);
  const v = await ok.json();
  assert.deepEqual([v.connected, v.keyHint], [true, '…beef']);
  assert.ok(!JSON.stringify(srv.kalshiLinks.links.get('kalshi_tester')).includes('PRIVATE KEY'), 'sealed in the store');

  // no odds screen offline: the fill is read and counted, but no game matches
  const st = await srv.pollKalshiLinks();
  assert.equal(st.polled, 1);
  assert.ok(kalshiCalls.includes('/trade-api/v2/portfolio/fills'));
  const after = await (await call(url, null, pub.token, 'GET')).json();
  assert.deepEqual([after.counts.fills, after.counts.unmatched, after.counts.imported], [1, 1, 0]);
  assert.deepEqual(after.unmatched, ['KXNBAGAME-MADEUP-HOM']);

  const ops = await (await fetch(`${base}/api/ops`)).json();
  assert.equal(ops.kalshiLink.active, 1);

  assert.equal((await call('/api/records/kalshi_tester', null, pub.token, 'DELETE')).status, 200);
  assert.equal(srv.kalshiLinks.links.get('kalshi_tester').box, null, 'unpublish drops the key');
});
