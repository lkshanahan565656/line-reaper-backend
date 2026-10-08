const test = require('node:test');
const assert = require('node:assert/strict');

const D = require('../dist');
const C = require('../context');
const S = require('../slip');

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const sum = a => a.reduce((x, y) => x + y, 0);
const mean = d => d.reduce((s, x, h) => s + h * x, 0);

function spanLeg(player, team, maps, line, meanPerMap, side = 'OVER') {
  const scenarios = C.spanScenarios(maps, 0.55, 3);
  return {
    player, team, gameId: 'M1', scenarios, line, side, meanPerMap, k: 2.5, stat: 'kills',
    prob: D.propProb(line, side, { meanPerMap, k: 2.5, scenarios }).effective,
  };
}

test('slip: legs with different map spans in one series price the same in any order', () => {
  const A = spanLeg('A', 'T1', [1, 2], 36.5, 18);
  const B = spanLeg('B', 'T2', [1, 2, 3], 46.5, 18);
  assert.notDeepEqual(A.scenarios, B.scenarios);
  const ab = S.priceSlip([A, B], 'prizepicks_power');
  const ba = S.priceSlip([B, A], 'prizepicks_power');
  close(ab.probAll, ba.probAll, 1e-12);
  assert.equal(ab.ev, ba.ev);
  assert.deepEqual(ab.hits, ba.hits);
  // A's span always plays both maps, so it doesn't share the map-3 variable
  // with B; the only link left is the opposing-team kills term
  const foes = S.priceSlip([{ ...A, team: null }, { ...B, team: null }], 'prizepicks_power');
  close(foes.probAll, A.prob * B.prob, 2e-3);
});

test('slip: shorter span is the series length truncated at its end', () => {
  const B = spanLeg('B', 'T1', [1, 2, 3], 46.5, 18);
  const A = { ...spanLeg('A', 'T1', [1, 2], 36.5, 18), team: null };
  const lat = S.seriesLatents([A, B]);
  assert.equal(lat.length, 1, 'Maps 1-2 nests inside Maps 1-3');
  // a span that does not start at map 1 is not a truncation: its own latent
  const late = { ...B, scenarios: [{ maps: 1, weight: 0.4 }, { maps: 2, weight: 0.6 }] };
  assert.equal(S.seriesLatents([B, late]).length, 2);
  assert.equal(S.seriesLatents([late, B]).length, 2);
  // identical sets share the latent, and they correlate positively through it
  const B2 = { ...B, player: 'B2', team: null };
  const same = S.priceSlip([{ ...B, team: null }, B2], 'prizepicks_power');
  assert.ok(same.probAll > same.probAllIndependent + 1e-3);
});

test('slip: correlated hits keep every marginal and sum to 1', () => {
  const cases = [
    [0.6, 0.6, 0.6].map(p => ({ gameId: 'M1', team: 'T1', side: 'OVER', stat: 'kills', prob: p })),
    [0.55, 0.62, 0.48, 0.7, 0.51, 0.66].map((p, i) => ({
      gameId: 'M1', team: i % 2 ? 'T1' : 'T2', side: i % 3 ? 'OVER' : 'UNDER',
      stat: i % 2 ? 'assists' : 'kills', prob: p,
    })),
    [0.95, 0.9, 0.05].map(p => ({ gameId: 'M1', team: 'T1', side: 'OVER', stat: 'assists', prob: p })),
  ];
  for (const legs of cases) {
    const d = S.slipHitsDistribution(legs);
    close(sum(d), 1, 1e-9);
    close(mean(d), sum(legs.map(l => l.prob)), 1e-9);
    for (const x of d) assert.ok(x >= 0 && x <= 1);
    // each leg's own marginal, not just the total
    const w = S.patternDistribution(legs.map(l => l.prob), (i, j) => S.pairRho(legs[i], legs[j]));
    legs.forEach((l, i) => close(w.reduce((s, x, k) => s + ((k >> i) & 1 ? x : 0), 0), l.prob, 1e-9));
  }
});

test('slip: three teammate OVERs at 0.6 — E[hits] 1.8, both tails thinner', () => {
  const legs = [0, 1, 2].map(() => ({ gameId: 'M1', team: 'T1', side: 'OVER', stat: 'kills', prob: 0.6 }));
  const d = S.slipHitsDistribution(legs);
  const ind = S.independentHitsDistribution(legs);
  close(mean(d), 1.8, 1e-9);
  assert.ok(d[3] < ind[3], 'negative correlation: sweep less likely');
  assert.ok(d[0] < ind[0], 'negative correlation: zero hits less likely too');
});

test('slip: positive correlation fattens both tails; two legs hit the target joint exactly', () => {
  const legs = [0.55, 0.6].map(p => ({ gameId: 'M1', team: 'T1', side: 'OVER', stat: 'assists', prob: p }));
  const d = S.slipHitsDistribution(legs);
  const ind = S.independentHitsDistribution(legs);
  assert.ok(d[2] > ind[2] && d[0] > ind[0]);
  close(d[2], S.adjustJoint(0.55, 0.6, S.CORR.sameTeam.assists), 1e-9);
});

test('pairRho: opposite sides flip the sign for opponents as well as teammates', () => {
  const o = (team, side) => ({ team, side, stat: 'kills' });
  assert.ok(S.pairRho(o('T1', 'OVER'), o('T2', 'OVER')) < 0);
  assert.ok(S.pairRho(o('T1', 'OVER'), o('T2', 'UNDER')) > 0);
  assert.equal(S.pairRho(o('T1', 'OVER'), o('T2', 'UNDER')), -S.pairRho(o('T1', 'OVER'), o('T2', 'OVER')));
  assert.ok(S.pairRho(o('T1', 'OVER'), o('T1', 'UNDER')) > 0);
  const legs = side2 => [{ gameId: 'M1', prob: 0.6, ...o('T1', 'OVER') }, { gameId: 'M1', prob: 0.6, ...o('T2', side2) }];
  assert.ok(S.priceSlip(legs('UNDER'), 'prizepicks_power').probAll > 0.36);
  assert.ok(S.priceSlip(legs('OVER'), 'prizepicks_power').probAll < 0.36);
});

test('slip: legs in different matches stay uncorrelated', () => {
  const legs = [{ gameId: 'M1', team: 'T1', side: 'OVER', prob: 0.6 }, { gameId: 'M2', team: 'T1', side: 'OVER', prob: 0.6 }];
  const p = S.priceSlip(legs, 'prizepicks_power');
  close(p.probAll, 0.36, 1e-12);
  assert.equal(p.correlated, false);
  for (const f of ['ev', 'evIndependent', 'probAll', 'probAllIndependent', 'hits', 'kelly', 'correlated']) assert.ok(f in p);
});
