// Runs the branch's readers against the live feeds the way the server does, and reports pairing and flags.
const fs = require('fs'); fs.mkdirSync('out', { recursive: true });
const R = p => require(require('path').resolve('app', p));
const axios = R('node_modules/axios');
const gb = R('geminibooks'), pb = R('pmusbooks'), fb = R('freebooks'), pg = R('pingames'), ev = R('ev'), sg = R('sportgrade');
const http = axios.create({ headers: { 'User-Agent': 'Mozilla/5.0' } });
(async () => {
  const out = {}, t0 = Date.now();
  const gem = await gb.fetchGemini(http); out.gemini = { events: gem.events, errors: gem.errors, skipped: gem.skipped, games: Object.fromEntries(Object.entries(gem.books).map(([k, v]) => [k, v.length]).filter(([, n]) => n)) };
  const pr = pb.createPolymarketUsBooks({ http }); const pm = await pr.read();
  out.pmus = { games: pm.games, withLines: pm.withLines, slugReads: pm.slugReads, counts: pm.counts, errors: pm.errors };
  const pin = await pg.fetchPinnacleGames(http, { sports: { football: 15, basketball: 4, hockey: 19, baseball: 3 } });
  const px = await pg.fetchPinnacleGames(http, { sports: { tennis: 33, mma: 22 }, leagues: { soccer: fb.PIN_SOCCER_LEAGUES } });
  out.pin = { main: pin.games.length, extra: px.games.length, errors: [...pin.errors, ...px.errors], soccerLeagues: [...new Set(px.games.filter(g => g.sport === 'soccer').map(g => g.league))] };
  const pinAll = [...pin.games, ...px.games];
  const extra = {};
  for (const [s, gs] of Object.entries(gem.books)) extra[s] = [...(extra[s] || []), ...gs];
  for (const [s, gs] of Object.entries(pm.books)) extra[s] = [...(extra[s] || []), ...gs];
  const read = await fb.fetchFreeBooks(http, pinAll, { extra, maxKambiEvents: 40 });
  const games = gb.mainLinesOnly(read.games, pinAll, ['gemini', 'polymarketus']);
  out.paired = {};
  for (const [s, gs] of Object.entries(games)) {
    const c = k => gs.filter(g => g.bookmakers.some(b => b.key === k)).length;
    out.paired[s] = { pinnacle: gs.length, gemini: c('gemini'), polymarketus: c('polymarketus'), listed: { gemini: (gem.books[s] || []).length, polymarketus: (pm.books[s] || []).length } };
  }
  // unpaired exchange games: names to check
  out.unpaired = {};
  for (const [s, list] of Object.entries(extra)) {
    const paired = new Set((games[s] || []).flatMap(g => g.bookmakers.filter(b => b.key === 'gemini' || b.key === 'polymarketus').map(b => b.key)).length ? [] : []);
    const ids = new Set();
    for (const g of games[s] || []) for (const b of g.bookmakers) ids.add(`${b.key}|${g.home_team}|${g.away_team}`);
    const leagueGames = fb.leagueGames(pinAll, s);
    out.unpaired[s] = list.filter(x => !leagueGames.some(p => Math.abs(Date.parse(p.start) - Date.parse(x.start)) < 3 * 3600e3 && ((pg.sameTeam(x.home, p.home) && pg.sameTeam(x.away, p.away)) || (pg.sameTeam(x.home, p.away) && pg.sameTeam(x.away, p.home)))))
      .slice(0, 6).map(x => `${x.book}: ${x.away} @ ${x.home} ${x.start}`);
  }
  const fairs = new Map(), pinFairs = new Map();
  const rows = ev.screen({ feeds: Object.entries(games).map(([s, g]) => ({ sport: s, label: 'free-odds', games: g })), minEv: 0, fairs, pinFairs });
  const ex = rows.filter(r => r.book === 'gemini' || r.book === 'polymarketus');
  out.flags = { atLeast2: {}, sample: ex.filter(r => r.ev >= 2).sort((a, b) => b.ev - a.ev).slice(0, 25).map(r => `${r.book} ${r.sport} ${r.event} ${r.market} ${r.side} ${r.price} ev ${r.ev} fair ${r.fairProb} pin ${pinFairs.get(r.group + '|' + r.side)?.p}`) };
  for (const r of ex.filter(r => r.ev >= 2)) { const k = `${r.book}|${r.sport}|${r.market}`; out.flags.atLeast2[k] = (out.flags.atLeast2[k] || 0) + 1; }
  out.priced = {}; for (const r of ex) { const k = `${r.book}|${r.sport}`; out.priced[k] = (out.priced[k] || 0) + 1; }
  out.pinFairs = pinFairs.size;
  // ESPN soccer finals reachable
  const g = sg.createSportsGrader({ http });
  out.espn = await g.gradeGame({ league: 'EPL', home: 'Tottenham Hotspur', away: 'Chelsea', start: '2026-10-24T16:30:00Z' }).catch(e => String(e));
  out.espnNfl = await g.gradeGame({ league: 'NFL', home: 'Philadelphia Eagles', away: 'New York Giants', start: '2026-10-19T00:20:00Z' }).catch(e => String(e));
  out.ms = Date.now() - t0;
  fs.writeFileSync('out/live.json', JSON.stringify(out, null, 1));
})().catch(e => { fs.writeFileSync('out/live.json', JSON.stringify({ error: String(e.stack) })); });
