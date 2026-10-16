const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const T = require('../tail');
const { createTailTracker, createStoreFromEnv, settle, observe, toRecord } = require('../tailtrack');
const { createFileStore } = require('../evtrack');

const NOW = Date.parse('2026-10-08T12:00:00Z');
const W = n => `0x${String(n).padStart(40, '0')}`;

// a sized entry, the shape tail.tradeSignal emits
const signal = (o = {}) => ({
  id: '0xtx1:tok-yes:w1', type: 'entry', wallet: W(1), name: 'Oracle', grade: 'A', scope: 'category', category: 'politics',
  market: 'Will X win the Ohio Senate election?', eventSlug: 'ohio-senate', conditionId: '0xm1', asset: 'tok-yes', outcome: 'Yes', outcomeIndex: 0,
  theirPrice: 0.4, theirSize: 2000, theirNotional: 800, currentPrice: 0.42, slippage: 0.02, edge: 0.1429, prob: 0.4571, kelly: 0.064,
  units: 1.6, cap: 2, consensus: [W(1)], isConsensus: false, reason: null, at: new Date(NOW - 60e3).toISOString(), seenAt: new Date(NOW).toISOString(),
  url: 'https://polymarket.com/event/ohio-senate', ...o,
});
const NO_SIDE = { id: '0xtx2:tok-no:w2', wallet: W(2), grade: 'B', asset: 'tok-no', outcome: 'No', outcomeIndex: 1, theirPrice: 0.58, currentPrice: 0.6, units: 1, consensus: [W(2), W(3)], isConsensus: true };
const SPORTS = { id: '0xtx3:tok-lal:w3', wallet: W(3), category: 'sports', conditionId: '0xm2', asset: 'tok-lal', outcome: 'Lakers', theirPrice: 0.24, currentPrice: 0.25, units: 0.5, consensus: [W(3), W(4)], isConsensus: true };

const gamma = (o = {}) => ({
  conditionId: '0xm1', question: 'Will X win the Ohio Senate election?', outcomes: '["Yes","No"]', outcomePrices: '["0.475","0.525"]',
  clobTokenIds: '["tok-yes","tok-no"]', bestBid: '0.47', bestAsk: '0.48', lastTradePrice: '0.48', active: true, closed: false, ...o,
});
const lakers = (o = {}) => gamma({ conditionId: '0xm2', question: 'Lakers vs. Celtics', outcomes: '["Lakers","Celtics"]', clobTokenIds: '["tok-lal","tok-bos"]', ...o });

// Gamma markets by condition id; CLOB books by token (none: the book call fails)
function fakeGamma(markets, books = {}) {
  const calls = [], bookCalls = [];
  return {
    calls, bookCalls,
    async get(url, { params }) {
      if (url.endsWith('/book')) {
        bookCalls.push(params.token_id);
        if (!books[params.token_id]) throw new Error('no book');
        return { data: books[params.token_id] };
      }
      calls.push(params.condition_ids);
      const m = markets[params.condition_ids];
      if (m instanceof Error) throw m;
      // like Gamma: a closed market only when asked for closed ones, an open one only when not
      return { data: m && (m.closed === true || m.closed === 'true') === !!params.closed ? [m] : [] };
    },
  };
}

test('records sized entries once; exits, 0u and unpriced signals are not bets', async () => {
  const tr = createTailTracker({ http: fakeGamma({}), now: () => NOW });
  assert.equal(await tr.record(signal()), true);
  assert.equal(await tr.record(signal({ units: 2 })), false, 'same trade again');
  assert.equal(await tr.record(signal({ id: 'x1', type: 'exit', units: undefined })), false);
  assert.equal(await tr.record(signal({ id: 'x2', units: 0, reason: "price ran, don't chase" })), false);
  assert.equal(await tr.record(signal({ id: 'x3', currentPrice: null })), false);
  assert.equal(await tr.record(null), false);
  assert.equal(await tr.recordAll([signal(NO_SIDE), signal(SPORTS), signal()]), 2);
  const [rec] = await tr.list({ status: 'open', limit: 1 });
  assert.equal(rec.status, 'open');
  const first = (await tr.list()).find(r => r.id === '0xtx1:tok-yes:w1');
  assert.equal(first.entry, 0.42, 'graded at the price a follower could get, not their 0.40');
  assert.equal(first.theirPrice, 0.4);
  assert.equal(first.units, 1.6);
  assert.equal(tr.state().open, 3);
});

