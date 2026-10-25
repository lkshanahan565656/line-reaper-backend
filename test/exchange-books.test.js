// Gemini and Polymarket US as books (10-24): every league Pinnacle prices,
// Pinnacle's own close on each row, and results from ESPN finals.
const test = require('node:test');
const assert = require('node:assert/strict');
const gb = require('../geminibooks');
const pb = require('../pmusbooks');
const freebooks = require('../freebooks');
const pingames = require('../pingames');
const ev = require('../ev');
const evtrack = require('../evtrack');
const closeBoard = require('../closeboard');
const results = require('../results');

const NOW = Date.parse('2026-10-24T17:00:00Z');
const START = '2026-10-24T21:30:00.000Z';
const px = (yes, no) => ({ buy: { yes: String(yes), no: String(no) } });

// ── Gemini: soccer and UFC, as the live feed listed them 10-24 ──
const mlsParts = [{ name: 'New York Red Bulls', side: 'home' }, { name: 'Inter Miami CF', side: 'away' }];
const reg = { scope: { type: 'regulation' } };
const gemPayload = { data: [
  { id: '10', ticker: 'MLS-2610242130-MIA-NYRB-M', title: 'Miami vs New York', status: 'active', startTime: START, gameId: 'sr:1', participants: mlsParts, sportsMarket: reg,
    contracts: [{ label: 'Miami', sportsSide: 'away', marketState: 'open', prices: px(0.53, 0.48) },
      { label: 'New York', sportsSide: 'home', marketState: 'open', prices: px(0.27, 0.74) },
      { label: 'Tie', sportsSide: 'tie', marketState: 'open', prices: px(0.22, 0.79) }] },
  { id: '11', ticker: 'MLS-2610242130-MIA-NYRB-REGS', title: 'Miami vs New York: Point Spread', status: 'active', startTime: START, gameId: 'sr:1', participants: mlsParts, sportsMarket: reg,
    contracts: [{ label: 'Reg Time: Miami wins by more than 1.5 goals', strike: { type: 'spread', value: '1.5' }, prices: px(0.32, 0.7) }] },
  { id: '12', ticker: 'MLS-2610242130-MIA-NYRB-REGT', title: 'Miami vs New York: Total Goals', status: 'active', startTime: START, gameId: 'sr:1', participants: mlsParts, sportsMarket: reg,
    contracts: [{ label: 'Reg Time: More than 2.5 goals scored', strike: { type: 'over', value: '2.5' }, prices: px(0.6, 0.42) }] },
  { id: '13', ticker: 'UFC-VOL-EVL-20261024', title: 'Volkanovski vs Evloev', status: 'active', startTime: '2026-10-24T19:30:00.000Z', gameId: 'sr:2', participants: [],
    sportsMarket: { sport: 'mixed_martial_arts', type: 'moneyline', scope: { type: 'full_contest' } }, category: 'Sports',
    contracts: [{ label: 'Alex Volkanovski', prices: px(0.51, 0.5) }, { label: 'Movsar Evloev', prices: px(0.5, 0.51) }] },
  // an NFL season-wins market and golf: not games, counted as skipped
  { id: '14', ticker: 'NFLDALWINS26', status: 'active', startTime: START, category: 'Sports', contracts: [] },
  // a soccer total that isn't regulation time: left out
  { id: '15', ticker: 'MLS-2610242130-MIA-NYRB-T', status: 'active', startTime: START, gameId: 'sr:1', participants: mlsParts, sportsMarket: { scope: { type: 'full_contest' } },
    contracts: [{ label: 'More than 3.5 goals scored', strike: { type: 'over', value: '3.5' }, prices: px(0.3, 0.72) }] },
] };

