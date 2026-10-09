// Sizing that is the same at every venue and for everyone: sizeAt, the
// Polymarket taker fee, and tradeSignal putting q on the signal and sizing it
// with sizeAt, so the server can size the same bet at Kalshi or a sportsbook.
const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../tail');

const NOW = Date.parse('2026-10-08T12:00:00Z');
const W = n => `0x${String(n).padStart(40, '0')}`;
const near = (a, b, eps = 1e-9, msg = '') => assert.ok(Math.abs(a - b) <= eps, `${msg} ${a} ≈ ${b}`);
const round2 = x => Math.round(x * 100) / 100;
const round4 = x => Math.round(x * 1e4) / 1e4;

test('sizeAt: quarter Kelly at price + fee, 1u = 1% of bankroll, capped 2u for A and 1u for B', () => {
  const a = T.sizeAt({ q: 0.42, price: 0.41, grade: 'A' });
  near(a.kelly, 0.01 / 0.59);
  assert.deepEqual({ units: a.units, maxPrice: a.maxPrice, cost: a.cost, cap: a.cap }, { units: round2(25 * 0.01 / 0.59), maxPrice: 0.41, cost: 0.41, cap: 2 });
  assert.equal(a.units, 0.42);

  // the fee comes off the edge: Polymarket sports at 45¢ is 0.05 × 0.45 × 0.55 = 1.2375¢ a share
  const fee = T.polymarketFee(0.45, { rate: 0.05 });
  near(fee, 0.012375);
  const free = T.sizeAt({ q: 0.5, price: 0.45, grade: 'A' });
  const paid = T.sizeAt({ q: 0.5, price: 0.45, feePerContract: fee, grade: 'A' });
  near(paid.kelly, (0.5 - 0.462375) / (1 - 0.462375));
  near(paid.cost, 0.462375);
  assert.equal(paid.units, round2(25 * (0.5 - 0.462375) / (1 - 0.462375)));
  assert.ok(paid.units < free.units, `${paid.units} < ${free.units}`);
  assert.deepEqual([free.maxPrice, paid.maxPrice], [0.49, 0.48], 'with the fee, 48¢ is the most to pay');

  // caps: q 0.7 at 50¢ is Kelly 0.4, 10u raw
  const big = { q: 0.7, price: 0.5 };
  assert.equal(T.sizeAt({ ...big, grade: 'A' }).units, 2);
  assert.equal(T.sizeAt({ ...big, grade: 'B' }).units, 1);
  assert.equal(T.sizeAt({ ...big, grade: 'b' }).units, 1, 'grade letter in any case');
  assert.equal(T.sizeAt({ ...big, grade: null }).units, 0, 'ungraded: nothing');
  assert.equal(T.sizeAt({ ...big, grade: 'A', opts: { grades: { A: { capUnits: 1.5 } } } }).units, 1.5);
  assert.equal(T.sizeAt({ ...big, grade: 'A', opts: { kellyFraction: 0.01 } }).units, 0.4, 'options are the tail options');
});

test('sizeAt: consensus (a count or the wallets) is ×1.5, never above 3u', () => {
  const big = { q: 0.7, price: 0.5 };
  assert.deepEqual([T.sizeAt({ ...big, grade: 'A', consensus: 2 }).units, T.sizeAt({ ...big, grade: 'A', consensus: 2 }).cap], [3, 3]);
  assert.deepEqual([T.sizeAt({ ...big, grade: 'B', consensus: 3 }).units, T.sizeAt({ ...big, grade: 'B', consensus: 3 }).cap], [1.5, 1.5]);
  assert.equal(T.sizeAt({ ...big, grade: 'A', consensus: [W(1), W(2)] }).units, 3);
  assert.equal(T.sizeAt({ ...big, grade: 'A', consensus: [W(1), W(1)] }).units, 2, 'one wallet twice is one opinion');
  assert.equal(T.sizeAt({ ...big, grade: 'A', consensus: ['0xAB', '0xab'] }).units, 2, 'in any case');
  assert.equal(T.sizeAt({ ...big, grade: 'A', consensus: 2, opts: { maxUnits: 2.5 } }).units, 2.5);
  assert.equal(T.sizeAt({ q: 0.42, price: 0.41, grade: 'A', consensus: 2 }).units, round2(25 * (0.01 / 0.59) * 1.5));
  assert.equal(T.sizeAt({ q: 0.42, price: 0.41, grade: 'A' }).cap, 2, 'one wallet: the plain cap');
});

