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

// ─── LoL via lolesports (Riot's own feed) ─────────────────────────────────────
// Leaguepedia rate-limits shared IPs hard (Railway and GitHub runners alike),
// so the main LoL source is the feed lolesports.com itself uses: the schedule
// finds the match, getEventDetails lists its games, and the live-stats window
// read after a game ends holds every player's final kills and assists.
// Covers the leagues lolesports lists (Worlds, LCK, LPL, LEC, LCS, CBLOL, ...);
// anything else falls back to Leaguepedia.
const LOLE_API = 'https://esports-api.lolesports.com/persisted/gw';
const LOLE_FEED = 'https://feed.lolesports.com/livestats/v1/window';
const LOLE_HEADERS = { 'x-api-key': '0TvQnueqKa5mxJntVWt0w4LpLfEkrV1Ta8rQBb9Z', 'User-Agent': 'Mozilla/5.0 (LineReaper pick grading)' };

// Pure: schedule events → the pick's match (completed or not), nearest start
// within windowMs (Underdog has listed a Worlds match three hours late),
// preferring one with the pick's team.
function loleMatchFor(events, pick, { windowMs = 6 * 3600e3 } = {}) {
  const start = Date.parse(pick.startTime);
  const teams = pickTeams(pick).map(squash);
  const hasTeam = e => (e.match?.teams || []).some(t => [t.name, t.code].some(n => {
    const q = squash(n);
    return q && teams.some(w => w === q || (Math.min(w.length, q.length) >= 4 && (w.includes(q) || q.includes(w))));
  }));
  const c = (events || [])
    .filter(e => e?.type === 'match' && e.match?.id && Math.abs(Date.parse(e.startTime) - start) <= windowMs)
    .map(e => ({ e, gap: Math.abs(Date.parse(e.startTime) - start), team: hasTeam(e) }))
    .sort((a, b) => (b.team - a.team) || (a.gap - b.gap));
  return teams.length ? (c.find(x => x.team)?.e || null) : (c[0]?.e || null);
}
// Pure: a finished game's last window frame → the player's stat, matching
// "VITLyncas" (team code + name) or the bare name.
function loleStatFromWindow(data, player, stat) {
  const frames = data?.frames || [];
  const last = frames[frames.length - 1];
  if (!last || last.gameState !== 'finished') return undefined;
  const want = squash(player);
  const meta = [...(data.gameMetadata?.blueTeamMetadata?.participantMetadata || []), ...(data.gameMetadata?.redTeamMetadata?.participantMetadata || [])];
  const hit = meta.find(m => squash(m.summonerName) === want)
    || meta.find(m => want.length >= 3 && squash(m.summonerName).endsWith(want) && squash(m.summonerName).length - want.length <= 5);
  if (!hit) return undefined;
  const row = [...(last.blueTeam?.participants || []), ...(last.redTeam?.participants || [])].find(p => p.participantId === hit.participantId);
  const v = Number(stat === 'assists' ? row?.assists : row?.kills);
  return Number.isFinite(v) ? v : undefined;
}

