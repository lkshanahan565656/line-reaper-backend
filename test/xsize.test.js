const test = require('node:test');
const assert = require('node:assert/strict');
const X = require('../xsize');
const { createMemoryStore } = require('../evtrack');

const START = '2026-10-25T17:00:00.000Z';
// Pinnacle: Saints (home) 58%, total 41.5 over 50%, Saints -3.5 52% (main), -6.5 alt
const pg = { id: 1, home: 'New Orleans Saints', away: 'Pittsburgh Steelers', start: START,
  ml: { home: 0.58, away: 0.42, limit: 5000 },
  spreads: [{ home: -3.5, pHome: 0.52, alt: false, limit: 3000 }, { home: -6.5, pHome: 0.35, alt: true, limit: 500 }],
  totals: [{ line: 41.5, pOver: 0.5, alt: false, limit: 2000 }] };
const gem = (name, price, buy, extra = {}) => ({ name, price, ref: { venue: 'gemini', id: 'GEMI-NFL-NO', buy }, ...extra });
const games = { nfl: [{ id: 'pin-1', home_team: pg.home, away_team: pg.away, commence_time: START, bookmakers: [
  { key: 'pinnacle', markets: [] },
  { key: 'gemini', markets: [{ key: 'h2h', outcomes: [gem(pg.home, -122, 'yes'), gem(pg.away, 130, 'no')] }] },
] }] };
const bare = { nfl: [{ id: 'pin-1', home_team: pg.home, away_team: pg.away, commence_time: START, bookmakers: [] }] };
const krow = { exchange: 'kalshi', id: 'KXNFLTOTAL-26OCT25PITNO-41', gameKey: 'NFL-PITNO', eventKey: 'kalshi:KXNFLTOTAL-26OCT25PITNO', kind: 'total', line: 41.5,
  yesAsk: 0.47, noAsk: 0.55, tradable: true };
const kteam = { exchange: 'kalshi', id: 'KXNFLGAME-26OCT25PITNO-NO', gameKey: 'NFL-PITNO', eventKey: 'kalshi:KXNFLGAME-26OCT25PITNO', kind: 'teams',
  outcomeLabel: 'New Orleans', noLabel: 'Pittsburgh', yesAsk: 0.6, noAsk: 0.42, startTime: START, tradable: true };

test('pinFair: moneyline, spreads at the home or away number, totals; three-way only beside three-way', () => {
  assert.equal(X.pinFair(pg, 'h2h', 'Pittsburgh Steelers').p, 0.42);
  assert.equal(X.pinFair(pg, 'h2h', 'Draw', null, { three: true }), null);
  assert.deepEqual(X.pinFair(pg, 'spreads', 'New Orleans Saints -3.5', -3.5), { p: 0.52, alt: false, limit: 3000 });
  assert.equal(X.pinFair(pg, 'spreads', 'Pittsburgh Steelers +3.5', 3.5).p, 0.48);
  assert.equal(X.pinFair(pg, 'spreads', 'New Orleans Saints -6.5', -6.5).alt, true);
  assert.equal(X.pinFair(pg, 'totals', 'Under', 41.5).p, 0.5);
  assert.equal(X.pinFair(pg, 'totals', 'Over', 44.5), null);
});

test('sidesOf: Gemini outcomes by their ref, Kalshi rows both ways, fair and top EV', () => {
  const s = X.sidesOf({ games, pinGames: [pg], kalshiRows: [krow, kteam] });
  const g = s.filter(x => x.venue === 'gemini');
  assert.equal(g.length, 2);
  assert.equal(g[0].fair, 0.58);
  assert.ok(Math.abs(g[0].ev - (0.58 / (122 / 222) - 1)) < 1e-3);
  const k = s.filter(x => x.venue === 'kalshi');
  const over = k.find(x => x.side === 'Over'), under = k.find(x => x.side === 'Under');
  assert.equal(over.ref.buy, 'yes');
  assert.equal(under.ref.buy, 'no');
  assert.ok(over.ev > 0.02, 'Over at 47c + fee against 50% fair');
  const saints = k.find(x => x.market === 'h2h' && x.side === pg.home), steelers = k.find(x => x.market === 'h2h' && x.side === pg.away);
  assert.equal(saints.ref.buy, 'yes');
  assert.equal(steelers.ref.buy, 'no');
  assert.equal(steelers.event, 'Pittsburgh Steelers @ New Orleans Saints');
});

function fakeHttp(books) {
  const calls = [];
  return { calls, get: async url => { calls.push(url); const k = Object.keys(books).find(x => url.includes(x)); if (!k) throw Object.assign(new Error('nf'), { response: { status: 404 } }); return { data: books[k] }; } };
}

