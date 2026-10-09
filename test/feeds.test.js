const test = require('node:test');
const assert = require('node:assert/strict');

const F = require('../feeds');
const { createOddsBook, matchContext, buildElo } = require('../context');

const vit = { id: 1, name: 'Team Vitality' }, faze = { id: 2, name: 'FaZe Clan' }, navi = { id: 3, name: 'Natus Vincere' };
const match = (id, A, B, begin, winners, extra = {}) => ({
  id, begin_at: begin, status: 'finished', number_of_games: 3, match_type: 'best_of',
  opponents: [{ type: 'Team', opponent: A }, { type: 'Team', opponent: B }],
  games: winners.map((w, i) => ({ id: id * 10 + i, position: i + 1, status: 'finished', finished: true, forfeit: false, winner: w ? { id: w.id, type: 'Team' } : null })),
  ...extra,
});

test('PandaScore results become map-level games for Elo', () => {
  const games = F.pandaGamesFromMatches([
    match(1, vit, faze, '2026-09-01T15:00:00Z', [vit, faze, vit]),
    match(2, vit, navi, '2026-09-02T15:00:00Z', [vit, vit]),
    { ...match(3, faze, navi, '2026-09-03T15:00:00Z', [faze]), games: [{ position: 1, forfeit: true, winner: { id: 2 } }] },
    match(4, vit, vit, '2026-09-04T15:00:00Z', [vit]),               // same team twice: junk
  ]);
  assert.equal(games.length, 5);
  assert.deepEqual(games.map(g => g.aWon), [true, false, true, true, true]);
  assert.ok(games.every(g => g.t > 0));
  const elo = buildElo(games);
  assert.ok(elo.mapProb('Vitality', 'FaZe') > 0.5);
});

test('schedule gives best-of, matched either way round', () => {
  const sched = F.pandaSchedule([
    { id: 9, begin_at: '2026-10-09T12:00:00Z', number_of_games: 5, match_type: 'best_of', opponents: [{ opponent: vit }, { opponent: navi }] },
    { id: 10, begin_at: '2026-10-09T15:00:00Z', number_of_games: 1, match_type: 'best_of', opponents: [{ opponent: faze }, { opponent: navi }] },
    { id: 11, number_of_games: 3, opponents: [{ opponent: faze }] },                   // TBD opponent
  ]);
  assert.equal(sched.length, 2);
  assert.equal(F.bestOfFor(sched, 'Natus Vincere', 'Vitality'), 5);
  assert.equal(F.bestOfFor(sched, 'FaZe', 'Natus Vincere'), 1);
  assert.equal(F.bestOfFor(sched, 'FaZe', 'Vitality'), null);
});

test('player stat is found in the shapes PandaScore games come in', () => {
  const flat = { players: [{ player: { name: 'ZywOo' }, kills: 24, assists: 3, headshots: 11 }] };
  const nested = { teams: [{ players: [{ name: 'm0NESY', stats: { kills: 19 } }] }] };
  const counts = { players: [{ player_name: 'aspas', stats: { kills_counts: { kills: 21 } } }] };
  assert.equal(F.playerStatFromGame(flat, 'zywoo', 'kills'), 24);
  assert.equal(F.playerStatFromGame(flat, 'ZywOo', 'headshots'), 11);
  assert.equal(F.playerStatFromGame(flat, 'ZywOo', 'assists'), 3);
  assert.equal(F.playerStatFromGame(nested, 'm0NESY'), 19);
  assert.equal(F.playerStatFromGame(counts, 'Aspas'), 21);
  assert.equal(F.playerStatFromGame(flat, 'ropz'), null);
  assert.equal(F.playerStatFromGame({ id: 1, status: 'finished' }, 'ZywOo'), null);
});

test('PandaScore grader returns per-map kills for the right series', async () => {
  const m = match(7, vit, faze, '2026-10-01T15:05:00Z', [vit, faze, null]);
  m.games[2].finished = false; m.games[2].status = 'not_started';
  m.status = 'finished';
  const other = match(8, faze, navi, '2026-10-01T15:00:00Z', [faze, faze]);
  const details = {
    70: { players: [{ player: { name: 'ZywOo' }, kills: 22 }] },
    71: { players: [{ player: { name: 'ZywOo' }, kills: 15 }] },
  };
  const calls = [];
  const http = { async get(url, { params, headers }) {
    calls.push(url);
    assert.equal(headers.Authorization, 'Bearer T');
    if (url.endsWith('/csgo/matches')) { if (params['range[begin_at]'].startsWith('2026-10-01')) assert.match(params['range[begin_at]'], /^2026-10-01T12:00/); return { data: [other, m] }; }
    const g = url.match(/games\/(\d+)$/); if (g) return { data: details[g[1]] || {} };
    throw new Error('unexpected ' + url);
  } };
  const grade = F.createPandaScoreClient(http, 'T', { log: {} }).grader('CS');
  const res = await grade({ sport: 'CS', player: 'ZywOo', team: 'Vitality', stat: 'kills', startTime: '2026-10-01T15:00:00Z' });
  assert.deepEqual(res, { maps: { 1: 22, 2: 15 }, complete: true });
  assert.ok(!calls.some(u => u.includes('/games/72')), 'unplayed map 3 not fetched');
  // without a team, the grader keeps looking past series the player wasn't in
  const res2 = await grade({ sport: 'CS', player: 'ZywOo', team: '', stat: 'kills', startTime: '2026-10-01T15:00:00Z' });
  assert.deepEqual(res2.maps, { 1: 22, 2: 15 });
  // nothing near kickoff
  assert.equal(await grade({ sport: 'CS', player: 'ZywOo', team: 'Vitality', stat: 'kills', startTime: '2026-10-03T15:00:00Z' }), null);
});

