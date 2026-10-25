const test = require('node:test');
const assert = require('node:assert/strict');
const X = require('../execcheck');
const { createEvTracker } = require('../evtrack');
const R = require('../results');

test('depth: buying YES fills against NO bids, only at or under the alerted price', () => {
  const book = { orderbook_fp: { yes_dollars: [['0.40', '500']], no_dollars: [['0.45', '100'], ['0.47', '200'], ['0.49', '300']] } };
  // NO bids at 49, 47, 45 are YES asks at 51, 53, 55
  assert.deepEqual(X.kalshiDepth(book, 'yes', 0.53), { contracts: 500, usd: Math.round(300 * 0.51 + 200 * 0.53), best: 0.51 });
  assert.deepEqual(X.kalshiDepth(book, 'yes', 0.5), { contracts: 0, usd: 0, best: null });
  // buying NO fills against YES bids: a YES bid at 40 is a NO ask at 60
  assert.equal(X.kalshiDepth(book, 'no', 0.6).contracts, 500);
  // the older cents shape
  assert.equal(X.kalshiDepth({ orderbook: { no: [[49, 300]] } }, 'yes', 0.51).contracts, 300);
  assert.equal(X.executable({ depth: { usd: 150 } }, 100), true);
  assert.equal(X.executable({ depth: { usd: 60 } }, 100), false);
  assert.equal(X.executable({}, 100), false, 'an unchecked venue is not executable');
});

test('depth check reads each Kalshi edge once a minute, at most maxReads a scan', async () => {
  let reads = 0, t = 0;
  const http = { get: async () => { reads++; return { data: { orderbook_fp: { no_dollars: [['0.49', '1000']] } } }; } };
  const c = X.createDepthCheck({ http, opts: { maxReads: 2 }, now: () => t });
  const edges = [1, 2, 3].map(i => ({ venue: 'kalshi', marketId: `K${i}`, side: 'yes', price: 0.51 })).concat({ venue: 'polymarketus', marketId: 'p', side: 'yes', price: 0.5 });
  await c.check(edges);
  assert.equal(reads, 2);
  assert.equal(edges[0].depth.usd, 510);
  assert.equal(edges[2].depth, undefined, 'over the read cap: unchecked this scan');
  assert.equal(edges[3].depth, undefined);
  t = 30e3; await c.check(edges);
  assert.equal(reads, 3, 'cached ones are not read again inside a minute');
});

test('evtrack grades a bet at the price 2 minutes after the flag too', async () => {
  let t = Date.parse('2026-10-14T00:00:00Z');
  const tr = createEvTracker({ minEv: 0, now: () => t });
  const row = { group: 'kalshi|K1', side: 'Boston', book: 'kalshi', start: '2026-10-14T01:00:00Z', sport: 'nba', event: 'x', market: 'moneyline', price: 0.5, decimal: 2, ev: 4, fairProb: 52, source: 'steam', depthUsd: 300 };
  const costs = new Map([['kalshi|K1|Boston', 0.51]]);
  await tr.recordBoard([row], null, { costs });
  t += 60e3; await tr.recordBoard([], new Map([['kalshi|K1|Boston', 53]]), { costs: new Map([['kalshi|K1|Boston', 0.505]]) });
  t += 60e3; await tr.recordBoard([], null, { costs: new Map([['kalshi|K1|Boston', 0.52]]) });
  t += 60e3; await tr.recordBoard([], null, { costs: new Map([['kalshi|K1|Boston', 0.55]]) });
  t = Date.parse('2026-10-14T01:00:00Z'); await tr.recordBoard([], null);
  const [b] = await tr.list();
  assert.equal(b.execPrice, 0.52, 'the first price 2+ minutes after the flag');
  assert.equal(b.depthUsd, 300);
  assert.equal(b.clv, 6);
  assert.equal(b.execClv, Math.round((0.53 / 0.52 * 100 - 100) * 100) / 100);
  const s = R.scoreboard({ exchangeValue: [b, { ...b, id: 'x2' }, { ...b, id: 'x3', execClv: undefined, execPrice: undefined }] }).sources.exchangeValue.overall;
  assert.equal(s.execN, 2);
  assert.equal(s.execClv, Math.round(b.execClv / 100 * 1e4) / 1e4);
});