test('sizeAt: no edge after the fee is 0u; no price is no Kelly, but still a price limit', () => {
  assert.equal(T.sizeAt({ q: 0.42, price: 0.42, grade: 'A' }).units, 0);
  assert.ok(T.sizeAt({ q: 0.42, price: 0.43, grade: 'A' }).kelly < 0);
  assert.equal(T.sizeAt({ q: 0.42, price: 0.43, grade: 'A' }).units, 0);
  assert.equal(T.sizeAt({ q: 0.42, price: 0.41, feePerContract: 0.01, grade: 'A' }).units, 0, 'the fee eats the edge');
  assert.deepEqual(T.sizeAt({ q: 0.42, price: null, grade: 'A' }), { kelly: null, units: 0, maxPrice: 0.41, cost: null, cap: 2 });
  assert.equal(T.sizeAt({ q: 0.42, price: 1, grade: 'A' }).kelly, null);
  assert.equal(T.sizeAt({ q: 0.995, price: 0.99, feePerContract: 0.02, grade: 'A' }).kelly, null, 'costs $1 or more: nothing to win');
  assert.deepEqual(T.sizeAt({ q: null, price: 0.5, grade: 'A' }), { kelly: null, units: 0, maxPrice: null, cost: 0.5, cap: 2 });
  assert.equal(T.sizeAt({ q: 0.6, price: '0.5', feePerContract: '0.01', grade: 'A' }).cost, 0.51, 'numbers as strings');
  assert.equal(T.sizeAt({ q: 0.6, price: 0.5, feePerContract: -0.05, grade: 'A' }).cost, 0.5, 'a negative fee is no fee');
});

test('sizeAt maxPrice: the highest cent still worth paying with the fee, rounded down', () => {
  const cases = [
    [0.4271, 0, 0.42], [0.43, 0, 0.42], [0.42 + 1e-12, 0, 0.41], [0.42 + 1e-6, 0, 0.42],
    [0.5, 0.0125, 0.48], [0.5, 0.02, 0.47], [0.995, 0, 0.99], [0.999, 0, 0.99], [0.015, 0, 0.01], [0.01, 0, null], [0.02, 0.015, null],
  ];
  for (const [q, fee, want] of cases) {
    const r = T.sizeAt({ q, price: 0.005, feePerContract: fee, grade: 'A' });
    assert.equal(r.maxPrice, want, `q ${q} fee ${fee}`);
    if (want == null) continue;
    // at maxPrice there is still an edge; a cent more and there isn't
    assert.ok(T.sizeAt({ q, price: want, feePerContract: fee, grade: 'A' }).kelly > 0, `edge at ${want}`);
    if (want < 0.99) assert.ok(!(T.sizeAt({ q, price: round2(want + 0.01), feePerContract: fee, grade: 'A' }).kelly > 1e-9), `none at ${round2(want + 0.01)}`);
  }
});

test('Polymarket taker fee: rate × (p(1 − p))^exponent from the market\'s schedule; a sports market without one pays 5%, most others nothing', () => {
  const sched = m => T.parseFeeSchedule(m);
  assert.deepEqual(sched({ feeType: 'sports_fees_v2', feeSchedule: { rate: 0.05, exponent: 1, takerOnly: true, rebateRate: 0.25 } }), { rate: 0.05, exponent: 1, type: 'sports_fees_v2' });
  assert.deepEqual(sched({ feeSchedule: '{"rate":"0.02","exponent":"2"}' }), { rate: 0.02, exponent: 2, type: null }, 'a JSON string, numbers as strings');
  assert.deepEqual(sched({ feeType: 'sports_fees_v2' }), { rate: 0.05, exponent: 1, type: 'sports_fees_v2' }, 'the published rate, so a missing field never looks free');
  assert.deepEqual(sched({ feeSchedule: { rate: 5 } }), { rate: 0.05, exponent: 1, type: null }, 'a percent');
  assert.equal(sched({ feeSchedule: { rate: 0 } }), null);
  assert.equal(sched({ feeSchedule: 'junk' }), null);
  assert.equal(sched({ question: 'Will Russia and Ukraine agree a ceasefire?' }), null, 'geopolitics: no fee');
  near(T.polymarketFee(0.5, { rate: 0.05 }), 0.0125);
  near(T.polymarketFee(0.5, { rate: 0.02, exponent: 2 }), 0.02 * 0.0625);
  near(T.polymarketFee(0.9, { rate: 0.05 }), 0.0045, 1e-12, 'a favourite pays far less');
  assert.equal(T.polymarketFee(0.5, null), 0);
  assert.equal(T.polymarketFee(1, { rate: 0.05 }), 0);
  const m = T.parseGammaMarket({ conditionId: 'c', feeType: 'sports_fees_v2', feeSchedule: { rate: 0.05, exponent: 1 } });
  assert.deepEqual(m.fee, { rate: 0.05, exponent: 1, type: 'sports_fees_v2' });
  assert.equal(T.parseGammaMarket({ conditionId: 'c' }).fee, null);
});

