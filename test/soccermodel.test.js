// Soccer match model (soccermodel.js) and its MATCHUPS engine (soccergl.js):
// club names, football-data CSVs in both layouts, UK kickoffs, ratings
// updates, Dixon-Coles chances, the seed round trip, ESPN finals, and the
// record's freeze, close and grade on a fake store.
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../soccermodel');
const G = require('../soccergl');
const P = require('../seeds/soccermodel-params.json');

test('club names from football-data, Pinnacle, Kalshi and ESPN', () => {
  assert.equal(M.canon('Man United'), M.canon('Manchester United'));
  assert.equal(M.canon("Nott'm Forest"), M.canon('Nottingham Forest'));
  assert.equal(M.canon('Bayern Munich'), M.canon('Bayern München'));
  assert.equal(M.canon('Ath Madrid'), M.canon('Atlético de Madrid'));
  assert.equal(M.canon('Paris SG'), M.canon('Paris Saint-Germain'));
  assert.ok(M.sameClub('Brighton', 'Brighton & Hove Albion'));
  assert.ok(M.sameClub('Tottenham', 'Tottenham Hotspur FC'));
  assert.ok(!M.sameClub('Bristol City', 'Bristol Rovers'));
  assert.ok(!M.sameClub('Manchester City', 'Manchester United'));
  assert.ok(!M.sameClub('Real Madrid', 'Atletico Madrid'));
});

test('UK kickoff times to UTC across British Summer Time', () => {
  assert.equal(new Date(M.parseDate('21/08/2026', '20:00')).toISOString(), '2026-08-21T19:00:00.000Z');
  assert.equal(new Date(M.parseDate('07/11/26', '15:00')).toISOString(), '2026-11-07T15:00:00.000Z');
  assert.equal(new Date(M.parseDate('01/01/2026', '')).toISOString(), '2026-01-01T15:00:00.000Z');
  assert.equal(M.parseDate('2026-01-01', '15:00'), null);
});

test('football-data CSVs: main and "new" layouts, Pinnacle close else Betfair close', () => {
  const main = 'Div,Date,Time,HomeTeam,AwayTeam,FTHG,FTAG,HST,AST,PSCH,PSCD,PSCA,BFECH,BFECD,BFECA,PC>2.5,PC<2.5\n'
    + 'E0,18/10/2026,14:00,Arsenal,Chelsea,2,1,6,3,2.0,3.6,4.0,,,,1.9,2.0\n'
    + 'E0,19/10/2026,16:30,Leeds,Everton,0,0,2,2,,,,2.5,3.2,3.2,,\n'
    + 'E0,25/10/2026,12:30,Wolves,Spurs,,,,,,,,,,,,\n';
  const rows = M.parseFootballData(main, 'E0', '2627');
  assert.equal(rows.length, 3);
  assert.equal(rows[0].hst, 6);
  assert.equal(rows[0].close.src, 'pinnacle');
  assert.ok(Math.abs(rows[0].close.h + rows[0].close.d + rows[0].close.a - 1) < 1e-3);
  assert.ok(rows[0].closeOver > 0.48 && rows[0].closeOver < 0.53);
  assert.equal(rows[1].close.src, 'betfair');
  assert.equal(rows[2].done, false);
  const nw = 'Country,League,Season,Date,Time,Home,Away,HG,AG,Res,PSCH,PSCD,PSCA\nUSA,MLS,2026,18/10/2026,22:00,FC Cincinnati,Columbus Crew,0,2,A,,,\n';
  const u = M.parseFootballData(nw, 'USA');
  assert.equal(u[0].season, '2026');
  assert.equal(u[0].home, 'FC Cincinnati');
  assert.equal(u[0].ag, 2);
  assert.equal(u[0].hst, null);
});

test('Dixon-Coles chances: sum to one, home edge, draws above plain Poisson', () => {
  const c = M.chances(1.5, 1.1, -0.09);
  assert.ok(Math.abs(c.h + c.d + c.a - 1) < 1e-3);
  assert.ok(c.h > c.a);
  const plain = M.chances(1.3, 1.3, 0);
  const dc = M.chances(1.3, 1.3, -0.09);
  assert.ok(dc.d > plain.d, 'negative rho adds draws');
  assert.ok(Math.abs(dc.h - dc.a) < 1e-3);
  assert.ok(M.chances(2, 2).over25 > M.chances(1, 1).over25);
});

