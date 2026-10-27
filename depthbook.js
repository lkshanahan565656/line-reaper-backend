// ─── ORDER-BOOK DEPTH FOR THE SHOPPER ───────────────────────────────────────
// The shopper's exchange prices (Kalshi, Gemini, Polymarket US) come from each
// venue's board: the top of the book, no size. This keeps the books behind
// them, read with the same calls as the size record (xsize.readAsks), and
// turns a book into what a bettor gets at $50, $200 and $1,000: the book
// walked cheapest first in whole contracts, the taker fee in (depthfill.walk).
//
// Books come from two places: every read the size record makes (it reads
// the sides at +1% over Pinnacle), and a small read budget of the shopper's
// own each minute for exchange prices at or near the fair, arb legs first.
// A book older than maxAgeMs is dropped: a price with no fresh book says
// "size not read", never a guessed size.
//
// Pure functions except createDepthBook's reader, which runs the read it is given.

const D = require('./depthfill');

const { r4, r2 } = require('./mathutil');
const EXCHANGES = new Set(['kalshi', 'gemini', 'polymarketus']);
// reads a minute on top of the size record's. Polymarket US: none of the shopper's own. Its gateway
// answered 429 to the record's 3 a pass and the shopper's 2 alike (live 03:14Z 10-25), so the shopper
// only keeps the books the record reads and never takes reads away from the record.
const READ_BUDGET = { kalshi: 25, gemini: 25, polymarketus: 0 };
const MAX_AGE_MS = 5 * 60e3;
const REFRESH_MS = 3 * 60e3;

const clean = asks => (Array.isArray(asks) ? asks : []).filter(([p, q]) => p > 0 && p < 1 && q > 0).sort((a, b) => a[0] - b[0]);
const costOf = (p, fee) => p + (fee?.rate || 0) * p * (1 - p);

// a shopper quote or price cell → { key, ref } of the book behind it, or null
// (Kalshi: sourceIds { marketId, buy: yes|no }; Gemini and Polymarket US: { venue, id, buy, rate })
function refOf(x) {
  const venue = x?.providerId || x?.provider;
  const s = x?.sourceIds;
  if (!EXCHANGES.has(venue) || !s) return null;
  const id = s.id || s.marketId;
  if (!id || !s.buy) return null;
  const ref = { venue, id: String(id), buy: s.buy, ...(s.rate != null ? { rate: s.rate } : {}) };
  return { key: `${venue}|${ref.id}|${ref.buy}`, ref };
}

// a book { asks [[price, contracts]], fee, at } → its size at every tier and
// beside the fair (fair: the side's no-vig chance, or null)
function sizeOf(book, { fair = null, tiers = D.TIERS, now = Date.now() } = {}) {
  if (!book) return null;
  const asks = clean(book.asks), fee = book.fee || D.VENUES.kalshi;
  const ageSec = Math.max(0, Math.round((now - book.at) / 1000));
  const out = { at: new Date(book.at).toISOString(), ageSec, tiers: {}, topPrice: null, topCost: null, topUsd: 0, depthUsd: 0, atFairUsd: null, empty: !asks.length };
  if (!asks.length) return out;
  const [p0, q0] = asks[0];
  out.topPrice = p0; out.topCost = r4(costOf(p0, fee)); out.topUsd = Math.round(q0 * costOf(p0, fee));
  let all = 0, atFair = 0;
  for (const [p, q] of asks) {
    const c = costOf(p, fee);
    all += q * c;
    if (fair > 0 && fair / c - 1 >= 0) atFair += q * c;
  }
  out.depthUsd = Math.round(all);
  out.atFairUsd = fair > 0 ? Math.round(atFair) : null;
  for (const t of tiers) {
    const w = D.walk(asks, t, fee);
    out.tiers[t] = w ? { usd: w.usd, contracts: w.contracts, cost: w.cost, decimal: r4(1 / w.cost), full: w.full, ev: fair > 0 ? r4(fair / w.cost - 1) : null } : null;
  }
  return out;
}

// the all-in decimal for `usd` on a book, or null when the book can't take it all
function fillAt(book, usd) {
  if (!book || !(usd > 0)) return null;
  const w = D.walk(clean(book.asks), usd, book.fee || D.VENUES.kalshi);
  return w && w.full ? { ...w, decimal: r4(1 / w.cost) } : null;
}

