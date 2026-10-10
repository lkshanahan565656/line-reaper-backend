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

// ── free sources that replaced the dead ones (2026-10-10) ──
// Leaguepedia's Cargo API rate-limits datacenter IPs, Oracle's Elixir's bucket
// is gone and the vlrggapi mirror answers 402. These read the same results
// from the leagues' and fans' own sites. Each returns map-level games for
// buildElo; a series score becomes that many map wins each way.
const seriesToGames = (a, b, s1, s2, t) => {
  const out = [];
  if (!a || !b || !(s1 >= 0) || !(s2 >= 0) || s1 + s2 > 7) return out;
  for (let i = 0; i < s1; i++) out.push({ a, b, aWon: true, t });
  for (let i = 0; i < s2; i++) out.push({ a, b, aWon: false, t });
  return out;
};

// LoL: the lolesports schedule (the public key its own site uses). Completed
// matches carry each team's game wins.
const LOLESPORTS = 'https://esports-api.lolesports.com/persisted/gw/getSchedule';
const LOLESPORTS_KEY = '0TvQnueqKa5mxJntVWt0w4LpLfEkrV1Ta8rQBb9Z';
function lolesportsGames(events) {
  const out = [];
  for (const e of events || []) {
    if (e?.state !== 'completed' || e.type !== 'match') continue;
    const [x, y] = e.match?.teams || [];
    if (!x || !y) continue;
    out.push(...seriesToGames(x.name, y.name, Number(x.result?.gameWins), Number(y.result?.gameWins), Date.parse(e.startTime) || 0));
  }
  return out;
}
async function fetchLoLesportsGames(http, { days = 180, maxPages = 60 } = {}) {
  const cutoff = Date.now() - days * 86400000;
  const games = [];
  let token = null;
  for (let page = 0; page < maxPages; page++) {
    const res = await http.get(LOLESPORTS, { params: { hl: 'en-US', ...(token ? { pageToken: token } : {}) }, headers: { ...UA, 'x-api-key': LOLESPORTS_KEY }, timeout: 20000 });
    const sched = res?.data?.data?.schedule;
    const events = sched?.events || [];
    games.push(...lolesportsGames(events));
    token = sched?.pages?.older || null;
    const oldest = Math.min(...events.map(e => Date.parse(e.startTime) || Infinity));
    if (!token || !events.length || oldest < cutoff) break;
    await new Promise(r => setTimeout(r, 300));
  }
  return games;
}

// Valorant: vlr.gg's results pages. Each day is a "wf-label mod-large" header
// followed by match items with both team names and the series score.
const strip = h => String(h).replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&#0?39;|&apos;/g, "'").replace(/&ndash;/g, '-').replace(/\s+/g, ' ').trim();
function vlrResultsGames(html) {
  const out = [];
  const text = String(html || '');
  // split into day blocks
  const parts = text.split(/<div class="wf-label mod-large">/).slice(1);
  for (const part of parts) {
    const day = Date.parse(strip(part.slice(0, part.indexOf('</div>'))).replace(/\s*Today|Yesterday\s*/g, '').trim()) || 0;
    for (const [item, id] of [...part.matchAll(/<a href="\/(\d+)\/[^"]*"[^>]*class="wf-module-item match-item[\s\S]*?<\/a>/g)].map(m => [m[0], m[1]])) {
      const names = [...item.matchAll(/<div class="match-item-vs-team-name">([\s\S]*?)<\/div>\s*<\/div>/g)].map(m => strip(m[1]));
      const scores = [...item.matchAll(/<div class="match-item-vs-team-score[^"]*">([\s\S]*?)<\/div>/g)].map(m => parseInt(strip(m[1]), 10));
      if (names.length < 2 || scores.length < 2) continue;
      out.push(...seriesToGames(names[0], names[1], scores[0], scores[1], day).map(g => ({ ...g, id })));
    }
  }
  return out;
}
async function fetchVlrGames(http, { pages = 12 } = {}) {
  const games = [], seen = new Set();
  for (let page = 1; page <= pages; page++) {
    const res = await http.get(`https://www.vlr.gg/matches/results${page > 1 ? `/?page=${page}` : ''}`, { headers: { 'User-Agent': 'Mozilla/5.0 (LineReaper team ratings)' }, timeout: 20000, responseType: 'text' });
    // past the last page vlr.gg serves an earlier one again: stop when nothing is new
    const batch = vlrResultsGames(res?.data).filter(g => !seen.has(g.id));
    if (!batch.length) break;
    for (const g of batch) seen.add(g.id);
    games.push(...batch);
    await new Promise(r => setTimeout(r, 1500));
  }
  return games;
}