test('ratings: results move clubs, promoted clubs start low, seasons shrink, state round-trips', () => {
  const R = M.createRatings(P);
  const m = (home, away, hg, ag, d, season = '2526') => ({ league: 'E0', season, home, away, hg, ag, hst: hg + 2, ast: ag + 2, kickoff: Date.UTC(2025, 8, d), done: true });
  for (let i = 1; i < 20; i++) R.update(m(i % 2 ? 'Arsenal' : 'Fulham', i % 2 ? 'Fulham' : 'Arsenal', i % 2 ? 3 : 0, i % 2 ? 0 : 2, i));
  const t = R.table('E0');
  assert.equal(t[0].team, 'Arsenal');
  const p = R.predict('E0', 'Arsenal', 'Fulham');
  assert.ok(p.known && p.h > 0.5);
  // a club never seen in a league with history starts below it
  const fresh = R.predict('E0', 'Arsenal', 'Coventry');
  assert.equal(fresh.known, false);
  R.update(m('Coventry', 'Fulham', 1, 1, 25));
  assert.ok(R.table('E0').find(x => x.team === 'Coventry').strength < 0);
  const before = R.table('E0').find(x => x.team === 'Arsenal').strength;
  R.update(m('Arsenal', 'Fulham', 1, 1, 28, '2627'));
  assert.ok(R.table('E0').find(x => x.team === 'Arsenal').strength < before, 'a new season pulls toward 0');
  const R2 = M.createRatings(P);
  R2.importState(JSON.parse(JSON.stringify(R.exportState())));
  const a = R2.predict('E0', 'Arsenal', 'Fulham'), b = R.predict('E0', 'Arsenal', 'Fulham');
  for (const k of ['h', 'd', 'a']) assert.ok(Math.abs(a[k] - b[k]) < 1e-3, `${k} survives the round trip`);
  assert.equal(R.resolve('E0', 'Arsenal FC'), 'Arsenal');
  assert.equal(R.resolve('E0', 'Chelsea'), null);
});

test('walk scores only the window and only matches with both clubs rated', () => {
  const ms = [];
  for (let i = 0; i < 40; i++) ms.push({ league: 'E0', season: '2526', home: i % 2 ? 'A' : 'B', away: i % 2 ? 'B' : 'A', hg: 1, ag: 1, kickoff: i * 1e6, done: true });
  const w = M.walk(ms, P, { from: 20e6 });
  assert.equal(w.n, 20);
  assert.ok(w.logLoss > 0 && w.logLoss < 1.2);
});

test('the frozen parameters, seed and backtest files are on hand', () => {
  assert.ok(P.fitted && P.fitted.check.matches > 10000);
  const seed = require('../seeds/soccermodel-seed.json');
  assert.ok(seed.teams.length > 300 && seed.lastMatch);
  const bt = require('../seeds/soccermodel-backtest.json');
  assert.ok(['PASS', 'FAIL'].includes(bt.verdict));
});

test('ESPN finals: completed 90-minute results only, shots on target when present', () => {
  const ev = (state, detail, hs, as) => ({ id: '1', date: '2026-10-24T14:00Z', competitions: [{ date: '2026-10-24T14:00Z', status: { type: { completed: state, shortDetail: detail } },
    competitors: [{ homeAway: 'home', score: String(hs), team: { displayName: 'Chelsea' }, statistics: [{ name: 'shotsOnTarget', displayValue: '5' }] }, { homeAway: 'away', score: String(as), team: { displayName: 'Sunderland' } }] }] });
  const out = G.parseEspn({ events: [ev(true, 'FT', 1, 1), ev(false, '45\'', 0, 0), ev(true, 'AET', 2, 1)] }, 'E0');
  assert.equal(out.length, 1);
  assert.equal(out[0].hst, 5);
  assert.equal(out[0].ast, null);
  assert.equal(G.leagueOf('England - Premier League'), 'E0');
  assert.equal(G.leagueOf('UEFA - Champions League'), null);
  assert.equal(G.seasonOf(Date.UTC(2026, 9, 1)), '2627');
  assert.equal(G.seasonOf(Date.UTC(2027, 1, 1)), '2627');
});

function fakeStore() {
  const m = new Map();
  return { init: async () => {}, all: async () => [...m.values()], put: async r => { m.set(r.id, JSON.parse(JSON.stringify(r))); }, m };
}