// An arb's size, set by its thinner side. legs: [{ provider, decimal (the
// price the arb was found at), book | null (null: a sportsbook, or a book
// not read) }]. For a total T, each leg's stake is T split so every side pays
// the same at the found prices; exchange legs are walked at that stake. The
// largest T (to maxTotal) at which every leg fills and the set still locks a
// profit is the arb's size.
function arbSize(legs, { stake = 100, maxTotal = 20000 } = {}) {
  if (!Array.isArray(legs) || legs.length < 2 || legs.some(l => !(l.decimal > 1))) return null;
  const unread = legs.filter(l => EXCHANGES.has(l.provider) && !l.book).map(l => l.provider);
  const S = legs.reduce((s, l) => s + 1 / l.decimal, 0);
  const at = T => {
    let spent = 0, payout = Infinity, thin = null, ok = true;
    const per = legs.map(l => {
      const s = T * (1 / l.decimal) / S;
      if (!l.book) { spent += s; payout = Math.min(payout, s * l.decimal); return { provider: l.provider, stake: r2(s), decimal: l.decimal, sized: false }; }
      const w = D.walk(clean(l.book.asks), s, l.book.fee || D.VENUES.kalshi);
      if (!w || !w.full) { ok = false; thin = thin || l.provider; return { provider: l.provider, stake: r2(s), decimal: null, sized: true, short: true }; }
      spent += w.usd; payout = Math.min(payout, w.contracts);
      return { provider: l.provider, stake: w.usd, decimal: r4(1 / w.cost), contracts: w.contracts, sized: true };
    });
    const profit = ok ? payout - spent : null;
    if (ok && !(profit > 0)) thin = legs.reduce((a, l, i) => (l.book && (!a || per[i].decimal < a.d) ? { p: l.provider, d: per[i].decimal } : a), null)?.p || null;
    return { T, ok: ok && profit > 0, profit: profit == null ? null : r2(profit), pct: profit == null || !spent ? null : r4(profit / spent), legs: per, thin };
  };
  if (!legs.some(l => l.book)) return { sized: false, unread, maxTotal: null, atStake: null, note: unread.length ? 'size not read yet' : 'sportsbook limits are not published' };
  const atStake = at(stake);
  // largest T that still locks a profit: doubling, then bisection
  let lo = 0, hi = 0, last = null, firstBad = null;
  for (let T = 10; T <= maxTotal; T *= 2) { const r = at(T); if (r.ok) { lo = T; last = r; } else { hi = T; firstBad = r; break; } }
  if (lo && hi) for (let i = 0; i < 12 && hi - lo > 1; i++) { const mid = (lo + hi) / 2, r = at(mid); if (r.ok) { lo = mid; last = r; } else { hi = mid; firstBad = r; } }
  return { sized: true, unread, maxTotal: last ? Math.floor(lo) : 0, atMax: last, atStake, thin: firstBad?.thin || null, capped: !hi && !!last };
}

// which exchange prices the shopper should read a book for: views from
// shopper.viewMarket; arb and near-arb legs first, then the best EV
function candidates(views, { minEv = -0.02, nearHold = 0.02 } = {}) {
  const out = new Map();
  for (const m of views || []) {
    const near = m.hold != null && m.hold < nearHold;
    for (const s of m.sides || []) for (const c of s.prices || []) {
      const r = refOf(c);
      if (!r || !c.bettable) continue;
      const pri = near && c.best ? 2 + (-m.hold) : c.ev != null && c.ev >= minEv ? 1 + c.ev : c.best ? 0.5 : null;
      if (pri == null) continue;
      const had = out.get(r.key);
      if (!had || had.pri < pri) out.set(r.key, { ...r, pri, start: m.start });
    }
  }
  return [...out.values()].sort((a, b) => b.pri - a.pri);
}

// the cache and the reader
function createDepthBook({ readAsks = null, now = () => Date.now(), maxAgeMs = MAX_AGE_MS, refreshMs = REFRESH_MS, budget = READ_BUDGET, max = 6000 } = {}) {
  const books = new Map();
  const holdUntil = {};
  const state = { books: 0, reads: {}, fromRecord: 0, errors: [], lastPass: null, lastPassMs: null, wanted: 0 };
  function put(key, book, at = now()) {
    if (!key || !book) return;
    if (books.size >= max && !books.has(key)) prune(true);
    books.set(key, { asks: clean(book.asks), fee: book.fee || null, at });
    state.books = books.size;
  }
  function get(key) {
    const b = books.get(key);
    if (!b) return null;
    if (now() - b.at > maxAgeMs) { books.delete(key); state.books = books.size; return null; }
    return b;
  }
  function prune(force = false) {
    const t = now();
    for (const [k, b] of books) if (t - b.at > maxAgeMs) books.delete(k);
    if (force && books.size >= max) { const old = [...books].sort((a, b) => a[1].at - b[1].at).slice(0, Math.ceil(max / 10)); for (const [k] of old) books.delete(k); }
    state.books = books.size;
  }
  const forQuote = q => { const r = refOf(q); return r ? get(r.key) : null; };
  // the size record's reads, kept for the shopper
  function fromRecord(ref, book, at = now()) {
    if (!ref || !book) return;
    put(`${ref.venue}|${ref.id}|${ref.buy}`, book, at);
    state.fromRecord++;
  }
  // one pass: up to budget reads a venue, freshest-needed first, venues side by side
  async function readPass(cands) {
    if (!readAsks) return { read: 0 };
    const t0 = now();
    prune();
    const per = {};
    const todo = (cands || []).filter(c => {
      const b = books.get(c.key);
      if (b && t0 - b.at < refreshMs) return false;
      if (t0 < (holdUntil[c.ref.venue] || 0)) return false;
      per[c.ref.venue] = (per[c.ref.venue] || 0) + 1;
      return per[c.ref.venue] <= (budget[c.ref.venue] || 0);
    });
    state.wanted = (cands || []).length;
    let read = 0;
    await Promise.all([...EXCHANGES].map(async v => {
      for (const c of todo.filter(x => x.ref.venue === v)) {
        if (now() < (holdUntil[v] || 0)) break;
        try {
          const b = await readAsks(c.ref);
          state.reads[v] = (state.reads[v] || 0) + 1;
          if (b) { put(c.key, b); read++; }
        } catch (e) {
          const st = e?.response?.status;
          if (st === 403 || st === 429) holdUntil[v] = now() + 10 * 60e3;
          state.errors = [`${v}: ${st || e.message}`, ...state.errors].slice(0, 5);
        }
      }
    }));
    state.lastPass = new Date(t0).toISOString(); state.lastPassMs = now() - t0;
    return { read, wanted: todo.length };
  }
  return { put, get, forQuote, fromRecord, readPass, prune, state, size: () => books.size };
}

module.exports = { EXCHANGES, READ_BUDGET, MAX_AGE_MS, refOf, sizeOf, fillAt, arbSize, candidates, createDepthBook };
