// ─── COLLEGE FOOTBALL PLAYER-PROP MODEL ───────────────────────────────────────
// Our own projection for the CFB player stats the pick'em apps post, built
// from ESPN box scores only (no sportsbook price goes in). One projection per
// player and game, from games that finished before that game's kickoff:
//
//   share     the player's share of his team's pass attempts, completions,
//             passing yards and TDs, rushes, rushing yards and TDs, catches
//             and receiving yards, recent games weighted more, last season's
//             games counted at a lower weight.
//   team      the team's own volume in each of those (recent games weighted,
//             pulled to the FBS average), times what the opponent allows
//             against the FBS average (pulled the same way).
//   script    the pre-game total and spread: implied team points against the
//             points the two teams' records expect, a pass/rush lean for the
//             side expected to trail, and a pull on volume past a 10-point
//             spread (starters sit in blowouts). Fitted per stat group.
//   spread    the fit window's own spread of actual / projection, in bands of
//             projection size per stat (zero games and negative rushing yards
//             included), so P(over line) is read straight off it.
//
// Pure functions: the backtest (scripts/cfbmodel-backtest.js) and the server
// (cfbdata.js) feed it the same compact games. Shapes follow nbamodel.js
// (compactGame, buildHistory, project, priceLine, expected, median).

const { canonName } = require('./ev');
const propcal = require('./propcal');

const num = v => { const x = parseFloat(v); return Number.isFinite(x) ? x : 0; };
const pair = v => String(v ?? '').split(/[/-]/).map(num);

// per player-game fields; each base stat's team category (the share's denominator)
const BASE = { pass_att: 'pa', pass_comp: 'pc', pass_yds: 'py', pass_tds: 'ptd', pass_ints: 'pint',
  rush_att: 'ra', rush_yds: 'ry', rush_tds: 'rtd', receptions: 'pc', rec_yds: 'py', rec_tds: 'ptd',
  fg_made: 'fgm', kicking_points: 'kp' };
// the group whose script parameters a stat uses
const GROUP = { pass_att: 'pass', pass_comp: 'pass', pass_yds: 'pass', pass_tds: 'ptd', pass_ints: 'pass',
  receptions: 'pass', rec_yds: 'pass', rec_tds: 'ptd', rush_att: 'rush', rush_yds: 'rush', rush_tds: 'rtd',
  fg_made: 'kick', kicking_points: 'kick' };
const COMBOS = { rush_rec_yds: ['rush_yds', 'rec_yds'], pass_rush_yds: ['pass_yds', 'rush_yds'], anytime_td: ['rush_tds', 'rec_tds'] };
const LONGEST = { longest_rec: ['reclong', 'rec_yds'], longest_rush: ['rushlong', 'rush_yds'] };
// what the props board posts and the grader can settle (sportgrade.js FB)
const STATS = ['pass_yds', 'pass_tds', 'pass_comp', 'pass_att', 'pass_ints', 'rush_yds', 'rush_att', 'rec_yds', 'receptions',
  'rush_rec_yds', 'pass_rush_yds', 'anytime_td', 'longest_rec', 'longest_rush', 'fg_made', 'kicking_points'];
const CATS = ['pa', 'pc', 'py', 'ptd', 'pint', 'ra', 'ry', 'rtd', 'fgm', 'kp', 'pts'];

// Fitted on the 2024 season (2023 as last season), box scores only. The
// backtest script writes the fitted values; these are the defaults it starts from.
const PARAMS = {
  halfLife: 4, teamHalfLife: 6, priorSeasonWeight: 0.35, teamK: 3, oppK: 4, minGames: 2,
  // per group: alpha = implied team points elasticity, beta = lean per 10 points of
  // the team's spread (+ = trailing side gets more), delta = pull per 10 points past 10
  script: { pass: { alpha: 0.5, beta: 0, delta: 0 }, rush: { alpha: 0.5, beta: 0, delta: 0 }, ptd: { alpha: 1, beta: 0, delta: 0 },
    rtd: { alpha: 1, beta: 0, delta: 0 }, kick: { alpha: 0.5, beta: 0, delta: 0 } },
  longExp: 0.5,
  // dist[stat] = [{ lo, hi, q: [ratio quantiles, ascending] }] (fitted)
  dist: {},
};

