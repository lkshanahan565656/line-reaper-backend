const test = require('node:test');
const assert = require('node:assert/strict');
const B = require('../bigmoney');
const R = require('../results');
const { canonMarket } = require('../ev');
const { parseRung } = require('../kprops');
const { createMemoryStore } = require('../evtrack');

const NOW = Date.parse('2026-10-18T15:00:00Z');
const START = '2026-10-18T17:00:00Z';

test('normPrint: the side the taker backed and its price, from either exchange', () => {
  // Kalshi: a NO sweep at 44c a YES (56c the NO)
  const k = B.normPrint({ key: 'kalshi|T|no|t', exchange: 'kalshi', market: 'T', dir: 'no', yesPrice: 0.44, price: 0.56, notional: 2240, at: NOW - 60e3, nFills: 3 });
  assert.equal(k.yes, false);
  assert.equal(k.price, 0.56);
  assert.equal(k.usd, 2240);
  assert.equal(k.fills, 3);
  // Polymarket: selling outcome 1 at 40c backs outcome 0 at 60c
  const p = B.normPrint({ key: 'pm|x', exchange: 'polymarket', market: '0xc', dir: 'yes', yesPrice: 0.6, price: 0.4, side: 'SELL', notional: 1200, at: NOW, wallet: '0xw', outcomeIndex: 1, conditionId: '0xc' });
  assert.equal(p.yes, true);
  assert.equal(p.price, 0.6);
  assert.equal(p.wallet, '0xw');
  assert.equal(B.normPrint({ exchange: 'kalshi', market: 'T', dir: null, notional: 5, at: NOW }), null);
});

test('american: a chance as American odds', () => {
  assert.equal(B.american(0.5556), -125);
  assert.equal(B.american(0.4), 150);
  assert.equal(B.american(1), null);
});

// Pinnacle's game, the Kalshi rows that ask about it, and FanDuel's prices
const PIN = { id: 99, sport: 'football', league: 'NFL', home: 'New York Jets', away: 'Cleveland Browns', start: START,
  ml: { home: 0.55, away: 0.45, vig: 0.03 }, spreads: [{ home: -1.5, pHome: 0.52, alt: false }, { home: -3.5, pHome: 0.4, alt: true }], totals: [{ line: 41.5, pOver: 0.48, alt: false }] };
const krow = o => ({ exchange: 'kalshi', id: 'KXNFLGAME-26OCT18CLENYJ-NYJ', kind: 'teams', outcomeLabel: 'New York J', noLabel: 'Cleveland', yesAsk: 0.56, noAsk: 0.46, tradable: true, url: 'https://kalshi.com/markets/kxnflgame-26oct18clenyj', ...o });
const FD = { id: 'pin-99', sport_key: 'nfl', commence_time: START, home_team: 'New York Jets', away_team: 'Cleveland Browns', bookmakers: [
  { key: 'pinnacle', markets: [] },
  { key: 'fanduel', title: 'FanDuel', markets: [
    { key: 'h2h', outcomes: [{ name: 'New York Jets', price: -110 }, { name: 'Cleveland Browns', price: -110 }] },
    { key: 'spreads', outcomes: [{ name: 'New York Jets', price: -105, point: -1.5 }, { name: 'Cleveland Browns', price: -115, point: 1.5 }] },
    { key: 'totals', outcomes: [{ name: 'Over', price: -108, point: 41.5 }, { name: 'Under', price: -112, point: 41.5 }] },
  ] },
] };

