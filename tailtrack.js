// ─── SHARP TAIL TRACK RECORD ──────────────────────────────────────────────────
// Proof that tailing works. Every tail signal sized above 0 units is logged
// once, at the price a follower could actually get when it fired, not the
// sharp's own fill: the venue the signal recommended (signal.venue: its
// price and units) or, without one, Polymarket's ask (currentPrice) and the
// signal's units. The follower also pays that venue's taker fee a contract
// (venue.fee when the signal says; Kalshi 0.07 × p(1 − p); Polymarket the
// signal's own fee; sportsbooks none, their margin is in the price), so a bet
// costs entry + fee. Each check looks the market up on Gamma by conditionId:
//
//   still open   remember its last traded price for our outcome: the last one
//                seen before the event (a game's start, the market's scheduled
//                end, orders stopping) is the close. A jump to 97¢+ or 3¢- is
//                the outcome getting out, not a closing line: the close freezes
//                there, and a record with no close before it has no CLV.
//   resolved     win  → profit = units × (1 / cost − 1), cost = entry + fee
//                loss → profit = −units
//                50/50 → void, profit 0
//                CLV  = closing price / entry − 1 (beat the close when > 0;
//                prices against prices, before fees)
//   close in     the game started, or the price jumped to the outcome: the
//                CLV is known then (closeOut), hours before it resolves, and
//                summary().closing counts it
//
// A resting bid (signal.limit: no venue sized a take, so the signal says to
// bid a cent or two under the ask) is logged with order 'limit' at its own
// price and maker fee, and only counts once it would have filled: the
// outcome's Polymarket price traded through the bid (half a cent under it,
// so the queue ahead of us went first) after the signal and before the
// event. Each check reads the live price; when the event comes without a
// fill, the price history since the signal decides once. Never filled →
// result 'unfilled', left out of every stat. On Kalshi and Polymarket US the
// Polymarket price stands in for that venue's. A filled bid's CLV is
// against its own price.
//
// A top-up (the sharp buying more of the same thing) joins its first bet as
// one record: the units add up, and the entry (and the cost) becomes the
// single price with the same payout (units / Σ(units_i / entry_i)).
//
// summary() reports n, wins, losses, units won, ROI (units won / units staked)
// overall and split by grade, by category, consensus vs single-wallet and venue.
// ROI and CLV are fractions (0.05 = 5%); profit is in units.
//
// Store pattern as evtrack.js: memory for tests, a JSON file locally
// (TAIL_TRACK_FILE), Postgres table tail_signals when DATABASE_URL is set.
// The fresh-wallet radar keeps its own record the same way (FRESH_TRACK_FILE,
// table fresh_signals).

const path = require('path');
const { createMemoryStore, createFileStore } = require('./evtrack');
const { fetchMarket, fetchBook, fetchPriceHistory, resolutionOf, priceOf, outcomeIndexOf, toMs } = require('./tail');

