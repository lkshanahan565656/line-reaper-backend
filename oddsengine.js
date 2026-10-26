// ─── ODDS ENGINE: FAIR PRICES, EV, FEES, LAYS AND ARBS ───────────────────────
// The betting math the Exchange Shopper and the esports matchup engine share.
// Decimal odds are the one internal format: every function takes and returns
// decimals (or probabilities), and display formats are converted at the edge
// (oddsschema.formatOdds).
//
//   devig         no-vig chances from one venue's full set of prices, four ways
//                 (multiplicative, additive, power, Shin)
//   blendFair     a weighted fair from several venues' no-vig chances, with how
//                 far apart they sit (the fair's own uncertainty)
//   effective     a price after the venue's cut: an exchange's commission on net
//                 winnings, or a prediction market's per-contract taker fee
//   lay           an exchange lay: liability, and the back price it equals
//   arb           the hold at the best price on every outcome; under 0 an arb,
//                 with the stakes that pay the same whatever wins
//   ev, kelly     expected value at a probability, and the Kelly stake
//   modelEdge     a model's probability (with its own range) against a price
//
// Pure functions, no I/O. ev.js keeps its own devig for the +EV board and its
// record; devig(…, 'power' | 'multiplicative') here is that same function.

const evMath = require('./ev');
const fees = require('./fees');

const isNum = x => typeof x === 'number' && Number.isFinite(x);
const r4 = x => (isNum(x) ? Math.round(x * 1e4) / 1e4 : null);
const r2 = x => (isNum(x) ? Math.round(x * 100) / 100 : null);
const okDecimal = d => isNum(d) && d > 1;

// ── implied probability and hold ──
const implied = d => (okDecimal(d) ? 1 / d : null);
// the book's margin on a full set of prices: Σ 1/d − 1 (0.045 = 4.5%)
function hold(decimals) {
  if (!Array.isArray(decimals) || decimals.length < 2 || !decimals.every(okDecimal)) return null;
  return decimals.reduce((a, d) => a + 1 / d, 0) - 1;
}

// ── devig ──
// Additive: take the same share of the margin off every side (can go below
// 0 on a long shot; such a set returns null).
function devigAdditive(decimals) {
  const imp = decimals.map(d => 1 / d);
  const over = imp.reduce((a, b) => a + b, 0) - 1;
  const out = imp.map(p => p - over / imp.length);
  return out.every(p => p > 0 && p < 1) ? out : null;
}
// Shin (1993): the margin comes from bettors with inside information; z is
// their share. Solved by bisection on z so the fair chances sum to 1.
function devigShin(decimals) {
  const imp = decimals.map(d => 1 / d);
  const S = imp.reduce((a, b) => a + b, 0);
  if (S <= 1) return imp.map(p => p / S);
  const at = z => imp.map(p => (Math.sqrt(z * z + 4 * (1 - z) * (p * p) / S) - z) / (2 * (1 - z)));
  let lo = 0, hi = 0.4;
  for (let i = 0; i < 80; i++) {
    const z = (lo + hi) / 2;
    const s = at(z).reduce((a, b) => a + b, 0);
    if (s > 1) lo = z; else hi = z;
  }
  const out = at((lo + hi) / 2);
  const t = out.reduce((a, b) => a + b, 0);
  return out.map(p => p / t);
}
const DEVIG_METHODS = ['power', 'multiplicative', 'additive', 'shin'];
function devig(decimals, method = 'power') {
  if (!Array.isArray(decimals) || decimals.length < 2 || !decimals.every(okDecimal)) return null;
  if (method === 'additive') return devigAdditive(decimals);
  if (method === 'shin') return devigShin(decimals);
  if (method === 'power' || method === 'multiplicative') return evMath.devig(decimals, method);
  throw new Error(`unknown devig method: ${method}`);
}

// ── fair from several sources ──
// sources: [{ id, decimals: [per side], weight }] (a source missing a side
// is skipped). → { fair: [p per side], sources: [{ id, p, weight }], spreadPts:
// [max − min per side, in points], n } or null when no source prices every side.
function blendFair(sources, { method = 'power' } = {}) {
  const used = [];
  for (const s of sources || []) {
    const w = isNum(s.weight) ? s.weight : 1;
    if (!(w > 0)) continue;
    const p = devig(s.decimals, method);
    if (p) used.push({ id: s.id, p, weight: w });
  }
  if (!used.length) return null;
  const k = used[0].p.length;
  if (!used.every(u => u.p.length === k)) return null;
  const W = used.reduce((a, u) => a + u.weight, 0);
  const fair = Array.from({ length: k }, (_, i) => used.reduce((a, u) => a + u.weight * u.p[i], 0) / W);
  const spreadPts = Array.from({ length: k }, (_, i) => {
    const ps = used.map(u => u.p[i]);
    return r2((Math.max(...ps) - Math.min(...ps)) * 100);
  });
  return { fair: fair.map(r4), sources: used.map(u => ({ id: u.id, p: u.p.map(r4), weight: u.weight })), spreadPts, n: used.length, method };
}

