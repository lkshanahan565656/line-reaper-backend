// ─── OFFSHORE POLYMARKET AS THE REFERENCE PRICE (NON-SPORTS) ─────────────────
// A research recorder with its own record, never an alert, never shown as a
// bet. The question (pre-registered 10-26 19:20Z in
// /mnt/project-files/line-reaper/checks/offshore-pm-2026-10-26/): in the
// non-sports markets where the offshore Polymarket book is the deepest public
// price, does taking Kalshi or Polymarket US at a price the offshore book has
// already left, taker fee in, pay?
//
// Pairs (seeds/offshore-pairs.json, built by scripts/offshore-pairs.js from a
// dump of every open non-sports market on the three venues): only contracts
// that pay on the same outcome by the same source. 100 pairs on 10-26: 81
// election races (office, state or district, party), 4 chamber-control and 15
// Fed-decision outcomes; 43 of them also on Polymarket US. The mismatch list
// beside it says what was left out and why (seat counts, IPO "confirms" vs
// "completes", crypto and weather sources, thin offshore books).
//
// Backtest (21 days of 1-minute prices, all 100 pairs, 10-05 to 10-26):
//   - S-MOVE: offshore mid up 3c+ in 15 min, the US mid under half of that,
//     the US side at least 1c under the offshore mid fee in; take it a minute
//     later. Kalshi 54 bets, own mid 60 min later −0.52c a contract (t −1.7);
//     Polymarket US 28, +0.18c (t 0.3). Before the fee both were up about
//     +0.9c and +1.5c: the fee (1.3 to 1.5c) is the whole difference.
//   - S-GAP: the US side 3c+ under the offshore mid. Kalshi 51 bets −1.08c
//     (t −2.9), Polymarket US 324 bets −1.65c (t −9.1). The gap does not close:
//     an hour later the offshore mid is still 2.7 to 3.4c above the price.
//   - Who moves first: Kalshi follows an offshore Fed move 85% of the time
//     within an hour, but on races Kalshi moves first (offshore follows 76%,
//     Kalshi follows offshore 53%). Polymarket US barely moves on races at all.
//   Verdict: FAIL on the pre-registered bar (own-venue mid 60 min later, t ≥ 2
//   over 50). Two pieces stay open and are what this records live: the
//   standing gap held to resolution (the Fed on 10-28, races on 11-03), and the
//   size actually resting at the shown price.
//
// Each tick (a minute): the offshore books (one POST /books for every token),
// Kalshi's quotes (GET /markets?tickers=, one call per 100), and each Polymarket
// US book. A flag reads the size at or under the flagged price (Kalshi
// orderbook, the Polymarket US book) and is graded on the US venue's own mid
// and the offshore mid 30 and 60 minutes later, the US bid an hour later (a
// real exit) and the market's own result. OFFSHORE_REF=off stops it.

const fees = require('./fees');
const { parseBook: parseClob } = require('./tail');
const pmus = require('./pmus');

const KALSHI = 'https://api.elections.kalshi.com/trade-api/v2';
const CLOB = 'https://clob.polymarket.com';
const GATEWAY = 'https://gateway.polymarket.us';

const DEFAULTS = {
  moveMin: 0.03,            // offshore move over the window, dollars
  windowMs: 15 * 60e3,
  followFrac: 0.5,          // the US mid moved less than this share of it
  minEdgeMove: 0.01,        // offshore mid − US cost, fee in
  minEdgeGap: 0.03,
  cooldownMs: 60 * 60e3,    // one flag per pair, venue, side and signal an hour
  minPrice: 0.05, maxPrice: 0.95,
  maxQuoteAgeMs: 3 * 60e3,  // a window's start point can be up to this much older
  keepMs: 3 * 3600e3,       // price history kept per pair and venue
  marksMin: [30, 60],
  target: 50,
  lot: 100,
};
const VENUE_NAME = { kalshi: 'Kalshi', pmus: 'Polymarket US' };
const r4 = x => (x == null || !Number.isFinite(x) ? null : Math.round(x * 1e4) / 1e4);
const num = v => (v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);