test('Gemini soccer: three-way result on each YES, regulation spreads and totals', () => {
  const skipped = {};
  const out = gb.parseGemini(gemPayload, { now: NOW, skipped });
  assert.equal(out.mls.length, 1);
  const g = out.mls[0];
  assert.deepEqual(g.h2h.map(o => o.name), ['New York Red Bulls', 'Inter Miami CF', 'Draw']);
  assert.deepEqual(g.h2h.map(o => o.price), [0.27, 0.53, 0.22].map(p => gb.american(gb.costOf(p))));
  // "Reg Time: Miami wins by more than 1.5": YES Miami -1.5, NO New York +1.5
  assert.deepEqual(g.spreads, [{ name: 'Inter Miami CF', price: gb.american(gb.costOf(0.32)), point: -1.5 }, { name: 'New York Red Bulls', price: gb.american(gb.costOf(0.7)), point: 1.5 }]);
  assert.deepEqual(g.totals.map(o => [o.name, o.point]), [['Over', 2.5], ['Under', 2.5]]);
  assert.deepEqual(skipped, { NFLDALWINS26: 1 });
});

test('Gemini UFC: a contract per fighter, each fighter on his own YES', () => {
  const g = gb.parseGemini(gemPayload, { now: NOW }).ufc[0];
  assert.equal(g.away, 'Alex Volkanovski');
  assert.equal(g.home, 'Movsar Evloev');
  assert.deepEqual(g.h2h, [{ name: 'Movsar Evloev', price: gb.american(gb.costOf(0.5)) }, { name: 'Alex Volkanovski', price: gb.american(gb.costOf(0.51)) }]);
});

test('Gemini asks for soccer and fights in their own queries', () => {
  const urls = gb.QUERIES.map(q => gb.eventUrl(q));
  assert.ok(urls.some(u => /sport=soccer/.test(u) && /sports_market_scope=regulation/.test(u)));
  assert.ok(urls.some(u => /sport=mixed_martial_arts/.test(u) && /sports_market_type=moneyline/.test(u) && !/type=spread/.test(u)));
});

// ── Polymarket US ──
const usd = v => ({ value: v, currency: 'USD' });
const side = (long, name, ordering, extra = {}) => ({ long, description: name, team: { name, ordering }, ...extra });
const nflEvent = (o = {}) => ({
  slug: 'nfl-pit-no-2026-10-25', title: 'PIT Steelers vs. NO Saints', startTime: '2026-10-25T17:00:00Z', active: true, closed: false,
  markets: [{ slug: 'aec-nfl-pit-no-2026-10-25', sportsMarketType: 'football_team_full_game_winner', status: 'MARKET_STATUS_OPEN', active: true, closed: false,
    feeCoefficient: 0.0695, bestBidQuote: usd('0.6050'), bestAskQuote: usd('0.6075'),
    marketSides: [side(true, 'Pittsburgh Steelers', 'away'), side(false, 'New Orleans Saints', 'home')] }], ...o });
const spread = (line, bid, ask) => ({ slug: `asc-${line}`, sportsMarketType: 'football_team_full_game_spread', line, status: 'MARKET_STATUS_OPEN', active: true, closed: false,
  bestBidQuote: usd(bid), bestAskQuote: usd(ask), marketSides: [side(true, 'Pittsburgh Steelers', 'away'), side(false, 'New Orleans Saints', 'home')] });
const noRef = os => os.map(({ ref, ...o }) => o);
const total = (line, bid, ask, type = 'football_team_full_game_total') => ({ slug: `tsc-${line}-${type}`, sportsMarketType: type, line, status: 'MARKET_STATUS_OPEN', active: true, closed: false,
  bestBidQuote: usd(bid), bestAskQuote: usd(ask), marketSides: [{ long: true, description: 'Over' }, { long: false, description: 'Under' }] });

