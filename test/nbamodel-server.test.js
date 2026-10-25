// /api/props/nbamodel: the NBA MODEL view prices a PrizePicks NBA line off the
// shipped box scores, labelled "model, not an edge", with its record and backtest.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lr-nbamodel-'));
for (const k of ['DATABASE_URL', 'ODDS_API_KEY', 'OWLS_API_KEY', 'ALERT_WEBHOOK_URL', 'NBA_MODEL']) delete process.env[k];
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

test('the NBA MODEL view prices an app line from the seed and never calls it an edge', async () => {
  assert.ok(srv.nbaModel, 'on by default');
  const H = srv.nbaModel.history();
  // a player with plenty of games in the seed, on his last team
  const [key, games] = [...H.players.entries()].sort((a, b) => b[1].length - a[1].length)[0];
  const last = games[games.length - 1];
  const tip = Date.now() + 5 * 3600e3;
  srv.nbaModel.state.schedule = [{ id: 'test1', t: tip, home: last.team, away: last.opp, done: false, total: 224.5, spread: -3.5, homeName: '', awayName: '' }];
  srv.nbaModel.state.refreshedAt = new Date().toISOString();
  srv.cache.prizepicks = { data: [{ book: 'prizepicks', sport: 'NBA', player: last.name, team: last.team, market: 'Points', line: 0.5, startTime: new Date(tip).toISOString(),
    overOpen: true, underOpen: true }], updated: new Date().toISOString() };
  const r = await fetch(`${base}/api/props/nbamodel`);
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.on, true);
  assert.equal(d.label, 'model, not an edge');
  assert.match(d.bar, /50\+ graded live legs/);
  const row = d.rows.find(x => x.player === last.name && x.mkey === 'points');
  assert.ok(row, `priced ${key}`);
  assert.equal(row.team, last.team);
  assert.ok(row.apps.prizepicks.pOver > 0.9, 'half a point is a near-certain Over for a regular');
  assert.ok(row.mean > 1);
  // its backtest ships with it, real numbers only
  assert.ok(d.backtest && Array.isArray(d.backtest.lines) && d.backtest.lines.length > 0);
  // the record endpoint lists the model's kinds apart from the headline
  const rec = await (await fetch(`${base}/api/props/record`)).json();
  assert.ok(rec.overall);
});
