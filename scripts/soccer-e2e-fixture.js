// Adds the soccer model's answers to the browser-test recording (e2e/fixtures/snapshot.json.gz),
// built offline from the recording's own soccer prices (/api/odds-screen?league=...): the same
// engine and the same response shape as server.js, labelled as an e2e fixture.
//   node scripts/soccer-e2e-fixture.js
const fs = require('fs'), zlib = require('zlib');
const G = require('../soccergl');
const FILE = 'e2e/fixtures/snapshot.json.gz';
const snap = JSON.parse(zlib.gunzipSync(fs.readFileSync(FILE)));
const LEAGUE = { epl: 'England - Premier League', laliga: 'Spain - La Liga', seriea: 'Italy - Serie A', bundesliga: 'Germany - Bundesliga', ligue1: 'France - Ligue 1', eredivisie: 'Netherlands - Eredivisie', mls: 'USA - Major League Soccer', ligamx: 'Mexico - Liga MX', brasileirao: 'Brazil - Serie A' };
const bets = [];
for (const [lg, name] of Object.entries(LEAGUE)) {
  const r = snap.responses[`/api/odds-screen?league=${lg}`];
  if (!r) continue;
  for (const g of JSON.parse(r.body).games || []) {
    const ml = (g.markets || []).find(m => m.key === 'ml');
    if (!ml || (ml.sides || []).length !== 3) continue;
    const game = { id: String(g.id).replace(/^pin-/, ''), home: g.home, away: g.away, start: g.start, sport: 'soccer', league: name };
    for (const sd of ml.sides) {
      const side = sd.name === g.home ? 'home' : sd.name === g.away ? 'away' : /^draw$/i.test(sd.name) ? 'draw' : null;
      if (!side) continue;
      const venues = (sd.venues || []).filter(v => v.venue === 'kalshi' || v.venue === 'polymarketus').map(v => ({ venue: v.venue, implied: v.implied, price: null, mid: null, marketId: null, side: 'yes', url: v.url }));
      bets.push({ key: `${game.id}|ml3|${side}`, game, label: side === 'draw' ? 'Draw' : `${sd.name} to win`, pin: sd.fair ?? null, venues });
    }
  }
}
const now = Date.parse(snap.recordedAt);
const E = G.createSoccerModel({ http: { get: async () => { throw new Error('offline'); } }, store: null, bets: () => bets, now: () => now });
const games = E.view();
const bt = E.state.backtest;
const put = (k, body) => { snap.responses[k] = { status: 200, type: 'application/json', body: JSON.stringify(body) }; };
put('/api/soccer/model', { label: 'model, not an edge', note: "e2e fixture: built offline from the recording's soccer prices", status: E.status(), count: games.length, games,
  backtest: bt ? { verdict: bt.verdict, testFrom: bt.testFrom, testTo: bt.testTo, split: bt.split, fitted: bt.fitted,
    venues: Object.fromEntries(Object.entries(bt.venues || {}).filter(([, v]) => v).map(([k, v]) => [k, { verdict: v.verdict, contracts: v.all.contracts, games: v.all.games, logLoss: v.all.logLoss, blend: v.all.blend, bets3: v.all.bets3, bets5: v.all.bets5,
      slices: [v.slice1, v.slice2].map(x => ({ contracts: x.contracts, bets3: { n: x.bets3.n, roi: x.bets3.roi, z: x.bets3.z, clvPin: x.bets3.clvPin } })) }])) } : null });
put('/api/soccer/model/record', { note: 'e2e fixture: no contract frozen yet', kinds: Object.fromEntries(Object.entries({ 'soccer-1x2-kalshi': 'Soccer model 1X2 on Kalshi', 'soccer-1x2-pmus': 'Soccer model 1X2 on Polymarket US' }).map(([k, label]) => [k, { label, open: 0, n: 0, graded: 0, wins: 0, losses: 0, avgClv: null, clvT: null, clvN: 0, games: 0, of: 50, verdict: 'model, not an edge' }])), recent: [], total: 0 });
for (const [, code] of G.PIN_LEAGUES) put(`/api/soccer/model/ratings?league=${code}`, { label: 'model', status: E.status(), teams: E.ratings(code).slice(0, 400) });
fs.writeFileSync(FILE, zlib.gzipSync(JSON.stringify(snap)));
console.log('bets', bets.length, 'games', games.length, 'priced', games.filter(g => g.model).length, 'unrated', games.filter(g => !g.model).map(g => `${g.home}|${g.away}`).slice(0, 20));
