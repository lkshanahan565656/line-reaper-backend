// ─── THE PROP CLOSE BOOK: PINNACLE'S AND KALSHI'S LAST NUMBER ON EVERY PROP ───
// MY SLIPS grades a user's legs against the close. A leg logged before the
// start is followed by the slip log (sliplog.js); one logged after the start,
// or imported later from Pikkit, used to have no close at all ("no line
// history"). This keeps the close for every sports prop the board saw a sharp
// price on, whether or not anyone had logged it yet:
//
//   observe   after each props board read: every sports row starting later
//             keeps, in memory, Pinnacle's own lines and no-vig P(over) (raw,
//             never a consensus) and Kalshi's ladder, and when it was read
//   close     the first read after the start freezes the last numbers into
//             the day's page: closeOk when that last read was within the
//             hour before the start (the records' rule, CLOSE_FRESH_MS)
//   find      a leg (sport, player, stat, when it was bet) → its prop's close
//   fairAt    Pinnacle's P(our side) at the leg's own line: exact when
//             Pinnacle hung that number, else read along the stat's curve
//             from Pinnacle's nearest line (marked, not exact); Kalshi's the
//             same way when Pinnacle had nothing
//
// A prop is the same for everyone: the book holds props, never people. One
// stored document per game day (`pc-2026-10-25`), kept KEEP_DAYS days, then
// written back empty so the store and the results backup stay small.

const { canonName } = require('./ev');
const { consensusFor, CONSENSUS } = require('./sportprops');

const CLOSE_FRESH_MS = 60 * 60e3;
const KEEP_DAYS = 14;
const SAVE_MS = 5 * 60e3;
const r4 = x => Math.round(x * 1e4) / 1e4;
// a game's day in US Eastern, so a 9pm ET game sits on its own date
const dayOf = t => new Date(t - 4 * 3600e3).toISOString().slice(0, 10);
const keyOf = (sport, player, mkey, start) => `${sport}|${canonName(player)}|${mkey}|${start}`;
const lastName = n => canonName(String(n || '').trim().split(/\s+/).pop());

// Pinnacle alone (or Kalshi alone) read at a line: the consensus math with one source
const PIN_ONLY = { ...CONSENSUS, weights: { pinnacle: 1 }, shadow: [], minSources: 1 };
const KAL_ONLY = { ...CONSENSUS, weights: { kalshi: 1 }, shadow: [], minSources: 1 };

// entry: a closed prop → P(over) at `line` on one source, { pOver, line (the
// source's own), exact } or null
function sourceAt(entry, line, which) {
  const row = { sport: entry.sport, mkey: entry.mkey };
  if (which === 'pinnacle') {
    const qs = (entry.pin || []).map(([l, p]) => ({ book: 'pinnacle', line: l, pOver: p }));
    if (!qs.length) return null;
    const exact = qs.find(q => q.line === line);
    if (exact) return { pOver: exact.pOver, line, exact: true };
    const f = consensusFor(row, line, { sharp: qs, o: PIN_ONLY });
    return f ? { pOver: r4(f.p), line: f.sources?.[0]?.line ?? null, exact: false } : null;
  }
  const kal = new Map((entry.kal || []).map(([l, p]) => [l, p]));
  if (!kal.size) return null;
  if (kal.has(line)) return { pOver: kal.get(line), line, exact: true };
  const f = consensusFor(row, line, { kalshi: kal, o: KAL_ONLY });
  return f ? { pOver: r4(f.p), line: f.sources?.[0]?.line ?? null, exact: false } : null;
}

// entry + the leg's line and side → { source, fair (P of the leg's side), line, exact, ok } or null
function fairAt(entry, line, side) {
  if (!entry) return null;
  for (const src of ['pinnacle', 'kalshi']) {
    const s = sourceAt(entry, line, src);
    if (s) return { source: src, fair: r4(side === 'Under' ? 1 - s.pOver : s.pOver), line: s.line, exact: s.exact, ok: entry.closeOk, ageMin: entry.ageMin };
  }
  return null;
}

