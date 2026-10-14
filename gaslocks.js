// ─── GAS LOCKS ────────────────────────────────────────────────────────────────
// Kalshi's daily state gas markets ("Will the AAA average in CA be above
// $4.65 on Oct 15?") settle on a number that barely moves overnight, and the
// favourite side is still offered at 90-98¢ the evening before. A backtest of
// every settled market from Aug 17 to Oct 14 2026 (taker at the ask, Kalshi's
// fee in, 12 to 19 hours before expiry) found:
//
//   15 states picked on the first half (Aug 17 to Sep 26) went +1.5% a bet
//   on the second half (Sep 27 to Oct 14): 1,541 bets, 2 losses, every day
//   up. The other states (price-cycling Midwest ones, CO, AZ...) went +0.7%
//   with 12 losses, so they're left out.
//
// Not risk-free: a refinery outage can jump a state's average past the
// strike overnight, and one loss at 97¢ costs ~32 wins. Each play is logged
// once, at its first price, and graded from Kalshi's result (1u staked) and
// against the close (our side's mid at the last scan before trading stops).

const { createMemoryStore } = require('./evtrack');
const { kalshiFee } = require('./exchanges');
const { kalshiDepth } = require('./execcheck');

const K = 'https://api.elections.kalshi.com/trade-api/v2';
const HOUR = 3600e3;
const DEFAULTS = {
  states: ['CA', 'MA', 'MD', 'WA', 'MI', 'VA', 'TX', 'FL', 'MN', 'OH', 'TN', 'OR', 'NY', 'NJ', 'SC'],
  minPrice: 0.90, maxPrice: 0.98,          // the favourite's ask (99¢ earns ~0.9% and is all fee rounding on small orders)
  fromHours: 12, toHours: 19,              // hours before Kalshi's expected expiration (14:00 UTC)
  minDepthUsd: 100,                        // dollars resting at or under the ask
  orderContracts: 100,                     // fee priced on an order this size (Kalshi rounds per order)
  maxBooks: 120,                           // order-book reads a scan
};
const BACKTEST = { from: '2026-08-17', to: '2026-10-14', outOfSample: { bets: 1541, losses: 2, roi: 0.0148, from: '2026-09-27' }, otherStates: { bets: 1156, losses: 12, roi: 0.0066 } };

const num = v => (v == null || v === '' ? null : Number(v));
const r4 = x => (x == null || !Number.isFinite(x) ? null : Math.round(x * 1e4) / 1e4);
const seriesOf = st => `KXAAAGASD${st}`;
const stateOf = ticker => (String(ticker).match(/^KXAAAGASD([A-Z]{2})-/) || [])[1] || null;
// all-in cost of one contract at `price` on an order of n contracts
const costOf = (price, n = DEFAULTS.orderContracts) => r4(price + kalshiFee(price, n) / n);

// one listing row → a candidate play (or null): the side asked in range
function candidate(m, { now = Date.now(), ...o } = {}) {
  const opts = { ...DEFAULTS, ...o };
  const exp = Date.parse(m.expected_expiration_time || ''), close = Date.parse(m.close_time || '');
  if (!Number.isFinite(exp) || !Number.isFinite(close) || close <= now + 10 * 60e3) return null;
  const hrs = (exp - now) / HOUR;
  if (hrs < opts.fromHours || hrs > opts.toHours) return null;
  const ya = num(m.yes_ask_dollars), na = num(m.no_ask_dollars);
  const inRange = p => p != null && p >= opts.minPrice - 1e-9 && p <= opts.maxPrice + 1e-9;
  const side = inRange(ya) ? 'yes' : inRange(na) ? 'no' : null;
  if (!side) return null;
  const price = side === 'yes' ? ya : na;
  const strike = num(m.floor_strike) ?? num((String(m.ticker).match(/-([\d.]+)$/) || [])[1]);
  const state = stateOf(m.ticker);
  const day = (String(m.event_ticker || m.ticker).match(/-(\d{2}[A-Z]{3}\d{2})/) || [])[1] || null;
  return {
    id: `${m.ticker}:${side}`, ticker: m.ticker, event: m.event_ticker || m.ticker.split('-').slice(0, 2).join('-'), state, strike, day, side,
    pick: `${state} gas ${side === 'yes' ? 'above' : 'at or below'} $${strike?.toFixed(3)}`,
    title: m.title || null, price, cost: costOf(price, opts.orderContracts), hoursLeft: Math.round(hrs * 10) / 10,
    expectedExpiration: m.expected_expiration_time, closeTime: m.close_time,
    url: `https://kalshi.com/markets/${String(m.event_ticker || '').toLowerCase()}`,
  };
}
// our side's mid from a listing row (the close we grade against)
function midOf(m, side) {
  const ya = num(m.yes_ask_dollars), yb = num(m.yes_bid_dollars);
  if (!(ya > 0 && ya < 1 && yb > 0 && yb < 1)) return null;
  const yes = (ya + yb) / 2;
  return r4(side === 'yes' ? yes : 1 - yes);
}

