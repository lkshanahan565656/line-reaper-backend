// Resting-bid tails: when the ask plus its taker fee leaves no edge, a bid a
// cent or two under it (maker fee) can. Sized by tail.limitPlan, logged by the
// track record with order 'limit', and only counted once it would have filled.
const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../tail');
const { createTailTracker, toRecord, bidOver, fillFromHistory } = require('../tailtrack');

const NOW = Date.parse('2026-10-12T12:00:00Z');
const START = NOW + 3 * 3600e3;
const iso = ms => new Date(ms).toISOString();

test('limitPlan: the highest bid under the ask, at or above the best bid, sized at half a take', () => {
  // live 10-12: Coventry vs Newcastle draw No, B grade, q 73.24%, ask 73¢ with a 1¢ taker fee: dead as a take
  const take = T.sizeAt({ q: 0.7324, price: 0.73, feePerContract: 0.009855, grade: 'B' });
  assert.equal(take.units, 0);
  const p = T.limitPlan({ q: 0.7324, ask: 0.73, bid: 0.72, grade: 'B' });
  const k = (0.7324 - 0.72) / (1 - 0.72);
  assert.deepEqual(p, { price: 0.72, fee: 0, cost: 0.72, units: Math.round(Math.min(25 * k, 1) * 0.5 * 100) / 100, kelly: Math.round(k * 1e4) / 1e4 });
  assert.equal(p.units, 0.5, 'B caps at 1u, half of it as a bid');

  // a maker fee (Kalshi's quarter of 7%) comes off the edge
  const kal = T.limitPlan({ q: 0.7324, ask: 0.73, bid: 0.72, grade: 'B', makerFee: c => 0.0175 * c * (1 - c) });
  assert.equal(kal.price, 0.72);
  assert.ok(kal.fee > 0 && kal.units > 0 && kal.units < p.units);

  // the bid goes no lower than the best bid: below it, it fills only on bad news
  assert.equal(T.limitPlan({ q: 0.715, ask: 0.73, bid: 0.72, grade: 'B' }), null);
  // a wider spread: the highest cent that's still sized
  const wide = T.limitPlan({ q: 0.6, ask: 0.64, bid: 0.55, grade: 'A' });
  assert.equal(wide.price, 0.59);
  // no bid known: at most 2¢ under the ask
  assert.equal(T.limitPlan({ q: 0.6, ask: 0.64, grade: 'A' }), null);
  assert.equal(T.limitPlan({ q: 0.6, ask: 0.61, grade: 'A' }).price, 0.59);
  // TAIL_LIMIT_SHARE=0 turns bids off; no grade, no size; no price, no plan
  assert.equal(T.limitPlan({ q: 0.7324, ask: 0.73, bid: 0.72, grade: 'B', opts: { limitShare: 0 } }), null);
  assert.equal(T.limitPlan({ q: 0.7324, ask: 0.73, bid: 0.72, grade: null }), null);
  assert.equal(T.limitPlan({ q: 0.7324, ask: null, grade: 'B' }), null);
  // never at the near-certain line
  assert.equal(T.limitPlan({ q: 0.99, ask: 0.97, bid: 0.95, grade: 'A' }), null);
  assert.equal(T.optionsFromEnv({ TAIL_LIMIT_SHARE: '25' }).limitShare, 0.25);
});

test('tradeSignal carries the book\'s bid for the bid plan', () => {
  const trade = { key: 'k1', wallet: '0xa', side: 'BUY', price: 0.73, size: 1000, notional: 730, asset: 'tok', conditionId: '0xc', title: 'Coventry vs. Newcastle: draw?', outcome: 'No', outcomeIndex: 1, at: NOW };
  const { signal } = T.tradeSignal({ trade, trader: { wallet: '0xa', grade: 'B', edge: 0.01, categories: {} }, book: { ask: 0.73, bid: 0.72 }, now: NOW });
  assert.equal(signal.currentBid, 0.72);
});

// a 0u signal with a bid on it, as server.routeSignal leaves it
const signal = (o = {}) => ({
  id: 'bid1', type: 'entry', wallet: '0xa', grade: 'B', category: 'sports', market: 'Coventry vs. Newcastle', conditionId: '0xc', asset: 'tok-no',
  outcome: 'No', outcomeIndex: 1, theirPrice: 0.73, currentPrice: 0.73, fee: 0.009855, units: 0, q: 0.7324, consensus: ['0xa'], isConsensus: false,
  reason: "price ran, don't chase", venue: null, at: iso(NOW), gameStartTime: iso(START),
  limit: { key: 'polymarket', name: 'Polymarket', price: 0.72, fee: 0, cost: 0.72, units: 0.5, ask: 0.73, bid: 0.72, until: iso(START) }, ...o,
});
const market = (o = {}) => ({
  conditionId: '0xc', question: 'Coventry vs. Newcastle', outcomes: '["Yes","No"]', outcomePrices: '["0.27","0.73"]', clobTokenIds: '["tok-yes","tok-no"]',
  bestBid: '0.27', bestAsk: '0.28', lastTradePrice: '0.27', active: true, closed: false, gameStartTime: iso(START), updatedAt: iso(NOW), ...o,
});
function fakeHttp(state) {
  const calls = { history: 0 };
  return {
    calls,
    async get(url, { params }) {
      if (url.endsWith('/book')) throw new Error('no book');
      if (url.endsWith('/v2/prices-history')) { calls.history++; return { data: { data: state.history.map(([t, p]) => ({ timestamp: t / 1000, price: p, resolution_seconds: 60 })), pagination: { has_more: false } } }; }
      const m = state.market;
      return { data: (m.closed === true) === !!params.closed ? [m] : [] };
    },
  };
}

