const test = require('node:test');
const assert = require('node:assert');
const K = require('../kmaker');

test('maker fee: Kalshi 0.0175 x C x P x (1-P), rounded up per 100-contract order', () => {
  // 0.0175 * 100 * .5 * .5 = 0.4375 → 44c on the order → 0.0044 a contract
  assert.strictEqual(K.makerFee(0.5), 0.0044);
  assert.strictEqual(K.makerFee(0.9), 0.0016);
  assert.strictEqual(K.makerFee(0.5, 0), 0);
});

test('fee schedule: no maker fee only where the series says so', () => {
  assert.strictEqual(K.makerRateOf({ fee_type: 'quadratic', fee_multiplier: 1 }), 0);
  assert.strictEqual(K.makerRateOf({ fee_type: 'quadratic_with_maker_fees', fee_multiplier: 1 }), 0.0175);
  assert.strictEqual(K.makerRateOf(null), 0.0175);
  assert.ok(Math.abs(K.makerRateOf({ fee_type: 'quadratic_with_maker_fees', fee_multiplier: 2 }) - 0.035) < 1e-12);
});

test('suggestBid: highest cent clearing 2% after the fee, under the ask', () => {
  const b = K.suggestBid({ fair: 0.5, ask: 0.52 });
  // 0.48 + 0.0044 = 0.4844 → 0.5/0.4844 = +3.2%; 0.49 + 0.0044 → +1.1% (short)
  assert.strictEqual(b.bid, 0.48);
  assert.ok(b.edge >= 0.02);
  // fair above the ask: never a take, at most 1c under the ask
  assert.strictEqual(K.suggestBid({ fair: 0.6, ask: 0.55 }).bid, 0.54);
  // too little room
  assert.strictEqual(K.suggestBid({ fair: 0.03, ask: 0.04 }), null);
  assert.strictEqual(K.suggestBid({ fair: null, ask: 0.5 }), null);
});

test('fillOf: through the bid fills; a sell at the bid is apart; outside the window ignored', () => {
  const tr = [[100, 0.50, 'yes', 5], [200, 0.48, 'no', 3], [300, 0.47, 'no', 1], [500, 0.40, 'no', 1]];
  const f = K.fillOf(tr, { buy: 'yes', bid: 0.48, from: 150, to: 400 });
  assert.deepStrictEqual(f.through, { t: 300, price: 0.47 });
  assert.deepStrictEqual(f.atBid, { t: 200, price: 0.48 });
  assert.strictEqual(f.contractsAt, 3);
  // a NO bid at 0.48 fills when YES prints above 0.52
  const n = K.fillOf([[200, 0.53, 'yes', 2], [250, 0.52, 'yes', 1]], { buy: 'no', bid: 0.48, from: 0, to: 1000 });
  assert.deepStrictEqual(n.through, { t: 200, price: 0.47 });
  assert.deepStrictEqual(n.atBid, { t: 250, price: 0.48 });
  // a buyer lifting the ask at our price is no sell to us
  assert.strictEqual(K.fillOf([[200, 0.48, 'yes', 1]], { buy: 'yes', bid: 0.48, from: 0, to: 1000 }).atBid, null);
});

test('grade and summarize: CLV on the close, result from settlement, verdict at 50', () => {
  const g = K.grade({ buy: 'no', result: 'no', cost: 0.4844, closeFair: 0.52 });
  assert.strictEqual(g.outcome, 'win');
  assert.ok(Math.abs(g.clv - (0.52 / 0.4844 - 1)) < 1e-3);
  assert.ok(Math.abs(g.profit - (1 / 0.4844 - 1)) < 1e-3);
  const mk = (i, clv) => ({ status: 'graded', filled: true, clv, cost: 0.5, closeFair: 0.5 * (1 + clv), outcome: i % 2 ? 'win' : 'loss', profit: i % 2 ? 1 : -1, fairAtPost: 0.5, fairAtFill: 0.49 });
  const few = K.summarize([mk(1, 0.02), mk(2, 0.03), { status: 'unfilled', filled: false }]);
  assert.strictEqual(few.filled, 2); assert.strictEqual(few.decided, 3); assert.strictEqual(few.verdict, 'lead');
  const bad = K.summarize(Array.from({ length: 50 }, (_, i) => mk(i, -0.01 - (i % 3) * 0.001)));
  assert.strictEqual(bad.verdict, 'fail');
  const good = K.summarize(Array.from({ length: 50 }, (_, i) => mk(i, 0.03 + (i % 3) * 0.01)));
  assert.strictEqual(good.verdict, 'passes the record');
  assert.strictEqual(good.fairDriftAtFill, -0.01);
});

