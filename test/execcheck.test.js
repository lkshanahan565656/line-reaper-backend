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