// ── ESPN home spread and total from the pick center (or scoreboard odds) ──
function spreadOf(pc) {
  const p = Array.isArray(pc) ? pc.find(x => x && (x.spread != null || x.overUnder != null)) : null;
  if (!p) return { total: null, spread: null };
  const total = Number.isFinite(+p.overUnder) && +p.overUnder > 20 ? +p.overUnder : null;
  let spread = Number.isFinite(+p.spread) && p.spread !== null && p.spread !== '' ? +p.spread : null;
  // the pick center's spread is the home team's; a positive one with the home side
  // marked favourite is the other convention: trust the favourite flag
  if (spread != null && p.homeTeamOdds && p.awayTeamOdds) {
    if (p.homeTeamOdds.favorite === true && spread > 0) spread = -spread;
    if (p.awayTeamOdds.favorite === true && spread < 0) spread = -spread;
  }
  return { total, spread };
}

// ── ESPN summary → one compact game ─────────────────────────────────────────
// { id, t, season, week, home, away (ESPN team ids), homeAbbr, awayAbbr, homeName,
// awayName, homePts, awayPts, total, spread (home's: -7 = home favoured by 7),
// players: [{ aid, key, name, team, pa, pc, py, ptd, pint, ra, ry, rtd, rushlong,
// rec, recy, rectd, reclong, fgm, kp }] }
function compactGame(sum, meta = {}) {
  const comp = sum?.comp || sum?.header?.competitions?.[0] || {};
  const cs = comp.competitors || [];
  const h = cs.find(c => c.homeAway === 'home'), a = cs.find(c => c.homeAway === 'away');
  if (!h || !a) return null;
  const by = new Map();
  for (const tm of sum?.players || sum?.boxscore?.players || []) {
    const team = String(tm.team?.id || '');
    for (const g of tm.statistics || []) {
      const keys = g.keys || [];
      for (const at of g.athletes || []) {
        const name = at.athlete?.displayName?.trim();
        const aid = String(at.athlete?.id || '');
        if (!name || !aid || name === 'Team' || !at.stats?.length) continue;
        const s = {}; keys.forEach((k, i) => { s[k] = at.stats[i]; });
        let p = by.get(aid);
        if (!p) { p = { aid, key: canonName(name), name, team, pa: 0, pc: 0, py: 0, ptd: 0, pint: 0, ra: 0, ry: 0, rtd: 0, rushlong: 0, rec: 0, recy: 0, rectd: 0, reclong: 0, fgm: 0, kp: 0, k: 0 }; by.set(aid, p); }
        if (g.name === 'passing') { const [c, at2] = pair(s['completions/passingAttempts']); p.pc = c; p.pa = at2; p.py = num(s.passingYards); p.ptd = num(s.passingTouchdowns); p.pint = num(s.interceptions); }
        else if (g.name === 'rushing') { p.ra = num(s.rushingAttempts); p.ry = num(s.rushingYards); p.rtd = num(s.rushingTouchdowns); p.rushlong = num(s.longRushing); }
        else if (g.name === 'receiving') { p.rec = num(s.receptions); p.recy = num(s.receivingYards); p.rectd = num(s.receivingTouchdowns); p.reclong = num(s.longReception); }
        else if (g.name === 'kicking') { p.fgm = pair(s['fieldGoalsMade/fieldGoalAttempts'])[0]; p.kp = num(s.totalKickingPoints); p.k = 1; }
      }
    }
  }
  const players = [...by.values()].filter(p => p.pa || p.ra || p.rec || p.k);
  if (!players.length) return null;
  const { total, spread } = spreadOf(sum?.pickcenter);
  return { id: String(sum.id || comp.id || ''), t: Date.parse(comp.date || sum.date || ''), season: meta.season ?? null, week: meta.week ?? null,
    stype: meta.stype ?? null, home: String(h.team?.id || ''), away: String(a.team?.id || ''),
    homeAbbr: h.team?.abbreviation || '', awayAbbr: a.team?.abbreviation || '', homeName: h.team?.displayName || '', awayName: a.team?.displayName || '',
    homePts: num(h.score), awayPts: num(a.score), total, spread, players };
}