test('rowBets: an exchange row as bet keys on Pinnacle\'s game', () => {
  assert.deepEqual(B.rowBets(krow(), PIN), { yes: '99|ml|home', no: '99|ml|away' });
  assert.deepEqual(B.rowBets(krow({ kind: 'total', line: 41.5 }), PIN), { yes: '99|total|41.5|over', no: '99|total|41.5|under' });
  // "Cleveland wins by more than 1.5": the away side giving 1.5, so home +1.5
  assert.deepEqual(B.rowBets(krow({ kind: 'spread', line: 1.5, lineTeam: 'Cleveland' }), PIN), { yes: '99|spread|1.5|away', no: '99|spread|1.5|home' });
  assert.deepEqual(B.rowBets(krow({ kind: 'spread', line: 1.5, lineTeam: 'New York J' }), PIN), { yes: '99|spread|-1.5|home', no: '99|spread|-1.5|away' });
  assert.equal(B.betLabel('99|spread|-1.5|away', PIN), 'Cleveland Browns +1.5');
  assert.equal(B.betLabel('99|ml|home', PIN), 'New York Jets to win');
  assert.equal(B.pinFair(PIN, '99|spread|-1.5|away'), 0.48);
  assert.equal(B.pinFair(PIN, '99|total|41.5|under'), 0.52);
});

test('gameIndex: the exchanges\' asks and the books\' prices land on the same bet', () => {
  const rows = [krow(), krow({ id: 'KXNFLTOTAL-26OCT18CLENYJ-41', kind: 'total', line: 41.5, outcomeLabel: 'Over', yesAsk: 0.5, noAsk: 0.52 })];
  const idx = B.gameIndex(rows.map(row => ({ row, game: PIN })), { nfl: [FD] });
  const ml = idx.bets.get('99|ml|home');
  assert.equal(ml.label, 'New York Jets to win');
  assert.equal(ml.pin, 0.55);
  const kal = ml.venues.find(v => v.venue === 'kalshi');
  assert.equal(kal.price, 0.56);
  assert.equal(kal.implied, 0.5773);   // 56c + $1.73 fee on 100 contracts
  const fd = ml.venues.find(v => v.venue === 'fanduel');
  assert.equal(fd.american, -110);
  assert.equal(fd.decimal, 1.9091);
  assert.ok(idx.bets.get('99|total|41.5|under').venues.some(v => v.venue === 'fanduel' && v.american === -112));
  assert.ok(idx.bets.get('99|ml|away').venues.some(v => v.venue === 'fanduel'));
  // Cleveland's own contract asks the same bet as NO on the Jets: one Kalshi price, the cheaper
  const two = B.gameIndex([...rows, krow({ id: 'KXNFLGAME-26OCT18CLENYJ-CLE', outcomeLabel: 'Cleveland', noLabel: 'New York J', yesAsk: 0.44, noAsk: 0.58 })].map(row => ({ row, game: PIN })), {});
  const away = two.bets.get('99|ml|away').venues.filter(v => v.venue === 'kalshi');
  assert.equal(away.length, 1);
  assert.equal(away[0].price, 0.44);
  assert.equal(idx.rows.get('kalshi:KXNFLGAME-26OCT18CLENYJ-NYJ').league, 'nfl');
});

test('rungIndex: a Kalshi rung is the over of strike − 0.5', () => {
  const ev = { event_ticker: 'KXNFLRECYDS-26OCT18CLENYJ', markets: [{ ticker: 'KXNFLRECYDS-26OCT18CLENYJ-GWILSON-50', strike_type: 'greater', floor_strike: 49.5,
    title: 'Garrett Wilson: 50+ receiving yards', expected_expiration_time: '2026-10-18T20:00:00Z', yes_bid_dollars: '0.55', yes_ask_dollars: '0.57' }] };
  const idx = B.rungIndex([{ ev, league: 'NFL' }], { canonMarket, parseRung });
  const r = idx.get('KXNFLRECYDS-26OCT18CLENYJ-GWILSON-50');
  assert.equal(r.line, 49.5);
  assert.equal(r.player, 'Garrett Wilson');
  assert.equal(r.start, '2026-10-18T17:00:00.000Z');
  assert.equal(r.mkey, canonMarket('receiving yards'));
  // a whole-number floor means the same half line
  ev.markets[0].floor_strike = 50;
  assert.equal(B.rungIndex([{ ev, league: 'NFL' }], { canonMarket, parseRung }).get('KXNFLRECYDS-26OCT18CLENYJ-GWILSON-50').line, 49.5);
});

