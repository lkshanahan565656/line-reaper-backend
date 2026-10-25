// ─── RESULTS FOR TENNIS, UFC, NASCAR AND SOCCER PICK'EM LEGS ─────────────────
// sportgrade.js settles the team sports from ESPN box scores. The legs PR 164
// priced in the other sports need results of their own, all from free public
// JSON (no key, no scraping):
//   Tennis  ESPN's tennis scoreboard (ATP and WTA): each set's games per
//           player → Games Played, Games Won, 1st Set Games, Sets Played,
//           Sets Won, Tiebreaks. A retirement or walkover voids the leg.
//   UFC     ESPN's UFC scoreboard: the round and clock the fight ended on and
//           the winner → Fight Time, Finishes, Nth Round Finish. Kalshi's
//           settled method-of-victory markets → Knockouts, Submissions.
//   NASCAR  Kalshi's settled top 3/5/10/20 and winner markets → Finishing
//           Position at N + 0.5, the only lines anything prices.
//   Soccer  Kalshi's settled goalscorer ladders ("Name: 1+ goals") → Goals
//           at the ladder's own line.
// A leg whose stat none of these carries stays ungraded (canGrade says so up
// front, so the tracker doesn't spend its grading budget on it).

const { canonName } = require('./ev');

const ESPN = 'https://site.api.espn.com/apis/site/v2/sports';
const KALSHI_EVENTS = 'https://api.elections.kalshi.com/trade-api/v2/events';
const TENNIS_TOURS = ['tennis/atp', 'tennis/wta'];
const TENNIS_KEYS = ['games_played', 'games_won', '1st_set_games_played', '1st_set_games_won', 'sets_played', 'sets_won', 'tiebreakers_played'];
const MMA_ESPN_KEYS = ['fight_time', 'finishes', '1st_round_finish', '2nd_round_finish', '3rd_round_finish', '4th_round_finish', '5th_round_finish'];
const MMA_KALSHI_KEYS = { knockouts: 'KO/TKO/DQ', submissions: 'Submission' };
const NASCAR_SERIES = { 1: 'KXNASCARRACE', 3: 'KXNASCARTOP3', 5: 'KXNASCARTOP5', 10: 'KXNASCARTOP10', 20: 'KXNASCARTOP20' };
const SOCCER_GOAL_SERIES = ['KXEPLGOAL', 'KXLALIGAGOAL', 'KXSERIEAGOAL', 'KXBUNDESLIGAGOAL', 'KXLIGUE1GOAL', 'KXMLSGOAL', 'KXLIGAMXGOAL', 'KXUCLGOAL', 'KXUELGOAL'];
const n = v => { const x = parseFloat(v); return Number.isFinite(x) ? x : null; };
const ROUND = { '1st': 1, '2nd': 2, '3rd': 3, '4th': 4, '5th': 5 };

// which results source settles a leg, or null: 'espn' | 'kalshi'
function sourceFor(sport, mkey, line) {
  if (sport === 'TENNIS') return TENNIS_KEYS.includes(mkey) ? 'espn' : null;
  if (sport === 'MMA') return MMA_ESPN_KEYS.includes(mkey) ? 'espn' : MMA_KALSHI_KEYS[mkey] ? 'kalshi' : null;
  if (sport === 'MOTORSPORTS') return mkey === 'finishing_position' && NASCAR_SERIES[Number(line) - 0.5] ? 'kalshi' : null;
  if (sport === 'SOCCER') return mkey === 'goals' ? 'kalshi' : null;
  return null;
}
const canGrade = pick => !!sourceFor(pick.sport, pick.mkey, pick.signalLine);

// Over/Under at the leg's line → win | loss | push
const outcomeOf = (v, line, side) => (v === line ? 'push' : (v > line) === (side === 'Over') ? 'win' : 'loss');