// a player's value of a stat in one game
function statOf(p, s) {
  switch (s) {
    case 'pass_att': return p.pa; case 'pass_comp': return p.pc; case 'pass_yds': return p.py; case 'pass_tds': return p.ptd; case 'pass_ints': return p.pint;
    case 'rush_att': return p.ra; case 'rush_yds': return p.ry; case 'rush_tds': return p.rtd; case 'receptions': return p.rec; case 'rec_yds': return p.recy;
    case 'rec_tds': return p.rectd; case 'fg_made': return p.fgm; case 'kicking_points': return p.kp;
    case 'rush_rec_yds': return p.ry + p.recy; case 'pass_rush_yds': return p.py + p.ry; case 'anytime_td': return p.rtd + p.rectd;
    case 'longest_rec': return p.reclong; case 'longest_rush': return p.rushlong;
    default: return null;
  }
}
const ZERO = { pa: 0, pc: 0, py: 0, ptd: 0, pint: 0, ra: 0, ry: 0, rtd: 0, rushlong: 0, rec: 0, recy: 0, rectd: 0, reclong: 0, fgm: 0, kp: 0, k: 0 };
const teamTotals = ps => {
  const o = { pa: 0, pc: 0, py: 0, ptd: 0, pint: 0, ra: 0, ry: 0, rtd: 0, fgm: 0, kp: 0 };
  for (const p of ps) { o.pa += p.pa; o.pc += p.pc; o.py += p.py; o.ptd += p.ptd; o.pint += p.pint; o.ra += p.ra; o.ry += p.ry; o.rtd += p.rtd; o.fgm += p.fgm; o.kp += p.kp; }
  return o;
};

// ── history ────────────────────────────────────────────────────────────────
// games (any order) → { players: Map(aid → [{ t, season, gid, team, opp, ...stats, tot }]),
// teams: Map(team id → [{ t, season, off: totals + pts, def: opponent's totals + pts }]),
// league: [{ t, season, off }] (one entry per team-game), names: Map(key → Set(aid)) }
function buildHistory(games) {
  const players = new Map(), teams = new Map(), league = [], names = new Map(), info = new Map();
  for (const g0 of [...games].filter(Boolean).sort((x, y) => x.t - y.t)) {
    // the seed drops zero fields: fill them back
    const g = { ...g0, players: (g0.players || []).map(p => ({ ...ZERO, ...p })) };
    const side = { [g.home]: g.players.filter(p => p.team === g.home), [g.away]: g.players.filter(p => p.team === g.away) };
    const tot = { [g.home]: { ...teamTotals(side[g.home]), pts: g.homePts }, [g.away]: { ...teamTotals(side[g.away]), pts: g.awayPts } };
    // a box with no offence on one side (forfeit, broken feed) never feeds the averages
    if (!(tot[g.home].pa + tot[g.home].ra > 20) || !(tot[g.away].pa + tot[g.away].ra > 20)) continue;
    for (const tm of [g.home, g.away]) {
      const opp = tm === g.home ? g.away : g.home;
      (teams.get(tm) || teams.set(tm, []).get(tm)).push({ t: g.t, season: g.season, gid: g.id, off: tot[tm], def: tot[opp] });
      league.push({ t: g.t, season: g.season, off: tot[tm] });
      info.set(tm, { abbr: tm === g.home ? g.homeAbbr : g.awayAbbr, name: tm === g.home ? g.homeName : g.awayName });
    }
    for (const p of g.players) {
      const opp = p.team === g.home ? g.away : g.home;
      (players.get(p.aid) || players.set(p.aid, []).get(p.aid)).push({ ...p, t: g.t, season: g.season, gid: g.id, opp, tot: tot[p.team] });
      (names.get(p.key) || names.set(p.key, new Set()).get(p.key)).add(p.aid);
    }
  }
  return { players, teams, league, names, info };
}

// entries strictly before t (history arrays are in time order)
function before(list, t) {
  if (!list) return [];
  let lo = 0, hi = list.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (list[m].t < t) lo = m + 1; else hi = m; }
  return list.slice(0, lo);
}
const YEAR_MS = 300 * 86400e3;
// the season a game time belongs to (Aug..Jan): its year, January counts as last year's
const seasonOf = t => { const d = new Date(t); return d.getUTCMonth() < 6 ? d.getUTCFullYear() - 1 : d.getUTCFullYear(); };

// weights for a list of past games (newest last): half-life in games, last season at a discount
function weights(list, season, halfLife, psw) {
  const n = list.length;
  return list.map((g, i) => Math.pow(0.5, (n - 1 - i) / halfLife) * ((g.season ?? seasonOf(g.t)) === season ? 1 : psw));
}

// league per-team-game means over the last year before t
const leagueCache = new Map();
function leagueMeans(H, t) {
  const ck = `${H.league.length}|${Math.floor(t / 86400e3)}`;
  if (leagueCache.has(ck)) return leagueCache.get(ck);
  const L = before(H.league, t).filter(x => x.t > t - YEAR_MS);
  const m = {};
  for (const c of CATS) m[c] = L.length ? L.reduce((a, x) => a + x.off[c], 0) / L.length : null;
  if (leagueCache.size > 2000) leagueCache.clear();
  leagueCache.set(ck, m);
  return m;
}

