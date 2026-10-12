// ─── RESULT GRADERS ───────────────────────────────────────────────────────────
// One function per sport: given a tracked pick, return the player's stat for
// each map of the series that started at pick.startTime:
//   { maps: { 1: 4, 2: 7 }, complete: true }   or   null (nothing found yet)
//
// LoL  → Leaguepedia Cargo (ScoreboardPlayers + ScoreboardGames, grouped by MatchId)
// Dota → OpenDota (player's recent pro matches, grouped by a ≤90 min gap)
// CS   → bo3.gg (finished matches near kickoff, then each map's player stats:
//         kills, headshots, assists). Free, no key; HLTV blocks datacenter IPs.
// Valorant and CoD land in the review queue for a one-click manual result
// unless PANDASCORE_TOKEN is set.

const LP_API = 'https://lol.fandom.com/api.php';
const LP_HEADERS = { 'User-Agent': 'LineReaper/4.0 (pick grading)', 'Accept': 'application/json' };

const iso = ms => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

// Pure: Leaguepedia rows → per-map stat for the FIRST match after kickoff.
// rows: [{ Link, Kills, Assists, MatchId, GameN, DateTime }]
function lolMapsFromRows(rows, stat) {
  if (!rows?.length) return null;
  const sorted = rows.slice().sort((a, b) => String(a.DateTime).localeCompare(String(b.DateTime)));
  const matchId = sorted[0].MatchId;
  const maps = {};
  let n = 0;
  for (const r of sorted) {
    if (r.MatchId !== matchId) continue;
    n++;
    const g = parseInt(r.GameN) || n;
    const v = parseFloat(stat === 'assists' ? r.Assists : r.Kills);
    if (isFinite(v)) maps[g] = v;
  }
  // Another match for this player after the first one means the series is over.
  const complete = sorted.some(r => r.MatchId !== matchId);
  return { maps, complete, matchId };
}

// Leaguepedia's link for a player is the name, or the name and a
// disambiguation in brackets ("Angel (Xiang Tao)").
const lpName = link => String(link || '').replace(/\s*\(.*\)\s*$/, '').trim().toLowerCase();

// One Cargo query per kickoff (every player's games from an hour before to
// twelve after), shared by every pick on that start for ttlMs: a Worlds
// series has ten players with picks, and Leaguepedia rate-limits anonymous
// queries, so one call a player starved most of them.
function createLoLGrader(http, { ttlMs = 10 * 60e3, now = () => Date.now() } = {}) {
  const cache = new Map();   // start ms → { at, rows }
  async function rowsNear(start) {
    const hit = cache.get(start);
    if (hit && now() - hit.at < ttlMs) return hit.rows;
    const params = {
      action: 'cargoquery', format: 'json', limit: '500',
      tables: 'ScoreboardPlayers=SP,ScoreboardGames=SG',
      join_on: 'SP.GameId=SG.GameId',
      fields: 'SP.Link=Link,SP.Kills=Kills,SP.Assists=Assists,SG.MatchId=MatchId,SG.N_GameInMatch=GameN,SG.DateTime_UTC=DateTime',
      where: `SG.DateTime_UTC >= '${iso(start - 3600000)}' AND SG.DateTime_UTC <= '${iso(start + 12 * 3600000)}'`,
      order_by: 'SG.DateTime_UTC ASC',
    };
    const res = await http.get(LP_API, { params, headers: LP_HEADERS, timeout: 20000 });
    if (res.data?.error) throw new Error('Cargo: ' + JSON.stringify(res.data.error).slice(0, 160));
    const rows = (res.data?.cargoquery || []).map(r => r.title || r);
    cache.set(start, { at: now(), rows });
    for (const [k, v] of cache) if (now() - v.at >= ttlMs) cache.delete(k);
    return rows;
  }
  return async function gradeLoL(pick) {
    const start = new Date(pick.startTime).getTime();
    const name = String(pick.player || '').trim().toLowerCase();
    const rows = (await rowsNear(start)).filter(r => lpName(r.Link) === name);
    const out = lolMapsFromRows(rows, pick.stat);
    if (!out) return null;
    // Twelve hours past kickoff with no newer match, the series is certainly over.
    if (now() - start > 12 * 3600000) out.complete = true;
    return out;
  };
}

