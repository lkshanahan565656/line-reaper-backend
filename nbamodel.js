// ─── NBA PLAYER-PROP MODEL ────────────────────────────────────────────────────
// Our own projection for every NBA player stat the pick'em apps post, built
// from ESPN box scores only (no sportsbook price goes in). One projection per
// player and game, from games that finished before that game's tip:
//
//   minutes   recent minutes weighted toward the last few games, pulled to
//             the season (and last season) when the sample is thin; lower on
//             the second night of a back-to-back; starters lose minutes when
//             the pre-game spread says blowout; freed minutes when teammates
//             are listed Out. A distribution (mean and spread), not a number.
//   rates     per-minute points, rebounds, assists, threes, steals, blocks and
//             turnovers, weighted to recent games and shrunk to the league.
//   context   the game's pace from both teams' recent possessions, the
//             scoring environment from the pre-game total and spread, and
//             what the opponent allows against the league average (shrunk).
//   spread    a negative binomial count per stat given minutes, mixed over the
//             minutes distribution, so P(over line) comes straight out.
//             Combos (PRA and the pairs) carry their own fitted dispersion.
//
// Pure functions: the backtest (scripts/nbamodel-backtest.js) and the server
// (nbadata.js) feed it the same compact games.

const { canonName } = require('./ev');

// The stats it projects, and how each combo is built from the parts.
const BASE = ['points', 'rebounds', 'assists', 'threes', 'steals', 'blocks', 'turnovers'];
const COMBOS = { pra: ['points', 'rebounds', 'assists'], pts_rebs: ['points', 'rebounds'], pts_asts: ['points', 'assists'],
  rebs_asts: ['rebounds', 'assists'], stocks: ['steals', 'blocks'] };
const STATS = [...BASE, ...Object.keys(COMBOS)];

const PARAMS = {
  // fitted 2026-10-25 on box scores 2024-11-20..2025-06-30 and 2025-11-15..2026-06-30
  // (negative binomial log-likelihood; no prop line used). The fit set the
  // back-to-back, blowout and pre-game-total adjustments to nothing: kept as
  // knobs, switched off by the data. freedShare/usageBump (players listed Out)
  // are not fitted: no pre-tip injury history could be read for the backtest.
  minHalfLife: 2, rateHalfLife: 18, priorSeasonWeight: 0.5, minPriorGames: 1, recentK: 300,
  rateK: { points: 84, rebounds: 84, assists: 84, threes: 175, steals: 350, blocks: 280, turnovers: 210 },
  oppK: 10, oppWeight: { points: 1, rebounds: 1, assists: 1, threes: 1, steals: 1, blocks: 1, turnovers: 1 },
  totalWeight: 0, b2b: 1, blowoutPerPt: 0, freedShare: 0.5, usageBump: 0.25,
  minSdFloor: 4, minSdScale: 1.2, longGapSd: 1,
  // var = mean + phi * mean^2 given minutes, per stat
  phi: { points: 0.132, rebounds: 0.0096, assists: 0.02, threes: 0.0504, steals: 0.03, blocks: 0.119, turnovers: 0.018, pra: 0.064, pts_rebs: 0.08, pts_asts: 0.08, rebs_asts: 0.014, stocks: 0.024 },
};

const num = v => { const x = parseFloat(v); return Number.isFinite(x) ? x : 0; };
const pair = v => String(v ?? '').split(/[/-]/).map(num);

