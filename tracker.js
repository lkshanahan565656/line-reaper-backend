// ─── ESPORTS PICK TRACKER ─────────────────────────────────────────────────────
// Records every pick the board signals, freezes it at match start, grades it
// from real match results, and reports hit rate / ROI / CLV. This is the proof
// a paying user wants to see, and it tells us which models deserve more weight.
//
// Lifecycle of a tracked pick:
//   (board shows side + bestEv >= TRACK_MIN_EV)  → 'open'    signal line/side saved once
//   (each board refresh until start)             → 'open'    close line/side keep updating
//   (now >= startTime)                           → 'locked'  frozen, waiting for results
//   (grader finds every map in the span)         → 'graded'  win / loss / push
//   (grader finds only part of the span)         → 'review'  needs a human call
//   (manual result or void from the API)         → 'graded' / 'void'
//
// We grade the SIGNAL (the first line/side the board recommended), because that
// is what a user would have played. CLV compares that signal line to the last
// line seen before lock.

const fs = require('fs');
const path = require('path');

// PrizePicks standard pick'em at 1.00x implies 56.22% per leg (≈ -128).
const PP_IMPLIED = 0.5622;

// ─── STORES ───────────────────────────────────────────────────────────────────
// Same tiny interface for both: all() → [pick], put(pick) → void.
// The file store is for local runs; on Railway a redeploy wipes the disk, so
// set DATABASE_URL (Railway Postgres) and the pg store is used instead.

function createMemoryStore(initial = []) {
  const rows = new Map(initial.map(p => [p.id, p]));
  return {
    kind: 'memory',
    async init() {},
    async all() { return [...rows.values()]; },
    async put(p) { rows.set(p.id, p); },
  };
}

