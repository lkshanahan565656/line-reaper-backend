// ─── FREE PLAYER STATS FOR PROPS, AND TEAM-VS-TEAM HISTORY ────────────────────
// The sources the props model used for LoL (Oracle's Elixir, Leaguepedia) and
// Valorant (the vlrggapi mirror) are dead or rate-limited, so those props had
// no projection. These read the same numbers from the public sites:
//   • LoL: gol.gg's season player list, one page with every pro's games,
//     kills, deaths, assists and kill participation per game.
//   • Valorant: vlr.gg's player page (60-day agent table: maps, rounds,
//     kills), found through vlr.gg's player search.
// Parsers are pure so they're tested against saved pages.
//
// Team-vs-team: the ratings refresh already pulls every team's recent map
// results; headToHead() turns them into the last meetings between two teams
// plus each team's recent form.

const { teamKey, teamsMatch } = require('./context');

const BROWSER = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36' };
const text = h => String(h ?? '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#0?39;|&apos;/g, "'").replace(/\s+/g, ' ').trim();
const num = v => { const n = parseFloat(String(v ?? '').replace(/[%,]/g, '')); return isFinite(n) ? n : null; };
const nameKey = n => String(n || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// ── LoL: gol.gg ──
// The season is the year minus 2010 (2026 is S16).
const golSeason = (now = Date.now()) => `S${new Date(now).getUTCFullYear() - 2010}`;

function parseGolPlayers(html) {
  const s = String(html || '');
  const start = s.indexOf('playerslist');
  if (start < 0) return {};
  const table = s.slice(start, s.indexOf('</table>', start));
  const head = [...table.slice(0, table.indexOf('</thead>')).matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map(m => text(m[1]).toLowerCase());
  const col = name => head.indexOf(name);
  const iG = col('games'), iK = col('avg kills'), iD = col('avg deaths'), iA = col('avg assists'), iKP = col('kp%');
  if (iG < 0 || iK < 0) return {};
  const out = {};
  for (const row of table.split(/<tr>/).slice(1)) {
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(m => m[1]);
    if (cells.length <= iK) continue;
    const name = text(cells[0]);
    const games = num(text(cells[iG]));
    const kpg = num(text(cells[iK]));
    if (!name || !games || kpg == null) continue;
    const key = nameKey(name);
    // a name shared by two players: keep the one with more games
    if (out[key] && out[key].games >= games) continue;
    out[key] = {
      name, games, kpg,
      dpg: iD >= 0 ? num(text(cells[iD])) : null,
      apg: iA >= 0 ? num(text(cells[iA])) : null,
      kp: iKP >= 0 ? (num(text(cells[iKP])) ?? 0) / 100 || null : null,
    };
  }
  return out;
}

async function fetchGolPlayers(http, { now = Date.now() } = {}) {
  const url = `https://gol.gg/players/list/season-${golSeason(now)}/split-ALL/tournament-ALL/`;
  const res = await http.get(url, { headers: BROWSER, timeout: 60000, responseType: 'text' });
  const players = parseGolPlayers(res?.data);
  if (!Object.keys(players).length) throw new Error('gol.gg: no player rows parsed');
  return players;
}

// ── Valorant: vlr.gg ──
function parseVlrSearch(html) {
  const out = [];
  for (const m of String(html || '').matchAll(/<a href="\/search\/r\/player\/(\d+)\/[^"]*"[^>]*>([\s\S]*?)<\/a>/g)) {
    const title = m[2].match(/<div class="search-item-title">([\s\S]*?)<\/div>/);
    if (title) out.push({ id: m[1], name: text(title[1]) });
  }
  return out;
}

function parseVlrPlayer(html) {
  const s = String(html || '');
  const cur = s.indexOf('Current Teams');
  let team = null;
  if (cur >= 0) {
    const card = s.slice(cur, s.indexOf('</a>', cur));
    const t = card.match(/<div style="font-weight: 500;">([\s\S]*?)<\/div>/);
    if (t) team = text(t[1]) || null;
  }
  const at = s.indexOf('mod-agent-rows');
  if (at < 0) return null;
  const table = s.slice(at, s.indexOf('</table>', at));
  const head = [...table.slice(0, table.indexOf('</thead>')).matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map(m => text(m[1]).toLowerCase());
  const iRnd = head.indexOf('rnd'), iK = head.indexOf('k'), iR = head.indexOf('r'), iAcs = head.indexOf('acs');
  if (iRnd < 0 || iK < 0) return null;
  let maps = 0, rounds = 0, kills = 0, ratingW = 0, acsW = 0;
  for (const row of table.split(/<tr>/).slice(2)) {
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(m => text(m[1]));
    if (cells.length <= iK) continue;
    const rnd = num(cells[iRnd]) || 0;
    maps += num((cells[1] || '').match(/\((\d+)\)/)?.[1]) || 0;
    rounds += rnd;
    kills += num(cells[iK]) || 0;
    ratingW += (num(cells[iR]) || 0) * rnd;
    acsW += (num(cells[iAcs]) || 0) * rnd;
  }
  if (!rounds) return null;
  return {
    team, maps, rounds, kills,
    kpr: kills / rounds,
    roundsPerMap: maps ? rounds / maps : null,
    avgKillsPerMap: maps ? kills / maps : null,
    rating: ratingW / rounds || null,
    acs: acsW / rounds || null,
  };
}

// Looks a player up on vlr.gg: search, then read up to three exact-name hits
// and keep the one on the line's team, else the one with the most rounds.
// Results (and misses) are cached so a refresh costs nothing once warm.
function createVlrStats({ http, ttlMs = 12 * 3600e3, missTtlMs = 3600e3, gapMs = 1200, now = () => Date.now() } = {}) {
  const cache = new Map();
  const health = { profiles: 0, misses: 0, lastError: null };
  let last = 0;
  async function get(url) {
    const wait = last + gapMs - now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    last = now();
    const res = await http.get(url, { headers: BROWSER, timeout: 20000, responseType: 'text' });
    return res?.data;
  }
  async function lookup(name, team = '') {
    const key = nameKey(name);
    if (!key) return null;
    const hit = cache.get(key);
    if (hit && now() - hit.at < (hit.stats ? ttlMs : missTtlMs)) return hit.stats;
    let stats = null;
    try {
      const found = parseVlrSearch(await get(`https://www.vlr.gg/search/?q=${encodeURIComponent(name)}&type=players`));
      const exact = found.filter(p => nameKey(p.name) === key).slice(0, 3);
      const pages = [];
      for (const p of exact) {
        const parsed = parseVlrPlayer(await get(`https://www.vlr.gg/player/${p.id}/?timespan=60d`));
        if (parsed) pages.push({ ...parsed, id: p.id, name: p.name });
        if (parsed && team && parsed.team && teamsMatch(parsed.team, team)) break;
      }
      const onTeam = team ? pages.find(p => p.team && teamsMatch(p.team, team)) : null;
      stats = onTeam || pages.sort((a, b) => b.rounds - a.rounds)[0] || null;
      if (stats && stats.maps < 3) stats = null;   // too little to project from
      if (stats) { stats = { ...stats, mapsPlayed: stats.maps, source: 'vlr', lastUpdate: now() }; health.profiles++; } else health.misses++;
    } catch (e) {
      health.lastError = `${name}: ${e.response?.status || e.message}`;
    }
    cache.set(key, { stats, at: now() });
    return stats;
  }
  return { lookup, health, cache };
}

// ── team-vs-team ──
// Index map-level games ({ a, b, aWon, t }) by team so lookups stay cheap.
function indexGames(games) {
  const byTeam = new Map();
  for (const g of games || []) {
    for (const side of [g.a, g.b]) {
      const k = teamKey(side);
      if (!k) continue;
      if (!byTeam.has(k)) byTeam.set(k, []);
      byTeam.get(k).push(g);
    }
  }
  const keys = [...byTeam.keys()];
  const resolved = new Map();
  function resolve(name) {
    const k = teamKey(name);
    if (!k) return null;
    if (resolved.has(k)) return resolved.get(k);
    const hit = byTeam.has(k) ? k : keys.find(x => teamsMatch(x, k)) || null;
    resolved.set(k, hit);
    return hit;
  }
  return { byTeam, resolve, size: keys.length };
}

// Maps from one series share a timestamp (or sit within hours of each other),
// so consecutive maps between the same pair inside 8 hours are one series.
function groupSeries(games, key) {
  const sorted = games.slice().sort((x, y) => (y.t || 0) - (x.t || 0));
  const out = [];
  for (const g of sorted) {
    const mine = teamKey(g.a) === key;
    const opp = mine ? g.b : g.a;
    const won = mine ? g.aWon : !g.aWon;
    const prev = out[out.length - 1];
    if (prev && teamKey(prev.opponent) === teamKey(opp) && Math.abs((prev.t || 0) - (g.t || 0)) < 8 * 3600e3) {
      prev[won ? 'maps' : 'oppMaps']++;
    } else out.push({ opponent: opp, t: g.t || 0, maps: won ? 1 : 0, oppMaps: won ? 0 : 1 });
  }
  return out;
}

function headToHead(index, teamA, teamB, { meetings = 5, form = 10 } = {}) {
  if (!index) return null;
  const a = index.resolve(teamA), b = index.resolve(teamB);
  if (!a && !b) return null;
  const formOf = key => {
    if (!key) return null;
    const series = groupSeries(index.byTeam.get(key) || [], key).slice(0, form);
    if (!series.length) return null;
    const won = series.filter(s => s.maps > s.oppMaps).length;
    const maps = series.reduce((s, x) => s + x.maps, 0), mapsLost = series.reduce((s, x) => s + x.oppMaps, 0);
    return { series: series.length, won, lost: series.length - won, maps, mapsLost, last: series.slice(0, 5).map(s => (s.maps > s.oppMaps ? 'W' : s.maps < s.oppMaps ? 'L' : 'D')) };
  };
  let h2h = [];
  if (a && b) {
    h2h = groupSeries((index.byTeam.get(a) || []).filter(g => teamKey(g.a) === b || teamKey(g.b) === b), a)
      .slice(0, meetings)
      .map(s => ({ date: s.t ? new Date(s.t).toISOString().slice(0, 10) : null, score: [s.maps, s.oppMaps] }));
  }
  const wins = h2h.filter(m => m.score[0] > m.score[1]).length;
  return {
    meetings: h2h,
    record: h2h.length ? [wins, h2h.filter(m => m.score[0] < m.score[1]).length] : null,
    maps: h2h.length ? [h2h.reduce((s, m) => s + m.score[0], 0), h2h.reduce((s, m) => s + m.score[1], 0)] : null,
    form: [formOf(a), formOf(b)],
  };
}

module.exports = {
  golSeason, parseGolPlayers, fetchGolPlayers,
  parseVlrSearch, parseVlrPlayer, createVlrStats,
  indexGames, groupSeries, headToHead, nameKey,
};
