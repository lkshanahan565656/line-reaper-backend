const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../ev');

const NOW = Date.parse('2026-10-08T12:00:00Z');
const START = '2026-10-08T23:00:00Z';
const game = (bookmakers, extra = {}) => ({ id: 'g1', home_team: 'Boston Celtics', away_team: 'New York Knicks', commence_time: START, bookmakers, ...extra });
const h2h = (key, home, away) => ({ key, markets: [{ key: 'h2h', outcomes: [{ name: 'Boston Celtics', price: home }, { name: 'New York Knicks', price: away }] }] });

test('odds conversions', () => {
  assert.equal(E.americanToDecimal(-110).toFixed(4), '1.9091');
  assert.equal(E.americanToDecimal(150), 2.5);
  assert.equal(E.americanToDecimal(50), null, 'not american odds');
  assert.equal(E.decimalToAmerican(2.5), 150);
  assert.equal(E.decimalToAmerican(1.5), -200);
  assert.equal(E.probToAmerican(0.5), 100);
});

test('devig: both methods sum to one; power shades the longshot harder', () => {
  const d = [E.americanToDecimal(-300), E.americanToDecimal(240)];
  const m = E.devig(d, 'multiplicative'), p = E.devig(d, 'power');
  for (const x of [m, p]) assert.ok(Math.abs(x[0] + x[1] - 1) < 1e-9);
  assert.ok(p[1] < m[1], 'power gives the underdog less');
  const even = E.devig([1.909, 1.909]);
  assert.ok(Math.abs(even[0] - 0.5) < 1e-9, 'symmetric market stays 50/50');
});

test('market names from every feed land on one key', () => {
  for (const m of ['player_points', 'Points', 'points', 'pts']) assert.equal(E.canonMarket(m), 'points');
  for (const m of ['player_points_rebounds_assists', 'Pts+Rebs+Asts', 'pts_rebs_asts', 'PRA']) assert.equal(E.canonMarket(m), 'pra');
  for (const m of ['player_threes', '3-PT Made', 'threes_made']) assert.equal(E.canonMarket(m), 'threes');
  for (const m of ['player_blocked_shots', 'Blocked Shots', 'player_blocks']) assert.equal(E.canonMarket(m), 'blocks');
  assert.equal(E.canonMarket('pitcher_strikeouts'), 'strikeouts');
  assert.equal(E.canonName('Luka Dončić'), E.canonName('luka doncic'));
  assert.equal(E.canonName('Jaren Jackson Jr.'), E.canonName('Jaren Jackson'));
});

test('a soft book beating Pinnacle shows up with the right EV', () => {
  const rows = E.screen({ now: NOW, feeds: [{ sport: 'nba', games: [game([
    h2h('pinnacle', -150, 130), h2h('draftkings', -160, 150), h2h('fanduel', -155, 125),
  ])] }] });
  const fair = E.devig([E.americanToDecimal(-150), E.americanToDecimal(130)])[1];
  const dk = rows.find(r => r.book === 'draftkings' && r.side === 'New York Knicks');
  assert.ok(dk, 'DK +150 on the dog');
  assert.equal(dk.source, 'sharp');
  assert.deepEqual(dk.sharpBooks, ['pinnacle']);
  assert.ok(Math.abs(dk.ev - (fair * 2.5 - 1) * 100) < 0.01);
  assert.ok(dk.kelly > 0);
  assert.ok(!rows.find(r => r.book === 'fanduel' && r.side === 'New York Knicks'), 'FD +125 is worse than fair');
  assert.equal(rows[0].ev, Math.max(...rows.map(r => r.ev)), 'sorted best first');
});

test('spreads and totals group by number; mismatched numbers do not mix', () => {
  const sp = (key, pt, a, b) => ({ key, markets: [{ key: 'spreads', outcomes: [{ name: 'Boston Celtics', point: pt, price: a }, { name: 'New York Knicks', point: -pt, price: b }] }] });
  const tot = (key, pt, o, u) => ({ key, markets: [{ key: 'totals', outcomes: [{ name: 'Over', point: pt, price: o }, { name: 'Under', point: pt, price: u }] }] });
  const rows = E.screen({ now: NOW, feeds: [{ games: [game([
    sp('pinnacle', -5.5, -105, -105), sp('betmgm', -5.5, -110, 105), sp('caesars', -6.5, 120, -140),
    tot('pinnacle', 221.5, -110, -110), tot('bet365', 221.5, 100, -120), tot('fanduel', 222.5, 110, -130),
  ])] }] });
  const mgm = rows.find(r => r.book === 'betmgm');
  assert.equal(mgm.side, 'New York Knicks +5.5');
  assert.ok(!rows.find(r => r.book === 'caesars'), '-6.5 has no sharp price');
  assert.ok(rows.find(r => r.book === 'bet365' && r.side === 'Over'));
  assert.ok(!rows.find(r => r.book === 'fanduel'), '222.5 has no sharp price');
});