function createFileStore(file) {
  const rows = new Map();
  let writing = Promise.resolve();
  return {
    kind: 'file',
    async init() {
      try {
        const arr = JSON.parse(fs.readFileSync(file, 'utf8'));
        for (const p of arr) rows.set(p.id, p);
      } catch (e) {
        if (e.code !== 'ENOENT') console.warn(`Tracker: could not read ${file}: ${e.message}`);
      }
    },
    async all() { return [...rows.values()]; },
    async put(p) {
      rows.set(p.id, p);
      // serialize writes; write to a temp file then rename so a crash can't truncate it
      writing = writing.then(() => {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const tmp = `${file}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify([...rows.values()]));
        fs.renameSync(tmp, file);
      }).catch(e => console.warn(`Tracker: write failed: ${e.message}`));
      return writing;
    },
  };
}

function createPgStore(connectionString) {
  const { Pool } = require('pg');   // only required when DATABASE_URL is set
  const pool = new Pool({
    connectionString,
    ssl: /localhost|127\.0\.0\.1|\.railway\.internal/.test(connectionString) ? false : { rejectUnauthorized: false },
  });
  const rows = new Map();   // write-through cache; the table is the source of truth
  return {
    kind: 'postgres',
    async init() {
      await pool.query(`CREATE TABLE IF NOT EXISTS esports_picks (
        id TEXT PRIMARY KEY,
        doc JSONB NOT NULL,
        status TEXT NOT NULL,
        start_time TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
      await pool.query('CREATE INDEX IF NOT EXISTS esports_picks_status ON esports_picks (status)');
      const r = await pool.query('SELECT doc FROM esports_picks');
      for (const { doc } of r.rows) rows.set(doc.id, doc);
    },
    async all() { return [...rows.values()]; },
    async put(p) {
      rows.set(p.id, p);
      await pool.query(
        `INSERT INTO esports_picks (id, doc, status, start_time, updated_at) VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (id) DO UPDATE SET doc = EXCLUDED.doc, status = EXCLUDED.status,
           start_time = EXCLUDED.start_time, updated_at = now()`,
        [p.id, p, p.status, p.startTime || null]);
    },
  };
}

function createStoreFromEnv(env = process.env) {
  if (env.DATABASE_URL) return createPgStore(env.DATABASE_URL);
  return createFileStore(env.TRACKER_FILE || path.join(__dirname, 'data', 'esports-picks.json'));
}

// ─── PURE HELPERS (unit-tested) ───────────────────────────────────────────────

// "1-3" → [1,2,3], "2" → [2]. Map/game numbers are 1-based.
function spanToMaps(label) {
  const m = String(label || '1').match(/^(\d+)(?:-(\d+))?$/);
  if (!m) return [1];
  const a = parseInt(m[1]), b = m[2] ? parseInt(m[2]) : a;
  const out = [];
  for (let i = a; i <= b; i++) out.push(i);
  return out;
}

function statKind(market) {
  const s = (market || '').toLowerCase();
  if (s.includes('fantasy')) return 'fantasy';
  if (s.includes('headshot') || /\bhs\b/.test(s)) return 'headshots';
  if (s.includes('assist')) return 'assists';
  return 'kills';
}

function sportKey(sport) {
  const s = (sport || '').toUpperCase();
  if (s.includes('VAL')) return 'VAL';
  if (s.includes('CS') || s.includes('COUNTER')) return 'CS';
  if (s.includes('LOL') || s.includes('LEAGUE')) return 'LOL';
  if (s.includes('DOTA')) return 'DOTA';
  if (s.includes('COD') || s.includes('CALL OF DUTY')) return 'COD';
  return s || 'OTHER';
}

// Decimal payout of one leg, so ROI is in "units per leg".
//   PP:  1 / 0.5622 ≈ 1.779 (standard pick'em leg)
//   UD:  from its implied % (already accounts for boost vs decimal regime)
function legDecimal(book, pick) {
  if (book === 'UD' && pick.udImplied) return 100 / pick.udImplied;
  return 1 / PP_IMPLIED;
}

function outcomeFor(side, line, stat) {
  if (stat == null || line == null || !side) return null;
  if (stat === line) return 'push';
  const over = stat > line;
  return (side === 'OVER') === over ? 'win' : 'loss';
}

// Positive = the market moved toward us after the signal (we beat the close).
function lineClv(side, signalLine, closeLine) {
  if (signalLine == null || closeLine == null || !side) return null;
  const d = closeLine - signalLine;
  return side === 'OVER' ? d : -d;
}

function profitFor(outcome, decimal) {
  if (outcome === 'win') return decimal - 1;
  if (outcome === 'loss') return -1;
  return 0;
}

// ─── TRACKER ──────────────────────────────────────────────────────────────────
function createTracker({
  store,
  graders = {},
  normalizeName = n => (n || '').toLowerCase().replace(/[^a-z0-9]/g, ''),
  normalizeMarket = m => (m || '').toLowerCase(),
  parseMapSpan = () => ({ count: 1, label: '1' }),
  minEv = parseFloat(process.env.TRACK_MIN_EV || '0'),
  gradeAfterMs = 2 * 3600000,      // don't look for results until 2h after start
  giveUpAfterMs = 72 * 3600000,    // after 3 days with no result, send it to review
  now = () => Date.now(),
  log = console,
} = {}) {
  if (!store) throw new Error('createTracker: store required');
  let ready = store.init();

  function pickId(p) {
    const start = p.startTime ? new Date(p.startTime).toISOString() : 'nostart';
    return `${sportKey(p.sport)}|${normalizeName(p.player)}|${normalizeMarket(p.market)}|${start}`;
  }

  // Called after every board refresh with the full pick list.
  async function recordBoard(picks) {
    await ready;
    const existing = new Map((await store.all()).map(p => [p.id, p]));
    const t = now();
    let created = 0, updated = 0;
    for (const p of picks || []) {
      if (!p || !p.player || !p.startTime) continue;
      const startMs = new Date(p.startTime).getTime();
      if (!isFinite(startMs) || startMs <= t) continue;          // started: frozen
      const id = pickId(p);
      const row = existing.get(id);
      const line = p.ppLine ?? p.udLine;
      const qualifies = p.side && p.bestEv != null && p.bestEv >= minEv && line != null;

      if (!row) {
        if (!qualifies) continue;
        const span = parseMapSpan(p.displayMarket || p.market);
        const book = p.bestBook || (p.lineSource === 'ud' ? 'UD' : 'PP');
        const signalLine = book === 'UD' && p.udLine != null ? p.udLine : line;
        await store.put({
          id, status: 'open',
          sport: sportKey(p.sport), player: p.player, team: p.team || '',
          market: p.market, displayMarket: p.displayMarket || p.market,
          stat: statKind(p.market), maps: spanToMaps(span.label),
          startTime: new Date(startMs).toISOString(),
          signalAt: new Date(t).toISOString(),
          signalSide: p.side, signalLine, signalBook: book,
          signalEv: p.bestEv, signalProb: p.prob, signalDecimal: legDecimal(book, p),
          modelPred: p.modelPred, rawPred: p.rawPred ?? null, predSource: p.predSource,
          confidence: p.confidence, sampleSize: p.sampleSize ?? null,
          context: p.context?.source || 'none', pMap: p.context?.pMap ?? null, expMaps: p.context?.expMaps ?? null,
          closeLine: signalLine, closeSide: p.side, closeEv: p.bestEv, closeAt: new Date(t).toISOString(),
          result: null, outcome: null, profit: null, clv: 0,
          gradedBy: null, gradedAt: null, note: null,
        });
        created++;
      } else if (row.status === 'open') {
        const closeLine = row.signalBook === 'UD' && p.udLine != null ? p.udLine : line;
        if (closeLine == null) continue;
        Object.assign(row, {
          closeLine, closeSide: p.side || row.closeSide, closeEv: p.bestEv ?? row.closeEv,
          closeAt: new Date(t).toISOString(),
          clv: lineClv(row.signalSide, row.signalLine, closeLine),
        });
        await store.put(row);
        updated++;
      }
    }
    return { created, updated };
  }

  // Freeze picks whose match has started.
  async function lockStarted() {
    await ready;
    const t = now();
    let locked = 0;
    for (const row of await store.all()) {
      if (row.status === 'open' && new Date(row.startTime).getTime() <= t) {
        row.status = 'locked';
        await store.put(row);
        locked++;
      }
    }
    return locked;
  }

  function applyResult(row, stat, by, note = null) {
    row.result = stat;
    row.outcome = outcomeFor(row.signalSide, row.signalLine, stat);
    row.profit = profitFor(row.outcome, row.signalDecimal);
    row.status = 'graded';
    row.gradedBy = by;
    row.gradedAt = new Date(now()).toISOString();
    row.note = note;
  }

  // Ask each sport's grader for results. A grader returns:
  //   { maps: { 1: 18, 2: 21 }, complete: bool }  — per-map stat for this player
  //   null                                         — nothing yet / unsupported
  async function gradeDue({ limit = 25 } = {}) {
    await ready;
    const t = now();
    const due = (await store.all())
      .filter(r => r.status === 'locked' && t - new Date(r.startTime).getTime() >= gradeAfterMs)
      .slice(0, limit);
    const out = { graded: 0, review: 0, waiting: 0, errors: 0 };
    for (const row of due) {
      const grader = graders[row.sport];
      const age = t - new Date(row.startTime).getTime();
      let res = null;
      if (grader && row.stat !== 'fantasy') {
        try { res = await grader(row); }
        catch (e) { out.errors++; log.warn?.(`Tracker: ${row.sport} grader failed for ${row.player}: ${e.message}`); }
      }
      if (res && res.maps) {
        const have = row.maps.filter(m => res.maps[m] != null);
        if (have.length === row.maps.length) {
          applyResult(row, row.maps.reduce((s, m) => s + res.maps[m], 0), 'auto');
          await store.put(row); out.graded++; continue;
        }
        if (res.complete) {
          // Series finished without every map in the span (e.g. Maps 1-3 in a 2-0).
          // Books differ on how they settle that, so a human decides.
          row.status = 'review';
          row.result = have.reduce((s, m) => s + res.maps[m], 0);
          row.note = `Series ended after ${have.length} of ${row.maps.length} maps in the span`;
          await store.put(row); out.review++; continue;
        }
      }
      if (age >= giveUpAfterMs) {
        row.status = 'review';
        row.note = grader ? 'No result found automatically' : `No automatic grader for ${row.sport} yet`;
        await store.put(row); out.review++;
      } else out.waiting++;
    }
    return out;
  }

  async function manualGrade(id, { result, void: isVoid, note } = {}) {
    await ready;
    const row = (await store.all()).find(r => r.id === id);
    if (!row) return null;
    if (isVoid) {
      Object.assign(row, { status: 'void', outcome: null, profit: null, gradedBy: 'manual',
        gradedAt: new Date(now()).toISOString(), note: note || 'Voided' });
    } else {
      const v = parseFloat(result);
      if (!isFinite(v)) throw new Error('result must be a number');
      applyResult(row, v, 'manual', note || null);
    }
    await store.put(row);
    return row;
  }

  async function list({ status, sport, limit = 200 } = {}) {
    await ready;
    let rows = await store.all();
    if (status) rows = rows.filter(r => r.status === status);
    if (sport) rows = rows.filter(r => r.sport === sportKey(sport));
    rows.sort((a, b) => new Date(b.startTime) - new Date(a.startTime));
    return rows.slice(0, limit);
  }

  function aggregate(rows) {
    const graded = rows.filter(r => r.status === 'graded' && r.outcome);
    const wins = graded.filter(r => r.outcome === 'win').length;
    const losses = graded.filter(r => r.outcome === 'loss').length;
    const pushes = graded.filter(r => r.outcome === 'push').length;
    const units = graded.reduce((s, r) => s + (r.profit || 0), 0);
    const withClv = rows.filter(r => r.status !== 'void' && r.clv != null && r.closeAt !== r.signalAt);
    const decided = wins + losses;
    // Breakeven hit rate for the books these picks were played at
    const be = graded.length ? graded.reduce((s, r) => s + 1 / r.signalDecimal, 0) / graded.length : null;
    return {
      picks: rows.length, graded: graded.length, wins, losses, pushes,
      hitRate: decided ? wins / decided : null,
      breakeven: be,
      units: Math.round(units * 100) / 100,
      roi: graded.length ? units / graded.length : null,
      avgEv: graded.length ? graded.reduce((s, r) => s + (r.signalEv || 0), 0) / graded.length / 100 : null,
      clvAvg: withClv.length ? withClv.reduce((s, r) => s + r.clv, 0) / withClv.length : null,
      beatClose: withClv.length ? withClv.filter(r => r.clv > 0).length / withClv.length : null,
      clvSample: withClv.length,
    };
  }

  function evBucket(ev) {
    if (ev == null) return 'n/a';
    if (ev < 3) return '0-3%';
    if (ev < 6) return '3-6%';
    if (ev < 10) return '6-10%';
    return '10%+';
  }

  async function summary({ sport, since, minEv: floor } = {}) {
    await ready;
    let rows = await store.all();
    if (sport) rows = rows.filter(r => r.sport === sportKey(sport));
    if (since) rows = rows.filter(r => new Date(r.startTime) >= new Date(since));
    if (floor != null && isFinite(floor)) rows = rows.filter(r => (r.signalEv ?? -999) >= floor);
    const groupBy = key => {
      const g = {};
      for (const r of rows) (g[key(r)] ||= []).push(r);
      return Object.fromEntries(Object.entries(g).map(([k, v]) => [k, aggregate(v)]));
    };
    return {
      overall: aggregate(rows),
      bySport: groupBy(r => r.sport),
      byStat: groupBy(r => r.stat),
      bySide: groupBy(r => r.signalSide),
      byConfidence: groupBy(r => r.confidence || 'n/a'),
      byEv: groupBy(r => evBucket(r.signalEv)),
      bySource: groupBy(r => r.predSource || 'n/a'),
      byContext: groupBy(r => r.context || 'none'),
      counts: {
        open: rows.filter(r => r.status === 'open').length,
        locked: rows.filter(r => r.status === 'locked').length,
        review: rows.filter(r => r.status === 'review').length,
        void: rows.filter(r => r.status === 'void').length,
      },
      store: store.kind,
      minEv,
    };
  }

  return { recordBoard, lockStarted, gradeDue, manualGrade, list, summary, pickId, ready: () => ready };
}

module.exports = {
  createTracker, createMemoryStore, createFileStore, createPgStore, createStoreFromEnv,
  spanToMaps, statKind, sportKey, legDecimal, outcomeFor, lineClv, profitFor, PP_IMPLIED,
};