const pinMatchups = [
  { id: 100, parentId: null, type: 'matchup', isLive: false, startTime: '2026-10-09T12:00:00Z', league: { name: 'CS2 - IEM Cologne' },
    participants: [{ alignment: 'home', name: 'Team Vitality' }, { alignment: 'away', name: 'FaZe Clan' }] },
  { id: 101, parentId: 100, type: 'matchup', league: { name: 'CS2 - IEM Cologne' },                                        // map line child
    participants: [{ alignment: 'home', name: 'Team Vitality (Map 1)' }, { alignment: 'away', name: 'FaZe Clan (Map 1)' }] },
  { id: 200, parentId: null, type: 'matchup', league: { name: 'League of Legends - LCK' }, startTime: '2026-10-09T08:00:00Z',
    participants: [{ alignment: 'home', name: 'T1' }, { alignment: 'away', name: 'Gen.G' }] },
  { id: 300, parentId: null, type: 'matchup', league: { name: 'Soccer - EPL' },
    participants: [{ alignment: 'home', name: 'Arsenal' }, { alignment: 'away', name: 'Chelsea' }] },
  { id: 400, parentId: null, type: 'matchup', isLive: true, league: { name: 'Valorant - VCT' },
    participants: [{ alignment: 'home', name: 'Sentinels' }, { alignment: 'away', name: 'G2' }] },
];
const ml = (matchupId, period, home, away, extra = {}) => ({ matchupId, period, type: 'moneyline', status: 'open', isAlternate: false,
  prices: [{ designation: 'home', price: home }, { designation: 'away', price: away }], ...extra });
const pinMarkets = [
  ml(100, 0, -180, 150), ml(100, 1, -150, 125),
  ml(200, 0, 120, -145), ml(200, 4, 110, -130),
  ml(300, 0, -110, 250), ml(400, 0, -120, 100),
  { matchupId: 100, period: 0, type: 'spread', prices: [] },
];

test('Pinnacle esports moneylines → series prices, skipping children, live and non-esports', () => {
  const out = F.pinnacleMatchPrices(pinMatchups, pinMarkets);
  assert.equal(out.length, 2);
  const cs = out.find(o => o.sport === 'CS');
  assert.deepEqual([cs.teamA, cs.teamB, cs.priceA, cs.priceB, cs.bestOf, cs.source], ['Team Vitality', 'FaZe Clan', -180, 150, null, 'pinnacle']);
  assert.equal(out.find(o => o.sport === 'LOL').bestOf, 5);      // map 4 lines exist → Bo5
  assert.equal(F.pinnacleSport('Dota 2 - The International'), 'DOTA');
  assert.equal(F.pinnacleSport('Call of Duty - CDL'), 'COD');
  assert.equal(F.pinnacleSport('Valorant - VCT'), 'VAL');
  assert.equal(F.pinnacleSport('Basketball - NBA'), null);
});

test('Pinnacle prices feed match context, without overwriting a hand-entered price', () => {
  const book = createOddsBook();
  book.set({ sport: 'LOL', teamA: 'T1', teamB: 'Gen.G', priceA: -200, priceB: 170 });     // entered by hand
  const sched = { CS: [{ teamA: 'FaZe', teamB: 'Vitality', bestOf: 1 }] };
  const n = F.loadMatchPrices(book, F.pinnacleMatchPrices(pinMatchups, pinMarkets), sched);
  assert.equal(n, 2);
  const lol = book.list().find(r => r.sport === 'LOL');
  assert.equal(lol.source, 'manual');
  const cs = book.list().find(r => r.sport === 'CS');
  assert.equal(cs.bestOf, 1);                                    // best-of from the PandaScore schedule
  const ctx = matchContext({ sport: 'CS2', team: 'Vitality', opponent: 'FaZe', maps: [1] }, { oddsBook: book });
  assert.equal(ctx.source, 'pinnacle');
  assert.ok(ctx.pMap > 0.6 && ctx.pMap < 0.65);
  const lolCtx = matchContext({ sport: 'LoL', team: 'T1', opponent: 'Gen.G', maps: [1, 2] }, { oddsBook: book });
  assert.equal(lolCtx.source, 'odds');
});

test('ratings refresh uses PandaScore for CS2 and CoD when a client is given', async () => {
  const { refreshRatings } = require('../ratings');
  const http = { async get() { throw new Error('offline'); } };
  const panda = { async games(sport) {
    return sport === 'COD' ? [] : F.pandaGamesFromMatches([match(1, vit, faze, '2026-09-01T15:00:00Z', [vit, vit]), match(2, vit, navi, '2026-09-02T15:00:00Z', [vit, navi, vit])]);
  } };
  const state = { elo: {}, meta: {} };
  await refreshRatings(http, state, {}, { panda });
  assert.equal(state.meta.CS.games, 5);
  assert.ok(state.elo.CS && state.elo.VAL);
  assert.match(state.meta.COD.error, /no games/);
  assert.match(state.meta.LOL.error, /offline/);
});
