const test = require('node:test');
const assert = require('node:assert/strict');

const C = require('../context');
const { valGamesFromRows, lolGamesFromRows, dotaGamesFromRows } = C;

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
// the same normal CDF the server uses
function erf(x) {
  const s = x >= 0 ? 1 : -1; x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  return s * (1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x));
}
const normalCDF = (x, m, sd) => 0.5 * (1 + erf((x - m) / (sd * Math.SQRT2)));

test('odds conversion and devig', () => {
  close(C.americanToProb(-200), 2 / 3);
  close(C.americanToProb(150), 0.4);
  assert.equal(C.americanToProb(50), null);        // inside the ±100 gap: not a real price
  close(C.decimalToProb(2.5), 0.4);
  close(C.devig(-200, 170), (2 / 3) / (2 / 3 + 100 / 270));
  close(C.devig(1.5, 2.5), (1 / 1.5) / (1 / 1.5 + 0.4));
  assert.equal(C.devig('abc', 2), null);
});

test('series and map probabilities invert each other', () => {
  close(C.mapToSeriesProb(0.5, 3), 0.5);
  close(C.mapToSeriesProb(0.6, 3), 0.648);
  close(C.mapToSeriesProb(0.5, 5), 0.5);
  for (const ps of [0.55, 0.7, 0.9]) {
    close(C.mapToSeriesProb(C.seriesToMapProb(ps, 3), 3), ps, 1e-9);
    close(C.mapToSeriesProb(C.seriesToMapProb(ps, 5), 5), ps, 1e-9);
  }
});

test('P(map played) and span scenarios', () => {
  assert.equal(C.pMapPlayed(1, 0.8, 3), 1);
  assert.equal(C.pMapPlayed(2, 0.8, 3), 1);
  close(C.pMapPlayed(3, 0.5, 3), 0.5);             // even match: 1-1 half the time
  close(C.pMapPlayed(3, 0.8, 3), 2 * 0.8 * 0.2);   // favourite: map 3 only on a split
  assert.equal(C.pMapPlayed(4, 0.5, 3), 0);
  close(C.pMapPlayed(5, 0.5, 5), 0.375);

  const sc = C.spanScenarios([1, 2, 3], 0.8, 3);
  assert.deepEqual(sc.map(x => x.maps), [2, 3]);
  close(sc.reduce((s, x) => s + x.weight, 0), 1);
  close(sc[1].weight, 0.32);
  // a 1-2 span is always fully played
  assert.deepEqual(C.spanScenarios([1, 2], 0.8, 3), [{ maps: 2, weight: 1 }]);
  // a lone map 3 renormalises to "if it happens, it's one map"
  assert.deepEqual(C.spanScenarios([3], 0.8, 3), [{ maps: 1, weight: 1 }]);
  assert.equal(C.inferBestOf([1, 2, 3]), 3);
  assert.equal(C.inferBestOf([1, 2, 3, 4]), 5);
});

test('kill factor rises with strength and falls on lopsided CS maps', () => {
  close(C.killFactor('LOL', 0.5, 0.5), 1);
  assert.ok(C.killFactor('LOL', 0.7, 0.5) > 1);
  assert.ok(C.killFactor('LOL', 0.3, 0.5) < 1);
  // already-strong team, no surprise tonight: no adjustment
  close(C.killFactor('LOL', 0.7, 0.7), 1);
  // CS: an even match plays longer than a stomp
  assert.ok(C.killFactor('CS', 0.5, 0.5) > C.killFactor('CS', 0.85, 0.85));
  close(C.killFactor('COD', 0.9, 0.5), 1, 1e-9);   // unsupported sport: untouched
});

