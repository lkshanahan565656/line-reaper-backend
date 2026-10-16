const test = require('node:test');
const assert = require('node:assert');
const xbooks = require('../xbooks');
const freebooks = require('../freebooks');
const sportProps = require('../sportprops');
const esbooks = require('../esbooks');
const ev = require('../ev');
const { createEvTracker, createMemoryStore } = require('../evtrack');

const NOW = Date.parse('2026-10-14T22:00:00Z');
const START = '2026-10-16T00:15:00.000Z';
const o = (side, odds, value, extra = {}) => ({ side, odds, value, is_live: false, is_alt_market: false, line_status: 'normal', ...extra });
const actionPayload = {
  games: [{
    id: 1, status: 'scheduled', start_time: START, home_team_id: 10, away_team_id: 20,
    teams: [{ id: 10, full_name: 'Denver Broncos' }, { id: 20, full_name: 'Seattle Seahawks' }],
    players: [{ id: 7, full_name: 'Sam Darnold' }],
    markets: {
      68: { event: {
        moneyline: [o('home', 120, 0), o('away', -142, 0)],
        spread: [o('home', -108, 2.5), o('away', -112, -2.5)],
        total: [o('over', -110, 40.5), o('under', -110, 40.5), o('over', 150, 44.5, { is_alt_market: true }), o('under', -180, 44.5, { is_alt_market: true })],
        core_bet_type_9_passing_yards: [o('over', -115, 220.5, { player_id: 7 }), o('under', -105, 220.5, { player_id: 7 })],
      } },
      // a book we don't map is skipped
      15: { event: { moneyline: [o('home', 118, 0), o('away', -140, 0)] } },
    },
  }],
};

test('Action Network: each mapped book becomes a book game with main lines and props', () => {
  const gs = xbooks.parseAction(actionPayload, { now: NOW, props: xbooks.AN_PROPS.nfl });
  assert.strictEqual(gs.length, 1);
  const g = gs[0];
  assert.strictEqual(g.book, 'draftkings');
  assert.deepStrictEqual(g.h2h, [{ name: 'Denver Broncos', price: 120 }, { name: 'Seattle Seahawks', price: -142 }]);
  assert.deepStrictEqual(g.spreads.map(x => x.point), [2.5, -2.5]);
  assert.deepStrictEqual(g.totals.map(x => x.point), [40.5, 40.5], 'alternate totals left out');
  assert.deepStrictEqual(g.props, [{ player: 'Sam Darnold', mkey: 'pass_yds', line: 220.5, over: -115, under: -105 }]);
  assert.ok(xbooks.actionUrls('nfl', { now: NOW })[0].includes('customPickTypes=core_bet_type_9_passing_yards'));
});

const back = (odds, amt, side = 'win') => ({ side, 'decimal-odds': odds, 'available-amount': amt });
const mbPayload = {
  events: [{
    id: 9, name: 'Seattle Seahawks at Denver Broncos', start: START, status: 'open',
    markets: [
      { name: 'Moneyline', 'market-type': 'money_line', status: 'open', runners: [{ name: 'Seattle Seahawks', prices: [back(1.76, 500, 'back'), { side: 'lose', 'decimal-odds': 1.8, 'available-amount': 900 }] }, { name: 'Denver Broncos', prices: [back(2.3, 400)] }] },
      { name: 'Handicap', 'market-type': 'handicap', status: 'open', runners: [{ name: 'Seattle Seahawks -2.5', handicap: -2.5, prices: [back(1.97, 400)] }, { name: 'Denver Broncos +2.5', handicap: 2.5, prices: [back(2.0, 300)] }] },
      { name: '1st Half Handicap', 'market-type': 'handicap', status: 'open', runners: [{ name: 'Seattle Seahawks -1.5', handicap: -1.5, prices: [back(2.04, 400)] }, { name: 'Denver Broncos +1.5', handicap: 1.5, prices: [back(1.81, 300)] }] },
      { name: 'Total', 'market-type': 'total', status: 'open', runners: [{ name: 'OVER 39.5', handicap: 39.5, prices: [back(1.82, 300)] }, { name: 'UNDER 39.5', handicap: 39.5, prices: [back(2.16, 500)] }] },
      // too thin to count
      { name: 'Total', 'market-type': 'total', status: 'open', runners: [{ name: 'OVER 44.5', handicap: 44.5, prices: [back(2.8, 5)] }, { name: 'UNDER 44.5', handicap: 44.5, prices: [back(1.5, 5)] }] },
      { name: 'Nix, B - Total Rushing Yards', 'market-type': 'total', status: 'open', runners: [{ name: 'OVER 15.5', handicap: 15.5, prices: [back(1.91, 400)] }, { name: 'UNDER 15.5', handicap: 15.5, prices: [back(1.9, 400)] }] },
    ],
  }],
};

