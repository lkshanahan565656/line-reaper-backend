// ─── SPORTS PROP RESULTS FROM ESPN BOX SCORES ────────────────────────────────
// A pick'em leg on a sports player is graded against the player's real line in
// ESPN's public box score (site.api.espn.com, no key). The scoreboard for the
// game's date finds the event by team or player, the summary gives every
// player's stat line under named keys ("receivingYards", "points"), and the
// leg's stat is read off those keys. Pure parsers are tested against saved
// box scores; the fetcher is a thin wrapper the server calls once a game ends.

const { canonName } = require('./ev');

const ESPN = 'https://site.api.espn.com/apis/site/v2/sports';
const LEAGUES = { NFL: 'football/nfl', CFB: 'football/college-football', NBA: 'basketball/nba', WNBA: 'basketball/wnba',
  CBB: 'basketball/mens-college-basketball', MLB: 'baseball/mlb', NHL: 'hockey/nhl' };

const n = v => { const x = parseFloat(v); return Number.isFinite(x) ? x : 0; };
// "12/19" → [12, 19]; "3-6" → [3, 6]
const pair = v => String(v ?? '').split(/[/-]/).map(n);
// "5.2" innings → 17 outs
const outs = v => { const [a, b = '0'] = String(v ?? '0').split('.'); return n(a) * 3 + n(b); };

// One box score → Map(canonName → { group: { key: value } }), groups as ESPN
// names them. Basketball and baseball groups carry no name, so they're named
// by a key only they have.
function parseBox(box) {
  const out = new Map();
  for (const team of box?.players || []) {
    for (const g of team.statistics || []) {
      const keys = g.keys || [];
      const name = g.name || (keys.includes('points') ? 'basketball' : keys.includes('hits-atBats') ? 'batting'
        : keys.includes('fullInnings.partInnings') ? 'pitching' : 'other');
      for (const a of g.athletes || []) {
        const who = a.athlete?.displayName;
        if (!who || !Array.isArray(a.stats) || !a.stats.length) continue;
        const k = canonName(who);
        if (!out.has(k)) out.set(k, { name: who, team: team.team?.displayName || '', groups: {} });
        const row = {};
        keys.forEach((key, i) => { row[key] = a.stats[i]; });
        // NHL lists a player under forwards and skaters alike; the first wins
        out.get(k).groups[name] ||= row;
      }
    }
  }
  return out;
}

