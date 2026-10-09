// ─── MORE DATA SOURCES ────────────────────────────────────────────────────────
// Two feeds that close the biggest esports gaps. Each is off until its key is
// set, and every parser is a pure function so it is tested on sample payloads.
//
// PandaScore (PANDASCORE_TOKEN, developers.pandascore.co)
//   • Map results for CS2, Valorant, CoD, LoL and Dota → team Elo. This is the
//     first automatic rating source for CS2 and CoD, so their picks get match
//     context without anyone typing in a price.
//   • Upcoming matches → best-of for every series (Bo1 / Bo3 / Bo5).
//   • Per-map player stats → automatic grading for CS2, Valorant and CoD picks,
//     which until now went to the "needs a result" list. Player stats need a
//     PandaScore plan that includes them; on the free plan the grader finds
//     no stats and those picks still go to the manual list.
//
// Pinnacle esports moneylines (PINNACLE_GUEST_KEY)
//   • The sharpest esports market, used as the match price for context in every
//     game. Read from Pinnacle's public guest odds API, which is not a licensed
//     data feed: check Pinnacle's terms before using it in a paid product.

const { teamsMatch } = require('./context');

const PANDA = 'https://api.pandascore.co';
const PIN = 'https://guest.api.arcadia.pinnacle.com/0.1';
const PIN_ESPORTS = 12;

// our sport keys → PandaScore videogame slugs
const PANDA_GAMES = { CS: 'csgo', VAL: 'valorant', COD: 'codmw', LOL: 'lol', DOTA: 'dota2' };

const teamName = o => o?.opponent?.name || o?.name || null;

// ── PandaScore: finished matches → map-level games for buildElo ──
// match: { begin_at, opponents: [{ opponent: { id, name } }], games: [{ position, winner: { id }, forfeit, begin_at }] }
function pandaGamesFromMatches(matches) {
  const out = [];
  for (const m of matches || []) {
    const [A, B] = (m.opponents || []).map(o => o.opponent || o);
    if (!A?.name || !B?.name || A.id === B.id) continue;
    const t0 = Date.parse(m.begin_at || m.scheduled_at || '') || 0;
    for (const g of m.games || []) {
      if (g.forfeit || !g.winner || g.winner.id == null) continue;   // forfeits say nothing about strength
      if (g.winner.id !== A.id && g.winner.id !== B.id) continue;
      const t = Date.parse(g.begin_at || '') || t0 + (g.position || 0) * 60000;
      out.push({ a: A.name, b: B.name, aWon: g.winner.id === A.id, t });
    }
  }
  return out;
}

// ── PandaScore: upcoming matches → { teamA, teamB, bestOf, start } ──
function pandaSchedule(matches) {
  return (matches || []).map(m => {
    const [a, b] = (m.opponents || []).map(teamName);
    const n = parseInt(m.number_of_games);
    return {
      id: m.id, teamA: a, teamB: b, start: m.begin_at || m.scheduled_at || null,
      bestOf: m.match_type === 'best_of' || !m.match_type ? (n > 0 ? n : null) : null,
      league: m.league?.name || null,
    };
  }).filter(x => x.teamA && x.teamB);
}

function bestOfFor(schedule, teamA, teamB) {
  const hit = (schedule || []).find(s =>
    (teamsMatch(s.teamA, teamA) && teamsMatch(s.teamB, teamB)) || (teamsMatch(s.teamA, teamB) && teamsMatch(s.teamB, teamA)));
  return hit?.bestOf || null;
}

// ── PandaScore: one game's detail → the player's stat on that map ──
// Shapes differ by title and plan, so look anywhere in the game for a row that
// names the player and carries the stat.
const pkey = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
function playerStatFromGame(game, player, stat = 'kills') {
  const want = pkey(player);
  if (!want) return null;
  const field = stat === 'assists' ? 'assists' : stat === 'headshots' ? 'headshots' : 'kills';
  let found = null;
  const seen = new Set();
  (function walk(x, depth) {
    if (found != null || !x || typeof x !== 'object' || depth > 6 || seen.has(x)) return;
    seen.add(x);
    if (Array.isArray(x)) { for (const y of x) walk(y, depth + 1); return; }
    const name = x.player?.name ?? x.name ?? x.player_name ?? x.nickname;
    const stats = x.stats && typeof x.stats === 'object' ? x.stats : x;
    const v = stats[field] ?? stats.counts?.[field] ?? stats.kills_counts?.[field];
    if (name != null && pkey(name) === want && isFinite(parseFloat(v))) { found = parseFloat(v); return; }
    for (const k of Object.keys(x)) walk(x[k], depth + 1);
  })(game, 0);
  return found;
}

// Series in `matches` this pick could belong to, closest start first: the
// player's team (or any team, when the pick has none) within 3 hours of start.
function findSeries(matches, pick) {
  const start = Date.parse(pick.startTime);
  return (matches || []).map(m => ({ m, gap: Math.abs(Date.parse(m.begin_at || m.scheduled_at || '') - start) }))
    .filter(({ m, gap }) => gap <= 3 * 3600000 &&
      (!pick.team || (m.opponents || []).map(teamName).some(n => teamsMatch(n, pick.team))))
    .sort((a, b) => a.gap - b.gap).map(x => x.m);
}

