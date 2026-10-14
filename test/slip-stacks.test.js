const test = require('node:test');
const assert = require('node:assert/strict');

const S = require('../slip');
const B = require('../slipbuild');

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const sum = a => a.reduce((x, y) => x + y, 0);
const mean = d => d.reduce((s, x, h) => s + h * x, 0);
const csLeg = (team, i, side = 'OVER', prob = 0.475, extra = {}) => ({
  prob, team, side, stat: 'kills', sport: 'CS2', gameId: 'M1', player: `${team}${i}`, scenarios: [{ maps: 2, weight: 1 }], ...extra,
});

test('factor model: marginals exact, distribution sums to 1', () => {
  const legs = [csLeg('A', 0, 'OVER', 0.55), csLeg('A', 1, 'UNDER', 0.6), csLeg('B', 0, 'OVER', 0.48), { ...csLeg('B', 1, 'OVER', 0.52), stat: 'headshots' }];
  const d = S.slipHitsDistribution(legs);
  close(sum(d), 1, 1e-6);
  close(mean(d), sum(legs.map(l => l.prob)), 2e-3);
});

test('factor model: measured CS stacks, under-called against the history', () => {
  // finished series: a 3+3 six-pick of overs hit 6.4 to 6.7%, a 2+2 11.0 to 11.5%
  const stack = (a, b) => S.slipHitsDistribution([...Array(a)].map((_, i) => csLeg('A', i)).concat([...Array(b)].map((_, i) => csLeg('B', i))))[a + b];
  const s22 = stack(2, 2), s33 = stack(3, 3);
  assert.ok(s22 > 0.095 && s22 < 0.115, `2+2 ${s22}`);
  assert.ok(s33 > 0.045 && s33 < 0.067, `3+3 ${s33}`);
  assert.ok(s33 > 0.475 ** 6 * 4, 'far above independent');
});

test('factor model: an OVER and an UNDER on teammates hit together less often', () => {
  const p = S.priceSlip([csLeg('A', 0), csLeg('A', 1, 'UNDER', 0.525)], 'prizepicks_power');
  assert.ok(p.probAll < 0.475 * 0.525 - 0.02);
});

test('factor model: LoL opponents pull apart on kills, teammates together', () => {
  const lol = (team, i) => ({ ...csLeg(team, i, 'OVER', 0.5), sport: 'LoL' });
  const mates = S.slipHitsDistribution([lol('A', 0), lol('A', 1)])[2];
  const foes = S.slipHitsDistribution([lol('A', 0), lol('B', 0)])[2];
  assert.ok(mates > 0.29 && foes < 0.25, `${mates} ${foes}`);
});

test('factor model: unmeasured sports and different matches stay as before', () => {
  const r6 = [csLeg('A', 0), csLeg('B', 0)].map(l => ({ ...l, sport: 'R6' }));
  assert.ok(S.legLoadings({ ...csLeg('A', 0), sport: 'DOTA' }), 'Dota is measured');
  assert.ok(S.legLoadings({ ...csLeg('A', 0), sport: 'VAL' }), 'Valorant is measured');
  assert.equal(S.legLoadings(r6[0]), null);
  const two = S.priceSlip([csLeg('A', 0), { ...csLeg('A', 1), gameId: 'M2' }], 'prizepicks_power');
  close(two.probAll, 0.475 * 0.475, 1e-4);
});

test('breakEvenScale: the payout cut that takes a slip to zero', () => {
  const p = S.priceSlip([csLeg('A', 0), csLeg('A', 1), csLeg('B', 0), csLeg('B', 1), csLeg('B', 2)], 'prizepicks_power');
  close(p.breakEvenScale * 20 * p.probAll, 1, 1e-3);
});

function boardPick(team, i, side, prob, game = 'G1') {
  return {
    sport: 'CS2', player: `${team}${i}`, team, side, gameId: game, matchTitle: 'A vs B MAPS 1-2', market: 'MAPS 1-2 Kills',
    startTime: '2099-01-01T00:00:00Z', ppEv: +((prob / 0.5622 - 1) * 100).toFixed(2),
    pricing: { meanPerMap: 15, k: 2, stat: 'kills', scenarios: [{ maps: 2, weight: 1 }], books: { PP: { line: 29.5, prob } } },
  };
}

