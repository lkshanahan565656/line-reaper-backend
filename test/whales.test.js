const test = require('node:test');
const assert = require('node:assert/strict');
const W = require('../whales');

const NOW = Date.parse('2026-10-08T12:00:00Z');
const MIN = 60e3;
const near = (a, b, eps = 1e-6, msg = '') => assert.ok(Math.abs(a - b) <= eps, `${msg} ${a} ≈ ${b}`);
const sec = ms => Math.floor(ms / 1000);
const KNICKS = 'KXNBAGAME-26OCT08NYKBOS-NYK';
const FED = 'KXFEDDECISION-26DEC-C25';

// one Kalshi fill, /markets/trades shape. dollars: newer `_dollars` strings
// alongside the cents; dollars: false is an older cents-only row.
let tid = 0;
function kt({ ticker = KNICKS, side = 'yes', yes = 56, count = 100, at = NOW - MIN, time, id, dollars = true } = {}) {
  const row = {
    trade_id: id || `9f3c1b2e-${++tid}`, ticker, count, yes_price: yes, no_price: 100 - yes,
    taker_side: side, created_time: time || new Date(at).toISOString(),
  };
  if (dollars) Object.assign(row, { yes_price_dollars: (yes / 100).toFixed(4), no_price_dollars: ((100 - yes) / 100).toFixed(4), count_fp: count.toFixed(2) });
  return row;
}
const kfills = rows => W.parseKalshiTrades({ trades: rows, cursor: '' });

// one Polymarket data-API trade (numbers partly strings, like the live API)
let tx = 0;
function pt(o = {}) {
  return {
    proxyWallet: '0x5A0b1C2d3E4f5a6B7c8D9e0F1a2B3c4D5e6F7a8B', side: 'BUY',
    asset: '71321045679252212594626385532706912750332728571942532289631379312455583992563',
    conditionId: '0xdd22472e552920b8438158ea7238bfadfa4f736aa4cee91a6b86c39ead110917',
    size: '20000', price: '0.5', timestamp: sec(NOW - 2 * MIN), title: 'Knicks vs. Celtics', slug: 'nba-nyk-bos-2026-10-08',
    eventSlug: 'nba-nyk-bos-2026-10-08', outcome: 'Knicks', outcomeIndex: 0, name: '', pseudonym: 'Gleaming-Ostrich',
    transactionHash: `0x${String(++tx).padStart(64, 'a')}`, ...o,
  };
}

// the same trade as /v2/trades sends it: snake_case, token_id for asset
function pt2(o = {}) {
  const v1 = pt();
  return {
    proxy_wallet: v1.proxyWallet, side: v1.side, token_id: v1.asset, condition_id: v1.conditionId, size: v1.size, price: v1.price,
    timestamp: v1.timestamp, title: v1.title, slug: v1.slug, icon: 'https://polymarket-upload.s3.amazonaws.com/nba.png', event_slug: v1.eventSlug,
    outcome: v1.outcome, outcome_index: v1.outcomeIndex, name: '', pseudonym: v1.pseudonym, bio: '', profile_image: '', profile_image_optimized: '',
    transaction_hash: v1.transactionHash, ...o,
  };
}

function fakeHttp(route) {
  const calls = [];
  return {
    calls,
    async get(url, cfg = {}) {
      const params = { ...(cfg.params || {}) };
      calls.push({ url, params, timeout: cfg.timeout });
      const out = await route(url, params, calls.length);
      if (out instanceof Error) throw out;
      return { data: out };
    },
  };
}
const quiet = { warn() {} };

// ── Kalshi parsing ──

test('kalshi trades: _dollars strings win over cents, notional is count × the TAKER side price', () => {
  const rows = W.parseKalshiTrades({ trades: [
    { trade_id: 'a', ticker: FED, count: 9000, count_fp: '9000.00', yes_price: 99, no_price: 1,
      yes_price_dollars: '0.6200', no_price_dollars: '0.3800', taker_side: 'yes', created_time: '2026-10-08T11:59:30.123456Z' },
    { trade_id: 'b', ticker: KNICKS, count: 20000, yes_price: 70, no_price: 30, taker_side: 'no', created_time: '2026-10-08T11:58:00Z' },
    { trade_id: 'c', ticker: KNICKS, count: '500', yes_price: '45', taker_side: 'YES', created_time: sec(NOW - 5 * MIN) },
    { trade_id: 'd', ticker: KNICKS, count: 10, no_price_dollars: '0.2500', taker_side: 'yes' },
    { trade_id: 'e', ticker: KNICKS, count: 10, yes_price: 50, created_time: 'x' },                  // no taker side
    { trade_id: 'f', ticker: KNICKS, count: 10, yes_price: 0, no_price: 100, taker_side: 'yes' },   // no real price
    { trade_id: 'g', ticker: KNICKS, count: 10, yes_price: 100, taker_side: 'yes' },
    { trade_id: 'h', ticker: KNICKS, count: 0, yes_price: 50, taker_side: 'no' },
    { trade_id: 'i', count: 10, yes_price: 50, taker_side: 'no' },
    { trade_id: 'j', ticker: KNICKS, count: 10, taker_side: 'no' },
    null,
    { trade_id: 'a', ticker: FED, count: 1, yes_price: 50, taker_side: 'no' },                      // repeat id
  ], cursor: 'abc' });
  assert.deepEqual(rows.map(r => r.id), ['a', 'b', 'c', 'd']);

  const [a, b, c, d] = rows;
  assert.equal(a.price, 0.62, 'dollars, not the 99¢ integer field');
  assert.equal(a.side, 'yes');
  assert.equal(a.contracts, 9000);
  near(a.notional, 5580);
  assert.equal(a.time, '2026-10-08T11:59:30.123456Z', 'raw time kept for grouping');
  assert.equal(a.at, Date.parse('2026-10-08T11:59:30.123Z'), 'microseconds parse');

  assert.equal(b.price, 0.3, 'taker bought NO at 30¢');
  assert.equal(b.yesPrice, 0.7);
  near(b.notional, 6000, 1e-6, '20,000 × $0.30, not × $0.70');

  assert.equal(c.side, 'yes', 'side case-insensitive');
  assert.equal(c.contracts, 500, 'count as a string');
  assert.equal(c.price, 0.45);
  assert.equal(c.at, sec(NOW - 5 * MIN) * 1000, 'unix seconds');

  assert.equal(d.price, 0.75, 'YES price derived from the NO price');
  assert.equal(d.at, null);

  assert.deepEqual(W.parseKalshiTrades(null), []);
  assert.deepEqual(W.parseKalshiTrades({}), []);
  assert.equal(W.parseKalshiTrades([kt()]).length, 1, 'bare array');
  assert.equal(W.parseKalshiTrades({ trades: [kt({ count: 12.5 })] })[0].contracts, 12.5, 'count_fp (fractional contracts)');
  assert.equal(W.parseKalshiTrades({ trades: [{ ticker: KNICKS, count: 5, yes_price: 40, taker_side: 'no', created_time: 't1' }] })[0].id.length > 0, true, 'id synthesized when missing');
});

