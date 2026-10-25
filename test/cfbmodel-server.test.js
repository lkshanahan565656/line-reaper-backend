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
  assert.match(d.backtest.verdict, /Bar not cleared/);
  // v2: calibrated, each app's real payout, the record by version
  assert.equal(d.version, 'v2');
  assert.match(d.versionNote, /calibration/);
  assert.ok('underdog' in d.record && 'prizepicks' in d.recordByVersion && 'underdog' in d.recordByVersion);
  assert.equal(row.version, 'v2');
  assert.ok(row.apps.prizepicks.breakEven > 0.55 && row.apps.prizepicks.breakEven < 0.551);
  assert.ok(row.apps.prizepicks.ev > 0, 'a near-certain side is worth more than the 55% break-even');
  assert.equal(row.bestPay.book, 'prizepicks');
  // the record's legs: a research kind of its own on PrizePicks, never the headline
  const all = srv.cfbModel.plays([{ key: row.key, sport: 'CFB', player: last.name, team: 'Home U', mkey: 'pass_yds', startTime: new Date(kick).toISOString(), books: { prizepicks: { line: 0.5 } } }]);
  const flagged = all.filter(l => l.kind === 'cfb-model');
  assert.equal(flagged.length, 1);
  // half a yard is far under the projection: a far-from-projection leg of its own (farlines.js)
  const far = all.filter(l => l.kind === 'far-cfb');
  assert.equal(far.length, 1);
  assert.equal(far[0].research, true);
  assert.equal(far[0].play.side, 'Over');
  assert.ok(far[0].play.farD >= 1);
  assert.ok(row.apps.prizepicks.far && row.far);
  assert.equal(d.far.label, 'model, not an edge');
  assert.equal(d.far.minD, 1);
  assert.match(d.far.backtest.verdict, /no app cleared/);
  assert.ok('prizepicks' in d.far.record && 'underdog' in d.far.record);
  assert.ok(d.far.count >= 1);
  const only = await (await fetch(`${base}/api/props/cfbmodel?far=1`)).json();
  assert.ok(only.rows.length >= 1 && only.rows.every(x => x.far));
  assert.equal(flagged[0].kind, 'cfb-model');
  assert.equal(flagged[0].research, true);
  assert.equal(flagged[0].play.side, 'Over');
  assert.equal(flagged[0].play.modelVersion, 'v2');
  // Underdog: logged on value at its real multiplier; a side with no multiplier read is never priced at 1x
  const udRow = m => ({ key: row.key, sport: 'CFB', player: last.name, team: 'Home U', mkey: 'pass_yds', startTime: new Date(kick).toISOString(), books: { underdog: { line: 0.5, over: m, under: null } } });
  const ud = srv.cfbModel.plays([udRow(1)]).filter(l => l.kind === 'ud-cfb-model');
  assert.equal(ud.length, 1);
  assert.equal(ud[0].kind, 'ud-cfb-model');
  assert.equal(ud[0].play.mult, 1);
  assert.ok(ud[0].play.ev >= 5);
  assert.equal(srv.cfbModel.plays([udRow(null)]).length, 0);
  assert.equal(srv.cfbModel.plays([udRow(1)]).filter(l => l.kind === 'ud-far-cfb').length, 1);
  const rec = await (await fetch(`${base}/api/props/record`)).json();
  assert.ok(rec.overall);
});