test('a real signal from tail.tradeSignal records as is', async () => {
  const trade = T.parseTrades({ data: [{ proxy_wallet: W(9), side: 'BUY', token_id: 'tok-yes', condition_id: '0xm1', size: 2000, price: 0.4, timestamp: (NOW - 60e3) / 1000,
    title: 'Will X win the Ohio Senate election?', event_slug: 'ohio-senate', outcome_index: 0, transaction_hash: '0xreal' }], pagination: { has_more: false } })[0];
  const { signal: s } = T.tradeSignal({ trade, trader: { wallet: W(9), grade: 'A', edge: 0.1, categories: {} }, market: T.parseGammaMarket(gamma({ bestAsk: '0.41' })), now: NOW });
  const rec = toRecord(s, NOW);
  assert.equal(rec.entry, 0.41);
  assert.equal(rec.units, s.units);
  assert.equal(rec.category, 'politics');
  assert.equal(rec.isConsensus, false);
  assert.deepEqual([rec.fee, rec.cost, rec.q, rec.venue], [0, 0.41, s.q, null], 'no fee on a politics market');
});

test('follows the last price while open, then grades wins, losses and ROI', async () => {
  let t = NOW;
  const markets = { '0xm1': gamma(), '0xm2': lakers({ closed: true, outcomePrices: '["1","0"]' }) };
  const http = fakeGamma(markets);
  const tr = createTailTracker({ http, now: () => t });
  await tr.recordAll([signal(), signal(NO_SIDE), signal(SPORTS)]);

  t += 600e3;
  const c1 = await tr.check();
  assert.deepEqual(c1, { checked: 2, settled: 1, errors: [] });
  assert.deepEqual(http.calls, ['0xm1', '0xm2', '0xm2'], 'one lookup per market, not per signal (a closed one: open, then closed=true)');
  const open1 = await tr.list({ status: 'open' });
  assert.deepEqual(open1.map(r => [r.asset, r.closePrice]).sort(), [['tok-no', 0.52], ['tok-yes', 0.48]], 'NO side priced 1 − last');

  t += 600e3;
  markets['0xm1'] = gamma({ closed: true, active: true, outcomePrices: '["1","0"]', lastTradePrice: '0.999' });
  assert.equal((await tr.check()).settled, 2);
  const by = Object.fromEntries((await tr.list()).map(r => [r.asset, r]));
  assert.equal(by['tok-yes'].result, 'win');
  assert.equal(by['tok-yes'].profit, Math.round(1.6 * (1 / 0.42 - 1) * 1e4) / 1e4, 'units × (1/entry − 1)');
  assert.equal(by['tok-yes'].clv, Math.round((0.48 / 0.42 - 1) * 1e4) / 1e4, 'the last open price, not the settlement print');
  assert.equal(by['tok-no'].result, 'loss');
  assert.equal(by['tok-no'].profit, -1);
  assert.equal(by['tok-no'].clv, Math.round((0.52 / 0.6 - 1) * 1e4) / 1e4);
  assert.equal(by['tok-lal'].result, 'win');
  assert.equal(by['tok-lal'].profit, 1.5);
  assert.equal(by['tok-lal'].clv, null, 'never seen open after the signal');
  assert.equal(by['tok-lal'].settledAt, new Date(NOW + 600e3).toISOString());

  const s = await tr.summary();
  assert.equal(s.open, 0);
  const units = 1.6 * (1 / 0.42 - 1) - 1 + 1.5;
  assert.deepEqual(s.overall, {
    n: 3, wins: 2, losses: 1, voids: 0, staked: 3.1, units: Math.round(units * 100) / 100, roi: Math.round((units / 3.1) * 1e4) / 1e4,
    winRate: 0.6667, avgClv: Math.round(((by['tok-yes'].clv + by['tok-no'].clv) / 2) * 1e4) / 1e4, beatClosePct: 0.5, clvN: 2,
  });
  assert.deepEqual([s.byGrade.A.n, s.byGrade.A.wins, s.byGrade.B.losses, s.byGrade.B.units, s.byGrade.B.roi], [2, 2, 1, -1, -1]);
  assert.deepEqual(Object.keys(s.byCategory), ['politics', 'sports']);
  assert.equal(s.byCategory.politics.units, Math.round((1.6 * (1 / 0.42 - 1) - 1) * 100) / 100);
  assert.equal(s.byConsensus.consensus.n, 2);
  assert.equal(s.byConsensus.consensus.roi, Math.round((0.5 / 1.5) * 1e4) / 1e4);
  assert.equal(s.byConsensus.single.n, 1);
  assert.equal(s.byConsensus.single.wins, 1);

  assert.equal((await tr.summary({ grade: 'B' })).overall.n, 1);
  assert.equal((await tr.summary({ category: 'sports' })).overall.units, 1.5);
  assert.equal((await tr.summary({ sinceDays: 1 })).overall.n, 3);
  t += 3 * 86400e3;
  assert.equal((await tr.summary({ sinceDays: 1 })).overall.n, 0);
  http.calls.length = 0;
  await tr.check();
  assert.deepEqual(http.calls, [], 'settled signals are not looked up again');
});