// One scan: each state's open markets, then the order book of every
// candidate (up to maxBooks) for the dollars at or under its ask.
// → { plays, rows (every listing row, for closing marks), counts, errors }
async function scan(http, o = {}) {
  const opts = { ...DEFAULTS, ...o }, now = o.now ?? Date.now();
  const rows = [], errors = [];
  for (const st of opts.states) {
    try {
      const d = (await http.get(`${K}/markets`, { params: { series_ticker: seriesOf(st), status: 'open', limit: 200 }, timeout: 15000 }))?.data;
      rows.push(...(d?.markets || []));
    } catch (e) { errors.push(`${st}: ${e.message}`); }
  }
  const cands = rows.map(m => candidate(m, { ...opts, now })).filter(Boolean);
  const skip = o.skip || new Set();   // already-logged plays don't need a book read
  const plays = [];
  let books = 0;
  for (const c of cands.sort((a, b) => a.price - b.price)) {
    if (skip.has(c.id)) { plays.push({ ...c, depth: null, logged: true }); continue; }
    if (books >= opts.maxBooks) break;
    books++;
    try {
      const ob = (await http.get(`${K}/markets/${encodeURIComponent(c.ticker)}/orderbook`, { timeout: 10000 }))?.data;
      const depth = kalshiDepth(ob, c.side, c.price);
      if (depth.usd >= opts.minDepthUsd) plays.push({ ...c, depth });
    } catch (e) { errors.push(`${c.ticker}: ${e.message}`); }
  }
  return { plays, rows, counts: { markets: rows.length, candidates: cands.length, books, plays: plays.length }, errors };
}

// ─── track record ───
function createGasTracker({ store = createMemoryStore(), http = null, now = () => Date.now(), log = console } = {}) {
  const ready = store.init();
  const open = new Map();
  const loaded = ready.then(async () => { for (const r of await store.all()) if (r.status === 'open') open.set(r.id, r); });

  // new plays → logged at their first price; returns the ones that are new
  async function record(plays = []) {
    await loaded;
    const ids = new Set((await store.all()).map(r => r.id)), fresh = [];
    for (const p of plays) {
      if (ids.has(p.id) || p.logged) continue;
      ids.add(p.id);
      const r = { id: p.id, status: 'open', flaggedAt: new Date(now()).toISOString(), ticker: p.ticker, event: p.event, state: p.state, strike: p.strike, day: p.day, side: p.side, pick: p.pick,
        price: p.price, cost: p.cost, depthUsd: p.depth?.usd ?? null, contracts: p.depth?.contracts ?? null, hoursLeft: p.hoursLeft, expectedExpiration: p.expectedExpiration, closeTime: p.closeTime, url: p.url };
      open.set(r.id, r);
      fresh.push(r);
    }
    await Promise.all(fresh.map(r => store.put(r))).catch(e => log.warn?.(`Gas locks: ${e.message}`));
    return fresh;
  }
  // every scan's listing: the latest mid on our side, until trading stops
  async function mark(rows = []) {
    await loaded;
    const t = now(), by = new Map(rows.map(m => [m.ticker, m])), writes = [];
    for (const r of open.values()) {
      const m = by.get(r.ticker);
      if (!m || Date.parse(r.closeTime) <= t) continue;
      const mid = midOf(m, r.side);
      if (mid != null && mid !== r.closeMid) { r.closeMid = mid; r.closeAt = new Date(t).toISOString(); writes.push(store.put(r)); }
    }
    await Promise.all(writes).catch(e => log.warn?.(`Gas locks: ${e.message}`));
  }
  // settled: Kalshi's result, an hour after the expected expiration
  async function grade() {
    await loaded;
    if (!http) return 0;
    const t = now();
    let n = 0;
    for (const r of [...open.values()].filter(x => Date.parse(x.expectedExpiration) + HOUR <= t)) {
      let m = null;
      try { m = (await http.get(`${K}/markets/${encodeURIComponent(r.ticker)}`, { timeout: 10000 }))?.data?.market; }
      catch (e) { log.warn?.(`Gas locks: ${r.ticker}: ${e.message}`); continue; }
      const res = String(m?.result || '').toLowerCase();
      if (res !== 'yes' && res !== 'no') { if (Date.parse(r.expectedExpiration) + 8 * 24 * HOUR <= t) { r.status = 'ungraded'; open.delete(r.id); await store.put(r).catch(() => {}); } continue; }
      const win = res === r.side;
      Object.assign(r, { status: 'graded', outcome: win ? 'win' : 'loss', profit: r4(((win ? 1 : 0) - r.cost) / r.cost), clv: r.closeMid != null ? r4(r.closeMid / r.price - 1) : null, gradedAt: new Date(t).toISOString() });
      open.delete(r.id);
      n++;
      await store.put(r).catch(e => log.warn?.(`Gas locks: ${e.message}`));
    }
    return n;
  }
  async function summary() {
    await loaded;
    const all = await store.all(), graded = all.filter(r => r.status === 'graded');
    const units = graded.reduce((a, r) => a + r.profit, 0), clvs = graded.map(r => r.clv).filter(v => v != null);
    return { open: open.size, graded: graded.length, wins: graded.filter(r => r.outcome === 'win').length, losses: graded.filter(r => r.outcome === 'loss').length,
      units: Math.round(units * 100) / 100, roi: graded.length ? r4(units / graded.length) : null, avgClv: clvs.length ? r4(clvs.reduce((a, b) => a + b, 0) / clvs.length) : null, clvN: clvs.length };
  }
  async function list() { await loaded; return store.all(); }
  return { record, mark, grade, summary, list, ready: () => loaded, store };
}

// one alert line
const describe = r => `${r.pick} (${r.day}) · ${Math.round(r.price * 100)}¢ · ${r.depthUsd != null ? `$${r.depthUsd.toLocaleString('en-US')} at the ask` : ''}`.replace(/ · $/, '');

module.exports = { DEFAULTS, BACKTEST, candidate, midOf, scan, createGasTracker, describe, stateOf, costOf };