// ── ESPN summary → one compact game ─────────────────────────────────────────
// { id, t, home, away, homePts, awayPts, total, spread (home team's: -6.5 =
// home favoured by 6.5), stype, players: [{ key, name, team, starter, min,
// points, rebounds, assists, threes, steals, blocks, turnovers, fga, fta,
// oreb }], dnp: { team: [key] } }
function spreadOf(pc, home, away) {
  const p = Array.isArray(pc) ? pc.find(x => x && (x.spread != null || x.details)) : null;
  if (!p) return { total: null, spread: null };
  const total = Number.isFinite(+p.overUnder) && +p.overUnder > 150 ? +p.overUnder : null;
  let spread = null;
  // "BOS -6.5": the favourite's abbreviation and its number; "EVEN" is 0
  const m = /^([A-Z]{2,4})\s+(-?\d+(?:\.\d+)?)$/.exec(String(p.details || '').trim());
  if (m) spread = m[1] === home ? +m[2] : m[1] === away ? -+m[2] : null;
  else if (/^even$/i.test(String(p.details || '').trim())) spread = 0;
  if (spread == null && Number.isFinite(+p.spread) && p.homeTeamOdds && p.awayTeamOdds) {
    const s = Math.abs(+p.spread);
    spread = p.homeTeamOdds.favorite ? -s : p.awayTeamOdds.favorite ? s : null;
  }
  return { total, spread };
}
function compactGame(sum) {
  const comp = sum?.comp || sum?.header?.competitions?.[0] || {};
  const cs = comp.competitors || [];
  const h = cs.find(c => c.homeAway === 'home'), a = cs.find(c => c.homeAway === 'away');
  if (!h || !a) return null;
  const home = h.team?.abbreviation, away = a.team?.abbreviation;
  const players = [], dnp = {};
  for (const tm of sum?.players || sum?.boxscore?.players || []) {
    const team = tm.team?.abbreviation;
    for (const g of tm.statistics || []) {
      const keys = g.keys || [];
      if (!keys.includes('points')) continue;
      for (const at of g.athletes || []) {
        const name = at.athlete?.displayName;
        if (!name) continue;
        const key = canonName(name);
        const s = {}; keys.forEach((k, i) => { s[k] = at.stats?.[i]; });
        const min = num(s.minutes);
        if (at.didNotPlay || !at.stats?.length || !(min > 0)) { (dnp[team] ||= []).push(key); continue; }
        players.push({ key, name, aid: String(at.athlete?.id || ''), team, starter: !!at.starter, min,
          points: num(s.points), rebounds: num(s.rebounds), assists: num(s.assists),
          threes: pair(s['threePointFieldGoalsMade-threePointFieldGoalsAttempted'])[0],
          steals: num(s.steals), blocks: num(s.blocks), turnovers: num(s.turnovers),
          fga: pair(s['fieldGoalsMade-fieldGoalsAttempted'])[1], fta: pair(s['freeThrowsMade-freeThrowsAttempted'])[1],
          oreb: num(s.offensiveRebounds) });
      }
    }
  }
  if (!players.length) return null;
  const { total, spread } = spreadOf(sum?.pickcenter, home, away);
  return { id: String(sum.id || comp.id || ''), t: Date.parse(comp.date || sum.date || ''), home, away,
    homePts: num(h.score), awayPts: num(a.score), total, spread, players, dnp };
}