test('kalshi prints: the fills of one sweep sum into one print; whales are prints ≥ $5k', () => {
  const T = '2026-10-08T11:55:00.482913Z';
  const fills = kfills([
    // a YES sweep through three resting orders: $1,800 + $2,440 + $1,860
    kt({ id: 's1', time: T, yes: 60, count: 3000 }),
    kt({ id: 's2', time: T, yes: 61, count: 4000 }),
    kt({ id: 's3', time: T, yes: 62, count: 3000 }),
    // a NO sweep walking YES down: NO at 60¢ then 61¢
    kt({ id: 'n1', time: '2026-10-08T11:56:10.000001Z', side: 'no', yes: 40, count: 5000 }),
    kt({ id: 'n2', time: '2026-10-08T11:56:10.000001Z', side: 'no', yes: 39, count: 5000 }),
    // same instant, other side: a different order
    kt({ id: 'o1', time: T, side: 'no', yes: 60, count: 100 }),
    // one big single fill, cents only
    kt({ id: 'b1', ticker: FED, at: NOW - 30 * MIN, yes: 25, count: 24000, dollars: false }),
  ]);
  const prints = W.kalshiPrints(fills);
  assert.equal(prints.length, 4);
  const [sweep, noSweep, other, single] = prints;
  assert.deepEqual(sweep.tradeIds, ['s1', 's2', 's3']);
  near(sweep.notional, 6100);
  near(sweep.price, 0.61, 1e-9, 'average fill price');
  assert.equal(sweep.yesStart, 0.6);
  assert.equal(sweep.yesEnd, 0.62, 'a YES sweep ends at the top');
  near(noSweep.notional, 6050);
  near(noSweep.price, 0.605, 1e-9);
  near(noSweep.yesPrice, 0.395, 1e-9);
  assert.equal(noSweep.yesStart, 0.4);
  assert.equal(noSweep.yesEnd, 0.39, 'a NO sweep pushes YES down');
  near(other.notional, 40);
  near(single.notional, 6000);

  const whales = W.kalshiWhales(fills, { kalshiInfo: new Map([[KNICKS, { title: 'New York K at Boston Winner?' }]]) });
  assert.deepEqual(whales.map(w => w.id), [single.key, sweep.key, noSweep.key], 'oldest first');
  assert.deepEqual(whales[1], {
    id: sweep.key, exchange: 'kalshi', ticker: KNICKS, eventTicker: 'KXNBAGAME-26OCT08NYKBOS', title: 'New York K at Boston Winner?',
    side: 'yes', price: 0.61, yesPrice: 0.61, contracts: 10000, notional: 6100, fills: 3, tradeIds: ['s1', 's2', 's3'],
    block: false, at: '2026-10-08T11:55:00.482Z', url: 'https://kalshi.com/markets/kxnbagame-26oct08nykbos',
  });
  assert.equal(whales[0].title, FED, 'no title known: the ticker');
  assert.equal(whales[0].side, 'yes');
  assert.equal(whales[0].price, 0.25);

  assert.equal(W.kalshiWhales(fills, { groupFills: false }).length, 1, 'fill by fill only the single $6k fill is a whale');
  assert.deepEqual(W.kalshiWhales(fills, { minUsd: 6100 }).map(w => w.notional), [6100], '≥ the threshold, float noise aside');
  assert.equal(W.kalshiWhales(fills, { kalshiInfo: t => (t === FED ? 'Fed cuts 25bp in December?' : null) })[0].title, 'Fed cuts 25bp in December?');
  assert.equal(W.kalshiWhales(fills, { kalshiInfo: () => { throw new Error('boom'); } }).length, 3, 'a failing lookup is ignored');
  // a whole-second stamp is too coarse: thirty $200 fills from thirty traders in
  // the same second are thirty prints, not one $6k whale
  const crowd = kfills(Array.from({ length: 30 }, (_, i) => kt({ id: `c${i}`, time: '2026-10-11T20:15:07Z', yes: 50, count: 400 })));
  assert.equal(W.kalshiPrints(crowd).length, 30);
  assert.deepEqual(W.kalshiWhales(crowd), [], 'no fake whale from same-second retail fills');
  assert.equal(W.kalshiPrints(kfills([kt({ id: 'u1', time: '2026-10-11T20:15:07.000Z' }), kt({ id: 'u2', time: '2026-10-11T20:15:07.000Z' })])).length, 2, 'a .000 fraction is a whole second too');
  assert.equal(W.kalshiEventTicker('KXHIGHNY-26OCT08-B65.5'), 'KXHIGHNY-26OCT08');
  assert.equal(W.kalshiEventTicker('ODDTICKER'), 'ODDTICKER');
});

