// Global search (search.js): what it finds in the site's own data, how it
// ranks, and that it never makes anything up.
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../search');
const L = require('../leagues');

const now = Date.parse('2026-10-27T12:00:00Z');
const soon = new Date(now + 3 * 3600e3).toISOString();
const screen = { games: [
  { id: 'g1', league: 'nba', leagueLabel: 'NBA', home: 'Los Angeles Lakers', away: 'Boston Celtics', start: soon, venues: 4, markets: [
    { key: 'ml', label: 'Moneyline', sides: [
      { label: 'Boston Celtics', venues: [{ venue: 'pinnacle', ref: true, decimal: 1.8, american: -125 }, { venue: 'kalshi', name: 'Kalshi', decimal: 1.85, american: -118, best: true }] },
      { label: 'Los Angeles Lakers', venues: [{ venue: 'fanduel', name: 'FanDuel', decimal: 2.1, american: 110 }] }] },
    { key: 'total', label: 'Total', sides: [] }] },
  { id: 'g2', league: 'nfl', leagueLabel: 'NFL', home: 'Kansas City Chiefs', away: 'Las Vegas Raiders', start: soon, markets: [{ key: 'spread', label: 'Spread', sides: [] }] },
] };
const propRows = [
  { player: 'LeBron James', team: 'LAL', sport: 'NBA', market: 'Points', startTime: soon, books: { underdog: { line: 25.5 }, prizepicks: { line: 24.5 } } },
  { player: 'LeBron James', team: 'LAL', sport: 'NBA', market: 'Rebounds', startTime: soon, books: { sleeper: { line: 7.5 } } },
  { player: 'Kylian Mbappé', team: 'RMA', sport: 'SOCCER', market: 'Shots', books: { prizepicks: { line: 2.5 } } },
  { player: 'ZywOo', team: 'Vitality', sport: 'CS', esports: true, market: 'Maps 1-2 Kills', books: { underdog: { line: 38.5 } } },
];
const matchups = [{ id: 'mu1', game: 'LOL', league: 'Worlds', start: soon, state: 'unstarted', teams: [{ name: 'T1', code: 'T1' }, { name: 'Gen.G', code: 'GEN' }],
  markets: { kalshi: { sides: [{ cost: 0.4512 }, { cost: 0.5733 }] }, pmus: null } }];
const esMatches = [
  { id: 'e1', game: 'LOL', label: 'LoL', teams: ['Gen.G', 'T1'], start: soon, tournament: 'Worlds' },
  { id: 'e2', game: 'DOTA', label: 'Dota 2', teams: ['Team Spirit', 'Tundra'], start: soon, tournament: 'TI', live: true },
];
const entries = S.build({ screen, propRows, matchups, esMatches, leagues: L.LEAGUES });

test('a team finds its game with each side\'s best bettable price, and opens ODDS SCREEN on that game', () => {
  const [h] = S.query(entries, 'lakers', { now });
  assert.equal(h.kind, 'game');
  assert.equal(h.title, 'Boston Celtics @ Los Angeles Lakers');
  assert.deepEqual(h.go, { tab: 'odds', view: 'lines', game: 'g1', league: 'nba', q: 'Los Angeles Lakers' });
  assert.equal(h.market, 'Moneyline');
  assert.deepEqual(h.prices[0], { label: 'Boston Celtics', venue: 'kalshi', venueName: 'Kalshi', american: -118, decimal: 1.85, point: null });
  // no venue marked best (none legal in the state): no price is made up
  assert.deepEqual(h.prices[1], { label: 'Los Angeles Lakers', venue: null });
  assert.ok(!('fair' in h) && !('ev' in h), 'search shows no fair or EV');
  assert.ok(!Object.keys(h).some(k => k.startsWith('_')), 'no search internals in a hit');
});

test('two teams, word starts and accents all match; a word that is not there does not', () => {
  assert.equal(S.query(entries, 'celtics lakers', { now })[0].id, 'g:g1');
  assert.equal(S.query(entries, 'kan chi', { now })[0].id, 'g:g2');
  assert.equal(S.query(entries, 'mbappe', { now })[0].title, 'Kylian Mbappé');
  assert.deepEqual(S.query(entries, 'lakers zzz', { now }), []);
  assert.deepEqual(S.query(entries, 'l', { now }), [], 'one letter is not a search');
  assert.deepEqual(S.query(entries, '   ', { now }), []);
  assert.deepEqual(S.query([], 'lakers', { now }), [], 'nothing held, nothing found');
});