// sport + canonical market key → the stat from one player's groups, or null
// when the box doesn't carry it (that leg stays ungraded rather than guessed).
function statValue(sport, market, groups) {
  const g = groups || {};
  const bb = g.basketball, pass = g.passing, rush = g.rushing, rec = g.receiving, kick = g.kicking;
  const bat = g.batting, pit = g.pitching;
  const sk = g.forwards || g.defenses || g.skaters, gk = g.goalies;
  const has = o => o && Object.keys(o).length;
  switch (sport) {
    case 'NBA': case 'WNBA': case 'CBB': {
      if (!has(bb)) return null;
      if (bb.minutes === '0' || bb.minutes === '--') return null;   // DNP: the books void it
      const p = n(bb.points), r = n(bb.rebounds), a = n(bb.assists), s = n(bb.steals), b = n(bb.blocks);
      const map = { points: p, rebounds: r, assists: a, steals: s, blocks: b, turnovers: n(bb.turnovers),
        threes: pair(bb['threePointFieldGoalsMade-threePointFieldGoalsAttempted'])[0],
        ftm: pair(bb['freeThrowsMade-freeThrowsAttempted'])[0],
        pra: p + r + a, pts_rebs: p + r, pts_asts: p + a, rebs_asts: r + a, stocks: s + b };
      return map[market] ?? null;
    }
    case 'NFL': case 'CFB': {
      const map = {
        pass_yds: has(pass) ? n(pass.passingYards) : null,
        pass_tds: has(pass) ? n(pass.passingTouchdowns) : null,
        pass_comp: has(pass) ? pair(pass['completions/passingAttempts'])[0] : null,
        pass_att: has(pass) ? pair(pass['completions/passingAttempts'])[1] : null,
        pass_ints: has(pass) ? n(pass.interceptions) : null,
        rush_yds: has(rush) || has(rec) || has(pass) ? n(rush?.rushingYards) : null,
        rush_att: has(rush) || has(rec) || has(pass) ? n(rush?.rushingAttempts) : null,
        rec_yds: has(rec) || has(rush) ? n(rec?.receivingYards) : null,
        receptions: has(rec) || has(rush) ? n(rec?.receptions) : null,
        targets: has(rec) && rec.receivingTargets != null ? n(rec.receivingTargets) : null,
        rush_rec_yds: has(rush) || has(rec) ? n(rush?.rushingYards) + n(rec?.receivingYards) : null,
        pass_rush_yds: has(pass) ? n(pass.passingYards) + n(rush?.rushingYards) : null,
        longest_rec: has(rec) ? n(rec.longReception) : null,
        longest_rush: has(rush) ? n(rush.longRushing) : null,
        fg_made: has(kick) ? pair(kick['fieldGoalsMade/fieldGoalAttempts'])[0] : null,
        kicking_points: has(kick) ? n(kick.totalKickingPoints) : null,
      };
      return map[market] ?? null;
    }
    case 'MLB': {
      const map = {};
      if (has(bat)) {
        const h = n(bat.hits), r = n(bat.runs), rbi = n(bat.RBIs);
        Object.assign(map, { hits: h, runs: r, rbis: rbi, home_runs: n(bat.homeRuns), hits_runs_rbis: h + r + rbi, batter_walks: n(bat.walks), batter_strikeouts: n(bat.strikeouts) });
      }
      if (has(pit)) {
        Object.assign(map, { strikeouts: n(pit.strikeouts), pitcher_outs: outs(pit['fullInnings.partInnings']), hits_allowed: n(pit.hits),
          earned_runs: n(pit.earnedRuns), walks_allowed: n(pit.walks) });
      }
      return map[market] ?? null;
    }
    case 'NHL': {
      if (has(gk)) return market === 'saves' ? n(gk.saves) : market === 'goals_against' ? n(gk.goalsAgainst) : null;
      if (!has(sk)) return null;
      const goals = n(sk.goals), ast = n(sk.assists);
      const map = { goals, assists: ast, points: goals + ast, shots_on_goal: n(sk.shotsTotal), blocks: n(sk.blockedShots), hits: n(sk.hits) };
      return map[market] ?? null;
    }
    default: return null;
  }
}

// The stats statValue reads per sport: a leg on anything else never grades
// from a box score, so the tracker doesn't spend its grading budget on it.
const BB = ['points', 'rebounds', 'assists', 'steals', 'blocks', 'turnovers', 'threes', 'ftm', 'pra', 'pts_rebs', 'pts_asts', 'rebs_asts', 'stocks'];
const FB = ['pass_yds', 'pass_tds', 'pass_comp', 'pass_att', 'pass_ints', 'rush_yds', 'rush_att', 'rec_yds', 'receptions', 'targets',
  'rush_rec_yds', 'pass_rush_yds', 'longest_rec', 'longest_rush', 'fg_made', 'kicking_points'];
const MARKETS = { NBA: BB, WNBA: BB, CBB: BB, NFL: FB, CFB: FB,
  MLB: ['hits', 'runs', 'rbis', 'home_runs', 'hits_runs_rbis', 'batter_walks', 'batter_strikeouts', 'strikeouts', 'pitcher_outs', 'hits_allowed', 'earned_runs', 'walks_allowed'],
  NHL: ['saves', 'goals_against', 'goals', 'assists', 'points', 'shots_on_goal', 'blocks', 'hits'] };
const canGrade = pick => !!MARKETS[pick.sport]?.includes(pick.mkey);

// "Cleveland Cavaliers" vs a pick's "CLE @ ORL" title or team: last words and
// abbreviations both count
function eventHasTeam(ev, words) {
  const teams = (ev?.competitions?.[0]?.competitors || []).flatMap(c => [c.team?.displayName, c.team?.shortDisplayName, c.team?.abbreviation, c.team?.name, c.team?.location]);
  const keys = teams.filter(Boolean).map(t => canonName(t));
  return words.some(w => { const k = canonName(w); return k && keys.some(t => t === k || (k.length > 3 && t.includes(k))); });
}