test('scan: a tier is a bet only when it all fills at +1%; first flag kept; started bets close on Pinnacle\'s last fair', async () => {
  let t = Date.parse(START) - 10 * 60e3;
  const store = createMemoryStore();
  // Kalshi total: NO bids at 0.53 (YES ask 0.47) for 150 contracts, then 0.50 (YES ask 0.50) deep
  const http = fakeHttp({ 'KXNFLTOTAL-26OCT25PITNO-41/orderbook': { orderbook_fp: { no_dollars: [['0.53', '150'], ['0.50', '5000']], yes_dollars: [['0.40', '10']] } } });
  const tr = X.createSizeTracker({ store, http, now: () => t });
  const r = await tr.scan({ games: bare, pinGames: [pg], kalshiRows: [krow, kteam] });
  assert.equal(r.read, 1);
  assert.equal(tr.state.byVenue.kalshi.sides, 4);
  assert.equal(tr.state.byVenue.kalshi.mainAtFlag, 1);
  const bets = await tr.list();
  // $50 fills at 47c + fee (+5.0%); $200 and $1,000 run into 50c: under +1%
  assert.deepEqual(bets.map(b => b.tier), [50]);
  const b = bets[0];
  assert.equal(b.venue, 'kalshi');
  assert.equal(b.side, 'Over');
  assert.ok(b.ev >= 0.01);
  assert.equal(b.status, 'open');
  // the next minute Pinnacle moves to 53% over: the bet keeps its first fill, its fair follows
  t += 60e3;
  const pg2 = { ...pg, totals: [{ line: 41.5, pOver: 0.53, alt: false, limit: 2000 }] };
  await tr.scan({ games: bare, pinGames: [pg2], kalshiRows: [krow, kteam] });
  const again = (await tr.list())[0];
  assert.equal(again.cost, b.cost);
  assert.equal(again.fairLast, 0.53);
  assert.equal(again.flagReads, 2);
  // after the start: closed at 53%
  t = Date.parse(START) + 60e3;
  await tr.scan({ games: {}, pinGames: [], kalshiRows: [] });
  const closed = (await tr.list())[0];
  assert.equal(closed.status, 'closed');
  assert.equal(closed.closeFair, 0.53);
  assert.ok(Math.abs(closed.clv - (0.53 / closed.cost - 1)) < 1e-4);
});

test('scan: a close read more than 20 minutes before the start is no close', async () => {
  let t = Date.parse(START) - 60 * 60e3;
  const store = createMemoryStore();
  const http = fakeHttp({ 'KXNFLTOTAL-26OCT25PITNO-41/orderbook': { orderbook_fp: { no_dollars: [['0.53', '5000']] } } });
  const tr = X.createSizeTracker({ store, http, now: () => t });
  await tr.scan({ games: bare, pinGames: [pg], kalshiRows: [krow, kteam] });
  assert.equal((await tr.list()).length, 3, 'all three tiers fill at 47c');
  t = Date.parse(START) + 60e3;
  await tr.scan({ games: {}, pinGames: [], kalshiRows: [] });
  for (const b of await tr.list()) { assert.equal(b.clv, null); assert.equal(b.closeMissing, true); }
});

test('results from the final; summary per venue and tier with the pre-registered verdict', async () => {
  const store = createMemoryStore();
  const tr = X.createSizeTracker({ store, http: fakeHttp({}), now: () => Date.parse(START) + 5 * 3600e3 });
  await store.put({ id: 'a', sideKey: 'k', venue: 'kalshi', tier: 50, sport: 'nfl', event: 'Pittsburgh Steelers @ New Orleans Saints', start: START,
    market: 'totals', side: 'Over', point: 41.5, cost: 0.4875, ev: 0.025, closeFair: 0.53, clv: 0.087, status: 'closed', alt: false, minsBefore: 300,
    flaggedAt: START, lastFlagAt: START });
  const grader = { gradeGame: async ({ league, home, away }) => (league === 'NFL' && home === 'New Orleans Saints' && away === 'Pittsburgh Steelers' ? { home: 24, away: 20 } : null) };
  const g = await tr.gradeResults(grader, s => (s === 'nfl' ? 'NFL' : null));
  assert.equal(g.graded, 1);
  const b = (await tr.list())[0];
  assert.equal(b.outcome, 'win');
  assert.ok(Math.abs(b.profit - (1 / 0.4875 - 1)) < 1e-3);
  const s = X.summarize(await tr.list());
  assert.equal(s.kinds[0].key, 'kalshi|50');
  assert.equal(s.kinds[0].graded, 1);
  assert.equal(s.kinds[0].verdict, 'lead');
  assert.equal(s.byStart[0].key, 'kalshi|50|2-6h');
});

test('verdict at 50: positive CLV with t ≥ 2 passes the record; CLV ≤ 0 fails', () => {
  const mk = (i, clv) => ({ id: `${i}`, venue: 'gemini', tier: 200, sport: 'nfl', market: 'h2h', alt: false, ev: 0.02, cost: 0.5, closeFair: 0.5 * (1 + clv), clv, status: 'closed',
    flaggedAt: START, lastFlagAt: START, minsBefore: 60 });
  const good = Array.from({ length: 50 }, (_, i) => mk(i, 0.02 + (i % 5) * 0.004));
  assert.equal(X.summarize(good).kinds[0].verdict, 'passes the record');
  const bad = Array.from({ length: 50 }, (_, i) => mk(i, -0.01 + (i % 3) * 0.002));
  assert.equal(X.summarize(bad).kinds[0].verdict, 'fail');
  const alt = X.summarize([{ ...mk(1, 0.05), alt: true }]);
  assert.equal(alt.kinds.length, 0);
  assert.equal(alt.alt[0].key, 'gemini|200');
});