test('kalshi trades: the newer taker_outcome_side / taker_book_side and count_fp, block trades flagged', () => {
  const base = { ticker: KNICKS, yes_price_dollars: '0.6000', no_price_dollars: '0.4000', created_time: '2026-10-08T11:57:00.250001Z' };
  const rows = W.parseKalshiTrades({ trades: [
    { ...base, trade_id: 'n1', count_fp: '10000.00', taker_outcome_side: 'yes', taker_book_side: 'bid', is_block_trade: false },
    { ...base, trade_id: 'n2', count_fp: '10000.00', taker_outcome_side: 'yes', taker_book_side: 'ask' },   // sold YES = bought NO
    { ...base, trade_id: 'n3', count_fp: '250.50', taker_outcome_side: 'NO' },                             // no book side: bought it
    { ...base, trade_id: 'n4', count: 9, count_fp: '12.00', taker_side: 'no', taker_outcome_side: 'yes', taker_book_side: 'bid' },
    { ...base, trade_id: 'n5', count_fp: '20000.00', taker_outcome_side: 'no', taker_book_side: 'bid', is_block_trade: true },
    { ...base, trade_id: 'n6', count_fp: '1.00', taker_outcome_side: 'maybe' },
  ], cursor: '' });
  assert.deepEqual(rows.map(r => r.id), ['n1', 'n2', 'n3', 'n4', 'n5'], 'no readable taker side: skipped');
  const [buyYes, sellYes, noOnly, both, block] = rows;
  assert.equal(buyYes.side, 'yes');
  assert.equal(buyYes.contracts, 10000, 'count_fp');
  near(buyYes.notional, 6000);
  assert.equal(buyYes.block, false);
  assert.equal(sellYes.side, 'no', 'a taker selling YES is NO money');
  near(sellYes.notional, 4000, 1e-6, '10,000 × the 40¢ NO price');
  assert.equal(noOnly.side, 'no');
  assert.equal(noOnly.contracts, 250.5);
  assert.equal(both.side, 'no', 'the deprecated taker_side still wins when both are sent');
  assert.equal(both.contracts, 12, 'count_fp over count');
  assert.equal(block.block, true);
  assert.equal(W.kalshiTakerSide({ takerOutcomeSide: 'yes', takerBookSide: 'sell' }), 'no', 'camelCase too');
  assert.equal(W.kalshiTakerSide({}), null);

  // a block shares the sweep's time, ticker and side but is its own print, flagged
  const sweep = kfills([
    { ...base, trade_id: 's1', count_fp: '6000.00', taker_outcome_side: 'no', taker_book_side: 'bid' },
    { ...base, trade_id: 's2', count_fp: '6000.00', taker_outcome_side: 'no', taker_book_side: 'bid' },
    { ...base, trade_id: 'b1', count_fp: '20000.00', taker_outcome_side: 'no', taker_book_side: 'bid', is_block_trade: 'true' },
  ]);
  const prints = W.kalshiPrints(sweep);
  assert.deepEqual(prints.map(p => [p.tradeIds.join('+'), p.block]), [['s1+s2', false], ['b1', true]]);
  const whales = W.kalshiWhales(sweep);
  assert.equal(whales.length, 1, 'the $4,800 sweep is not a whale; the $8,000 block is');
  assert.equal(whales[0].block, true);
  assert.equal(whales[0].tag, 'block trade');
  assert.equal(whales[0].notional, 8000);
});

// ── Polymarket parsing and tagging ──

test('polymarket trades: fills of one order merge, direction is relative to the first outcome', () => {
  const w = '0x5a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b';
  const rows = W.parsePolymarketTrades({ data: [
    pt({ transactionHash: '0xmerge', size: '4000', price: '0.50' }),
    pt({ transactionHash: '0xmerge', size: 6000, price: 0.55 }),
    pt({ side: 'SELL', size: 10000, price: 0.6 }),                                  // selling outcome 0 = NO money
    pt({ outcome: 'Celtics', outcomeIndex: '1', size: 20000, price: 0.4 }),        // buying outcome 1 = NO money
    pt({ side: 'sell', outcome: 'Celtics', outcomeIndex: 1, size: 100, price: 0.4 }), // selling outcome 1 = YES money
    pt({ outcome: 'No', outcomeIndex: undefined, size: 100, price: 0.3 }),         // index from the label
    pt({ outcome: 'Draw', outcomeIndex: undefined, size: 100, price: 0.3 }),       // can't place it
    pt({ side: 'MERGE' }), pt({ price: '1' }), pt({ size: 0 }), pt({ proxyWallet: '' }), pt({ asset: '' }), null,
  ] });
  assert.equal(rows.length, 6);
  const [m, sell0, buy1, sell1, labelled, unplaced] = rows;
  assert.equal(m.wallet, w, 'lowercased');
  assert.equal(m.contracts, 10000);
  near(m.notional, 5300);
  near(m.price, 0.53, 1e-9);
  assert.equal(m.fills, 2);
  assert.equal(m.name, 'Gleaming-Ostrich', 'pseudonym when no name');
  assert.equal(m.market, pt().conditionId);
  assert.equal(m.dir, 'yes');
  assert.equal(m.yesPrice, m.price);
  assert.equal(sell0.dir, 'no');
  assert.equal(buy1.dir, 'no');
  near(buy1.yesPrice, 0.6, 1e-9, 'first outcome at 1 − 0.40');
  assert.equal(sell1.dir, 'yes');
  assert.equal(sell1.side, 'SELL');
  assert.equal(labelled.outcomeIndex, 1);
  assert.equal(labelled.dir, 'no');
  assert.equal(unplaced.dir, null);
  assert.equal(m.at, sec(NOW - 2 * MIN) * 1000);
  assert.deepEqual(W.parsePolymarketTrades(null), []);
  assert.equal(W.parsePolymarketTrades([pt()]).length, 1, 'bare array');
});

