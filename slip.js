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
// We handle it the honest way: condition on the shared map-count scenario,
// treat legs as independent WITHIN a scenario, then average over scenarios.
// Same-team pairs get an extra adjustment on top. Legs from different matches
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
  // two legs pointing the same way on the same team share more
  if (same && a.side !== b.side) rho = -rho;
  return rho;
}

// Distribution over "how many of these legs hit", for one series group within
// one map-count scenario. Builds it leg by leg; the correlation nudge is folded
// into each leg's conditional probability given what came before.
function hitsDistribution(groupLegs, maps) {
  let dist = [1];
  groupLegs.forEach((leg, idx) => {
    let p = legProbIn(leg, maps);
    if (idx > 0) {
      // average the pairwise adjustment against the already-placed legs
      const prev = groupLegs.slice(0, idx);
      const adj = prev.reduce((s, q) => {
        const pq = legProbIn(q, maps);
        return s + (pq > 0 ? adjustJoint(p, pq, pairRho(leg, q)) / pq - p : 0);
      }, 0) / prev.length;
      p = Math.min(0.999, Math.max(0.001, p + adj));
    }
    const next = new Array(dist.length + 1).fill(0);
    for (let h = 0; h < dist.length; h++) {
      next[h] += dist[h] * (1 - p);
      next[h + 1] += dist[h] * p;
    }
    dist = next;
  });
  return dist;
}

function convolve(a, b) {
  const out = new Array(a.length + b.length - 1).fill(0);
  for (let i = 0; i < a.length; i++) for (let j = 0; j < b.length; j++) out[i + j] += a[i] * b[j];
  return out;
}

// P(exactly h legs hit) across the whole slip, honouring shared series.
function slipHitsDistribution(legs) {
  const groups = groupBySeries(legs);
  let total = [1];
  for (const g of groups) {
    // average each group's distribution over its own map-count scenarios
    const scenarios = g[0].scenarios?.length ? g[0].scenarios : [{ maps: 1, weight: 1 }];
    let acc = null;
    for (const sc of scenarios) {
      const d = hitsDistribution(g, sc.maps);
      if (!acc) acc = d.map(x => x * sc.weight);
      else d.forEach((x, i) => { acc[i] += x * sc.weight; });
    }
    total = convolve(total, acc);
  }
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
};
