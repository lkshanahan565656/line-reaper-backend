// Map kill Unders on a booted server (axios offline): a CS2 match whose
// Pinnacle rounds sit under PrizePicks' Map 1 kill lines summed opens a row
// in both records only inside 6 hours of the start, the play record only
// where the round model clears break-even, and the record shows on
// /api/esports/map-unders and RESULTS as research.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lr-mapunders-'));
for (const k of ['DATABASE_URL', 'ODDS_API_KEY', 'OWLS_API_KEY', 'ALERT_WEBHOOK_URL', 'PAYWALL', 'PUBLIC_URL', 'ESPORTS_MAP_UNDERS']) delete process.env[k];
Object.assign(process.env, { TRACKER_FILE: path.join(DIR, 'picks.json'), USERS_FILE: path.join(DIR, 'users.json'), EV_TRACK_FILE: path.join(DIR, 'ev.json'), ESPORTS_CALIBRATION: 'off', LR_DATA_DIR: DIR });
const axios = require('axios');
axios.get = async () => { throw Object.assign(new Error('offline'), { response: { status: 503 } }); };
axios.post = axios.get;
const srv = require('../server');
const cron = require('node-cron');
let server, base;
test.before(async () => { server = srv.app.listen(0); await new Promise(r => server.once('listening', r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => { server?.close(); for (const t of cron.getTasks().values()) t.stop(); fs.rmSync(DIR, { recursive: true, force: true }); setTimeout(() => process.exit(0), 50).unref(); });

const wait = ms => new Promise(r => setTimeout(r, ms));
function board(startMs) {
  const start = new Date(startMs).toISOString();
  srv.esBooksState.pin = [{ id: 901, game: 'CS2', league: 'Test Cup', teams: ['Team Vitality', 'FaZe Clan'], start: startMs,
    ladders: new Map([['rounds|1|total', [{ x: -21.5, p: 0.5 }]]]) }];
  const lines = { Vitality: [{ n: 'ZywOo', l: 21.5 }, { n: 'flameZ', l: 17.5 }, { n: 'apEX', l: 15.5 }, { n: 'Spinx', l: 16.5 }, { n: 'mezii', l: 15.5 }],
    FaZe: [{ n: 'broky', l: 17.5 }, { n: 'frozen', l: 17.5 }, { n: 'rain', l: 15.5 }, { n: 'karrigan', l: 13.5 }] };
  const picks = [];
  for (const [team, ps] of Object.entries(lines)) for (const x of ps) {
    // the round model's context for this player on map 1 (priceRoundKills sets it on the board)
    const kpr = x.l / 21.5 * (x.n === 'ZywOo' ? 0.8 : 1.05);
    picks.push({ sport: 'CS2', player: x.n, team, matchTitle: 'Vitality vs FaZe', market: 'Map 1 Kills', ppLine: x.l, lineSource: 'pp', startTime: start,
      rounds: { ctx: { game: 'CS2', kpr: +kpr.toFixed(4), qs: [team === 'Vitality' ? 0.55 : 0.45] }, mean: x.l } });
  }
  // a Maps 1-2 line is not a map line
  picks.push({ sport: 'CS2', player: 'ZywOo', team: 'Vitality', matchTitle: 'Vitality vs FaZe', market: 'Maps 1-2 Kills', ppLine: 40.5, lineSource: 'pp', startTime: start });
  return picks;
}

test('a match 9 hours out is read and shown, but opens no row', async () => {
  const st = srv.runMapUnders(board(Date.now() + 9 * 3600e3));
  assert.equal(st.groups, 1);
  assert.equal(st.flagged, 1, 'Pinnacle 146.2 kills under the app sum');
  await wait(50);
  assert.equal((await srv.mapUndersTracker.list({ limit: 100 })).length, 0);
  const g = srv.mapUndersState.groups[0];
  assert.equal(g.appName, 'PrizePicks');
  assert.equal(g.map, '1');
  assert.deepEqual(g.teams.map(t => t.n), [5, 4]);
  assert.ok(g.anchor.kills < g.appSum);
});

test('inside 6 hours: every flagged Under in the rule record, model plays in their own', async () => {
  const st = srv.runMapUnders(board(Date.now() + 3 * 3600e3));
  assert.ok(st.model >= 1 && st.model < 9, `model plays ${st.model}`);
  await wait(100);
  const rule = await srv.mapUndersTracker.list({ limit: 100 });
  const play = await srv.mapUndersModelTracker.list({ limit: 100 });
  assert.equal(rule.length, 9, 'nine players, PrizePicks only, map 1 only');
  assert.equal(play.length, st.model);
  for (const r of [...rule, ...play]) {
    assert.equal(r.signalSide, 'UNDER');
    assert.equal(r.signalBook, 'PP');
    assert.equal(r.appKey, 'PP');
    assert.equal(r.span, '1');
    assert.equal(r.be, 0.5503);
    assert.equal(r.signalDecimal, +(1 / 0.5503).toFixed(4));
  }
  assert.ok(play.every(r => r.modelProb - r.be >= 0.01));
  assert.ok(play.every(r => r.signalFair > 0), 'the model fair is kept for the close');
  // a second read follows the rows, never doubles them
  srv.runMapUnders(board(Date.now() + 3 * 3600e3 - 60e3));
  await wait(100);
  assert.equal((await srv.mapUndersTracker.list({ limit: 100 })).length, 9);
});

test('/api/esports/map-unders: the record and today\'s match-maps, labelled research', async () => {
  const d = await fetch(base + '/api/esports/map-unders').then(r => r.json());
  assert.equal(d.label, 'research, not an edge');
  assert.equal(d.alerts, false);
  assert.equal(d.now.groups.length, 1);
  assert.equal(d.record.model.cells[0].label, 'research, not an edge');
  assert.equal(d.record.rule.cells[0].open, 9);
  assert.equal(d.record.model.cells[0].graded, 0);
});

test('RESULTS: graded plays show as a research row, never proven, no profit shown', async () => {
  const rows = await srv.mapUndersModelTracker.list({ limit: 100 });
  // grade them by hand: one win, the rest losses
  let first = true;
  for (const r of rows) { r.status = 'locked'; }
  for (const r of rows) { await srv.mapUndersModelTracker.manualGrade(r.id, { result: first ? 5 : 40 }); first = false; }
  const d = await fetch(base + '/api/record').then(r => r.json());
  const row = d.rows.find(r => r.kind === 'props-es-map-under');
  assert.ok(row, 'a row on RESULTS');
  assert.equal(row.book, 'prizepicks');
  assert.equal(row.label, 'research');
  assert.match(row.why, /of 50 graded/);
  assert.equal(row.profitShown, false);
  assert.equal(row.wins, 1);
});