test('polymarket trades: v2 snake_case rows parse the same as v1', () => {
  const v1 = W.parsePolymarketTrades([pt({ transactionHash: '0xsame' })]);
  const v2 = W.parsePolymarketTrades({ data: [pt2({ transaction_hash: '0xsame' })], pagination: { has_more: false, next_cursor: null } });
  assert.equal(v2.length, 1);
  assert.deepEqual(v2, v1);
  const [t] = v2;
  assert.equal(t.wallet, '0x5a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b');
  assert.equal(t.asset, pt().asset, 'token_id is the asset');
  assert.equal(t.conditionId, pt().conditionId);
  assert.equal(t.eventSlug, 'nba-nyk-bos-2026-10-08');
  assert.equal(t.outcomeIndex, 0);
  assert.equal(t.dir, 'yes');
  // two fills of one order, v2 field names
  const merged = W.parsePolymarketTrades({ data: [pt2({ transaction_hash: '0xfeed', size: '1000' }), pt2({ transaction_hash: '0xfeed', size: '3000', price: '0.6' })] });
  assert.equal(merged.length, 1);
  near(merged[0].notional, 2300);
  assert.equal(W.parsePolymarketTrades({ data: [pt2({ outcome_index: '1', outcome: 'Celtics' })] })[0].dir, 'no');
});

test('polymarket whales: tagged "graded whale" or "unknown whale" from the lookup', () => {
  const wallet = n => `0x${String(n).padStart(40, '0')}`;
  const trades = W.parsePolymarketTrades([
    pt({ proxyWallet: wallet(1), size: 20000, price: 0.5 }),                       // $10,000
    pt({ proxyWallet: wallet(2), size: 10000, price: 0.6, name: '' , pseudonym: '' }),
    pt({ proxyWallet: wallet(3), size: 12500, price: 0.4 }),
    pt({ proxyWallet: wallet(4), size: 10000, price: 0.5 }),
    pt({ proxyWallet: wallet(5), size: 10000, price: 0.5 }),
    pt({ proxyWallet: wallet(6), size: 9000, price: 0.5 }),                        // $4,500: not a whale
  ]);
  const asked = [];
  const lookups = {
    [wallet(1)]: 'A', [wallet(2)]: { grade: 'b', name: 'SharpGuy', categories: {} }, [wallet(3)]: { grade: null, wallet: wallet(3) },
  };
  const gradeOf = (w, t) => {
    asked.push([w, t.notional]);
    if (w === wallet(4)) throw new Error('lookup down');
    return lookups[w];
  };
  const out = W.polymarketWhales(trades, { gradeOf });
  assert.equal(out.length, 5);
  assert.deepEqual(asked.map(a => a[0]), [1, 2, 3, 4, 5].map(wallet), 'asked with (wallet, trade) for whales only');
  assert.deepEqual(out.map(e => [e.grade, e.tag, e.known]), [
    ['A', 'graded whale', true], ['B', 'graded whale', true], [null, 'unknown whale', true],
    [null, 'unknown whale', false], [null, 'unknown whale', false],
  ]);
  assert.equal(out[1].name, 'SharpGuy', 'name from the scored trader when the trade has none');
  assert.deepEqual(out[0], {
    id: trades[0].key, exchange: 'polymarket', wallet: wallet(1), name: 'Gleaming-Ostrich', grade: 'A', graded: true, known: true, tag: 'graded whale',
    side: 'BUY', outcome: 'Knicks', outcomeIndex: 0, price: 0.5, yesPrice: 0.5, contracts: 20000, notional: 10000, fills: 1,
    at: new Date(sec(NOW - 2 * MIN) * 1000).toISOString(), title: 'Knicks vs. Celtics', slug: 'nba-nyk-bos-2026-10-08',
    eventSlug: 'nba-nyk-bos-2026-10-08', conditionId: pt().conditionId, asset: pt().asset, txHash: trades[0].txHash,
    url: 'https://polymarket.com/event/nba-nyk-bos-2026-10-08',
  });
  assert.equal(W.polymarketWhales(trades).every(e => e.tag === 'unknown whale'), true, 'no lookup: all unknown');
  assert.equal(W.polymarketWhales(trades, { minUsd: 6000 }).length, 2);

  assert.deepEqual(W.gradeInfo('a'), { grade: 'A', known: true, name: null });
  assert.equal(W.gradeInfo('elite').grade, null, 'only letter grades');
  assert.deepEqual(W.gradeInfo(Promise.resolve('A')), { grade: null, known: false, name: null }, 'sync tagging cannot wait');
  assert.deepEqual(W.gradeInfo(undefined), { grade: null, known: false, name: null });
});

// ── rolling-hour flow ──

