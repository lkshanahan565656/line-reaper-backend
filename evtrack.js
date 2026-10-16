// ─── +EV TRACK RECORD ─────────────────────────────────────────────────────────
// Proof the screener finds real edges. Every price that first shows up at
// TRACK_EV_MIN or better is logged with the price and the fair probability at
// that moment. Until the game starts we keep updating the fair probability
// from each new screen, so the last one before start is the closing fair
// price. Closing-line value then says whether the price we flagged beat where
// the sharp market finished:
//
//   CLV % = closing fair prob × decimal odds at flag − 1
//
// Positive CLV over hundreds of bets is the standard evidence an edge is real,
// and unlike win/loss it needs no results feed.

const fs = require('fs');
const path = require('path');

function createMemoryStore() {
  const rows = new Map();
  return { kind: 'memory', async init() {}, async all() { return [...rows.values()]; }, async put(b) { rows.set(b.id, b); } };
}

function createFileStore(file) {
  const rows = new Map();
  let writing = Promise.resolve();
  const store = {
    kind: 'file',
    async init() {
      try { for (const b of JSON.parse(fs.readFileSync(file, 'utf8'))) rows.set(b.id, b); }
      catch (e) { if (e.code !== 'ENOENT') console.warn(`EV tracker: could not read ${file}: ${e.message}`); }
    },
    async all() { return [...rows.values()]; },
    async put(b) { return store.putMany([b]); },
    async putMany(list) {
      for (const b of list) rows.set(b.id, b);
      writing = writing.then(() => {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(`${file}.tmp`, JSON.stringify([...rows.values()]));
        fs.renameSync(`${file}.tmp`, file);
      }).catch(e => console.warn(`EV tracker: write failed: ${e.message}`));
      return writing;
    },
  };
  return store;
}

