// NFL game-line model (nflmodel.js) and its odds-screen engine (nflgl.js):
// team names, Eastern kickoffs, ratings updates, key-number shapes, every
// bet key priced and graded, ESPN finals merged, and the record's freeze,
// close and grade on a fake store.
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../nflmodel');
const G = require('../nflgl');
const P = require('../seeds/nflmodel-params.json');

test('team names from books, exchanges and old codes', () => {
  assert.equal(M.teamCode('Kansas City Chiefs'), 'KC');
  assert.equal(M.teamCode('NY Jets'), 'NYJ');
  assert.equal(M.teamCode('New York Giants'), 'NYG');
  assert.equal(M.teamCode('Washington'), 'WAS');
  assert.equal(M.teamCode('Washington Redskins'), 'WAS');
  assert.equal(M.teamCode('LA Rams'), 'LA');
  assert.equal(M.teamCode('Los Angeles Chargers'), 'LAC');
  assert.equal(M.teamCode('OAK'), 'LV');
  assert.equal(M.teamCode('Los Angeles'), null);   // two teams there
  assert.equal(M.teamCode('Toronto Argonauts'), null);
});

test('Eastern kickoffs to UTC across daylight saving', () => {
  assert.equal(new Date(M.easternToUtc('2026-10-29', '20:15')).toISOString(), '2026-10-30T00:15:00.000Z');
  assert.equal(new Date(M.easternToUtc('2026-11-08', '13:00')).toISOString(), '2026-11-08T18:00:00.000Z');
  assert.equal(new Date(M.easternToUtc('2026-09-13', '16:25')).toISOString(), '2026-09-13T20:25:00.000Z');
});

test('ratings move toward results and shrink at a new season', () => {
  const R = M.createRatings({ ...P, rest: 0 });
  const g = { season: 2025, home: 'KC', away: 'DEN', homeScore: 30, awayScore: 10, kickoff: 1 };
  const before = R.predict(g).margin;
  R.update(g);
  const after = R.predict({ season: 2025, home: 'KC', away: 'DEN' }).margin;
  assert.ok(after > before, 'a home win raises the home margin');
  const t = R.table();
  assert.equal(t[0].team, 'KC');
  const next = R.predict({ season: 2026, home: 'KC', away: 'DEN' }).margin;
  assert.ok(Math.abs(next - P.hfa) < Math.abs(after - P.hfa), 'the off-season pulls ratings back toward zero');
  // a capped blowout counts no more than the cap
  const R2 = M.createRatings({ ...P, rest: 0 }), R3 = M.createRatings({ ...P, rest: 0 });
  R2.update({ season: 2025, home: 'A', away: 'B', homeScore: 60, awayScore: 0 });
  R3.update({ season: 2025, home: 'A', away: 'B', homeScore: 60 - (60 - P.cap), awayScore: 0 });
  assert.equal(R2.table()[0].rating, R3.table()[0].rating);
});

test('score shapes: key numbers, monotone lines, moneyline consistent', () => {
  const ch = M.chances({ margin: 3, total: 44 }, P);
  assert.ok(ch.home(2.5) - ch.home(3.5) > ch.home(4.5) - ch.home(5.5), 'more lands on 3 than on 5');
  assert.ok(ch.home(-3.5) > ch.home(0.5) && ch.home(0.5) > ch.home(7.5));
  assert.ok(ch.over(40.5) > ch.over(44.5) && ch.over(44.5) > ch.over(50.5));
  assert.ok(Math.abs(ch.home(0.5) + ch.away(-0.5) - 1) < 1e-3);
  assert.ok(ch.pHome > 0.55 && ch.pHome < 0.65);
  const even = M.chances({ margin: 0, total: 44 }, P);
  assert.ok(Math.abs(even.pHome - 0.5) < 1e-3);
  const mk = M.marketChances(-7, 47, P);
  assert.ok(mk.pHome > 0.2 && mk.pHome < 0.35, `home a 7-point dog: ${mk.pHome}`);
});