// Pure: OpenDota match list → per-map stat for the series starting near kickoff.
// matches: [{ start_time (unix s), duration (s), kills, assists }]
function dotaMapsFromMatches(matches, startMs, stat) {
  const startS = startMs / 1000;
  const games = (matches || [])
    .filter(m => m && isFinite(m.start_time) && m.start_time >= startS - 1800 && m.start_time <= startS + 10 * 3600)
    .sort((a, b) => a.start_time - b.start_time);
  if (!games.length) return null;
  const maps = {};
  let prevEnd = null, n = 0, complete = false;
  for (const g of games) {
    // A gap of more than 90 minutes between games means a different series.
    if (prevEnd != null && g.start_time - prevEnd > 90 * 60) { complete = true; break; }
    n++;
    const v = stat === 'assists' ? g.assists : g.kills;
    if (isFinite(v)) maps[n] = v;
    prevEnd = g.start_time + (g.duration || 0);
  }
  return { maps, complete };
}

function createDotaGrader(http, resolveAccountId) {
  return async function gradeDota(pick) {
    const accountId = await resolveAccountId(pick.player);
    if (!accountId) return null;
    const start = new Date(pick.startTime).getTime();
    const days = Math.max(1, Math.ceil((Date.now() - start) / 86400000) + 1);
    const res = await http.get(`https://api.opendota.com/api/players/${accountId}/matches`, {
      params: { date: days, significant: 0 }, timeout: 20000,
    });
    const out = dotaMapsFromMatches(Array.isArray(res.data) ? res.data : [], start, pick.stat);
    if (!out) return null;
    if (Date.now() - start > 10 * 3600000) out.complete = true;
    return out;
  };
}

// ─── CS via bo3.gg ────────────────────────────────────────────────────────────
const BO3_API = 'https://api.bo3.gg/api/v1';
const BO3_HEADERS = { origin: 'https://bo3.gg', referer: 'https://bo3.gg/', 'User-Agent': 'Mozilla/5.0 (LineReaper pick grading)', Accept: 'application/json' };
const squash = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const bo3Ms = v => { const t = Date.parse(v); return Number.isFinite(t) ? t : null; };

// Pure: the names a bo3 match's teams go by, from its games' clans
function bo3TeamNames(match) {
  const out = new Set();
  for (const g of match?.games || []) {
    for (const side of [g.winner_team_clan, g.loser_team_clan]) {
      for (const v of [side?.clan_name, side?.team?.name, side?.team?.slug, side?.team?.acronym]) if (squash(v)) out.add(squash(v));
    }
    for (const v of [g.winner_clan_name, g.loser_clan_name]) if (squash(v)) out.add(squash(v));
  }
  return out;
}
// Pure: does a pick's team name this match? Either name may be the short one
// ("NPG" / "Nordic Partners Gaming", "Vitality" / "Team Vitality").
function bo3TeamMatch(match, team) {
  const t = squash(team);
  if (t.length < 2) return false;
  for (const n of bo3TeamNames(match)) {
    if (n === t) return true;
    if (Math.min(n.length, t.length) >= 4 && (n.includes(t) || t.includes(n))) return true;
  }
  return false;
}
// Pure: finished matches that could be the pick's, best first: its team's,
// then the nearest start. Within windowMs of kickoff.
function bo3Candidates(matches, pick, { windowMs = 3 * 3600e3 } = {}) {
  const start = Date.parse(pick.startTime);
  return (matches || [])
    .map(m => ({ m, gap: Math.abs((bo3Ms(m.start_date) ?? Infinity) - start), team: bo3TeamMatch(m, pick.team) }))
    .filter(x => x.gap <= windowMs && x.m.status === 'finished' && (x.m.games || []).length)
    .sort((a, b) => (b.team - a.team) || (a.gap - b.gap));
}
// Pure: one map's player rows → the pick's player stat, or undefined when
// the player isn't in them
const BO3_STAT = { kills: 'kills', headshots: 'headshots', assists: 'assists', deaths: 'death' };
function bo3PlayerStat(rows, player, stat) {
  const want = squash(player), key = BO3_STAT[stat] || 'kills';
  const row = (rows || []).find(r => [r?.steam_profile?.player?.nickname, r?.steam_profile?.player?.slug, r?.steam_profile?.nickname].some(n => squash(n) === want));
  if (!row) return undefined;
  const v = Number(row[key]);
  return Number.isFinite(v) ? v : undefined;
}