function createPgStore(connectionString, table = 'ev_bets') {
  if (!/^[a-z_]+$/.test(table)) throw new Error(`bad table name ${table}`);
  const { Pool } = require('pg');
  const pool = new Pool({
    connectionString,
    ssl: /localhost|127\.0\.0\.1|\.railway\.internal/.test(connectionString) ? false : { rejectUnauthorized: false },
  });
  const rows = new Map();
  return {
    kind: 'postgres',
    async init() {
      await pool.query(`CREATE TABLE IF NOT EXISTS ${table} (
        id TEXT PRIMARY KEY, doc JSONB NOT NULL, status TEXT NOT NULL,
        start_time TIMESTAMPTZ, updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
      for (const { doc } of (await pool.query(`SELECT doc FROM ${table}`)).rows) rows.set(doc.id, doc);
    },
    async all() { return [...rows.values()]; },
    async put(b) {
      rows.set(b.id, b);
      await pool.query(
        `INSERT INTO ${table} (id, doc, status, start_time, updated_at) VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (id) DO UPDATE SET doc = EXCLUDED.doc, status = EXCLUDED.status, start_time = EXCLUDED.start_time, updated_at = now()`,
        [b.id, b, b.status, b.start || null]);
    },
  };
}

function createStoreFromEnv(env = process.env, { table = 'ev_bets', fileVar = 'EV_TRACK_FILE', file = 'ev-bets.json' } = {}) {
  if (env.DATABASE_URL) return createPgStore(env.DATABASE_URL, table);
  return createFileStore(env[fileVar] || path.join(process.env.LR_DATA_DIR || path.join(__dirname, 'data'), file));
}

// One bet per market side and book per game: a book dipping below the
// threshold and coming back is the same bet, logged at its first price.
const betId = r => `${r.group}|${r.side}|${r.book}`;
const marketSide = r => `${r.group}|${r.side}`;
const r2 = x => Math.round(x * 100) / 100;

// The delayed price only counts read within EXEC_WINDOW_MS of being due (2
// minutes after the flag): a price read hours later grades a different bet.
// Before 3.106.0 there was no such bound, so bets flagged before PR 117 shipped
// took their "+2 min" price at the deploy (10-14 01:37 UTC), up to 14 hours
// after the flag; load() drops those (execDropped: 'late').
const EXEC_WINDOW_MS = 3 * 60e3;
const execLate = (b, lagMs = 2 * 60e3) => b.execAt != null && Date.parse(b.execAt) - Date.parse(b.flaggedAt) > lagMs + EXEC_WINDOW_MS;

// A close only counts when the fair was still being read near the start.
// closeAt moves only when the fair changes, so a market the sharp book pulled
// hours early used to close at its last price as if nothing were wrong (10-15
// audit: 9 of 36 main-line closes and 77 of 225 alt closes last changed more
// than 30 minutes before the start, and 46 never changed after the flag).
// fairSeenAt is the last screen that priced the side (saved at most every
// SEEN_SAVE_MS, exact in memory); at the close, closeAgeMin is start minus
// that, and closeOk says it was within CLOSE_FRESH_MS.
const CLOSE_FRESH_MS = 60 * 60e3, SEEN_SAVE_MS = 10 * 60e3;
// 'ok' | 'stale' | 'unverified' (closed before fairSeenAt existed, last
// change too early to tell a pulled market from a quiet one) | null (open)
function closeState(b, freshMs = CLOSE_FRESH_MS) {
  if (b.status !== 'closed') return null;
  if (b.closeOk != null) return b.closeOk ? 'ok' : 'stale';
  const start = Date.parse(b.start || ''), seen = Date.parse(b.fairSeenAt || b.closeAt || '');
  if (!Number.isFinite(start) || !Number.isFinite(seen)) return 'unverified';
  return start - seen <= freshMs ? 'ok' : b.fairSeenAt ? 'stale' : 'unverified';
}

function createEvTracker({ store = createMemoryStore(), minEv = 2, now = () => Date.now(), log = console, closeFreshMs = CLOSE_FRESH_MS, freshCloseOnly = false } = {}) {
  const ready = store.init();
  const open = new Map();   // id → bet, for bets whose game hasn't started
  const seen = new Map();   // id → last time a screen priced its side (ms)

  const loaded = ready.then(async () => {
    const fixes = [];
    for (const b of await store.all()) {
      if (execLate(b)) {
        for (const k of ['execPrice', 'execAt', 'execClv', 'execSized', 'execSizedUsd', 'execSizedClv']) delete b[k];
        b.execDropped = 'late';
        fixes.push(store.put(b));
      }
      if (b.status === 'open') open.set(b.id, b);
    }
    await Promise.all(fixes).catch(e => log.warn?.(`EV tracker: dropping late +2 min prices: ${e.message}`));
  });

  // Feed every screen here: its rows, plus the fair price of every market
  // (ev.screen's `fairs` map) so a bet keeps tracking after its edge is gone.
  // costs (optional, bet id or market side → what the side costs now at that
  // book, fee included): the first one at least lagMs after a flag is the
  // bet's execPrice, the price a subscriber acting on the alert gets; execClv
  // grades it there. A scan landing a few seconds early still counts (slackMs).
  // sized (optional, bet id → execcheck.walkCost): what minUsd cost walking
  // the book at that same moment, the grade at real size (execSizedClv).
  async function recordBoard(rows, fairs = null, { costs = null, sized = null, lagMs = 2 * 60e3, slackMs = 15e3 } = {}) {
    await loaded;
    const t = now();
    const fairBySide = new Map();
    for (const r of rows || []) if (r.fairProb != null) fairBySide.set(marketSide(r), r.fairProb);
    if (fairs) for (const [k, v] of fairs) fairBySide.set(k, v);
    const dirty = new Set();

    // new flags
    for (const r of rows || []) {
      if (r.ev < minEv || r.dfs || !r.decimal) continue;   // DFS legs have no single price to grade
      const id = betId(r);
      if (open.has(id)) continue;
      if (r.start && Date.parse(r.start) <= t) continue;
      const b = {
        id, group: r.group, status: 'open', flaggedAt: new Date(t).toISOString(), start: r.start || null,
        sport: r.sport, event: r.event, market: r.market, player: r.player || null, point: r.point ?? null,
        side: r.side, book: r.book, price: r.price, decimal: r.decimal, source: r.source,
        evAtFlag: r.ev, fairAtFlag: r.fairProb, closeFair: r.fairProb, closeAt: new Date(t).toISOString(), fairSeenAt: new Date(t).toISOString(),
        ...(r.depthUsd != null ? { depthUsd: r.depthUsd } : {}),
        // every book's own no-vig chance of this side at the flag (sharp or not):
        // summary.bySourceClose scores each against the closing fair
        ...(r.srcP && Object.keys(r.srcP).length ? { srcP: r.srcP } : {}),
        // which contract on which venue market, so its book can be read again
        ...(r.contract ? { contract: r.contract, marketId: r.marketId ?? null, ...(r.yesSide ? { yesSide: r.yesSide } : {}) } : {}),
      };
      open.set(id, b);
      seen.set(id, t);
      dirty.add(b);
    }

    // keep the fair price current until the game starts, then close
    for (const b of open.values()) {
      const started = b.start && Date.parse(b.start) <= t;
      if (!started) {
        const age = t - Date.parse(b.flaggedAt);
        const ec = costs && b.execPrice == null && !b.execDropped && age >= lagMs - slackMs && age <= lagMs + EXEC_WINDOW_MS ? costs.get(b.id) ?? costs.get(marketSide(b)) : null;
        if (ec > 0 && ec < 1) {
          b.execPrice = ec; b.execAt = new Date(t).toISOString();
          const w = sized?.get(b.id);
          if (w && w.cost > 0 && w.cost < 1) { b.execSized = w.cost; b.execSizedUsd = w.usd; }
          dirty.add(b);
        }
        const fp = fairBySide.get(marketSide(b));
        if (fp != null) {
          seen.set(b.id, t);
          if (fp !== b.closeFair) { b.closeFair = fp; b.closeAt = b.fairSeenAt = new Date(t).toISOString(); dirty.add(b); }
          else if (!(t - Date.parse(b.fairSeenAt || b.closeAt) < SEEN_SAVE_MS)) { b.fairSeenAt = new Date(t).toISOString(); dirty.add(b); }
        }
        continue;
      }
      // the close: the last fair seen, and whether it was seen near the start
      const seenT = Math.max(seen.get(b.id) || 0, Date.parse(b.fairSeenAt || b.closeAt) || 0);
      b.fairSeenAt = new Date(seenT).toISOString();
      b.closeAgeMin = r2((Date.parse(b.start) - seenT) / 60e3);
      b.closeOk = Date.parse(b.start) - seenT <= closeFreshMs;
      seen.delete(b.id);
      b.status = 'closed';
      b.clv = r2((b.closeFair / 100) * b.decimal * 100 - 100);
      b.fairMove = r2(b.closeFair - b.fairAtFlag);
      if (b.execPrice) b.execClv = r2((b.closeFair / 100) / b.execPrice * 100 - 100);   // + means the market moved toward our side
      if (b.execSized) b.execSizedClv = r2((b.closeFair / 100) / b.execSized * 100 - 100);
      open.delete(b.id);
      dirty.add(b);
    }
    if (!dirty.size) return;
    // one write for the whole screen where the store can batch (the file store rewrites the file per put)
    await (store.putMany ? store.putMany([...dirty]) : Promise.all([...dirty].map(b => store.put(b)))).catch(e => log.warn?.(`EV tracker: ${e.message}`));
  }

  // open bets that the next recordBoard will give their delayed price: what
  // to read books for, for the grade at size
  async function dueForExec({ lagMs = 2 * 60e3, slackMs = 15e3 } = {}) {
    await loaded;
    const t = now();
    return [...open.values()].filter(b => b.execPrice == null && b.contract && !(b.start && Date.parse(b.start) <= t) && !b.execDropped && t - Date.parse(b.flaggedAt) >= lagMs - slackMs && t - Date.parse(b.flaggedAt) <= lagMs + EXEC_WINDOW_MS)
      .map(b => ({ id: b.id, venue: b.book, marketId: b.marketId, contract: b.contract, yesSide: b.yesSide }));
  }

  async function summary({ sport, book, source, sinceDays } = {}) {
    await loaded;
    const cut = sinceDays ? now() - sinceDays * 86400000 : 0;
    const all = (await store.all()).filter(b =>
      (!sport || b.sport === sport) && (!book || b.book === book) && (!source || b.source === source) &&
      Date.parse(b.flaggedAt) >= cut);
    // with freshCloseOnly (the books' records) only a close read near the
    // start grades a bet; the rest are counted apart in closeCheck
    const check = { ok: 0, stale: 0, unverified: 0 };
    for (const b of all) { const c = closeState(b, closeFreshMs); if (c) check[c]++; }
    const closed = all.filter(b => (freshCloseOnly ? closeState(b, closeFreshMs) === 'ok' : b.status === 'closed'));
    const stats = list => {
      const n = list.length;
      if (!n) return { n: 0 };
      const avg = f => r2(list.reduce((a, b) => a + f(b), 0) / n);
      // graded again at the price two minutes after the flag (execClv), where a subscriber gets in
      const ex = list.filter(b => b.execClv != null);
      // execAlertClv: the same bets graded at the alert, so the two compare like for like
      // execStillN: of those, the ones still at the flagged price or better (rounding aside)
      const exec = ex.length ? { execN: ex.length, avgExecClv: r2(ex.reduce((a, b) => a + b.execClv, 0) / ex.length), execAlertClv: r2(ex.reduce((a, b) => a + b.clv, 0) / ex.length), execBeatPct: r2(100 * ex.filter(b => b.execClv > 0).length / ex.length),
        execStillN: ex.filter(b => b.execPrice * b.decimal <= 1 + 5e-4).length } : { execN: 0 };
      const sz = list.filter(b => b.execSizedClv != null);
      if (sz.length) Object.assign(exec, { sizedN: sz.length, avgSizedClv: r2(sz.reduce((a, b) => a + b.execSizedClv, 0) / sz.length), sizedFullPct: r2(100 * sz.filter(b => b.execSizedUsd >= 99).length / sz.length) });
      return { n, avgEvAtFlag: avg(b => b.evAtFlag), avgClv: avg(b => b.clv), beatClosePct: r2(100 * list.filter(b => b.clv > 0).length / n), ...exec };
    };
    const by = key => {
      const g = {};
      for (const b of closed) (g[b[key] || '—'] ||= []).push(b);
      return Object.fromEntries(Object.entries(g).map(([k, v]) => [k, stats(v)]).sort((a, b) => b[1].n - a[1].n));
    };
    // How close each book's own no-vig chance at the flag sat to the closing
    // fair (mean squared error in points², lower = closer). Game lines have no
    // results feed here, so the close is the yardstick; the props record
    // scores sources on real outcomes (sporttrack bySource Brier).
    const src = {};
    for (const b of closed) for (const [k, p] of Object.entries(b.srcP || {})) {
      const a = (src[k] ||= { n: 0, se: 0 });
      a.n++; a.se += (p - b.closeFair) ** 2;
    }
    const bySourceClose = Object.fromEntries(Object.entries(src).map(([k, a]) => [k, { n: a.n, mse: r2(a.se / a.n) }]).sort((a, b) => b[1].n - a[1].n));
    return { open: all.filter(b => b.status === 'open').length, closeCheck: check, overall: stats(closed), bySport: by('sport'), byBook: by('book'), bySource: by('source'), byMarket: by('market'), bySourceClose };
  }

  async function list({ status, limit = 100 } = {}) {
    await loaded;
    return (await store.all()).filter(b => !status || b.status === status)
      .sort((a, b) => Date.parse(b.flaggedAt) - Date.parse(a.flaggedAt)).slice(0, limit);
  }

  return { recordBoard, dueForExec, summary, list, ready: () => loaded, store };
}

module.exports = { EXEC_WINDOW_MS, CLOSE_FRESH_MS, closeState, createEvTracker, createMemoryStore, createFileStore, createStoreFromEnv, betId };
