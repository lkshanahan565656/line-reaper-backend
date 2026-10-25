const test = require('node:test');
const assert = require('node:assert');
const M = require('../esstackmodel');
const { slipHitsDistribution } = require('../slip');
const { createSlipTracker } = require('../sliptrack');

const PARAMS = { games: { cs: { buckets: {
  'kills|1-2': { OVER: { f: [0.24, 0.07], tail: { m: [0.1, 2], d: [0, 1] } }, UNDER: { f: [0.18, 0.05], tail: {} } },
} } } };

test('each leg keeps its own price, with or without the tail', () => {
  for (const tail of [{}, { m: [0.1, 2.5] }, { m: [0.05, 3], d: [0.2, 1.6] }]) {
    for (const p of [0.3, 0.5, 0.62]) {
      const d = M.hitsDistribution([{ p, a: 0.5, b: 0.3, s: 1 }], tail);
      assert.ok(Math.abs(d[1] - p) < 1e-4, `p ${p} tail ${JSON.stringify(tail)} gave ${d[1]}`);
    }
  }
});

test('with no tail the link is the slip pricer\'s own factor model', () => {
  const legs = [1, 1, 1, -1, -1, -1].map(s => ({ p: 0.5, a: Math.sqrt(0.24), b: Math.sqrt(0.07), s }));
  const ours = M.hitsDistribution(legs, {})[6];
  const slip = slipHitsDistribution([1, 1, 1, 2, 2, 2].map((t, i) => ({ prob: 0.5, sport: 'CS', stat: 'kills', side: 'OVER', team: `t${t}`, gameId: 'g', player: `p${i}` })))[6];
  assert.ok(Math.abs(ours - slip) < 2e-4, `${ours} vs ${slip}`);
});

test('a distribution sums to one; unfitted legs ride independent', () => {
  const d = M.hitsDistribution([{ p: 0.4, a: null, b: null, s: 1 }, { p: 0.7, a: null, b: null, s: -1 }], { m: [0.1, 2] });
  assert.ok(Math.abs(d.reduce((a, b) => a + b, 0) - 1) < 1e-9);
  assert.ok(Math.abs(d[2] - 0.28) < 1e-9);
  assert.deepStrictEqual(M.mixture([0, 1]), [[1, 1]]);
  const mx = M.mixture([0.1, 2]);
  assert.ok(Math.abs(mx.reduce((a, [w, s]) => a + w * s * s, 0) - 1) < 1e-9);
});

test('span and stat buckets come from the market', () => {
  assert.strictEqual(M.spanKey({ market: 'MAPS 1-2 Kills' }), '1-2');
  assert.strictEqual(M.spanKey({ market: 'Maps 1-3 Kills' }), '1-2');
  assert.strictEqual(M.spanKey({ market: 'MAP 1 Kills' }), '1');
  assert.strictEqual(M.statKey('MAPS 1-2 Headshots'), 'headshots');
  const l = M.loadings(PARAMS, { sport: 'CS2', market: 'MAPS 1-2 Kills', side: 'UNDER', team: 'A' });
  assert.ok(l.a < 0 && l.b < 0);
  assert.strictEqual(M.loadings(PARAMS, { sport: 'CS2', market: 'MAPS 1-2 Kills', side: 'OVER' }), null, 'no team, no link');
  assert.strictEqual(M.loadings(PARAMS, { sport: 'R6', market: 'MAPS 1-2 Kills', side: 'OVER', team: 'A' }), null);
});

const leg = (player, team, prob, side = 'OVER') => ({ player, team, sport: 'CS2', market: 'MAPS 1-2 Kills', side, prob, line: 30.5, gameId: 'm1' });

test('repriced EV is the legs\' own edge; the link only sets the payout needed', () => {
  const picks = [leg('a', 'A', 0.55), leg('b', 'A', 0.55), leg('c', 'A', 0.55), leg('d', 'B', 0.55), leg('e', 'B', 0.55), leg('f', 'B', 0.55)];
  const pr = M.priceStack({ book: 'PP', payTable: { 6: 37.5 }, picks }, PARAMS);
  const indEv = (0.55 ** 6 * 37.5 - 1) * 100;
  assert.ok(Math.abs(pr.repriced.ev - indEv) < 0.05, `${pr.repriced.ev} vs ${indEv}`);
  assert.ok(pr.probAll > pr.probAllIndependent * 2, 'six overs from one CS match move together');
  assert.ok(pr.standard.ev > pr.repriced.ev);
  assert.strictEqual(pr.rule, 'repriced');
  assert.strictEqual(pr.flag, indEv >= 0);
  assert.ok(Math.abs(pr.breakEvenPays * pr.probAll - 1) < 0.01);
});