test('a player is one hit a sport, with their props and apps, and opens PROPS filtered to them', () => {
  const hits = S.query(entries, 'lebron', { now });
  const p = hits.find(h => h.kind === 'player');
  assert.equal(hits.filter(h => h.kind === 'player').length, 1);
  assert.equal(p.props, 2);
  assert.deepEqual(p.apps, ['prizepicks', 'sleeper', 'underdog']);
  assert.deepEqual(p.lines[0], { market: 'Points', line: 25.5 });
  assert.deepEqual(p.go, { tab: 'props', view: 'cards', sport: 'NBA', q: 'LeBron James' });
});

test('an esports series is found by either team or code once (MATCHUPS first), the board adds the rest', () => {
  const t1 = S.query(entries, 'gen g', { now }).filter(h => h.kind === 'series');
  assert.equal(t1.length, 1, 'the board copy of a MATCHUPS series is not listed twice');
  assert.equal(t1[0].title, 'T1 vs Gen.G');
  assert.deepEqual(t1[0].go, { tab: 'esports', mode: 'matchups', game: 'LOL', id: 'mu1' });
  assert.deepEqual(t1[0].exchanges, [{ venue: 'kalshi', venueName: 'Kalshi', costs: [0.4512, 0.5733] }]);
  assert.equal(S.query(entries, 'GEN', { now }).find(h => h.kind === 'series')?.id, 'mu:LOL:mu1');
  const sp = S.query(entries, 'spirit', { now })[0];
  assert.equal(sp.kind, 'series');
  assert.equal(sp.live, true);
  assert.deepEqual(sp.go, { tab: 'esports', mode: 'matches', game: 'DOTA', id: 'e2' });
});

test('markets: props stats by sport, and the game markets only when games carry them', () => {
  const k = S.query(entries, 'kills', { now }).find(h => h.kind === 'market');
  assert.deepEqual(k.go, { tab: 'props', view: 'cards', sport: 'CS', q: 'Maps 1-2 Kills' });
  assert.equal(k.count, 1);
  const ml = S.query(entries, 'moneyline', { now }).find(h => h.kind === 'market');
  assert.deepEqual(ml.go, { tab: 'odds', view: 'lines', market: 'ml' });
  assert.equal(ml.count, 1);
  const none = S.build({ screen: { games: [] }, propRows: [], leagues: L.LEAGUES });
  assert.deepEqual(S.query(none, 'moneyline', { now }), [], 'no games, no game markets');
});

test('leagues show only when the site holds something for them, and link their public page', () => {
  const nba = S.query(entries, 'nba', { now }).find(h => h.kind === 'league');
  assert.deepEqual(nba.counts, { games: 1, props: 2, series: 0 });
  assert.equal(nba.page, '/nba');
  assert.deepEqual(nba.go, { tab: 'odds', view: 'lines', league: 'nba' });
  const lol = S.query(entries, 'league of legends', { now }).find(h => h.kind === 'league');
  assert.deepEqual(lol.go, { tab: 'esports', mode: 'matchups', game: 'LOL' });
  assert.ok(!S.query(entries, 'mlb', { now }).some(h => h.kind === 'league'), 'MLB holds nothing here');
  const holds = S.summary(entries);
  assert.equal(holds.game, 2);
  assert.equal(holds.series, 2);
  assert.equal(holds.player, 3);
});

test('ranking: a whole name first; limits per kind and in all; a kind filter', () => {
  const big = S.build({ propRows: Array.from({ length: 30 }, (_, i) => ({ player: `Smith ${i}`, sport: 'NFL', market: 'Rush Yards', books: { underdog: { line: 50 } } })), leagues: {} });
  assert.equal(S.query(big, 'smith', { now }).filter(h => h.kind === 'player').length, 8);
  assert.equal(S.query(big, 'smith', { now, kinds: ['player'], perKind: 20, limit: 20 }).length, 20);
  assert.equal(S.query(big, 'smith 12', { now })[0].title, 'Smith 12');
  assert.ok(S.query(entries, 'nba', { now, kinds: ['league'] }).every(h => h.kind === 'league'));
});