test('bet keys priced and graded both ways', () => {
  const ch = M.chances({ margin: 3, total: 44 }, P);
  assert.equal(G.modelP('g|ml|home', ch), ch.pHome);
  assert.ok(Math.abs(G.modelP('g|ml|away', ch) - (1 - ch.pHome)) < 1e-4);
  // home -3.5 covers on a margin over 3.5
  assert.equal(G.modelP('g|spread|-3.5|home', ch), ch.home(3.5));
  assert.ok(Math.abs(G.modelP('g|spread|-3.5|away', ch) - (1 - ch.home(3.5))) < 1e-4);
  assert.equal(G.modelP('g|total|44.5|over', ch), ch.over(44.5));
  assert.equal(G.modelP('g|nonsense', ch), null);
  assert.equal(G.outcomeOf('g|ml|home', 24, 20), 'win');
  assert.equal(G.outcomeOf('g|ml|away', 24, 20), 'loss');
  assert.equal(G.outcomeOf('g|ml|home', 20, 20), 'push');
  assert.equal(G.outcomeOf('g|spread|-3.5|home', 24, 20), 'win');
  assert.equal(G.outcomeOf('g|spread|-3.5|home', 23, 20), 'loss');
  assert.equal(G.outcomeOf('g|spread|-3.5|away', 23, 20), 'win');
  assert.equal(G.outcomeOf('g|spread|3|home', 17, 20), 'push');
  assert.equal(G.outcomeOf('g|total|44.5|over', 24, 21), 'win');
  assert.equal(G.outcomeOf('g|total|44.5|under', 24, 21), 'loss');
  assert.equal(G.kindOf('g|spread|-3.5|home'), 'nfl-spread');
});

test('ESPN finals parsed and laid over the schedule', () => {
  const body = { events: [
    { id: '1', competitions: [{ date: '2026-10-25T17:00Z', status: { type: { completed: true } }, competitors: [{ homeAway: 'home', score: '27', team: { abbreviation: 'WSH' } }, { homeAway: 'away', score: '20', team: { abbreviation: 'LAR' } }] }] },
    { id: '2', competitions: [{ date: '2026-10-25T20:00Z', status: { type: { completed: false } }, competitors: [{ homeAway: 'home', score: '0', team: { abbreviation: 'KC' } }, { homeAway: 'away', score: '0', team: { abbreviation: 'DEN' } }] }] },
  ] };
  const f = G.parseEspn(body);
  assert.deepEqual(f.map(x => [x.home, x.away, x.homeScore, x.awayScore]), [['WAS', 'LA', 27, 20]]);
  const games = [{ id: 'x', home: 'WAS', away: 'LA', kickoff: Date.parse('2026-10-25T17:00Z'), done: false }];
  assert.equal(G.mergeFinals(games, f), 1);
  assert.equal(games[0].done, true);
  assert.equal(games[0].homeScore, 27);
});

function fakeStore() {
  const m = new Map();
  return { init: async () => {}, all: async () => [...m.values()], put: async r => { m.set(r.id, JSON.parse(JSON.stringify(r))); }, m };
}
const CSV_HEAD = 'game_id,season,game_type,week,gameday,weekday,gametime,away_team,away_score,home_team,home_score,location,result,total,overtime,old_game_id,gsis,nfl_detail_id,pfr,pff,espn,ftn,away_rest,home_rest,away_moneyline,home_moneyline,spread_line,away_spread_odds,home_spread_odds,total_line,under_odds,over_odds,div_game,roof,surface,temp,wind,away_qb_id,home_qb_id,away_qb_name,home_qb_name,away_coach,home_coach,referee,stadium_id,stadium';
function csvRow(id, season, day, time, away, as, home, hs) {
  const c = new Array(CSV_HEAD.split(',').length).fill('');
  Object.assign(c, { 0: id, 1: season, 2: 'REG', 3: 1, 4: day, 6: time, 7: away, 8: as ?? '', 9: home, 10: hs ?? '', 11: 'Home', 22: 7, 23: 7, 33: 'outdoors' });
  return c.join(',');
}

