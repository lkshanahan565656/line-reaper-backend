// /api/props/cfbmodel: the CFB MODEL view prices a PrizePicks college line off the
// shipped box scores, labelled "model, not an edge", with its record and backtest;
// its confident legs go in the record under their own kind.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lr-cfbmodel-'));
for (const k of ['DATABASE_URL', 'ODDS_API_KEY', 'OWLS_API_KEY', 'ALERT_WEBHOOK_URL', 'CFB_MODEL']) delete process.env[k];
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

test('the CFB MODEL view prices an app line from the seed and never calls it an edge', async () => {
  assert.ok(srv.cfbModel, 'on by default');
  const H = srv.cfbModel.history();
  // a 2026 starting QB with the most games on file, on his last team
  const [aid, games] = [...H.players.entries()].filter(([, g]) => g[g.length - 1].season === 2026 && g[g.length - 1].pa >= 20)
    .sort((a, b) => b[1].length - a[1].length)[0];
  const last = games[games.length - 1];
  const kick = Date.now() + 5 * 3600e3;
  srv.cfbModel.state.schedule = [{ id: 'test1', t: kick, home: last.team, away: last.opp, done: false, total: 55.5, spread: -6.5,
    homeName: 'Home U', awayName: 'Away U', homeAbbr: 'HOM', awayAbbr: 'AWY' }];
  srv.cfbModel.state.refreshedAt = new Date().toISOString();
  srv.cache.prizepicks = { data: [{ book: 'prizepicks', sport: 'CFB', player: last.name, team: 'Home U', market: 'Pass Yards', line: 0.5, startTime: new Date(kick).toISOString(),
    overOpen: true, underOpen: true }], updated: new Date().toISOString() };
  const r = await fetch(`${base}/api/props/cfbmodel`);
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.on, true);
  assert.equal(d.label, 'model, not an edge');
  assert.match(d.bar, /50\+ graded live legs/);
  const row = d.rows.find(x => x.player === last.name && x.mkey === 'pass_yds');
  assert.ok(row, `priced ${aid} (${d.count} rows)`);
  assert.equal(row.team, 'Home U');
  assert.equal(row.spread, -6.5);
  assert.ok(row.apps.prizepicks.pOver > 0.9, 'half a yard is a near-certain Over for a starter');
  assert.ok(row.mean > 50);
  assert.ok(d.backtest && Array.isArray(d.backtest.lines) && d.backtest.lines.length > 0);
  assert.match(d.backtest.verdict, /No edge/);
  // the record's legs: a research kind of its own on PrizePicks, never the headline
  const flagged = srv.cfbModel.plays([{ key: row.key, sport: 'CFB', player: last.name, team: 'Home U', mkey: 'pass_yds', startTime: new Date(kick).toISOString(), books: { prizepicks: { line: 0.5 } } }]);
  assert.equal(flagged.length, 1);
  assert.equal(flagged[0].kind, 'cfb-model');
  assert.equal(flagged[0].research, true);
  assert.equal(flagged[0].play.side, 'Over');
  const rec = await (await fetch(`${base}/api/props/record`)).json();
  assert.ok(rec.overall);
});