test('no sharp book: consensus needs enough books and is labelled', () => {
  const books = [h2h('draftkings', -150, 130), h2h('fanduel', -145, 125), h2h('betmgm', -150, 125), h2h('caesars', -140, 160)];
  const rows = E.screen({ now: NOW, feeds: [{ games: [game(books)] }] });
  const czr = rows.find(r => r.book === 'caesars' && r.side === 'New York Knicks');
  assert.ok(czr);
  assert.equal(czr.source, 'consensus');
  assert.deepEqual(E.screen({ now: NOW, feeds: [{ games: [game(books.slice(0, 3))] }] }), [], 'three books is not a consensus');
});

test('started games and one-sided sharp prices are skipped', () => {
  const live = game([h2h('pinnacle', -150, 130), h2h('draftkings', -160, 200)], { commence_time: '2026-10-08T11:00:00Z' });
  assert.deepEqual(E.screen({ now: NOW, feeds: [{ games: [live] }] }), []);
  const half = { key: 'pinnacle', markets: [{ key: 'h2h', outcomes: [{ name: 'Boston Celtics', price: -150 }] }] };
  assert.deepEqual(E.screen({ now: NOW, feeds: [{ games: [game([half, h2h('draftkings', -160, 200)])] }] }), []);
});

test('props from both feeds merge, and DFS legs are scored at the same line', () => {
  // Odds API event-odds shape (Over/Under with description = player)
  const oddsApi = game([{ key: 'pinnacle', markets: [{ key: 'player_points', outcomes: [
    { name: 'Over', description: 'Jayson Tatum', point: 27.5, price: -135 },
    { name: 'Under', description: 'Jayson Tatum', point: 27.5, price: 110 },
  ] }] }]);
  // props-cache shape from a different feed id, same game
  const cached = { id: 'other-id', home_team: 'Boston Celtics', away_team: 'New York Knicks', commence_time: START,
    books: [{ key: 'draftkings', props: [{ player: 'Jayson Tatum', market: 'player_points', line: 27.5, overPrice: -110, underPrice: -110 }] }] };
  const dfsEv = (p, book) => (book === 'prizepicks' ? (p / 0.5622 - 1) * 100 : null);
  const rows = E.screen({ now: NOW, minEv: -100, feeds: [{ sport: 'nba', games: [oddsApi] }, { sport: 'nba', games: [cached] }], dfsEv,
    dfsLines: [
      { book: 'prizepicks', player: 'Jayson Tatum', market: 'Points', line: 27.5, startTime: START },
      { book: 'prizepicks', player: 'Jayson Tatum', market: 'Points', line: 26.5, startTime: START },
    ] });
  const dk = rows.find(r => r.book === 'draftkings' && r.side === 'Over');
  assert.ok(dk && dk.ev > 0, 'DK -110 over beats Pinnacle -135');
  const pp = rows.filter(r => r.book === 'prizepicks');
  assert.equal(pp.length, 2, 'one line matched, both sides scored; 26.5 skipped');
  const ppOver = pp.find(r => r.side === 'Over');
  const fair = E.devig([E.americanToDecimal(-135), E.americanToDecimal(110)])[0];
  assert.ok(Math.abs(ppOver.ev - (fair / 0.5622 - 1) * 100) < 0.01);
  assert.equal(ppOver.dfs, true);
});

test('live edges: new or newly +EV rows fire once, with a cooldown', () => {
  const row = (ev, book = 'draftkings') => ({ group: 'g|h2h', side: 'Knicks', book, ev, event: 'Knicks @ Celtics', market: 'h2h', price: 150, fairPrice: 140, source: 'sharp' });
  const seen = new Map();
  assert.equal(E.diffEv([], [row(4)], { seen, now: NOW }).length, 1, 'new edge');
  assert.equal(E.diffEv([row(4)], [row(5)], { seen, now: NOW }).length, 0, 'already alerting');
  assert.equal(E.diffEv([row(1)], [row(4)], { seen, now: NOW + 60000 }).length, 0, 'cooldown');
  assert.equal(E.diffEv([row(1)], [row(4)], { seen, now: NOW + 31 * 60000 }).length, 1, 'after cooldown');
  assert.equal(E.diffEv([], [row(2)], { now: NOW }).length, 0, 'below threshold');
  assert.match(E.describeEv(row(4)), /\+4\.0% Knicks @ Celtics ML Knicks @ draftkings \+150 \(fair \+140\)/);
});

test('screen reports the fair price of every market through `fairs`', () => {
  const fairs = new Map();
  E.screen({ now: NOW, fairs, feeds: [{ games: [game([h2h('pinnacle', -150, 130), h2h('fanduel', -170, 110)])] }] });
  const vals = [...fairs.values()];
  assert.equal(vals.length, 2, 'both sides, though nothing is +EV');
  assert.ok(Math.abs(vals[0] + vals[1] - 100) < 0.02);
});