test('50/50 resolutions are void; unresolved and missing markets stay open; lookup errors do not sink the rest', async () => {
  const markets = { '0xm1': gamma({ closed: true, outcomePrices: '["0.5","0.5"]' }), '0xm2': new Error('502'), '0xm3': gamma({ conditionId: '0xm3', closed: true, outcomePrices: '["0.62","0.38"]' }) };
  const tr = createTailTracker({ http: fakeGamma(markets), now: () => NOW });
  await tr.recordAll([signal(), signal(SPORTS), signal({ id: 's3', conditionId: '0xm3' }), signal({ id: 's4', conditionId: '0xgone' })]);
  const c = await tr.check();
  assert.equal(c.checked, 4);
  assert.equal(c.settled, 1);
  assert.deepEqual(c.errors, [{ conditionId: '0xm2', message: '502' }]);
  const v = (await tr.list()).find(r => r.id === '0xtx1:tok-yes:w1');
  assert.deepEqual([v.status, v.result, v.profit], ['settled', 'void', 0]);
  const s = await tr.summary();
  assert.equal(s.open, 3);
  assert.deepEqual([s.overall.n, s.overall.voids, s.overall.staked, s.overall.roi, s.overall.winRate], [1, 1, 0, null, null]);
});

test('a game that has started stops moving the closing price; lookups are capped and rotate', async () => {
  const rec = toRecord(signal(), NOW);
  const m = T.parseGammaMarket(gamma({ gameStartTime: new Date(NOW + 3600e3).toISOString(), lastTradePrice: '0.45' }));
  assert.equal(observe(rec, m, NOW), true);
  assert.equal(rec.closePrice, 0.45);
  assert.equal(observe(rec, { ...m, lastTradePrice: 0.9 }, NOW + 2 * 3600e3), false, 'in-game prices are not a close');
  assert.equal(rec.closePrice, 0.45);
  assert.equal(observe(rec, { ...m, closed: true, lastTradePrice: 0.5 }, NOW), false);
  assert.equal(settle(rec, m, NOW), false, 'not resolved yet');
  assert.equal(settle(rec, { ...m, closed: true, prices: [0, 1] }, NOW), true);
  assert.deepEqual([rec.result, rec.profit, rec.clv], ['loss', -1.6, Math.round((0.45 / 0.42 - 1) * 1e4) / 1e4]);

  const markets = {};
  const sigs = [];
  for (let i = 0; i < 5; i++) { markets[`0xc${i}`] = gamma({ conditionId: `0xc${i}` }); sigs.push(signal({ id: `s${i}`, conditionId: `0xc${i}` })); }
  const http = fakeGamma(markets);
  let t = NOW;
  const tr = createTailTracker({ http, now: () => t, maxLookups: 2 });
  await tr.recordAll(sigs);
  await tr.check(); t += 1;
  await tr.check(); t += 1;
  await tr.check();
  assert.deepEqual(http.calls, ['0xc0', '0xc1', '0xc2', '0xc3', '0xc4', '0xc0'], 'least recently checked first');
});

