// ─── JSON FILE STORE ──────────────────────────────────────────────────────────
// One JSON array on disk per record store, the whole set kept in memory.
//
// The old stores rewrote the whole file on every put(): a full JSON.stringify
// and writeFileSync of 10,000+ records, blocking the event loop each time.
// Graders and boards call `await store.put(row)` in loops, so a pass over 500
// rows meant 500 full rewrites back to back, and the site stopped answering
// for minutes after a deploy (when the backup restore and the first grading
// passes all land at once).
//
// Here put() only updates memory. Writes are coalesced: the first change
// starts a short timer, every change before it fires rides along, and one
// write covers them all. The write itself goes out in chunks of rows with an
// await between each, so no single step holds the event loop for long.
// flush() waits until everything put so far is on disk; on exit, anything
// still pending is written synchronously.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const DEFAULT_DELAY_MS = Number.isFinite(+process.env.LR_STORE_WRITE_MS) && process.env.LR_STORE_WRITE_MS !== '' ? +process.env.LR_STORE_WRITE_MS : 2000;
const CHUNK_ROWS = 400;

const live = new Set();   // stores with unwritten changes, for the exit hook
const stats = { writes: 0, rows: 0, bytes: 0, ms: 0, maxMs: 0, errors: 0, lastError: null };

let exitHooked = false;
function hookExit() {
  if (exitHooked) return;
  exitHooked = true;
  process.once('exit', () => { for (const s of live) s.flushSync(); });
}

// file: where the array lives; label: prefix for warnings; key(row): its id
function createJsonFileStore(file, { label = 'Store', delayMs = DEFAULT_DELAY_MS, key = r => r.id, chunkRows = CHUNK_ROWS } = {}) {
  const rows = new Map();
  let dirty = false, timer = null, running = null;
  let waiters = [];   // flush() calls waiting on the next completed write
  const tmp = `${file}.tmp`;

  async function writeOut() {
    const list = [...rows.values()];
    const t0 = Date.now();
    let bytes = 0;
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const fh = await fsp.open(tmp, 'w');
    try {
      await fh.write('[');
      for (let i = 0; i < list.length; i += chunkRows) {
        const part = (i ? ',' : '') + list.slice(i, i + chunkRows).map(r => JSON.stringify(r)).join(',');
        bytes += part.length;
        await fh.write(part);
      }
      await fh.write(']');
    } finally { await fh.close(); }
    await fsp.rename(tmp, file);
    const ms = Date.now() - t0;
    stats.writes++; stats.rows += list.length; stats.bytes += bytes + 2; stats.ms += ms;
    if (ms > stats.maxMs) stats.maxMs = ms;
  }

  async function run() {
    timer = null;
    if (running || !dirty) return;
    dirty = false;
    const done = waiters;
    waiters = [];
    running = writeOut().catch(e => {
      stats.errors++; stats.lastError = `${path.basename(file)}: ${e.message}`;
      console.warn(`${label}: write failed: ${e.message}`);
    });
    await running;
    running = null;
    if (dirty) arm();
    else live.delete(store);
    for (const r of done) r();
  }

  function arm() {
    if (timer || running) return;
    timer = setTimeout(run, delayMs);
    timer.unref?.();
  }

  const store = {
    kind: 'file',
    file,
    async init() {
      try {
        const arr = JSON.parse(await fsp.readFile(file, 'utf8'));
        for (const r of arr) rows.set(key(r), r);
      } catch (e) {
        if (e.code !== 'ENOENT') console.warn(`${label}: could not read ${file}: ${e.message}`);
      }
    },
    async all() { return [...rows.values()]; },
    async put(r) { return store.putMany([r]); },
    // memory now, disk on the next coalesced write
    async putMany(list) {
      for (const r of list) rows.set(key(r), r);
      dirty = true;
      live.add(store);
      hookExit();
      arm();
    },
    // resolves once every change made before the call is on disk
    async flush() {
      if (running) await running;
      if (!dirty) return;
      if (timer) { clearTimeout(timer); timer = null; }
      const p = new Promise(r => waiters.push(r));
      run();
      return p;
    },
    // exit path only: one synchronous write of whatever is pending
    flushSync() {
      if (!dirty) return;
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(tmp, JSON.stringify([...rows.values()]));
        fs.renameSync(tmp, file);
        dirty = false;
      } catch (e) { console.warn(`${label}: final write failed: ${e.message}`); }
    },
    pending() { return dirty || !!running; },
  };
  return store;
}

const flushAll = () => Promise.all([...live].map(s => s.flush()));
const storeStats = () => ({ ...stats, pending: live.size });

module.exports = { createJsonFileStore, flushAll, storeStats, DEFAULT_DELAY_MS };
