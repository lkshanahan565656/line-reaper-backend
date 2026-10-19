const test = require('node:test');
const assert = require('node:assert/strict');
const venues = require('../venues');
const gb = require('../geminibooks');
const freebooks = require('../freebooks');
const ev = require('../ev');
const bestplays = require('../bestplays');
const closeBoard = require('../closeboard');

test('Texas allows the pick\'em apps and the exchanges, never a sportsbook', () => {
  const tx = venues.legalIn('tx');
  for (const v of ['prizepicks', 'PP', 'UD', 'sleeper', 'DK Pick6', 'pick6', 'Kalshi', 'kalshi_mid', 'Polymarket US', 'polymarketus', 'gemini', 'Gemini'])
    assert.equal(tx(v), true, v);
  for (const v of ['fanduel', 'BetRivers', 'draftkings', 'Hard Rock', 'pinnacle', 'Polymarket', 'matchbook', 'bovada', '', null, 'somebook'])
    assert.equal(tx(v), false, String(v));
  // a two-venue arb needs both venues legal
  assert.equal(tx('Kalshi + Polymarket US'), true);
  assert.equal(tx('Kalshi + Polymarket'), false);
});

test('no state, or one without a list, passes everything', () => {
  assert.equal(venues.legalIn()('fanduel'), true);
  assert.equal(venues.legalIn('')('betrivers'), true);
  assert.equal(venues.legalIn('ZZ')('betrivers'), true);
  assert.equal(venues.stateInfo('zz'), null);
  const info = venues.stateInfo('TX');
  assert.equal(info.state, 'TX');
  assert.ok(info.venues.some(v => v.key === 'betr' && !v.read && v.why));
  assert.ok(info.venues.some(v => v.key === 'gemini' && v.read));
});

test('record rows find their venue whichever field holds it', () => {
  const tx = venues.rowLegalIn('TX');
  assert.equal(tx({ book: 'prizepicks' }), true);
  assert.equal(tx({ venue: 'kalshi' }), true);
  assert.equal(tx({ app: 'UD' }), true);
  assert.equal(tx({ signalBook: 'P6' }), true);
  assert.equal(tx({ book: 'betrivers' }), false);
  assert.equal(closeBoard.propsVenue({ signalBook: 'PP' }), 'prizepicks');
});

// ── Gemini ──
const START = '2026-10-20T00:15:00.000Z';
const NOW = Date.parse('2026-10-19T18:00:00Z');
const px = (yes, no) => ({ buy: { yes: String(yes), no: String(no) } });
const participants = [{ name: 'San Francisco 49ers', side: 'home' }, { name: 'Washington Commanders', side: 'away' }];
const payload = { data: [
  { id: '1', ticker: 'NFL-2610200015-WAS-SF-M', title: 'Washington vs San Francisco', status: 'active', startTime: START, gameId: 'g1', participants,
    sportsMarket: { scope: { type: 'full_contest' } },
    contracts: [{ label: 'San Francisco', sportsSide: 'home', marketState: 'open', prices: px(0.79, 0.22) },
      { label: 'Washington', sportsSide: 'away', marketState: 'open', prices: px(0.22, 0.79) }],
    events: [{ id: '2', ticker: 'NFL-2610200015-WAS-SF-S', title: 'Washington vs San Francisco: Point Spread', status: 'active', startTime: START, gameId: 'g1', participants,
      contracts: [{ label: 'San Francisco wins by more than 6.5 points', strike: { type: 'spread', value: '6.5' }, prices: px(0.55, 0.48) },
        { label: 'Washington wins by more than 1.5 points', strike: { type: 'spread', value: '1.5' }, prices: px(0.2, 0.83) },
        { label: 'San Francisco wins by more than 3.5 points', strike: { type: 'spread', value: '3.5' }, prices: px(0.67, 0.36) }] }] },
  { id: '3', ticker: 'NFL-2610200015-WAS-SF-T', title: 'Washington vs San Francisco: Total Points', status: 'active', startTime: START, gameId: 'g1', participants,
    contracts: [{ label: 'More than 44.5 points scored', strike: { type: 'over', value: '44.5' }, prices: px(0.5, 0.53) },
      { label: 'More than 47.5 points scored', strike: { type: 'over', value: '47.5' }, prices: px(0.4, 0.63) }] },
  // started already, a three-way soccer result and a quarter line: all left out
  { id: '4', ticker: 'NFL-2610191700-BAL-CLE-M', status: 'active', startTime: '2026-10-19T17:00:00Z', participants, contracts: [] },
  { id: '5', ticker: 'EPL-2610201900-ARS-CHE-M', status: 'active', startTime: START, participants, contracts: [] },
  { id: '6', ticker: 'NFL-2610200015-WAS-SF-1QM', status: 'active', startTime: START, participants, contracts: [] },
] };

test('the fee is 7% of p(1-p) a contract, and the price is the cost with it', () => {
  assert.equal(+gb.costOf(0.5).toFixed(4), 0.5175);
  assert.equal(gb.american(gb.costOf(0.5)), -107);
  assert.equal(gb.american(gb.costOf(0.22)), 331);   // 0.22 + 0.012 = 0.232
});