test('Matchbook: best backs make two-way prices, halves and thin books skipped, props by surname', () => {
  const [g] = xbooks.parseMatchbook(mbPayload, { now: NOW });
  assert.strictEqual(g.home, 'Denver Broncos');
  assert.strictEqual(g.h2h.length, 2);
  assert.deepStrictEqual(g.spreads.map(x => x.point), [2.5, -2.5]);
  assert.deepStrictEqual(g.totals.map(x => x.point), [39.5, 39.5]);
  assert.deepStrictEqual(g.props, [], 'props stay off: a market maker\'s quotes with nothing matched');
  const [p] = xbooks.parseMatchbook(mbPayload, { now: NOW, props: true });
  assert.deepStrictEqual(p.props.map(x => [x.player, x.mkey, x.line]), [['Nix, B', 'rush_yds', 15.5]]);
  assert.strictEqual(xbooks.resolvePlayer('Nix, B', ['Bo Nix', 'Sam Darnold']), 'Bo Nix');
  assert.strictEqual(xbooks.resolvePlayer('Mims Jr., Marvin', ['Marvin Mims Jr.']), 'Marvin Mims Jr.');
});

test('extra books merge onto Pinnacle games and a soft book is scored, not used, by the +EV screen', () => {
  const pin = [{ id: 5, sport: 'football', league: 'NFL', home: 'Denver Broncos', away: 'Seattle Seahawks', start: START,
    ml: { raw: [130, -140] }, spreads: [], totals: [{ line: 40.5, raw: [-105, -105] }] }];
  const books = [...xbooks.parseAction(actionPayload, { now: NOW, props: xbooks.AN_PROPS.nfl }), ...xbooks.parseMatchbook(mbPayload, { now: NOW })];
  const games = freebooks.mergeGames('nfl', pin, books);
  assert.deepStrictEqual(games[0].bookmakers.map(b => b.key).sort(), ['draftkings', 'matchbook', 'pinnacle']);
  const rows = ev.screen({ feeds: [{ sport: 'nfl', games }], now: NOW, minEv: -100 });
  const dk = rows.find(r => r.book === 'draftkings' && r.market === 'h2h' && r.side === 'Denver Broncos');
  assert.ok(dk, 'DraftKings is a venue');
  assert.deepStrictEqual(dk.sharpBooks.sort(), ['matchbook', 'pinnacle'], 'Matchbook joins the fair, DraftKings does not');
  assert.ok(dk.srcP.draftkings > 0 && dk.srcP.pinnacle > 0, 'each book has its own chance on the row');
  assert.ok(!rows.some(r => r.book === 'matchbook'), 'a sharp source is never a play');
});