// ── Tennis ──
// ESPN's tennis scoreboard for a date → singles matches
// [{ date, status, players: [{ name, winner, sets: [{ games, tiebreak, won }] }] }]
function tennisMatches(board) {
  const out = [];
  for (const ev of board?.events || []) {
    for (const g of ev.groupings || []) {
      for (const c of g.competitions || []) {
        if (!/singles/i.test(c.type?.slug || c.type?.text || g.grouping?.slug || g.grouping?.displayName || '')) continue;
        const players = (c.competitors || []).map(x => ({
          name: x.athlete?.displayName || '', winner: !!x.winner,
          sets: (x.linescores || []).map(s => ({ games: n(s.value) ?? 0, tiebreak: s.tiebreak != null, won: !!s.winner })),
        }));
        if (players.length === 2) out.push({ date: c.date || c.startDate, status: c.status?.type?.name || '', completed: !!c.status?.type?.completed, players });
      }
    }
  }
  return out;
}
// one player's stat in a finished match, or null
function tennisStat(match, player, mkey) {
  const me = match.players.find(p => canonName(p.name) === canonName(player));
  const them = match.players.find(p => p !== me);
  if (!me || !them) return null;
  const sets = Math.max(me.sets.length, them.sets.length);
  const games = (p, i) => p.sets[i]?.games ?? 0;
  let all = 0, mine = 0, tbs = 0;
  for (let i = 0; i < sets; i++) { all += games(me, i) + games(them, i); mine += games(me, i); if (me.sets[i]?.tiebreak || them.sets[i]?.tiebreak) tbs++; }
  const map = {
    games_played: all, games_won: mine, '1st_set_games_played': games(me, 0) + games(them, 0), '1st_set_games_won': games(me, 0),
    sets_played: sets, sets_won: me.sets.filter(s => s.won).length, tiebreakers_played: tbs,
  };
  return map[mkey] ?? null;
}
// the player's match nearest the leg's start (a player plays one a day at most)
function findTennis(matches, pick) {
  const t = Date.parse(pick.startTime || pick.start || '');
  const k = canonName(pick.player);
  let best = null;
  for (const m of matches) {
    if (!m.players.some(p => canonName(p.name) === k)) continue;
    const d = Math.abs(Date.parse(m.date) - t);
    if (!(d < 36 * 3600e3)) continue;
    if (!best || d < best.d) best = { m, d };
  }
  return best?.m || null;
}
function gradeTennis(match, pick) {
  if (!match) return null;
  if (/RETIRED|WALKOVER|ABANDONED|CANCELED|DEFAULT/i.test(match.status)) return { void: `tennis ${match.status.replace(/^STATUS_/, '').toLowerCase()}` };
  if (!match.completed) return { pending: true };
  const v = tennisStat(match, pick.player, pick.mkey);
  return v == null ? null : { result: v, outcome: outcomeOf(v, Number(pick.signalLine), pick.signalSide), source: 'espn' };
}

// ── UFC ──
// ESPN's UFC scoreboard → bouts [{ date, completed, period, clock (s into the round), rounds, fighters: [{ name, winner }] }]
function ufcBouts(board) {
  const out = [];
  for (const ev of board?.events || []) {
    for (const c of ev.competitions || []) {
      const fighters = (c.competitors || []).map(x => ({ name: x.athlete?.displayName || x.athlete?.fullName || '', winner: !!x.winner }));
      if (fighters.length !== 2) continue;
      out.push({ date: c.date || c.startDate || ev.date, completed: !!c.status?.type?.completed, status: c.status?.type?.name || '',
        period: n(c.status?.period), clock: n(c.status?.clock), rounds: n(c.format?.regulation?.periods) || 3, fighters });
    }
  }
  return out;
}
function findBout(bouts, pick) {
  const t = Date.parse(pick.startTime || pick.start || '');
  const k = canonName(pick.player);
  let best = null;
  for (const b of bouts) {
    if (!b.fighters.some(f => canonName(f.name) === k)) continue;
    const d = Math.abs(Date.parse(b.date) - t);
    if (!(d < 30 * 3600e3)) continue;
    if (!best || d < best.d) best = { b, d };
  }
  return best?.b || null;
}
// the stat for one fighter in a finished bout, or { void } / null
function ufcStat(bout, player, mkey) {
  if (bout.period == null || bout.clock == null) return null;
  const me = bout.fighters.find(f => canonName(f.name) === canonName(player));
  if (!me) return null;
  const distance = bout.period >= bout.rounds && bout.clock >= 300;
  if (mkey === 'fight_time') return +(((bout.period - 1) * 5) + bout.clock / 60).toFixed(2);
  // a bout that ended early with no winner (a no contest) settles no finish prop
  if (!distance && !bout.fighters.some(f => f.winner)) return { void: 'no contest' };
  const finish = me.winner && !distance;
  if (mkey === 'finishes') return finish ? 1 : 0;
  const r = /^(1st|2nd|3rd|4th|5th)_round_finish$/.exec(mkey);
  if (r) return finish && bout.period === ROUND[r[1]] ? 1 : 0;
  return null;
}
function gradeUfc(bout, pick) {
  if (!bout) return null;
  if (!bout.completed) return /CANCEL|POSTPON/i.test(bout.status) ? { void: 'bout cancelled' } : { pending: true };
  const v = ufcStat(bout, pick.player, pick.mkey);
  if (v == null) return null;
  if (v.void) return v;
  return { result: v, outcome: outcomeOf(v, Number(pick.signalLine), pick.signalSide), source: 'espn' };
}