function createPandaScoreClient(http, token, { log = console } = {}) {
  const get = async (path, params = {}) => {
    const res = await http.get(`${PANDA}${path}`, {
      params, headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, timeout: 20000,
    });
    return res.data;
  };

  async function pastMatches(sport, { pages = 5, since } = {}) {
    const slug = PANDA_GAMES[sport];
    if (!slug) return [];
    const rows = [];
    for (let page = 1; page <= pages; page++) {
      const params = { sort: '-begin_at', 'page[size]': 100, 'page[number]': page };
      if (since) params['range[begin_at]'] = `${since},${new Date().toISOString()}`;
      const batch = await get(`/${slug}/matches/past`, params);
      if (!Array.isArray(batch) || !batch.length) break;
      rows.push(...batch);
      if (batch.length < 100) break;
    }
    return rows;
  }

  async function games(sport, opts) { return pandaGamesFromMatches(await pastMatches(sport, opts)); }

  async function upcoming(sport) {
    const slug = PANDA_GAMES[sport];
    if (!slug) return [];
    const batch = await get(`/${slug}/matches/upcoming`, { sort: 'begin_at', 'page[size]': 100 });
    return pandaSchedule(Array.isArray(batch) ? batch : []);
  }

  // Grader in the tracker's shape: { maps: { 1: 18, 2: 22 }, complete } or null
  function grader(sport) {
    const slug = PANDA_GAMES[sport];
    return async function gradePanda(pick) {
      const start = Date.parse(pick.startTime);
      const from = new Date(start - 3 * 3600000).toISOString(), to = new Date(start + 12 * 3600000).toISOString();
      const matches = await get(`/${slug}/matches`, { 'range[begin_at]': `${from},${to}`, 'page[size]': 100 });
      // Without a team, try each nearby series until one has this player in it.
      for (const m of findSeries(Array.isArray(matches) ? matches : [], pick).slice(0, pick.team ? 1 : 4)) {
        const maps = {};
        for (const g of (m.games || []).slice().sort((a, b) => a.position - b.position)) {
          if (!g.finished && g.status !== 'finished') continue;
          let detail = g;
          if (playerStatFromGame(detail, pick.player, pick.stat) == null) {
            try { detail = await get(`/${slug}/games/${g.id}`); }
            catch (e) { log.warn?.(`PandaScore: game ${g.id} detail failed: ${e.response?.status || e.message}`); }
          }
          const v = playerStatFromGame(detail, pick.player, pick.stat);
          if (v != null) maps[g.position] = v;
        }
        if (Object.keys(maps).length || pick.team) return { maps, complete: m.status === 'finished' };
      }
      return null;
    };
  }

  return { pastMatches, games, upcoming, grader };
}

// ── Pinnacle: esports matchups + straight markets → series prices ──
// matchups: [{ id, parentId, league: { name }, participants: [{ alignment, name }], startTime, type }]
// markets:  [{ matchupId, period, type: 'moneyline', status, isAlternate, prices: [{ designation, price }] }]
function pinnacleSport(leagueName) {
  const s = String(leagueName || '').toLowerCase();
  if (/^(cs2|cs:go|counter-strike)/.test(s)) return 'CS';
  if (s.startsWith('valorant')) return 'VAL';
  if (s.startsWith('league of legends') || s.startsWith('lol')) return 'LOL';
  if (s.startsWith('dota')) return 'DOTA';
  if (s.startsWith('call of duty') || s.startsWith('cod')) return 'COD';
  return null;
}

function pinnacleMatchPrices(matchups, markets) {
  const ml = new Map(), maxPeriod = new Map();
  for (const k of markets || []) {
    if (k.type !== 'moneyline' || k.isAlternate) continue;
    maxPeriod.set(k.matchupId, Math.max(maxPeriod.get(k.matchupId) || 0, k.period || 0));
    if (k.period === 0 && (k.status || 'open') === 'open') ml.set(k.matchupId, k);
  }
  const out = [];
  for (const m of matchups || []) {
    if (m.parentId != null || (m.type && m.type !== 'matchup') || m.isLive) continue;
    const sport = pinnacleSport(m.league?.name);
    const k = ml.get(m.id);
    if (!sport || !k) continue;
    const home = m.participants?.find(p => p.alignment === 'home'), away = m.participants?.find(p => p.alignment === 'away');
    const ph = k.prices?.find(p => p.designation === 'home')?.price, pa = k.prices?.find(p => p.designation === 'away')?.price;
    if (!home?.name || !away?.name || ph == null || pa == null) continue;
    // per-map moneylines on periods 4-5 only exist in a best-of-5
    const mp = maxPeriod.get(m.id) || 0;
    out.push({
      sport, teamA: home.name, teamB: away.name, priceA: ph, priceB: pa,
      bestOf: mp >= 4 ? 5 : null, start: m.startTime || null, league: m.league?.name || null, source: 'pinnacle',
    });
  }
  return out;
}

async function fetchPinnacleEsports(http, key) {
  const headers = { 'X-API-Key': key, Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' };
  const [mu, mk] = await Promise.all([
    http.get(`${PIN}/sports/${PIN_ESPORTS}/matchups`, { headers, timeout: 20000 }),
    http.get(`${PIN}/sports/${PIN_ESPORTS}/markets/straight`, { headers, timeout: 20000 }),
  ]);
  return pinnacleMatchPrices(mu.data, mk.data);
}

// Load every Pinnacle price into the odds book, taking best-of from the
// PandaScore schedule when Pinnacle doesn't say. Returns how many were set.
function loadMatchPrices(oddsBook, prices, schedules = {}) {
  let n = 0;
  for (const p of prices) {
    const bestOf = p.bestOf || bestOfFor(schedules[p.sport], p.teamA, p.teamB) || 3;
    try { oddsBook.set({ ...p, bestOf }); n++; } catch { /* a price that doesn't devig */ }
  }
  return n;
}

module.exports = {
  PANDA_GAMES, pandaGamesFromMatches, pandaSchedule, bestOfFor, playerStatFromGame, findSeries,
  createPandaScoreClient, pinnacleSport, pinnacleMatchPrices, fetchPinnacleEsports, loadMatchPrices,
};