function createPgStore(connectionString, table = 'tail_signals') {
  if (!/^[a-z_]+$/.test(table)) throw new Error(`bad table name ${table}`);
  const { Pool } = require('pg');   // only required when DATABASE_URL is set
  const pool = new Pool({
    connectionString,
    ssl: /localhost|127\.0\.0\.1|\.railway\.internal/.test(connectionString) ? false : { rejectUnauthorized: false },
  });
  const rows = new Map();   // write-through cache; the table is the source of truth
  return {
    kind: 'postgres',
    async init() {
      await pool.query(`CREATE TABLE IF NOT EXISTS ${table} (
        id TEXT PRIMARY KEY, doc JSONB NOT NULL, status TEXT NOT NULL,
        signal_at TIMESTAMPTZ, updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
      await pool.query(`CREATE INDEX IF NOT EXISTS ${table}_status ON ${table} (status)`);
      for (const { doc } of (await pool.query(`SELECT doc FROM ${table}`)).rows) rows.set(doc.id, doc);
    },
    async all() { return [...rows.values()]; },
    async put(b) {
      rows.set(b.id, b);
      await pool.query(
        `INSERT INTO ${table} (id, doc, status, signal_at, updated_at) VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (id) DO UPDATE SET doc = EXCLUDED.doc, status = EXCLUDED.status, signal_at = EXCLUDED.signal_at, updated_at = now()`,
        [b.id, b, b.status, b.at || null]);
    },
  };
}

function createStoreFromEnv(env = process.env, { table = 'tail_signals', fileVar = 'TAIL_TRACK_FILE', file = 'tail-signals.json' } = {}) {
  if (env.DATABASE_URL) return createPgStore(env.DATABASE_URL, table);
  return createFileStore(env[fileVar] || path.join(process.env.LR_DATA_DIR || path.join(__dirname, 'data'), file));
}
const createFreshStoreFromEnv = (env = process.env) => createStoreFromEnv(env, { table: 'fresh_signals', fileVar: 'FRESH_TRACK_FILE', file: 'fresh-signals.json' });

const r2 = x => (x == null || !Number.isFinite(x) ? null : Math.round(x * 100) / 100);
const r4 = x => (x == null || !Number.isFinite(x) ? null : Math.round(x * 1e4) / 1e4);
const r6 = x => (x == null || !Number.isFinite(x) ? null : Math.round(x * 1e6) / 1e6);
const iso = ms => new Date(ms).toISOString();
const num = v => (v == null || v === '' || typeof v === 'boolean' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const inUnit = x => x > 0 && x < 1;

// Taker fee a contract at the recommended venue, when the venue doesn't say.
const KALSHI_FEE_RATE = 0.07;
function venueFee(venue, s) {
  const given = num(venue?.fee ?? venue?.feePerContract);
  if (given != null) return Math.max(0, given);
  const name = String(venue?.name || venue?.venue || '').toLowerCase();
  const p = num(venue?.price);
  if (/kalshi/.test(name) && inUnit(p)) return KALSHI_FEE_RATE * p * (1 - p);
  if (/polymarket/.test(name)) return Math.max(0, num(s?.fee) ?? 0);
  return 0;
}

// signal → stored record (null when it isn't a sized entry). With a venue,
// the follower's bet is that venue's price and units; without one, the
// Polymarket ask, the signal's units and its fee.
function toRecord(s, t = Date.now()) {
  if (!s || s.type !== 'entry' || !s.id) return null;
  let v = s.venue && typeof s.venue === 'object' && inUnit(num(s.venue.price)) ? s.venue : null;
  let entry = v ? num(v.price) : num(s.currentPrice);
  let units = v && num(v.units) != null ? num(v.units) : num(s.units);
  let fee = v ? venueFee(v, s) : Math.max(0, num(s.fee) ?? 0);
  const limit = !(units > 0) && s.limit && inUnit(num(s.limit.price)) && num(s.limit.units) > 0 ? s.limit : null;
  if (limit) {
    v = limit;
    entry = num(limit.price);
    units = num(limit.units);
    fee = Math.max(0, num(limit.fee) ?? 0);
  }
  if (!(units > 0) || !inUnit(entry)) return null;
  if (!(entry + fee < 1)) return null;
  const consensus = Array.isArray(s.consensus) ? s.consensus : [];
  return {
    id: s.id, status: 'open', result: null, recordedAt: iso(t), at: s.at || iso(t),
    wallet: s.wallet, name: s.name || null, grade: s.grade, scope: s.scope || null, category: s.category || 'other',
    market: s.market || '', eventSlug: s.eventSlug || null, conditionId: s.conditionId, asset: s.asset ?? null,
    outcome: s.outcome ?? null, outcomeIndex: s.outcomeIndex ?? null, url: s.url || null,
    theirPrice: s.theirPrice, venue: v ? String(v.name || v.venue || 'venue') : null, polyPrice: s.currentPrice ?? null,
    entry, fee: r6(fee), cost: r6(entry + fee), units, edge: s.edge ?? null, kelly: s.kelly ?? null, q: s.q ?? s.prob ?? null,
    consensus, isConsensus: s.isConsensus ?? consensus.length >= 2,
    ...(limit ? { order: 'limit', filled: false, filledAt: null, until: limit.until || s.gameStartTime || null } : {}),
    // a fresh-wallet buy: how new the wallet was (first-bet: today, one market)
    ...(s.fresh && typeof s.fresh === 'object' ? { fresh: { ageDays: num(s.fresh.ageDays), markets: num(s.fresh.markets), firstBet: !!s.fresh.firstBet } } : {}),
    // the cheapest Texas-placeable price (Kalshi, Polymarket US) when the
    // signal went out, graded on its own beside the headline venue's
    ...(s.texas && inUnit(num(s.texas.price)) && num(s.texas.price) + Math.max(0, num(s.texas.fee) ?? 0) < 1
      ? { texas: { venue: String(s.texas.name || s.texas.key || 'venue'), entry: num(s.texas.price), fee: r6(Math.max(0, num(s.texas.fee) ?? 0)), cost: r6(num(s.texas.price) + Math.max(0, num(s.texas.fee) ?? 0)) } } : {}),
    closePrice: null, closeAt: null, closeFrozen: false, profit: null, clv: null, settledAt: null,
  };
}
// what a contract cost all in (records from before fees: the entry)
const costOf = rec => (rec.cost > 0 ? rec.cost : rec.entry + (rec.fee || 0));
// CLV compares Polymarket's close with Polymarket's price when the signal
// went out, not with another venue's entry. Records without a venue entered
// at that price; a venue record with no Polymarket ask has no CLV.
const clvBase = rec => (rec.order === 'limit' ? rec.entry : inUnit(num(rec.polyPrice)) ? num(rec.polyPrice) : rec.venue ? null : rec.entry);

// ── resting bids ──
const THROUGH = 0.005;   // traded this far under the bid: the queue ahead of it filled first
const waiting = rec => rec.order === 'limit' && !rec.filled;
const tradedThrough = (rec, px) => inUnit(num(px)) && num(px) <= rec.entry - THROUGH + 1e-9;
// Pure: the event (a game's start, the market's end, orders stopping, the
// bid's own until) has come, or the market is settled. → bool
function bidOver(rec, market, t = Date.now()) {
  if (!market || market.closed || !market.active || market.acceptingOrders === false || resolutionOf(market)) return true;
  const ends = [toMs(market.gameStartTime), toMs(market.endDate), toMs(rec.until)].filter(x => x != null);
  return ends.some(x => t >= x);
}
// Pure: when the bid filled from price history ({ points: [{ t, p }] }), from
// the signal to the cut-off. → ms or null
function fillFromHistory(rec, points, cut) {
  const from = Date.parse(rec.at || rec.recordedAt);
  for (const x of points || []) {
    if (Number.isFinite(from) && x.t < from) continue;
    if (cut != null && x.t > cut) break;
    if (tradedThrough(rec, x.p)) return x.t;
  }
  return null;
}

// Pure: settle a record against its (parsed) market. → true when it changed.
function settle(rec, market, t = Date.now()) {
  const res = resolutionOf(market);
  if (!res) return false;
  if (res.void) {
    Object.assign(rec, { status: 'settled', result: 'void', profit: 0 });
    if (rec.texas) rec.texas.profit = 0;
  } else {
    const idx = outcomeIndexOf(market, rec);
    if (idx == null) return false;
    const won = idx === res.winner;
    Object.assign(rec, { status: 'settled', result: won ? 'win' : 'loss', profit: r4(won ? rec.units * (1 / costOf(rec) - 1) : -rec.units) });
    if (rec.texas?.cost > 0) rec.texas.profit = r4(won ? rec.units * (1 / rec.texas.cost - 1) : -rec.units);
  }
  const base = clvBase(rec);
  rec.clv = rec.closePrice != null && base > 0 ? r4(rec.closePrice / base - 1) : null;
  rec.settledAt = iso(t);
  return true;
}

// Pure: while the market trades, before its event, its price is the running
// close: `live` (the token's book midpoint) when given, else Gamma's last
// price unless Gamma is over an hour stale. → true when it changed.
// Like Polymarket's own display, a midpoint only counts while the spread is
// 10¢ or less (a 5¢ / 95¢ book says nothing about the price).
const OUTCOME_KNOWN = px => px >= 0.97 || px <= 0.03;
const JUMP = 0.2;
const GAMMA_STALE_MS = 3600e3;
const MAX_SPREAD = 0.1;
const midOf = book => (book && book.spread != null && book.spread <= MAX_SPREAD + 1e-9 ? book.mid : null);
function observe(rec, market, t = Date.now(), live = null) {
  if (!market || market.closed || !market.active || market.acceptingOrders === false || rec.closeFrozen) return false;
  const start = toMs(market.gameStartTime), end = toMs(market.endDate);
  if (start != null && t >= start) return false;
  if (end != null && t >= end) return false;
  const px = inUnit(num(live)) ? num(live) : market.updatedAt != null && t - market.updatedAt > GAMMA_STALE_MS ? null : priceOf(market, rec);
  if (px == null || px === rec.closePrice) return false;
  if (OUTCOME_KNOWN(px) && Math.abs(px - (rec.closePrice ?? clvBase(rec) ?? rec.entry)) >= JUMP) {
    rec.closeFrozen = true;
    return true;
  }
  rec.closePrice = px;
  rec.closeAt = iso(t);
  return true;
}

// Pure: once the close is in (the game started, or the price jumped to the
// outcome) the record's CLV is known, hours before the market resolves, so
// the record shows whether we beat the close the same day. settle() works it
// out again the same way. → true when it changed.
function closeOut(rec, market, t = Date.now()) {
  if (rec.clv != null || rec.closePrice == null || waiting(rec) || !market) return false;
  const start = toMs(market.gameStartTime);
  if (!rec.closeFrozen && !(start != null && t >= start)) return false;
  const base = clvBase(rec);
  if (!(base > 0)) return false;
  rec.clv = r4(rec.closePrice / base - 1);
  return true;
}

// Pure: a top-up record into its first bet. → the parent, changed
function merge(parent, add) {
  const units = parent.units + add.units;
  const cost = units / (parent.units / costOf(parent) + add.units / costOf(add));
  parent.entry = r4(units / (parent.units / parent.entry + add.units / add.entry));
  const pp = num(parent.polyPrice), ap = num(add.polyPrice);
  if (inUnit(pp) && inUnit(ap)) parent.polyPrice = r4(units / (parent.units / pp + add.units / ap));
  parent.cost = r6(cost);
  parent.fee = r6(Math.max(0, cost - parent.entry));
  parent.units = Math.round(units * 100) / 100;
  parent.topUps = [...(parent.topUps || []), add.id];
  return parent;
}

function groupBy(list, key) {
  const g = {};
  for (const r of list) (g[key(r)] ||= []).push(r);
  return g;
}

// One bet per game: a CS2 match that 17 wallets bought the same side of is one
// bet, not 17, and so are a game's moneyline, spread and total bought by fresh
// wallets around the same time (10-24 re-check: by eventSlug+outcome name the
// "Yes" of two different markets of one UCL game were merged while the game's
// O/U and moneyline stayed apart). Each game stakes 1u at the mean of its rows'
// per-unit result; its CLV and expected wins (the price paid) are the mean of
// theirs. t is the units' t-stat over games. 50 graded games is the bar.
const CLUSTER_TARGET = 50;
const gameKey = r => String(r.eventSlug || r.conditionId || r.market || '').replace(/-more-markets$/, '');
// Texas-placeable: the follower's price was at Kalshi or Polymarket US (not
// polymarket.com, not a sportsbook Texas doesn't have)
const TEXAS_VENUES = new Set(['Kalshi', 'Polymarket US']);
// texas: grade each row at its Texas price (rec.texas, or the headline venue
// when that was Kalshi or Polymarket US); rows with neither are left out.
const texasRow = r => (r.texas?.cost > 0 && r.texas.profit != null ? { ...r, cost: r.texas.cost, profit: r.texas.profit, venue: r.texas.venue }
  : TEXAS_VENUES.has(r.venue) ? r : null);
function clusterStats(list, { texas = false } = {}) {
  if (texas) list = list.map(texasRow).filter(Boolean);
  const m = new Map();
  for (const r of list) { const k = gameKey(r); if (!m.has(k)) m.set(k, []); m.get(k).push(r); }
  const mean = a => (a.length ? a.reduce((x, v) => x + v, 0) / a.length : null);
  const bets = [...m.values()].map(rows => {
    const g = rows.filter(r => r.result === 'win' || r.result === 'loss');
    return { rows: rows.length, profit: mean(g.map(r => (r.profit || 0) / r.units)), win: mean(g.map(r => (r.result === 'win' ? 1 : 0))),
      paid: mean(g.map(r => r.cost ?? r.entry).filter(v => v != null)), clv: mean(rows.filter(r => r.clv != null).map(r => r.clv)) };
  });
  const gr = bets.filter(b => b.profit != null), cl = bets.filter(b => b.clv != null);
  const units = gr.reduce((a, b) => a + b.profit, 0);
  const mu = gr.length ? units / gr.length : null;
  const sd = gr.length > 1 ? Math.sqrt(gr.reduce((a, b) => a + (b.profit - mu) ** 2, 0) / (gr.length - 1)) : null;
  return { rows: list.length, n: gr.length, wins: gr.filter(b => b.profit > 0).length, losses: gr.filter(b => b.profit <= 0).length,
    units: r2(units), roi: gr.length ? r4(mu) : null, t: sd > 0 ? r2(mu / (sd / Math.sqrt(gr.length))) : null,
    winShare: gr.length ? r2(gr.reduce((a, b) => a + b.win, 0)) : null, expWins: gr.length ? r2(gr.reduce((a, b) => a + (b.paid ?? 0), 0)) : null,
    avgClv: cl.length ? r4(cl.reduce((a, b) => a + b.clv, 0) / cl.length) : null,
    beatClosePct: cl.length ? r4(cl.filter(b => b.clv > 0).length / cl.length) : null, clvN: cl.length,
    target: CLUSTER_TARGET, toTarget: Math.min(1, r2(gr.length / CLUSTER_TARGET)),
    mark: gr.length ? (gr.length < CLUSTER_TARGET ? `${gr.length} of ${CLUSTER_TARGET} graded` : 'graded') : 'not graded yet' };
}

function stats(list) {
  const wins = list.filter(r => r.result === 'win').length;
  const losses = list.filter(r => r.result === 'loss').length;
  const voids = list.filter(r => r.result === 'void').length;
  const graded = list.filter(r => r.result === 'win' || r.result === 'loss');
  const staked = graded.reduce((a, r) => a + r.units, 0);
  const units = list.reduce((a, r) => a + (r.profit || 0), 0);
  const withClv = list.filter(r => r.clv != null);
  return {
    n: list.length, wins, losses, voids, staked: r2(staked), units: r2(units),
    roi: staked > 0 ? r4(units / staked) : null, winRate: graded.length ? r4(wins / graded.length) : null,
    avgClv: withClv.length ? r4(withClv.reduce((a, r) => a + r.clv, 0) / withClv.length) : null,
    beatClosePct: withClv.length ? r4(withClv.filter(r => r.clv > 0).length / withClv.length) : null,
    clvN: withClv.length,   // settled records with a close from before the event (the rest have none)
  };
}

function createTailTracker({ store = createMemoryStore(), http, now = () => Date.now(), log = console, maxLookups = 50 } = {}) {
  const ready = Promise.resolve(store.init());
  const open = new Map();      // id → record not yet settled
  const checkedAt = new Map(); // conditionId → ms of the last lookup (memory only)
  let busy = false;
  let lastCheck = null;

  const loaded = ready.then(async () => {
    for (const r of await store.all()) if (r.status === 'open') open.set(r.id, r);
  });

  const known = async id => open.has(id) || (await store.all()).some(r => r.id === id || r.topUps?.includes(id));

  // → true when the signal was new and sized
  async function record(signal) {
    await loaded;
    const rec = toRecord(signal, now());
    if (!rec || await known(rec.id)) return false;
    // a bid and a take fill differently: each stays its own record
    let parent = signal.parentId ? open.get(signal.parentId) : null;
    if (parent && (parent.order || 'take') !== (rec.order || 'take')) parent = null;
    const doc = parent ? merge(parent, rec) : rec;
    if (!parent) open.set(rec.id, rec);
    await store.put(doc).catch(e => log.warn?.(`Tail tracker: ${e.message}`));
    return true;
  }

  async function recordAll(signals) {
    let n = 0;
    for (const s of signals || []) if (await record(s)) n++;
    return n;
  }

  // One Gamma lookup per market, least recently checked first, at most
  // maxLookups per call.
  async function check() {
    await loaded;
    if (busy) return { busy: true, checked: 0, settled: 0, errors: [] };
    busy = true;
    try {
      const byMarket = new Map();
      for (const r of open.values()) {
        if (!r.conditionId) continue;
        if (!byMarket.has(r.conditionId)) byMarket.set(r.conditionId, []);
        byMarket.get(r.conditionId).push(r);
      }
      const ids = [...byMarket.keys()].sort((a, b) => (checkedAt.get(a) ?? 0) - (checkedAt.get(b) ?? 0)).slice(0, maxLookups);
      let settled = 0;
      const errors = [], writes = [];
      for (const cid of ids) {
        let market;
        try { market = await fetchMarket(http, cid); }
        catch (e) { errors.push({ conditionId: cid, message: e?.message || String(e) }); continue; }
        finally { checkedAt.set(cid, now()); }
        if (!market) continue;
        // still trading: each held token's book midpoint is its running close
        const mids = new Map();
        if (!market.closed && resolutionOf(market) == null) {
          for (const asset of new Set(byMarket.get(cid).map(r => r.asset).filter(a => a != null))) {
            try { mids.set(String(asset), midOf(await fetchBook(http, asset))); } catch { /* Gamma's price, if fresh */ }
          }
        }
        const t = now();
        for (const rec of byMarket.get(cid)) {
          if (waiting(rec)) {
            const live = mids.get(String(rec.asset)) ?? (market.updatedAt != null && t - market.updatedAt > GAMMA_STALE_MS ? null : priceOf(market, rec));
            if (!bidOver(rec, market, t)) {
              if (tradedThrough(rec, live)) Object.assign(rec, { filled: true, filledAt: iso(t) });
              observe(rec, market, t, mids.get(String(rec.asset)) ?? null);
              writes.push(store.put(rec));
              continue;
            }
            // the event came first: did it trade through the bid in between?
            const cut = Math.min(t, ...[toMs(market.gameStartTime), toMs(market.endDate), toMs(rec.until)].filter(x => x != null));
            let at = null;
            try {
              if (rec.asset == null) throw new Error('no token');
              const { points } = await fetchPriceHistory(http, rec.asset, { start: Date.parse(rec.at || rec.recordedAt), end: cut, bucketSeconds: 60 });
              at = fillFromHistory(rec, points, cut);
            } catch (e) { errors.push({ conditionId: cid, message: `bid fill: ${e?.message || e}` }); continue; }
            if (at == null) {
              Object.assign(rec, { status: 'settled', result: 'unfilled', profit: 0, settledAt: iso(t) });
              open.delete(rec.id); settled++; writes.push(store.put(rec));
              continue;
            }
            Object.assign(rec, { filled: true, filledAt: iso(at) });
          }
          if (settle(rec, market, t)) { open.delete(rec.id); settled++; writes.push(store.put(rec)); }
          else {
            const seen = observe(rec, market, t, mids.get(String(rec.asset)) ?? null);
            if (closeOut(rec, market, t) || seen) writes.push(store.put(rec));
          }
        }
      }
      await Promise.all(writes).catch(e => log.warn?.(`Tail tracker: ${e.message}`));
      lastCheck = iso(now());
      return { checked: ids.length, settled, errors };
    } finally { busy = false; }
  }

  async function filtered({ sinceDays, grade, category } = {}) {
    await loaded;
    const cut = sinceDays ? now() - sinceDays * 86400000 : 0;
    return (await store.all()).filter(r => (!grade || r.grade === grade) && (!category || r.category === category) &&
      Date.parse(r.recordedAt) >= cut);
  }

  async function summary(filter = {}) {
    const all = await filtered(filter);
    // a bid that never filled was never a bet
    const done = all.filter(r => r.status === 'settled' && r.result !== 'unfilled');
    const bids = all.filter(r => r.order === 'limit');
    const filledN = bids.filter(r => r.filled).length, unfilledN = bids.filter(r => r.result === 'unfilled').length;
    const by = key => {
      const g = {};
      for (const r of done) (g[r[key] || '—'] ||= []).push(r);
      return Object.fromEntries(Object.entries(g).map(([k, v]) => [k, stats(v)]).sort((a, b) => b[1].n - a[1].n));
    };
    // beat the close: every bet with its close in, settled or not
    const closed = all.filter(r => r.clv != null && r.result !== 'unfilled' && !waiting(r));
    return {
      open: all.filter(r => r.status !== 'settled').length, overall: stats(done), clustered: clusterStats(done.filter(r => r.result === 'win' || r.result === 'loss')),
      texas: clusterStats(done.filter(r => r.result === 'win' || r.result === 'loss'), { texas: true }),
      // first-bet wallets (recorded from v3.153.0; older rows carry no wallet age)
      firstBet: clusterStats(done.filter(r => (r.result === 'win' || r.result === 'loss') && r.fresh?.firstBet)),
      firstBetTexas: clusterStats(done.filter(r => (r.result === 'win' || r.result === 'loss') && r.fresh?.firstBet), { texas: true }),
      closing: { n: closed.length, avgClv: closed.length ? r4(closed.reduce((a, r) => a + r.clv, 0) / closed.length) : null,
        beatClosePct: closed.length ? r4(closed.filter(r => r.clv > 0).length / closed.length) : null }, byGrade: by('grade'), byCategory: by('category'),
      byConsensus: { consensus: stats(done.filter(r => r.isConsensus)), single: stats(done.filter(r => !r.isConsensus)) },
      byVenue: Object.fromEntries(Object.entries(groupBy(done, r => r.venue || 'Polymarket')).map(([k, v]) => [k, stats(v)])),
      byOrder: { take: stats(done.filter(r => r.order !== 'limit')), limit: stats(done.filter(r => r.order === 'limit')) },
      bids: { placed: bids.length, filled: filledN, unfilled: unfilledN, waiting: bids.length - filledN - unfilledN,
        fillRate: filledN + unfilledN > 0 ? r4(filledN / (filledN + unfilledN)) : null },
      lastCheck,
    };
  }

  async function list({ status, limit = 100 } = {}) {
    await loaded;
    return (await store.all()).filter(r => !status || r.status === status)
      .sort((a, b) => Date.parse(b.recordedAt) - Date.parse(a.recordedAt)).slice(0, limit);
  }

  return { record, recordAll, check, summary, list, ready: () => loaded, store, state: () => ({ open: open.size, lastCheck }) };
}

module.exports = { createTailTracker, createStoreFromEnv, createFreshStoreFromEnv, createPgStore, toRecord, settle, observe, closeOut, merge, stats, bidOver, fillFromHistory };