test('engine: board, freeze in the hour before kickoff, close, grade on the final', async () => {
  const R = M.createRatings(P);
  for (let i = 0; i < 30; i++) R.update({ league: 'E0', season: '2627', home: i % 2 ? 'Arsenal' : 'Fulham', away: i % 2 ? 'Fulham' : 'Arsenal', hg: i % 2 ? 3 : 0, ag: i % 2 ? 0 : 1, kickoff: Date.UTC(2026, 7, 1) + i * 86400e3, done: true });
  const seed = { lastMatch: new Date(Date.UTC(2026, 8, 15)).toISOString(), ...R.exportState() };
  const start = Date.UTC(2026, 9, 25, 15, 0);
  let t = start - 50 * 60e3;
  const game = { id: 'g1', home: 'Arsenal FC', away: 'Fulham FC', start: new Date(start).toISOString(), sport: 'soccer', league: 'England - Premier League' };
  const bet = (side, kcost, pin, url) => ({ key: `g1|ml3|${side}`, game, label: side, pin, venues: [{ venue: 'kalshi', implied: kcost, price: kcost - 0.01, mid: kcost - 0.005, marketId: `K-${side}`, side: 'yes', url },
    { venue: 'polymarketus', implied: 0.9, price: 0.89, mid: 0.88, marketId: `U-${side}`, side: 'yes', url: 'https://polymarket.us/x' }] });
  const bets = [bet('home', 0.4, 0.62, 'https://kalshi.com/markets/x'), bet('draw', 0.3, 0.22), bet('away', 0.3, 0.16)];
  let espn = { events: [] };
  const asked = [];
  const http = { get: async (url, o) => { if (url.includes('espn')) asked.push(o?.params?.dates); return url.includes('football-data') ? { data: 'Div,Date,Time,HomeTeam,AwayTeam,FTHG,FTAG\n' } : { data: espn }; } };
  const store = fakeStore();
  const E = G.createSoccerModel({ http, store, bets: () => bets, now: () => t, seed, fill: async (ref, usd) => (usd <= 200 ? { usd, cost: 0.41 } : null) });
  await E.refresh();
  assert.ok(asked.length && asked.every(d => /^\d{8}$/.test(d)), 'ESPN is asked one day at a time (a range answers 400)');
  const board = E.view();
  assert.equal(board.length, 1);
  assert.deepEqual(board[0].rated, { home: 'Arsenal', away: 'Fulham' });
  assert.ok(board[0].model.h > 0.5);
  const home = board[0].rows.find(r => r.pick === 'home');
  assert.ok(home.flag.kalshi && !home.flag.pmus);
  await E.tick();
  let recs = await store.all();
  assert.equal(recs.length, 1);
  assert.equal(recs[0].kind, 'soccer-1x2-kalshi');
  assert.deepEqual(recs[0].sized.at200, { usd: 200, cost: 0.41 });
  assert.equal(recs[0].sized.at1000, null);
  // the close moves, then kickoff locks it
  bets[0].pin = 0.66;
  t = start - 5 * 60e3; await E.tick();
  t = start + 60e3; await E.tick();
  recs = await store.all();
  assert.equal(recs[0].status, 'locked');
  assert.equal(recs[0].clv, Math.round((0.66 / 0.4 - 1) * 1e4) / 1e4);
  // the final arrives from ESPN
  espn = { events: [{ id: '9', date: new Date(start).toISOString(), competitions: [{ date: new Date(start).toISOString(), status: { type: { completed: true, shortDetail: 'FT' } },
    competitors: [{ homeAway: 'home', score: '2', team: { displayName: 'Arsenal' } }, { homeAway: 'away', score: '0', team: { displayName: 'Fulham' } }] }] }] };
  t = start + 3 * 3600e3; await E.refresh();
  recs = await store.all();
  assert.equal(recs[0].status, 'graded');
  assert.equal(recs[0].outcome, 'win');
  assert.equal(recs[0].final, '2-0');
  const rec = await E.record();
  assert.equal(rec.kinds['soccer-1x2-kalshi'].graded, 1);
  assert.equal(rec.kinds['soccer-1x2-kalshi'].verdict, 'model, not an edge');
  assert.equal(rec.kinds['soccer-1x2-pmus'].n, 0);
});

test('engine: nothing frozen more than an hour out, nothing for a league we do not rate', async () => {
  const start = Date.UTC(2026, 9, 25, 15, 0);
  const t = start - 3 * 3600e3;
  const g = league => ({ key: 'g|ml3|home', game: { id: 'g', home: 'A', away: 'B', start: new Date(start).toISOString(), sport: 'soccer', league }, pin: 0.5, venues: [{ venue: 'kalshi', implied: 0.1, marketId: 'k', side: 'yes' }] });
  const store = fakeStore();
  const E = G.createSoccerModel({ http: { get: async () => ({ data: {} }) }, store, bets: () => [g('England - Premier League'), g('UEFA - Champions League')], now: () => t, seed: null });
  const v = E.view();
  assert.equal(v.length, 1);
  assert.equal(v[0].model, null);
  await E.tick();
  assert.equal((await store.all()).length, 0);
});