test('tracker: posts once, closes on Pinnacle\'s last read, decides from prints, grades on settlement', async () => {
  const rows = new Map();
  const store = { all: async () => [...rows.values()], put: async b => { rows.set(b.id, b); } };
  let t = Date.parse('2026-10-25T12:00:00Z');
  const start = '2026-10-25T17:00:00Z';
  const pg = { id: 1, home: 'Dallas Cowboys', away: 'New York Giants', start, ml: { home: 0.5, away: 0.5 }, spreads: [], totals: [] };
  const games = { nfl: [{ id: 'pin-1', home_team: 'Dallas Cowboys', away_team: 'New York Giants', commence_time: start, bookmakers: [] }] };
  const krow = (yesAsk, noAsk) => ({ exchange: 'kalshi', id: 'KXNFLGAME-26OCT25NYGDAL-DAL', kind: 'teams', outcomeLabel: 'Dallas', eventKey: 'kalshi:KXNFLGAME-26OCT25NYGDAL', gameKey: 'kalshi:KXNFL|26OCT25NYGDAL', startTime: start, yesAsk, noAsk, tradable: true });
  const calls = [];
  const http = { get: async (url, cfg) => {
    calls.push(url);
    if (/\/series\//.test(url)) return { data: { series: { fee_type: 'quadratic_with_maker_fees', fee_multiplier: 1 } } };
    if (/\/markets\/trades/.test(url)) return { data: { trades: [{ created_time: '2026-10-25T13:00:00Z', yes_price_dollars: '0.4700', taker_side: 'no', count_fp: '10' }], cursor: '' } };
    return { data: { market: { result: 'yes', status: 'finalized' } } };
  } };
  const tr = K.createMakerTracker({ store, http, now: () => t });
  // the board relies on xsize.sidesOf matching the Kalshi row to Pinnacle's game
  const xsize = require('../xsize');
  const orig = xsize.sidesOf;
  xsize.sidesOf = () => [{ venue: 'kalshi', ref: { venue: 'kalshi', id: krow().id, buy: 'yes' }, sideKey: `kalshi|${krow().id}|yes`, sport: 'nfl', event: 'New York Giants @ Dallas Cowboys', start, market: 'h2h', side: 'Dallas Cowboys', point: null, fair: pg.ml.home, alt: false, cost: 0.53, ev: -0.05 }];
  try {
    await tr.scan({ games, pinGames: [pg], kalshiRows: [krow(0.52, 0.5)] });
    const b = [...rows.values()][0];
    assert.strictEqual(b.bid, 0.48); assert.strictEqual(b.status, 'open'); assert.strictEqual(b.makerRate, 0.0175);
    t += 60e3;
    await tr.scan({ games, pinGames: [pg], kalshiRows: [krow(0.52, 0.5)] });
    assert.strictEqual(rows.size, 1, 'one bid per side');
    t = Date.parse(start) - 10 * 60e3;
    await tr.scan({ games, pinGames: [pg], kalshiRows: [krow(0.52, 0.5)] });
    t = Date.parse(start) + 60e3;
    await tr.scan({ games, pinGames: [pg], kalshiRows: [] });
    assert.strictEqual(b.status, 'closed'); assert.strictEqual(b.closeFair, 0.5);
    t = Date.parse(start) + 3 * 3600e3;
    await tr.settle({ minAgeMs: 0 });
    assert.strictEqual(b.filled, true); assert.strictEqual(b.status, 'graded'); assert.strictEqual(b.outcome, 'win');
    assert.ok(b.clv > 0.02);
    assert.ok(calls.some(u => /markets\/trades/.test(u)));
  } finally { xsize.sidesOf = orig; }
});

test('kinds: NHL spreads and totals (no maker fee) are their own record, never pooled', () => {
  assert.strictEqual(K.kindOf({ sport: 'nhl', market: 'totals' }), 'kalshi-maker-nhl');
  assert.strictEqual(K.kindOf({ sport: 'nhl', market: 'spreads' }), 'kalshi-maker-nhl');
  assert.strictEqual(K.kindOf({ sport: 'nhl', market: 'h2h' }), 'kalshi-maker');
  assert.strictEqual(K.kindOf({ sport: 'nfl', market: 'totals' }), 'kalshi-maker');
  const b = (sport, market) => ({ sport, market, status: 'graded', filled: true, clv: 0.01, cost: 0.5, closeFair: 0.505, outcome: 'win', profit: 1 });
  const k = K.byKind([b('nhl', 'totals'), b('nhl', 'h2h'), b('nba', 'spreads')]);
  assert.strictEqual(k['kalshi-maker-nhl'].filled, 1);
  assert.strictEqual(k['kalshi-maker'].filled, 2);
  assert.strictEqual(k['kalshi-maker-nhl'].kind, 'kalshi-maker-nhl');
});