test('Polymarket US moneyline: long at the ask, short at 1 − the bid, fee in; home from the teams\' ordering', () => {
  const g = pb.gameOf(nflEvent(), { league: 'nfl', now: NOW });
  assert.equal(g.book, 'polymarketus');
  assert.equal(g.sport, 'nfl');
  assert.equal(g.home, 'New Orleans Saints');
  assert.equal(g.away, 'Pittsburgh Steelers');
  assert.deepEqual(noRef(g.h2h), [{ name: 'Pittsburgh Steelers', price: pb.priceOf(0.6075, 0.0695) }, { name: 'New Orleans Saints', price: pb.priceOf(0.395, 0.0695) }]);
  // each side names its market, so the size check can read the book
  assert.deepEqual(g.h2h.map(o => o.ref?.buy), ['long', 'short']);
  assert.equal(g.h2h[0].ref.venue, 'polymarketus');
  // 0.6075 + 0.0695 × 0.6075 × 0.3925 = 0.6241 → −166
  assert.equal(pb.priceOf(0.6075, 0.0695), -166);
});

test('Polymarket US slug page: spreads signed from the long team, game totals, never a team total', () => {
  const e = nflEvent();
  e.markets.push(spread(-2.5, '0.5000', '0.5100'), total(41.5, '0.4800', '0.5000'), total(20.5, '0.5', '0.52', 'football_team_points_full_game_total'));
  const g = pb.gameOf({ event: e }, { league: 'nfl', now: NOW });
  assert.deepEqual(noRef(g.spreads), [{ name: 'Pittsburgh Steelers', price: pb.priceOf(0.51), point: -2.5 }, { name: 'New Orleans Saints', price: pb.priceOf(0.5), point: 2.5 }]);
  assert.deepEqual(noRef(g.totals), [{ name: 'Over', price: pb.priceOf(0.5), point: 41.5 }, { name: 'Under', price: pb.priceOf(0.52), point: 41.5 }]);
  assert.deepEqual(g.totals.map(o => [o.ref.id, o.ref.buy]), [['tsc-41.5-football_team_full_game_total', 'long'], ['tsc-41.5-football_team_full_game_total', 'short']]);
});

test('Polymarket US soccer: the three result markets make one three-way moneyline', () => {
  const res = (slug, name, ask) => ({ slug, sportsMarketType: 'soccer_team_full_time_winner', status: 'MARKET_STATUS_OPEN', active: true, closed: false,
    bestBidQuote: usd('0.01'), bestAskQuote: usd(ask), marketSides: [{ long: true, description: 'Yes', ...(name ? { team: { name } } : {}) }, { long: false, description: 'No' }] });
  const e = { slug: 'epl-cry-new-2026-10-25', startTime: '2026-10-25T14:00:00Z', active: true, closed: false,
    teams: [{ name: 'Crystal Palace FC', ordering: 'home' }, { name: 'Newcastle United FC', ordering: 'away' }],
    markets: [res('a', 'Crystal Palace FC', '0.35'), res('b', null, '0.28'), res('c', 'Newcastle United FC', '0.42')] };
  const g = pb.gameOf(e, { league: 'epl', now: NOW });
  assert.equal(g.sport, 'epl');
  assert.deepEqual(g.h2h.map(o => o.name), ['Crystal Palace FC', 'Newcastle United FC', 'Draw']);
  assert.deepEqual(g.h2h.map(o => o.price), ['0.35', '0.42', '0.28'].map(x => pb.priceOf(+x)));
});

test('Polymarket US: a live, started or unknown-league game is left out', () => {
  assert.equal(pb.gameOf(nflEvent({ live: true }), { league: 'nfl', now: NOW }), null);
  assert.equal(pb.gameOf(nflEvent({ startTime: '2026-10-24T16:00:00Z' }), { league: 'nfl', now: NOW }), null);
  assert.equal(pb.gameOf(nflEvent(), { league: 'cs2', now: NOW }), null);   // esports stay with the esports board
});