// ── what a price pays after the venue's cut ──
// commission on net winnings (Betfair, Matchbook, Smarkets style)
function afterCommission(decimal, rate = 0) {
  if (!okDecimal(decimal)) return null;
  const c = isNum(rate) && rate > 0 && rate < 1 ? rate : 0;
  return 1 + (decimal - 1) * (1 - c);
}
// a prediction-market contract bought at `price` dollars (pays $1) with a
// taker fee: Kalshi's and Gemini's 0.07 × p × (1 − p), rounded up to the cent
// per order (roundCents), or Polymarket US's coefficient unrounded.
function contractFee(price, { rate = 0.07, contracts = 1, roundCents = true } = {}) {
  const p = Number(price);
  if (!(p > 0 && p < 1)) return null;
  return fees.orderFee('kalshi', p, contracts, { rate, round: roundCents }) / contracts;
}
function contractDecimal(price, opts = {}) {
  const fee = contractFee(price, opts);
  if (fee == null) return null;
  const cost = Number(price) + fee;
  return cost < 1 ? 1 / cost : null;
}
// one shape for every venue: fee { type: 'none' | 'commission' | 'contract' |
// 'included', rate, roundCents }. 'included' means the price already has it in.
function effective(decimal, fee = null) {
  if (!okDecimal(decimal)) return null;
  if (!fee || fee.type === 'none' || fee.type === 'included') return decimal;
  if (fee.type === 'commission') return afterCommission(decimal, fee.rate);
  if (fee.type === 'contract') return contractDecimal(1 / decimal, { rate: fee.rate, roundCents: fee.roundCents !== false, contracts: fee.contracts || 1 });
  return decimal;
}

// ── lays (exchanges only) ──
// Laying `stake` at decimal L: you win the backer's stake (less commission)
// if the selection loses and pay stake × (L − 1) if it wins.
function layLiability(stake, layDecimal) {
  return isNum(stake) && okDecimal(layDecimal) ? stake * (layDecimal - 1) : null;
}
// the back price on "the selection does not win" a lay at L equals, after
// commission: risk L − 1 to win 1 − c
function layAsBack(layDecimal, rate = 0) {
  if (!okDecimal(layDecimal)) return null;
  const c = isNum(rate) && rate > 0 && rate < 1 ? rate : 0;
  return 1 + (1 - c) / (layDecimal - 1);
}
// EV of a lay per unit of liability, at a fair chance p that the selection wins
function layEv(p, layDecimal, rate = 0) {
  const b = layAsBack(layDecimal, rate);
  return b == null || !(p >= 0 && p <= 1) ? null : (1 - p) * b - 1;
}

// ── EV and staking ──
// EV per unit staked at a true chance p
const ev = (p, decimal) => (okDecimal(decimal) && isNum(p) && p >= 0 && p <= 1 ? p * decimal - 1 : null);
const evAmount = (p, decimal, stake) => { const e = ev(p, decimal); return e == null || !isNum(stake) ? null : e * stake; };
// fraction of bankroll by Kelly, scaled by `fraction` (0.25 = quarter Kelly); 0 when −EV
function kelly(p, decimal, fraction = 1) {
  if (!okDecimal(decimal) || !isNum(p)) return null;
  const b = decimal - 1;
  const f = (p * b - (1 - p)) / b;
  return f > 0 ? f * fraction : 0;
}
// a model's chance against a price, with the model's own range [lo, hi]:
// the EV at the low end is the one to trust
function modelEdge({ p, lo = null, hi = null }, decimal) {
  if (!okDecimal(decimal) || !isNum(p)) return null;
  const imp = 1 / decimal;
  return {
    p: r4(p), implied: r4(imp), edgePts: r2((p - imp) * 100), ev: r4(ev(p, decimal)),
    evLow: isNum(lo) ? r4(ev(lo, decimal)) : null, evHigh: isNum(hi) ? r4(ev(hi, decimal)) : null,
    clearsAtLow: isNum(lo) ? lo > imp : null,
  };
}

// ── price gaps ──
// the best price against the next best, in points of implied chance and as
// the best's extra payout (0.04 = pays 4% more)
function discrepancy(best, second) {
  if (!okDecimal(best) || !okDecimal(second)) return null;
  return { pts: r2((1 / second - 1 / best) * 100), payout: r4(best / second - 1) };
}

// ── arbs ──
// decimals: the best (effective) price on each outcome of one market.
// → { hold, arb, profit (share of total stake locked), stakes for `total` so
// every outcome pays the same, payout } or null.
function arb(decimals, total = 100) {
  const h = hold(decimals);
  if (h == null) return null;
  const S = h + 1;
  const stakes = decimals.map(d => (total / d) / S);
  return { hold: r4(h), arb: h < 0, profit: r4(1 / S - 1), stakes: stakes.map(r2), payout: r2(total / S) };
}

module.exports = {
  DEVIG_METHODS, implied, hold, devig, devigAdditive, devigShin, blendFair,
  afterCommission, contractFee, contractDecimal, effective, layLiability, layAsBack, layEv,
  ev, evAmount, kelly, modelEdge, discrepancy, arb, r4, r2,
};