test('Gemini games parse: moneyline, spread rungs both ways, totals; started and three-way skipped', () => {
  const out = gb.parseGemini(payload, { now: NOW });
  assert.equal(out.nfl.length, 1);
  const g = out.nfl[0];
  assert.equal(g.book, 'gemini');
  assert.equal(g.home, 'San Francisco 49ers');
  assert.deepEqual(g.h2h.map(o => o.name), ['San Francisco 49ers', 'Washington Commanders']);
  assert.equal(g.h2h[0].price, gb.american(gb.costOf(0.79)));
  // SF -6.5 is YES; Washington +6.5 is NO of the same contract
  assert.deepEqual(g.spreads.filter(o => Math.abs(o.point) === 6.5), [
    { name: 'San Francisco 49ers', price: gb.american(gb.costOf(0.55)), point: -6.5 },
    { name: 'Washington Commanders', price: gb.american(gb.costOf(0.48)), point: 6.5 }]);
  // the away team giving points
  assert.deepEqual(g.spreads.filter(o => Math.abs(o.point) === 1.5).map(o => [o.name, o.point]), [['Washington Commanders', -1.5], ['San Francisco 49ers', 1.5]]);
  assert.deepEqual(g.totals.slice(0, 2), [{ name: 'Over', price: gb.american(gb.costOf(0.5)), point: 44.5 }, { name: 'Under', price: gb.american(gb.costOf(0.53)), point: 44.5 }]);
  assert.equal(out.nfl.length + out.nba.length + out.nhl.length, 1);
});

const pinGame = { id: 77, sport: 'football', league: 'NFL', home: 'San Francisco 49ers', away: 'Washington Commanders', start: START,
  ml: { home: 0.78, away: 0.22, raw: [-380, 300] },
  spreads: [{ home: -6.5, pHome: 0.52, alt: false, raw: [-104, -116] }, { home: -3.5, pHome: 0.66, alt: true, raw: [-200, 160] }],
  totals: [{ line: 44.5, pOver: 0.5, alt: false, raw: [-108, -112] }, { line: 47.5, pOver: 0.4, alt: true, raw: [140, -170] }] };

test('only rungs at Pinnacle\'s main number stay; the moneyline always does', () => {
  const books = gb.parseGemini(payload, { now: NOW }).nfl;
  const merged = { nfl: freebooks.mergeGames('nfl', [pinGame], books) };
  const cut = gb.mainLinesOnly(merged, [pinGame]).nfl[0];
  const bm = cut.bookmakers.find(b => b.key === 'gemini');
  const m = k => bm.markets.find(x => x.key === k);
  assert.equal(m('h2h').outcomes.length, 2);
  assert.deepEqual(m('spreads').outcomes.map(o => o.point), [-6.5, 6.5]);   // -3.5 is Pinnacle's alternate, 1.5 Pinnacle doesn't price
  assert.deepEqual(m('totals').outcomes.map(o => o.point), [44.5, 44.5]);
  // and the screen prices them against Pinnacle's no-vig like any book
  const rows = ev.screen({ feeds: [{ sport: 'nfl', label: 'free-odds', games: [cut] }], minEv: -100 });
  const gem = rows.filter(r => r.book === 'gemini');
  assert.ok(gem.length >= 4);
  assert.ok(gem.every(r => r.source === 'sharp' && (r.sharpBooks || []).includes('pinnacle')));
});

test('a game Pinnacle doesn\'t list keeps no Gemini lines', () => {
  const books = gb.parseGemini(payload, { now: NOW }).nfl;
  const other = { ...pinGame, id: 78, home: 'Dallas Cowboys', away: 'New York Giants' };
  const merged = { nfl: freebooks.mergeGames('nfl', [other], books) };
  assert.equal(merged.nfl[0].bookmakers.some(b => b.key === 'gemini'), false);
});

test('Best Plays keeps only the venues a state allows', () => {
  const arb = (id, venues2) => ({ id, title: id, profitPct: 2, totalCost: 0.98, legs: venues2.map(v => ({ venue: v, pick: 'Yes' })) });
  const arbs = [arb('a', ['kalshi', 'polymarketus']), arb('b', ['kalshi', 'polymarket']), arb('c', ['kalshi', 'fanduel'])];
  const all = bestplays.bestPlays({ arbs });
  const tx = bestplays.bestPlays({ arbs }, { venueOk: venues.legalIn('TX') });
  assert.equal(all.total, 3);
  assert.deepEqual(tx.rows.map(r => r.venue), ['Kalshi + Polymarket US']);
  assert.equal(tx.outOfState, 2);
  assert.equal(tx.counts.arb, 1);
});

test('the props record keeps its apps when a state is picked', () => {
  const tx = venues.legalIn('TX');
  const props = [{ signalBook: 'PP' }, { book: 'underdog' }, { signalBook: 'P6' }, { book: 'fanduel' }];
  assert.deepEqual(props.filter(r => tx(closeBoard.propsVenue(r))).length, 3);
  // a row predicate given a venue string finds nothing: the 3.144.0 bug
  assert.equal(venues.rowLegalIn('TX')('prizepicks'), false);
});