test('a signal alerts only once its record 2 minutes after the alert beats the close', () => {
  const play = o => ({ source: 'exchangeValue', by: 'signal', play: 'steam', n: 23, avgClv: 0.041, ...o });
  assert.equal(X.execPasses([play({})], 'steam').pass, false, 'no delayed grades yet: held');
  assert.equal(X.execPasses([play({ execN: 10, execClv: 0.03, execBeatPct: 0.7 })], 'steam').pass, false, 'too few');
  assert.equal(X.execPasses([play({ execN: 20, execClv: 0.004, execBeatPct: 0.5 })], 'steam').pass, false, 'under 1%');
  assert.equal(X.execPasses([play({ execN: 20, execClv: 0.021, execBeatPct: 0.72 })], 'steam').pass, true);
  assert.equal(X.execPasses([play({ execN: 20, execClv: 0.021 })], 'price gap').pass, false, 'another signal\'s record');
  assert.equal(X.recordLine('steam', play({ execN: 18, execClv: 0.021, execBeatPct: 0.72 })), 'Steam record: +2.1% CLV 2 min after the alert over 18 bets (+4.1% at the alert), 72% beat the close');
  assert.equal(X.recordLine('steam', play({})), 'Steam record: +4.1% CLV at the alert over 23 bets');
});

test('Polymarket US depth: buying long takes the offers, buying short sells into the bids', () => {
  const book = { open: true, offers: [[0.52, 100], [0.53, 200], [0.55, 900]], bids: [[0.5, 300], [0.49, 100], [0.45, 50]] };
  assert.deepEqual(X.pmusDepth(book, 'long', 0.53), { contracts: 300, usd: Math.round(100 * 0.52 + 200 * 0.53), best: 0.52 });
  // short at 1 − bid: 0.50 → 50¢, 0.49 → 51¢, 0.45 → 55¢
  assert.deepEqual(X.pmusDepth(book, 'short', 0.51), { contracts: 400, usd: Math.round(300 * 0.5 + 100 * 0.51), best: 0.5 });
  assert.equal(X.pmusDepth({}, 'long', 0.6).contracts, 0);
});

test('depth check reads Polymarket US edges through the pmus client, YES mapped to its side of the book', async () => {
  let reads = 0;
  const pmus = { book: async slug => { reads++; return slug === 'shut' ? { open: false, offers: [[0.4, 1000]], bids: [] } : { open: true, offers: [[0.4, 1000]], bids: [[0.55, 400]] }; } };
  const c = X.createDepthCheck({ http: { get: async () => { throw new Error('no kalshi here'); } }, pmus, now: () => 0 });
  const edges = [
    { venue: 'polymarketus', marketId: 'aec-nba-a-b', side: 'yes', yesSide: 'long', price: 0.4 },
    { venue: 'polymarketus', marketId: 'aec-nba-a-b', side: 'no', yesSide: 'long', price: 0.45 },
    { venue: 'polymarketus', marketId: 'asc-nba-a-b', side: 'yes', yesSide: 'short', price: 0.45 },
    { venue: 'polymarketus', marketId: 'shut', side: 'yes', yesSide: 'long', price: 0.4 },
    { venue: 'polymarketus', marketId: 'x', side: 'yes', price: 0.4 },
  ];
  await c.check(edges);
  assert.equal(reads, 3, 'one read a market; an edge without yesSide is not checked');
  assert.equal(edges[0].depth.usd, 400);
  assert.deepEqual(edges[1].depth, { contracts: 400, usd: 180, best: 0.45 }, 'NO of a long-YES market sells into the bids');
  assert.equal(edges[2].depth.contracts, 400, 'YES on the short side of the book');
  assert.equal(edges[3].depth, undefined, 'a closed book gives no depth');
  assert.equal(edges[4].depth, undefined);
  assert.equal(X.executable(edges[0], 100), true);
});

