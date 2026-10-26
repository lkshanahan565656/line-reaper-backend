// The venue tap counter routes: POST /api/ops/tap and the count in /api/ops.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lr-taps-'));
for (const k of ['DATABASE_URL', 'ODDS_API_KEY', 'OWLS_API_KEY', 'ALERT_WEBHOOK_URL', 'PUBLIC_URL']) delete process.env[k];
Object.assign(process.env, { LR_DATA_DIR: DIR, TRACKER_FILE: path.join(DIR, 'picks.json'), USERS_FILE: path.join(DIR, 'users.json'), EV_TRACK_FILE: path.join(DIR, 'ev.json'),
  SPORT_PROPS_FILE: path.join(DIR, 'sport-props.json'), ESPORTS_CALIBRATION: 'off' });
const axios = require('axios');
axios.get = async () => { throw Object.assign(new Error('offline'), { response: { status: 503 } }); };
axios.post = axios.get;
const srv = require('../server');
const cron = require('node-cron');
let server, base;
test.before(async () => { server = srv.app.listen(0); await new Promise(r => server.once('listening', r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => { server?.close(); for (const t of cron.getTasks().values()) t.stop(); fs.rmSync(DIR, { recursive: true, force: true }); setTimeout(() => process.exit(0), 50).unref(); });


test('/api/ops/tap counts a tap per venue and /api/ops shows it; unknown venues are refused', async () => {
  const before = (await (await fetch(`${base}/api/ops`)).json()).venueTaps;
  assert.equal(typeof before.total, 'number');
  const post = body => fetch(`${base}/api/ops/tap`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await post({ venue: 'kalshi', exact: true })).status, 204);
  assert.equal((await post({ venue: 'underdog', exact: false })).status, 204);
  assert.equal((await post({ venue: 'nowhere' })).status, 400);
  const after = (await (await fetch(`${base}/api/ops`)).json()).venueTaps;
  assert.equal(after.total, before.total + 2);
  assert.equal(after.byVenue.kalshi.exact, (before.byVenue.kalshi?.exact || 0) + 1);
  assert.equal(after.byVenue.underdog.board, (before.byVenue.underdog?.board || 0) + 1);
  assert.ok(!JSON.stringify(after).match(/ip|user|token/i), 'nothing about who tapped');
});