// ── history ────────────────────────────────────────────────────────────────
// games (any order) → { players: Map(key → [{ t, gid, team, opp, home, ...stats }]),
// teams: Map(abbr → [{ t, poss, pts, allowed: { stat: per-poss } }]), league: [{ t, per-minute rates, poss, total }] }
const poss = ps => ps.reduce((s, p) => s + p.fga + 0.44 * p.fta - p.oreb + p.turnovers, 0);
function buildHistory(games) {
  const players = new Map(), teams = new Map(), league = [];
  for (const g of [...games].filter(Boolean).sort((x, y) => x.t - y.t)) {
    const side = { [g.home]: g.players.filter(p => p.team === g.home), [g.away]: g.players.filter(p => p.team === g.away) };
    const pz = { [g.home]: poss(side[g.home]), [g.away]: poss(side[g.away]) };
    const gp = (pz[g.home] + pz[g.away]) / 2;
    if (!(gp > 60)) continue;   // a broken box (no shooting lines) never feeds the averages
    for (const tm of [g.home, g.away]) {
      const opp = tm === g.home ? g.away : g.home;
      const allowed = {};
      for (const s of BASE) allowed[s] = side[opp].reduce((a, p) => a + p[s], 0) / gp;
      (teams.get(tm) || teams.set(tm, []).get(tm)).push({ t: g.t, gid: g.id, poss: gp, pts: tm === g.home ? g.homePts : g.awayPts, allowed,
        out: g.dnp?.[tm] || [], rot: side[tm].map(p => p.key) });
    }
    const mins = g.players.reduce((a, p) => a + p.min, 0);
    const rates = {}; for (const s of BASE) rates[s] = g.players.reduce((a, p) => a + p[s], 0) / mins;
    league.push({ t: g.t, rates, poss: gp, pts: g.homePts + g.awayPts, total: g.total });
    for (const p of g.players) {
      const opp = p.team === g.home ? g.away : g.home;
      (players.get(p.key) || players.set(p.key, []).get(p.key)).push({ ...p, t: g.t, gid: g.id, opp, home: p.team === g.home,
        teamPoss: gp, teamPts: p.team === g.home ? g.homePts : g.awayPts });
    }
  }
  return { players, teams, league };
}

// entries strictly before t (history arrays are in time order)
function before(list, t) {
  if (!list) return [];
  let lo = 0, hi = list.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (list[m].t < t) lo = m + 1; else hi = m; }
  return list.slice(0, lo);
}
const SEASON_MS = 120 * 86400e3;
// the NBA season a tip belongs to: games from August on count to the next year
const seasonOf = t => { const d = new Date(t); return d.getUTCMonth() >= 7 ? d.getUTCFullYear() + 1 : d.getUTCFullYear(); };

// league per-minute rates, pace and total over the 60 days before t
function leagueAt(H, t) {
  const L = before(H.league, t).filter(x => x.t >= t - 60 * 86400e3);
  const use = L.length >= 30 ? L : before(H.league, t).slice(-200);
  const rates = {}; for (const s of BASE) rates[s] = use.length ? use.reduce((a, x) => a + x.rates[s], 0) / use.length : null;
  const tot = use.filter(x => x.pts > 0);
  return { rates, poss: use.length ? use.reduce((a, x) => a + x.poss, 0) / use.length : 100,
    pts: tot.length ? tot.reduce((a, x) => a + x.pts, 0) / tot.length : 228, n: use.length };
}

// exponentially weighted mean with each game's weight halving every hl games
// back; last season's games also count priorSeasonWeight
function ewMean(list, f, hl, t, P, wf = () => 1) {
  let sw = 0, s = 0; const cur = seasonOf(t);
  for (let i = list.length - 1, k = 0; i >= 0; i--, k++) {
    const g = list[i];
    let w = Math.pow(0.5, k / hl) * wf(g);
    if (seasonOf(g.t) !== cur) w *= P.priorSeasonWeight;
    if (!(w > 1e-4)) continue;
    sw += w; s += w * f(g);
  }
  return sw > 0 ? { mean: s / sw, w: sw } : { mean: null, w: 0 };
}

// What one team's opponents put up per possession against it, vs the league
// (1.0 = average), shrunk with oppK pseudo-games
function oppFactor(H, opp, t, P, lg) {
  const list = before(H.teams.get(opp), t).filter(x => seasonOf(x.t) === seasonOf(t) || x.t >= t - SEASON_MS * 2);
  const out = {};
  for (const s of BASE) {
    const lgPer = lg.rates[s] != null ? lg.rates[s] * 240 / lg.poss : null;   // league per possession (240 player-minutes a game)
    if (!lgPer) { out[s] = 1; continue; }
    const e = ewMean(list, x => x.allowed[s], 15, t, P);
    const n = Math.min(list.length, 40);
    const raw = e.mean == null ? 1 : e.mean / lgPer;
    out[s] = 1 + (raw - 1) * (n / (n + P.oppK)) * (P.oppWeight[s] ?? 1);
  }
  return out;
}
function teamPace(H, tm, t, P, lg) {
  const list = before(H.teams.get(tm), t).slice(-30);
  const e = ewMean(list, x => x.poss, 10, t, P), n = Math.min(list.length, 30);
  return e.mean == null ? lg.poss : lg.poss + (e.mean - lg.poss) * n / (n + 6);
}
function teamPts(H, tm, t, P) {
  const list = before(H.teams.get(tm), t).slice(-30);
  return ewMean(list, x => x.pts, 10, t, P).mean;
}