test('the reader pages leagues, reads slug pages for games soon, and keeps their lines', async () => {
  const calls = [];
  const http = { get: async (url, o) => {
    calls.push(url);
    if (/\/v2\/leagues\/nfl\/events/.test(url)) return { data: { events: [nflEvent()] } };
    if (/\/v1\/events\/slug\//.test(url)) { const e = nflEvent(); e.markets.push(spread(-2.5, '0.50', '0.51')); return { data: { event: e } }; }
    const err = new Error('nf'); err.response = { status: 404 }; throw err;
  } };
  const r = pb.createPolymarketUsBooks({ http, leagues: ['nfl', 'epl'] });
  const out = await r.read(NOW);
  assert.equal(out.games, 1);
  assert.equal(out.slugReads, 1);
  assert.equal(out.books.nfl[0].spreads.length, 2);
  assert.deepEqual(out.errors, []);
  // the next pass inside the cache doesn't read the slug again
  const again = await r.read(NOW + 60e3);
  assert.equal(again.slugReads, 0);
  assert.equal(again.books.nfl[0].spreads.length, 2);
});

// ── merged onto Pinnacle, exchange-only leagues ──
const pinSoccer = { id: 501, sport: 'soccer', league: 'USA - Major League Soccer', home: 'New York Red Bulls', away: 'Inter Miami CF', start: START,
  ml: { home: 0.25, away: 0.5, draw: 0.25, raw: [290, 100, 300] }, spreads: [{ home: 1.5, pHome: 0.68, alt: false, raw: [-215, 175] }], totals: [{ line: 2.5, pOver: 0.62, alt: false, raw: [-165, 140] }] };

test('Pinnacle\'s three-way result merges with an exchange\'s; a two-way never sits beside it', () => {
  const books = gb.parseGemini(gemPayload, { now: NOW }).mls;
  const [g] = freebooks.mergeGames('mls', [pinSoccer], books);
  const pin = g.bookmakers.find(b => b.key === 'pinnacle').markets.find(m => m.key === 'h2h');
  assert.deepEqual(pin.outcomes.map(o => o.name), ['New York Red Bulls', 'Inter Miami CF', 'Draw']);
  const gem = g.bookmakers.find(b => b.key === 'gemini');
  assert.equal(gem.markets.find(m => m.key === 'h2h').outcomes.length, 3);
  const two = { ...books[0], h2h: [{ name: 'New York Red Bulls', price: 200 }, { name: 'Inter Miami CF', price: -150 }] };
  const [g2] = freebooks.mergeGames('mls', [pinSoccer], [two]);
  assert.equal(g2.bookmakers.find(b => b.key === 'gemini').markets.some(m => m.key === 'h2h'), false);
  // and the screen prices all three sides off Pinnacle's no-vig
  const rows = ev.screen({ feeds: [{ sport: 'mls', label: 'free-odds', games: [g] }], minEv: -100, now: NOW });
  assert.deepEqual([...new Set(rows.filter(r => r.market === 'h2h' && r.book === 'gemini').map(r => r.side))].sort(), ['Draw', 'Inter Miami CF', 'New York Red Bulls']);
});

test('exchange-only leagues: no FanDuel or BetRivers read, a game kept only when an exchange lists it', async () => {
  const urls = [];
  const http = { get: async url => { urls.push(url); const e = new Error('nf'); e.response = { status: 404 }; throw e; } };
  const other = { ...pinSoccer, id: 502, home: 'LA Galaxy', away: 'Seattle Sounders' };
  const books = gb.parseGemini(gemPayload, { now: NOW });
  const out = await freebooks.fetchFreeBooks(http, [pinSoccer, other], { sports: [], extra: { mls: books.mls, ufc: books.ufc }, now: NOW });
  assert.equal(urls.length, 0);
  assert.deepEqual(out.games.mls.map(g => g.id), ['pin-501']);
  assert.equal(out.counts.mls.exchangeOnly, true);
  assert.equal(out.games.ufc, undefined, 'no Pinnacle fight to sit on');
  assert.equal(freebooks.leagueOf('tennis').league.test('ATP Brussels'), true);
  assert.equal(freebooks.leagueOf('tennis').league.test('ATP Brussels - Doubles'), false);
  assert.ok(freebooks.PIN_SOCCER_LEAGUES.includes(1980));
});

test('Pinnacle reads single soccer leagues by id', async () => {
  const urls = [];
  const http = { get: async url => { urls.push(url); return { data: [] }; } };
  await pingames.fetchPinnacleGames(http, { sports: {}, leagues: { soccer: [1980, 2663] } });
  assert.deepEqual(urls.sort(), ['/leagues/1980/markets/straight', '/leagues/1980/matchups', '/leagues/2663/markets/straight', '/leagues/2663/matchups'].map(u => pingames.PIN + u).sort());
});

test('Polymarket US rungs off Pinnacle\'s main number are cut like Gemini\'s', () => {
  const g = pb.gameOf((() => { const e = nflEvent(); e.markets.push(spread(-2.5, '0.50', '0.51'), spread(-3.5, '0.44', '0.45')); return { event: e }; })(), { league: 'nfl', now: NOW });
  const pg = { id: 9, sport: 'football', league: 'NFL', home: 'New Orleans Saints', away: 'Pittsburgh Steelers', start: '2026-10-25T17:00:00Z', ml: { raw: [140, -160] },
    spreads: [{ home: 2.5, pHome: 0.5, alt: false, raw: [-110, -110] }, { home: 3.5, pHome: 0.55, alt: true, raw: [-130, 110] }], totals: [] };
  const merged = { nfl: freebooks.mergeGames('nfl', [pg], [g]) };
  const bm = gb.mainLinesOnly(merged, [pg], ['gemini', 'polymarketus']).nfl[0].bookmakers.find(b => b.key === 'polymarketus');
  assert.deepEqual(bm.markets.find(m => m.key === 'spreads').outcomes.map(o => o.point), [-2.5, 2.5]);
});

// ── Pinnacle's own close ──
const nflGame = (pinRaw, kmid) => ({ id: 'pin-9', sport_key: 'nfl', commence_time: '2026-10-25T17:00:00Z', home_team: 'New Orleans Saints', away_team: 'Pittsburgh Steelers',
  bookmakers: [{ key: 'pinnacle', markets: [{ key: 'h2h', outcomes: [{ name: 'New Orleans Saints', price: pinRaw[0] }, { name: 'Pittsburgh Steelers', price: pinRaw[1] }] }] },
    ...(kmid ? [{ key: 'kalshi_mid', markets: [{ key: 'h2h', outcomes: [{ name: 'New Orleans Saints', price: kmid[0] }, { name: 'Pittsburgh Steelers', price: kmid[1] }] }] }] : []),
    { key: 'polymarketus', markets: [{ key: 'h2h', outcomes: [{ name: 'New Orleans Saints', price: 160 }, { name: 'Pittsburgh Steelers', price: -175 }] }] }] });

test('the screen hands over Pinnacle\'s own no-vig and raw prices, apart from the blend', () => {
  const fairs = new Map(), pinFairs = new Map();
  ev.screen({ feeds: [{ sport: 'nfl', label: 'free-odds', games: [nflGame([150, -170], [120, -140])] }], minEv: -100, now: NOW, fairs, pinFairs });
  const key = [...pinFairs.keys()].find(k => k.endsWith('|New Orleans Saints'));
  const pf = pinFairs.get(key);
  assert.deepEqual(pf.raw, { 'New Orleans Saints': 150, 'Pittsburgh Steelers': -170 });
  assert.equal(pf.p, 38.36);
  assert.ok(fairs.get(key) > pf.p + 1, 'the blend with Kalshi\'s mid sits elsewhere');
});

test('an exchange row closes on Pinnacle\'s own price; a row Pinnacle stopped pricing is never graded on it', async () => {
  let t = NOW;
  const tr = evtrack.createEvTracker({ now: () => t, minEv: 2 });
  const row = { group: 'g|h2h', side: 'New Orleans Saints', book: 'polymarketus', sport: 'nfl', event: 'Pittsburgh Steelers @ New Orleans Saints', market: 'h2h',
    price: 160, decimal: 2.6, fairProb: 42, ev: 9.2, source: 'sharp', start: '2026-10-25T17:00:00Z' };
  const row2 = { ...row, group: 'g2|h2h' };
  const pin = (p, raw = { a: 150, b: -170 }) => new Map([['g|h2h|New Orleans Saints', { p, raw }], ['g2|h2h|New Orleans Saints', { p, raw }]]);
  await tr.recordBoard([row, row2], new Map([['g|h2h|New Orleans Saints', 42], ['g2|h2h|New Orleans Saints', 42]]), { pinFairs: pin(39) });
  t += 3600e3;
  // Pinnacle moves to 41; the blended fair says 45; g2 loses Pinnacle 20 hours before the start
  await tr.recordBoard([], new Map([['g|h2h|New Orleans Saints', 45], ['g2|h2h|New Orleans Saints', 45]]), { pinFairs: new Map([['g|h2h|New Orleans Saints', { p: 41, raw: { a: 140, b: -160 } }]]) });
  t = Date.parse('2026-10-25T16:30:00Z');
  await tr.recordBoard([], new Map([['g|h2h|New Orleans Saints', 45], ['g2|h2h|New Orleans Saints', 45]]), { pinFairs: new Map([['g|h2h|New Orleans Saints', { p: 41, raw: { a: 140, b: -160 } }]]) });
  t = Date.parse('2026-10-25T17:00:01Z');
  await tr.recordBoard([]);
  const [a] = await tr.list({ book: 'polymarketus', status: 'closed' }).then(l => l.filter(b => b.group === 'g|h2h'));
  const [b] = await tr.list({ status: 'closed' }).then(l => l.filter(x => x.group === 'g2|h2h'));
  assert.equal(a.pinAtFlag, 39);
  assert.equal(a.pinClose, 41);
  assert.deepEqual(a.pinRaw, { a: 140, b: -160 });
  assert.equal(a.pinClv, 6.6, '0.41 × 2.6 − 1');
  assert.equal(a.clv, 17, 'the blend would have said 17%');
  assert.equal(a.pinCloseOk, true);
  assert.equal(b.pinCloseOk, false, 'Pinnacle last priced it 20 hours out');
  assert.deepEqual(evtrack.gradeOf(a), { state: 'ok', clv: 6.6, exec: null, p: 0.41, close: 'pinnacle' });
  assert.equal(evtrack.gradeOf(b).state, 'stale');
  // a row from before Pinnacle's close was kept
  assert.equal(evtrack.gradeOf({ book: 'gemini', status: 'closed', clv: 9.8, closeOk: true }).state, 'unverified');
  // a sportsbook keeps the blended close
  assert.equal(evtrack.gradeOf({ ...a, book: 'betrivers' }).clv, 17);
});

// ── results from the final ──
test('game-line outcomes from a final score', () => {
  const b = o => ({ event: 'Pittsburgh Steelers @ New Orleans Saints', ...o });
  const sc = { home: 20, away: 24 };
  assert.equal(evtrack.outcomeOf(b({ market: 'h2h', side: 'Pittsburgh Steelers' }), sc), 'win');
  assert.equal(evtrack.outcomeOf(b({ market: 'h2h', side: 'New Orleans Saints' }), sc), 'loss');
  assert.equal(evtrack.outcomeOf(b({ market: 'h2h', side: 'Draw' }), { home: 1, away: 1 }), 'win');
  assert.equal(evtrack.outcomeOf(b({ market: 'h2h', side: 'Draw' }), sc), 'loss');
  assert.equal(evtrack.outcomeOf(b({ market: 'spreads', side: 'New Orleans Saints +3.5', point: 3.5 }), sc), 'loss');
  assert.equal(evtrack.outcomeOf(b({ market: 'spreads', side: 'New Orleans Saints +4', point: 4 }), sc), 'push');
  assert.equal(evtrack.outcomeOf(b({ market: 'spreads', side: 'Pittsburgh Steelers -2.5', point: -2.5 }), sc), 'win');
  assert.equal(evtrack.outcomeOf(b({ market: 'totals', side: 'Over', point: 43.5 }), sc), 'win');
  assert.equal(evtrack.outcomeOf(b({ market: 'totals', side: 'Under', point: 43.5 }), sc), 'loss');
  assert.equal(evtrack.outcomeOf(b({ market: 'h2h', side: 'Dallas Cowboys' }), sc), null);
});

test('the results job reads closed lines, grades them and keeps trying a game it can\'t find', async () => {
  let t = Date.parse('2026-10-26T00:00:00Z');
  const store = evtrack.createMemoryStore();
  const base = { status: 'closed', market: 'h2h', event: 'Pittsburgh Steelers @ New Orleans Saints', start: '2026-10-25T17:00:00Z', flaggedAt: '2026-10-24T17:00:00Z', decimal: 2.6, sport: 'nfl' };
  await store.put({ ...base, id: 'x', side: 'New Orleans Saints', execPrice: 0.4 });
  await store.put({ ...base, id: 'y', side: 'Pittsburgh Steelers', sport: 'tennis' });
  await store.put({ ...base, id: 'z', side: 'Pittsburgh Steelers', start: '2026-10-25T23:00:00Z' });   // started 1 hour ago
  const tr = evtrack.createEvTracker({ store, now: () => t });
  const due = await tr.ungraded({ sports: new Set(['nfl']) });
  assert.deepEqual(due.map(b => b.id), ['x']);
  const done = await tr.setResult(due[0], { home: 27, away: 24 }, { save: false });
  assert.equal(done.outcome, 'win');
  assert.equal(done.profit, 1.6);
  assert.equal(done.execProfit, 1.5);
  await tr.saveMany([done]);
  assert.equal((await tr.ungraded({ sports: new Set(['nfl']) })).length, 0);
  // not found: a try is counted
  const [y] = await tr.ungraded({ sports: new Set(['tennis']) });
  assert.equal(await tr.setResult(y, null), null);
  assert.equal((await store.all()).find(b => b.id === 'y').resultTries, 1);
});

test('the scoreboard grades Gemini on Pinnacle\'s close with its results; a pre-change row stays out', () => {
  const row = (i, o = {}) => ({ id: `r${i}`, book: 'gemini', source: 'sharp', status: 'closed', event: `A${i} @ B${i}`, group: `g${i}`, start: '2026-10-20T00:00:00Z',
    flaggedAt: '2026-10-19T00:00:00Z', market: 'h2h', side: `B${i}`, decimal: 2, clv: 20, closeOk: true, closeFair: 60,
    pinAtFlag: 52, pinClose: 52, pinCloseOk: true, pinClv: 4, outcome: i % 2 ? 'win' : 'loss', profit: i % 2 ? 1 : -1, ...o });
  const ev = [...Array.from({ length: 10 }, (_, i) => row(i)), row(99, { pinClose: undefined, pinCloseOk: undefined, pinClv: undefined, pinAtFlag: undefined })];
  const board = closeBoard.scoreboard({ ev });
  const r = board.rows.find(x => x.kind === 'ev' && x.book === 'gemini');
  assert.equal(r.graded, 10);
  assert.equal(r.unverified, 1);
  assert.equal(r.avgClv, 4, 'Pinnacle\'s close, not the blend\'s 20');
  // results count wherever there's a final (the pre-change row too)
  assert.equal(r.wins, 6);
  assert.equal(r.losses, 5);
  // the results page carries the 1u result
  const bet = results.SOURCES.ev.bet(row(1));
  assert.equal(bet.profit, 1);
  assert.equal(bet.staked, 1);
  assert.equal(bet.clv, 0.04);
});