function createLoLesportsGrader(http, { ttlMs = 10 * 60e3, now = () => Date.now() } = {}) {
  let sched = { at: 0, events: [], from: Infinity };   // from: the oldest start the pages reach
  const windows = new Map();   // game id → final window (kept once finished)
  async function schedule(oldest) {
    if (now() - sched.at < ttlMs && sched.from <= oldest) return sched.events;
    const events = [];
    let token = null, from = Infinity;
    for (let page = 0; page < 4; page++) {
      const res = await http.get(`${LOLE_API}/getSchedule`, { params: { hl: 'en-US', ...(token ? { pageToken: token } : {}) }, headers: LOLE_HEADERS, timeout: 20000 });
      const sc = res.data?.data?.schedule;
      events.push(...(sc?.events || []));
      token = sc?.pages?.older;
      from = token ? Math.min(...events.map(e => Date.parse(e.startTime) || Infinity)) : -Infinity;
      if (from <= oldest) break;
    }
    sched = { at: now(), events, from };
    return events;
  }
  async function finalWindow(gameId, startMs) {
    if (windows.has(gameId)) return windows.get(gameId);
    // A starting time past the game's end returns its last frames; it must be
    // a multiple of 10 seconds and not in the future.
    const t = Math.floor(Math.min(now() - 60e3, startMs + 14 * 3600e3) / 10000) * 10000;
    const res = await http.get(`${LOLE_FEED}/${gameId}`, { params: { startingTime: new Date(t).toISOString() }, headers: { 'User-Agent': LOLE_HEADERS['User-Agent'] }, timeout: 20000 });
    const frames = res.data?.frames || [];
    if (frames[frames.length - 1]?.gameState === 'finished') windows.set(gameId, res.data);
    while (windows.size > 500) windows.delete(windows.keys().next().value);
    return res.data;
  }
  return async function gradeLoLesports(pick) {
    const start = Date.parse(pick.startTime);
    if (!Number.isFinite(start)) return null;
    const ev = loleMatchFor(await schedule(start - 6 * 3600e3), pick);
    if (!ev) return null;
    const det = await http.get(`${LOLE_API}/getEventDetails`, { params: { hl: 'en-US', id: ev.match.id }, headers: LOLE_HEADERS, timeout: 20000 });
    const games = (det.data?.data?.event?.match?.games || []).filter(g => g.state === 'completed');
    const maps = {};
    let found = false;
    for (const g of games) {
      const v = loleStatFromWindow(await finalWindow(g.id, start), pick.player, pick.stat);
      if (v === undefined) continue;
      maps[g.number] = v; found = true;
    }
    if (!found) return null;
    return { maps, complete: ev.state === 'completed', matchId: ev.match.id };
  };
}

