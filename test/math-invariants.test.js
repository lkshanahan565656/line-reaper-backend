// Invariants of the shared betting math (oddsengine.js, esmatchup.js series
// math) checked over grids of prices and chances, beside the worked examples
// in their own test files. A break here means a number on the shopper or a
// matchup page is wrong for some price, not just the example one.
const test = require('node:test');
const assert = require('node:assert/strict');
const oe = require('../oddsengine');
const esm = require('../esmatchup');

const close = (a, b, eps = 1e-6, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg || ''} ${a} vs ${b}`);
const sum = xs => xs.reduce((a, b) => a + b, 0);
const PRICES = [1.05, 1.3, 1.5, 1.83, 1.91, 2, 2.2, 2.75, 3.5, 6, 12];

test('every devig method gives chances in (0,1) that sum to 1 and keep the order of the prices', () => {
  for (const a of PRICES) for (const b of PRICES) {
    if (1 / a + 1 / b < 1) continue;   // only sets that carry a margin
    for (const m of oe.DEVIG_METHODS) {
      const p = oe.devig([a, b], m);
      if (p == null) { assert.equal(m, 'additive', `${m} ${a}/${b}`); continue; }   // additive can push a long shot below 0
      close(sum(p), 1, 1e-6, `${m} ${a}/${b}`);
      assert.ok(p.every(x => x > 0 && x < 1));
      if (a < b) assert.ok(p[0] >= p[1], `${m}: shorter price is likelier`);
      // removing the margin can only lower a chance below its raw implied one
      assert.ok(p[0] <= 1 / a + 1e-9 && p[1] <= 1 / b + 1e-9, `${m} ${a}/${b}`);
    }
  }
});

test('a fair set (no margin) devigs to its own implied chances', () => {
  for (const m of oe.DEVIG_METHODS) {
    const p = oe.devig([2, 2], m);
    close(p[0], 0.5, 1e-9, m); close(p[1], 0.5, 1e-9, m);
    const q = oe.devig([1.25, 5], m);
    close(q[0], 0.8, 1e-6, m); close(q[1], 0.2, 1e-6, m);
  }
});

test('hold, arb stakes and payout agree for every pair of prices', () => {
  for (const a of PRICES) for (const b of PRICES) {
    const r = oe.arb([a, b], 100);
    const h = 1 / a + 1 / b - 1;
    close(r.hold, h, 1e-4);
    assert.equal(r.arb, h < 0);
    close(sum(r.stakes), 100, 0.02, 'stakes use the whole total');
    // every outcome pays the same, and that payout is total / (1 + hold)
    close(r.stakes[0] * a, r.payout, 0.02 * a); close(r.stakes[1] * b, r.payout, 0.02 * b);
    close(r.payout, 100 / (1 + h), 0.01);
    close(r.profit, 1 / (1 + h) - 1, 1e-4);
  }
});

test('EV, EV in dollars and Kelly line up; Kelly is 0 exactly when EV is not positive', () => {
  for (const d of PRICES) for (let p = 0.02; p < 1; p += 0.07) {
    const e = oe.ev(p, d);
    close(e, p * d - 1, 1e-12);
    close(oe.evAmount(p, d, 50), 50 * e, 1e-9);
    const k = oe.kelly(p, d);
    if (e > 1e-12) { assert.ok(k > 0); close(k, e / (d - 1), 1e-9); close(oe.kelly(p, d, 0.25), k / 4, 1e-12); }
    else assert.equal(k, 0);
  }
  assert.equal(oe.ev(1.2, 2), null); assert.equal(oe.ev(0.5, 1), null);
});

test('commission only ever lowers a price, by the rate on the winnings', () => {
  for (const d of PRICES) for (const c of [0, 0.02, 0.05, 0.1]) {
    const e = oe.afterCommission(d, c);
    assert.ok(e <= d + 1e-12 && e > 1);
    close(e - 1, (d - 1) * (1 - c), 1e-12);
    close(oe.effective(d, { type: 'commission', rate: c }), e, 1e-12);
  }
  assert.equal(oe.effective(2, { type: 'included' }), 2);
});

test('a contract fee makes the price worse, and is largest at 50 cents', () => {
  let maxFee = 0, maxAt = null;
  for (let c = 1; c < 100; c++) {
    const price = c / 100;
    const fee = oe.contractFee(price, { roundCents: false });
    close(fee, 0.07 * price * (1 - price), 1e-12);
    if (fee > maxFee) { maxFee = fee; maxAt = c; }
    const rounded = oe.contractFee(price);
    assert.ok(rounded >= fee - 1e-12, 'rounding up never lowers the fee');
    const d = oe.contractDecimal(price);
    if (d != null) assert.ok(d < 1 / price, `fee lowers the payout at ${c}c`);
  }
  assert.equal(maxAt, 50);
});

test('a lay is the back of the other side: liability, back price and EV agree', () => {
  for (const L of PRICES) for (const c of [0, 0.02, 0.05]) {
    close(oe.layLiability(10, L), 10 * (L - 1), 1e-12);
    const b = oe.layAsBack(L, c);
    // risk (L-1) to win (1-c): back decimal = 1 + (1-c)/(L-1)
    close((b - 1) * (L - 1), 1 - c, 1e-12);
    for (const p of [0.1, 0.4, 0.7]) close(oe.layEv(p, L, c), (1 - p) * b - 1, 1e-12);
    // with no commission a lay at the fair price is break-even
    if (c === 0) close(oe.layEv(1 / L, L, 0), 0, 1e-9);
  }
});

test('series math: scores sum to 1, win + loss (+ draw) = 1, symmetric, and a better team gains from a longer series', () => {
  for (const bo of [1, 2, 3, 5, 7]) for (const kappa of [0, 8, 30]) for (let i = 1; i < 20; i++) {
    const p = i / 20;
    if (bo === 1) { close(esm.seriesProb(p, 1, kappa), p, 1e-9); continue; }
    const sc = esm.seriesScores(p, bo, kappa);
    close(sum(sc.map(s => s.prob)), 1, 1e-9, `bo${bo} k${kappa} p${p}`);
    const m = esm.seriesMarkets(p, bo, kappa);
    close(m.win + m.loss + (m.draw || 0), 1, 3e-4);
    // the other team's chance is the mirror image
    const loss = sum(sc.filter(x => x.a < x.b).map(x => x.prob));
    close(esm.seriesProb(1 - p, bo, kappa), loss, 1e-6);
    if (bo >= 3 && p > 0.5 && kappa === 0) assert.ok(esm.seriesProb(p, bo, kappa) > p, 'favourite gains in a longer series (independent maps)');
  }
});

test('series math: mapFromSeries inverts seriesProb', () => {
  for (const bo of [3, 5]) for (const kappa of [0, 12]) for (let i = 1; i < 10; i++) {
    const p = i / 10;
    const s = esm.seriesProb(p, bo, kappa);
    close(esm.mapFromSeries(s, bo, kappa), p, 1e-6, `bo${bo} k${kappa}`);
  }
});

test('series math: independent Bo3 matches the closed form', () => {
  for (let i = 1; i < 10; i++) {
    const p = i / 10;
    close(esm.seriesProb(p, 3, 0), p * p * (3 - 2 * p), 1e-12);
    close(esm.seriesProb(p, 5, 0), p ** 3 * (1 + 3 * (1 - p) + 6 * (1 - p) ** 2), 1e-12);
  }
});