test('propVenues: same line priced at the money\'s chance, another line moved along the curve', () => {
  const mkey = canonMarket('receptions');
  const board = { books: {
    prizepicks: { line: 4.5, over: null, under: null, overOpen: true, underOpen: true },
    underdog: { line: 5.5, over: 1, under: 1, overOpen: true, underOpen: true },
  } };
  const dfsEv = (p, book, mult) => (p * 1.78 * (mult || 1) - 1) * 100;
  const books = [{ book: 'fanduel', line: 4.5, over: -115, under: -105 }];
  const v = B.propVenues({ sport: 'NFL', mkey, line: 4.5, side: 'Over', fair: 0.6 }, { board, books, dfsEv });
  const pp = v.find(x => x.venue === 'prizepicks');
  assert.equal(pp.sameLine, true);
  assert.equal(pp.entry, '3-pick power');
  assert.ok(Math.abs(pp.ev - (0.6 / pp.implied - 1) * 100) < 0.01);
  const fd = v.find(x => x.venue === 'fanduel');
  assert.equal(fd.american, -115);
  assert.ok(Math.abs(fd.ev - (0.6 * (1 + 100 / 115) - 1) * 100) < 0.01);
  // Underdog at 5.5: a harder over, so its fair is below the money's 60%
  const ud = v.find(x => x.venue === 'underdog');
  assert.equal(ud.sameLine, false);
  assert.ok(ud.fair < 0.6);
  // the break-even solved from the app's own pricing
  assert.ok(Math.abs(ud.implied - 1 / 1.78) < 0.002);
});

test('flowOf: one-way money is a bettor; money on both sides is a market maker', () => {
  const money = { exchange: 'kalshi', market: 'T', yes: true, firstAt: NOW - 10 * 60e3, lastAt: NOW, wallets: [] };
  const p = (yes, usd, at = NOW - 5 * 60e3, o = {}) => ({ exchange: 'kalshi', market: 'T', yes, usd, at, ...o });
  assert.deepEqual(B.flowOf(money, { market: [p(true, 2000), p(false, 300)] }), { flow: 'bettor', why: [] });
  const two = B.flowOf(money, { market: [p(true, 2000), p(false, 900)] });
  assert.equal(two.flow, 'market maker');
  assert.match(two.why[0], /two-way: \$900/);
  // money on the other side long before the window doesn't count, nor a block trade
  assert.equal(B.flowOf(money, { market: [p(true, 2000), p(false, 5000, NOW - 3 * 3600e3), p(false, 5000, NOW, { block: true })] }).flow, 'bettor');
  // the same player's other rungs taking the under
  const hedge = B.flowOf(money, { market: [p(true, 2000)], ladder: [{ exchange: 'kalshi', market: 'T2', yes: false, usd: 1500, at: NOW - 60e3 }], side: 'Over' });
  assert.match(hedge.why[0], /hedge/);
  // a Polymarket wallet Sharp Tail marks a market maker
  const mm = B.flowOf({ ...money, wallets: ['0xm'] }, { market: [p(true, 2000)], isMaker: w => w === '0xm' });
  assert.equal(mm.flow, 'market maker');
});

test('groupMoney: big pregame prints summed per bet, volume-weighted price', () => {
  const store = [
    { key: 'a', exchange: 'kalshi', market: 'T', yes: true, price: 0.55, usd: 1100, at: NOW - 20 * 60e3 },
    { key: 'b', exchange: 'kalshi', market: 'T', yes: true, price: 0.6, usd: 3000, at: NOW - 5 * 60e3 },
    { key: 'c', exchange: 'kalshi', market: 'T', yes: true, price: 0.6, usd: 400, at: NOW - 4 * 60e3 },   // under minUsd
    { key: 'd', exchange: 'kalshi', market: 'T', yes: true, price: 0.6, usd: 9000, at: NOW, block: true },
    { key: 'e', exchange: 'kalshi', market: 'LIVE', yes: true, price: 0.6, usd: 9000, at: NOW },
  ];
  const resolve = p => (p.market === 'T' ? { betKey: 'k', kind: 'game', start: START } : { betKey: 'live', kind: 'game', start: '2026-10-18T14:00:00Z' });
  const g = B.groupMoney(store, resolve, { now: NOW });
  assert.equal(g.length, 1);
  assert.equal(g[0].money.usd, 4100);
  assert.equal(g[0].prints, 2);
  // 4,100 / (1100/.55 + 3000/.6) = 0.5857
  assert.equal(g[0].money.price, 0.5857);
  assert.equal(g[0].money.biggest.usd, 3000);
});