test('kalshi flow per market over the rolling hour: net whale dollars, largest print, price before and after', () => {
  // one sweep = fills sharing a sub-second timestamp (Kalshi stamps fills to the microsecond)
  const sweepT = '2026-10-08T11:20:00.418236Z';
  const fills = kfills([
    kt({ id: 'old', at: NOW - 70 * MIN, yes: 50, count: 100 }),                    // before the window
    kt({ id: 'pre', at: NOW - 45 * MIN, yes: 52, count: 200 }),                    // last price before the first whale
    kt({ id: 'w1a', time: sweepT, yes: 55, count: 6000 }),                         // YES sweep $3,300 + $3,920 = $7,220
    kt({ id: 'w1b', time: sweepT, yes: 56, count: 7000 }),
    kt({ id: 'mid', at: NOW - 30 * MIN, side: 'no', yes: 50, count: 600 }),        // $300 of NO
    kt({ id: 'w2', at: NOW - 20 * MIN, side: 'no', yes: 40, count: 10000 }),       // NO $6,000
    kt({ id: 'last', at: NOW - 5 * MIN, yes: 47, count: 100 }),                    // latest price
    // a market with only small trades
    kt({ id: 'q1', ticker: 'KXMLBGAME-26OCT08NYYBOS-NYY', at: NOW - 10 * MIN, count: 100 }),
    // a market whose only whale was 90 minutes ago
    kt({ id: 'z1', ticker: 'KXNHLGAME-26OCT08BOSTOR-BOS', at: NOW - 90 * MIN, yes: 50, count: 20000 }),
    // a whale with nothing before it: its own starting price
    kt({ id: 'f1', ticker: FED, time: '2026-10-08T11:50:00.071553Z', yes: 30, count: 10000 }),
    kt({ id: 'f2', ticker: FED, time: '2026-10-08T11:50:00.071553Z', yes: 31, count: 10000 }),
  ]);
  const rows = W.aggregateFlow(W.kalshiPrints(fills), { now: NOW, kalshiInfo: { [KNICKS]: 'New York K at Boston Winner?' } });
  assert.deepEqual(rows.map(r => r.market), [KNICKS, FED], 'whale money first; quiet and expired markets left out');

  const k = rows[0];
  assert.equal(k.title, 'New York K at Boston Winner?');
  assert.equal(k.url, 'https://kalshi.com/markets/kxnbagame-26oct08nykbos');
  assert.deepEqual(k.outcomes, ['Yes', 'No']);
  assert.equal(k.whalePrints, 2);
  assert.equal(k.yesUsd, 7220);
  assert.equal(k.noUsd, 6000);
  assert.equal(k.netUsd, 1220);
  assert.equal(k.whaleUsd, 13220);
  assert.equal(k.lean, 'yes');
  assert.equal(k.leanOutcome, 'Yes');
  assert.equal(k.prints, 5, 'every print in the window, small ones too');
  assert.equal(k.flowYesUsd, r2(104 + 7220 + 47));
  assert.equal(k.flowNoUsd, 6300);
  assert.equal(k.largest.notional, 7220);
  assert.equal(k.largest.fills, 2);
  assert.equal(k.largest.side, 'yes');
  assert.equal(k.priceBefore, 0.52);
  assert.equal(k.priceAfter, 0.47);
  assert.equal(k.priceMove, -0.05);
  assert.equal(k.firstWhaleAt, '2026-10-08T11:20:00.418Z');
  assert.equal(k.lastWhaleAt, new Date(NOW - 20 * MIN).toISOString());
  assert.equal(k.windowStart, new Date(NOW - 60 * MIN).toISOString());
  assert.equal(k.windowEnd, new Date(NOW).toISOString());

  const f = rows[1];
  assert.equal(f.priceBefore, 0.3, 'no earlier trade: where the sweep started');
  assert.equal(f.priceAfter, 0.31);
  assert.equal(f.title, FED);

  const wide = W.aggregateFlow(W.kalshiPrints(fills), { now: NOW, windowMs: 2 * 3600e3 });
  assert.equal(wide.length, 3, 'a two-hour window catches the 90-minute-old whale');
  assert.deepEqual(W.aggregateFlow(W.kalshiPrints(fills), { now: NOW, minUsd: 7000 }).map(r => r.market), [KNICKS], 'the $6,100 Fed sweep is under $7k');
  assert.equal(W.aggregateFlow(W.kalshiPrints(fills), { now: NOW, limit: 1 }).length, 1);
  assert.deepEqual(W.aggregateFlow(null), []);
});

const r2 = x => Math.round(x * 100) / 100;

test('polymarket flow: YES = backing the first outcome, labels from the trades', () => {
  const trades = W.parsePolymarketTrades([
    pt({ size: 20000, price: 0.5, timestamp: sec(NOW - 50 * MIN) }),                                    // BUY Knicks $10k: yes
    pt({ side: 'SELL', size: 10000, price: 0.6, timestamp: sec(NOW - 30 * MIN) }),                     // SELL Knicks $6k: no
    pt({ outcome: 'Celtics', outcomeIndex: 1, size: 20000, price: 0.42, timestamp: sec(NOW - 10 * MIN) }), // BUY Celtics $8.4k: no
    pt({ conditionId: '0xother', title: 'Other', size: 2000, price: 0.5 }),                             // $1k only
  ]);
  const kalshi = W.kalshiPrints(kfills([kt({ at: NOW - 5 * MIN, count: 10000, yes: 60 })]));
  const all = W.aggregateFlow([...trades, ...kalshi], { now: NOW, gradeOf: () => 'B' });
  assert.equal(all.length, 2);
  const [pm] = W.aggregateFlow([...trades, ...kalshi], { now: NOW, exchange: 'polymarket', gradeOf: () => 'B' });
  assert.equal(pm.exchange, 'polymarket');
  assert.equal(pm.market, pt().conditionId);
  assert.equal(pm.title, 'Knicks vs. Celtics');
  assert.equal(pm.url, 'https://polymarket.com/event/nba-nyk-bos-2026-10-08');
  assert.deepEqual(pm.outcomes, ['Knicks', 'Celtics']);
  assert.equal(pm.yesUsd, 10000);
  assert.equal(pm.noUsd, 14400);
  assert.equal(pm.netUsd, -4400);
  assert.equal(pm.lean, 'no');
  assert.equal(pm.leanOutcome, 'Celtics');
  assert.equal(pm.largest.notional, 10000);
  assert.equal(pm.largest.tag, 'graded whale', 'largest print tagged through the lookup');
  assert.equal(pm.priceBefore, 0.5);
  assert.equal(pm.priceAfter, 0.58, 'Knicks at 1 − 0.42');
  assert.equal(pm.priceMove, 0.08);
});

// ── fetchers ──

test('kalshi fetch: follows the cursor, min_ts in seconds, stops at an empty cursor', async () => {
  const pages = { '': { trades: [kt({ id: 'p1' }), kt({ id: 'p2' })], cursor: 'c1' }, c1: { trades: [kt({ id: 'p3' })], cursor: 'c2' }, c2: { trades: [kt({ id: 'p4' })], cursor: '' } };
  const http = fakeHttp((url, params) => pages[params.cursor || '']);
  const since = NOW - 3600e3 + 123;
  const r = await W.fetchKalshiTrades(http, { sinceMs: since });
  assert.equal(http.calls.length, 3);
  assert.equal(http.calls[0].url, 'https://api.elections.kalshi.com/trade-api/v2/markets/trades');
  assert.deepEqual(http.calls[0].params, { limit: 1000, min_ts: sec(since) });
  assert.deepEqual(http.calls[1].params, { limit: 1000, min_ts: sec(since), cursor: 'c1' });
  assert.equal(http.calls[2].params.cursor, 'c2');
  assert.ok(http.calls[0].timeout > 0);
  assert.deepEqual(r.trades.map(t => t.id), ['p1', 'p2', 'p3', 'p4']);
  assert.equal(r.pages, 3);
  assert.equal(r.truncated, false);
  assert.deepEqual(r.errors, []);

  const one = fakeHttp(() => ({ trades: [kt()], cursor: '' }));
  await W.fetchKalshiTrades(one, { ticker: KNICKS, limit: 50 });
  assert.deepEqual(one.calls[0].params, { limit: 50, ticker: KNICKS }, 'no min_ts unless asked');
});

