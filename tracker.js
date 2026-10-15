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
// line seen before lock. With fairProb (the books' consensus, esmarket.js) it
// also prices the signal ticket on the market as it stood at signal and as it
// stood at lock: line moves, payout moves and the other books all count, in
// the one unit a bettor cares about (chance our side wins, and EV at the close).

const fs = require('fs');
const path = require('path');
const { bookLines, gapOutcome } = require('./esgaps');

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
  const store = {
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
    async put(p) { return store.putMany([p]); },
    async putMany(list) {
      for (const p of list) rows.set(p.id, p);
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
  return store;
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
  return createFileStore(env.TRACKER_FILE || path.join(process.env.LR_DATA_DIR || path.join(__dirname, 'data'), 'esports-picks.json'));
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
  if (book === 'SL' && pick.sleeperMultiplier) return pick.sleeperMultiplier;
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

// Market CLV for one row: how the books' consensus chance of the SIGNAL ticket
// (same side, same line) moved from signal to close, in points, and what that
// ticket was worth at the close. A move under 0.5 points counts as no move.
const CLV_FLAT = 0.005;
function marketClv(row) {
  if (row.signalFair == null || row.closeFair == null) return null;
  const move = row.closeFair - row.signalFair;
  return {
    move,
    dir: move > CLV_FLAT ? 1 : move < -CLV_FLAT ? -1 : 0,
    closeEv: row.signalDecimal ? row.closeFair * row.signalDecimal - 1 : null,
  };
}

// The kind a pick's CLV is pooled under: sport, stat, the book it was signaled
// on and the side. Works on board picks and tracked rows alike.
function clvKind(r) {
  const book = r.signalBook || r.bestBook || (r.lineSource === 'ud' ? 'UD' : r.lineSource === 'sl' ? 'SL' : 'PP');
  return `${sportKey(r.sport)}|${r.stat || statKind(r.market)}|${book}|${r.signalSide || r.side}`;
}

// Does Pinnacle's team kill total back the pick? Its team's kills over the
// books' five players: 3%+ under backs an under, 3%+ over backs an over.
function pinTeamGroup(r) {
  if (r.pinTeam === undefined) return 'before Pinnacle team kills';
  if (r.pinTeam == null) return 'no Pinnacle team kills';
  const side = r.signalSide || r.side;
  if (Math.abs(r.pinTeam - 1) < 0.03) return 'Pinnacle in line with the books';
  return (r.pinTeam < 1) === (side === 'UNDER') ? 'Pinnacle backs the pick' : 'Pinnacle against the pick';
}

// Line-gap group of a tracked row, for the record
function gapGroup(r) {
  if (!r.signalLines) return 'before gap tracking';
  if (r.gapVs && r.gapVs.length) return 'line gap';
  const n = Object.keys(r.signalLines).length;
  return n < 2 ? 'one book only' : 'no gap';
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
  // (pick, line, side) → the books' consensus chance (0-1) that side wins at
  // that line, or null. Supplied by the server; without it only line CLV runs.
  fairProb = null,
  gradeAfterMs = 2 * 3600000,      // don't look for results until 2h after start
  giveUpAfterMs = 72 * 3600000,    // after 3 days with no result, send it to review
  now = () => Date.now(),
  log = console,
} = {}) {
  if (!store) throw new Error('createTracker: store required');
  let ready = store.init();

  // One tracked row per player/market/match. Keyed on the book's game id when
  // there is one, else on the UTC day, so a rescheduled start doesn't spawn a
  // second row. (Older rows used the exact start time; they still match by day.)
  function pickBase(p) {
    return `${sportKey(p.sport)}|${normalizeName(p.player)}|${normalizeMarket(p.market)}`;
  }
  function utcDay(startTime) {
    const ms = startTime ? new Date(startTime).getTime() : NaN;
    return isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : 'nostart';
  }
  function pickId(p) {
    if (p.gameId != null && p.gameId !== '') return `${pickBase(p)}|g:${p.gameId}`;
    return `${pickBase(p)}|d:${utcDay(p.startTime)}`;
  }
  // Existing row for this pick: same game id, or (when either side has no game
  // id) same base on the same UTC day.
  function findExisting(rows, p) {
    const base = pickBase(p), hasGid = p.gameId != null && p.gameId !== '';
    const day = utcDay(p.startTime);
    let byDay = null;
    for (const r of rows) {
      if (pickBase(r) !== base) continue;
      const rGid = r.gameId != null && r.gameId !== '';
      if (hasGid && rGid) { if (String(r.gameId) === String(p.gameId)) return r; continue; }
      if (!byDay && utcDay(r.startTime) === day) byDay = r;
    }
    return byDay;
  }

  const fairOf = (p, line, side) => {
    if (!fairProb) return null;
    try { const v = fairProb(p, line, side); return Number.isFinite(v) ? +v.toFixed(4) : null; } catch { return null; }
  };

  // Called after every board refresh with the full pick list.
  async function recordBoard(picks) {
    await ready;
    const existing = await store.all();
    const t = now();
    let created = 0, updated = 0;
    for (const p of picks || []) {
      if (!p || !p.player || !p.startTime) continue;
      const startMs = new Date(p.startTime).getTime();
      if (!isFinite(startMs) || startMs <= t) continue;          // started: frozen
      const row = findExisting(existing, p);
      const line = p.ppLine ?? p.udLine;
      const qualifies = p.side && p.bestEv != null && p.bestEv >= minEv && line != null;

      if (!row) {
        if (!qualifies) continue;
        // Settled on the book's own label ("Maps 1+2"), never a span we inferred
        const span = parseMapSpan(p.market);
        const book = p.bestBook || (p.lineSource === 'ud' ? 'UD' : 'PP');
        const signalLine = book === 'UD' && p.udLine != null ? p.udLine : book === 'SL' && p.sleeperLine != null ? p.sleeperLine : line;
        const fresh = {
          id: pickId(p), status: 'open', gameId: p.gameId ?? null,
          sport: sportKey(p.sport), player: p.player, team: p.team || '', matchTitle: p.matchTitle || '',
          market: p.market, displayMarket: p.displayMarket || p.market,
          stat: statKind(p.market), maps: spanToMaps(span.label),
          startTime: new Date(startMs).toISOString(),
          signalAt: new Date(t).toISOString(),
          signalSide: p.side, signalLine, signalBook: book,
          signalEv: p.bestEv, signalProb: p.prob, signalDecimal: legDecimal(book, p),
          // the model's probability before the record's calibration shift (escal.js)
          rawProb: p.rawProb ?? p.prob, calShift: p.calShift || 0,
          modelPred: p.modelPred, rawPred: p.rawPred ?? null, predSource: p.predSource,
          // 'market' when the books' consensus set the number (esmarket.js)
          fair: p.fairSource || null, marketPred: p.marketPred ?? null,
          confidence: p.confidence, sampleSize: p.sampleSize ?? null,
          context: p.context?.source || 'none', pMap: p.context?.pMap ?? null, expMaps: p.context?.expMaps ?? null,
          // the matchup the market price was moved by (server marketize), for its weight and record
          ctxFactor: p.matchup?.factor ?? null, matchupSrc: p.matchup?.source || null, matchupAdj: p.matchup?.adj ?? null,
          matchupPMap: p.matchup?.pMap ?? null, matchupLed: p.matchupLed != null, h2h: p.matchup?.h2h ? `${p.matchup.h2h.w}-${p.matchup.h2h.l}` : null,
          closeLine: signalLine, closeSide: p.side, closeEv: p.bestEv, closeAt: new Date(t).toISOString(),
          // the market's chance of this exact ticket at signal; closeFair follows it to lock
          signalFair: fairOf(p, signalLine, p.side), closeFair: null,
          // every book's line at signal and at the last refresh before lock, and
          // the gap when the book played sat apart from the others (esgaps.js)
          signalLines: bookLines(p), closeLines: bookLines(p),
          gapVs: p.lineGap ? p.lineGap.vs : null, gapPts: p.lineGap ? p.lineGap.pts : null, gapProbPts: p.lineGap ? p.lineGap.probPts : null,
          // Pinnacle's team kills over the books' five players (esmarket.teamKillBudget)
          pinTeam: p.pinTeam ? p.pinTeam.factor : null, pinTeamKills: p.pinTeam ? p.pinTeam.pin : null,
          result: null, outcome: null, profit: null, clv: 0,
          gradedBy: null, gradedAt: null, note: null,
          // what a record of its own wants kept beside the usual fields (esstale.js: the leading app's move)
          ...(p.trackExtra && typeof p.trackExtra === 'object' ? p.trackExtra : {}),
        };
        await store.put(fresh);
        existing.push(fresh);
        created++;
      } else if (row.status === 'open') {
        const closeLine = row.signalBook === 'UD' && p.udLine != null ? p.udLine : row.signalBook === 'SL' && p.sleeperLine != null ? p.sleeperLine : line;
        if (closeLine == null) continue;
        const closeFair = row.signalFair != null ? fairOf(p, row.signalLine, row.signalSide) : null;
        Object.assign(row, {
          ...(closeFair != null ? { closeFair } : {}),
          startTime: new Date(startMs).toISOString(),   // follow reschedules
          ...(row.gameId == null && p.gameId != null ? { gameId: p.gameId } : {}),
          ...(!row.matchTitle && p.matchTitle ? { matchTitle: p.matchTitle } : {}),
          ...(!row.team && p.team ? { team: p.team } : {}),
          closeLine, closeSide: p.side || row.closeSide, closeEv: p.bestEv ?? row.closeEv,
          closeAt: new Date(t).toISOString(),
          ...(row.signalLines ? { closeLines: bookLines(p) } : {}),
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
  //   { unavailable: 'why' }                       — the source will never have it
  //   null                                         — nothing yet / unsupported
  // Rows are tried least-recently-tried first, so a batch of rows whose stats
  // never arrive can't hold every sweep and starve the rest.
  const lastTry = new Map();   // row id → ms of the last grader call
  async function gradeDue({ limit = 25 } = {}) {
    await ready;
    const t = now();
    // Rows we can't grade only need a slot once they're due to move to review,
    // so they don't starve the sports that do have a grader.
    let parked = 0;
    const due = (await store.all())
      .filter(r => {
        const age = t - new Date(r.startTime).getTime();
        // An auto review from a partial series is asked again (hourly, for a
        // week): a source that had only some maps may have them all now.
        // A row parked for want of a grader is asked once one exists (the
        // Valorant grader backfills what sat in review before it).
        if (r.status === 'review') return (/^Series ended after/.test(r.note || '') || /^No automatic grader for /.test(r.note || ''))
          && !!graders[r.sport] && r.stat !== 'fantasy' && age < 14 * 86400e3 && t - (lastTry.get(r.id) || 0) >= 3600e3;
        if (r.status !== 'locked') return false;
        if (age < gradeAfterMs) return false;
        if ((graders[r.sport] && r.stat !== 'fantasy') || age >= giveUpAfterMs) return true;
        parked++;
        return false;
      })
      .sort((a, b) => (lastTry.get(a.id) || 0) - (lastTry.get(b.id) || 0))
      .slice(0, limit);
    const out = { graded: 0, review: 0, void: 0, waiting: parked, errors: 0 };
    for (const row of due) {
      const grader = graders[row.sport];
      const age = t - new Date(row.startTime).getTime();
      let res = null;
      if (grader && row.stat !== 'fantasy') {
        lastTry.set(row.id, now());
        try { res = await grader(row); }
        catch (e) { out.errors++; log.warn?.(`Tracker: ${row.sport} grader failed for ${row.player}: ${e.message}`); }
      }
      if (res?.unavailable) {
        voidRow(row, 'auto', res.unavailable);
        await store.put(row); out.void++; continue;
      }
      if (res && res.maps) {
        // Older rows saved an inferred span; the book settles on its label.
        const maps = spanToMaps(parseMapSpan(row.market).label);
        if (maps.join() !== (row.maps || []).join()) row.maps = maps;
        const have = maps.filter(m => res.maps[m] != null);
        if (have.length === maps.length) {
          applyResult(row, maps.reduce((s, m) => s + res.maps[m], 0), 'auto');
          await store.put(row); out.graded++; continue;
        }
        if (res.complete) {
          // Series over without every map in the span. Maps 1 and 2 are always
          // played in a Bo3, so a "Maps 1-3" line on a 2-0 counts the maps played
          // (the board prices these on expected maps played). A missing map 1
          // or 2 means a Bo1 or the wrong match: void it.
          const partial = have.reduce((s, m) => s + res.maps[m], 0);
          const missing = maps.filter(m => res.maps[m] == null);
          if (missing.every(m => m >= 3) && have.length >= 2) {
            applyResult(row, partial, 'auto', `Series ended after ${have.length} maps; graded on maps played`);
            await store.put(row); out.graded++; continue;
          }
          voidRow(row, 'auto', `Series ended after ${have.length} of ${maps.length} maps in the span`);
          row.result = partial;
          await store.put(row); out.void++; continue;
        }
      }
      if (row.status === 'review') continue;
      if (age >= giveUpAfterMs) {
        row.status = 'review';
        row.note = grader ? 'No result found automatically' : `No automatic grader for ${row.sport} yet`;
        await store.put(row); out.review++;
      } else out.waiting++;
    }
    for (const id of lastTry.keys()) if (!due.some(r => r.id === id) && t - lastTry.get(id) > giveUpAfterMs) lastTry.delete(id);
    return out;
  }

  function voidRow(row, by, note) {
    Object.assign(row, { status: 'void', outcome: null, profit: null, gradedBy: by,
      gradedAt: new Date(now()).toISOString(), note: note || 'Voided' });
  }

  async function manualGrade(id, { result, void: isVoid, note } = {}) {
    await ready;
    const row = (await store.all()).find(r => r.id === id);
    if (!row) return null;
    if (isVoid) voidRow(row, 'manual', note);
    else {
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
    // Breakeven hit rate for the books these picks were played at. A push
    // refunds the stake, so ROI and breakeven count decided picks only.
    const dec = graded.filter(r => r.outcome !== 'push');
    const be = dec.length ? dec.reduce((s, r) => s + 1 / r.signalDecimal, 0) / dec.length : null;
    return {
      picks: rows.length, graded: graded.length, wins, losses, pushes,
      hitRate: decided ? wins / decided : null,
      breakeven: be,
      units: Math.round(units * 100) / 100,
      roi: dec.length ? units / dec.length : null,
      avgEv: graded.length ? graded.reduce((s, r) => s + (r.signalEv || 0), 0) / graded.length / 100 : null,
      clvAvg: withClv.length ? withClv.reduce((s, r) => s + r.clv, 0) / withClv.length : null,
      beatClose: withClv.length ? withClv.filter(r => r.clv > 0).length / withClv.length : null,
      clvSample: withClv.length,
      ...marketClvStats(rows),
    };
  }

  // Market CLV over the rows that have it: average chance moved (points), the
  // share of moves that went our way, and the signal tickets' EV at the close.
  function marketClvStats(rows) {
    const m = rows.filter(r => r.status !== 'void' && r.closeAt !== r.signalAt).map(marketClv).filter(Boolean);
    const moved = m.filter(x => x.dir !== 0);
    const evs = m.filter(x => x.closeEv != null);
    return {
      mktClvSample: m.length,
      mktMoved: moved.length,
      mktBeat: moved.filter(x => x.dir > 0).length,
      mktBeatShare: moved.length ? moved.filter(x => x.dir > 0).length / moved.length : null,
      mktMoveAvg: m.length ? m.reduce((s, x) => s + x.move, 0) / m.length : null,
      closeEvAvg: evs.length ? evs.reduce((s, x) => s + x.closeEv, 0) / evs.length : null,
    };
  }

  // Market CLV per kind of pick (sport, stat, book, side), for the board: plays
  // of a kind whose signals keep losing the close are the ones to doubt.
  async function clvByKind() {
    await ready;
    const g = {};
    for (const r of await store.all()) {
      if (r.signalFair == null) continue;
      (g[clvKind(r)] ||= []).push(r);
    }
    return Object.fromEntries(Object.entries(g).map(([k, v]) => [k, marketClvStats(v)]));
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
      // books' consensus (esmarket.js, from v3.82.0) vs the old model price, so a
      // cutoff can be judged on picks the current pricing made
      byPricing: groupBy(r => r.fair === 'market' ? 'market' : 'model'),
      byContext: groupBy(r => r.context || 'none'),
      byBook: groupBy(r => r.signalBook || 'n/a'),
      // picks the matchup moved by 2%+ vs the rest, once matchup pricing runs
      byMatchup: groupBy(r => r.matchupLed ? 'matchup-led (no edge without it)' : r.ctxFactor == null ? (r.matchupAdj === undefined ? 'before matchup pricing' : 'no match price') : Math.abs((r.matchupAdj ?? 1) - 1) >= 0.02 ? 'matchup moved price 2%+' : 'even-ish matchup'),
      // line gaps (one book apart from the others, esgaps.js) vs books agreeing
      byGap: groupBy(gapGroup),
      byPinTeam: groupBy(pinTeamGroup),
      gapOutcomes: rows.filter(r => r.gapVs && r.status !== 'void' && r.closeAt !== r.signalAt).reduce((g, r) => { const o = gapOutcome(r); if (o) g[o] = (g[o] || 0) + 1; return g; }, {}),
      // market CLV pooled by kind (sport|stat|book|side), picks signaled since it was measured
      byKind: Object.fromEntries(Object.entries(rows.filter(r => r.signalFair != null).reduce((g, r) => ((g[clvKind(r)] ||= []).push(r), g), {})).map(([k, v]) => [k, aggregate(v)])),
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

  return { recordBoard, lockStarted, gradeDue, manualGrade, list, summary, clvByKind, pickId, graders, ready: () => ready };
}

module.exports = { pinTeamGroup,
  createTracker, createMemoryStore, createFileStore, createPgStore, createStoreFromEnv,
  spanToMaps, statKind, sportKey, legDecimal, outcomeFor, lineClv, marketClv, clvKind, gapGroup, profitFor, PP_IMPLIED,
};
