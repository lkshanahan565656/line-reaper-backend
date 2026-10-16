// ─── SLEEPER SCHEDULES: each sports line's own game time ──────────────────────
// Sleeper's lines carry a game_id but no start time. Borrowing the player's
// next start from Underdog or PrizePicks goes wrong when the apps list
// different games: on 2026-10-14 Sleeper's NBA lines were opening night
// (Oct 20) while Underdog and PrizePicks still listed preseason. Sleeper's own
// schedule maps game_id to a date and teams, and its scores feed (by week) to
// the exact tip-off, so a Sleeper line gets its own game.
//   api.sleeper.com/schedule/{sport}/{season_type}/{season} → [{ game_id, date, week, home, away }]
//   api.sleeper.com/scores/{sport}/{season_type}/{season}/{week} → [{ game_id, start_time (ms), metadata }]
// Sports without a schedule there (soccer, tennis, MMA, golf) keep borrowing.

const SCHEDULE_TTL = 6 * 3600e3;
const SCORES_TTL = 30 * 60e3;
const team = side => (side && typeof side === 'object' ? side.team : side) || '';

// Pure: schedule rows → Map(game_id → { date, week, home, away })
function gamesFromSchedule(rows) {
  const out = new Map();
  for (const g of Array.isArray(rows) ? rows : []) {
    if (!g || g.game_id == null) continue;
    out.set(String(g.game_id), { date: g.date || null, week: g.week ?? null, home: team(g.home), away: team(g.away) });
  }
  return out;
}

// Pure: scores rows → Map(game_id → ISO start)
function startsFromScores(rows) {
  const out = new Map();
  for (const g of Array.isArray(rows) ? rows : []) {
    if (!g || g.game_id == null) continue;
    const ms = Number(g.start_time) || Date.parse(g.metadata?.scheduled || '');
    if (Number.isFinite(ms) && ms > 0) out.set(String(g.game_id), new Date(ms).toISOString());
  }
  return out;
}

// Pure: give each line its game's start, teams and date where known
function attachGames(lines, games, starts) {
  return lines.map(l => {
    if (!l.gameId) return l;
    const id = String(l.gameId);
    const g = games.get(id);
    const start = starts.get(id);
    if (!g && !start) return l;
    const title = g && g.home && g.away ? `${g.away} @ ${g.home}` : '';
    return { ...l, startTime: start || l.startTime || '', gameDate: g?.date || null, matchTitle: l.matchTitle || title, startSource: start ? 'sleeper' : l.startSource };
  });
}

function createSleeperSchedule(http, { now = () => Date.now(), log = console } = {}) {
  const schedules = new Map();   // sport|type|season → { at, games }
  const scores = new Map();      // sport|type|season|week → { at, starts }
  const get = async url => (await http.get(url, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' }, timeout: 20000 })).data;

  // rows: Sleeper's raw lines; sportOf(key) → board sport, or null to skip
  async function refresh(rows, sportOf) {
    const want = new Map();   // sport|type|season → Set(game ids)
    for (const r of Array.isArray(rows) ? rows : []) {
      const key = String(r.sport || '').toLowerCase();
      if (!r.game_id || !sportOf(key) || !r.season || !r.season_type || /^clubsoccer|tennis|mma|golf/.test(key)) continue;
      const k = `${key}|${r.season_type}|${r.season}`;
      if (!want.has(k)) want.set(k, new Set());
      want.get(k).add(String(r.game_id));
    }
    const games = new Map(), starts = new Map();
    for (const [k, ids] of want) {
      const [sport, type, season] = k.split('|');
      let s = schedules.get(k);
      if (!s || now() - s.at > SCHEDULE_TTL) {
        try { s = { at: now(), games: gamesFromSchedule(await get(`https://api.sleeper.com/schedule/${sport}/${type}/${season}`)) }; }
        catch (e) { log.warn?.(`Sleeper schedule ${k}: ${e.response?.status || ''} ${e.message}`); s = { at: now(), games: new Map() }; }
        schedules.set(k, s);
      }
      const weeks = new Set();
      for (const id of ids) {
        const g = s.games.get(id);
        if (g) { games.set(id, g); if (g.week != null) weeks.add(g.week); }
      }
      for (const w of weeks) {
        const wk = `${k}|${w}`;
        let sc = scores.get(wk);
        if (!sc || now() - sc.at > SCORES_TTL) {
          try { sc = { at: now(), starts: startsFromScores(await get(`https://api.sleeper.com/scores/${sport}/${type}/${season}/${w}`)) }; }
          catch (e) { log.warn?.(`Sleeper scores ${wk}: ${e.response?.status || ''} ${e.message}`); sc = { at: now(), starts: new Map() }; }
          scores.set(wk, sc);
        }
        for (const id of ids) if (sc.starts.has(id)) starts.set(id, sc.starts.get(id));
      }
    }
    return { games, starts };
  }
  return { refresh };
}

module.exports = { createSleeperSchedule, gamesFromSchedule, startsFromScores, attachGames };
