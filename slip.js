// ─── SLIP PRICING ─────────────────────────────────────────────────────────────
// A DFS entry is not a stack of independent legs, and pricing it as one is the
// most expensive mistake on the board.
//
// Two legs from the SAME SERIES share the thing that drives both: how many maps
// get played. A "Maps 1-3" over on one player and a "Maps 1-3" over on another
// both quietly need a map 3. Multiplying their standalone probabilities treats
// that as two independent coin flips and overstates a 3-leg same-series entry
// badly. Teammates share more than that — one team's kills come out of the
// other's — so legs on the same team get a correlation term too.
//
// We handle it the honest way: condition on the number of maps the series
// runs (each leg sees min(that, its span end)), build a correlated joint over
// the legs' hit patterns WITHIN that outcome, then average over outcomes.
// Same-series pairs with a team get a correlation term on top. Legs from different matches
// stay independent, which they are.
//
// Payout tables are the defaults the apps publish. They move, so they are data,
// not logic, and the caller can pass its own.

const { propProb } = require('./dist');

// payout[legs][hits] = multiplier on the stake. Power plays pay only on a sweep.
const PAYOUTS = {
  prizepicks_power: { 2: { 2: 3 }, 3: { 3: 5 }, 4: { 4: 10 }, 5: { 5: 20 }, 6: { 6: 37.5 } },
  prizepicks_flex: {
    3: { 3: 2.25, 2: 1.25 },
    4: { 4: 5, 3: 1.5 },
    5: { 5: 10, 4: 2, 3: 0.4 },
    6: { 6: 25, 5: 2, 4: 0.4 },
  },
  underdog_standard: { 2: { 2: 3 }, 3: { 3: 6 }, 4: { 4: 10 }, 5: { 5: 20 } },
  underdog_flex: {
    3: { 3: 3, 2: 1 },
    4: { 4: 6, 3: 1.5 },
    5: { 5: 10, 4: 2.5, 3: 0.4 },
  },
};

// How much of a leg's outcome is shared with another leg in the same series.
// Starting points; the tracker's graded pairs are what should set these.
const CORR = {
  sameTeam: { kills: -0.12, assists: 0.10, headshots: -0.08 },   // teammates split a fixed pie of kills
  opposingTeam: { kills: -0.05, assists: -0.03, headshots: -0.04 },
};

// Legs: { prob, scenarios?, meanPerMap?, k?, stat?, line?, side?, gameId?, team?, player? }
// A leg with scenarios/meanPerMap/k is re-priced per scenario; one with only
// `prob` is used as-is (a manual number, or a book-supplied probability).
function legProbIn(leg, maps) {
  if (leg.meanPerMap == null || leg.k == null) return leg.prob;
  const r = propProb(leg.line, leg.side, {
    meanPerMap: leg.meanPerMap, k: leg.k, stat: leg.stat,
    scenarios: [{ maps, weight: 1 }],
  });
  return r.effective;
}