// ── projection ────────────────────────────────────────────────────────────
// ctx: { team, opp, home, total, spread (home's), out: [player keys Out for
//        his team], t }
// → null when the player has no NBA minutes on record, else { minutes:
//   { mean, sd }, rate: { stat: per-minute }, mult: { stat }, games, ... }
function project(H, key, ctx, P = PARAMS) {
  const t = ctx.t;
  const all = before(H.players.get(key), t);
  const recent = all.filter(g => g.t >= t - 400 * 86400e3);
  if (!recent.length) return null;
  const cur = seasonOf(t);
  const thisSeason = recent.filter(g => seasonOf(g.t) === cur);
  const lg = leagueAt(H, t);

  // minutes: recent EW mean pulled toward the longer-run mean
  const ewMin = ewMean(recent, g => g.min, P.minHalfLife, t, P);
  const longMin = ewMean(recent, g => g.min, 25, t, P);
  const nCur = thisSeason.length;
  let mMean = (ewMin.mean * Math.min(ewMin.w, 8) + longMin.mean * P.minPriorGames) / (Math.min(ewMin.w, 8) + P.minPriorGames);
  const last = recent[recent.length - 1];
  const restDays = (t - last.t) / 86400e3;
  const b2b = restDays < 1.6;
  const longGap = restDays > 12;
  if (b2b) mMean *= P.b2b;
  const starter = ewMean(recent.slice(-5), g => (g.starter ? 1 : 0), 3, t, P).mean >= 0.5;
  // blowout: the side's spread from the home spread
  if (ctx.spread != null && starter) {
    const s = Math.abs(ctx.spread);
    if (s > 6) mMean *= 1 - P.blowoutPerPt * (s - 6);
  }
  // teammates listed Out: their recent minutes, a share picked up by the rest
  // of the rotation in proportion to each one's minutes; usage freed likewise
  let freedMin = 0, freedUse = 0;
  const outs = (ctx.out || []).filter(k => k !== key);
  if (outs.length) {
    for (const k of outs) {
      const h = before(H.players.get(k), t).filter(g => g.team === ctx.team).slice(-10);
      if (h.length < 3 || h[h.length - 1].t < t - 30 * 86400e3) continue;   // a long-term absence is already in everyone's recent minutes
      const m = h.reduce((a, g) => a + g.min, 0) / h.length;
      const u = h.reduce((a, g) => a + g.fga + 0.44 * g.fta + g.turnovers, 0) / h.reduce((a, g) => a + g.teamPoss, 0);
      freedMin += m; freedUse += u;
    }
    if (freedMin > 0) {
      // the rotation's minutes this player sits in (240 a game)
      const share = Math.max(0, Math.min(0.3, mMean / 240 * 1.6));
      mMean = Math.min(42, mMean + P.freedShare * freedMin * share);
    }
  }
  mMean = Math.max(1, Math.min(44, mMean));
  // minutes spread: the player's own recent deviations, floored
  const dev = Math.sqrt(ewMean(recent.slice(-15), g => (g.min - ewMin.mean) ** 2, 8, t, P).mean || 0);
  let mSd = Math.max(P.minSdFloor, P.minSdScale * dev);
  if (longGap || nCur < 3) mSd *= P.longGapSd;

  // per-minute rates, shrunk to the league's with rateK pseudo-minutes
  const rate = {};
  const minW = recent.reduce((a, g) => a + g.min, 0);
  for (const s of BASE) {
    // the long run (every game in the window, slowly decaying) shrunk to the
    // league's rate with rateK pseudo-minutes; recent form pulled toward that
    // long run with recentK pseudo-minutes
    const lgR = lg.rates[s] ?? 0;
    const lr = ewMean(recent, g => g[s] / g.min, 80, t, P, g => g.min);
    const longR = lr.mean == null ? lgR : (lr.mean * minW + lgR * P.rateK[s]) / (minW + P.rateK[s]);
    const e = ewMean(recent, g => g[s] / g.min, P.rateHalfLife, t, P, g => g.min);
    rate[s] = e.mean == null ? longR : (e.mean * e.w + longR * P.recentK) / (e.w + P.recentK);
  }
  if (freedUse > 0) {
    const ownUse = ewMean(recent, g => (g.fga + 0.44 * g.fta + g.turnovers) / Math.max(1, g.teamPoss), 10, t, P).mean || 0;
    const lift = 1 + P.usageBump * Math.min(0.4, freedUse) * Math.min(2, ownUse / 0.18);
    rate.points *= lift; rate.assists *= 1 + (lift - 1) * 0.6; rate.threes *= 1 + (lift - 1) * 0.8; rate.turnovers *= 1 + (lift - 1) * 0.6;
  }

  // context: pace, opponent, scoring environment
  const myTeam = ctx.team || last.team;
  const pace = (teamPace(H, myTeam, t, P, lg) + teamPace(H, ctx.opp, t, P, lg)) / 2;
  const ownPace = ewMean(recent, g => g.teamPoss, 15, t, P).mean || lg.poss;
  const paceF = Math.max(0.85, Math.min(1.15, pace / ownPace));
  const opp = oppFactor(H, ctx.opp, t, P, lg);
  const mult = {};
  for (const s of BASE) mult[s] = paceF * opp[s];
  // points: the pre-game total and spread give this team's expected points;
  // against what this player's team scored in his recent games
  if (ctx.total != null && ctx.spread != null) {
    const homeExp = (ctx.total - ctx.spread) / 2, exp = ctx.home ? homeExp : ctx.total - homeExp;
    const own = ewMean(recent, g => g.teamPts, 15, t, P).mean;
    if (own > 60 && exp > 60) {
      const envF = Math.max(0.8, Math.min(1.2, exp / own));
      mult.points = Math.pow(mult.points, 1 - P.totalWeight) * Math.pow(envF, P.totalWeight);
      mult.threes = Math.pow(mult.threes, 1 - P.totalWeight * 0.7) * Math.pow(envF, P.totalWeight * 0.7);
    }
  }
  return { key, minutes: { mean: mMean, sd: mSd }, rate, mult, games: recent.length, gamesThisSeason: nCur, restDays, b2b, starter,
    freedMin, outs: outs.length, lastTeam: last.team };
}