test('kalshi fetch: page cap, empty pages and failures', async () => {
  let n = 0;
  const endless = fakeHttp(() => ({ trades: [kt({ id: `e${++n}` })], cursor: `next${n}` }));
  const capped = await W.fetchKalshiTrades(endless, { maxPages: 2 });
  assert.equal(endless.calls.length, 2, 'never more than maxPages');
  assert.equal(capped.trades.length, 2);
  assert.equal(capped.truncated, true, 'more pages were left');

  const empty = fakeHttp(() => ({ trades: [], cursor: 'still-here' }));
  const e = await W.fetchKalshiTrades(empty);
  assert.equal(empty.calls.length, 1, 'an empty page ends it');
  assert.equal(e.truncated, false);

  const flaky = fakeHttp((url, params, i) => (i === 1 ? { trades: [kt({ id: 'ok' })], cursor: 'c1' } : new Error('502 Bad Gateway')));
  const f = await W.fetchKalshiTrades(flaky);
  assert.deepEqual(f.trades.map(t => t.id), ['ok'], 'keeps the pages before the failure');
  assert.deepEqual(f.errors, [{ exchange: 'kalshi', key: 'trades page 2', message: '502 Bad Gateway' }]);
  assert.equal(f.truncated, true);

  const junk = fakeHttp(() => 'not json');
  assert.deepEqual((await W.fetchKalshiTrades(junk)).trades, []);
});

test('polymarket fetch: v2 large taker trades (CASH filter), cursor paging, failures', async () => {
  // v2 wraps every page: { data, pagination: { limit, offset, has_more, next_cursor } }
  const http = fakeHttp((url, params) => (params.cursor === 'c2'
    ? { data: [pt2({ size: '100' })], pagination: { limit: 3, offset: 3, has_more: false, next_cursor: null } }
    : { data: Array.from({ length: 3 }, () => pt2()), pagination: { limit: 3, offset: 0, has_more: true, next_cursor: 'c2' } }));
  const r = await W.fetchPolymarketTrades(http, { limit: 3, maxPages: 3 });
  assert.equal(http.calls[0].url, 'https://data-api.polymarket.com/v2/trades');
  assert.deepEqual(http.calls[0].params, { limit: 3, taker_only: true, filter_type: 'CASH', filter_amount: 500 }, 'CASH: the default TOKENS filter would count shares');
  assert.equal(http.calls[1].params.cursor, 'c2', 'next_cursor goes back as cursor');
  assert.equal(http.calls.length, 2, 'has_more false ends it');
  assert.equal(r.trades.length, 4);
  assert.equal(r.pages, 2);
  assert.equal(r.truncated, false);

  const capped = fakeHttp(() => ({ data: [pt2()], pagination: { has_more: true, next_cursor: 'more' } }));
  const c = await W.fetchPolymarketTrades(capped, { maxPages: 1 });
  assert.equal(capped.calls.length, 1);
  assert.equal(c.truncated, true, 'the page cap cut it short');

  const one = fakeHttp(() => ({ data: [pt()] }));
  assert.equal((await W.fetchPolymarketTrades(one, { minCash: 5000 })).trades.length, 1, 'v1 rows in a wrapper still parse');
  assert.equal(one.calls[0].params.filter_amount, 5000);
  const bare = fakeHttp(() => [pt2()]);
  assert.equal((await W.fetchPolymarketTrades(bare)).trades.length, 1, 'a bare array too');
  const empty = fakeHttp(() => ({ data: null }));
  assert.deepEqual((await W.fetchPolymarketTrades(empty)).trades, [], 'data: null');

  const down = fakeHttp(() => new Error('timeout of 10000ms exceeded'));
  const d = await W.fetchPolymarketTrades(down);
  assert.deepEqual(d.trades, []);
  assert.equal(d.errors[0].message, 'timeout of 10000ms exceeded');
});

// ── watcher ──

// routes the two endpoints to swappable responses
function exchangesHttp() {
  const state = { kalshi: { trades: [], cursor: '' }, polymarket: [] };
  const http = fakeHttp(url => (url.includes('kalshi') ? (typeof state.kalshi === 'function' ? state.kalshi() : state.kalshi) : state.polymarket));
  return { http, state };
}

test('watcher: Kalshi trades dedup by trade_id across overlapping polls', async () => {
  let t = NOW;
  const { http, state } = exchangesHttp();
  const w = W.createWhaleWatcher({ http, now: () => t, log: quiet });
  const big = kt({ id: 'k1', at: NOW - 2 * MIN, yes: 60, count: 10000 });   // $6,000
  const small = kt({ id: 'k2', at: NOW - MIN, side: 'no', yes: 60, count: 100 });
  state.kalshi = { trades: [small, big], cursor: '' };   // newest first, as Kalshi sends them

  const first = await w.pollKalshi();
  assert.deepEqual(first.map(e => [e.ticker, e.side, e.notional]), [[KNICKS, 'yes', 6000]]);
  assert.equal(http.calls[0].params.min_ts, sec(NOW - 3600e3), 'the first poll seeds the rolling hour');

  t += 30e3;
  const big2 = kt({ id: 'k3', at: NOW + 20e3, side: 'no', yes: 70, count: 30000 });  // NO at 30¢: $9,000
  state.kalshi = { trades: [big2, small, big], cursor: '' };   // the overlap re-sends k1, k2
  const second = await w.pollKalshi();
  assert.deepEqual(second.map(e => e.tradeIds), [['k3']], 'only the new print');
  assert.equal(http.calls[1].params.min_ts, sec(NOW - MIN - 60e3), 'newest trade seen minus the overlap');

  t += 30e3;
  assert.deepEqual(await w.pollKalshi(), [], 'nothing new');
  assert.equal(http.calls[2].params.min_ts, sec(NOW + 20e3 - 60e3));

  assert.deepEqual(w.events().map(e => e.notional), [9000, 6000], 'newest first');
  assert.deepEqual(w.events({ minUsd: 7000 }).map(e => e.notional), [9000]);
  assert.deepEqual(w.events({ market: KNICKS }).length, 2);
  const [row] = w.flow();
  assert.equal(row.yesUsd, 6000);
  assert.equal(row.noUsd, 9000);
  assert.equal(row.lean, 'no');
  assert.equal(row.prints, 3);
  assert.equal(row.priceAfter, 0.7);
  const s = w.state();
  assert.equal(s.seen.kalshi, 3);
  assert.equal(s.lastHour.whales, 2);
  assert.equal(s.lastHour.usd, 15000);
  assert.equal(s.lastKalshiPollAt, new Date(t).toISOString());
  assert.equal(s.kalshiTruncated, false);
});