test('mixture pricing lowers an OVER when the last map may not happen', () => {
  const sc = C.spanScenarios([1, 2, 3], 0.8, 3);   // mostly 2 maps
  const perMap = 18, k = 2.5, line = 47.5;
  const mixed = C.mixtureProb(line, 'OVER', sc, perMap, k, normalCDF);
  const assume3 = 1 - normalCDF(line, perMap * 3, Math.sqrt(perMap * 3 * k));
  assert.ok(mixed < assume3 - 0.2, `${mixed} should be well below ${assume3}`);
  close(mixed + C.mixtureProb(line, 'UNDER', sc, perMap, k, normalCDF), 1);
  // single scenario matches the plain normal model
  close(C.mixtureProb(line, 'OVER', [{ maps: 3, weight: 1 }], perMap, k, normalCDF), assume3);
});

test('team names and opponents', () => {
  assert.ok(C.teamsMatch('Team Vitality', 'vitality'));
  assert.ok(C.teamsMatch('G2 Esports', 'G2'));
  assert.ok(!C.teamsMatch('G2', 'NAVI'));
  assert.deepEqual(C.splitMatchTitle('Vitality vs NAVI'), ['Vitality', 'NAVI']);
  assert.deepEqual(C.splitMatchTitle('T1 @ Gen.G'), ['T1', 'Gen.G']);
  assert.equal(C.splitMatchTitle('some match'), null);
  assert.equal(C.opponentFrom('Team Vitality', 'Vitality vs NAVI'), 'NAVI');
  assert.equal(C.opponentFrom('NAVI', 'Vitality vs NAVI'), 'Vitality');
  assert.equal(C.opponentFrom('FaZe', 'Vitality vs NAVI'), null);
  assert.equal(C.opponentFrom('FaZe', 'anything', 'G2'), 'G2');
});

test('Elo ranks teams and reports how favoured each usually is', () => {
  const games = [];
  for (let i = 0; i < 30; i++) {
    games.push({ a: 'Strong', b: 'Weak', aWon: i % 5 !== 0, t: i });       // 80%
    games.push({ a: 'Mid', b: 'Weak', aWon: i % 2 === 0, t: i + 0.5 });    // 50%
  }
  const elo = buildAndCheck(games);
  assert.ok(elo.rating('Strong') > elo.rating('Mid'));
  assert.ok(elo.rating('Mid') > elo.rating('Weak'));
  assert.ok(elo.mapProb('Strong', 'Weak') > 0.65);
  close(elo.mapProb('Strong', 'Strong'), 0.5);
  assert.ok(elo.typical('Strong') > elo.typical('Weak'));
  assert.equal(elo.rating('Nobody'), null);
  assert.equal(elo.mapProb('Strong', 'Nobody'), null);
  assert.ok(elo.rating('team strong') != null, 'name matching is fuzzy');

  function buildAndCheck(g) {
    const e = C.buildElo(g);
    assert.equal(e.size, 3);
    return e;
  }
});

test('odds book stores, flips sides, and converts series to map odds', () => {
  let t = 0;
  const book = C.createOddsBook({ ttlMs: 1000, now: () => t });
  const row = book.set({ sport: 'CS2', teamA: 'Vitality', teamB: 'NAVI', priceA: -200, priceB: 170 });
  assert.ok(row.pMapA < row.pSeriesA, 'a map is closer than the series');
  const a = book.lookup('CS', 'Team Vitality', 'NAVI');
  close(a.pMap, row.pMapA);
  close(book.lookup('CS', 'NAVI', 'Vitality').pMap, 1 - row.pMapA);
  assert.equal(book.lookup('LOL', 'Vitality', 'NAVI'), null, 'wrong sport');
  // a per-map price is used as-is
  close(book.set({ sport: 'CS2', teamA: 'G2', teamB: 'FaZe', pA: 0.6, perMap: true }).pMapA, 0.6);
  // re-entering a match replaces it
  book.set({ sport: 'CS2', teamA: 'Vitality', teamB: 'NAVI', pA: 0.4 });
  assert.ok(book.lookup('CS', 'Vitality', 'NAVI').pMap < 0.5);
  assert.equal(book.list().length, 2);
  t = 2000;
  assert.equal(book.lookup('CS', 'Vitality', 'NAVI'), null, 'stale odds expire');
  assert.throws(() => book.set({ sport: 'CS2', teamA: 'A', teamB: 'B' }));
});