test('survives a restart from the file store; env picks the store', async () => {
  const file = path.join(os.tmpdir(), `tailtrack-${process.pid}-${Date.now()}.json`);
  const a = createTailTracker({ store: createFileStore(file), http: fakeGamma({}), now: () => NOW });
  await a.record(signal());
  await new Promise(r => setTimeout(r, 20));
  const b = createTailTracker({ store: createFileStore(file), http: fakeGamma({ '0xm1': gamma({ closed: true, outcomePrices: '["1","0"]' }) }), now: () => NOW + 1 });
  assert.equal(await b.record(signal()), false, 'reloaded signal is not logged twice');
  assert.equal((await b.check()).settled, 1);
  assert.equal((await b.summary()).overall.wins, 1);
  await new Promise(r => setTimeout(r, 20));
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved[0].result, 'win');
  fs.unlinkSync(file);

  assert.equal(createStoreFromEnv({ TAIL_TRACK_FILE: file }).kind, 'file');
  assert.equal(createStoreFromEnv({}).kind, 'file');
  assert.equal(createStoreFromEnv({ DATABASE_URL: 'postgres://u:p@localhost:5432/db' }).kind, 'postgres');
});

test('the close freezes when the outcome gets out, and stops at the scheduled end or when orders stop', () => {
  // "Fed cuts in December?": in at 60¢, 62¢ a day before, 99.7¢ after the announcement while UMA settles
  const rec = toRecord(signal({ currentPrice: 0.6, theirPrice: 0.59 }), NOW);
  const m = (o = {}) => T.parseGammaMarket(gamma({ endDate: new Date(NOW + 10 * 86400e3).toISOString(), ...o }));
  assert.equal(observe(rec, m({ lastTradePrice: '0.62' }), NOW), true);
  assert.equal(rec.closePrice, 0.62);
  assert.equal(observe(rec, m({ lastTradePrice: '0.997' }), NOW + 3600e3), true, 'the jump freezes the close');
  assert.equal(rec.closeFrozen, true);
  assert.equal(rec.closePrice, 0.62);
  assert.equal(observe(rec, m({ lastTradePrice: '0.95' }), NOW + 2 * 3600e3), false, 'and nothing moves it after');
  assert.equal(settle(rec, m({ closed: true, outcomePrices: '["1","0"]' }), NOW + 86400e3), true);
  assert.equal(rec.clv, Math.round((0.62 / 0.6 - 1) * 1e4) / 1e4, '+3.3%, not +66%');

  const first = toRecord(signal({ id: 'jump-first', currentPrice: 0.6 }), NOW);
  observe(first, m({ lastTradePrice: '0.998' }), NOW);
  assert.equal(first.closePrice, null);
  settle(first, m({ closed: true, outcomePrices: '["1","0"]' }), NOW);
  assert.equal(first.clv, null, 'no close from before the outcome: no CLV');

  const drift = toRecord(signal({ id: 'drift', currentPrice: 0.9 }), NOW);
  assert.equal(observe(drift, m({ lastTradePrice: '0.975' }), NOW), true);
  assert.equal(drift.closePrice, 0.975, 'a favourite drifting up is still a price');
  const ended = toRecord(signal({ id: 'ended' }), NOW);
  assert.equal(observe(ended, m({ endDate: new Date(NOW - 60e3).toISOString(), lastTradePrice: '0.5' }), NOW), false, 'past its scheduled end');
  assert.equal(observe(ended, m({ acceptingOrders: false, lastTradePrice: '0.5' }), NOW), false, 'orders stopped');
});

