// ─── RESULT GRADERS ───────────────────────────────────────────────────────────
// One function per sport: given a tracked pick, return the player's stat for
// each map of the series that started at pick.startTime:
//   { maps: { 1: 4, 2: 7 }, complete: true }   or   null (nothing found yet)
//
// LoL  → Leaguepedia Cargo (ScoreboardPlayers + ScoreboardGames, grouped by MatchId)
// Dota → OpenDota (player's recent pro matches, grouped by a ≤90 min gap)
// CS / Valorant have no stable public results API we can call from a server
// (HLTV blocks datacenter IPs, bo3.gg's schema is undocumented), so those land
// in the review queue for a one-click manual result until we add a feed.

const LP_API = 'https://lol.fandom.com/api.php';
const LP_HEADERS = { 'User-Agent': 'LineReaper/4.0 (pick grading)', 'Accept': 'application/json' };

const iso = ms => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
const cargoStr = s => String(s || '').replace(/'/g, "\\'");

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

function createLoLGrader(http) {
  return async function gradeLoL(pick) {
    const start = new Date(pick.startTime).getTime();
    const name = cargoStr(pick.player);
    const params = {
      action: 'cargoquery', format: 'json', limit: '20',
      tables: 'ScoreboardPlayers=SP,ScoreboardGames=SG',
      join_on: 'SP.GameId=SG.GameId',
      fields: 'SP.Link=Link,SP.Kills=Kills,SP.Assists=Assists,SG.MatchId=MatchId,SG.N_GameInMatch=GameN,SG.DateTime_UTC=DateTime',
      where: `(SP.Link='${name}' OR SP.Link LIKE '${name} (%') AND SG.DateTime_UTC >= '${iso(start - 3600000)}' AND SG.DateTime_UTC <= '${iso(start + 12 * 3600000)}'`,
      order_by: 'SG.DateTime_UTC ASC',
    };
    const res = await http.get(LP_API, { params, headers: LP_HEADERS, timeout: 20000 });
    if (res.data?.error) throw new Error('Cargo: ' + JSON.stringify(res.data.error).slice(0, 160));
    const rows = (res.data?.cargoquery || []).map(r => r.title || r);
    const out = lolMapsFromRows(rows, pick.stat);
    if (!out) return null;
    // Twelve hours past kickoff with no newer match, the series is certainly over.
    if (Date.now() - start > 12 * 3600000) out.complete = true;
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

module.exports = { createLoLGrader, createDotaGrader, lolMapsFromRows, dotaMapsFromMatches };
