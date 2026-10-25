// The +EV screen and the alt-lines screen on recorded boards (the 10-15
// 06:17Z raw feeds replayed through the server: Pinnacle's, FanDuel's,
// BetRivers' and the exchanges' games, the apps' lines, Kalshi's mids).
// `expect` holds what each screen gave in one go before it ran in slices:
// the rows, fairs, costs and Pinnacle fairs must be the same, in one go and
// a step at a time.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const ev = require('../ev');
const alt = require('../altlines');
const freebooks = require('../freebooks');
const { runSteps, runStepsAsync } = require('../ops');

const rev = (k, v) => (v && v.__map ? new Map(v.__map) : v && v.__set ? new Set(v.__set) : v);
const load = f => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname, 'fixtures', f))), rev);
const evFix = load('evscreen-snapshot.json.gz');
const altFix = load('altlines-snapshot.json.gz');
// the app payouts the recording's DFS legs were priced with
const dfsEv = (p, book, mult) => (book === 'prizepicks' ? (p / 0.5622 - 1) * 100 : book === 'underdog' ? (p * (mult || 1) / 0.5623 - 1) * 100 : (p * (mult || 1) - 1) * 100);
const leagueOf = s => freebooks.LEAGUES[s]?.props || s.toUpperCase();

test('snapshot: the recorded boards hold game lines, props, DFS legs and alt rungs', () => {
  assert.ok(evFix.expect.rows.length > 100 && evFix.expect.rows.some(r => r.dfs) && evFix.expect.rows.some(r => r.player));
  assert.ok(evFix.expect.fairs.length > 1000 && altFix.expect.rows.length > 100);
});

test('snapshot: the +EV screen gives the recorded rows and maps, in one go and a step at a time', async () => {
  for (const mode of ['once', 'steps', 'async']) {
    const fairs = new Map(), costs = new Map(), pinFairs = new Map();
    const opts = { ...evFix.input, dfsEv, fairs, costs, pinFairs };
    const rows = mode === 'once' ? ev.screen(opts) : mode === 'steps' ? runSteps(ev.screenSteps(opts)) : await runStepsAsync(ev.screenSteps(opts), { sliceMs: 1 });
    assert.deepStrictEqual(rows, evFix.expect.rows, mode);
    assert.deepStrictEqual([...fairs], evFix.expect.fairs, mode);
    assert.deepStrictEqual([...costs], evFix.expect.costs, mode);
    assert.deepStrictEqual([...pinFairs], evFix.expect.pinFairs, mode);
  }
});

test('snapshot: the alt-lines screen gives the recorded rows and maps, in one go and a step at a time', async () => {
  for (const mode of ['once', 'async']) {
    const fairs = new Map(), costs = new Map();
    const opts = { ...altFix.input, now: altFix.at, leagueOf, fairs, costs };
    const rows = mode === 'once' ? alt.screen(opts) : await runStepsAsync(alt.screenSteps(opts), { sliceMs: 1 });
    assert.deepStrictEqual(rows, altFix.expect.rows, mode);
    assert.deepStrictEqual([...fairs], altFix.expect.fairs, mode);
    assert.deepStrictEqual([...costs], altFix.expect.costs, mode);
  }
});

test('the step runners: one go and slices give the same answer, slices hand the loop back', async () => {
  function* work(n) { let t = 0; for (let i = 0; i < n; i++) { t += i; if (i % 10 === 0) yield; } return t; }
  assert.equal(runSteps(work(1000)), 499500);
  const stats = {};
  let ticks = 0;
  const timer = setInterval(() => ticks++, 0);
  function* slow() { for (let i = 0; i < 40; i++) { const t = performance.now(); while (performance.now() - t < 2); yield; } return 'done'; }
  assert.equal(await runStepsAsync(slow(), { sliceMs: 5, stats }), 'done');
  clearInterval(timer);
  assert.ok(stats.slices > 5 && stats.maxSliceMs < 30, JSON.stringify(stats));
  assert.ok(ticks > 0, 'a timer ran between slices');
});