test('a top-up joins its first bet as one record at the price that pays the same', async () => {
  const tr = createTailTracker({ http: fakeGamma({ '0xm1': gamma({ closed: true, outcomePrices: '["1","0"]' }) }), now: () => NOW });
  assert.equal(await tr.record(signal({ units: 0.6, currentPrice: 0.4 })), true);
  assert.equal(await tr.record(signal({ id: 'top-1', parentId: '0xtx1:tok-yes:w1', topUp: true, units: 0.4, currentPrice: 0.5 })), true);
  assert.equal(await tr.record(signal({ id: 'top-1', parentId: '0xtx1:tok-yes:w1', topUp: true, units: 0.4, currentPrice: 0.5 })), false, 'once');
  const all = await tr.list();
  assert.equal(all.length, 1);
  const [r] = all;
  assert.equal(r.units, 1);
  assert.equal(r.entry, Math.round((1 / (0.6 / 0.4 + 0.4 / 0.5)) * 1e4) / 1e4);
  assert.deepEqual(r.topUps, ['top-1']);
  await tr.check();
  const [done] = await tr.list();
  // 0.6u at 40¢ wins 0.9u, 0.4u at 50¢ wins 0.4u
  assert.ok(Math.abs(done.profit - 1.3) < 0.001, String(done.profit));
  // a top-up whose first bet isn't open stands alone
  assert.equal(await tr.record(signal({ id: 'orphan', parentId: 'gone', topUp: true, units: 0.3 })), true);
  assert.equal((await tr.list()).length, 2);
});

test('the running close is the token\'s book midpoint; a stale Gamma price is ignored', async () => {
  let t = NOW;
  const stale = new Date(NOW - 30 * 86400e3).toISOString();
  const markets = { '0xm1': gamma({ updatedAt: stale }) };   // Gamma still says 0.48, a month old
  const books = { 'tok-yes': { asks: [{ price: '0.60', size: '100' }, { price: '0.58', size: '50' }], bids: [{ price: '0.55', size: '10' }, { price: '0.56', size: '20' }] } };
  const http = fakeGamma(markets, books);
  const tr = createTailTracker({ http, now: () => t });
  await tr.recordAll([signal(), signal(NO_SIDE)]);
  t += 600e3;
  await tr.check();
  const by = Object.fromEntries((await tr.list()).map(r => [r.asset, r]));
  assert.equal(by['tok-yes'].closePrice, 0.57, 'midpoint of the best bid 0.56 and best ask 0.58');
  assert.equal(by['tok-no'].closePrice, null, 'no book and a stale Gamma: no close yet');
  assert.deepEqual(http.bookCalls.sort(), ['tok-no', 'tok-yes'], 'one book a held token');
  // a 5¢ / 95¢ book has no price: the close stays where it was
  books['tok-yes'] = { asks: [{ price: '0.95', size: '10' }], bids: [{ price: '0.05', size: '10' }] };
  t += 600e3;
  await tr.check();
  assert.equal((await tr.list()).find(r => r.asset === 'tok-yes').closePrice, 0.57, 'spread over 10¢: midpoint ignored');
  books['tok-yes'] = { asks: [{ price: '0.58', size: '50' }], bids: [{ price: '0.56', size: '20' }] };
  // settled markets need no book
  markets['0xm1'] = gamma({ closed: true, outcomePrices: '["1","0"]' });
  http.bookCalls.length = 0;
  t += 600e3;
  assert.equal((await tr.check()).settled, 2);
  assert.deepEqual(http.bookCalls, []);
  const yes = (await tr.list()).find(r => r.asset === 'tok-yes');
  assert.equal(yes.clv, Math.round((0.57 / 0.42 - 1) * 1e4) / 1e4);
});

// ── venues and fees ──
const r4 = x => Math.round(x * 1e4) / 1e4;
const r6 = x => Math.round(x * 1e6) / 1e6;

