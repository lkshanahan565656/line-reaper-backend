// /api/props/cbbmodel: the CBB MODEL view prices a PrizePicks college basketball
// line off the shipped box scores, labelled "model, not an edge", with its
// record from 0 and its backtest; its confident legs go in the record under
// their own kinds.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lr-cbbmodel-'));
for (const k of ['DATABASE_URL', 'ODDS_API_KEY', 'OWLS_API_KEY', 'ALERT_WEBHOOK_URL', 'CBB_MODEL']) delete process.env[k];
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

test('the CBB MODEL view prices an app line from the seed and never calls it an edge', async () => {
  assert.ok(srv.cbbModel, 'on by default');
  const H = srv.cbbModel.history();
  // a 2025-26 starter with the most games on file, on his last team
  const [key, games] = [...H.players.entries()].filter(([, g]) => g.length >= 25 && g[g.length - 1].min >= 28).sort((a, b) => b[1].length - a[1].length)[0];
  const last = games[games.length - 1];
  const tip = Date.now() + 5 * 3600e3;
  srv.cbbModel.state.schedule = [{ id: 'test1', t: tip, home: last.team, away: last.opp, done: false, total: 141.5, spread: -6.5,
    homeName: 'Home State Hornets', awayName: 'Away Tech Owls', homeAbbr: 'HOM', awayAbbr: 'AWY' }];
  srv.cbbModel.state.refreshedAt = new Date().toISOString();
  srv.cache.prizepicks = { data: [{ book: 'prizepicks', sport: 'CBB', player: last.name, team: 'HOM', market: 'Points', line: 0.5, startTime: new Date(tip).toISOString(),
    overOpen: true, underOpen: true }], updated: new Date().toISOString() };
  const r = await fetch(`${base}/api/props/cbbmodel`);
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.on, true);
  assert.equal(d.sport, 'CBB');
  assert.equal(d.label, 'model, not an edge');
  assert.match(d.bar, /50\+ graded live legs/);
  const row = d.rows.find(x => x.player === last.name && x.mkey === 'points');
  assert.ok(row, `priced ${key} (${d.count} rows)`);
  assert.equal(row.team, 'HOM');
  assert.equal(row.total, 141.5);
  assert.ok(row.apps.prizepicks.pOver > 0.9, 'half a point is a near-certain Over for a starter');
  assert.ok(row.minutes <= 40);
  assert.equal(row.version, 'v1');
  assert.ok(row.apps.prizepicks.breakEven > 0.55 && row.apps.prizepicks.breakEven < 0.551);
  assert.ok(d.backtest && Array.isArray(d.backtest.lines) && d.backtest.lines.length > 0);
  assert.match(d.backtest.verdict, /[Bb]ar (not )?cleared/);
  // the record starts from 0: its own kinds, nothing logged yet
  assert.deepEqual(Object.keys(d.record), ['prizepicks', 'pick6', 'underdog']);
  assert.equal(d.record.prizepicks, null);
  // the record's legs: a research kind of its own on PrizePicks, never the headline
  const flagged = srv.cbbModel.plays([{ key: row.key, sport: 'CBB', player: last.name, team: 'HOM', mkey: 'points', startTime: new Date(tip).toISOString(), books: { prizepicks: { line: 0.5 } } }]);
  assert.equal(flagged.length, 1);
  assert.equal(flagged[0].kind, 'cbb-model');
  assert.equal(flagged[0].research, true);
  assert.equal(flagged[0].play.side, 'Over');
  const ud = srv.cbbModel.plays([{ key: row.key, sport: 'CBB', player: last.name, team: 'HOM', mkey: 'points', startTime: new Date(tip).toISOString(), books: { underdog: { line: 0.5, over: 1, under: null } } }]);
  assert.equal(ud.length, 1);
  assert.equal(ud[0].kind, 'ud-cbb-model');
  // NBA's view is untouched by college rows
  const nba = await (await fetch(`${base}/api/props/nbamodel`)).json();
  assert.ok(!nba.rows.some(x => x.player === last.name));
});