test('evtrack: costs keyed by bet id grade one book of many; a scan a few seconds early still counts', async () => {
  let t = Date.parse('2026-10-14T00:00:00Z');
  const tr = createEvTracker({ minEv: 0, now: () => t });
  const rows = ['kalshi', 'fanduel'].map(book => ({ group: 'nba|g1|ml', side: 'Boston', book, start: '2026-10-14T01:00:00Z', sport: 'nba', event: 'x', market: 'moneyline', price: 100, decimal: 2, ev: 4, fairProb: 52, source: 'consensus' }));
  await tr.recordBoard(rows, null);
  t += 110e3;
  await tr.recordBoard([], null, { costs: new Map([['nba|g1|ml|Boston|kalshi', 0.505], ['nba|g1|ml|Boston|fanduel', 0.52]]) });
  const by = Object.fromEntries((await tr.list()).map(b => [b.book, b.execPrice]));
  assert.deepEqual(by, { kalshi: 0.505, fanduel: 0.52 });
});

test('verdicts judge the 2-minute grade once 8 bets carry one', () => {
  const bet = (clv, exec) => ({ id: Math.random().toString(36), status: 'closed', flaggedAt: '2026-10-14T00:00:00Z', source: 'steam', sport: 'nba', book: 'kalshi', market: 'moneyline', clv, execClv: exec });
  const good = Array.from({ length: 54 }, (_, i) => bet(3 + (i % 3), exec(i)));
  function exec(i) { return -2 + (i % 3) * 0.5; }
  const s = R.scoreboard({ exchangeValue: good }).sources.exchangeValue.overall;
  assert.ok(s.avgClv > 0.03 && s.execClv < 0);
  assert.equal(s.verdict, 'avoid', 'beats the close at the alert, loses to it 2 minutes on');
  const few = R.scoreboard({ exchangeValue: good.map((b, i) => (i < 5 ? b : { ...b, execClv: undefined })) }).sources.exchangeValue.overall;
  assert.equal(few.execN, 5);
  assert.equal(few.verdict, 'proven', 'under 8 delayed grades: the alert-time CLV still decides');
});

test('walkCost: $100 walked up the asks with the taker fee, short when the book is thin', () => {
  const w = X.walkCost([[0.5, 100], [0.4, 100], [0.6, 1000]], 100, 0.07);
  // 0.40 + fee 0.0168 = 0.4168 × 100 = 41.68; 0.50 + 0.0175 = 0.5175 × 100 = 51.75; the last 6.57 at 0.6168
  assert.equal(w.usd, 100);
  assert.equal(w.contracts, Math.round(200 + 6.57 / 0.6168));
  assert.ok(Math.abs(w.cost - 100 / (200 + 6.57 / 0.6168)) < 1e-3);
  assert.deepEqual(X.walkCost([[0.5, 10]], 100, 0), { cost: 0.5, usd: 5, contracts: 10 });
  assert.equal(X.walkCost([], 100), null);
});

test('sized: reads each due bet\'s book fresh and walks it for $100', async () => {
  const http = { get: async () => ({ data: { orderbook: { no: [[48, 50], [45, 1000]] } } }) };
  const pmus = { book: async () => ({ open: true, offers: [[0.3, 1000]], bids: [[0.6, 1000]] }) };
  const dc = X.createDepthCheck({ http, pmus });
  const out = await dc.sized([
    { id: 'k', venue: 'kalshi', marketId: 'KX-A', contract: 'yes' },
    { id: 'u', venue: 'polymarketus', marketId: 'slug', contract: 'no', yesSide: 'long' },
    { id: 'skip', venue: 'kalshi', marketId: 'KX-B' },
  ], { kalshiFeeRate: 0, pmusFeeRate: 0 });
  // YES asks 0.52 × 50 = $26, then 0.55 for the other $74
  assert.ok(Math.abs(out.get('k').cost - 100 / (50 + 74 / 0.55)) < 1e-3);
  assert.equal(out.get('u').cost, 0.4, 'NO on a long-YES market sells into the bids at 1 − 0.6');
  assert.equal(out.has('skip'), false, 'no contract side: not read');
});

test('once 15 bets carry the $100 grade, alerts go by it', () => {
  const play = o => ({ source: 'exchangeValue', by: 'signal', play: 'steam', n: 23, avgClv: 0.041, execN: 20, execClv: 0.021, ...o });
  assert.equal(X.execPasses([play({ sizedN: 16, sizedClv: -0.01 })], 'steam').pass, false);
  assert.equal(X.execPasses([play({ sizedN: 16, sizedClv: 0.012 })], 'steam').pass, true);
  assert.equal(X.execPasses([play({ sizedN: 5, sizedClv: -0.05 })], 'steam').pass, true, 'too few at size: the +2 min grade decides');
});