test('consensus: shadow books ride along with weight 0 until their Brier earns a say', () => {
  const row = { mkey: 'pass_yds', sport: 'NFL' };
  const sharp = [{ book: 'pinnacle', line: 220.5, pOver: 0.5 }, { book: 'fanduel', line: 220.5, pOver: 0.52 }, { book: 'draftkings', line: 220.5, pOver: 0.7 }];
  const f = sportProps.consensusFor(row, 220.5, { sharp });
  assert.strictEqual(f.n, 2);
  assert.ok(f.p < 0.53, 'DraftKings does not move the fair');
  const dk = f.sources.find(x => x.book === 'draftkings');
  assert.ok(dk && dk.shadow && dk.at > 60);
  const { weights, promoted } = sportProps.promoteShadows({ fanduel: { n: 80, brier: 0.25 }, draftkings: { n: 60, brier: 0.24 }, betmgm: { n: 60, brier: 0.26 }, caesars: { n: 10, brier: 0.1 } });
  assert.deepStrictEqual(promoted, ['draftkings']);
  assert.strictEqual(weights.draftkings, 1);
});

test('esports: Polymarket plus Kalshi clear a BetRivers line, one source never does', () => {
  const start = NOW + 3 * 3600e3;
  const pin = [{ id: 1, game: 'LOL', league: 'Worlds', teams: ['Cloud9', 'Karmine Corp'], start, ladders: new Map() }];
  const book = { book: 'betrivers', eventId: 2, game: 'LOL', teams: ['Cloud9', 'Karmine Corp'], start, lines: [{ key: 'series|0|ml', scope: 'series', period: 0, type: 'ml', team: null, x: 0, prices: [150, -200] }] };
  const lad = p => [{ game: 'LOL', teams: ['Cloud9', 'Karmine Corp'], start, ladders: new Map([['series|0|ml', [{ x: 0, p }]]]) }];
  const both = esbooks.screen({ books: [book], pin, kalshi: lad(0.44), poly: lad(0.45), now: NOW, o: { minEv: 2 } });
  const c9 = both.rows.find(r => r.side === 'Cloud9');
  assert.ok(c9.clears);
  assert.deepStrictEqual(c9.sharpBooks, ['kalshi', 'polymarket']);
  const one = esbooks.screen({ books: [book], pin, kalshi: lad(0.44), now: NOW, o: { minEv: 2 } });
  assert.ok(!one.rows.find(r => r.side === 'Cloud9').clears);
});

test('Bovada esports parse into the BetRivers line shape', () => {
  const payload = [{ path: [{ description: 'World Championship Play-In' }, { description: 'League Of Legends' }, { description: 'Esports' }],
    events: [{ id: 3, description: 'Cloud9 vs Karmine Corp', startTime: NOW + 3600e3, displayGroups: [{ description: 'Game Lines', markets: [
      { description: 'Moneyline', period: { description: 'Game' }, outcomes: [{ description: 'Cloud9', price: { american: '+145' } }, { description: 'Karmine Corp', price: { american: '-190' } }] },
      { description: 'Moneyline', period: { description: 'Map 1' }, outcomes: [{ description: 'Cloud9 - Map 1', price: { american: '+115' } }, { description: 'Karmine Corp - Map 1', price: { american: 'EVEN' } }] },
      { description: 'Under/Over Kills', period: { description: 'Map 1' }, outcomes: [{ description: 'Over - Map 1', price: { american: '-115', handicap: '26.5' } }, { description: 'Under - Map 1', price: { american: '-115', handicap: '26.5' } }] },
    ] }] }] }];
  const g = esbooks.parseBovadaEsports(payload, NOW);
  assert.strictEqual(g.book, 'bovada');
  assert.strictEqual(g.game, 'LOL');
  assert.deepStrictEqual(g.lines.map(l => [l.key, l.x, l.prices]), [['series|0|ml', 0, [145, -190]], ['map|1|ml', 0, [115, 100]], ['kills|1|total', -26.5, [-115, -115]]]);
});