test('a follower is graded at the venue the signal recommended, its fee included; without one at the Polymarket ask', async () => {
  const kalshi = signal({ id: 'k', venue: { name: 'Kalshi', price: 0.44, units: 1.2, maxPrice: 0.45, url: 'https://kalshi.com/markets/x' } });
  const kalshiFee = signal({ id: 'kf', venue: { name: 'Kalshi', price: 0.44, fee: 0.02, units: 1, maxPrice: 0.45 } });
  const book = signal({ id: 'dk', venue: { name: 'DraftKings', price: 0.4545, american: 120, units: 1.5, maxPrice: 0.45 } });
  const poly = signal({ id: 'pm', fee: 0.0125, units: 0.8 });   // a Polymarket sports market's taker fee
  const watch = signal({ id: 'watch', venue: { name: 'Kalshi', price: 0.47, units: 0, maxPrice: 0.45 } });
  const noVenue = signal({ id: 'nv', venue: null });

  const rec = s => toRecord(s, NOW);
  assert.deepEqual(['venue', 'entry', 'fee', 'cost', 'units', 'polyPrice', 'theirPrice'].map(k => rec(kalshi)[k]),
    ['Kalshi', 0.44, r6(0.07 * 0.44 * 0.56), r6(0.44 + 0.07 * 0.44 * 0.56), 1.2, 0.42, 0.4], 'Kalshi: 7% × p(1 − p) a contract');
  assert.deepEqual([rec(kalshiFee).fee, rec(kalshiFee).cost], [0.02, 0.46], 'the venue\'s own fee when it gives one');
  assert.deepEqual([rec(book).venue, rec(book).fee, rec(book).cost, rec(book).units], ['DraftKings', 0, 0.4545, 1.5], 'a sportsbook\'s margin is in its price');
  assert.deepEqual([rec(poly).venue, rec(poly).entry, rec(poly).fee, rec(poly).cost], [null, 0.42, 0.0125, 0.4325]);
  assert.equal(rec(watch), null, '0u at the venue: watch only, not a bet');
  assert.deepEqual([rec(noVenue).entry, rec(noVenue).units, rec(noVenue).cost], [0.42, 1.6, 0.42], 'no US venue: the Polymarket ask');
  assert.equal(rec(signal({ id: 'bad', venue: { name: 'Kalshi', price: 1.2, units: 1 } })).entry, 0.42, 'a venue with no real price is ignored');
  assert.equal(rec(signal({ id: 'nope', currentPrice: null, venue: { name: 'Kalshi', price: 0.44, units: 1 } })).entry, 0.44, 'a venue price is enough');
  assert.equal(rec(signal({ id: 'dear', venue: { name: 'Kalshi', price: 0.99, fee: 0.02, units: 1 } })), null, 'costs $1 or more');

  let t = NOW;
  const markets = { '0xm1': gamma() };
  const tr = createTailTracker({ http: fakeGamma(markets), now: () => t });
  assert.equal(await tr.recordAll([kalshi, kalshiFee, book, poly, watch, noVenue]), 5);
  t += 600e3;
  await tr.check();   // last price 0.48: the running close
  markets['0xm1'] = gamma({ closed: true, outcomePrices: '["1","0"]' });
  t += 600e3;
  assert.equal((await tr.check()).settled, 5);
  const by = Object.fromEntries((await tr.list()).map(r => [r.id, r]));
  const cost = 0.44 + 0.07 * 0.44 * 0.56;
  assert.equal(by.k.profit, r4(1.2 * (1 / r6(cost) - 1)), 'units × (1 / (price + fee) − 1)');
  assert.ok(by.k.profit < r4(1.2 * (1 / 0.44 - 1)), 'less than the fee-free payout');
  assert.equal(by.k.clv, r4(0.48 / 0.42 - 1), "CLV: Polymarket's close against Polymarket's price at the signal, not the Kalshi entry");
  assert.equal(by.dk.clv, by.k.clv, 'the same for a sportsbook entry');
  assert.equal(by.nv.clv, r4(0.48 / 0.42 - 1));
  assert.equal(by.kf.profit, r4(1 / 0.46 - 1));
  assert.equal(by.dk.profit, r4(1.5 * (1 / 0.4545 - 1)));
  assert.equal(by.pm.profit, r4(0.8 * (1 / 0.4325 - 1)));
  assert.equal(by.nv.profit, r4(1.6 * (1 / 0.42 - 1)));

  const s = await tr.summary();
  assert.deepEqual(Object.keys(s.byVenue).sort(), ['DraftKings', 'Kalshi', 'Polymarket']);
  assert.deepEqual([s.byVenue.Kalshi.n, s.byVenue.Kalshi.staked, s.byVenue.Polymarket.n], [2, 2.2, 2]);
  assert.equal(s.overall.units, Math.round((by.k.profit + by.kf.profit + by.dk.profit + by.pm.profit + by.nv.profit) * 100) / 100);

  // and a loss is the stake, fee or not
  const loser = createTailTracker({ http: fakeGamma({ '0xm1': gamma({ closed: true, outcomePrices: '["0","1"]' }) }), now: () => NOW });
  await loser.record(kalshi);
  await loser.check();
  assert.equal((await loser.list())[0].profit, -1.2);
});