// ── tradeSignal ──
const trader = (o = {}) => ({ wallet: W(9), name: 'sharpie', grade: 'A', edge: 0.05, avgEntry: 0.4, categories: {}, ...o });
const market = (o = {}) => T.parseGammaMarket({
  conditionId: '0xm1', question: 'Will X win the Ohio Senate election?', outcomes: '["Yes","No"]', outcomePrices: '["0.405","0.595"]',
  clobTokenIds: '["tok-yes","tok-no"]', bestBid: '0.40', bestAsk: '0.41', lastTradePrice: '0.41', endDate: '2026-11-04T00:00:00Z',
  active: true, closed: false, events: [{ slug: 'ohio-senate' }], ...o,
});
const trade = (o = {}) => T.parseTrades([{
  proxy_wallet: W(9), side: 'BUY', token_id: 'tok-yes', condition_id: '0xm1', size: 2000, price: 0.40, timestamp: Math.floor((NOW - 60e3) / 1000),
  title: 'Will X win the Ohio Senate election?', slug: 'will-x-win', event_slug: 'ohio-senate', outcome: 'Yes', outcome_index: 0,
  name: 'sharpie', transaction_hash: '0xtx1', ...o,
}])[0];
const sig = (o = {}) => T.tradeSignal({ trade: trade(o.trade), trader: trader(o.trader), market: o.market === null ? null : market(o.market), book: o.book ?? null, consensus: o.consensus, prior: o.prior, now: NOW, opts: o.opts }).signal;
const resize = s => T.sizeAt({ q: s.q, price: s.currentPrice, feePerContract: s.fee ?? 0, grade: s.grade, consensus: s.consensus });
const SPORTS = {
  trade: { title: 'Lakers vs. Celtics', event_slug: 'nba-lal-bos-2026-10-08', price: 0.44, size: 3000 },
  market: { question: 'Lakers vs. Celtics', outcomes: '["Lakers","Celtics"]', bestAsk: '0.45', bestBid: '0.44', feeType: 'sports_fees_v2', feeSchedule: { rate: 0.05, exponent: 1, takerOnly: true } },
  trader: { categories: { sports: { grade: 'A', edge: 0.08, avgEntry: 0.45, n: 200 } } },
};

test('tradeSignal puts q on the signal and sizes it with sizeAt at Polymarket\'s ask plus its taker fee', () => {
  const cases = {
    politics: {}, consensus: { consensus: [W(10)] }, B: { trader: { grade: 'B', edge: 0.2 } }, capped: { trader: { edge: 0.2 }, consensus: [W(10), W(11)] },
    no: { trade: { token_id: 'tok-no', outcome: 'No', outcome_index: 1, price: 0.58 }, market: { bestBid: '0.42', bestAsk: '0.43' }, trader: { edge: 0.1 } },
    sports: SPORTS,
  };
  for (const [name, o] of Object.entries(cases)) {
    const s = sig(o);
    assert.equal(s.type, 'entry', name);
    assert.ok(s.q > 0 && s.q < 1, `${name}: q ${s.q}`);
    assert.equal(s.prob, round4(s.q), `${name}: prob is q rounded`);
    const r = resize(s);
    assert.ok(s.units > 0, `${name}: sized`);
    assert.equal(s.units, r.units, `${name}: units`);
    assert.equal(s.target, r.units);
    assert.equal(s.maxPrice, r.maxPrice, `${name}: maxPrice`);
    assert.equal(s.kelly, round4(r.kelly), `${name}: kelly`);
    assert.equal(s.cap, r.cap, `${name}: cap`);
  }
  // q is the wallet's edge carried to its price, as before
  near(sig().q, 0.42, 1e-12);
  near(sig(SPORTS).q, T.trueProb(0.44, 0.08, 0.45), 1e-12, 'the category\'s own edge and average price');
  // the sports market's fee is charged; the politics one has none
  assert.deepEqual([sig().fee, sig().feeRate], [0, 0]);
  const s = sig(SPORTS);
  near(s.fee, 0.05 * 0.45 * 0.55, 1e-6);
  assert.equal(s.feeRate, 0.05);
  const noFee = sig({ ...SPORTS, market: { ...SPORTS.market, feeType: null, feeSchedule: null } });
  assert.ok(s.units < noFee.units, `the fee costs size: ${s.units} < ${noFee.units}`);
  assert.equal(noFee.fee, 0);
});