test('a bid is a record at its own price, kept apart from takes', () => {
  const rec = toRecord(signal(), NOW);
  assert.deepEqual([rec.order, rec.filled, rec.entry, rec.fee, rec.cost, rec.units, rec.venue, rec.until], ['limit', false, 0.72, 0, 0.72, 0.5, 'Polymarket', iso(START)]);
  // a take still wins when there is one
  const take = toRecord(signal({ units: 0.4, currentPrice: 0.73 }), NOW);
  assert.equal(take.order, undefined);
  assert.equal(take.entry, 0.73);
  assert.equal(toRecord(signal({ limit: null }), NOW), null);
});

test('a bid fills when the price trades through it, then settles like any bet', async () => {
  let t = NOW + 60e3;
  const state = { market: market(), history: [] };
  const tr = createTailTracker({ http: fakeHttp(state), now: () => t });
  assert.equal(await tr.record(signal()), true);
  await tr.check();
  let [rec] = await tr.list();
  assert.equal(rec.filled, false, '73¢ is still above the bid');
  state.market = market({ lastTradePrice: '0.29', updatedAt: iso(t) });   // No at 71¢
  t += 600e3;
  await tr.check();
  [rec] = await tr.list();
  assert.equal(rec.filled, true);
  assert.equal(rec.filledAt, iso(t));
  state.market = market({ closed: true, outcomePrices: '["0","1"]' });
  t = START + 3 * 3600e3;
  await tr.check();
  [rec] = await tr.list();
  assert.equal(rec.result, 'win');
  assert.equal(rec.profit, Math.round(0.5 * (1 / 0.72 - 1) * 1e4) / 1e4);
  const s = await tr.summary();
  assert.equal(s.byOrder.limit.n, 1);
  assert.equal(s.byOrder.take.n, 0);
  assert.deepEqual(s.bids, { placed: 1, filled: 1, unfilled: 0, waiting: 0, fillRate: 1 });
});

test('a bid the price never reached is unfilled and left out of the record; history can still fill it', async () => {
  let t = NOW + 60e3;
  const state = { market: market(), history: [] };
  const http = fakeHttp(state);
  const tr = createTailTracker({ http, now: () => t });
  await tr.recordAll([signal(), signal({ id: 'bid2', asset: 'tok-no', limit: { ...signal().limit, price: 0.7 } })]);
  // the game starts; between checks No traded at 71.5¢ and 71¢: through 72¢, not 70¢
  state.history = [[NOW - 60e3, 0.6], [NOW + 1800e3, 0.715], [NOW + 3600e3, 0.71], [START + 600e3, 0.5]];
  t = START + 60e3;
  await tr.check();
  const by = Object.fromEntries((await tr.list()).map(r => [r.id, r]));
  assert.equal(by.bid1.filled, true);
  assert.equal(by.bid1.filledAt, iso(NOW + 1800e3), 'the first point through the bid, after the signal');
  assert.equal(by.bid1.status, 'open', 'filled, waiting on the result');
  assert.equal(by.bid2.status, 'settled');
  assert.equal(by.bid2.result, 'unfilled');
  assert.equal(by.bid2.profit, 0);
  const s = await tr.summary();
  assert.equal(s.overall.n, 0, 'an unfilled bid was never a bet');
  assert.equal(s.open, 1);
  assert.deepEqual(s.bids, { placed: 2, filled: 1, unfilled: 1, waiting: 0, fillRate: 0.5 });
  assert.equal(http.calls.history, 2, 'history read once a bid');
});

test('bidOver and fillFromHistory', () => {
  const rec = toRecord(signal(), NOW);
  const m = T.parseGammaMarket(market());
  assert.equal(bidOver(rec, m, NOW), false);
  assert.equal(bidOver(rec, m, START), true);
  assert.equal(bidOver(rec, { ...m, closed: true }, NOW), true);
  assert.equal(fillFromHistory(rec, [{ t: NOW - 1, p: 0.5 }, { t: NOW + 1, p: 0.716 }], START), null, 'before the signal; not through by half a cent');
  assert.equal(fillFromHistory(rec, [{ t: START + 1, p: 0.5 }], START), null, 'after the cut-off');
  assert.equal(fillFromHistory(rec, [{ t: NOW + 1, p: 0.715 }], START), NOW + 1);
});