test('Pick6 is judged at its own table, flex rows count toward break-even', () => {
  const picks = [leg('a', 'A', 0.5), leg('b', 'A', 0.5), leg('c', 'A', 0.5), leg('d', 'B', 0.5), leg('e', 'B', 0.5), leg('f', 'B', 0.5)];
  const pr = M.priceStack({ book: 'P6', payTable: { 6: 25, 5: 1.5 }, picks }, PARAMS);
  assert.strictEqual(pr.rule, 'standard');
  assert.strictEqual(pr.ruleEv, pr.standard.ev);
  const rest = pr.hits[5] * 1.5;
  assert.ok(Math.abs(pr.breakEvenPays - (1 - rest) / pr.probAll) < 0.02);
});

test('board stacks: two teams, one leg a player, best size per match, app and side', () => {
  const legs = ['a', 'b', 'c', 'd'].map((p, i) => ({ ...leg(p, i < 2 ? 'A' : 'B', 0.6), ev: 5 - i, mult: 1 }))
    .concat([{ ...leg('a', 'A', 0.6), ev: 1, mult: 1 }]);
  const out = M.stacksForBook(legs, 'PP', { params: PARAMS });
  assert.ok(out.length >= 1);
  const s = out[0];
  assert.strictEqual(s.kind, 'es-stacks');
  assert.strictEqual(s.label, 'model, not an edge');
  assert.strictEqual(new Set(s.picks.map(l => l.player)).size, s.picks.length);
  assert.strictEqual(new Set(s.picks.map(l => l.team)).size, 2);
  assert.ok(s.flag, '60% legs clear PrizePicks power even repriced');
  assert.deepStrictEqual(Object.keys(s.payTable), Object.keys(s.standardPayTable));
  assert.ok(M.stacksForBook(legs.filter(l => l.team === 'A'), 'PP', { params: PARAMS }).length === 0, 'one team only: no stack');
  assert.deepStrictEqual(M.boardStacks([], { params: null }), { on: false, stacks: [], flagged: [], byBook: {} });
});

test('the slip tracker keeps model stacks in their own record', async () => {
  const t0 = Date.parse('2026-10-25T10:00:00Z');
  let now = t0;
  const tr = createSlipTracker({ now: () => now, graders: { CS: async l => ({ maps: { 1: l.player === 'f' ? 10 : 20, 2: 20 }, complete: true }) }, parseMapSpan: () => ({ label: '1-2' }) });
  const picks = ['a', 'b', 'c', 'd', 'e', 'f'].map((p, i) => ({ ...leg(p, i < 3 ? 'A' : 'B', 0.6), ev: 5, mult: 1, startTime: '2026-10-25T12:00:00Z' }));
  const [s] = M.stacksForBook(picks, 'PP', { params: PARAMS });
  await tr.record([s, s]);
  now = t0 + 6 * 3600e3;
  await tr.grade();
  const sum = await tr.summary();
  assert.strictEqual(sum.slips, 0, 'Best Slips untouched');
  assert.strictEqual(sum.stacks.slips, 0, 'the old stack record untouched');
  assert.strictEqual(sum.esStacks.flagged, 1, 'one a match, app and side');
  assert.strictEqual(sum.esStacks.graded, 1);
  assert.strictEqual(sum.esStacks.label, 'model, not an edge');
  assert.strictEqual(sum.esStacks.bar, 50);
  const row = (await tr.list())[0];
  const won = row.legs.filter(l => l.outcome === 'win').length;
  assert.strictEqual(row.hits, won);
  if (won === row.size) assert.ok(sum.esStacks.units < sum.esStacks.unitsStandard, 'repriced pays less than standard');
});

test('the shipped seed covers all four games and says which link each bucket uses', () => {
  const p = M.loadParams();
  assert.ok(p && p.rule && p.heldOut?.summary);
  for (const g of ['cs', 'lol', 'dota', 'val']) {
    const b = p.games[g]?.buckets || {};
    assert.ok(b['kills|1-2']?.OVER?.f && b['kills|1-2']?.UNDER?.f, g);
    for (const sides of Object.values(b)) for (const v of Object.values(sides)) {
      assert.ok(['fitted', 'slip.js FACTORS', 'independent'].includes(v.link), `${g} ${v.link}`);
      assert.ok(v.f[0] >= 0 && v.f[1] >= 0 && v.f[0] + v.f[1] < 1);
    }
  }
});