// Group legs by the series they belong to. Legs with no gameId are their own
// group, which keeps them independent — the safe assumption when we can't tell.
function groupBySeries(legs) {
  const groups = new Map();
  legs.forEach((leg, i) => {
    const key = leg.gameId ? `g:${leg.gameId}` : `solo:${i}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ ...leg, _i: i });
  });
  return [...groups.values()];
}

// Pairwise correlation nudge applied inside a scenario. Positive rho raises the
// chance both legs land together; negative lowers it. Applied as a Gaussian-ish
// adjustment to the joint, clamped to stay a valid probability.
function adjustJoint(pA, pB, rho) {
  if (!rho) return pA * pB;
  const sd = Math.sqrt(pA * (1 - pA) * pB * (1 - pB));
  const joint = pA * pB + rho * sd;
  return Math.min(Math.min(pA, pB), Math.max(0, joint));
}

function pairRho(a, b) {
  const stat = a.stat === b.stat ? (a.stat || 'kills') : 'kills';
  if (!a.team || !b.team) return 0;
  const same = a.team === b.team;
  const table = same ? CORR.sameTeam : CORR.opposingTeam;
  let rho = table[stat] ?? 0;
  // the tables are for two legs on the same side; an OVER paired with an UNDER
  // has the opposite relationship, teammates or not
  if (a.side !== b.side) rho = -rho;
  return rho;
}

// ── map-count scenarios ──────────────────────────────────────────────────────
// A leg's `scenarios` are the distribution of how many maps of ITS span get
// played: for a "Maps 1-E" span that is min(T, E), T = maps the series runs.
// The shared latent variable is T, not any one leg's span. Two scenario sets
// belong to the same latent when the shorter one is the longer one truncated
// at its own end (identical sets trivially are). Sets that don't fit (a span
// that doesn't start at map 1, say) get their own latent, independent of the
// rest — the safe assumption when we can't tell.
const SC_TOL = 2e-3;   // pricing rounds weights to 4 decimals

function canonScenarios(leg) {
  const sc = leg.scenarios?.length ? leg.scenarios : [{ maps: 1, weight: 1 }];
  const by = new Map();
  for (const s of sc) by.set(s.maps, (by.get(s.maps) || 0) + s.weight);
  const tot = [...by.values()].reduce((a, b) => a + b, 0) || 1;
  const list = [...by.entries()].filter(([, w]) => w > 0).sort((a, b) => a[0] - b[0])
    .map(([maps, w]) => ({ maps, weight: w / tot }));
  return list.length ? list : [{ maps: 1, weight: 1 }];
}

const scKey = sc => sc.map(s => `${s.maps}:${s.weight.toFixed(6)}`).join(',');
const scEnd = sc => sc[sc.length - 1].maps;

// Is `short` the distribution of min(T, end(short)) when T ~ `root`?
function truncatesTo(root, short) {
  const end = scEnd(short);
  const want = new Map();
  for (const s of root) {
    const m = Math.min(s.maps, end);
    want.set(m, (want.get(m) || 0) + s.weight);
  }
  const have = new Map(short.map(s => [s.maps, s.weight]));
  for (const m of new Set([...want.keys(), ...have.keys()])) {
    if (Math.abs((want.get(m) || 0) - (have.get(m) || 0)) > SC_TOL) return false;
  }
  return true;
}

// Split one series' legs into latents. Each latent: { root, legs: [{leg, end}] }.
// Built from the scenario CONTENT in a fixed order, so leg order can't matter.
function seriesLatents(groupLegs) {
  const sets = new Map();
  for (const leg of groupLegs) {
    const sc = canonScenarios(leg);
    const key = scKey(sc);
    if (!sets.has(key)) sets.set(key, { key, sc, legs: [] });
    sets.get(key).legs.push(leg);
  }
  const ordered = [...sets.values()].sort((a, b) =>
    scEnd(b.sc) - scEnd(a.sc) || b.sc.length - a.sc.length || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const latents = [];
  for (const s of ordered) {
    let home = latents.find(l => truncatesTo(l.root, s.sc));
    if (!home) { home = { root: s.sc, legs: [] }; latents.push(home); }
    for (const leg of s.legs) home.legs.push({ leg, end: scEnd(s.sc) });
  }
  return latents;
}

// ── correlated hit patterns ──────────────────────────────────────────────────
// Joint distribution over the 2^n hit patterns of one series with marginals
// exactly p_i and pairwise association from rho. Log-linear (Ising-style)
// model: P(x) ∝ Π_i a_i^{x_i} Π_{i<j} OR_ij^{x_i x_j}, where OR_ij is the odds
// ratio of the 2x2 table whose joint is adjustJoint(p_i, p_j, rho_ij). The a_i
// are fitted by iterative proportional fitting, so every marginal is exact
// (and for two legs the joint is exact too). Probabilities stay in [0,1] by
// construction.
const MAX_LOG_OR = 12;
const MAX_CORR_LEGS = 12;

function logOddsRatio(pA, pB, rho) {
  if (!rho || pA <= 0 || pA >= 1 || pB <= 0 || pB >= 1) return 0;
  const j = adjustJoint(pA, pB, rho);
  const n11 = j, n10 = pA - j, n01 = pB - j, n00 = 1 - pA - pB + j;
  if (n11 <= 0 || n00 <= 0) return -MAX_LOG_OR;
  if (n10 <= 0 || n01 <= 0) return MAX_LOG_OR;
  return Math.max(-MAX_LOG_OR, Math.min(MAX_LOG_OR, Math.log((n11 * n00) / (n10 * n01))));
}

function patternDistribution(probs, rhoOf) {
  const n = probs.length;
  const N = 1 << n;
  const theta = [];
  let any = false;
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    const t = logOddsRatio(probs[i], probs[j], rhoOf(i, j));
    if (t) { theta.push([i, j, t]); any = true; }
  }
  const w = new Float64Array(N);
  for (let x = 0; x < N; x++) {
    let lw = 0;
    for (const [i, j, t] of theta) if ((x >> i) & (x >> j) & 1) lw += t;
    let pr = 1;
    for (let i = 0; i < n; i++) pr *= (x >> i) & 1 ? probs[i] : 1 - probs[i];
    w[x] = pr * Math.exp(lw);
  }
  // IPF on the one-way marginals
  for (let iter = 0; iter < (any ? 2000 : 1); iter++) {
    let worst = 0;
    for (let i = 0; i < n; i++) {
      let tot = 0, on = 0;
      for (let x = 0; x < N; x++) { tot += w[x]; if ((x >> i) & 1) on += w[x]; }
      const m = on / tot, p = probs[i];
      worst = Math.max(worst, Math.abs(m - p));
      const up = m > 0 ? p / m : 0, down = m < 1 ? (1 - p) / (1 - m) : 0;
      for (let x = 0; x < N; x++) w[x] *= (x >> i) & 1 ? up : down;
    }
    if (worst < 1e-14) break;
  }
  let tot = 0;
  for (let x = 0; x < N; x++) tot += w[x];
  for (let x = 0; x < N; x++) w[x] /= tot;
  return w;
}

// P(exactly h of these legs hit), each leg already assigned its maps.
function hitsDistribution(groupLegs, mapsOf) {
  const n = groupLegs.length;
  const probs = groupLegs.map((leg, i) =>
    Math.min(1, Math.max(0, legProbIn(leg, typeof mapsOf === 'function' ? mapsOf(i) : mapsOf))));
  if (n > MAX_CORR_LEGS) {
    // too many to enumerate; fall back to independence within the group
    let dist = [1];
    for (const p of probs) {
      const next = new Array(dist.length + 1).fill(0);
      for (let h = 0; h < dist.length; h++) { next[h] += dist[h] * (1 - p); next[h + 1] += dist[h] * p; }
      dist = next;
    }
    return dist;
  }
  const w = patternDistribution(probs, (i, j) => pairRho(groupLegs[i], groupLegs[j]));
  const dist = new Array(n + 1).fill(0);
  for (let x = 0; x < w.length; x++) {
    let h = 0;
    for (let y = x; y; y &= y - 1) h++;
    dist[h] += w[x];
  }
  return dist;
}

function convolve(a, b) {
  const out = new Array(a.length + b.length - 1).fill(0);
  for (let i = 0; i < a.length; i++) for (let j = 0; j < b.length; j++) out[i + j] += a[i] * b[j];
  return out;
}

// One series: average over the joint map-count outcome of its latents (each a
// T drawn from its root), giving each leg maps = min(T, its span end).
function seriesHitsDistribution(g) {
  const latents = seriesLatents(g);
  const legs = [], ends = [], owner = [];
  latents.forEach((l, li) => l.legs.forEach(({ leg, end }) => { legs.push(leg); ends.push(end); owner.push(li); }));
  let acc = new Array(legs.length + 1).fill(0);
  const walk = (li, ts, weight) => {
    if (li === latents.length) {
      const d = hitsDistribution(legs, i => Math.min(ts[owner[i]], ends[i]));
      d.forEach((x, h) => { acc[h] += x * weight; });
      return;
    }
    for (const sc of latents[li].root) walk(li + 1, [...ts, sc.maps], weight * sc.weight);
  };
  walk(0, [], 1);
  return acc;
}

// P(exactly h legs hit) across the whole slip, honouring shared series.
function slipHitsDistribution(legs) {
  let total = [1];
  for (const g of groupBySeries(legs)) total = convolve(total, seriesHitsDistribution(g));
  return total;
}

// Same slip with every leg independent — what the old pricing assumed.
function independentHitsDistribution(legs) {
  let dist = [1];
  for (const leg of legs) {
    const p = leg.prob;
    const next = new Array(dist.length + 1).fill(0);
    for (let h = 0; h < dist.length; h++) { next[h] += dist[h] * (1 - p); next[h + 1] += dist[h] * p; }
    dist = next;
  }
  return dist;
}

function evFromDistribution(dist, table) {
  let ev = 0;
  for (let h = 0; h < dist.length; h++) ev += dist[h] * (table[h] || 0);
  return ev - 1;
}

// Fraction of bankroll for a multi-outcome bet, by bisection on the derivative
// of expected log wealth. Returns 0 when the slip is not +EV.
function kelly(dist, table) {
  const outcomes = dist.map((p, h) => ({ p, mult: table[h] || 0 })).filter(o => o.p > 1e-12);
  const deriv = f => outcomes.reduce((s, o) => s + o.p * (o.mult - 1) / (1 + f * (o.mult - 1)), 0);
  if (deriv(0) <= 0) return 0;
  let lo = 0, hi = 1;
  // never stake into a certain total loss
  const worst = Math.min(...outcomes.map(o => o.mult));
  if (worst < 1) hi = Math.min(0.999, 1 / (1 - worst) - 1e-9);
  if (deriv(hi) > 0) return hi;
  for (let i = 0; i < 80; i++) { const mid = (lo + hi) / 2; if (deriv(mid) > 0) lo = mid; else hi = mid; }
  return (lo + hi) / 2;
}

// Price one slip on one payout table.
function priceSlip(legs, tableName, payouts = PAYOUTS) {
  const byLegs = payouts[tableName];
  const table = byLegs?.[legs.length];
  if (!table) return null;
  const dist = slipHitsDistribution(legs);
  const indep = independentHitsDistribution(legs);
  const ev = evFromDistribution(dist, table);
  return {
    table: tableName, legs: legs.length,
    probAll: dist[legs.length] ?? 0,
    probAllIndependent: indep[legs.length] ?? 0,
    hits: dist.map(x => +x.toFixed(6)),
    ev: +(ev * 100).toFixed(2),
    evIndependent: +(evFromDistribution(indep, table) * 100).toFixed(2),
    kelly: +kelly(dist, table).toFixed(4),
    // 0.1 points of probability is the floor for calling a slip correlated;
    // below that it's float noise from averaging scenarios.
    correlated: legs.length > 1 && Math.abs((dist[legs.length] ?? 0) - (indep[legs.length] ?? 0)) > 1e-3,
  };
}

// Price on every table that fits this leg count, best EV first.
function priceAll(legs, payouts = PAYOUTS) {
  return Object.keys(payouts)
    .map(name => priceSlip(legs, name, payouts))
    .filter(Boolean)
    .sort((a, b) => b.ev - a.ev);
}

// Greedy builder: from a pool of candidate legs, the best entry at each size.
// Greedy because the exact search is combinatorial and the pool is the board.
function bestSlips(pool, { maxLegs = 6, minLegs = 2, payouts = PAYOUTS } = {}) {
  const ranked = pool.slice().sort((a, b) => (b.ev ?? 0) - (a.ev ?? 0));
  const out = [];
  for (let n = minLegs; n <= Math.min(maxLegs, ranked.length); n++) {
    let chosen = [];
    const rest = ranked.slice();
    while (chosen.length < n && rest.length) {
      let bestIdx = 0, bestEv = -Infinity;
      for (let i = 0; i < rest.length; i++) {
        const trial = [...chosen, rest[i]];
        if (trial.length < 2) { bestIdx = i; break; }
        const p = priceAll(trial, payouts)[0];
        if (p && p.ev > bestEv) { bestEv = p.ev; bestIdx = i; }
      }
      chosen.push(rest.splice(bestIdx, 1)[0]);
    }
    const priced = priceAll(chosen, payouts)[0];
    if (priced) out.push({ ...priced, legs: chosen.length, picks: chosen });
  }
  return out.sort((a, b) => b.ev - a.ev);
}

module.exports = {
  PAYOUTS, CORR, priceSlip, priceAll, bestSlips, slipHitsDistribution,
  independentHitsDistribution, kelly, evFromDistribution, groupBySeries, pairRho, adjustJoint,
  hitsDistribution, patternDistribution, seriesLatents,
};
