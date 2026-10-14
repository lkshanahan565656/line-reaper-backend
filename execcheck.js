// ─── EXECUTABLE ───────────────────────────────────────────────────────────────
// An edge only counts if a subscriber can get it: after the alert goes out, in
// real size, on a venue US users can use. Two checks:
//
//   depth  the contracts and dollars resting at or under the alerted price on
//          the venue's order book (Kalshi, Polymarket US) when the edge is
//          flagged (alerts need minUsd)
//   delay  the price a subscriber gets lagMs after the flag (evtrack records
//          it as execPrice; execClv grades the bet at that price)
//
// Kalshi's book lists bids only: buying YES fills against NO bids, so a NO bid
// at q is a YES ask at 1 − q.

const KALSHI_BOOK_URL = t => `https://api.elections.kalshi.com/trade-api/v2/markets/${encodeURIComponent(t)}/orderbook`;
const DEFAULTS = { minUsd: 100, lagMs: 2 * 60e3, maxReads: 20, ttlMs: 60e3, alertMinN: 15, alertMinClv: 0.01 };

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

// Polymarket US: a market's book is its long side's (pmus.parseBook). Buying
// long takes the offers; buying short sells into the bids, at 1 − the bid.
// book: pmus.parseBook output; buy: 'long' | 'short' → { contracts, usd, best }
function pmusDepth(book, buy, maxPrice) {
  let contracts = 0, usd = 0, best = null;
  const lv = buy === 'long' ? (book?.offers || []).map(([p, n]) => [p, n]) : (book?.bids || []).map(([p, n]) => [Math.round((1 - p) * 1e4) / 1e4, n]);
  for (const [ask, n] of lv) {
    if (!(ask > 0 && ask < 1 && n > 0) || ask > maxPrice + 1e-9) continue;
    contracts += n; usd += n * ask;
    if (best == null || ask < best) best = ask;
  }
  return { contracts: Math.round(contracts), usd: Math.round(usd), best };
}

// Reads each Kalshi edge's book, and each Polymarket US edge's when a pmus
// client is given (at most maxReads a scan, a read kept ttlMs), and sets
// e.depth. Other venues are left without one: unchecked.
function createDepthCheck({ http, pmus = null, opts = {}, now = () => Date.now() } = {}) {
  const o = { ...DEFAULTS, ...opts };
  const cache = new Map();   // venue:market → { at, payload }
  const read = e => (e.venue === 'kalshi' ? http.get(KALSHI_BOOK_URL(e.marketId), { timeout: 10000 }).then(r => r?.data) : pmus.book(e.marketId));
  async function check(edges = []) {
    const t = now();
    let reads = 0;
    for (const e of edges) {
      const us = e.venue === 'polymarketus' && pmus && (e.yesSide === 'long' || e.yesSide === 'short');
      if (!e.marketId || !(e.venue === 'kalshi' || us)) continue;
      const k = `${e.venue}:${e.marketId}`;
      let c = cache.get(k);
      if (!c || t - c.at > o.ttlMs) {
        if (reads >= o.maxReads) continue;
        reads++;
        try { c = { at: t, payload: await read(e) }; if (c.payload == null) continue; cache.set(k, c); }
        catch { continue; }
      }
      if (!us) e.depth = kalshiDepth(c.payload, e.side, e.price);
      else if (c.payload.open !== false) {
        const buy = e.side === 'yes' ? e.yesSide : e.yesSide === 'long' ? 'short' : 'long';
        e.depth = pmusDepth(c.payload, buy, e.price);
      }
    }
    for (const [k, c] of cache) if (t - c.at > 10 * o.ttlMs) cache.delete(k);
    return reads;
  }
  return { check, opts: o };
}

// A signal alerts only once its own record, graded at the price 2 minutes
// after each flag, beats the close by alertMinClv over alertMinN bets. A
// replay of 4 days of Kalshi and Polymarket minute prices (10-14, 7,600
// paired lines) found neither steam (131 bets, -2.2% at +2 min) nor standing
// gaps (289, -4.1%) beat the close once a subscriber's delay is counted, so
// nothing is assumed to pass: the live record has to show it.
// plays: results.scoreboard plays → { pass, rec }
function execPasses(plays = [], signal, { minN = DEFAULTS.alertMinN, minClv = DEFAULTS.alertMinClv } = {}) {
  const rec = plays.find(p => p.source === 'exchangeValue' && p.by === 'signal' && p.play === signal) || null;
  return { pass: !!(rec && rec.execN >= minN && rec.execClv >= minClv), rec };
}
// "Steam record: +2.1% CLV 2 min after the alert over 18 bets (+3.0% at the alert), 72% beat the close"
function recordLine(signal, rec) {
  if (!rec) return null;
  const pc = x => `${x > 0 ? '+' : ''}${(x * 100).toFixed(1)}%`;
  const name = signal.charAt(0).toUpperCase() + signal.slice(1);
  if (rec.execN) return `${name} record: ${pc(rec.execClv)} CLV 2 min after the alert over ${rec.execN} bets (${pc(rec.avgClv)} at the alert), ${Math.round(rec.execBeatPct * 100)}% beat the close`;
  return rec.avgClv != null ? `${name} record: ${pc(rec.avgClv)} CLV at the alert over ${rec.n} bets` : null;
}

const executable = (e, minUsd = DEFAULTS.minUsd) => !!(e?.depth && e.depth.usd >= minUsd);

module.exports = { execPasses, recordLine, kalshiDepth, pmusDepth, createDepthCheck, executable, levels, KALSHI_BOOK_URL, DEFAULTS };
