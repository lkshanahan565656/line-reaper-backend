// ─── ESPORTS HEAD-TO-HEAD MATCHUP ENGINE (esmatchup.js) ──────────────────────
// League of Legends first. Our own transparent team model, built only from
// finished series (lolesports schedule results), every number explainable:
//
//   1. Map ratings (Glicko). Each team has a rating and an uncertainty (RD).
//      A series updates both teams with its map score, maps weighted by
//      `mapWeight` (maps inside one series are not independent). RD grows
//      while a team sits idle, so a team back from the off-season is
//      uncertain again, and its rating is pulled part of the way back toward
//      its league's average (`breakShrink`): rosters change between splits.
//   2. New teams start at their league's current average with a wide RD, so
//      an LCK newcomer and an ERL newcomer don't both start at 1500.
//   3. Map win probability = Glicko's expected score with both teams' RDs in
//      it (more uncertainty pulls toward 50%), on a scale fitted to history.
//   4. Series math. A favourite sweeps more often than independent maps say,
//      so a series' map chance q is drawn from a Beta around p with
//      concentration `kappa` (beta-binomial; kappa = Infinity is independent
//      maps). That gives the series winner, every correct score, total maps
//      and the -1.5 handicap from one number.
//   5. Head-to-head and form are shown with their numbers. They enter the
//      price only by the weight the walk-forward fit gave them (h2hWeight).
//
// Uncertainty: a one-sd band on the match probability from the two RDs.
// Confidence is 'insufficient' when either team has too few recent maps or
// its RD is near the new-team level; those matchups carry no model price.
//
// Everything here is pure: the data layer (esmatchupdata.js) feeds series in
// time order and the server reads predictions. Model outputs are a model,
// never a proven edge: the backtest against Kalshi says how it really does.

const DEFAULTS = {
  r0: 1500,
  rdNew: 260,          // a brand-new team in a known league
  rdUnknown: 330,      // a new team whose league we can't place
  rdMax: 330,
  rdMin: 45,
  rdPerDay: 13,        // c: RD grows by sqrt(c^2 * days) while idle
  mapWeight: 0.6,      // each map's weight in an update
  breakDays: 40,       // an idle gap this long is an off-season
  breakShrink: 0.4,    // share of the rating pulled back to the league average after a break
  newOffset: -80,      // new teams start this far under their league average
  scale: 0.9,          // logit scale on the map probability, fitted
  kappa: 10,           // series shape: Beta concentration of a series' map chance
  h2hWeight: 1,        // logit points per shrunk h2h map edge (fitted 2024-07..2025-12; small out of sample)
  h2hDays: 730,
  h2hShrink: 4,        // maps of prior at 50% in the h2h edge
  minMaps: 8,          // recent maps each team needs before we price
  recentDays: 300,
  maxRdPriced: 200,    // RD above this: insufficient data
  lowRdBoth: 215,      // both RDs together above this (the top quarter in 2026): low confidence
  homeN: 12,           // recent series that decide a team's home league
  leaguePrior: null,   // league → starting rating; null uses LEAGUE_PRIOR
  unknownPrior: 1420,  // a league with no prior
  leagueEta: 0.3,      // cross-league results move every team of a league by this share. 1.2 (fitted on all series) let a few upsets lift the LEC over the LPL; 0.3 cut log loss on the 165 major-league international series since 2025 from 0.585 to 0.555 for +0.0002 on all 2026 series
  leagueCap: 150,      // most a league can learn either way: ERLs only meet each other, and without a cap the best ERL drifted level with the LPL
  offsetIntlOnly: true, // league strength learns only from international events: a team whose home label still lags after promotion (Karmine Corp in its first LEC split) made domestic games look cross-league
  tier2Re: /wsci/i,    // academy-level events where a main team's name can stand for its second roster: skipped when a major-league team plays
};
const MAJOR = new Set(['LCK', 'LPL', 'LEC', 'LCS', 'LCP', 'CBLOL', 'PCS', 'VCS']);

