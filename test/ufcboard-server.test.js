// /api/props/ufc: the UFC VS PINNACLE view answers with its bar, record kinds
// and backtest, and prices nothing when Pinnacle and the UFC data are offline.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lr-ufc-'));
for (const k of ['DATABASE_URL', 'ODDS_API_KEY', 'OWLS_API_KEY', 'ALERT_WEBHOOK_URL', 'UFC_PIN']) delete process.env[k];
Object.assign(process.env, { TRACKER_FILE: path.join(DIR, 'picks.json'), USERS_FILE: path.join(DIR, 'users.json'), EV_TRACK_FILE: path.join(DIR, 'ev.json'),
  SPORT_PROPS_FILE: path.join(DIR, 'sport-props.json'), ESPORTS_CALIBRATION: 'off' });
const axios = require('axios');
axios.get = async () => { throw Object.assign(new Error('offline'), { response: { status: 503 } }); };
axios.post = axios.get;
const srv = require('../server');
const cron = require('node-cron');
let server, base;
test.before(async () => { server = srv.app.listen(0); await new Promise(r => server.once('listening', r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => { server?.close(); for (const t of cron.getTasks().values()) t.stop(); fs.rmSync(DIR, { recursive: true, force: true }); setTimeout(() => process.exit(0), 50).unref(); });

test('UFC VS PINNACLE: model not an edge, twelve record kinds, nothing priced while offline', async () => {
  const start = new Date(Date.now() + 5 * 3600e3).toISOString();
  srv.cache.prizepicks = { data: [{ book: 'prizepicks', sport: 'MMA', player: 'Ann Lee', team: 'Ann Lee', market: 'Significant Strikes', line: 40.5, startTime: start, overOpen: true, underOpen: true }], updated: new Date().toISOString() };
  const r = await fetch(`${base}/api/props/ufc`);
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.on, true);
  assert.equal(d.label, 'model, not an edge');
  assert.match(d.bar, /50\+ graded live/);
  assert.equal(Object.keys(d.record).length, 12);
  assert.ok(Object.keys(d.record).includes('ufc-stat') && Object.keys(d.record).includes('sl-ufc-time'));
  assert.ok(d.model && d.model.holdout.sig.n > 0, 'the fitted model says what it was checked on');
  // Pinnacle and the UFCStats files are offline here: nothing priced, nothing made up
  assert.equal(d.rows.length, 0);
  assert.equal(d.counts.clears, 0);
  assert.equal(d.pinnacle.fights, 0);
  assert.equal(d.data.fights, 0);
  assert.ok(d.data.error == null || /offline/.test(d.data.error));
});