// ── Kalshi settled markets ──
// settled events of a series → markets [{ title, sub, strike, result, exp }]
function settledMarkets(events) {
  const out = [];
  for (const ev of events || []) for (const m of ev.markets || []) {
    out.push({ title: m.title || '', sub: m.yes_sub_title || '', strike: n(m.floor_strike), result: String(m.result || '').toLowerCase(),
      exp: Date.parse(m.expected_expiration_time || m.close_time || ''), event: ev.event_ticker || '' });
  }
  return out;
}
// the market settling the leg's event: expires between an hour before the
// leg's start and 14 hours after it (as kxextra.quoteAt matches it)
const inWindow = (m, pick) => { const d = m.exp - Date.parse(pick.startTime || pick.start || ''); return d > -3600e3 && d < 14 * 3600e3; };
// yes/no → the leg's grade; yesOver says whether a yes means the stat went over the line
function kalshiOutcome(m, pick, yesOver) {
  if (!m) return null;
  if (m.result !== 'yes' && m.result !== 'no') return m.result ? { void: `kalshi ${m.result}` } : { pending: true };
  const over = (m.result === 'yes') === yesOver;
  return { result: m.result === 'yes' ? 'yes' : 'no', outcome: over === (pick.signalSide === 'Over') ? 'win' : 'loss', source: 'kalshi', market: m.event };
}
function gradeKalshi(pick, marketsBySeries) {
  const k = canonName(pick.player), line = Number(pick.signalLine);
  if (pick.sport === 'MMA') {
    const word = MMA_KALSHI_KEYS[pick.mkey];
    const m = (marketsBySeries.KXUFCMOV || []).find(x => inWindow(x, pick) && (() => {
      const r = /^(.+?)\s+wins by\s+(.+?)\??$/i.exec(x.title);
      return r && canonName(r[1]) === k && r[2].toLowerCase().startsWith(word.toLowerCase());
    })());
    // a yes on "wins by KO" is one knockout: over 0.5
    return line === 0.5 ? kalshiOutcome(m, pick, true) : null;
  }
  if (pick.sport === 'MOTORSPORTS') {
    const top = line - 0.5, series = NASCAR_SERIES[top];
    const m = (marketsBySeries[series] || []).find(x => inWindow(x, pick) && canonName(x.sub) === k);
    // finishing position over N + 0.5 is finishing outside the top N: a no
    return kalshiOutcome(m, pick, false);
  }
  if (pick.sport === 'SOCCER') {
    for (const s of SOCCER_GOAL_SERIES) {
      const m = (marketsBySeries[s] || []).find(x => inWindow(x, pick) && x.strike === line && canonName(String(x.title).replace(/:.*$/, '')) === k);
      if (m) return kalshiOutcome(m, pick, true);
    }
    return null;
  }
  return null;
}
const seriesFor = pick => (pick.sport === 'MMA' ? ['KXUFCMOV'] : pick.sport === 'MOTORSPORTS' ? [NASCAR_SERIES[Number(pick.signalLine) - 0.5]] : pick.sport === 'SOCCER' ? SOCCER_GOAL_SERIES : []).filter(Boolean);