test('pickBest: an app or a book at the same line, never the exchange itself', () => {
  const best = B.pickBest([
    { venue: 'kalshi', ev: 9, sameLine: true },
    { venue: 'underdog', ev: 8, sameLine: false },
    { venue: 'fanduel', ev: 3, sameLine: true },
    { venue: 'prizepicks', ev: 60, sameLine: true },   // past maxEv: not the same bet
  ]);
  assert.equal(best.venue, 'fanduel');
});

test('gameOutcome: a final score settles every kind of bet', () => {
  const sc = { home: 24, away: 20 };
  assert.equal(B.gameOutcome('9|ml|home', sc).outcome, 'win');
  assert.equal(B.gameOutcome('9|ml|away', sc).outcome, 'loss');
  assert.equal(B.gameOutcome('9|spread|-3.5|home', sc).outcome, 'win');
  assert.equal(B.gameOutcome('9|spread|-4.5|home', sc).outcome, 'loss');
  assert.equal(B.gameOutcome('9|spread|-4.5|away', sc).outcome, 'win');
  assert.equal(B.gameOutcome('9|total|44|over', sc).outcome, 'push');
  assert.equal(B.gameOutcome('9|total|43.5|under', sc).outcome, 'loss');
});

test('tracker: logged once, checked two minutes on, closed at the start, graded', async () => {
  let t = NOW;
  const graded = [];
  const tr = B.createBigMoneyTracker({ store: createMemoryStore(), now: () => t, log: { warn: () => {} },
    propGrader: { grade: async pick => { graded.push(pick); return { result: 6, outcome: 'win' }; } } });
  const play = { betKey: 'prop|NFL|garrettwilson|receptions|4.5|Over', kind: 'prop', sport: 'NFL', title: 'Garrett Wilson Over 4.5 receptions', side: 'Over', start: START, line: 4.5,
    money: { exchange: 'kalshi', market: 'T', yes: true, usd: 2500, price: 0.6 }, pinFair: 0.58, flow: 'bettor', why: [], minEv: 2,
    prop: { sport: 'NFL', player: 'Garrett Wilson', mkey: 'receptions', startTime: START },
    best: { venue: 'prizepicks', line: 4.5, sameLine: true, decimal: 1.8172, implied: 0.5503, ev: 9.03, fair: 0.6, entry: '3-pick power' } };
  assert.equal((await tr.record([play])).length, 1);
  assert.equal((await tr.record([play])).length, 0);   // once per bet and venue
  assert.equal((await tr.record([{ ...play, betKey: 'x', best: { ...play.best, ev: 1 } }])).length, 0);   // under minEv
  t += 3 * 60e3;
  await tr.mark(() => ({ venue: { line: 4.5, decimal: 1.8172 }, close: 0.62, sharp: 0.59 }));
  let [r] = await tr.list();
  assert.equal(r.execOk, true);
  assert.equal(r.closeEv, +((0.62 * 1.8172 - 1) * 100).toFixed(2));
  t = Date.parse(START) + 4 * 3600e3;
  await tr.mark(() => null);
  assert.equal((await tr.list())[0].status, 'locked');
  await tr.grade();
  [r] = await tr.list();
  assert.equal(r.status, 'graded');
  assert.equal(r.profit, 0.8172);
  assert.equal(graded[0].signalLine, 4.5);
  const s = await tr.summary();
  assert.equal(s.overall.wins, 1);
  assert.equal(s.byFlow.bettor.graded, 1);
  // Results reads the record as its own source
  const board = R.scoreboard({ bigMoney: await tr.list() });
  assert.equal(board.sources.bigMoney.overall.graded, 1);
  assert.ok(board.plays.some(p => p.source === 'bigMoney' && p.play === 'all'));
});