// a team's expected offence and what its defence allows, per category, shrunk to the league
function teamSide(H, team, t, season, o, lg) {
  const list = before(H.teams.get(team), t).filter(x => x.t > t - YEAR_MS);
  const w = weights(list, season, o.teamHalfLife, o.priorSeasonWeight);
  const W = w.reduce((a, b) => a + b, 0);
  const off = {}, def = {};
  for (const c of CATS) {
    const so = list.reduce((a, x, i) => a + w[i] * x.off[c], 0), sd = list.reduce((a, x, i) => a + w[i] * x.def[c], 0);
    off[c] = (so + o.teamK * lg[c]) / (W + o.teamK);
    def[c] = (sd + o.oppK * lg[c]) / (W + o.oppK);
  }
  return { off, def, games: list.length };
}

// ── projection ──────────────────────────────────────────────────────────────
// ctx { t, team, opp, total, spread (the player's team's: -7 = favoured) } →
// { mean: { stat → projected mean }, games, team, opp } or null (not enough history)
function project(H, aid, ctx, o = PARAMS) {
  const t = ctx.t;
  const season = seasonOf(t);
  const hist = before(H.players.get(aid), t).filter(x => x.t > t - YEAR_MS);
  const cur = hist.filter(x => (x.season ?? seasonOf(x.t)) === season);
  if (hist.length < o.minGames) return null;
  const team = ctx.team || hist[hist.length - 1].team;
  // a player's games for another school (transfer) still say his role; the share carries over
  const lg = leagueMeans(H, t);
  if (lg.pa == null) return null;
  const ts = teamSide(H, team, t, season, o, lg), os = ctx.opp ? teamSide(H, ctx.opp, t, season, o, lg) : null;
  const w = weights(hist, season, o.halfLife, o.priorSeasonWeight);
  const W = w.reduce((a, b) => a + b, 0);
  // expected team points from the two records, and the Vegas implied points
  const ptsRec = os ? ts.off.pts * (os.def.pts / lg.pts) : ts.off.pts;
  const implied = Number.isFinite(ctx.total) && Number.isFinite(ctx.spread) ? ctx.total / 2 - ctx.spread / 2 : null;
  const ratio = implied != null && ptsRec > 0 ? Math.min(2, Math.max(0.5, implied / ptsRec)) : 1;
  const sp = Number.isFinite(ctx.spread) ? ctx.spread : 0;
  const mean = {};
  for (const [s, c] of Object.entries(BASE)) {
    const num0 = hist.reduce((a, x, i) => a + w[i] * statOf(x, s), 0);
    const den = hist.reduce((a, x, i) => a + w[i] * x.tot[c], 0);
    const share = den > 0 ? num0 / den : 0;
    let teamC = ts.off[c] * (os ? os.def[c] / lg[c] : 1);
    const sc = o.script[GROUP[s]] || { alpha: 0, beta: 0, delta: 0 };
    teamC *= Math.pow(ratio, sc.alpha) * Math.exp(sc.beta * sp / 10) * Math.exp(-sc.delta * Math.max(0, Math.abs(sp) - 10) / 10);
    mean[s] = Math.max(0, share * teamC);
  }
  for (const [s, parts] of Object.entries(COMBOS)) mean[s] = parts.reduce((a, p) => a + mean[p], 0);
  for (const [s, [f, base]] of Object.entries(LONGEST)) {
    // longest play: his own weighted longest, scaled by how his projected yards compare with his usual
    const lw = hist.reduce((a, x, i) => a + w[i] * x[f], 0) / W;
    const yw = hist.reduce((a, x, i) => a + w[i] * statOf(x, base), 0) / W;
    mean[s] = yw > 0 ? lw * Math.pow(Math.max(0.2, mean[base] / yw), o.longExp) : lw;
  }
  return { mean, games: hist.length, curGames: cur.length, team, opp: ctx.opp || null, kicker: hist.some(x => x.k), passer: hist.some(x => x.pa >= 5) };
}

