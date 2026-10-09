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
  return {
    kind: 'file',
    async init() {
      try { for (const b of JSON.parse(fs.readFileSync(file, 'utf8'))) rows.set(b.id, b); }
      catch (e) { if (e.code !== 'ENOENT') console.warn(`EV tracker: could not read ${file}: ${e.message}`); }
    },
    async all() { return [...rows.values()]; },
    async put(b) {
      rows.set(b.id, b);
      writing = writing.then(() => {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(`${file}.tmp`, JSON.stringify([...rows.values()]));
        fs.renameSync(`${file}.tmp`, file);
      }).catch(e => console.warn(`EV tracker: write failed: ${e.message}`));
      return writing;
    },
  };
}

function createPgStore(connectionString) {
  const { Pool } = require('pg');
  const pool = new Pool({
    connectionString,
    ssl: /localhost|127\.0\.0\.1|\.railway\.internal/.test(connectionString) ? false : { rejectUnauthorized: false },
  });
  const rows = new Map();
  return {
    kind: 'postgres',
    async init() {
      await pool.query(`CREATE TABLE IF NOT EXISTS ev_bets (
        id TEXT PRIMARY KEY, doc JSONB NOT NULL, status TEXT NOT NULL,
        start_time TIMESTAMPTZ, updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
      for (const { doc } of (await pool.query('SELECT doc FROM ev_bets')).rows) rows.set(doc.id, doc);
    },
    async all() { return [...rows.values()]; },
    async put(b) {
      rows.set(b.id, b);
      await pool.query(
        `INSERT INTO ev_bets (id, doc, status, start_time, updated_at) VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (id) DO UPDATE SET doc = EXCLUDED.doc, status = EXCLUDED.status, start_time = EXCLUDED.start_time, updated_at = now()`,
        [b.id, b, b.status, b.start || null]);
    },
  };
}

function createStoreFromEnv(env = process.env) {
  if (env.DATABASE_URL) return createPgStore(env.DATABASE_URL);
  return createFileStore(env.EV_TRACK_FILE || path.join(__dirname, 'data', 'ev-bets.json'));
}

// One bet per market side and book per game: a book dipping below the
// threshold and coming back is the same bet, logged at its first price.
const betId = r => `${r.group}|${r.side}|${r.book}`;
const marketSide = r => `${r.group}|${r.side}`;
const r2 = x => Math.round(x * 100) / 100;

function createEvTracker({ store = createMemoryStore(), minEv = 2, now = () => Date.now(), log = console } = {}) {
  const ready = store.init();
  const open = new Map();   // id → bet, for bets whose game hasn't started

  const loaded = ready.then(async () => {
    for (const b of await store.all()) if (b.status === 'open') open.set(b.id, b);
  });

  // Feed every screen here: its rows, plus the fair price of every market
  // (ev.screen's `fairs` map) so a bet keeps tracking after its edge is gone.
  async function recordBoard(rows, fairs = null) {
    await loaded;
    const t = now();
    const fairBySide = new Map();
    for (const r of rows || []) if (r.fairProb != null) fairBySide.set(marketSide(r), r.fairProb);
    if (fairs) for (const [k, v] of fairs) fairBySide.set(k, v);
    const writes = [];

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
        evAtFlag: r.ev, fairAtFlag: r.fairProb, closeFair: r.fairProb, closeAt: new Date(t).toISOString(),
      };
      open.set(id, b);
      writes.push(store.put(b));
    }

    // keep the fair price current until the game starts, then close
    for (const b of open.values()) {
      const started = b.start && Date.parse(b.start) <= t;
      if (!started) {
        const fp = fairBySide.get(marketSide(b));
        if (fp != null && fp !== b.closeFair) { b.closeFair = fp; b.closeAt = new Date(t).toISOString(); writes.push(store.put(b)); }
        continue;
      }
      b.status = 'closed';
      b.clv = r2((b.closeFair / 100) * b.decimal * 100 - 100);
      b.fairMove = r2(b.closeFair - b.fairAtFlag);   // + means the market moved toward our side
      open.delete(b.id);
      writes.push(store.put(b));
    }
    await Promise.all(writes).catch(e => log.warn?.(`EV tracker: ${e.message}`));
  }

  async function summary({ sport, book, source, sinceDays } = {}) {
    await loaded;
    const cut = sinceDays ? now() - sinceDays * 86400000 : 0;
    const all = (await store.all()).filter(b =>
      (!sport || b.sport === sport) && (!book || b.book === book) && (!source || b.source === source) &&
      Date.parse(b.flaggedAt) >= cut);
    const closed = all.filter(b => b.status === 'closed');
    const stats = list => {
      const n = list.length;
      if (!n) return { n: 0 };
      const avg = f => r2(list.reduce((a, b) => a + f(b), 0) / n);
      return { n, avgEvAtFlag: avg(b => b.evAtFlag), avgClv: avg(b => b.clv), beatClosePct: r2(100 * list.filter(b => b.clv > 0).length / n) };
    };
    const by = key => {
      const g = {};
      for (const b of closed) (g[b[key] || '—'] ||= []).push(b);
      return Object.fromEntries(Object.entries(g).map(([k, v]) => [k, stats(v)]).sort((a, b) => b[1].n - a[1].n));
    };
    return { open: all.length - closed.length, overall: stats(closed), bySport: by('sport'), byBook: by('book'), bySource: by('source'), byMarket: by('market') };
  }

  async function list({ status, limit = 100 } = {}) {
    await loaded;
    return (await store.all()).filter(b => !status || b.status === status)
      .sort((a, b) => Date.parse(b.flaggedAt) - Date.parse(a.flaggedAt)).slice(0, limit);
  }

  return { recordBoard, summary, list, ready: () => loaded, store };
}

module.exports = { createEvTracker, createMemoryStore, createFileStore, createStoreFromEnv, betId };