// The numbers above were fitted by walk-forward log loss on 2024-07 to
// 2025-12 series and tested on 2026 (scripts/esmatchup-backtest.js).

// Where each league starts, on the rating scale. Leagues that never meet
// (LEC and LFL, LCK and LPL outside internationals) can't be placed against
// each other by results alone, so each starts at a prior: its tier, set by
// hand from the international record, shown on the ratings page. New teams
// start at their league's prior and an off-season pulls part of the way back
// to it. Results move everything from there.
const LEAGUE_PRIOR = {
  LCK: 1800, LPL: 1790,
  LEC: 1660, 'LTA North': 1580, LCS: 1580, LCP: 1580, PCS: 1540, VCS: 1550, 'LTA South': 1520, CBLOL: 1520, LJL: 1470, LLA: 1470, LCO: 1420,
  'LCK Challengers': 1560, NACL: 1430,
  'La Ligue Française': 1510, 'Prime League': 1480, LES: 1490, TCL: 1460, NLC: 1440, 'LoL Italian Tournament': 1420, 'Hitpoint Masters': 1420,
  'Rift Legends': 1420, 'Road of Legends': 1400, 'Esports Balkan League': 1400, 'Hellenic Legends League': 1380, 'Arabian League': 1400, 'Liga Portuguesa': 1390,
  'Circuito Desafiante': 1420, LRN: 1380, LRS: 1380,
};

// Renamed leagues are one league: the LCS ran as LTA North in 2025, CBLOL
// as LTA South.
const LEAGUE_ALIAS = { 'LTA North': 'LCS', 'LTA South': 'CBLOL' };

const Q = Math.LN10 / 400;
const clampP = p => Math.min(1 - 1e-6, Math.max(1e-6, p));
const logit = p => Math.log(clampP(p) / (1 - clampP(p)));
const sigmoid = x => 1 / (1 + Math.exp(-x));
const r4 = x => (x == null || !Number.isFinite(x) ? null : Math.round(x * 1e4) / 1e4);
const r1 = x => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10) / 10);

// International events and cross-league qualifiers: they connect leagues but
// never make a team's "home" league.
const INTL_RE = /worlds|world championship|\bmsi\b|mid-season|first stand|esports world cup|\bewc\b|asian games|emea masters|americas cup|cross-conference|wsci|dcgi|cacg|promotion|kespa cup/i;
const isIntl = lg => INTL_RE.test(String(lg || ''));

