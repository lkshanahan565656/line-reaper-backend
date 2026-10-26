const test = require('node:test');
const assert = require('node:assert');
const X = require('../exprops');

const T0 = Date.parse('2026-10-27T00:00:00Z');
const START = '2026-10-27T02:00:00.000Z';
// rungIndex keeps start = settles - 3h; Kalshi NBA rungs settle about 6h after tip
const rung = (o = {}) => ({ ticker: 'KXNBAPTS-26OCT26NYKBOS-NYKJBRUNSON11-25', league: 'NBA', player: 'Jalen Brunson', mkey: 'points', line: 24.5,
  start: new Date(Date.parse(START) + 3 * 3600e3).toISOString(), yesBid: 0.47, yesAsk: 0.48, eventTicker: 'KXNBAPTS-26OCT26NYKBOS', ...o });
const pinIdx = (o = {}) => new Map([['NBA|jalenbrunson|points', [{ line: 24.5, pOver: 0.52, start: START, ...o }]]]);

test('taker fee: 0.07 x p x (1-p), rounded up on a 100-contract order', () => {
  assert.strictEqual(X.takerFee(0.5), 0.0175);
  assert.strictEqual(X.takerFee(0.9), 0.0063);
});

test('kinds: one per role x league x stat, never pooled', () => {
  assert.strictEqual(X.kindOf('maker', 'NHL', 'points'), 'kxprop-maker-nhl-points');
  assert.deepStrictEqual(X.parseKind('kxprop-taker-nfl-rec_yds'), { role: 'taker', league: 'NFL', mkey: 'rec_yds' });
  assert.strictEqual(X.parseKind('kalshi-maker'), null);
});

test('priceRung: exact line only, the same game only, both sides priced', () => {
  const r = X.priceRung(rung(), pinIdx().get('NBA|jalenbrunson|points'), { now: T0 });
  assert.strictEqual(r.start, START);
  assert.strictEqual(r.sides.yes.fair, 0.52);
  // YES at 48c + 1.75c fee → 0.52 / 0.4975 - 1 = +4.5%
  assert.strictEqual(r.sides.yes.cost, 0.4975);
  assert.ok(r.sides.yes.ev > 0.04 && r.sides.yes.ev < 0.05);
  // NO costs 1 - bid = 53c: under fair, no take, and a bid that clears 2%
  assert.ok(r.sides.no.ev < 0);
  assert.ok(r.sides.no.bid == null || r.sides.no.bid <= 0.52);
  // Pinnacle on 25.5 (not the rung's line): no price
  assert.strictEqual(X.priceRung(rung(), [{ line: 25.5, pOver: 0.45, start: START }], { now: T0 }), null);
  // a Pinnacle game 2 days away is another game
  assert.strictEqual(X.priceRung(rung(), [{ line: 24.5, pOver: 0.52, start: '2026-10-29T02:00:00Z' }], { now: T0 }), null);
  // leagues outside the list
  assert.strictEqual(X.priceRung(rung({ league: 'SOCCER' }), pinIdx().get('NBA|jalenbrunson|points'), { now: T0 }), null);
});