test('matchContext prefers entered odds, falls back to Elo, else null', () => {
  const book = C.createOddsBook();
  book.set({ sport: 'CS2', teamA: 'Vitality', teamB: 'NAVI', pA: 0.75 });
  const games = [];
  for (let i = 0; i < 20; i++) {
    games.push({ a: 'T1', b: 'Gen.G', aWon: i % 3 !== 0, t: i });
    games.push({ a: 'T1', b: 'KT', aWon: true, t: i + 0.1 });
    games.push({ a: 'Gen.G', b: 'KT', aWon: i % 4 !== 0, t: i + 0.2 });
  }
  const elo = { LOL: C.buildElo(games) };

  const cs = C.matchContext({ sport: 'CS2', team: 'Vitality', opponent: 'NAVI', maps: [1, 2, 3] }, { oddsBook: book, elo });
  assert.equal(cs.source, 'odds');
  assert.ok(cs.pMap > 0.5 && cs.pMap < 0.75, 'series prob converts down to a map prob');
  assert.ok(cs.expMaps < 3 && cs.expMaps > 2);
  assert.ok(cs.pLastMap < 0.5);

  const lol = C.matchContext({ sport: 'LOL', team: 'T1', opponent: 'KT', maps: [1, 2] }, { oddsBook: book, elo });
  assert.equal(lol.source, 'elo');
  assert.ok(lol.factor > 1);
  assert.equal(lol.expMaps, 2, 'a 1-2 span is always two maps');

  assert.equal(C.matchContext({ sport: 'LOL', team: 'T1', maps: [1] }, { oddsBook: book, elo }), null, 'no opponent, no context');
  assert.equal(C.matchContext({ sport: 'VAL', team: 'Sentinels', opponent: 'LOUD', maps: [1] }, { oddsBook: book, elo }), null, 'unknown teams');
  assert.equal(C.matchContext({ sport: 'CS2', team: '', maps: [1] }, { oddsBook: book, elo }), null);
  assert.match(C.describeContext(cs), /vs NAVI/);
  assert.equal(C.describeContext(null), '');
});

test('result rows parse into map-level games', () => {
  assert.deepEqual(
    lolGamesFromRows([{ Team1: 'T1', Team2: 'KT', WinTeam: 'KT', DateTime: '2026-10-07 09:00:00' }]),
    [{ a: 'T1', b: 'KT', aWon: false, t: Date.parse('2026-10-07T09:00:00Z') }]);
  assert.deepEqual(lolGamesFromRows([{ Team1: 'T1', Team2: '', WinTeam: 'T1' }]), []);

  assert.deepEqual(
    dotaGamesFromRows([{ radiant_name: 'Spirit', dire_name: 'Falcons', radiant_win: true, start_time: 100 }, { radiant_name: null }]),
    [{ a: 'Spirit', b: 'Falcons', aWon: true, t: 100000 }]);

  const val = valGamesFromRows([{ team1: 'SEN', team2: 'LOUD', score1: '2', score2: '1', unix_timestamp: '1760000000' }]);
  assert.equal(val.length, 3);
  assert.equal(val.filter(g => g.aWon).length, 2);
  assert.equal(val[0].t, 1760000000000);
  // no usable timestamp: list order still replays oldest-last
  const noTs = valGamesFromRows([{ team1: 'A', team2: 'B', score1: '1', score2: '0' }, { team1: 'C', team2: 'D', score1: '1', score2: '0' }]);
  assert.equal(noTs.length, 2);
  assert.ok(noTs[0].t > noTs[1].t, 'newest first in, newest-highest t out');
  assert.deepEqual(valGamesFromRows([{ team1: 'A', team2: 'B', score1: '9', score2: '9' }]), [], 'nonsense scores dropped');
});
