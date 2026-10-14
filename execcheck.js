// ─── EXECUTABLE ───────────────────────────────────────────────────────────────
// An edge only counts if a subscriber can get it: after the alert goes out, in
// real size, on a venue US users can use. Two checks:
//
//   depth  the contracts and dollars resting at or under the alerted price on
//          Kalshi's order book when the edge is flagged (alerts need minUsd)
//   delay  the price a subscriber gets lagMs after the flag (evtrack records
//          it as execPrice; execClv grades the bet at that price)
//
// Kalshi's book lists bids only: buying YES fills against NO bids, so a NO bid
// at q is a YES ask at 1 − q.

const KALSHI_BOOK_URL = t => `https://api.elections.kalshi.com/trade-api/v2/markets/${encodeURIComponent(t)}/orderbook`;
const DEFAULTS = { minUsd: 100, lagMs: 2 * 60e3, maxReads: 20, ttlMs: 60e3 };

// [[price in dollars, contracts]] from either book shape (dollar strings or cents)
function levels(ob, side) {
  const d = ob?.[`${side}_dollars`];
  if (Array.isArray(d)) return d.map(([p, n]) => [parseFloat(p), parseFloat(n)]).filter(([p, n]) => p > 0 && p < 1 && n > 0);
  const c = ob?.[side];
  if (Array.isArray(c)) return c.map(([p, n]) => [Number(p) / 100, Number(n)]).filter(([p, n]) => p > 0 && p < 1 && n > 0);
  return [];
}

// payload of GET /markets/{ticker}/orderbook → what buying `side` at maxPrice
// or better can fill: { contracts, usd, best } (best: the lowest ask)
function kalshiDepth(payload, side, maxPrice) {
  const ob = payload?.orderbook_fp || payload?.orderbook || payload || {};
  let contracts = 0, usd = 0, best = null;
  for (const [q, n] of levels(ob, side === 'yes' ? 'no' : 'yes')) {
    const ask = Math.round((1 - q) * 1e4) / 1e4;
    if (ask > maxPrice + 1e-9) continue;
    contracts += n; usd += n * ask;
    if (best == null || ask < best) best = ask;
  }
  return { contracts: Math.round(contracts), usd: Math.round(usd), best };
}

// Reads each Kalshi edge's book (at most maxReads a scan, a read kept ttlMs)
// and sets e.depth. Other venues are left without one: unchecked.
function createDepthCheck({ http, opts = {}, now = () => Date.now() } = {}) {
  const o = { ...DEFAULTS, ...opts };
  const cache = new Map();   // ticker → { at, payload }
  async function check(edges = []) {
    const t = now();
    let reads = 0;
    for (const e of edges) {
      if (e.venue !== 'kalshi' || !e.marketId) continue;
      let c = cache.get(e.marketId);
      if (!c || t - c.at > o.ttlMs) {
        if (reads >= o.maxReads) continue;
        reads++;
        try { c = { at: t, payload: (await http.get(KALSHI_BOOK_URL(e.marketId), { timeout: 10000 }))?.data }; cache.set(e.marketId, c); }
        catch { continue; }
      }
      e.depth = kalshiDepth(c.payload, e.side, e.price);
    }
    for (const [k, c] of cache) if (t - c.at > 10 * o.ttlMs) cache.delete(k);
    return reads;
  }
  return { check, opts: o };
}

const executable = (e, minUsd = DEFAULTS.minUsd) => !!(e?.depth && e.depth.usd >= minUsd);

module.exports = { kalshiDepth, createDepthCheck, executable, levels, KALSHI_BOOK_URL, DEFAULTS };
