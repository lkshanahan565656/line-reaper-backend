// ─── FILLS AT REAL SIZE ON THE EXCHANGES ─────────────────────────────────────
// What a subscriber actually pays to buy one side of a game line on Kalshi,
// Gemini or Polymarket US for $50, $200 or $1,000: the venue's order book
// walked cheapest first, the taker fee in, against Pinnacle's no-vig fair for
// the same line. Earlier exchange-value work priced the top of the book only;
// the 10-14 latency study found the top price held but the size behind it
// didn't, so here every size tier is its own record.
//
// Books (public, no key):
//   Kalshi        GET /trade-api/v2/markets/{ticker}/orderbook      bids only:
//                 buying YES fills against NO bids at 1 − q (execcheck.kalshiAsks)
//   Gemini        GET https://api.gemini.com/v1/book/{instrumentSymbol}
//                 { bids, asks: [{ price, amount }] } of the YES contract;
//                 buying NO sells into the YES bids at 1 − the bid
//   Polymarket US GET /v1/markets/{slug}/book (pmus.parseBook); long takes
//                 the offers, short sells into the bids (execcheck.pmusAsks)
//
// Fees (taker, per contract at price p): Kalshi 0.07·p(1−p) and Gemini
// 0.07·p(1−p), each rounded up to the cent per fill (one fill per book level
// here, which is the conservative reading); Polymarket US the market's own
// feeCoefficient (0.0695 by default), not rounded.

const TIERS = [50, 200, 1000];
// the rates are fees.js's schedules (one place for every venue's cut)
const fees = require('./fees');
const VENUES = {
  kalshi: { rate: fees.SCHEDULES.kalshi.taker.rate, roundCent: true },
  gemini: { rate: fees.SCHEDULES.gemini.taker.rate, roundCent: true },
  polymarketus: { rate: fees.SCHEDULES.polymarketus.taker.rate, roundCent: false },
};
const GEMINI_BOOK_URL = sym => `https://api.gemini.com/v1/book/${encodeURIComponent(sym)}`;
const r4 = x => Math.round(x * 1e4) / 1e4;

// fee on n contracts at p
function feeOf(n, p, { rate = 0.07, roundCent = true } = {}) {
  return fees.orderFee('kalshi', p, n, { rate, round: roundCent });
}

// asks [[price, contracts]] walked for `usd` in whole contracts, fee in →
// { usd: spent, contracts, cost: all-in per contract, worst: highest price
// taken, full: the book held the whole tier (under $1 left over) } | null
function walk(asks = [], usd, fee = VENUES.kalshi) {
  let spent = 0, n = 0, worst = null;
  for (const [p, q] of [...asks].filter(([p, q]) => p > 0 && p < 1 && q > 0).sort((a, b) => a[0] - b[0])) {
    const left = usd - spent;
    if (left < p) break;
    let k = Math.min(Math.floor(q + 1e-9), Math.floor(left / (p + (fee.rate || 0) * p * (1 - p))));
    while (k > 0 && k * p + feeOf(k, p, fee) > left + 1e-9) k--;
    if (k <= 0) break;
    spent += k * p + feeOf(k, p, fee); n += k; worst = p;
    if (k < Math.floor(q + 1e-9)) break;   // budget ran out inside this level
  }
  if (!n) return null;
  return { usd: Math.round(spent * 100) / 100, contracts: n, cost: r4(spent / n), worst, full: usd - spent < 1 };
}

// EV of paying `cost` (all-in) for a side Pinnacle prices at fair probability p
const evOf = (p, cost) => (p > 0 && cost > 0 ? r4(p / cost - 1) : null);

// every tier at once, plus how many dollars the book holds at `minEv` or
// better a contract (each contract's own fee in) → { tiers: { 50: walk+ev }, top, atEdge }
function fillsOf(asks, fairP, fee = VENUES.kalshi, { tiers = TIERS, minEv = 0.01 } = {}) {
  const out = { tiers: {}, top: null, atEdge: 0 };
  const sorted = [...asks].filter(([p, q]) => p > 0 && p < 1 && q > 0).sort((a, b) => a[0] - b[0]);
  if (!sorted.length) return out;
  const [p0] = sorted[0];
  const c0 = p0 + (fee.rate || 0) * p0 * (1 - p0);
  out.top = { price: p0, cost: r4(c0), ev: evOf(fairP, c0) };
  for (const [p, q] of sorted) {
    const c = p + (fee.rate || 0) * p * (1 - p);
    if (evOf(fairP, c) < minEv) break;
    out.atEdge += q * c;
  }
  out.atEdge = Math.round(out.atEdge);
  for (const t of tiers) {
    const w = walk(sorted, t, fee);
    out.tiers[t] = w ? { ...w, ev: evOf(fairP, w.cost) } : null;
  }
  return out;
}

// Gemini /v1/book payload → asks for buying 'yes' | 'no'
function geminiAsks(payload, buy) {
  const lv = (arr = []) => (Array.isArray(arr) ? arr : []).map(l => [parseFloat(l.price), parseFloat(l.amount)]).filter(([p, n]) => p > 0 && p < 1 && n > 0);
  return buy === 'yes' ? lv(payload?.asks) : lv(payload?.bids).map(([p, n]) => [r4(1 - p), n]);
}

// The pre-registered flag (checks/xsize-2026-10-24/PREREGISTERED.md): the
// whole tier fills at +1% or better over Pinnacle's main-line fair.
const FLAG_EV = 0.01;
const flagged = tier => !!(tier && tier.full && tier.ev >= FLAG_EV);

// minutes before start → the report's bucket
function startBucket(mins) {
  if (!(mins >= 0)) return 'live';
  return mins < 30 ? '0-30m' : mins < 120 ? '30m-2h' : mins < 360 ? '2-6h' : '6h+';
}

module.exports = { TIERS, VENUES, GEMINI_BOOK_URL, FLAG_EV, feeOf, walk, evOf, fillsOf, geminiAsks, flagged, startBucket };