// LoL: lolesports first, Leaguepedia when lolesports has no such match.
function createLoLGraderChain(...graders) {
  return async function gradeLoLChain(pick) {
    let lastErr = null;
    for (const g of graders) {
      try { const r = await g(pick); if (r) return r; }
      catch (e) { lastErr = e; }
    }
    if (lastErr) throw lastErr;
    return null;
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
const { pickOpponent } = require('./esmatch');
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
// Pure: the teams a pick could be on: its own, else both from the book's
// match title ("Nuclear TigeRES vs XI Esport").
function pickTeams(pick) {
  if (squash(pick.team).length >= 2) return [pick.team];
  return String(pick.matchTitle || '').split(/\s+(?:vs\.?|v|@|at)\s+/i).map(s => s.trim()).filter(s => squash(s).length >= 2);
}
// Pure: finished matches that could be the pick's, best first: its team's,
// then the nearest start. Within windowMs of kickoff.
// A team in three Bo1s a day has three matches inside the window: the one
// against the pick's opponent (Underdog's "A vs B", PrizePicks' "ENCE MAP 1")
// goes first, so a kill line isn't graded on another opponent's map.
function bo3Candidates(matches, pick, { windowMs = 3 * 3600e3 } = {}) {
  const start = Date.parse(pick.startTime);
  const teams = pickTeams(pick);
  const opp = squash(pick.team).length >= 2 ? pickOpponent(pick) : null;
  return (matches || [])
    .map(m => {
      const team = teams.some(t => bo3TeamMatch(m, t));
      return { m, gap: Math.abs((bo3Ms(m.start_date) ?? Infinity) - start), team, opp: team && !!opp && bo3TeamMatch(m, opp) };
    })
    .filter(x => x.gap <= windowMs && x.m.status === 'finished' && (x.m.games || []).length)
    .sort((a, b) => (b.team - a.team) || (b.opp - a.opp) || (a.gap - b.gap));
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
//
// bo3 only parses demos for some matches: lower-tier ones keep empty stats
// for good. When the pick's own match is over by more than giveUpMs and no
// map has stats, the grader says so ({ unavailable }) and the tracker voids
// the pick instead of holding it for three days and calling it a review.
function createCsGrader(http, { ttlMs = 5 * 60e3, emptyTtlMs = 30 * 60e3, giveUpMs = 18 * 3600e3, maxPages = 4, now = () => Date.now(), pause = 300 } = {}) {
  let list = { at: 0, rows: [], oldest: Infinity };
  const maps = new Map();    // game id → player rows
  const empty = new Map();   // game id → ms we last saw no rows (not asked again for emptyTtlMs)
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
    if (now() - (empty.get(id) || -Infinity) < emptyTtlMs) return [];
    const res = await http.get(`${BO3_API}/games/${id}/players_stats`, { headers: BO3_HEADERS, timeout: 20000 });
    const rows = Array.isArray(res.data) ? res.data : Array.isArray(res.data?.results) ? res.data.results : [];
    if (rows.length) { maps.set(id, rows); empty.delete(id); } else empty.set(id, now());
    while (maps.size > 2000) maps.delete(maps.keys().next().value);
    while (empty.size > 4000) empty.delete(empty.keys().next().value);
    await wait(pause);
    return rows;
  }
  return async function gradeCs(pick) {
    const start = Date.parse(pick.startTime);
    if (!Number.isFinite(start)) return null;
    const cands = bo3Candidates(await matchesSince(start - 3 * 3600e3), pick);
    // the team's match first; with no team match, the nearest few by start
    // (and of those, the one against its opponent when bo3 names it)
    const tryList = cands.some(c => c.opp) ? cands.filter(c => c.opp) : cands.some(c => c.team) ? cands.filter(c => c.team) : cands.slice(0, 4);
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
    const own = (cands.find(c => c.opp) || cands.find(c => c.team))?.m;
    // Every map of the team's match parsed and the player in none of them:
    // he didn't play (or the book had his team wrong). Underdog voids a DNP.
    if (own && own.games.length && own.games.every(g => maps.has(g.id))) {
      return { unavailable: `${pick.player} is not in the player stats for ${own.slug || 'the match'} (did not play)` };
    }
    const ended = own && (bo3Ms(own.end_date) ?? bo3Ms(own.start_date));
    if (own && ended != null && now() - ended > giveUpMs && !own.games.some(g => maps.has(g.id))) {
      return { unavailable: `bo3.gg has no player stats for ${own.slug || 'this match'} (no demo parsed)` };
    }
    return null;
  };
}

// ─── Valorant via vlr.gg ──────────────────────────────────────────────────────
// PandaScore (paid) was the only Valorant grader, so Valorant rows sat
// ungraded. vlr.gg's match pages carry every map's score and each player's
// kills, deaths and assists. The results list finds the match (both team
// names, the day), the match page confirms it (its UTC start, the teams,
// "final") and gives the maps by their number in the series. Anything that
// doesn't match cleanly (a player in neither lineup, a handle two players
// share, a stat vlr doesn't count) is ungradable, never a guess.
const { teamsMatch, teamCode } = require('./context');
const VLR = 'https://www.vlr.gg';
const VLR_HEADERS = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36' };
const vlrText = s => String(s || '').replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&#0?39;|&apos;/g, "'").replace(/\s+/g, ' ').trim();
const VLR_STAT = { kills: 'kills', deaths: 'deaths', assists: 'assists' };

// Pure: a finished Valorant map has a winner at 13+ by two (overtime goes on
// until someone leads by two)
const vlrMapDone = ([a, b]) => Math.max(a, b) >= 13 && Math.abs(a - b) >= 2;

// Pure: vlr.gg match page → { id, start, final, teams: [{ name, tag }], maps:
// [{ number, gameId, name, score: [a, b], done, players: [{ id, name, team, kills, deaths, assists }] }] }
// team is 0 or 1 (the match header's order), from the player's tag where the
// map's round chart names both tags, else his row's place (vlr lists one
// team's five, then the other's).
function vlrMatchPage(html) {
  const h = String(html || '');
  const id = /<link rel="canonical" href="https?:\/\/www\.vlr\.gg\/(\d+)\//.exec(h)?.[1] || null;
  const start = Date.parse((/data-utc-ts="([^"]+)"/.exec(h)?.[1] || '').replace(' ', 'T') + 'Z');
  const notes = [...h.matchAll(/match-header-vs-note">\s*([^<]*)/g)].map(m => m[1].trim().toLowerCase());
  const names = [...h.matchAll(/match-header-link-name mod-(\d)">\s*<div class="wf-title-med[^"]*">([\s\S]*?)<\/div>/g)].map(m => vlrText(m[2]));
  const teams = names.slice(0, 2).map(name => ({ name, tag: null }));
  // map numbers from the maps bar: game id → its place in the series
  const numberOf = new Map();
  for (const m of h.matchAll(/vm-stats-gamesnav-item[^"]*"\s+data-game-id="(\d+)"[^>]*>[\s\S]*?<span[^>]*>\s*(\d+)\s*<\/span>/g)) numberOf.set(m[1], +m[2]);
  const maps = [];
  for (const c of h.split(/<div class="vm-stats-game\s/).slice(1)) {
    const gid = /^[^>]*data-game-id="(\d+)"/.exec(c)?.[1];
    if (!gid) continue;   // "all" (the series totals) and the nav bar
    const cut = c.search(/class="ovw-|<table/);
    const head = cut > 0 ? c.slice(0, cut) : c.slice(0, 20000);
    const score = [...head.matchAll(/<div class="score[^"]*"[^>]*>\s*(\d+)\s*</g)].map(m => +m[1]).slice(0, 2);
    const sideNames = [...head.matchAll(/<div class="team-name"[^>]*>([\s\S]*?)<\/div>/g)].map(m => vlrText(m[1]));
    const tags = [...head.matchAll(/vlr-rounds-tag" title="([^"]*)"/g)].map(m => vlrText(m[1])).slice(0, 2);
    // the map header's left team is normally the match's first; flip when its names say otherwise
    const flip = sideNames.length === 2 && teams.length === 2 && squash(sideNames[0]) === squash(teams[1].name) && squash(sideNames[1]) === squash(teams[0].name);
    if (flip) { score.reverse(); tags.reverse(); }
    if (tags.length === 2) tags.forEach((t, i) => { if (teams[i] && !teams[i].tag) teams[i].tag = t; });
    const players = [];
    const rows = c.split(/class="ovw-row"|<tr[\s>]/).slice(1).filter(r => /mod-player/.test(r));
    rows.forEach((row, i) => {
      const name = vlrText((/<div class="ovw-player-name[^"]*"[^>]*>([\s\S]*?)<\/div>/.exec(row) || /<div class="text-of"[^>]*>([\s\S]*?)<\/div>/.exec(row))?.[1]);
      const tag = vlrText((/<div class="ovw-player-tag[^"]*"[^>]*>([\s\S]*?)<\/div>/.exec(row) || /<div class="ge-text-light"[^>]*>([\s\S]*?)<\/div>/.exec(row))?.[1]);
      const col = key => {
        const v = (new RegExp(`data-col="${key}"><span class="side mod-both[^"]*">\\s*(\\d+)`).exec(row) || new RegExp(`mod-vlr-${key}[\\s\\S]*?mod-both[^>]*>\\s*(\\d+)`).exec(row))?.[1];
        return v != null ? +v : null;
      };
      const kills = col('kills');
      if (!name || kills == null) return;
      let team = tags.length === 2 && tag ? tags.findIndex(t => squash(t) === squash(tag)) : -1;
      if (team < 0) team = rows.length === 10 ? (i < 5 ? 0 : 1) : null;
      players.push({ id: /href="\/player\/(\d+)/.exec(row)?.[1] || null, name, tag: tag || null, team, kills, deaths: col('deaths'), assists: col('assists') });
    });
    if (score.length < 2) continue;
    maps.push({ number: numberOf.get(gid) ?? null, gameId: gid, name: vlrText(/<div class="map-name"[^>]*>\s*<span[^>]*>\s*([^<]*)/.exec(head)?.[1] || ''), score, done: vlrMapDone(score), players });
  }
  // maps the nav bar didn't number keep the page's order
  let n = 0;
  for (const m of maps) { n++; if (m.number == null) m.number = n; }
  return { id, start: Number.isFinite(start) ? start : null, final: notes.includes('final'), teams, maps };
}

// Pure: the results list (newest first) → [{ id, teams: [a, b], day }]
// day is the list's date header (vlr.gg's own time zone), a rough filter only:
// the match page's UTC start decides.
function vlrResultsList(html) {
  const out = [];
  for (const part of String(html || '').split(/<div class="wf-label mod-large">/).slice(1)) {
    const day = Date.parse(vlrText(part.slice(0, part.indexOf('</div>'))).replace(/\s*(Today|Yesterday)\s*/g, ' ').trim()) || null;
    for (const m of part.matchAll(/<a href="\/(\d+)\/[^"]*"[^>]*class="wf-module-item match-item[\s\S]*?<\/a>/g)) {
      const teams = [...m[0].matchAll(/<div class="match-item-vs-team-name">([\s\S]*?)<\/div>\s*<\/div>/g)].map(x => vlrText(x[1]));
      if (teams.length >= 2) out.push({ id: m[1], teams: teams.slice(0, 2), day });
    }
  }
  return out;
}

// Pure: does a name (a pick's team, or one side of its match title) name this
// team (its full name or its tag)?
function vlrTeamIs(team, name) {
  const t = squash(name);
  if (t.length < 2 || !team) return false;
  for (const n of [team.name, team.tag].map(squash).filter(Boolean)) {
    if (n === t) return true;
    if (Math.min(n.length, t.length) >= 4 && (n.includes(t) || t.includes(n))) return true;
  }
  return false;
}
// Pure: which of the match's teams the pick names, -1 for none. With only a
// match title, both sides must be the match's two teams.
function vlrPickSide(page, pick) {
  if (squash(pick.team).length >= 2) {
    const hit = page.teams.map((t, i) => (vlrTeamIs(t, pick.team) ? i : -1)).filter(i => i >= 0);
    return hit.length === 1 ? hit[0] : -1;
  }
  const sides = pickTeams(pick);
  if (sides.length !== 2) return -1;
  const fwd = vlrTeamIs(page.teams[0], sides[0]) && vlrTeamIs(page.teams[1], sides[1]);
  const rev = vlrTeamIs(page.teams[0], sides[1]) && vlrTeamIs(page.teams[1], sides[0]);
  return fwd || rev ? 2 : -1;   // 2: the match, either team
}

// Pure: a final match page + a pick → { maps, complete } | { unavailable } | null.
// The player is matched on his handle within the pick's team (or within the
// match when the pick names only the match); a handle two players share is
// ungradable.
function vlrGradeFromPage(page, pick) {
  const key = VLR_STAT[pick.stat || 'kills'];
  if (!key) return { unavailable: `vlr.gg has no ${pick.stat} counts for Valorant` };
  const side = vlrPickSide(page, pick);
  if (side < 0) return null;
  const want = squash(pick.player);
  const played = page.maps.filter(m => m.done && m.players.length >= 10);
  const maps = {};
  let found = false;
  for (const m of played) {
    const hits = m.players.filter(p => squash(p.name) === want && (side === 2 || p.team === side));
    if (hits.length > 1) return { unavailable: `two players named ${pick.player} in ${page.teams.map(t => t.name).join(' vs ')}` };
    if (!hits.length || hits[0][key] == null) continue;
    maps[m.number] = hits[0][key];
    found = true;
  }
  if (found) return { maps, complete: page.final && played.length === page.maps.filter(m => m.done).length, matchId: page.id };
  if (!page.final) return null;
  // a final match with stats on every map played and the player in none: he
  // didn't play (or the book had his team wrong); the apps void a DNP
  if (played.length && played.length === page.maps.filter(m => m.done).length) {
    return { unavailable: `${pick.player} is not in ${side === 2 ? 'either lineup' : page.teams[side].name + "'s lineup"} on vlr.gg for ${page.teams.map(t => t.name).join(' vs ')} (did not play)` };
  }
  return null;
}

// Results pages are shared by every pick for ttlMs (newest first, back to the
// oldest day asked for); a final match page is kept, others re-read after
// ttlMs. A pick's match: a result within a day and a half of its start with
// one of its teams, whose page starts within windowMs of the pick.
function createValGrader(http, { ttlMs = 10 * 60e3, windowMs = 6 * 3600e3, maxPages = 25, giveUpMs = 18 * 3600e3, now = () => Date.now(), pause = 1200 } = {}) {
  let list = { at: 0, rows: [], oldest: Infinity };
  const pages = new Map();   // match id → { at, page }
  const wait = ms => (ms > 0 ? new Promise(r => setTimeout(r, ms)) : null);
  async function resultsSince(from) {
    if (now() - list.at < ttlMs && list.oldest <= from) return list.rows;
    const rows = [], seen = new Set();
    let oldest = Infinity;
    for (let p = 1; p <= maxPages && oldest > from; p++) {
      const res = await http.get(`${VLR}/matches/results${p > 1 ? `/?page=${p}` : ''}`, { headers: VLR_HEADERS, timeout: 20000, responseType: 'text' });
      // past the last page vlr.gg serves an earlier one again: stop when nothing is new
      const got = vlrResultsList(res?.data).filter(r => !seen.has(r.id));
      if (!got.length) { oldest = -Infinity; break; }
      for (const r of got) { seen.add(r.id); rows.push(r); }
      oldest = Math.min(oldest, ...got.map(r => r.day ?? Infinity));
      await wait(pause);
    }
    list = { at: now(), rows, oldest };
    return rows;
  }
  async function matchPage(id) {
    const hit = pages.get(id);
    if (hit && (hit.page.final || now() - hit.at < ttlMs)) return hit.page;
    const res = await http.get(`${VLR}/${id}`, { headers: VLR_HEADERS, timeout: 20000, responseType: 'text' });
    const page = { ...vlrMatchPage(res?.data), id: String(id) };
    pages.set(id, { at: now(), page });
    while (pages.size > 600) pages.delete(pages.keys().next().value);
    await wait(pause);
    return page;
  }
  return async function gradeVal(pick) {
    const start = Date.parse(pick.startTime);
    if (!Number.isFinite(start)) return null;
    // the pick's team and both sides of its match title: an app's tag
    // ("AKV.GC") may name nothing in the list, its opponent still does
    const names = [...new Set([...pickTeams(pick), ...pickTeams({ matchTitle: pick.matchTitle })])];
    // the list has full names only ("G2 Esports" for an app's "G2"): a loose
    // first cut, the page (names and tags) decides
    const named = r => names.some(n => r.teams.some(t => vlrTeamIs({ name: t }, n) || teamsMatch(t, n) || teamCode(t, n)));
    const cands = (await resultsSince(start - 36 * 3600e3))
      .filter(r => named(r) && (r.day == null || Math.abs(r.day - start) <= 36 * 3600e3));
    const fits = [];
    for (const r of cands.slice(0, 6)) {
      const page = await matchPage(r.id);
      if (page.start == null || Math.abs(page.start - start) > windowMs || vlrPickSide(page, pick) < 0) continue;
      fits.push(page);
    }
    fits.sort((a, b) => Math.abs(a.start - start) - Math.abs(b.start - start));
    const page = fits[0];
    if (!page) return null;
    const out = vlrGradeFromPage(page, pick);
    if (out) return out;
    // a final match with no stats on any map, long after: a forfeit or a match
    // vlr.gg never filled in
    if (page.final && now() - page.start > giveUpMs && !page.maps.some(m => m.done && m.players.length >= 10)) {
      return { unavailable: `vlr.gg has no player stats for ${page.teams.map(t => t.name).join(' vs ')}` };
    }
    return null;
  };
}

module.exports = { createValGrader, vlrMatchPage, vlrResultsList, vlrTeamIs, vlrPickSide, vlrGradeFromPage, vlrMapDone, pickTeams, createLoLGrader, createLoLesportsGrader, createLoLGraderChain, loleMatchFor, loleStatFromWindow, createDotaGrader, createCsGrader, lolMapsFromRows, dotaMapsFromMatches, lpName, bo3TeamMatch, bo3Candidates, bo3PlayerStat };