test('stacks: one match, one side, two teams, flipped legs where PrizePicks takes them', () => {
  const picks = [
    boardPick('A', 0, 'OVER', 0.5), boardPick('A', 1, 'UNDER', 0.52), boardPick('A', 2, 'OVER', 0.49),
    boardPick('B', 0, 'OVER', 0.51), boardPick('B', 1, 'OVER', 0.48), boardPick('B', 2, 'UNDER', 0.5),
  ];
  const r = B.autoSlips(picks, { now: 0 });
  assert.ok(r.stacks.length >= 1);
  const s = r.stacks[0];
  assert.equal(s.kind, 'stack');
  assert.equal(s.book, 'PP');
  assert.equal(new Set(s.picks.map(l => l.side)).size, 1, 'every leg the same way');
  assert.ok(new Set(s.picks.map(l => l.team)).size === 2);
  assert.ok(s.ev > 0 && s.evIndependent < 0);
  assert.ok(s.breakEvenPays > 0 && s.breakEvenPays < s.paysAll);
  assert.ok(s.picks.some(l => l.flipped), 'an UNDER pick turned to its OVER');
});

test('stacks: nothing across matches, nothing for unmeasured sports', () => {
  const split = [boardPick('A', 0, 'OVER', 0.5, 'G1'), boardPick('B', 0, 'OVER', 0.5, 'G2'), boardPick('A', 1, 'OVER', 0.5, 'G1'), boardPick('B', 1, 'OVER', 0.5, 'G2')];
  assert.equal(B.autoSlips(split, { now: 0 }).stacks.length, 0);
  const r6 = ['A', 'B'].flatMap(t => [0, 1, 2].map(i => ({ ...boardPick(t, i, 'OVER', 0.5), sport: 'R6' })));
  assert.equal(B.autoSlips(r6, { now: 0 }).stacks.length, 0);
});

test('stack record: one row per match, book and side', async () => {
  const { createSlipTracker } = require('../sliptrack');
  const t = createSlipTracker({ now: () => 0 });
  const picks = ['A', 'B'].flatMap(team => [0, 1, 2].map(i => boardPick(team, i, 'OVER', 0.52)));
  const first = B.autoSlips(picks, { now: 0 }).stacks;
  const moved = B.autoSlips(picks.map(p => ({ ...p, pricing: { ...p.pricing, books: { PP: { line: 30.5, prob: 0.53 } } } })), { now: 0 }).stacks;
  assert.ok(first.length && moved.length);
  assert.ok([...first, ...moved].every(x => x.picks.every(l => l.side === 'OVER')));
  assert.equal(first[0].matchTitle, 'A vs B');
  await t.record([...first, ...moved]);
  const sum = await t.summary();
  assert.equal(sum.stacks.open, 1);
  assert.equal(sum.open, 0, 'Best Slips record untouched');
});

test('factor model: Dota teammates hit together, opponents a little less often', () => {
  const dota = (team, i) => ({ ...csLeg(team, i, 'OVER', 0.5), sport: 'DOTA' });
  const mates = S.slipHitsDistribution([dota('A', 0), dota('A', 1)])[2];
  const foes = S.slipHitsDistribution([dota('A', 0), dota('B', 0)])[2];
  assert.ok(mates > 0.27 && foes < 0.25, `${mates} ${foes}`);
});

test('factor model: Valorant teammates and opponents both lean together, weaker than CS', () => {
  const leg = (sport, team, i) => ({ ...csLeg(team, i, 'OVER', 0.5), sport });
  const six = sport => S.slipHitsDistribution([0, 1, 2].map(i => leg(sport, 'A', i)).concat([0, 1, 2].map(i => leg(sport, 'B', i))))[6];
  const val = six('VAL'), cs = six('CS2');
  assert.ok(val > 3 / 64 && val < cs, `${val} ${cs}`);
  assert.ok(S.slipHitsDistribution([leg('VAL', 'A', 0), leg('VAL', 'B', 0)])[2] > 0.25);
});
