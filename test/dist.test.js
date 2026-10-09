const test = require('node:test');
const assert = require('node:assert/strict');

const D = require('../dist');
const S = require('../slip');

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('logGamma and the NB pmf are a real distribution', () => {
  close(D.logGamma(1), 0, 1e-9);
  close(D.logGamma(5), Math.log(24), 1e-9);
  close(D.logGamma(0.5), Math.log(Math.sqrt(Math.PI)), 1e-9);

  const m = 6, k = 2.5;
  let sum = 0, mean = 0, m2 = 0;
  for (let n = 0; n <= 400; n++) {
    const p = D.nbPmf(n, m, k);
    assert.ok(p >= 0);
    sum += p; mean += n * p; m2 += n * n * p;
  }
  close(sum, 1, 1e-9);
  close(mean, m, 1e-6);
  close(m2 - mean * mean, k * m, 1e-5);   // variance is exactly k·mean, as asked
});

test('NB cdf is monotone and agrees with the pmf', () => {
  const m = 4, k = 2;
  close(D.nbCdf(0, m, k), D.nbPmf(0, m, k));
  let prev = -1;
  for (let n = 0; n < 30; n++) {
    const c = D.nbCdf(n, m, k);
    assert.ok(c >= prev); prev = c;
  }
  close(D.nbCdf(400, m, k), 1, 1e-9);
  assert.equal(D.nbCdf(-1, m, k), 0);
});

test('half-integer lines have no push; whole lines do', () => {
  const a = D.sideProbs(3.5, 4, 2.5);
  close(a.under + a.over, 1);
  assert.equal(a.push, 0);
  assert.equal(a.model, 'nb');
  // P(under 3.5) = P(X <= 3)
  close(a.under, D.nbCdf(3, 4, 2.5));

  const b = D.sideProbs(4, 4, 2.5);
  assert.ok(b.push > 0.05, 'a whole line pushes a real fraction of the time');
  close(b.under + b.over + b.push, 1);
  close(b.push, D.nbPmf(4, 4, 2.5));
});

test('the count model beats the normal one where it matters: low lines', () => {
  // LoL support, 2.5 kills, k=8: the normal curve puts mass below zero
  const mean = 2.2, k = 8, line = 2.5;
  const nb = D.sideProbs(line, mean, k);
  const sd = Math.sqrt(mean * k);
  const normalUnder = D.normalCdf(line, mean, sd);
  const normalBelowZero = D.normalCdf(0, mean, sd);
  assert.ok(normalBelowZero > 0.1, 'the normal model really is broken here');
  // 2.6 points of probability against a 56.2% breakeven is roughly 5% of EV
  assert.ok(Math.abs(nb.under - normalUnder) > 0.02, 'and the NB answer differs materially');
  // the NB answer never claims impossible outcomes
  close(D.nbCdf(-1, mean, k), 0);

  // at a big line the two converge: a few points apart, not tens
  const big = D.sideProbs(40.5, 40, 2.5);
  close(big.under, D.normalCdf(40.5, 40, Math.sqrt(40 * 2.5)), 0.03);
  assert.ok(Math.abs(big.under - D.normalCdf(40.5, 40, Math.sqrt(40 * 2.5)))
    < Math.abs(nb.under - normalUnder), 'and they agree better at 40 than at 2.5');
});

test('fantasy points and degenerate inputs stay on the normal curve', () => {
  assert.equal(D.sideProbs(20.5, 20, 2.5, 'fantasy').model, 'normal');
  assert.equal(D.sideProbs(2.5, 3, 1, 'kills').model, 'normal', 'k<=1 is not over-dispersed');
  assert.equal(D.useCount('kills', 0, 2), false);
});

test('propProb mixes scenarios and reports the push-adjusted number', () => {
  const scenarios = [{ maps: 2, weight: 0.6 }, { maps: 3, weight: 0.4 }];
  const r = D.propProb(40.5, 'OVER', { meanPerMap: 18, k: 2.5, scenarios });
  const two = D.sideProbs(40.5, 36, 2.5), three = D.sideProbs(40.5, 54, 2.5);
  close(r.over, 0.6 * two.over + 0.4 * three.over);
  close(r.win, r.over);
  close(r.effective, r.win);                       // no push on a half line
  assert.ok(r.over > D.sideProbs(40.5, 36, 2.5).over, 'the 3-map case pulls it up');

  const push = D.propProb(40, 'OVER', { meanPerMap: 20, k: 2.5 });
  assert.ok(push.push > 0);
  assert.ok(push.effective > push.win, 'a refunded push raises the effective odds');
});