// ── distribution ────────────────────────────────────────────────────────────
// the band of a projection; P(actual > line) from the band's ratio quantiles
function bandOf(stat, m, o = PARAMS) {
  const bands = o.dist?.[stat];
  if (!bands || !bands.length) return null;
  return bands.find(b => m >= b.lo && m < b.hi) || (m < bands[0].lo ? bands[0] : bands[bands.length - 1]);
}
// share of the band's ratios above x (q ascending, equally spaced quantiles; linear between)
function tailAbove(q, x) {
  const n = q.length;
  if (!n) return null;
  if (x < q[0]) return 1;
  if (x >= q[n - 1]) return 0;
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (q[mid] <= x) lo = mid; else hi = mid; }
  // ties (a run of equal quantiles, e.g. the zero mass) count as at-or-below
  const f = q[hi] === q[lo] ? 1 : (x - q[lo]) / (q[hi] - q[lo]);
  return 1 - (lo + f) / (n - 1);
}
function probOver(proj, stat, line, o = PARAMS) {
  const m = proj?.mean?.[stat];
  if (!Number.isFinite(m) || !Number.isFinite(line)) return null;
  const b = bandOf(stat, m, o);
  if (!b) return null;
  if (m <= 0) return line < 0 ? 1 : 0;
  const p = tailAbove(b.q, line / m);
  return p == null ? null : Math.min(0.995, Math.max(0.005, p));
}
// { pOver, side, pSide, mean } at a line (half lines; a whole line's push is not split out)
// v2: the raw P(over) goes through the per-stat calibration fitted on ESPN
// BET's 2024-25 main lines (o.cal, propcal.js, shared with the NBA model); v1
// params carry none and pass through (checks/cfb-model-v2-2026-10-25)
function priceLine(proj, stat, line, o = PARAMS) {
  const raw = probOver(proj, stat, line, o);
  if (raw == null) return null;
  const pOver = propcal.calibrate(raw, stat, o.cal);
  const side = pOver >= 0.5 ? 'Over' : 'Under';
  // raw: the model's own P(over) before calibration (farlines.js reads the line's distance from it)
  return { pOver: Math.round(pOver * 1e4) / 1e4, side, pSide: Math.round((side === 'Over' ? pOver : 1 - pOver) * 1e4) / 1e4, mean: Math.round(proj.mean[stat] * 10) / 10, raw: Math.round(raw * 1e4) / 1e4 };
}
const expected = (proj, stat) => proj?.mean?.[stat] ?? null;
// the line where P(over) crosses 50%
function median(proj, stat, o = PARAMS) {
  const m = proj?.mean?.[stat], b = Number.isFinite(m) ? bandOf(stat, m, o) : null;
  if (!b) return null;
  const q = b.q;
  return Math.round(m * q[Math.floor((q.length - 1) / 2)] * 10) / 10;
}

// ── fitting helpers (backtest) ──────────────────────────────────────────────
// [{ stat, mean, actual }] → dist bands: nb bands of equal count per stat, k quantiles each
function fitDist(rows, { nb = 5, k = 101 } = {}) {
  const by = {};
  for (const r of rows) if (r.mean > 0 && Number.isFinite(r.actual)) (by[r.stat] ||= []).push(r);
  const dist = {};
  for (const [stat, rs] of Object.entries(by)) {
    rs.sort((a, b) => a.mean - b.mean);
    const bands = [];
    const n = Math.min(nb, Math.max(1, Math.floor(rs.length / 150)));
    for (let i = 0; i < n; i++) {
      const part = rs.slice(Math.floor(i * rs.length / n), Math.floor((i + 1) * rs.length / n));
      const ratios = part.map(r => r.actual / r.mean).sort((a, b) => a - b);
      const q = Array.from({ length: k }, (_, j) => Math.round(ratios[Math.round(j * (ratios.length - 1) / (k - 1))] * 1e4) / 1e4);
      bands.push({ lo: i === 0 ? 0 : part[0].mean, hi: i === n - 1 ? Infinity : rs[Math.floor((i + 1) * rs.length / n)].mean, n: part.length, q });
    }
    dist[stat] = bands;
  }
  return dist;
}
// the aid for a props row's player among the teams playing (name, then team)
function aidFor(H, name, teams = null) {
  const ids = [...(H.names.get(canonName(name)) || [])];
  if (!ids.length) return null;
  if (!teams) return ids.length === 1 ? ids[0] : null;
  const on = ids.filter(id => { const h = H.players.get(id); return h && teams.includes(h[h.length - 1].team); });
  return on.length === 1 ? on[0] : null;
}

module.exports = { STATS, BASE, COMBOS, LONGEST, PARAMS, spreadOf, compactGame, statOf, buildHistory, before, seasonOf, project,
  probOver, priceLine, expected, median, fitDist, tailAbove, bandOf, aidFor, leagueMeans };