// The pick's game on a scoreboard: the event starting within 3 hours of the
// pick's start that names its team (or any word of its match title)
function findEvent(events, pick) {
  const t = Date.parse(pick.startTime || '');
  const words = [pick.team, ...String(pick.matchTitle || '').split(/\s+(?:@|vs\.?|at|v)\s+/i)].filter(Boolean).map(s => s.trim());
  const near = (events || []).filter(e => !t || Math.abs(Date.parse(e.date) - t) < 3 * 3600e3);
  return near.find(e => eventHasTeam(e, words)) || null;
}

// Grade one leg from a parsed box: { result, outcome } or null (not found)
function gradeLeg(pick, players) {
  const p = players.get(canonName(pick.player));
  if (!p) return null;
  const v = statValue(pick.sport, pick.mkey, p.groups);
  if (v == null) return null;
  const line = Number(pick.signalLine);
  const outcome = v === line ? 'push' : (v > line) === (pick.signalSide === 'Over') ? 'win' : 'loss';
  return { result: v, outcome };
}

// Fetch side. ymd(t) in US Eastern so a 9pm ET game sits on its own date.
const ymd = t => new Date(t - 4 * 3600e3).toISOString().slice(0, 10).replace(/-/g, '');
function createSportsGrader({ http, ttlMs = 10 * 60e3, now = () => Date.now() } = {}) {
  const boards = new Map(), boxes = new Map();
  const cached = async (map, key, fn) => {
    const hit = map.get(key);
    if (hit && now() - hit.at < ttlMs) return hit.v;
    const v = await fn();
    map.set(key, { at: now(), v });
    return v;
  };
  const board = (league, d) => cached(boards, `${league}|${d}`, async () => (await http.get(`${ESPN}/${LEAGUES[league]}/scoreboard`, { params: { dates: d }, timeout: 20000 }))?.data?.events || []);
  const box = (league, id) => cached(boxes, `${league}|${id}`, async () => parseBox((await http.get(`${ESPN}/${LEAGUES[league]}/summary`, { params: { event: id }, timeout: 20000 }))?.data?.boxscore));
  // → { result, outcome, eventId } | { pending: true } (game not final) | null
  async function grade(pick) {
    if (!LEAGUES[pick.sport]) return null;
    const t = Date.parse(pick.startTime || '');
    if (!t) return null;
    let ev = null;
    for (const d of new Set([ymd(t), ymd(t + 6 * 3600e3)])) { ev = findEvent(await board(pick.sport, d), pick); if (ev) break; }
    if (!ev) return null;
    if (!ev.status?.type?.completed) return { pending: true };
    const g = gradeLeg(pick, await box(pick.sport, ev.id));
    return g ? { ...g, eventId: ev.id } : null;
  }
  // a game's final score: game { league (board key: NFL, CFB, ...), home,
  // away, start } → { home, away } (points) | { pending: true } | null
  async function gradeGame(game) {
    if (!LEAGUES[game.league]) return null;
    const t = Date.parse(game.start || '');
    if (!t) return null;
    const pick = { startTime: game.start, team: game.home, matchTitle: `${game.away} @ ${game.home}` };
    let ev = null;
    for (const d of new Set([ymd(t), ymd(t + 6 * 3600e3)])) { ev = findEvent(await board(game.league, d), pick); if (ev) break; }
    if (!ev) return null;
    if (!ev.status?.type?.completed) return { pending: true };
    return scoreOf(ev, game);
  }
  return { grade, gradeGame, canGrade };
}

// ESPN's competitors → our home and away points, each side found by name
// (a neutral site can list our home team as away)
function scoreOf(ev, game) {
  const comps = ev?.competitions?.[0]?.competitors || [];
  const find = name => comps.find(c => eventHasTeam({ competitions: [{ competitors: [c] }] }, [name]));
  const h = find(game.home), a = find(game.away);
  if (!h || !a || h === a) return null;
  const hp = parseFloat(h.score), ap = parseFloat(a.score);
  return Number.isFinite(hp) && Number.isFinite(ap) ? { home: hp, away: ap } : null;
}

module.exports = { LEAGUES, MARKETS, canGrade, parseBox, statValue, findEvent, gradeLeg, createSportsGrader, ymd, scoreOf };