test('engine: board rows, freeze inside the hour, close, grade', async () => {
  // 5,001 played games so the schedule read is accepted, then one game today
  const rows = [CSV_HEAD];
  for (let i = 0; i < 5001; i++) rows.push(csvRow(`old${i}`, 2020, '2020-10-04', '13:00', i % 2 ? 'DEN' : 'KC', i % 2 ? 17 : 24, i % 2 ? 'KC' : 'DEN', i % 2 ? 24 : 17));
  rows.push(csvRow('2026_08_DEN_KC', 2026, '2026-10-25', '16:25', 'DEN', '', 'KC', ''));
  const csv = rows.join('\n');
  const kick = M.easternToUtc('2026-10-25', '16:25');
  let t = kick - 45 * 60e3;
  const store = fakeStore();
  const pin = { id: 99, home: 'Kansas City Chiefs', away: 'Denver Broncos', start: new Date(kick).toISOString(), league: 'NFL' };
  let bets = [
    { key: '99|ml|home', game: pin, league: 'NFL', label: 'Kansas City Chiefs to win', pin: 0.5, venues: [{ venue: 'kalshi', implied: 0.45, price: 0.44, mid: 0.44, marketId: 'KXNFLGAME-X-KC', side: 'yes' }] },
    { key: '99|ml|away', game: pin, league: 'NFL', label: 'Denver Broncos to win', pin: 0.5, venues: [{ venue: 'kalshi', implied: 0.58, price: 0.57, mid: 0.56, marketId: 'KXNFLGAME-X-KC', side: 'no' }] },
    { key: '99|ml|home', game: { ...pin, league: 'NCAA' }, league: 'ncaaf', label: 'other', pin: 0.5, venues: [] },
  ];
  let espn = { events: [] };
  const http = { get: async url => (url.includes('nflverse') ? { data: csv } : { data: espn }) };
  const E = G.createNflModel({ http, store, bets: () => bets, now: () => t, fill: async (ref, usd) => (usd <= 200 ? { usd, cost: 0.455 } : null) });
  await E.refresh();
  assert.equal(E.status().upcoming, 1);
  const v = E.view();
  assert.equal(v.length, 1);
  assert.equal(v[0].rows.length, 2);
  const home = v[0].rows.find(r => r.key === '99|ml|home');
  assert.ok(home.model > 0.6, 'KC beat DEN 5,001 times');
  assert.equal(home.flag, true);
  await E.tick();
  let recs = await store.all();
  assert.equal(recs.length, 1, 'only the flagged side');
  assert.equal(recs[0].kind, 'nfl-ml');
  assert.deepEqual(recs[0].sized, { at200: { usd: 200, cost: 0.455 }, at1000: null });
  // the close moves, then kickoff locks the CLV
  bets = bets.map(b => ({ ...b, pin: b.key.endsWith('home') ? 0.5 : 0.5 }));
  bets[0] = { ...bets[0], pin: 0.54 };
  t = kick - 5 * 60e3; await E.tick();
  t = kick + 60e3; await E.tick();
  recs = await store.all();
  assert.equal(recs[0].status, 'locked');
  assert.equal(recs[0].clv, Math.round((0.54 / 0.45 - 1) * 1e4) / 1e4);
  // the final grades it
  espn = { events: [{ id: '7', competitions: [{ date: new Date(kick).toISOString(), status: { type: { completed: true } }, competitors: [{ homeAway: 'home', score: '24', team: { abbreviation: 'KC' } }, { homeAway: 'away', score: '17', team: { abbreviation: 'DEN' } }] }] }] };
  t = kick + 4 * 3600e3; await E.refresh();
  recs = await store.all();
  assert.equal(recs[0].status, 'graded');
  assert.equal(recs[0].outcome, 'win');
  const rec = await E.record();
  assert.equal(rec.kinds['nfl-ml'].verdict, 'model, not an edge');
  assert.equal(rec.kinds['nfl-ml'].wins, 1);
  assert.equal(rec.kinds['nfl-ml'].of, 50);
});