// CS2: bo3.gg's finished matches (series scores) and its team list for names.
const BO3 = 'https://api.bo3.gg/api/v1';
const BO3_HEADERS = { origin: 'https://bo3.gg', referer: 'https://bo3.gg/', 'User-Agent': 'Mozilla/5.0 (LineReaper team ratings)' };
function bo3Games(matches, names) {
  const out = [];
  for (const m of matches || []) {
    if (m.status !== 'finished') continue;
    const a = names.get(m.team1_id), b = names.get(m.team2_id);
    out.push(...seriesToGames(a, b, Number(m.team1_score), Number(m.team2_score), Date.parse(m.start_date) || 0));
  }
  return out;
}
async function fetchBo3Games(http, { days = 120, maxPages = 80 } = {}) {
  const cutoff = Date.now() - days * 86400000;
  const matches = [];
  for (let page = 0; page < maxPages; page++) {
    const res = await http.get(`${BO3}/matches`, {
      params: { 'page[offset]': page * 100, 'page[limit]': 100, sort: '-start_date', 'filter[matches.status][in]': 'finished', 'filter[matches.discipline_id][eq]': 1 },
      headers: BO3_HEADERS, timeout: 20000,
    });
    const rows = res?.data?.results || [];
    matches.push(...rows);
    const oldest = Math.min(...rows.map(m => Date.parse(m.start_date) || Infinity));
    if (rows.length < 100 || oldest < cutoff) break;
    await new Promise(r => setTimeout(r, 700));
  }
  const ids = [...new Set(matches.flatMap(m => [m.team1_id, m.team2_id]).filter(x => x != null))];
  const names = new Map();
  for (let i = 0; i < ids.length; i += 100) {
    const res = await http.get(`${BO3}/teams`, { params: { 'filter[teams.id][in]': ids.slice(i, i + 100).join(','), 'page[limit]': 100 }, headers: BO3_HEADERS, timeout: 20000 });
    for (const t of res?.data?.results || []) if (t?.id != null && t.name) names.set(t.id, t.name);
    await new Promise(r => setTimeout(r, 700));
  }
  return bo3Games(matches, names);
}

// Refresh every sport we can; one failing source never blocks the others.
// LoL tries Leaguepedia, then lolesports; Valorant vlrggapi, then vlr.gg.
// With a PandaScore client, CoD gets ratings too and CS2/Valorant use its
// timestamped map results.
const firstOf = (...jobs) => async () => {
  let err = null;
  for (const job of jobs) {
    try { const g = await job(); if (g.length) return g; } catch (e) { err = e; }
  }
  if (err) throw err;
  return [];
};
async function refreshRatings(http, state, log = console, { panda = null } = {}) {
  const jobs = {
    LOL: firstOf(() => fetchLoLesportsGames(http), () => fetchLoLGames(http)),
    DOTA: () => fetchDotaGames(http),
    VAL: firstOf(() => fetchVlrGames(http), () => fetchValGames(http)),
    CS: () => fetchBo3Games(http),
  };
  if (panda) {
    const since = new Date(Date.now() - 180 * 86400000).toISOString();
    for (const sport of ['CS', 'VAL', 'COD']) { const free = jobs[sport]; jobs[sport] = free ? firstOf(() => panda.games(sport, { pages: 10, since }), free) : () => panda.games(sport, { pages: 10, since }); }
  }
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

module.exports = {
  fetchLoLGames, fetchDotaGames, fetchValGames, refreshRatings,
  lolesportsGames, fetchLoLesportsGames, vlrResultsGames, fetchVlrGames, bo3Games, fetchBo3Games,
};