test('watcher: a sweep whose fills arrive over two polls becomes one whale, updated in place', async () => {
  let t = NOW;
  const { http, state } = exchangesHttp();
  const w = W.createWhaleWatcher({ http, now: () => t, log: quiet });
  const T = '2026-10-08T11:59:00.250117Z';
  const f1 = kt({ id: 'f1', time: T, yes: 50, count: 6000 });   // $3,000
  const f2 = kt({ id: 'f2', time: T, yes: 51, count: 5000 });   // $2,550
  const f3 = kt({ id: 'f3', time: T, yes: 52, count: 2000 });   // $1,040

  state.kalshi = { trades: [f1], cursor: '' };
  assert.deepEqual(await w.pollKalshi(), [], '$3,000 so far');
  t += 30e3;
  state.kalshi = { trades: [f2, f1], cursor: '' };
  const [ev] = await w.pollKalshi();
  assert.equal(ev.notional, 5550);
  assert.equal(ev.fills, 2);
  t += 30e3;
  state.kalshi = { trades: [f3, f2, f1], cursor: '' };
  assert.deepEqual(await w.pollKalshi(), [], 'not announced twice');
  assert.equal(w.events().length, 1);
  assert.equal(w.events()[0], ev, 'the same event object, grown');
  assert.equal(ev.notional, 6590);
  assert.equal(ev.fills, 3);
  assert.equal(ev.contracts, 13000);
  assert.equal(w.flow()[0].largest.notional, 6590);
});

test('watcher: whales found late go in the feed but are not "new"; ancient trades are ignored', async () => {
  const t = NOW;
  const { http, state } = exchangesHttp();
  const w = W.createWhaleWatcher({ http, now: () => t, log: quiet });
  state.kalshi = { trades: [kt({ id: 'r', at: NOW - 3 * MIN, count: 10000 }), kt({ id: 'o', at: NOW - 50 * MIN, count: 10000 })], cursor: '' };
  const fresh = await w.pollKalshi();
  assert.deepEqual(fresh.map(e => e.tradeIds[0]), ['r'], '50 minutes old at startup: history');
  assert.deepEqual(w.events().map(e => e.tradeIds[0]), ['r', 'o']);
  assert.equal(w.flow()[0].whalePrints, 2);

  assert.deepEqual(w.ingestKalshi(kfills([kt({ id: 'ancient', at: NOW - 4 * 3600e3, count: 100000 })]), t), []);
  assert.equal(w.events().length, 2, 'older than the dedup memory: could be a repeat, so dropped');
});

test('watcher: Polymarket whales graded through an async lookup, deduped across polls', async () => {
  let t = NOW;
  const { http, state } = exchangesHttp();
  const sharp = '0x00000000000000000000000000000000000000aa';
  const flaky = '0x00000000000000000000000000000000000000bb';
  const asked = [];
  const gradeOf = async (wallet, trade) => {
    asked.push(wallet);
    if (wallet === flaky) throw new Error('db down');
    return wallet === sharp ? { grade: 'A', name: 'Domer' } : null;
  };
  const w = W.createWhaleWatcher({ http, now: () => t, gradeOf, log: quiet });
  const a = pt({ proxyWallet: sharp, size: 20000, price: 0.5, name: '', pseudonym: '', timestamp: sec(NOW - MIN) });
  const b = pt({ size: 30000, price: 0.4, timestamp: sec(NOW - 30e3) });
  const c = pt({ proxyWallet: flaky, size: 10000, price: 0.6, timestamp: sec(NOW - 20e3) });
  const small = pt({ size: 1000, price: 0.5 });
  state.polymarket = [c, b, a, small];

  const first = await w.pollPolymarket();
  assert.deepEqual(first.map(e => [e.wallet.slice(-2), e.tag, e.grade]), [['aa', 'graded whale', 'A'], ['8b', 'unknown whale', null], ['bb', 'unknown whale', null]]);
  assert.equal(first[0].name, 'Domer');
  assert.deepEqual(http.calls[0].params, { limit: 500, taker_only: true, filter_type: 'CASH', filter_amount: 500 });
  assert.equal(asked.length, 3, 'the $500 trade is never looked up');
  assert.match(w.state().errors[0].message, /grade lookup 0x…: db down/);

  t += 30e3;
  const d = pt({ side: 'SELL', size: 20000, price: 0.3, timestamp: sec(NOW + 10e3) });
  state.polymarket = [d, c, b, a];
  const second = await w.pollPolymarket();
  assert.deepEqual(second.map(e => e.side), ['SELL'], 'repeats skipped');
  assert.equal(asked.length, 4);

  assert.deepEqual(w.events({ graded: true }).map(e => e.wallet), [sharp]);
  assert.equal(w.events({ graded: false }).length, 3);
  assert.equal(w.events({ exchange: 'kalshi' }).length, 0);
  assert.equal(w.state().lastHour.graded, 1);
  const [row] = w.flow({ exchange: 'polymarket' });
  assert.equal(row.whalePrints, 4);
  assert.equal(row.largest.wallet, b.proxyWallet.toLowerCase());
  assert.equal(w.flow()[0].largest.tag, 'unknown whale', 'the stored event, not a fresh lookup');
});