// The finished CS matches list is shared by every pick for ttlMs (pages of
// 100, newest first, back to the oldest kickoff asked for); each map's stats
// are kept once bo3 has them (they appear when the demo is parsed, a while
// after the map). The series is complete when every map it played has stats.
function createCsGrader(http, { ttlMs = 5 * 60e3, maxPages = 4, now = () => Date.now(), pause = 300 } = {}) {
  let list = { at: 0, rows: [], oldest: Infinity };
  const maps = new Map();   // game id → player rows
  const wait = ms => (ms > 0 ? new Promise(r => setTimeout(r, ms)) : null);
  async function matchesSince(from) {
    if (now() - list.at < ttlMs && list.oldest <= from) return list.rows;
    const rows = [];
    let oldest = Infinity;
    for (let page = 0; page < maxPages && oldest > from; page++) {
      const res = await http.get(`${BO3_API}/matches`, { headers: BO3_HEADERS, timeout: 20000, params: {
        'page[offset]': page * 100, 'page[limit]': 100, sort: '-start_date', with: 'games',
        'filter[matches.status][in]': 'finished', 'filter[matches.discipline_id][eq]': 1,
      } });
      const got = Array.isArray(res.data?.results) ? res.data.results : [];
      rows.push(...got);
      if (got.length < 100) { oldest = -Infinity; break; }
      oldest = Math.min(oldest, ...got.map(m => bo3Ms(m.start_date) ?? Infinity));
      await wait(pause);
    }
    list = { at: now(), rows, oldest };
    return rows;
  }
  async function mapRows(id) {
    if (maps.has(id)) return maps.get(id);
    const res = await http.get(`${BO3_API}/games/${id}/players_stats`, { headers: BO3_HEADERS, timeout: 20000 });
    const rows = Array.isArray(res.data) ? res.data : Array.isArray(res.data?.results) ? res.data.results : [];
    if (rows.length) maps.set(id, rows);
    while (maps.size > 2000) maps.delete(maps.keys().next().value);
    await wait(pause);
    return rows;
  }
  return async function gradeCs(pick) {
    const start = Date.parse(pick.startTime);
    if (!Number.isFinite(start)) return null;
    const cands = bo3Candidates(await matchesSince(start - 3 * 3600e3), pick);
    // the team's match first; with no team match, the nearest few by start
    const tryList = cands.some(c => c.team) ? cands.filter(c => c.team) : cands.slice(0, 4);
    for (const { m } of tryList) {
      const out = {};
      let found = false, parsed = 0;
      const games = m.games.slice().sort((a, b) => (a.number || 0) - (b.number || 0));
      for (const g of games) {
        const rows = await mapRows(g.id);
        if (!rows.length) continue;
        parsed++;
        const v = bo3PlayerStat(rows, pick.player, pick.stat);
        if (v === undefined) continue;
        found = true;
        out[g.number || parsed] = v;
      }
      if (found) return { maps: out, complete: parsed === games.length, matchId: m.slug || m.id };
    }
    return null;
  };
}

module.exports = { createLoLGrader, createDotaGrader, createCsGrader, lolMapsFromRows, dotaMapsFromMatches, lpName, bo3TeamMatch, bo3Candidates, bo3PlayerStat };