test('engine: a flag more than an hour out is not frozen; flipped Pinnacle sides grade the right team', async () => {
  const rows = [CSV_HEAD];
  for (let i = 0; i < 5001; i++) rows.push(csvRow(`old${i}`, 2020, '2020-10-04', '13:00', 'DEN', 10, 'KC', 30));
  rows.push(csvRow('2026_08_DEN_KC', 2026, '2026-10-25', '16:25', 'DEN', '', 'KC', ''));
  const kick = M.easternToUtc('2026-10-25', '16:25');
  let t = kick - 3 * 3600e3;
  const store = fakeStore();
  // Pinnacle lists Denver as home (a neutral-site style flip)
  const pin = { id: 5, home: 'Denver Broncos', away: 'Kansas City Chiefs', start: new Date(kick).toISOString(), league: 'NFL' };
  const bets = [{ key: '5|spread|3.5|away', game: pin, league: 'NFL', label: 'Kansas City Chiefs -3.5', pin: 0.5, venues: [{ venue: 'kalshi', implied: 0.5, price: 0.49, mid: 0.49, marketId: 'K', side: 'yes' }] }];
  let espn = { events: [] };
  const E = G.createNflModel({ http: { get: async url => (url.includes('nflverse') ? { data: rows.join('\n') } : { data: espn }) }, store, bets: () => bets, now: () => t });
  await E.refresh();
  const r = E.view()[0].rows[0];
  assert.ok(r.model > 0.6, 'KC is our home team and a big favourite');
  await E.tick();
  assert.equal((await store.all()).length, 0);
  t = kick - 30 * 60e3; await E.tick();
  t = kick + 60e3; await E.tick();
  espn = { events: [{ id: '1', competitions: [{ date: new Date(kick).toISOString(), status: { type: { completed: true } }, competitors: [{ homeAway: 'home', score: '20', team: { abbreviation: 'KC' } }, { homeAway: 'away', score: '17', team: { abbreviation: 'DEN' } }] }] }] };
  t = kick + 4 * 3600e3; await E.refresh();
  const rec = (await store.all())[0];
  assert.equal(rec.outcome, 'loss', 'KC by 3 does not cover -3.5');
});

test('results: the NFL model reads proven only by kind, at 50 games', () => {
  const results = require('../results');
  const rec = (i, kind, clv) => ({ id: `r${i}`, kind, status: 'graded', outcome: i % 2 ? 'win' : 'loss', profit: i % 2 ? 1 : -1, clv, gameId: `g${i}`, start: '2026-10-25T17:00:00Z', closeOk: true, pinClose: 0.5, cost: 0.5 });
  const rows = Array.from({ length: 60 }, (_, i) => rec(i, 'nfl-spread', 0.03 + (i % 3) * 0.01));
  const b = results.scoreboard({ nflModel: rows });
  const kind = b.plays.find(p => p.source === 'nflModel' && p.by === 'kind');
  assert.equal(kind.verdict, 'proven');
  const all = b.plays.find(p => p.source === 'nflModel' && p.play === 'all');
  assert.notEqual(all.verdict, 'proven');
  // 40 games of the same quality are not enough
  const few = results.scoreboard({ nflModel: rows.slice(0, 40) }).plays.find(p => p.source === 'nflModel' && p.by === 'kind');
  assert.notEqual(few.verdict, 'proven');
  // one game counted once: 60 contracts on 6 games are 6 games
  const same = rows.map((r, i) => ({ ...r, gameId: `g${i % 6}` }));
  const one = results.scoreboard({ nflModel: same }).plays.find(p => p.source === 'nflModel' && p.by === 'kind');
  assert.notEqual(one.verdict, 'proven');
});
