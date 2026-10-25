// POST /api/slips/grade: an old leg the board never saw (a Pikkit import) is
// graded from ESPN's box scores and says where its result came from; the
// answer carries the apps' live tables for the break-even.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lr-slipgrade-'));
for (const k of ['DATABASE_URL', 'ODDS_API_KEY', 'OWLS_API_KEY', 'ALERT_WEBHOOK_URL']) delete process.env[k];
Object.assign(process.env, { TRACKER_FILE: path.join(DIR, 'picks.json'), USERS_FILE: path.join(DIR, 'users.json'), EV_TRACK_FILE: path.join(DIR, 'ev.json'),
  SPORT_PROPS_FILE: path.join(DIR, 'sport-props.json'), SLIP_LEGS_FILE: path.join(DIR, 'slip-legs.json'), SLIP_LATE_FILE: path.join(DIR, 'slip-late.json'),
  PROP_CLOSES_FILE: path.join(DIR, 'prop-closes.json'), LR_DATA_DIR: DIR, ESPORTS_CALIBRATION: 'off' });
const axios = require('axios');
// ESPN answers for one finished NBA game; everything else is offline
const GAME = { id: '401', date: '2026-10-20T23:30Z', shortName: 'MIA @ ORL', name: 'Miami Heat at Orlando Magic', status: { type: { completed: true } },
  competitions: [{ competitors: [{ team: { displayName: 'Orlando Magic', abbreviation: 'ORL', name: 'Magic', location: 'Orlando' } }, { team: { displayName: 'Miami Heat', abbreviation: 'MIA', name: 'Heat', location: 'Miami' } }] }] };
const BOX = { boxscore: { players: [{ team: { displayName: 'Orlando Magic' }, statistics: [{ keys: ['minutes', 'points', 'rebounds', 'assists'], athletes: [{ athlete: { displayName: 'Paolo Banchero' }, stats: ['35', '24', '9', '5'] }] }] }] } };
const espn = [];
axios.get = async (url, opts = {}) => {
  if (/espn\.com.*basketball\/nba\/scoreboard/.test(url)) { espn.push(url); return { data: { events: opts.params?.dates === '20261020' ? [GAME] : [] } }; }
  if (/espn\.com.*basketball\/nba\/summary/.test(url)) { espn.push(url); return { data: BOX }; }
  throw Object.assign(new Error('offline'), { response: { status: 503 } });
};
axios.post = async () => { throw Object.assign(new Error('offline'), { response: { status: 503 } }); };
const srv = require('../server');
const cron = require('node-cron');
let server, base;
test.before(async () => { server = srv.app.listen(0); await new Promise(r => server.once('listening', r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => { server?.close(); for (const t of cron.getTasks().values()) t.stop(); fs.rmSync(DIR, { recursive: true, force: true }); setTimeout(() => process.exit(0), 50).unref(); });

test('an imported leg is graded from the box scores, says its source, and is kept', async () => {
  const leg = { id: 'pk|1', app: 'prizepicks', sport: 'NBA', player: 'Paolo Banchero', market: 'Points', side: 'Over', line: 22.5, betAt: '2026-10-20T20:00:00Z', betAtExact: true };
  const post = async legs => (await fetch(`${base}/api/slips/grade`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ legs }) })).json();
  const d = await post([leg, { ...leg, id: 'pk|2', player: 'Nobody', sport: null, betAt: '2026-10-01T20:00:00Z' }]);
  const g = d.results['pk|1'];
  assert.equal(g.status, 'graded'); assert.equal(g.outcome, 'win'); assert.equal(g.result, 24); assert.equal(g.final, true);
  assert.equal(g.gradeSource, 'ESPN box score'); assert.equal(g.gameSource, 'box score search'); assert.equal(g.late, true);
  assert.equal(g.closeEv, null, 'no close: the board never saw this prop');
  assert.equal(d.results['pk|2'].reason, 'sport');
  assert.ok('pick6' in d.tables);
  // the second ask reads the kept result
  const n = espn.length;
  assert.equal((await post([{ ...leg, id: 'pk|3' }])).results['pk|3'].outcome, 'win');
  assert.equal(espn.length, n);
  const rec = await (await fetch(`${base}/api/slips/record`)).json();
  assert.equal(rec.late.graded, 1);
  assert.ok(rec.closeBook && typeof rec.closeBook.live === 'number');
});
