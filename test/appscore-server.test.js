// GET /api/props/shop/scorecard: the close book's props, each app's closing
// number against Pinnacle's close, graded results from the app scorecard store.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lr-appscore-'));
for (const k of ['DATABASE_URL', 'ODDS_API_KEY', 'OWLS_API_KEY', 'ALERT_WEBHOOK_URL']) delete process.env[k];
const start = new Date(Date.now() - 6 * 3600e3).toISOString();
const day = new Date(Date.parse(start) - 4 * 3600e3).toISOString().slice(0, 10);
const key = `NFL|pukanacua|rec_yds|${start}`;
fs.writeFileSync(path.join(DIR, 'prop-closes.json'), JSON.stringify([{ id: `pc-${day}`, day, status: 'day', start: `${day}T12:00:00Z`, props: {
  [key]: { sport: 'NFL', player: 'Puka Nacua', team: 'LAR', matchTitle: 'LAR @ JAX', market: 'Receiving Yards', mkey: 'rec_yds', start, pin: [[60.5, 0.56]], kal: [],
    apps: { prizepicks: 60.5, underdog: 66.5 }, cells: { prizepicks: [60.5, null, null, 1, 1], underdog: [66.5, 1, 1, 1, 1] }, seenAt: start, ageMin: 2, closeOk: true },
} }]));
fs.writeFileSync(path.join(DIR, 'app-card.json'), JSON.stringify([{ id: `ac|${key}`, key, status: 'graded', start, sport: 'NFL', result: 71 }]));
Object.assign(process.env, { TRACKER_FILE: path.join(DIR, 'picks.json'), USERS_FILE: path.join(DIR, 'users.json'), EV_TRACK_FILE: path.join(DIR, 'ev.json'),
  PROP_CLOSES_FILE: path.join(DIR, 'prop-closes.json'), APP_CARD_FILE: path.join(DIR, 'app-card.json'), LR_DATA_DIR: DIR, ESPORTS_CALIBRATION: 'off' });
const axios = require('axios');
axios.get = async () => { throw Object.assign(new Error('offline'), { response: { status: 503 } }); };
axios.post = async () => { throw Object.assign(new Error('offline'), { response: { status: 503 } }); };
const srv = require('../server');
const cron = require('node-cron');
let server, base;
test.before(async () => { server = srv.app.listen(0); await new Promise(r => server.once('listening', r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => { server?.close(); for (const t of cron.getTasks().values()) t.stop(); fs.rmSync(DIR, { recursive: true, force: true }); setTimeout(() => process.exit(0), 50).unref(); });

test('the scorecard lists each app against Pinnacle\'s close, graded from the store', async () => {
  const d = await (await fetch(`${base}/api/props/shop/scorecard?sport=NFL`)).json();
  assert.equal(d.props, 1);
  assert.equal(d.legs, 2);
  assert.equal(d.graded, 2);
  const pp = d.apps.find(a => a.app === 'prizepicks'), ud = d.apps.find(a => a.app === 'underdog');
  assert.equal(pp.exact, 100);
  assert.equal(pp.graded.w, 1);                // Over 60.5, 71
  assert.equal(ud.high, 100);                  // 6 above Pinnacle: the Under gets the better number
  assert.equal(ud.graded.l, 1);                // Under 66.5, 71
  assert.match(d.note, /Research, not a play/);
  assert.equal(d.preregistered, 'checks/app-scorecard-2026-10-25/PREREGISTERED.md');
  const none = await (await fetch(`${base}/api/props/shop/scorecard?sport=NBA`)).json();
  assert.equal(none.legs, 0);
});