test('tradeSignal: q is there even when it signals 0u, so another venue can still size it', () => {
  // the price ran 4¢ past their fill: 0u here, though the edge is big
  const ran = sig({ trader: { edge: 0.4 }, market: { bestAsk: '0.44', bestBid: '0.43' } });
  assert.deepEqual([ran.units, ran.reason], [0, "price ran, don't chase"]);
  assert.ok(ran.q > 0.5);
  assert.ok(resize(ran).units > 0, 'the chase rule is about this price, not about q');
  // no book: no price, no fee, still q and a price limit
  const unpriced = sig({ market: null });
  assert.deepEqual([unpriced.currentPrice, unpriced.fee, unpriced.units, unpriced.kelly], [null, null, 0, null]);
  assert.equal(unpriced.maxPrice, T.sizeAt({ q: unpriced.q, grade: 'A' }).maxPrice);
  assert.equal(unpriced.maxPrice, 0.41);
  // a top-up stakes the rest of sizeAt's target
  const first = sig({ trader: { edge: 0.2 } });
  const top = sig({ trader: { edge: 0.2 }, prior: { id: 'first', units: 1.25 }, trade: { transaction_hash: '0xtx2' } });
  assert.equal(top.target, resize(top).units);
  assert.equal(top.units, round2(top.target - 1.25));
  assert.equal(first.units, top.target);
  // exits carry no sizing
  const exit = sig({ trade: { side: 'SELL' } });
  assert.deepEqual([exit.type, exit.q, exit.units], ['exit', undefined, undefined]);
});

// ── live prices: the order book, not Gamma ──
test('parseBook: the CLOB lists asks high to low and bids low to high; the best of each is picked', () => {
  const b = T.parseBook({ asks: [{ price: '0.62', size: '10' }, { price: '0.596', size: '2055' }], bids: [{ price: '0.55', size: '5' }, { price: '0.59', size: '232.27' }], timestamp: '1791558388424' });
  assert.deepEqual([b.ask, b.askSize, b.bid, b.bidSize, b.mid, b.at], [0.596, 2055, 0.59, 232.27, 0.593, 1791558388424]);
  assert.deepEqual(T.parseBook({ asks: [], bids: [{ price: '0.4', size: '1' }] }), { ask: null, bid: 0.4, mid: null, spread: null, askSize: null, bidSize: 1, at: null });
  for (const junk of [null, [], {}, { error: 'not found' }, 'x']) assert.equal(T.parseBook(junk), null);
  assert.equal(T.parseBook({ asks: [{ price: '1', size: '5' }, { price: '0.5', size: '0' }] }).ask, null, 'no real level');
});

test('a signal is priced at the token\'s book; a stale Gamma price is no price', () => {
  // seen live: Gamma said 35.4¢ (last updated weeks earlier) while the book's ask was 59.6¢
  const staleGamma = { bestAsk: '0.354', bestBid: '0.349', updatedAt: new Date(NOW - 23 * 86400e3).toISOString() };
  const book = T.parseBook({ asks: [{ price: '0.596', size: '2055' }], bids: [{ price: '0.59', size: '232' }] });
  const live = sig({ trade: { price: 0.58 }, market: staleGamma, book });
  assert.deepEqual([live.currentPrice, live.priceSource, live.slippage], [0.596, 'book', 0.016]);
  const blind = sig({ trade: { price: 0.58 }, market: staleGamma });
  assert.deepEqual([blind.currentPrice, blind.priceSource, blind.units], [null, 'gamma', 0], 'no book and a stale Gamma: not sized');
  assert.match(blind.reason, /no live price/);
  const fresh = sig({ trade: { price: 0.40 }, market: { bestAsk: '0.41', updatedAt: new Date(NOW - 60e3).toISOString() } });
  assert.deepEqual([fresh.currentPrice, fresh.priceSource], [0.41, 'gamma'], 'a fresh Gamma price still serves when the book can\'t be read');
  const empty = sig({ trade: { price: 0.40 }, market: { bestAsk: '0.41' }, book: T.parseBook({ asks: [], bids: [{ price: '0.39', size: '9' }] }) });
  assert.equal(empty.currentPrice, null, 'a book with no asks: nothing to buy, whatever Gamma says');
});
