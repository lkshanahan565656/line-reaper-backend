const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../calc');
const ex = require('../exchanges');

const near = (a, b, eps = 1e-6, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg || ''} ${a} vs ${b}`);

test('odds formats convert both ways and parse what bettors type', () => {
  near(C.americanToDecimal(150), 2.5); near(C.americanToDecimal(-110), 1 + 100 / 110);
  near(C.decimalToAmerican(2.5), 150); near(C.decimalToAmerican(1.5), -200);
  assert.equal(C.americanToDecimal(50), null);
  near(C.parseOdds('+150'), 2.5); near(C.parseOdds('-110'), 1.909090909);
  near(C.parseOdds('150'), 2.5); near(C.parseOdds('2.5'), 2.5); near(C.parseOdds('3/2'), 2.5);
  near(C.parseOdds('40%'), 2.5); near(C.parseOdds('40c'), 2.5); near(C.parseOdds('.40'), 2.5); near(C.parseOdds('0.4'), 2.5);
  for (const bad of ['', 'abc', '1', '-50', '0', '1/0', '100%']) assert.equal(C.parseOdds(bad), null, bad);
  assert.equal(C.fmtAmerican(C.parseOdds('-110')), '-110');
  assert.equal(C.fmtAmerican(2), '+100');
  assert.equal(C.decimalToFractional(2.5), '3/2');
  assert.equal(C.decimalToFractional(C.parseOdds('-110')), '10/11');
  const c = C.convert('+150');
  assert.equal(c.american, '+150'); near(c.prob, 0.4); assert.equal(c.cents, 40);
});

test('hold and the four no-vig methods', () => {
  const m = [1.909090909, 1.909090909];
  near(C.hold(m).hold, 1 - 1 / (2 / 1.909090909));
  near(C.hold(m).hold, 0.0454545, 1e-6);
  for (const k of ['multiplicative', 'additive', 'power', 'shin', 'worst']) {
    const p = C.devig(m, k); near(p[0], 0.5, 1e-6, k); near(p[1], 0.5, 1e-6, k);
  }
  // favourite -300 / dog +240: every method sums to 1, power and shin give the dog less than multiplicative
  const fav = [C.parseOdds('-300'), C.parseOdds('+240')];
  const res = {};
  for (const k of ['multiplicative', 'additive', 'power', 'shin']) { res[k] = C.devig(fav, k); near(res[k][0] + res[k][1], 1, 1e-6, k); }
  assert.ok(res.power[1] < res.multiplicative[1] && res.shin[1] < res.multiplicative[1]);
  near(res.additive[1], res.shin[1], 1e-9, 'two-way Shin is additive');
  const worst = C.devig(fav, 'worst');
  near(worst[1], Math.min(...Object.values(res).map(r => r[1])));
  // three-way market sums to 1
  const s = C.devig([2.1, 3.4, 3.8], 'shin'); near(s[0] + s[1] + s[2], 1, 1e-6);
  // no overround leaves the prices alone
  near(C.devig([2, 2], 'shin')[0], 0.5);
  assert.equal(C.devig([2], 'multiplicative'), null);
});

test('EV and Kelly', () => {
  near(C.ev(0.55, 2), 0.1);
  near(C.kelly(0.55, 2), 0.1); near(C.kelly(0.55, 2, 0.25), 0.025);
  assert.equal(C.kelly(0.4, 2), 0, 'never a negative stake');
  assert.equal(C.ev(1.2, 2), null);
});

test('arbitrage stakes equalise the return, and rounding reports the worst case', () => {
  const a = C.arbitrage([2.1, 2.1], 100);
  assert.ok(a.isArb); near(a.stakes[0], 50); near(a.profit, 5); near(a.roi, 0.05);
  const b = C.arbitrage([C.parseOdds('+110'), C.parseOdds('-105'), 12], 500, 5);
  b.stakes.forEach(s => assert.equal(s % 5, 0));
  near(b.profit, Math.min(...b.profits));
  assert.equal(C.arbitrage([1.9, 1.9], 100).isArb, false);
});

test('hedge: equal locks the same result both ways; breakeven gets the stake back', () => {
  const h = C.hedge(100, 5, 1.5);
  near(h.hedgeStake, 100 * 5 / 1.5); near(h.ifOpenWins, h.ifHedgeWins);
  const b = C.hedge(100, 5, 1.5, 'breakeven');
  near(b.ifHedgeWins, 0);
});

test('parlay multiplies and only prices EV with fair legs', () => {
  const p = C.parlay([{ dec: 2 }, { dec: 1.5 }], 10);
  near(p.dec, 3); near(p.payout, 30); assert.equal(p.ev, null);
  const q = C.parlay([{ dec: 2, prob: 0.55 }, { dec: 2, prob: 0.55 }]);
  near(q.ev, 0.3025 * 4 - 1);
});

test('middle: equal-miss stakes, break-even hit rate makes EV zero', () => {
  const m = C.middle(1.909090909, 1.909090909, 220);
  near(m.stakeA, 110); near(m.miss, 110 * 1.909090909 - 220); near(m.hit, 2 * 110 * 0.909090909);
  const e = C.middle(1.909090909, 1.909090909, 220, m.breakeven);
  near(e.ev, 0, 1e-9);
  near(C.windowProb(45, 13.5, 44.5, 47.5), C.normalCdf(2.5 / 13.5) - C.normalCdf(-0.5 / 13.5));
  assert.equal(C.windowProb(45, 13.5, 45.5, 45.5), null);
  assert.equal(C.windowProb(45, 13.5, 45, 46), 0);
});

test('free bet and profit boost conversion', () => {
  const f = C.freeBet(100, 5, 1.25);
  near(f.hedgeStake, 400 / 1.25); near(f.profit, 400 - 320); near(f.conversion, 0.8);
  // a profit boost's two outcomes match after the hedge
  const b = C.profitBoost(2, 50, 100, 1.909090909);
  near(b.boosted, 2.5); near(b.profitIfWin, 150);
  near(b.hedge.ifOpenWins, b.hedge.ifHedgeWins);
  assert.ok(b.ev > 0);
});

test('CLV against a de-vigged close', () => {
  const c = C.clv(2.2, 2, 2);
  near(c.clv, 0.1); assert.ok(c.devigged);
  const raw = C.clv(2.2, 2);
  near(raw.clv, 0.1); assert.equal(raw.devigged, false);
  assert.ok(C.clv(1.9, C.parseOdds('-120'), C.parseOdds('+100')).clv < 0.0);
});

test('exchange fees match the arb engine', () => {
  for (const [p, n] of [[0.5, 100], [0.37, 13], [0.92, 250], [0.03, 1]]) {
    near(C.kalshiFee(p, n), ex.kalshiFee(p, n), 1e-12, `kalshi ${p} ${n}`);
  }
  const k = C.exchangeBuy(0.5, 100, 'kalshi');
  near(k.fee, 1.75); near(k.cost, 51.75); near(k.breakeven, 0.5175); assert.equal(k.american, '-107');
  const pm = C.exchangeBuy(0.5, 100, 'polymarket', { myProb: 0.6 });
  near(pm.fee, 1.25); assert.ok(pm.ev > 0 && pm.kelly > 0);
  near(C.exchangeBuy(0.5, 100, 'none').fee, 0);
});

test('prop lines: poisson and normal, with pushes on whole lines', () => {
  const p = C.propLine(4, 4.5);
  let under = 0; for (let k = 0; k <= 4; k++) under += C.poissonPmf(k, 4);
  near(p.under, under); near(p.over + p.under, 1); assert.equal(p.push, 0);
  const w = C.propLine(4, 4);
  near(w.push, C.poissonPmf(4, 4)); near(w.over + w.under + w.push, 1);
  const n = C.propLine(250, 249.5, 40);
  near(n.over, 1 - C.normalCdf(-0.5 / 40 + 0), 1e-6); assert.equal(n.dist, 'normal');
  near(C.normalCdf(1.96), 0.975, 1e-4);
});