// ── names ──
// "T1", "Gen.G", "Movistar KOI Fénix" → stable keys. Academy rosters keep their
// suffix, so "T1 Academy" never becomes T1.
function teamKey(n) {
  return String(n || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[\u200B-\u200F\u2060-\u2064\uFEFF]/g, '')
    .toLowerCase().replace(/['’]s\b/g, '').replace(/\b(team|esports?|gaming|club)\b/g, '').replace(/[^a-z0-9]/g, '');
}

// How alike two names for one team are, 0 to 1. Venues and lolesports name
// sponsors differently ("OKSavingsBank BRION" / "HANJIN BRION", "JD Gaming" /
// "Beijing JDG Esports", "DRX" / "KIWOOM DRX"), so whole words count, a word
// that starts another counts most of the way, and a code counts. Loose on
// purpose: it is only ever used to pick between the few series in one time
// slot, and both teams have to fit.
const STOP = new Set(['team', 'esports', 'esport', 'gaming', 'club', 'e', 'sport', 'sports', 'the', 'gg', 'de', 'fc']);
const SECOND = new Set(['academy', 'challengers', 'youth', 'junior', 'rising', 'nxt', 'next', 'pride', 'itero', 'blue', 'ii', '2']);
function words(n) {
  return String(n || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()
    .split(/[^a-z0-9]+/).filter(w => w && !STOP.has(w));
}
function nameScore(a, b, codeB = null) {
  if (!a || !b) return 0;
  if (teamKey(a) === teamKey(b)) return 1;
  const sq = x => String(x || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (codeB && sq(a) === sq(codeB)) return 0.95;
  const wa = words(a), wb = words(b);
  if (!wa.length || !wb.length) return 0;
  // a second roster on one side only is a different team
  const sa = wa.some(w => SECOND.has(w)), sb = wb.some(w => SECOND.has(w));
  if (sa !== sb) return 0;
  const core = ws => ws.filter(w => !SECOND.has(w));
  const ca = core(wa), cb = core(wb);
  if (!ca.length || !cb.length) return 0;
  let hit = 0;
  for (const x of ca) {
    let best = 0;
    for (const y of cb) {
      if (x === y) best = 1;
      else if (Math.min(x.length, y.length) >= 2 && (x.startsWith(y) || y.startsWith(x))) best = Math.max(best, 0.7);
    }
    hit += best;
  }
  let sc = Math.min(1, hit / Math.min(ca.length, cb.length)) * 0.9;
  // sponsors go in front: the team's own word is usually last ("HANJIN BRION")
  const la = ca[ca.length - 1], lb = cb[cb.length - 1];
  if (la.length >= 2 && lb.length >= 2 && (la === lb || (Math.min(la.length, lb.length) >= 3 && (la.startsWith(lb) || lb.startsWith(la))))) sc = Math.max(sc, 0.75);
  return sc;
}

// ── math ──
function lgamma(x) {
  // Lanczos, g = 7
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x);
  x -= 1;
  let a = c[0];
  const t = x + 7.5;
  for (let i = 1; i < 9; i++) a += c[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}
const lbeta = (a, b) => lgamma(a) + lgamma(b) - lgamma(a + b);
const choose = (n, k) => { let r = 1; for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i; return r; };

// Every final score of a best-of-n for team A at map chance p, with the
// series' chance drawn from Beta(kappa p, kappa (1-p)). Bo2 can draw.
// → [{ a, b, prob }]
function seriesScores(p, bestOf = 3, kappa = DEFAULTS.kappa) {
  p = clampP(p);
  const n = Number(bestOf) || 1;
  const indep = !Number.isFinite(kappa) || kappa <= 0;
  const al = kappa * p, be = kappa * (1 - p), lb0 = indep ? 0 : lbeta(al, be);
  // E[q^x (1-q)^y] under the Beta (or p^x (1-p)^y independent)
  const mom = (x, y) => (indep ? p ** x * (1 - p) ** y : Math.exp(lbeta(al + x, be + y) - lb0));
  if (n === 2) return [{ a: 2, b: 0, prob: mom(2, 0) }, { a: 1, b: 1, prob: 2 * mom(1, 1) }, { a: 0, b: 2, prob: mom(0, 2) }];
  const w = Math.ceil(n / 2), out = [];
  for (let j = 0; j < w; j++) {
    out.push({ a: w, b: j, prob: choose(w - 1 + j, j) * mom(w, j) });
    out.push({ a: j, b: w, prob: choose(w - 1 + j, j) * mom(j, w) });
  }
  return out.sort((x, y) => (y.a - y.b) - (x.a - x.b));
}
function seriesProb(p, bestOf = 3, kappa = DEFAULTS.kappa) {
  if (Number(bestOf) === 1) return clampP(p);
  return seriesScores(p, bestOf, kappa).filter(s => s.a > s.b).reduce((x, s) => x + s.prob, 0);
}
// the map chance that gives a series chance (to read a market's map price)
function mapFromSeries(ps, bestOf = 3, kappa = DEFAULTS.kappa) {
  if (Number(bestOf) === 1) return ps;
  let lo = 1e-4, hi = 1 - 1e-4;
  for (let i = 0; i < 50; i++) { const mid = (lo + hi) / 2; if (seriesProb(mid, bestOf, kappa) < ps) lo = mid; else hi = mid; }
  return (lo + hi) / 2;
}
// the market-facing prices for one series from the map chance
function seriesMarkets(p, bestOf, kappa) {
  const scores = seriesScores(p, bestOf, kappa);
  const n = Number(bestOf) || 1;
  const win = scores.filter(s => s.a > s.b).reduce((x, s) => x + s.prob, 0);
  const loss = scores.filter(s => s.a < s.b).reduce((x, s) => x + s.prob, 0);
  const out = { bestOf: n, mapProb: r4(p), win: r4(win), loss: r4(loss), scores: scores.map(s => ({ score: `${s.a}-${s.b}`, prob: r4(s.prob) })) };
  if (n === 2) out.draw = r4(1 - win - loss);
  if (n >= 3) {
    const w = Math.ceil(n / 2);
    const full = scores.filter(s => s.a + s.b === n).reduce((x, s) => x + s.prob, 0);
    out.allMaps = r4(full); // the decider gets played
    // over (n-1.5) maps: anything but a sweep (Bo3 over 2.5 = 2-1/1-2; Bo5 over 3.5 = 3-1, 3-2 either way)
    const sweeps = scores.filter(s => Math.min(s.a, s.b) === 0).reduce((x, s) => x + s.prob, 0);
    out.totalMaps = { line: w + 0.5, over: r4(1 - sweeps) };
    // A -1.5: win by 2+ maps
    out.aMinus1p5 = r4(scores.filter(s => s.a - s.b >= 2).reduce((x, s) => x + s.prob, 0));
    out.bMinus1p5 = r4(scores.filter(s => s.b - s.a >= 2).reduce((x, s) => x + s.prob, 0));
  }
  return out;
}

// ── ratings ──
const g = rd => 1 / Math.sqrt(1 + (3 * Q * Q * rd * rd) / (Math.PI * Math.PI));
const expected = (r, rj, rdj) => 1 / (1 + Math.pow(10, (-g(rdj) * (r - rj)) / 400));

function createRatings(opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const teams = new Map();          // key → team
  const pairs = new Map();          // 'a|b' → [{ t, aWins, bWins, lg }]
  const leagueOf = new Map();       // league → Set of team keys whose home it is
  let last = 0, count = 0;

  const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  function homeLeague(tm) {
    const c = {};
    for (const lg of tm.leagues.slice(-o.homeN)) if (!isIntl(lg)) c[lg] = (c[lg] || 0) + 1;
    let best = null;
    for (const [lg, n] of Object.entries(c)) if (!best || n > best[1]) best = [lg, n];
    return best ? best[0] : null;
  }
  // a league's average current rating (teams active in the last year, settled RD)
  function leagueAvg(lg, t) {
    const set = lg && leagueOf.get(lg);
    if (!set) return null;
    let s = 0, n = 0;
    for (const k of set) {
      const tm = teams.get(k);
      if (!tm || tm.home !== lg || t - tm.lastT > 365 * 86400e3 || tm.maps < o.minMaps) continue;
      s += tm.r; n++;
    }
    return n >= 3 ? s / n : null;
  }
  const priors = o.leaguePrior || LEAGUE_PRIOR;
  // league strength learned from cross-league series, on top of each team
  const off = new Map();
  const offOf = tm => (tm && tm.home ? off.get(tm.home) || 0 : 0);
  const capOff = x => Math.max(-o.leagueCap, Math.min(o.leagueCap, x));
  const eff = tm => tm.r + offOf(tm);
  const priorOf = lg => (lg && priors[lg] != null ? priors[lg] : null);
  // RD after `days` idle
  const rdAt = (tm, t) => Math.min(o.rdMax, Math.sqrt(tm.rd * tm.rd + o.rdPerDay * o.rdPerDay * Math.max(0, (t - tm.lastT) / 86400e3)));

  function ensure(name, code, lg, t) {
    const key = teamKey(name);
    if (!key) return null;
    let tm = teams.get(key);
    if (!tm) {
      const home = isIntl(lg) ? null : lg;
      const prior = priorOf(home);
      const avg = prior == null && home ? leagueAvg(home, t) : null;
      const r = prior != null ? prior : avg != null ? avg : o.unknownPrior;
      tm = {
        key, name, code: code || null, r: r + o.newOffset, rd: prior != null || avg != null ? o.rdNew : o.rdUnknown,
        firstT: t, lastT: t, maps: 0, series: 0, leagues: [], home, history: [], startedAt: prior != null ? `${home} prior` : avg != null ? `${home} average` : 'unknown league',
      };
      teams.set(key, tm);
    }
    if (code && !tm.code) tm.code = code;
    if (name && t >= (tm.nameT || 0)) { tm.name = name; tm.nameT = t; }
    return tm;
  }
  // off-season: part of the rating goes back to the league average
  function wake(tm, t) {
    if (t - tm.lastT >= o.breakDays * 86400e3 && tm.series > 0) {
      const avg = priorOf(tm.home) ?? leagueAvg(tm.home, t) ?? o.unknownPrior;
      tm.r = tm.r + o.breakShrink * (avg - tm.r);
      tm.breaks = (tm.breaks || 0) + 1;
    }
    tm.rd = rdAt(tm, t);
  }

  // s: { t (ms), lg, bo, a, ac, b, bc, s1, s2 } with s1/s2 map wins
  function update(s0) {
    const s = LEAGUE_ALIAS[s0.lg] ? { ...s0, lg: LEAGUE_ALIAS[s0.lg] } : s0;
    const t = typeof s.t === 'number' ? s.t : Date.parse(s.t);
    if (!Number.isFinite(t) || s.s1 == null || s.s2 == null) return null;
    if (o.tier2Re && o.tier2Re.test(String(s.lg || ''))) {
      const ha = teams.get(teamKey(s.a))?.home, hb = teams.get(teamKey(s.b))?.home;
      if (MAJOR.has(ha) || MAJOR.has(hb)) return null;
    }
    const A = ensure(s.a, s.ac, s.lg, t), B = ensure(s.b, s.bc, s.lg, t);
    if (!A || !B || A === B) return null;
    wake(A, t); wake(B, t);
    const offA = offOf(A), offB = offOf(B);
    const ra = A.r + offA, rb = B.r + offB, rda = A.rd, rdb = B.rd;
    const m = (Number(s.s1) || 0) + (Number(s.s2) || 0);
    if (m > 0) {
      const w = o.mapWeight;
      const step = (r, rd, rj, rdj, wins, losses) => {
        const E = expected(r, rj, rdj), gj = g(rdj);
        const d2inv = w * (wins + losses) * Q * Q * gj * gj * E * (1 - E);
        const denom = 1 / (rd * rd) + d2inv;
        const r2 = r + (Q / denom) * w * gj * (wins - (wins + losses) * E);
        return { r: r2, rd: Math.max(o.rdMin, Math.sqrt(1 / denom)) };
      };
      const na = step(ra, rda, rb, rdb, Number(s.s1), Number(s.s2));
      const nb = step(rb, rdb, ra, rda, Number(s.s2), Number(s.s1));
      A.r = na.r - offA; A.rd = na.rd; B.r = nb.r - offB; B.rd = nb.rd;
      if (o.leagueEta && A.home && B.home && A.home !== B.home && (!o.offsetIntlOnly || isIntl(s.lg))) {
        const E = expected(ra, rb, Math.sqrt(rda * rda + rdb * rdb));
        const d = o.leagueEta * w * (Number(s.s1) - m * E) * 400 / Math.LN10 / 4;
        off.set(A.home, capOff((off.get(A.home) || 0) + d));
        off.set(B.home, capOff((off.get(B.home) || 0) - d));
      }
    }
    for (const [tm, opp, won, lost, before] of [[A, B, s.s1, s.s2, ra], [B, A, s.s2, s.s1, rb]]) {
      tm.maps += m; tm.series += 1; tm.lastT = t;
      tm.leagues.push(s.lg || ''); if (tm.leagues.length > 40) tm.leagues.shift();
      const prevHome = tm.home;
      tm.home = homeLeague(tm) || tm.home;
      if (prevHome && prevHome !== tm.home) {
        leagueOf.get(prevHome)?.delete(tm.key);
        // a team that changes league keeps its strength: only the label moves
        tm.r += (off.get(prevHome) || 0) - (off.get(tm.home) || 0);
      }
      if (tm.home) { if (!leagueOf.has(tm.home)) leagueOf.set(tm.home, new Set()); leagueOf.get(tm.home).add(tm.key); }
      tm.history.push({ t, opp: opp.name, oppKey: opp.key, won: Number(won), lost: Number(lost), lg: s.lg || null, bo: Number(s.bo) || null, before: Math.round(before), after: Math.round(eff(tm)) });
      if (tm.history.length > 60) tm.history.shift();
    }
    const pk = pairKey(A.key, B.key);
    if (!pairs.has(pk)) pairs.set(pk, []);
    pairs.get(pk).push({ t, [A.key]: Number(s.s1), [B.key]: Number(s.s2), lg: s.lg || null, bo: Number(s.bo) || null });
    last = Math.max(last, t); count++;
    return { a: A.key, b: B.key };
  }

  function find(name) {
    const key = teamKey(name);
    if (!key) return null;
    if (teams.has(key)) return teams.get(key);
    // a code ("GEN", "BLG") or a short form ("KOI" for Movistar KOI)
    const lower = String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    let hit = null;
    for (const tm of teams.values()) {
      if (tm.code && tm.code.toLowerCase().replace(/[^a-z0-9]/g, '') === lower) { if (!hit || tm.lastT > hit.lastT) hit = tm; }
    }
    if (hit) return hit;
    for (const tm of teams.values()) {
      if (key.length >= 3 && tm.key.startsWith(key) && !/^(academy|rising|nxt|junior|youth|global|next|ii|2)/.test(tm.key.slice(key.length))) { if (!hit || tm.lastT > hit.lastT) hit = tm; }
    }
    return hit;
  }

  // shrunk head-to-head map edge for A over B: (wins + k/2) / (maps + k) - 1/2
  function h2h(a, b, t) {
    const rows = (pairs.get(pairKey(a.key, b.key)) || []).filter(x => x.t < t && t - x.t <= o.h2hDays * 86400e3);
    let aw = 0, bw = 0;
    for (const x of rows) { aw += x[a.key] || 0; bw += x[b.key] || 0; }
    const n = aw + bw;
    return { series: rows.length, aMaps: aw, bMaps: bw, edge: n ? (aw + o.h2hShrink / 2) / (n + o.h2hShrink) - 0.5 : 0, rows };
  }

  function recentMaps(tm, t) {
    let n = 0;
    for (const h of tm.history) if (t - h.t <= o.recentDays * 86400e3) n += h.won + h.lost;
    return n;
  }

  // the model's view of A vs B at time t (defaults to now)
  function predict(aName, bName, { bestOf = 3, t = Date.now() } = {}) {
    const A = find(aName), B = find(bName);
    const reasons = [];
    if (!A) reasons.push(`${aName}: no finished series in our data`);
    if (!B) reasons.push(`${bName}: no finished series in our data`);
    if (!A || !B || A === B) return { ok: false, confidence: 'insufficient', reasons, teams: [A ? teamView(A, t) : null, B ? teamView(B, t) : null] };
    const rda = rdAt(A, t), rdb = rdAt(B, t);
    for (const [tm, rd] of [[A, rda], [B, rdb]]) {
      const rm = recentMaps(tm, t);
      if (rm < o.minMaps) reasons.push(`${tm.name}: ${rm} maps in the last ${o.recentDays} days (needs ${o.minMaps})`);
      if (rd > o.maxRdPriced) reasons.push(`${tm.name}: rating uncertainty ${Math.round(rd)} (over ${o.maxRdPriced})`);
    }
    // after a long break the shrink would apply at the next series: preview it
    const rNow = tm => offOf(tm) + (t - tm.lastT >= o.breakDays * 86400e3 ? tm.r + o.breakShrink * ((priorOf(tm.home) ?? leagueAvg(tm.home, t) ?? o.unknownPrior) - tm.r) : tm.r);
    const ra = rNow(A), rb = rNow(B);
    const rdBoth = Math.sqrt(rda * rda + rdb * rdb);
    const gap = ra - rb;
    const base = 1 / (1 + Math.pow(10, (-g(rdBoth) * gap) / 400));
    const hh = h2h(A, B, t);
    const h2hShift = o.h2hWeight * hh.edge;
    const map = sigmoid(o.scale * logit(base) + h2hShift);
    const bo = Number(bestOf) || 1;
    const markets = seriesMarkets(map, bo, o.kappa);
    // one-sd band on the gap from both RDs
    const band = [gap - rdBoth, gap + rdBoth].map(d => seriesProb(sigmoid(o.scale * logit(1 / (1 + Math.pow(10, -d / 400))) + h2hShift), bo, o.kappa));
    // cross-league games are where the model is weakest (2026 log loss 0.61
    // on international series vs 0.58 overall), so they never read as 'ok'
    const crossLeague = !!(A.home && B.home && A.home !== B.home);
    const confidence = reasons.length ? 'insufficient' : rdBoth > o.lowRdBoth || crossLeague ? 'low' : 'ok';
    return {
      ok: confidence !== 'insufficient', confidence, reasons, priced: confidence !== 'insufficient', crossLeague,
      teams: [teamView(A, t), teamView(B, t)],
      rating: { a: Math.round(ra), b: Math.round(rb), gap: Math.round(gap), rdA: Math.round(rda), rdB: Math.round(rdb), mapBase: r4(base) },
      h2h: { series: hh.series, maps: [hh.aMaps, hh.bMaps], edge: r4(hh.edge), weight: o.h2hWeight, shift: r4(h2hShift), mapPts: r1((map - sigmoid(o.scale * logit(base))) * 100), days: o.h2hDays, last: hh.rows.slice(-5).reverse().map(x => ({ t: new Date(x.t).toISOString(), score: `${x[A.key]}-${x[B.key]}`, lg: x.lg })) },
      map: r4(map), series: markets, band: band.map(r4),
    };
  }

  function teamView(tm, t = Date.now()) {
    const hist = tm.history.slice(-10).reverse();
    const w = hist.filter(h => h.won > h.lost).length, l = hist.filter(h => h.won < h.lost).length;
    const month = tm.history.filter(h => t - h.t <= 30 * 86400e3);
    const delta30 = month.length ? Math.round(eff(tm) - month[0].before) : 0;
    return {
      name: tm.name, code: tm.code, key: tm.key, rating: Math.round(eff(tm)), leagueAdj: Math.round(offOf(tm)), rd: Math.round(rdAt(tm, t)), home: tm.home,
      maps: tm.maps, series: tm.series, recentMaps: recentMaps(tm, t), lastPlayed: new Date(tm.lastT).toISOString(), started: tm.startedAt,
      form: { last10: `${w}-${l}`, delta30, series: hist.map(h => ({ t: new Date(h.t).toISOString(), opp: h.opp, score: `${h.won}-${h.lost}`, lg: h.lg, change: h.after - h.before })) },
    };
  }

  function table({ t = Date.now(), league = null, minMaps = o.minMaps, activeDays = 120 } = {}) {
    const out = [];
    for (const tm of teams.values()) {
      if (t - tm.lastT > activeDays * 86400e3 || tm.maps < minMaps) continue;
      if (league && tm.home !== league) continue;
      out.push({ name: tm.name, code: tm.code, home: tm.home, rating: Math.round(eff(tm)), rd: Math.round(rdAt(tm, t)), maps: tm.maps, lastPlayed: new Date(tm.lastT).toISOString() });
    }
    return out.sort((a, b) => b.rating - a.rating);
  }

  function leagues(t = Date.now()) {
    const out = [];
    for (const lg of leagueOf.keys()) { const avg = leagueAvg(lg, t); if (avg != null) out.push({ league: lg, avg: Math.round(avg + (off.get(lg) || 0)), prior: priorOf(lg), learned: Math.round(off.get(lg) || 0), teams: [...leagueOf.get(lg)].filter(k => teams.get(k)?.home === lg && t - teams.get(k).lastT < 365 * 86400e3).length }); }
    return out.sort((a, b) => b.avg - a.avg);
  }

  return { update, predict, find, teamView, table, leagues, h2h, opts: o, size: () => teams.size, count: () => count, last: () => last };
}

// Feed series in time order. → ratings
function buildRatings(series, opts = {}) {
  const R = createRatings(opts);
  const rows = (series || []).map(s => ({ ...s, _t: typeof s.t === 'number' ? s.t : Date.parse(s.t) })).filter(s => Number.isFinite(s._t)).sort((a, b) => a._t - b._t);
  for (const s of rows) R.update({ ...s, t: s._t });
  return R;
}

// Plain-language reasons for a prediction, from its own numbers only.
function explain(pred, { market = null } = {}) {
  if (!pred) return [];
  const out = [];
  const [A, B] = pred.teams || [];
  if (!pred.ok) {
    for (const r of pred.reasons || []) out.push(r);
    out.push('No model price: not enough recent games to rate both teams.');
    return out;
  }
  const aFav = pred.map >= 0.5, fav = aFav ? A : B, dog = aFav ? B : A;
  const mp = aFav ? pred.map : 1 - pred.map;
  const rf = aFav ? pred.rating.a : pred.rating.b, rg = aFav ? pred.rating.b : pred.rating.a;
  out.push(`${fav.name} rate ${Math.abs(rf - rg)} points ${rf >= rg ? 'higher' : 'lower'} than ${dog.name} (${rf} vs ${rg}), worth ${Math.round(mp * 100)}% a map.`);
  const s = pred.series;
  if (s.bestOf > 1) {
    const sp = aFav ? s.win : s.loss;
    out.push(`Over a best-of-${s.bestOf} that becomes ${Math.round(sp * 100)}% for the series (favourites sweep more than independent maps would say).`);
  }
  if (pred.confidence === 'low' && Math.max(pred.rating.rdA, pred.rating.rdB) > 120) out.push(`Uncertain rating: ${pred.rating.rdA > pred.rating.rdB ? A.name : B.name} has an RD of ${Math.max(pred.rating.rdA, pred.rating.rdB)} (few recent games or a long break). The one-sd band is ${Math.round(pred.band[0] * 100)}% to ${Math.round(pred.band[1] * 100)}%.`);
  for (const tm of [A, B]) {
    if (Math.abs(tm.form.delta30) >= 30) out.push(`${tm.name} ${tm.form.delta30 > 0 ? 'gained' : 'lost'} ${Math.abs(tm.form.delta30)} rating points in the last 30 days (last 10 series ${tm.form.last10}).`);
  }
  const h = pred.h2h;
  if (h.series) {
    const yrs = h.days >= 700 ? 'two years' : 'year';
    out.push(`Head-to-head in the last ${yrs}: ${h.series} series, maps ${h.maps[0]}-${h.maps[1]}${h.weight ? `, moving ${A.name}'s map chance ${h.mapPts >= 0 ? '+' : ''}${h.mapPts} points (a small weight: it helped only slightly in testing)` : ' (shown for context only)'}.`);
  } else out.push(`No head-to-head series in the last ${h.days >= 700 ? 'two years' : 'year'}.`);
  if (A.home && B.home && A.home !== B.home) out.push(`Cross-league match: ${A.name} from ${A.home}, ${B.name} from ${B.home}. League strength comes only from past international results, and this is where the model is weakest (it misses more on international series than at home), so it is marked low confidence.`);
  if (market && market.prob != null) {
    const d = pred.series.win - market.prob;
    out.push(`${market.venue} prices ${A.name} at ${Math.round(market.prob * 100)}% (no vig); the model says ${Math.round(pred.series.win * 100)}%, ${d >= 0 ? '+' : ''}${Math.round(d * 1000) / 10} points. Model view only: it has not beaten Kalshi's price in the backtest.`);
  }
  return out;
}

module.exports = { LEAGUE_PRIOR, LEAGUE_ALIAS, nameScore, words, DEFAULTS, INTL_RE, isIntl, teamKey, lgamma, lbeta, seriesScores, seriesProb, mapFromSeries, seriesMarkets, createRatings, buildRatings, explain, logit, sigmoid, expected, g };