test('EV record scores every book against the close', async () => {
  let t = NOW;
  const tr = createEvTracker({ store: createMemoryStore(), now: () => t, minEv: 1 });
  const row = { group: 'g|h2h', sport: 'nfl', event: 'A @ B', start: new Date(NOW + 3600e3).toISOString(), market: 'h2h', side: 'B', book: 'draftkings', price: 120, decimal: 2.2, ev: 5, fairProb: 47.7, source: 'sharp', srcP: { pinnacle: 47.7, draftkings: 44 } };
  await tr.recordBoard([row], new Map([['g|h2h|B', 47.7]]));
  t = NOW + 2 * 3600e3;
  await tr.recordBoard([], new Map());
  const s = await tr.summary();
  assert.strictEqual(s.bySourceClose.draftkings.n, 1);
  assert.ok(s.bySourceClose.draftkings.mse > s.bySourceClose.pinnacle.mse);
});

test('a relayed book far from the other books is left off as unverified', () => {
  const g = { sides: ['A', 'B'], all: { pinnacle: [0.756, 0.244], fanduel: [0.761, 0.239], draftkings: [0.757, 0.243], hardrock: [0.5, 0.5], betmgm: [0.73, 0.27] } };
  assert.ok(ev.isOutlier(g, 'hardrock', 'A'), 'a -120/-120 placeholder on a -340 favourite');
  assert.ok(!ev.isOutlier(g, 'betmgm', 'A'), 'a few points off is a real price');
  assert.ok(!ev.isOutlier({ ...g, all: { pinnacle: [0.76, 0.24], fanduel: [0.5, 0.5] } }, 'fanduel', 'A'), 'books we read directly are never dropped');
});

test('Matchbook counts only beside another sharp source, and is never the second vote', () => {
  const q = (book, a, b) => [{ book, side: 'Over', price: a }, { book, side: 'Under', price: b }];
  // alone: no sharp fair (and too few books for a consensus)
  assert.strictEqual(ev.fairForGroup([...q('matchbook', 144, -175), ...q('betrivers', 130, -143)]), null);
  const f = ev.fairForGroup([...q('pinnacle', -127, 109), ...q('matchbook', -127, 106), ...q('thescore', -105, -115)]);
  assert.deepStrictEqual(f.sharpBooks.sort(), ['matchbook', 'pinnacle']);
  assert.strictEqual(ev.agreement(f, 'Over').agree, false, 'Matchbook follows Pinnacle: one opinion');
  const k = ev.fairForGroup([...q('pinnacle', -127, 109), ...q('matchbook', -127, 106), ...q('kalshi_mid', -110, -110)]);
  assert.strictEqual(ev.agreement(k, 'Over').n, 2);
});

test('a second-hand book never plays off a soft-book consensus', () => {
  const game = (bms) => ({ id: 'g', home_team: 'Tampa Bay Buccaneers', away_team: 'Pittsburgh Steelers', commence_time: START, bookmakers: bms });
  const prop = (key, o, u) => ({ key, markets: [{ key: 'player_receptions', outcomes: [{ name: 'Over', description: 'Cade Otton', point: 3.5, price: o }, { name: 'Under', description: 'Cade Otton', point: 3.5, price: u }] }] });
  // live 2026-10-15: bet365 -115 on the Under, everyone else -154 to -157
  const bms = [prop('bet365', -105, -115), prop('fanduel', 120, -154), prop('caesars', 120, -154), prop('draftkings', 122, -157)];
  const rows = ev.screen({ feeds: [{ sport: 'nfl', games: [game(bms)] }], now: NOW });
  assert.ok(!rows.some(r => r.book === 'bet365'), 'bet365 off the consensus is dropped');
  // a book we read directly still scores off the consensus
  const direct = ev.screen({ feeds: [{ sport: 'nfl', games: [game([prop('betrivers', -105, -115), ...bms.slice(1)])] }], now: NOW });
  assert.ok(direct.some(r => r.book === 'betrivers' && r.source === 'consensus'));
});