// ── distributions ──────────────────────────────────────────────────────────
// log-gamma (Lanczos)
const LG = [676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
function lgamma(z) {
  if (z < 0.5) return Math.log(Math.PI / Math.abs(Math.sin(Math.PI * z))) - lgamma(1 - z);
  z -= 1; let x = 0.99999999999980993;
  for (let i = 0; i < 8; i++) x += LG[i] / (z + i + 1);
  const tt = z + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(tt) - tt + Math.log(x);
}
// P(X <= k) and P(X = k) for a count with mean mu and var mu + phi mu^2
// (negative binomial; Poisson when phi is 0)
function countCdf(k, mu, phi) {
  if (k < 0) return { cdf: 0, pmf: 0 };
  if (!(mu > 0)) return { cdf: 1, pmf: k === 0 ? 1 : 0 };
  let logp, step;
  if (phi > 1e-9) {
    const r = 1 / phi, p = r / (r + mu);   // success prob
    logp = r * Math.log(p);                 // P(0)
    step = i => Math.log((i - 1 + r) / i) + Math.log(1 - p);
  } else {
    logp = -mu; step = i => Math.log(mu / i);
  }
  let cdf = Math.exp(logp), pm = cdf;
  for (let i = 1; i <= k; i++) { logp += step(i); pm = Math.exp(logp); cdf += pm; }
  return { cdf: Math.min(1, cdf), pmf: pm };
}

// probabilists' Hermite nodes and weights (sum 1), 9 points
const NODES = [-4.5127458633997834, -3.2054290028564703, -2.0768479786778302, -1.0232556637891326, 0, 1.0232556637891326, 2.0768479786778302, 3.2054290028564703, 4.5127458633997834];
const WEIGHTS = [2.2345844007746e-5, 0.0027891413212318, 0.049916406765218, 0.24409750289494, 0.40634920634921, 0.24409750289494, 0.049916406765218, 0.0027891413212318, 2.2345844007746e-5];

// the stat's mean given minutes m
function statMean(proj, stat, m) {
  const parts = COMBOS[stat] || [stat];
  return parts.reduce((a, s) => a + proj.rate[s] * proj.mult[s] * m, 0);
}
function expected(proj, stat) {
  let e = 0;
  for (let i = 0; i < NODES.length; i++) {
    const m = Math.max(0, Math.min(48, proj.minutes.mean + proj.minutes.sd * NODES[i]));
    e += WEIGHTS[i] * statMean(proj, stat, m);
  }
  return e;
}
// P(over line), P(push) for a line, mixing over minutes. A line of 0.5 on a
// whole-number stat is "1 or more".
function probOver(proj, stat, line, P = PARAMS) {
  const phi = P.phi[stat] ?? 0.1;
  const k = Math.floor(line);
  const whole = Math.abs(line - k) < 1e-9;
  let over = 0, push = 0;
  for (let i = 0; i < NODES.length; i++) {
    const m = Math.max(0, Math.min(48, proj.minutes.mean + proj.minutes.sd * NODES[i]));
    const mu = statMean(proj, stat, m);
    if (whole) {
      const below = countCdf(k - 1, mu, phi).cdf, at = countCdf(k, mu, phi);
      over += WEIGHTS[i] * (1 - at.cdf); push += WEIGHTS[i] * (at.cdf - below);
    } else {
      over += WEIGHTS[i] * (1 - countCdf(k, mu, phi).cdf);
    }
  }
  return { over, push, under: Math.max(0, 1 - over - push) };
}
// the median of the projection (the number we'd hang)
function median(proj, stat, P = PARAMS) {
  const mean = expected(proj, stat);
  let k = Math.max(0, Math.floor(mean));
  for (let step = 0; step < 200; step++) {
    const below = 1 - probOver(proj, stat, k + 0.5, P).over;   // P(X <= k)
    if (below >= 0.5) { if (k === 0 || 1 - probOver(proj, stat, k - 0.5, P).over < 0.5) return k; k--; } else k++;
  }
  return k;
}

// one row of the NBA MODEL section: the projection at the app's number
function priceLine(proj, stat, line, P = PARAMS) {
  if (!proj || !STATS.includes(stat) || !Number.isFinite(line)) return null;
  const p = probOver(proj, stat, line, P);
  const n = 1 - p.push;
  const pOver = n > 0 ? p.over / n : 0.5;   // a push is a void on the apps
  return { stat, line, mean: Math.round(expected(proj, stat) * 10) / 10, pOver: Math.round(pOver * 1e4) / 1e4,
    side: pOver >= 0.5 ? 'Over' : 'Under', pSide: Math.round(Math.max(pOver, 1 - pOver) * 1e4) / 1e4,
    minutes: Math.round(proj.minutes.mean * 10) / 10 };
}

module.exports = { PARAMS, BASE, COMBOS, STATS, compactGame, spreadOf, buildHistory, before, seasonOf, leagueAt, project, probOver,
  expected, median, priceLine, countCdf, lgamma };
