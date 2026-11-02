// ─── COLD STORES: records of lanes closed for good ───────────────────────────
// A research lane that lost (the "do not propose again" list) stops recording,
// but its record stays: the counts and labels people already saw don't move.
// Its rows go to disk instead of memory. Every other store keeps its whole set
// in memory (jsonstore.js), so a closed lane's 13,000 rows cost heap for as
// long as the server ran, for a tab few people open.
//
// createDiskStore(file) speaks the store contract the trackers and the results
// backup use (init, all, put, putMany) with nothing kept between calls: all()
// reads the file, puts are coalesced into one rewrite. The trackers already
// keep only their open rows in memory, so a tracker on a disk store holds
// almost nothing. Open rows still grade (each grader puts what it changes);
// nothing new is recorded (the recorders check closed()).
//
// CLOSED: which stores are closed, since when, and the line the tab shows.
'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const CLOSED = {
  promoLegs: { at: '2026-10-28', lane: "Pick'em promos and boards", why: 'no kind beat its app\'s break-even' },
  bidArbs: { at: '2026-10-28', lane: 'Bid plans (maker bids)', why: 'maker bids filled only when about to go stale' },
  kalshiMaker: { at: '2026-10-28', lane: 'Kalshi maker bids', why: 'maker bids filled only when about to go stale' },
  xsize: { at: '2026-10-28', lane: 'Exchange game lines at size', why: 'every pregame taker play lost after fees' },
  esportsInplay: { at: '2026-10-28', lane: 'Esports in-play vs Kalshi', why: 'in-play Kalshi plays lost' },
  exchangeProps: { at: '2026-10-28', lane: 'Kalshi player props', why: 'Kalshi prop taker and maker plays lost' },
};

const closed = name => Object.prototype.hasOwnProperty.call(CLOSED, name);
// what a closed lane's endpoint adds to its answer: { at, final, note }
function closedInfo(name) {
  const c = CLOSED[name];
  if (!c) return null;
  return { at: c.at, final: true, lane: c.lane, note: `Closed ${c.at}, final: ${c.why}. Nothing new is recorded; open rows are graded once their result is in.` };
}

// One JSON array on disk (the same format as jsonstore.js, so a file either
// wrote is read by the other). key(row) defaults to the id (wallet for traders).
function createDiskStore(file, { label = 'Cold store', delayMs = 1000, key = r => r?.id ?? r?.wallet, log = console } = {}) {
  let pending = new Map();      // puts not yet on disk
  let flushing = null, next = null;
  const stats = { reads: 0, writes: 0, rows: null, bytes: null, lastError: null };

  async function read() {
    stats.reads++;
    try {
      const text = await fsp.readFile(file, 'utf8');
      const rows = JSON.parse(text);
      stats.bytes = text.length;
      return Array.isArray(rows) ? rows : [];
    } catch (e) {
      if (e.code === 'ENOENT') return [];
      stats.lastError = e.message;
      throw e;
    }
  }
  async function write(rows) {
    const tmp = `${file}.tmp`;
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(tmp, JSON.stringify(rows));
    await fsp.rename(tmp, file);
    stats.writes++;
    stats.rows = rows.length;
  }
  // every put since the last flush, merged into the file in one rewrite
  function flush() {
    if (flushing) return flushing.then(() => (pending.size ? flush() : undefined));
    if (!pending.size) return Promise.resolve();
    const batch = pending;
    pending = new Map();
    flushing = (async () => {
      try {
        const rows = await read();
        const at = new Map(rows.map((r, i) => [key(r), i]));
        for (const [k, r] of batch) { if (at.has(k)) rows[at.get(k)] = r; else { at.set(k, rows.length); rows.push(r); } }
        await write(rows);
      } catch (e) {
        stats.lastError = e.message;
        log.warn?.(`${label}: could not write ${file}: ${e.message}`);
        for (const [k, r] of batch) if (!pending.has(k)) pending.set(k, r);   // kept for the next flush
        throw e;
      } finally { flushing = null; }
    })();
    return flushing;
  }
  // puts within delayMs of each other share one rewrite
  function schedule() {
    if (!next) next = new Promise(r => setTimeout(r, delayMs)).then(() => { next = null; return flush(); });
    return next;
  }
  const store = {
    kind: 'disk',
    file,
    async init() { await fsp.mkdir(path.dirname(file), { recursive: true }); },
    // a fresh copy each call, with every put so far included
    async all() { await flush(); return read(); },
    put(r) { return store.putMany([r]); },
    putMany(list) {
      for (const r of list || []) if (r && key(r) != null) pending.set(key(r), JSON.parse(JSON.stringify(r)));
      return schedule();
    },
    flush,
    stats: () => ({ ...stats, pending: pending.size }),
  };
  return store;
}

// where the store's rows lived before (createStoreFromEnv's file), so a local
// copy carries over; on Railway the disk starts empty and the backup fills it
function diskFileFor(env = process.env, { fileVar, file }) {
  return env[fileVar] || path.join(env.LR_DATA_DIR || path.join(__dirname, 'data'), file);
}

module.exports = { CLOSED, closed, closedInfo, createDiskStore, diskFileFor };
