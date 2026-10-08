// ─── TEAM RATINGS FROM RESULTS ────────────────────────────────────────────────
// Fetchers that turn recent match results into map-level Elo (see context.js).
// Each returns the games it used so the parsing can be unit-tested.

const { buildElo, lolGamesFromRows, dotaGamesFromRows, valGamesFromRows } = require('./context');

const UA = { 'User-Agent': 'LineReaper/3.11 (team ratings)', 'Accept': 'application/json' };

async function fetchLoLGames(http, days = 180) {
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const rows = [];
  for (let page = 0; page < 20; page++) {
    const res = await http.get('https://lol.fandom.com/api.php', {
      params: {
        action: 'cargoquery', format: 'json', limit: '500', offset: String(page * 500),
        tables: 'ScoreboardGames=SG', fields: 'SG.Team1=Team1,SG.Team2=Team2,SG.WinTeam=WinTeam,SG.DateTime_UTC=DateTime',
        where: `SG.DateTime_UTC >= '${since}'`, order_by: 'SG.DateTime_UTC ASC',
      },
      headers: UA, timeout: 30000,
    });
    if (res.data?.error) throw new Error('Cargo: ' + JSON.stringify(res.data.error).slice(0, 160));
    const batch = (res.data?.cargoquery || []).map(r => r.title || r);
    rows.push(...batch);
    if (batch.length < 500) break;
    await new Promise(r => setTimeout(r, 300));
  }
  return lolGamesFromRows(rows);
}

async function fetchDotaGames(http, pages = 10) {
  const rows = [];
  let before = null;
  for (let i = 0; i < pages; i++) {
    const res = await http.get('https://api.opendota.com/api/proMatches', {
      params: before ? { less_than_match_id: before } : {}, headers: UA, timeout: 20000,
    });
    const batch = Array.isArray(res.data) ? res.data : [];
    if (!batch.length) break;
    rows.push(...batch);
    before = Math.min(...batch.map(m => m.match_id));
    await new Promise(r => setTimeout(r, 1100));   // OpenDota free tier: 60/min
  }
  return dotaGamesFromRows(rows);
}

async function fetchValGames(http, pages = 5) {
  const rows = [];
  for (let page = 1; page <= pages; page++) {
    const res = await http.get('https://vlrggapi.vercel.app/match', {
      params: { q: 'results', page }, headers: UA, timeout: 20000,
    });
    const batch = res.data?.data?.segments || res.data?.segments || [];
    if (!batch.length) break;
    rows.push(...batch);
    await new Promise(r => setTimeout(r, 300));
  }
  return valGamesFromRows(rows);
}

// Refresh every sport we can; one failing source never blocks the others.
async function refreshRatings(http, state, log = console) {
  const jobs = { LOL: () => fetchLoLGames(http), DOTA: () => fetchDotaGames(http), VAL: () => fetchValGames(http) };
  for (const [sport, job] of Object.entries(jobs)) {
    try {
      const games = await job();
      if (!games.length) throw new Error('no games returned');
      state.elo[sport] = buildElo(games);
      state.meta[sport] = { games: games.length, teams: state.elo[sport].size, updated: new Date().toISOString(), error: null };
      log.log?.(`Ratings ${sport}: ${games.length} maps → ${state.elo[sport].size} teams`);
    } catch (e) {
      state.meta[sport] = { ...(state.meta[sport] || {}), error: `${e.response?.status || ''} ${e.message}`.trim() };
      log.warn?.(`Ratings ${sport} failed: ${e.message}`);
    }
  }
  return state;
}

module.exports = { fetchLoLGames, fetchDotaGames, fetchValGames, refreshRatings };