// per-contract taker fee in dollars at a 100 lot
function feeOf(venue, price, pair = {}, o = DEFAULTS) {
  if (!(price > 0 && price < 1)) return null;
  if (venue === 'kalshi') {
    const mult = num(pair.k?.fm) ?? 1;
    return fees.orderFee('kalshi', price, o.lot, { rate: 0.07 * mult, round: true }) / o.lot;
  }
  const rate = num(pair.u?.fee) ?? fees.SCHEDULES.polymarketus.taker.rate;
  return fees.orderFee('polymarketus', price, o.lot, { rate }) / o.lot;
}

// the cluster a pair's bets are counted in (one Fed meeting, one chamber, one race)
function eventOf(id) {
  const parts = String(id).split('|');
  return parts.slice(0, parts[0] === 'fed' ? 2 : 3).join('|');
}

// What buying `side` (yes / no) costs at a quote { ask, bid } (YES prices)
function sideCost(q, side, venue, pair, o = DEFAULTS) {
  const price = side === 'yes' ? q.ask : q.bid == null ? null : 1 - q.bid;
  if (!(price >= o.minPrice && price <= o.maxPrice)) return null;
  const fee = feeOf(venue, price, pair, o);
  return fee == null ? null : { price: r4(price), fee: r4(fee), cost: r4(price + fee) };
}
const midOf = q => (q && q.ask != null && q.bid != null && q.ask >= q.bid ? (q.ask + q.bid) / 2 : null);

// the latest point at or before t, no older than maxAge
function pointAt(hist, t, maxAge) {
  for (let i = hist.length - 1; i >= 0; i--) {
    if (hist[i].t <= t) return t - hist[i].t <= maxAge ? hist[i] : null;
  }
  return null;
}

// New flags at the newest point of hist ([{ t, m, ask, bid }], m = offshore mid,
// ask/bid = the US venue's YES quote). Pure; lastFlag maps a flag key to its time.
function detect(hist, pair, venue, lastFlag = new Map(), o = DEFAULTS) {
  const now = hist[hist.length - 1];
  if (!now || now.m == null || midOf(now) == null) return [];
  const then = pointAt(hist, now.t - o.windowMs, o.maxQuoteAgeMs);
  const out = [];
  for (const side of ['yes', 'no']) {
    const c = sideCost(now, side, venue, pair, o);
    if (!c) continue;
    const fair = side === 'yes' ? now.m : 1 - now.m;
    const edge = fair - c.cost;
    const s = side === 'yes' ? 1 : -1;
    const sigs = [];
    if (then && then.m != null && midOf(then) != null) {
      const dM = (now.m - then.m) * s, dU = (midOf(now) - midOf(then)) * s;
      if (dM >= o.moveMin - 1e-9 && dU < o.followFrac * dM && edge >= o.minEdgeMove - 1e-9) sigs.push({ sig: 'move', move: r4(dM), usMove: r4(dU) });
    }
    if (edge >= o.minEdgeGap - 1e-9) sigs.push({ sig: 'gap' });
    for (const g of sigs) {
      const key = `${pair.id}|${venue}|${side}|${g.sig}`;
      if (now.t - (lastFlag.get(key) ?? -Infinity) < o.cooldownMs) continue;
      lastFlag.set(key, now.t);
      out.push({ key, ...g, pairId: pair.id, fam: pair.fam, cat: pair.cat, event: eventOf(pair.id), venue, side, t: now.t,
        price: c.price, fee: c.fee, cost: c.cost, fair: r4(fair), edge: r4(edge), usMid: r4(side === 'yes' ? midOf(now) : 1 - midOf(now)) });
    }
  }
  return out;
}

// Fill the 30 and 60 minute marks of an open bet from a point { t, m, ask, bid }
// taken at or after them. Returns true when something changed.
function mark(bet, point, o = DEFAULTS) {
  if (!point) return false;
  const age = (point.t - Date.parse(bet.flaggedAt)) / 60e3;
  const s = bet.side === 'yes';
  let changed = false;
  for (const m of o.marksMin) {
    if (age < m || bet[`u${m}`] !== undefined) continue;
    if (age > m + 5) { bet[`u${m}`] = null; bet[`x${m}`] = null; changed = true; continue; }   // missed: no read near the mark
    const um = midOf(point);
    bet[`u${m}`] = um == null ? null : r4(s ? um : 1 - um);
    bet[`x${m}`] = point.m == null ? null : r4(s ? point.m : 1 - point.m);
    if (m === 60) bet.exit60 = s ? (point.bid ?? null) : point.ask == null ? null : r4(1 - point.ask);
    changed = true;
  }
  return changed;
}