test('slip: same-series legs are not independent', () => {
  const scenarios = [{ maps: 2, weight: 0.6 }, { maps: 3, weight: 0.4 }];
  const leg = (player, team) => ({
    player, team, gameId: 'M1', scenarios, line: 40.5, side: 'OVER',
    meanPerMap: 18, k: 2.5, stat: 'kills',
    prob: D.propProb(40.5, 'OVER', { meanPerMap: 18, k: 2.5, scenarios }).effective,
  });
  const legs = [leg('A', 'Vitality'), leg('B', 'NAVI')];
  const priced = S.priceSlip(legs, 'prizepicks_power');
  assert.ok(priced.correlated);
  assert.ok(priced.probAll > priced.probAllIndependent,
    'both need the same third map, so they land together more often than independence says');
  close(priced.hits.reduce((a, b) => a + b, 0), 1, 1e-5);

  // legs in different series stay independent
  const other = { ...leg('C', 'G2'), gameId: 'M2' };
  const split = S.priceSlip([legs[0], other], 'prizepicks_power');
  close(split.probAll, split.probAllIndependent, 1e-3);
  assert.equal(split.correlated, false);
});

test('slip: teammates on kills drag each other down', () => {
  const base = { gameId: 'M1', prob: 0.56, stat: 'kills', side: 'OVER' };
  const mates = S.priceSlip([{ ...base, team: 'T1' }, { ...base, team: 'T1' }], 'prizepicks_power');
  const foes = S.priceSlip([{ ...base, team: 'T1' }, { ...base, team: 'KT' }], 'prizepicks_power');
  const indep = 0.56 * 0.56;
  assert.ok(mates.probAll < indep, 'two teammates both going over is harder than independence suggests');
  assert.ok(mates.probAll < foes.probAll);
  close(mates.probAllIndependent, indep, 1e-9);
});

test('slip EV, payout tables and leg counts', () => {
  const leg = p => ({ prob: p, stat: 'kills' });
  // 2-leg power at 3x: breakeven probability is 1/sqrt(3) ≈ 0.5774
  const even = S.priceSlip([leg(0.5774), leg(0.5774)], 'prizepicks_power');
  close(even.ev, 0, 0.1);
  assert.ok(S.priceSlip([leg(0.62), leg(0.62)], 'prizepicks_power').ev > 0);
  assert.ok(S.priceSlip([leg(0.52), leg(0.52)], 'prizepicks_power').ev < 0);

  // flex pays something on a near miss, so it survives a weak leg better
  const three = [leg(0.58), leg(0.58), leg(0.45)];
  assert.ok(S.priceSlip(three, 'prizepicks_flex').ev > S.priceSlip(three, 'prizepicks_power').ev);

  assert.equal(S.priceSlip([leg(0.6)], 'prizepicks_power'), null, 'no 1-leg table');
  assert.equal(S.priceSlip([leg(0.6), leg(0.6)], 'nonsense'), null);
  const all = S.priceAll([leg(0.6), leg(0.6), leg(0.6)]);
  assert.ok(all.length >= 2);
  assert.ok(all[0].ev >= all[1].ev, 'sorted best first');
});

test('kelly stakes only +EV slips and never risks ruin', () => {
  const leg = p => ({ prob: p, stat: 'kills' });
  assert.equal(S.priceSlip([leg(0.5), leg(0.5)], 'prizepicks_power').kelly, 0);
  const good = S.priceSlip([leg(0.65), leg(0.65)], 'prizepicks_power');
  assert.ok(good.kelly > 0 && good.kelly < 1);
  // a huge edge still can't stake the whole roll when a loss is total
  const huge = S.priceSlip([leg(0.95), leg(0.95)], 'prizepicks_power');
  assert.ok(huge.kelly < 1);
  assert.ok(huge.kelly > good.kelly);
});

test('bestSlips builds entries at each size, best first', () => {
  const pool = [0.64, 0.62, 0.60, 0.58, 0.45].map((p, i) => ({
    player: `P${i}`, team: `T${i}`, gameId: `M${i}`, prob: p, ev: (p - 0.5622) * 100, stat: 'kills', side: 'OVER',
  }));
  const slips = S.bestSlips(pool, { maxLegs: 3 });
  assert.ok(slips.length >= 2);
  assert.ok(slips[0].ev >= slips[slips.length - 1].ev);
  for (const s of slips) {
    assert.equal(s.picks.length, s.legs);
    assert.ok(!s.picks.includes(pool[4]) || s.legs > 3, 'the worst leg is not picked first');
  }
  assert.deepEqual(S.bestSlips([], {}), []);
});
