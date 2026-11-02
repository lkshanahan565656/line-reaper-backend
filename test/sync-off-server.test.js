// With no AUTH_SECRET (the live server today) sync is off: the status says
// why, the sync routes answer 503 with that reason, and nothing else changes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lr-sync-off-'));
for (const k of Object.keys(process.env)) if (/^(DATABASE_URL|RAILWAY_|PAYWALL|LR_SYNC|AUTH_SECRET|STRIPE_)/.test(k)) delete process.env[k];
Object.assign(process.env, { LR_DATA_DIR: DIR, UPSTREAM_GAP_MS: '0', ALERT_STARTUP: 'off', USERS_FILE: path.join(DIR, 'users.json'), TRACKER_FILE: path.join(DIR, 'picks.json'), EV_TRACK_FILE: path.join(DIR, 'ev.json') });
const axios = require('axios');
axios.get = async url => { throw Object.assign(new Error(`offline: ${url}`), { code: 'ENOTFOUND' }); };
axios.post = axios.get;
const S = require('../server');
const cron = require('node-cron');
for (const t of cron.getTasks().values()) t.stop();

let srv, base;
test.before(async () => { await new Promise(r => { srv = S.app.listen(0, '127.0.0.1', r); }); base = `http://127.0.0.1:${srv.address().port}`; });
test.after(() => { srv?.closeAllConnections?.(); srv?.close(); for (const t of cron.getTasks().values()) t.stop(); fs.rmSync(DIR, { recursive: true, force: true }); });

test('sync is off without AUTH_SECRET and says why', async () => {
  const st = await (await fetch(`${base}/api/sync/status`)).json();
  assert.equal(st.enabled, false);
  assert.match(st.reason, /AUTH_SECRET/);
  const r = await fetch(`${base}/api/sync`);
  assert.equal(r.status, 503);
  assert.match((await r.json()).error, /AUTH_SECRET/);
  const status = await (await fetch(`${base}/api/status`)).json();
  assert.equal(status.accounts.sync.enabled, false);
});