test('a real sports signal from tail.tradeSignal records its Polymarket fee; a top-up merges the all-in cost', async () => {
  const trade = T.parseTrades([{ proxy_wallet: W(9), side: 'BUY', token_id: 'tok-lal', condition_id: '0xm2', size: 3000, price: 0.44, timestamp: (NOW - 60e3) / 1000,
    title: 'Lakers vs. Celtics', event_slug: 'nba-lal-bos-2026-10-08', outcome: 'Lakers', outcome_index: 0, transaction_hash: '0xsport' }])[0];
  const market = T.parseGammaMarket(lakers({ bestAsk: '0.45', bestBid: '0.44', feeType: 'sports_fees_v2', feeSchedule: { rate: 0.05, exponent: 1 } }));
  const { signal: s } = T.tradeSignal({ trade, trader: { wallet: W(9), grade: 'A', edge: 0.1, avgEntry: 0.45, categories: {} }, market, now: NOW });
  assert.ok(s.units > 0);
  const rec = toRecord(s, NOW);
  assert.deepEqual([rec.entry, rec.fee, rec.cost, rec.q], [0.45, r6(0.05 * 0.45 * 0.55), r6(0.45 + 0.05 * 0.45 * 0.55), s.q]);

  const tr = createTailTracker({ http: fakeGamma({ '0xm1': gamma({ closed: true, outcomePrices: '["1","0"]' }) }), now: () => NOW });
  await tr.record(signal({ id: 'p1', units: 0.6, currentPrice: 0.4, fee: 0.012 }));
  await tr.record(signal({ id: 'p2', parentId: 'p1', topUp: true, units: 0.4, venue: { name: 'Kalshi', price: 0.5, fee: 0.02, units: 0.4 } }));
  const [r] = await tr.list();
  assert.equal(r.units, 1);
  assert.equal(r.entry, r4(1 / (0.6 / 0.4 + 0.4 / 0.5)));
  assert.equal(r.cost, r6(1 / (0.6 / 0.412 + 0.4 / 0.52)), 'the single all-in price with the same payout');
  await tr.check();
  const [done] = await tr.list();
  // 0.6u at 41.2¢ all in wins 0.6 × (1/0.412 − 1); 0.4u at 52¢ wins 0.4 × (1/0.52 − 1)
  assert.ok(Math.abs(done.profit - (0.6 * (1 / 0.412 - 1) + 0.4 * (1 / 0.52 - 1))) < 0.001, String(done.profit));
});

test('records from before fees and venues still settle at their entry', () => {
  const old = toRecord(signal(), NOW);
  delete old.fee;
  delete old.cost;
  delete old.venue;
  assert.equal(settle(old, T.parseGammaMarket(gamma({ closed: true, outcomePrices: '["1","0"]' })), NOW), true);
  assert.equal(old.profit, r4(1.6 * (1 / 0.42 - 1)));
});
