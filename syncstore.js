// ─── ACCOUNT SYNC: THE SERVER SIDE ────────────────────────────────────────────
// One private document per signed-in user holding the keys acctsync.js lists
// (bets, slips, favorites, saved views, layout, alert kinds, unit size). The
// browser does the merging; the server checks each upload (only listed keys,
// size caps), applies it only on top of the revision the browser read (a
// stale write gets 409 and the current document back), and never shares a
// document with anyone but its owner.
//
// Where it lives: Postgres (table user_sync) when DATABASE_URL is set,
// otherwise a JSON file in the data folder. Railway wipes that folder on every
// deploy and this data must never go into the results backup (it is personal),
// so on Railway sync stays off until Postgres is attached. Locally, on the
// desktop app and in tests the file is fine.
//
// Turned on by AUTH_SECRET (logins that survive a restart). LR_SYNC=off turns
// it off whatever else is set.

const path = require('path');
const S = require('./acctsync');
const { createJsonFileStore } = require('./jsonstore');

const onRailway = env => !!(env.RAILWAY_ENVIRONMENT || env.RAILWAY_PROJECT_ID || env.RAILWAY_SERVICE_ID);

// → { enabled, reason, store: 'postgres'|'file'|null }
function syncConfig(env = process.env) {
  if (/^(0|off|false|no)$/i.test(env.LR_SYNC || '')) return { enabled: false, reason: 'Account sync is turned off on this server (LR_SYNC=off).', store: null };
  if (!env.AUTH_SECRET) return { enabled: false, reason: 'Sign-in is not switched on for this server yet (AUTH_SECRET is not set).', store: null };
  if (env.DATABASE_URL) return { enabled: true, reason: null, store: 'postgres' };
  if (onRailway(env)) return { enabled: false, reason: 'Account sync needs the Postgres database on this server (DATABASE_URL is not set).', store: null };
  return { enabled: true, reason: null, store: 'file' };
}

function createMemorySyncStore() {
  const rows = new Map();
  return { kind: 'memory', async init() {}, async get(id) { return rows.get(id) || null; }, async put(d) { rows.set(d.id, d); }, async remove(id) { rows.delete(id); } };
}

function createFileSyncStore(file) {
  const inner = createJsonFileStore(file, { label: 'Account sync' });
  const rows = new Map();
  let ready = null;
  return {
    kind: 'file', file,
    init() { return (ready ||= inner.init().then(async () => { for (const d of await inner.all()) rows.set(d.id, d); })); },
    async get(id) { await this.init(); return rows.get(id) || null; },
    async put(d) { await this.init(); rows.set(d.id, d); await inner.put(d); },
    async remove(id) { await this.init(); rows.delete(id); await inner.remove(id); },
    flush: () => inner.flush?.(),
  };
}

function createPgSyncStore(connectionString) {
  const { Pool } = require('pg');
  const pool = new Pool({
    connectionString,
    ssl: /localhost|127\.0\.0\.1|\.railway\.internal/.test(connectionString) ? false : { rejectUnauthorized: false },
  });
  let ready = null;
  return {
    kind: 'postgres',
    // one row per user, read on demand (documents are not all held in memory)
    init() {
      return (ready ||= pool.query(`CREATE TABLE IF NOT EXISTS user_sync (
        user_id TEXT PRIMARY KEY, doc JSONB NOT NULL, rev INTEGER NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`));
    },
    async get(id) { await this.init(); const r = await pool.query('SELECT doc FROM user_sync WHERE user_id = $1', [id]); return r.rows[0]?.doc || null; },
    async put(d) {
      await this.init();
      await pool.query(`INSERT INTO user_sync (user_id, doc, rev, updated_at) VALUES ($1, $2, $3, now())
        ON CONFLICT (user_id) DO UPDATE SET doc = EXCLUDED.doc, rev = EXCLUDED.rev, updated_at = now()`, [d.id, d, d.rev]);
    },
    async remove(id) { await this.init(); await pool.query('DELETE FROM user_sync WHERE user_id = $1', [id]); },
  };
}

function createSyncStoreFromEnv(env = process.env) {
  if (env.DATABASE_URL) return createPgSyncStore(env.DATABASE_URL);
  return createFileSyncStore(env.SYNC_FILE || path.join(env.LR_DATA_DIR || path.join(__dirname, 'data'), 'user-sync.json'));
}

const httpError = (status, message, extra) => Object.assign(new Error(message), { status }, extra || {});

// store: one of the above. Per user, uploads run one at a time (the revision
// check and the write can't interleave) and at most `maxPuts` per window.
/** @param {{ store: any, now?: () => number, maxPuts?: number, windowMs?: number }} opts */
function createSync({ store, now = () => Date.now(), maxPuts = 120, windowMs = 10 * 60e3 }) {
  const locks = new Map();      // user id → promise of the last write
  const puts = new Map();       // user id → timestamps
  const stats = { gets: 0, puts: 0, conflicts: 0, rejected: 0, lastError: null };

  const empty = id => ({ id, rev: 0, keys: {}, tomb: {}, updatedAt: null });
  const view = d => ({ rev: d.rev || 0, keys: d.keys || {}, tomb: d.tomb || {}, updatedAt: d.updatedAt || null });

  async function get(userId) {
    stats.gets++;
    return view((await store.get(userId)) || empty(userId));
  }

  async function put(userId, body = {}) {
    const t = now();
    const mine = (puts.get(userId) || []).filter(x => t - x < windowMs);
    if (mine.length >= maxPuts) { stats.rejected++; throw httpError(429, 'Too many syncs in a few minutes. It will catch up shortly.'); }
    mine.push(t); puts.set(userId, mine);
    const check = S.validateUpload(body.keys, body.tomb);
    if (!check.ok) { stats.rejected++; throw httpError(400, check.error); }
    const prev = locks.get(userId) || Promise.resolve();
    const run = prev.catch(() => {}).then(async () => {
      const doc = (await store.get(userId)) || empty(userId);
      if (Number(body.rev) !== (doc.rev || 0)) { stats.conflicts++; throw httpError(409, 'Your account changed on another device. Syncing again.', { current: view(doc) }); }
      const next = S.applyUpload(doc, { keys: body.keys || {}, tomb: body.tomb || {} }, now());
      if (S.sizeOf(next) > S.TOTAL_MAX) { stats.rejected++; throw httpError(413, 'Your synced data is over the 8 MB an account holds. Export old bets to CSV and delete them to make room.'); }
      next.id = userId;
      await store.put(next);
      stats.puts++;
      return view(next);
    });
    locks.set(userId, run);
    try { return await run; } finally { if (locks.get(userId) === run) locks.delete(userId); }
  }

  async function remove(userId) { await store.remove(userId); }

  return { get, put, remove, stats: () => ({ ...stats, store: store.kind }) };
}

module.exports = { syncConfig, createSync, createMemorySyncStore, createFileSyncStore, createPgSyncStore, createSyncStoreFromEnv, onRailway };