// Fetch side. ymd in US Eastern, as sportgrade does.
const ymd = t => new Date(t - 4 * 3600e3).toISOString().slice(0, 10).replace(/-/g, '');
function createExtraGrader({ http, ttlMs = 10 * 60e3, kalshiTtlMs = 20 * 60e3, now = () => Date.now() } = {}) {
  const cache = new Map();
  const cached = async (key, ms, fn) => {
    const hit = cache.get(key);
    if (hit && now() - hit.at < ms) return hit.v;
    const v = await fn();
    cache.set(key, { at: now(), v });
    return v;
  };
  const espn = (path, d) => cached(`${path}|${d}`, ttlMs, async () => (await http.get(`${ESPN}/${path}/scoreboard`, { params: { dates: d }, timeout: 20000 }))?.data || {});
  // the newest settled events of a series (Kalshi lists newest first); two pages at most
  const settled = series => cached(`kx|${series}`, kalshiTtlMs, async () => {
    const events = [];
    let cursor = '';
    for (let page = 0; page < 2; page++) {
      const res = await http.get(KALSHI_EVENTS, { params: { series_ticker: series, status: 'settled', with_nested_markets: true, limit: 200, ...(cursor ? { cursor } : {}) }, timeout: 20000 });
      events.push(...(res?.data?.events || []));
      cursor = res?.data?.cursor || '';
      if (!cursor || (res?.data?.events || []).length < 200) break;
    }
    return settledMarkets(events);
  });
  // → { result, outcome, source } | { pending } | { void } | null
  async function grade(pick) {
    const src = sourceFor(pick.sport, pick.mkey, pick.signalLine);
    const t = Date.parse(pick.startTime || pick.start || '');
    if (!src || !t) return null;
    const days = [...new Set([ymd(t), ymd(t + 12 * 3600e3)])];
    if (pick.sport === 'TENNIS') {
      const matches = [];
      for (const tour of TENNIS_TOURS) for (const d of days) matches.push(...tennisMatches(await espn(tour, d)));
      return gradeTennis(findTennis(matches, pick), pick);
    }
    if (src === 'espn' && pick.sport === 'MMA') {
      const bouts = [];
      for (const d of days) bouts.push(...ufcBouts(await espn('mma/ufc', d)));
      return gradeUfc(findBout(bouts, pick), pick);
    }
    const bySeries = {};
    for (const s of seriesFor(pick)) bySeries[s] = await settled(s);
    return gradeKalshi(pick, bySeries);
  }
  return { grade, canGrade };
}

module.exports = { sourceFor, canGrade, tennisMatches, tennisStat, findTennis, gradeTennis, ufcBouts, findBout, ufcStat, gradeUfc,
  settledMarkets, gradeKalshi, createExtraGrader, TENNIS_KEYS, MMA_ESPN_KEYS, NASCAR_SERIES, SOCCER_GOAL_SERIES };

// One grader for the sports record: ESPN box scores for the team sports
// (sportgrade.js), this file for the rest. canGrade(pick) says up front
// whether anything can settle a leg.
function combineGraders(box, extra) {
  return {
    canGrade: pick => box.canGrade(pick) || extra.canGrade(pick),
    // a leg both can settle (soccer goals: ESPN's box and Kalshi's goalscorer
    // market) takes the box first, Kalshi when the box has nothing
    grade: async pick => {
      if (!extra.canGrade(pick)) return box.grade(pick);
      if (!box.canGrade(pick)) return extra.grade(pick);
      const g = await box.grade(pick);
      return g || extra.grade(pick);
    },
    sourceOf: pick => (box.canGrade(pick) ? 'espn box score' : sourceFor(pick.sport, pick.mkey, pick.signalLine)),
  };
}
module.exports.combineGraders = combineGraders;