function memStore() {
  const m = new Map();
  return { all: async () => [...m.values()].map(x => JSON.parse(JSON.stringify(x))), put: async b => { m.set(b.id, JSON.parse(JSON.stringify(b))); }, m };
}
function fakeHttp({ trades = [], result = 'yes', fee = 'quadratic_with_maker_fees' } = {}) {
  const calls = [];
  return { calls, get: async (url, cfg) => {
    calls.push(url);
    if (/\/series\//.test(url)) return { data: { series: { fee_type: fee, fee_multiplier: 1 } } };
    if (/orderbook/.test(url)) return { data: { orderbook_fp: { yes_dollars: [['0.46', '300']], no_dollars: [['0.52', '120'], ['0.51', '400']] } } };
    if (/markets\/trades/.test(url)) return { data: { trades, cursor: '' } };
    if (/\/markets\//.test(url)) return { data: { market: { result, status: 'finalized' } } };
    throw new Error('unexpected ' + url);
  } };
}

test('tracker: a taker flag with its order book, a maker bid, the close, the fill and the grade', async () => {
  let now = T0;
  const store = memStore();
  const http = fakeHttp({ trades: [{ created_time: new Date(T0 + 30 * 60e3).toISOString(), yes_price_dollars: '0.40', taker_side: 'no', count_fp: '10' }], result: 'yes' });
  const tr = X.createExchangePropsTracker({ store, http, now: () => now });
  await tr.scan({ rungs: new Map([['a', rung()]]), pinIdx: pinIdx() });
  let all = await store.all();
  const taker = all.find(b => b.role === 'taker');
  assert.ok(taker && taker.side === 'yes' && taker.kind === 'kxprop-taker-nba-points');
  // buying YES walks the NO bids: 52c (100 - 48) x 120, then 51c is 49c... only levels clearing 2%
  assert.ok(taker.depth && taker.depth.contracts >= 120);
  const maker = all.find(b => b.role === 'maker' && b.side === 'yes');
  assert.ok(maker && maker.bid <= 0.47);
  // a second read does not flag the same rung again
  now += 5 * 60e3;
  await tr.scan({ rungs: new Map([['a', rung()]]), pinIdx: pinIdx({ pOver: 0.53 }) });
  all = await store.all();
  assert.strictEqual(all.filter(b => b.role === 'taker').length, 1);
  // the last read before the start (inside 20 min) is the close
  now = Date.parse(START) - 10 * 60e3;
  await tr.scan({ rungs: new Map([['a', rung()]]), pinIdx: pinIdx({ pOver: 0.55 }) });
  now = Date.parse(START) + 60e3;
  await tr.scan({ rungs: new Map([['a', rung()]]), pinIdx: pinIdx({ pOver: 0.55 }) });
  all = await store.all();
  assert.ok(all.filter(b => b.status !== 'open').length >= 2);
  assert.strictEqual(all.find(b => b.role === 'taker').closeFair, 0.55);
  // settle: the maker fills on the 40c print, both grade on Kalshi's YES
  now = Date.parse(START) + 3 * 3600e3;
  await tr.settle();
  all = await store.all();
  const g = all.filter(b => b.status === 'graded' && b.side === 'yes');
  assert.ok(g.length >= 2);
  for (const b of g) { assert.strictEqual(b.outcome, 'win'); assert.ok(b.clv > 0); }
  const rec = X.byKind(all);
  const tk = rec.find(r => r.kind === 'kxprop-taker-nba-points');
  assert.strictEqual(tk.graded, 1);
  assert.strictEqual(tk.verdict, 'lead');
  const mk = rec.find(r => r.kind === 'kxprop-maker-nba-points');
  assert.ok(mk.posted >= 1 && mk.fillRate > 0);
});

test('tracker: a Pinnacle line that moves off the rung is not graded on CLV', async () => {
  let now = T0;
  const store = memStore();
  const tr = X.createExchangePropsTracker({ store, http: fakeHttp(), now: () => now });
  await tr.scan({ rungs: new Map([['a', rung()]]), pinIdx: pinIdx() });
  now += 5 * 60e3;
  await tr.scan({ rungs: new Map([['a', rung()]]), pinIdx: new Map([['NBA|jalenbrunson|points', [{ line: 25.5, pOver: 0.48, start: START }]]]) });
  now = Date.parse(START) + 60e3;
  await tr.scan({ rungs: new Map([['a', rung()]]), pinIdx: new Map([['NBA|jalenbrunson|points', [{ line: 25.5, pOver: 0.48, start: START }]]]) });
  const t = (await store.all()).find(b => b.role === 'taker');
  assert.strictEqual(t.closeFair, null);
  assert.strictEqual(t.closeMissing, 'line moved');
  // an empty Pinnacle read is an outage, not a line move
  const s2 = memStore();
  let n2 = T0;
  const tr2 = X.createExchangePropsTracker({ store: s2, http: fakeHttp(), now: () => n2 });
  await tr2.scan({ rungs: new Map([['a', rung()]]), pinIdx: pinIdx() });
  n2 += 5 * 60e3;
  await tr2.scan({ rungs: new Map([['a', rung()]]), pinIdx: new Map() });
  assert.notStrictEqual((await s2.all()).find(b => b.role === 'taker').lineOk, false);
});

test('summarize: the 50 bar, results short, and fail', () => {
  const mk = (clv, won, i) => ({ id: String(i), role: 'taker', kind: 'k', status: 'graded', cost: 0.5, closeFair: 0.5 * (1 + clv), clv, outcome: won ? 'win' : 'loss', profit: won ? 1 : -1 });
  const lead = X.summarize(Array.from({ length: 10 }, (_, i) => mk(0.02 + (i % 3) * 0.01, i % 2 === 0, i)));
  assert.strictEqual(lead.verdict, 'lead');
  assert.strictEqual(lead.graded, 10);
  const pass = X.summarize(Array.from({ length: 60 }, (_, i) => mk(0.02 + (i % 3) * 0.01, i % 2 === 0, i)));
  assert.strictEqual(pass.verdict, 'passes the record');
  const fail = X.summarize(Array.from({ length: 60 }, (_, i) => mk(-0.01 - (i % 3) * 0.01, i % 2 === 0, i)));
  assert.strictEqual(fail.verdict, 'fail');
  const short = X.summarize(Array.from({ length: 30 }, (_, i) => mk(0.03 + (i % 3) * 0.01, i % 5 === 0, i)));
  assert.strictEqual(short.verdict, 'lead (results short)');
  // maker bids that never filled do not count as bets
  const unf = X.summarize([{ id: 'm', role: 'maker', kind: 'k', status: 'unfilled', filled: false }]);
  assert.strictEqual(unf.bets, 0);
  assert.strictEqual(unf.posted, 1);
  assert.strictEqual(unf.fillRate, 0);
});