test('watcher: poll() reads both exchanges; one failing does not stop the other', async () => {
  const t = NOW;
  const { http, state } = exchangesHttp();
  const w = W.createWhaleWatcher({ http, now: () => t, log: quiet });
  state.kalshi = { trades: [kt({ at: NOW - 20e3, count: 10000 })], cursor: '' };
  state.polymarket = [pt({ timestamp: sec(NOW - 40e3) })];
  const out = await w.poll();
  assert.deepEqual(out.map(e => e.exchange), ['polymarket', 'kalshi'], 'oldest first across exchanges');
  assert.equal(w.flow().length, 2);

  const broken = exchangesHttp();
  broken.state.kalshi = () => new Error('kalshi 429');
  broken.state.polymarket = [pt({ timestamp: sec(NOW - 40e3) })];
  const w2 = W.createWhaleWatcher({ http: broken.http, now: () => t, log: quiet });
  const got = await w2.poll();
  assert.deepEqual(got.map(e => e.exchange), ['polymarket']);
  const s = w2.state();
  assert.equal(s.kalshiTruncated, true);
  assert.ok(s.errors.some(e => /kalshi 429/.test(e.message)));
});

test('watcher: the hour rolls on and old state is pruned', async () => {
  let t = NOW;
  const { http, state } = exchangesHttp();
  const w = W.createWhaleWatcher({ http, now: () => t, log: quiet });
  state.kalshi = { trades: [kt({ id: 'x1', at: NOW - MIN, count: 10000 })], cursor: '' };
  state.polymarket = [pt({ timestamp: sec(NOW - MIN) })];
  await w.poll();
  assert.equal(w.flow().length, 2);

  t = NOW + 61 * MIN;
  state.kalshi = { trades: [], cursor: '' };
  state.polymarket = [];
  assert.deepEqual(w.flow(), [], 'out of the rolling hour');
  assert.equal(w.flow({ windowMs: 2 * 3600e3 }).length, 2, 'still there for a longer window');
  assert.equal(w.state().lastHour.whales, 0);
  assert.equal(w.events().length, 2, 'the feed keeps history');

  t = NOW + 4 * 3600e3;
  await w.poll();
  const s = w.state();
  assert.deepEqual(s.seen, { kalshi: 0, polymarket: 0 });
  assert.equal(s.prints, 0);
  const lastKalshi = http.calls.filter(c => c.url.includes('kalshi')).at(-1);
  assert.equal(lastKalshi.params.min_ts, sec(t - w.settings().seenTtlMs), 'a long gap reads back only as far as the dedup memory');
});

test('watcher: the memory cap drops flow data, never the dedup memory', async () => {
  let t = NOW;
  const { http, state } = exchangesHttp();
  const w = W.createWhaleWatcher({ http, now: () => t, opts: { maxPrints: 1 }, log: quiet });
  state.kalshi = { trades: [kt({ id: 'c1', at: NOW - 2 * MIN, count: 10000 }), kt({ id: 'c2', at: NOW - MIN, count: 10000 })], cursor: '' };
  state.polymarket = [pt({ timestamp: sec(NOW - 2 * MIN) }), pt({ timestamp: sec(NOW - MIN) })];
  assert.equal((await w.poll()).length, 4);
  assert.equal(w.state().prints, 1, 'capped');
  t += 30e3;
  assert.deepEqual(await w.poll(), [], 'evicted prints are still known trades');
  assert.equal(w.events().length, 4);
});

test('watcher: overlapping polls of the same exchange do not run twice', async () => {
  let release;
  const gate = new Promise(r => { release = r; });
  const http = fakeHttp(async url => { if (url.includes('kalshi')) await gate; return url.includes('kalshi') ? { trades: [kt({ count: 10000 })], cursor: '' } : []; });
  const w = W.createWhaleWatcher({ http, now: () => NOW, log: quiet });
  const slow = w.pollKalshi();
  assert.deepEqual(await w.pollKalshi(), [], 'still busy');
  release();
  assert.equal((await slow).length, 1);
  assert.equal(http.calls.length, 1);
});

test('settings: defaults, overrides, WHALE_MIN_USD from env', () => {
  const o = W.resolveOptions();
  assert.equal(o.minUsd, 5000);
  assert.equal(o.windowMs, 3600e3);
  assert.equal(W.resolveOptions({ minUsd: 10000, windowMs: undefined }).windowMs, 3600e3, 'undefined keeps the default');
  assert.equal(W.resolveOptions({ windowMs: 6 * 3600e3, seenTtlMs: 60e3 }).seenTtlMs, 6 * 3600e3 + 60e3, 'dedup memory outlasts window + overlap');
  assert.equal(o.seenTtlMs, o.windowMs + o.kalshiOverlapMs + 5 * 60e3, 'default dedup memory: window + overlap + 5 minutes');
  assert.equal(W.resolveOptions({ windowMs: 6 * 3600e3 }).seenTtlMs, 6 * 3600e3 + o.kalshiOverlapMs + 5 * 60e3, 'a longer window stretches the default memory');
  assert.deepEqual(W.optionsFromEnv({ WHALE_MIN_USD: '2500' }), { minUsd: 2500 });
  assert.deepEqual(W.optionsFromEnv({ WHALE_MIN_USD: 'lots' }), {});
  assert.deepEqual(W.optionsFromEnv({ WHALE_MIN_USD: '' }), {});
  assert.deepEqual(W.optionsFromEnv({ WHALE_MIN_USD: '-5' }), {});
  assert.deepEqual(W.optionsFromEnv({}), {});
  const w = W.createWhaleWatcher({ http: fakeHttp(() => []), opts: W.optionsFromEnv({ WHALE_MIN_USD: '20000' }), log: quiet });
  assert.equal(w.settings().minUsd, 20000);
  assert.equal(w.state().minUsd, 20000);
});