// store: { init, all, put } (evtrack's file or Postgres store). quotes(row) →
// { pin: [{ line, pOver }], kal: Map(line → P(over)) } for a board row.
function createPropCloseBook({ store, now = () => Date.now(), keepDays = KEEP_DAYS, log = console } = {}) {
  const live = new Map();     // key → the prop's latest numbers, until its start
  const days = new Map();     // 'YYYY-MM-DD' → { id, day, props: { key: entry } }
  const dirty = new Set();
  let lastSave = 0;
  const loaded = (async () => {
    if (store.init) await store.init();
    for (const d of await store.all()) if (d?.day && d.props) days.set(d.day, d);
  })().catch(e => log.warn?.(`Prop close book: load failed: ${e.message}`));

  // rows: the props board's sports rows; quotes(row) as above
  async function observe(rows, quotes) {
    await loaded;
    const t = now();
    let added = 0, closed = 0, i = 0;
    for (const r of rows || []) {
      // a big board in slices, so requests get in between
      if (++i % 1500 === 0) await new Promise(res => setImmediate(res));
      if (r.esports || !r.mkey || !r.player) continue;
      const start = Date.parse(r.startTime || '');
      if (!(start > t)) continue;
      const q = quotes(r);
      const pin = (q?.pin || []).filter(x => x.pOver > 0 && x.pOver < 1).map(x => [x.line, r4(x.pOver)]);
      const kal = [...(q?.kal || new Map())].filter(([, p]) => p > 0 && p < 1).map(([l, p]) => [l, r4(p)]);
      if (!pin.length && !kal.length) continue;
      const k = keyOf(r.sport, r.player, r.mkey, r.startTime);
      if (!live.has(k)) added++;
      const apps = {};
      for (const [b, c] of Object.entries(r.books || {})) if (c?.line != null) apps[b] = c.line;
      live.set(k, { sport: r.sport, player: r.player, team: r.team || '', matchTitle: r.matchTitle || '', market: r.market, mkey: r.mkey, start: r.startTime, pin, kal, apps, seenAt: new Date(t).toISOString() });
    }
    // started: freeze the last numbers on the game's day
    for (const [k, e] of live) {
      const start = Date.parse(e.start);
      if (start > t) continue;
      live.delete(k);
      const ageMin = Math.round((start - Date.parse(e.seenAt)) / 6e4);
      const day = dayOf(start);
      const d = days.get(day) || { id: `pc-${day}`, day, props: {} };
      d.props[k] = { ...e, ageMin, closeOk: start - Date.parse(e.seenAt) <= CLOSE_FRESH_MS };
      days.set(day, d);
      dirty.add(day);
      closed++;
    }
    await save();
    return { live: live.size, added, closed };
  }

  // days past keepDays are written back empty (the store has no delete)
  async function save(force = false) {
    const t = now();
    const cut = dayOf(t - keepDays * 86400e3);
    for (const [day, d] of days) if (day < cut && Object.keys(d.props).length) { d.props = {}; d.pruned = true; dirty.add(day); }
    if (!dirty.size || (!force && t - lastSave < SAVE_MS)) return;
    lastSave = t;
    const list = [...dirty];
    dirty.clear();
    for (const day of list) { const d = days.get(day); if (d) await store.put({ ...d, status: 'day', start: `${day}T12:00:00Z` }).catch(e => log.warn?.(`Prop close book: save failed: ${e.message}`)); }
  }

  // leg { sport?, player, mkey, betAt (ms), start? (ms, when known) } → a
  // closed entry or null. The game: the player's first prop on that stat from
  // 18 hours before the bet (a slip typed in after the start) to 7 days after.
  // A leg with a known start takes the prop within 3 hours of it.
  function find(leg) {
    const name = canonName(leg.player);
    const words = String(leg.player || '').trim().split(/\s+/);
    const first = words.length > 1 ? words[0].replace(/\.$/, '') : '';
    const t = leg.betAt || now();
    const lo = leg.start ? leg.start - 3 * 3600e3 : t - 18 * 3600e3, hi = leg.start ? leg.start + 3 * 3600e3 : t + 7 * 86400e3;
    const hits = [];
    for (const [day, d] of days) {
      if (day < dayOf(lo - 86400e3) || day > dayOf(hi + 86400e3)) continue;
      for (const e of Object.values(d.props)) {
        if (e.mkey !== leg.mkey || (leg.sport && e.sport !== leg.sport)) continue;
        const s = Date.parse(e.start);
        if (s < lo || s > hi) continue;
        const n = canonName(e.player);
        // "J. Allen" or "Allen": the last name, and the first initial when given
        const near = n === name || (first.length <= 1 && lastName(e.player) === lastName(leg.player) && (!first || n.startsWith(canonName(first))));
        if (near) hits.push({ e, exact: n === name });
      }
    }
    if (!hits.length) return null;
    const exact = hits.filter(h => h.exact);
    const pool = exact.length ? exact : hits;
    // a short name that fits two players finds neither
    if (!exact.length && new Set(pool.map(h => canonName(h.e.player))).size > 1) return null;
    // the first game from the bet on; a slip typed after the start takes the latest before it
    const after = pool.filter(h => Date.parse(h.e.start) >= t - 3600e3).sort((a, b) => Date.parse(a.e.start) - Date.parse(b.e.start));
    const before = pool.filter(h => Date.parse(h.e.start) < t - 3600e3).sort((a, b) => Date.parse(b.e.start) - Date.parse(a.e.start));
    return (leg.start ? pool.sort((a, b) => Math.abs(Date.parse(a.e.start) - leg.start) - Math.abs(Date.parse(b.e.start) - leg.start))[0] : after[0] || before[0])?.e || null;
  }

  // a prop still ahead (the live map), for a leg the slip log is following
  const findLive = (sport, player, mkey, start) => live.get(keyOf(sport, player, mkey, start)) || null;
  // a closed prop by its exact subject
  const get = (sport, player, mkey, start) => {
    const t = Date.parse(start || '');
    return Number.isFinite(t) ? days.get(dayOf(t))?.props[keyOf(sport, player, mkey, start)] || null : null;
  };

  function status() {
    const counts = {};
    for (const [day, d] of days) { const n = Object.keys(d.props).length; if (n) counts[day] = n; }
    return { live: live.size, days: counts, keepDays };
  }
  return { observe, find, findLive, get, save, status, ready: () => loaded };
}

module.exports = { createPropCloseBook, fairAt, sourceAt, dayOf, keyOf, CLOSE_FRESH_MS, KEEP_DAYS };