// clustered mean and t of f over rows (cluster = event)
function clusterT(rows, f) {
  const xs = [];
  for (const r of rows) { const v = f(r); if (v != null && Number.isFinite(v)) xs.push([r.event, v]); }
  if (!xs.length) return { n: 0, events: 0, mean: null, t: null };
  const mean = xs.reduce((a, [, v]) => a + v, 0) / xs.length;
  const cl = new Map();
  for (const [e, v] of xs) cl.set(e, (cl.get(e) || 0) + (v - mean));
  const G = cl.size;
  let ss = 0; for (const v of cl.values()) ss += v * v;
  const se = G > 1 ? Math.sqrt(ss * G / (G - 1)) / xs.length : 0;
  return { n: xs.length, events: G, mean: r4(mean), t: se > 0 ? Math.round(mean / se * 100) / 100 : null };
}

// The record per signal × venue × family: graded = 60-minute mark read. No
// units or profit: nothing here is proven.
function summarize(rows = [], o = DEFAULTS) {
  const groups = new Map();
  for (const r of rows) for (const fam of [r.fam, 'all']) {
    const k = `${r.sig}|${r.venue}|${fam}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const out = [];
  for (const [k, list] of groups) {
    const [sig, venue, fam] = k.split('|');
    const own60 = clusterT(list, r => (r.u60 == null ? null : r.u60 - r.cost));
    const settled = list.filter(r => r.result === 0 || r.result === 1);
    const depth = list.map(r => r.depth?.contracts).filter(n => n != null).sort((a, b) => a - b);
    out.push({
      sig, venue, venueName: VENUE_NAME[venue], fam, flagged: list.length, graded: own60.n, target: o.target,
      own30: clusterT(list, r => (r.u30 == null ? null : r.u30 - r.cost)), own60,
      exit60: clusterT(list, r => (r.exit60 == null ? null : r.exit60 - r.cost)),
      offshore60: clusterT(list, r => (r.x60 == null ? null : r.x60 - r.cost)),
      settled: settled.length, won: settled.filter(r => r.result === 1).length,
      vsResult: clusterT(settled, r => r.result - r.cost),
      meanFee: r4(list.reduce((a, r) => a + (r.fee || 0), 0) / list.length),
      medianDepth: depth.length ? depth[Math.floor(depth.length / 2)] : null,
      label: `research, not an edge, ${Math.min(own60.n, o.target)} of ${o.target}`,
      profitShown: false,
    });
  }
  return out.sort((a, b) => a.sig.localeCompare(b.sig) || a.venue.localeCompare(b.venue) || (a.fam === 'all' ? -1 : b.fam === 'all' ? 1 : a.fam.localeCompare(b.fam)));
}

// GET /markets?tickers= payload → Map ticker → { ask, bid, status, result }
function parseKalshiQuotes(payload) {
  const out = new Map();
  for (const m of payload?.markets || []) {
    if (!m?.ticker) continue;
    const ask = num(m.yes_ask_dollars) ?? (num(m.yes_ask) != null ? num(m.yes_ask) / 100 : null);
    const bid = num(m.yes_bid_dollars) ?? (num(m.yes_bid) != null ? num(m.yes_bid) / 100 : null);
    const result = String(m.result || '').toLowerCase();
    out.set(m.ticker, { ask: ask > 0 && ask < 1 ? ask : null, bid: bid > 0 && bid < 1 ? bid : null, status: m.status || null, result: result === 'yes' ? 1 : result === 'no' ? 0 : null });
  }
  return out;
}
// POST /books payload → Map token → mid (only books 10c wide or tighter)
function parseOffshoreMids(payload) {
  const out = new Map();
  for (const b of Array.isArray(payload) ? payload : []) {
    const id = b?.asset_id || b?.token_id;
    const p = parseClob(b);
    if (!id || !p || p.mid == null || !(p.spread <= 0.1)) continue;
    out.set(String(id), { mid: p.mid, spread: p.spread, bidSize: p.bidSize, askSize: p.askSize });
  }
  return out;
}

function createOffshoreRef({ http, post = null, pairs = [], store, now = () => Date.now(), log = console, opts = {} } = {}) {
  const o = { ...DEFAULTS, ...opts };
  const hist = new Map();      // `${pairId}|${venue}` → [{ t, m, ask, bid }]
  const lastFlag = new Map();
  const open = new Map();
  const state = { on: true, pairs: pairs.length, ticks: 0, lastTick: null, lastMs: null, quotes: { offshore: 0, kalshi: 0, pmus: 0 }, flags: 0, errors: [] };
  const err = m => { state.errors.unshift(`${new Date(now()).toISOString()} ${m}`); state.errors.length = Math.min(state.errors.length, 8); };
  const ready = store.init().then(async () => {
    for (const r of await store.all()) {
      if (r.status !== 'open') continue;
      open.set(r.id, r);
      const key = `${r.pairId}|${r.venue}|${r.side}|${r.sig}`;
      lastFlag.set(key, Math.max(lastFlag.get(key) ?? -Infinity, Date.parse(r.flaggedAt)));
    }
  });

  async function readOffshore() {
    const toks = [...new Set(pairs.map(p => p.p?.tok).filter(Boolean))];
    const out = new Map();
    for (let i = 0; i < toks.length; i += 100) {
      const res = await post(`${CLOB}/books`, toks.slice(i, i + 100).map(t => ({ token_id: t })), { timeout: 15000 });
      for (const [k, v] of parseOffshoreMids(res?.data)) out.set(k, v);
    }
    return out;
  }
  async function readKalshi() {
    const tks = [...new Set(pairs.map(p => p.k?.t).filter(Boolean))];
    const out = new Map();
    for (let i = 0; i < tks.length; i += 100) {
      const res = await http.get(`${KALSHI}/markets`, { params: { tickers: tks.slice(i, i + 100).join(','), limit: 100 }, timeout: 15000 });
      for (const [k, v] of parseKalshiQuotes(res?.data)) out.set(k, v);
    }
    return out;
  }
  async function readPmus() {
    const out = new Map();
    for (const slug of [...new Set(pairs.map(p => p.u?.slug).filter(Boolean))]) {
      try {
        const res = await http.get(`${GATEWAY}/v1/markets/${encodeURIComponent(slug)}/book`, { timeout: 8000 });
        const b = pmus.parseBook(res?.data);
        if (b) out.set(slug, b);
      } catch (e) { if (out.size === 0 && e?.response?.status !== 404) throw e; }
    }
    return out;
  }
  // size at or under the flagged price on the venue's book
  async function depthOf(f, pair, books) {
    try {
      if (f.venue === 'kalshi') {
        const res = await http.get(`${KALSHI}/markets/${encodeURIComponent(pair.k.t)}/orderbook`, { timeout: 8000 });
        const ob = res?.data?.orderbook_fp || res?.data?.orderbook || {};
        const lv = ob[f.side === 'yes' ? 'no_dollars' : 'yes_dollars'] || [];
        let contracts = 0, usd = 0;
        for (const [q, n] of lv.map(([p, n]) => [parseFloat(p), parseFloat(n)])) {
          const ask = 1 - q;
          if (ask <= f.price + 1e-9 && n > 0) { contracts += n; usd += n * ask; }
        }
        return { contracts: Math.round(contracts), usd: Math.round(usd) };
      }
      const b = books.get(pair.u.slug);
      if (!b) return null;
      const lv = f.side === 'yes' ? b.offers : b.bids.map(([p, n]) => [1 - p, n]);
      let contracts = 0, usd = 0;
      for (const [ask, n] of lv) if (ask <= f.price + 1e-9 && n > 0) { contracts += n; usd += n * ask; }
      return { contracts: Math.round(contracts), usd: Math.round(usd) };
    } catch { return null; }
  }

  async function tick() {
    await ready;
    const t0 = now();
    const [off, kq, ub] = await Promise.all([
      readOffshore().catch(e => { err(`offshore books: ${e.message}`); return new Map(); }),
      readKalshi().catch(e => { err(`Kalshi quotes: ${e.message}`); return new Map(); }),
      readPmus().catch(e => { err(`Polymarket US books: ${e.message}`); return new Map(); }),
    ]);
    state.quotes = { offshore: off.size, kalshi: kq.size, pmus: ub.size };
    const t = now(), fresh = [], writes = [];
    const results = new Map();   // pairId → Kalshi's YES result, 0/1
    for (const pair of pairs) {
      const m = off.get(String(pair.p?.tok))?.mid ?? null;
      const venues = [];
      if (pair.k) { const q = kq.get(pair.k.t); if (q) { venues.push(['kalshi', q]); if (q.result != null) results.set(pair.id, q.result); } }
      if (pair.u) { const b = ub.get(pair.u.slug); if (b) venues.push(['pmus', { ask: b.ask, bid: b.bid, open: b.open }]); }
      for (const [venue, q] of venues) {
        const key = `${pair.id}|${venue}`;
        const h = hist.get(key) || [];
        h.push({ t, m, ask: q.ask ?? null, bid: q.bid ?? null });
        while (h.length && t - h[0].t > o.keepMs) h.shift();
        hist.set(key, h);
        if (q.status && !/^(active|open)$/i.test(q.status)) continue;
        if (q.open === false) continue;
        for (const f of detect(h, pair, venue, lastFlag, o)) fresh.push([f, pair]);
      }
    }
    for (const [f, pair] of fresh) {
      const depth = await depthOf(f, pair, ub);
      const r = { id: `${f.key}|${f.t}`, status: 'open', flaggedAt: new Date(f.t).toISOString(), ...f, depth, result: null };
      delete r.key;
      open.set(r.id, r); writes.push(r);
    }
    state.flags += fresh.length;
    for (const r of open.values()) {
      const h = hist.get(`${r.pairId}|${r.venue}`);
      let changed = mark(r, h?.[h.length - 1], o);
      // both venues settle from Kalshi's result: every Polymarket US pair is also a
      // Kalshi pair with the same terms (Polymarket US has no public settlement until one exists)
      const res = results.get(r.pairId);
      if (res != null && r.result == null) {
        r.result = r.side === 'yes' ? res : 1 - res;
        r.settledAt = new Date(t).toISOString();
        changed = true;
      }
      const marked = o.marksMin.every(mm => r[`u${mm}`] !== undefined);
      if (marked && r.result != null) { r.status = 'graded'; open.delete(r.id); changed = true; }
      if (changed && !writes.includes(r)) writes.push(r);
    }
    if (writes.length) await (store.putMany ? store.putMany(writes) : Promise.all(writes.map(w => store.put(w)))).catch(e => err(`store: ${e.message}`));
    state.ticks++; state.lastTick = new Date(t).toISOString(); state.lastMs = now() - t0;
    return fresh.map(([f]) => f);
  }

  // the current US-vs-offshore gaps, widest first (research view, no links to the offshore book)
  function gaps(limit = 25) {
    const out = [];
    for (const pair of pairs) for (const venue of ['kalshi', 'pmus']) {
      const h = hist.get(`${pair.id}|${venue}`);
      const p = h?.[h.length - 1];
      if (!p || p.m == null || now() - p.t > 5 * 60e3) continue;
      for (const side of ['yes', 'no']) {
        const c = sideCost(p, side, venue, pair, o);
        if (!c) continue;
        const fair = side === 'yes' ? p.m : 1 - p.m;
        out.push({ pairId: pair.id, fam: pair.fam, cat: pair.cat, venue, venueName: VENUE_NAME[venue], side, question: pair.p.q, outcome: pair.p.git,
          kalshiTicker: venue === 'kalshi' ? pair.k.t : undefined, pmusSlug: venue === 'pmus' ? pair.u.slug : undefined,
          price: c.price, fee: c.fee, cost: c.cost, offshoreMid: r4(fair), gap: r4(fair - c.cost), at: new Date(p.t).toISOString() });
      }
    }
    return out.sort((a, b) => b.gap - a.gap).slice(0, limit);
  }

  return { tick, gaps, ready, state: () => ({ ...state, open: open.size }), list: async () => { await ready; return store.all(); } };
}

module.exports = { DEFAULTS, VENUE_NAME, feeOf, eventOf, sideCost, midOf, detect, mark, clusterT, summarize, parseKalshiQuotes, parseOffshoreMids, createOffshoreRef };
