// ─── SPORTS PROPS RECORD ──────────────────────────────────────────────────────
// Every sports pick'em play sportprops.js flags is logged once, at the line
// and payout shown, and followed to the end:
//
//   exec   the first read of that book at least lagMs after the flag: was the
//          same line and side still up at the same payout or better? A play
//          that was gone by then was never something a subscriber could take.
//   close  until the game starts, each read keeps the books' lines and the
//          fair (the play's own: the sharp consensus for kind 'sharp', else
//          the other books, Kalshi and Pinnacle) at OUR signal line, so CLV is
//          the chance our ticket wins as the market stood at the start.
//   grade  ESPN's box score settles it (sportgrade.js). A player who didn't
//          play, or a box that never shows him, is void after voidAfterMs.
//
// Rows: open → locked (game started) → graded | void.

const { canonName } = require('./ev');
const { gapOutcome } = require('./esgaps');

const CODE = { prizepicks: 'PP', underdog: 'UD', sleeper: 'SL', pick6: 'P6' };
const RESEARCH = new Set(['gap-odd', 'gap-stale']);
const PP_IMPLIED = 0.5622, UD_IMPLIED = 0.5623, UD_DECIMAL = 1.35, P6_BE = 0.5503;
// Pick6 legs carry their own kinds (p6-sharp, p6-gap, ...): the same play, its own record
const baseKind = k => String(k || '').replace(/^p6-/, '');
const r2 = x => Math.round(x * 100) / 100;
// The close counts only when the fair was still being read near the start
// (as in evtrack.js): closeSeenAt is the last read that priced the leg, saved
// at most every SEEN_SAVE_MS (exact in memory); at the lock closeOk says it
// was within CLOSE_FRESH_MS of the start. A leg locked before closeSeenAt
// existed is 'unverified' unless its fair last changed inside that hour.
const CLOSE_FRESH_MS = 60 * 60e3, SEEN_SAVE_MS = 10 * 60e3;
function closeState(b, freshMs = CLOSE_FRESH_MS) {
  if (b.status === 'open' || b.status === 'void') return null;
  if (b.closeOk != null) return b.closeOk ? 'ok' : 'stale';
  const start = Date.parse(b.start || ''), seen = Date.parse(b.closeSeenAt || b.closeAt || '');
  if (!Number.isFinite(start) || !Number.isFinite(seen)) return 'unverified';
  return start - seen <= freshMs ? 'ok' : b.closeSeenAt ? 'stale' : 'unverified';
}
const r4 = x => Math.round(x * 1e4) / 1e4;

// What one leg pays per unit if it wins, as decimal odds: the book's own
// per-leg price (PrizePicks legs are priced at
// the 56.22% breakeven the app's EV math uses, 1.78 a leg).
function legDecimal(book, mult) {
  const m = Number(mult) || 1;
  if (book === 'prizepicks') return 1 / PP_IMPLIED;
  if (book === 'underdog') return m > UD_DECIMAL ? m : m / UD_IMPLIED;
  // a Pick6 pick pays its table times its own multiplier: at the 3-pick 6x, 1.817 a leg
  if (book === 'pick6') return m / P6_BE;
  return m;
}

// a stale-line leg keeps its own id, so the same leg flagged on the consensus
// and as stale lands in both records
const STALE = new Set(['stale', 'stale-single', 'p6-stale', 'p6-stale-single']);
const idOf = (row, p, kind) => `${row.sport}|${canonName(row.player)}|${row.mkey}|${p.book}|${p.side}|${p.line}|${String(row.startTime || '').slice(0, 10)}${STALE.has(kind) ? `|${kind}` : ''}`;
const linesOf = row => Object.fromEntries(Object.entries(row.books || {}).map(([b, c]) => [CODE[b] || b, c.line]));

function createSportTracker({ store, grader = null, now = () => Date.now(), lagMs = 2 * 60e3, voidAfterMs = 3 * 86400e3, log = console } = {}) {
  const ready = store.init();
  const open = new Map();
  const seen = new Map();   // id → last read that priced the leg (ms)
  const loaded = ready.then(async () => { for (const b of await store.all()) if (b.status === 'open' || b.status === 'locked') open.set(b.id, b); });
  const put = b => store.put(b).catch(e => log.warn?.(`Sports record: ${e.message}`));

  // rows: the props board's sports rows. flagged: [{ row, play, kind }].
  // fairAt(row, book, line) → P(over) on the other sources now, or null.
  // updated: { prizepicks: iso, ... } when each book's lines were last read.
  async function record({ rows = [], flagged = [], fairAt, updated = {} } = {}) {
    await loaded;
    const t = now();
    const writes = [];
    for (const { row, play, kind } of flagged) {
      const id = idOf(row, play, kind);
      if (open.has(id)) continue;
      const start = Date.parse(row.startTime || '');
      if (!(start > t)) continue;
      // a consensus PrizePicks leg is priced at the entry it's graded on (play.decimal)
      const decimal = play.decimal ?? legDecimal(play.book, play.mult);
      const b = {
        id, status: 'open', kind, sport: row.sport, player: row.player, team: row.team || '', matchTitle: row.matchTitle || '',
        market: row.market, mkey: row.mkey, start: row.startTime, startTime: row.startTime, rowKey: row.key,
        // a stale-line leg is logged as of the read it first showed on
        signalAt: new Date(STALE.has(kind) && play.signalAt ? Math.min(play.signalAt, t) : t).toISOString(), signalBook: CODE[play.book] || play.book, book: play.book, signalSide: play.side, signalLine: play.line,
        signalMult: play.mult, signalDecimal: r4(decimal), signalFair: play.fair == null ? null : r4(play.fair), signalEv: play.ev, sources: play.sources,
        signalLines: linesOf(row), gapVs: play.gap ? play.gap.vs.map(v => ({ book: CODE[v.book] || v.book, line: v.line })) : null,
        gapPts: play.gap?.pts ?? null, gapProbPts: play.gap?.probPts ?? null,
        ...(baseKind(kind) === 'sharp' ? { entry: play.entry || null, entries: play.entries || null, spreadPts: play.spreadPts ?? null, stale: play.stale || null } : {}),
        ...(STALE.has(kind) ? { entry: play.entry || null, entries: play.entries || null, stale: play.stale || null } : {}),
        closeFair: play.fair == null ? null : r4(play.fair), closeLines: linesOf(row), closeAt: new Date(t).toISOString(), closeSeenAt: new Date(t).toISOString(),
      };
      open.set(id, b);
      seen.set(id, t);
      writes.push(put(b));
    }
    const byKey = new Map(rows.map(r => [r.key, r]));
    for (const b of open.values()) {
      if (b.status !== 'open') continue;
      const start = Date.parse(b.start);
      // a stale-line leg whose row left the board (no app lists the player
      // now) is still checked and closed: at the next read it was gone, and
      // its close is Pinnacle's fair, which doesn't need the row
      const row = byKey.get(b.rowKey) || (STALE.has(b.kind) ? { key: b.rowKey, sport: b.sport, player: b.player, mkey: b.mkey, startTime: b.startTime, books: {} } : null);
      if (t < start) {
        if (!row) continue;
        let dirty = false;
        const cell = row.books?.[b.book];
        // the executable check, on the first fresh read of the book lagMs on
        // Pick6 reads one sport at a time, so its read is that sport's
        const read = Date.parse(updated[`${b.book}|${b.sport}`] || updated[b.book] || '');
        if (b.execOk == null && read >= Date.parse(b.signalAt) + lagMs) {
          const sideOpen = cell && (b.signalSide === 'Over' ? cell.overOpen : cell.underOpen);
          const mult = cell ? (b.signalSide === 'Over' ? cell.over : cell.under) ?? 1 : null;
          b.execOk = !!(cell && sideOpen && cell.line === b.signalLine && mult >= b.signalMult - 0.005);
          b.execAt = new Date(read).toISOString();
          b.execLine = cell?.line ?? null;
          dirty = true;
        }
        const lines = linesOf(row);
        if (JSON.stringify(lines) !== JSON.stringify(b.closeLines)) { b.closeLines = lines; dirty = true; }
        const pOver = fairAt ? fairAt(row, b.book, b.signalLine, b.kind) : null;
        if (pOver != null) {
          seen.set(b.id, t);
          const fair = r4(b.signalSide === 'Over' ? pOver : 1 - pOver);
          if (fair !== b.closeFair) { b.closeFair = fair; dirty = true; }
          if (dirty || !(t - Date.parse(b.closeSeenAt || b.closeAt) < SEEN_SAVE_MS)) { b.closeSeenAt = new Date(t).toISOString(); dirty = true; }
        }
        if (dirty) { b.closeAt = new Date(t).toISOString(); writes.push(put(b)); }
        continue;
      }
      // the game started: freeze the close
      b.status = 'locked';
      b.lockedAt = new Date(t).toISOString();
      const seenT = Math.max(seen.get(b.id) || 0, Date.parse(b.closeSeenAt || b.signalAt) || 0);
      seen.delete(b.id);
      b.closeSeenAt = new Date(seenT).toISOString();
      b.closeAgeMin = r2((start - seenT) / 60e3);
      b.closeOk = start - seenT <= CLOSE_FRESH_MS;
      // a leg no sharp source priced (a slip-log leg, sliplog.js) closes without a fair
      b.closeEv = b.closeFair == null ? null : r2((b.closeFair * b.signalDecimal - 1) * 100);
      b.fairMove = b.closeFair == null || b.signalFair == null ? null : r2((b.closeFair - b.signalFair) * 100);
      b.gapOutcome = gapOutcome({ gapVs: b.gapVs, signalLine: b.signalLine, signalBook: b.signalBook, closeLines: b.closeLines });
      writes.push(put(b));
    }
    await Promise.all(writes);
  }

  // Locked rows a few hours past the start go to the grader
  async function grade({ afterMs = 3.5 * 3600e3, max = 60 } = {}) {
    await loaded;
    if (!grader) return { graded: 0 };
    const t = now();
    let graded = 0, voided = 0, tried = 0;
    for (const b of [...open.values()]) {
      if (b.status !== 'locked' || t - Date.parse(b.start) < afterMs) continue;
      if (tried++ >= max) break;
      let g = null;
      try { g = await grader.grade(b); } catch (e) { log.warn?.(`Sports grader: ${e.message}`); continue; }
      if (g && !g.pending && g.outcome) {
        Object.assign(b, { status: 'graded', result: g.result, outcome: g.outcome, eventId: g.eventId || null, gradedAt: new Date(t).toISOString(),
          profit: g.outcome === 'win' ? r4(b.signalDecimal - 1) : g.outcome === 'loss' ? -1 : 0 });
        open.delete(b.id); graded++;
        await put(b);
      } else if (t - Date.parse(b.start) > voidAfterMs) {
        Object.assign(b, { status: 'void', voidReason: g?.pending ? 'never final' : 'no box score line', gradedAt: new Date(t).toISOString() });
        open.delete(b.id); voided++;
        await put(b);
      }
    }
    return { graded, voided };
  }

  function stats(list) {
    const execd = list.filter(b => b.execOk != null);
    const live = list.filter(b => b.status !== 'open');
    const g = list.filter(b => b.status === 'graded' && b.outcome !== 'push');
    const wins = g.filter(b => b.outcome === 'win').length;
    const units = g.reduce((a, b) => a + (b.profit || 0), 0);
    const exec = g.filter(b => b.execOk === true);
    const avg = (l, f) => (l.length ? r2(l.reduce((a, b) => a + f(b), 0) / l.length) : null);
    return {
      signals: list.length, open: list.filter(b => b.status === 'open').length,
      execChecked: execd.length, execShare: execd.length ? r2(execd.filter(b => b.execOk).length / execd.length) : null,
      closed: live.length, closeEvAvg: avg(live, b => b.closeEv ?? 0), fairMoveAvg: avg(live, b => b.fairMove ?? 0),
      movedOurWay: live.filter(b => b.fairMove > 0.5).length, movedAgainst: live.filter(b => b.fairMove < -0.5).length,
      graded: g.length, wins, losses: g.length - wins, hitRate: g.length ? r4(wins / g.length) : null,
      breakeven: g.length ? r4(g.length / g.reduce((a, b) => a + b.signalDecimal, 0)) : null,
      units: r2(units), roi: g.length ? r4(units / g.length) : null, avgEv: avg(list, b => b.signalEv),
      // close EV on the legs still up at the next read: the executable grade before results
      execClosed: live.filter(b => b.execOk === true).length, execCloseEvAvg: avg(live.filter(b => b.execOk === true), b => b.closeEv ?? 0),
      // the record that counts: only plays still up at the next read
      execGraded: exec.length, execUnits: r2(exec.reduce((a, b) => a + (b.profit || 0), 0)), execRoi: exec.length ? r4(exec.reduce((a, b) => a + (b.profit || 0), 0) / exec.length) : null,
      gapOutcomes: list.reduce((a, b) => { if (b.gapOutcome) a[b.gapOutcome] = (a[b.gapOutcome] || 0) + 1; return a; }, {}),
    };
  }
  // How sharp each source proves: the Brier score of its own chance of our
  // side at our line (sources[].at, at the signal) on graded consensus legs,
  // next to the consensus's own. Lower is sharper; these set the weights.
  function sourceScores(list) {
    const g = list.filter(b => b.kind === 'sharp' && b.status === 'graded' && (b.outcome === 'win' || b.outcome === 'loss'));
    const acc = {};
    const add = (k, p, y) => { const a = (acc[k] ||= { n: 0, brier: 0 }); a.n++; a.brier += (p - y) ** 2; };
    for (const b of g) {
      const y = b.outcome === 'win' ? 1 : 0;
      add('consensus', b.signalFair, y);
      for (const x of b.sources || []) if (x.at != null) add(x.book, b.signalSide === 'Over' ? x.at / 100 : 1 - x.at / 100, y);
    }
    return Object.fromEntries(Object.entries(acc).map(([k, a]) => [k, { n: a.n, brier: r4(a.brier / a.n) }]));
  }
  async function summary({ sinceDays } = {}) {
    await loaded;
    const cut = sinceDays ? now() - sinceDays * 86400e3 : 0;
    const every = (await store.all()).filter(b => b.status !== 'void' && Date.parse(b.signalAt) >= cut);
    // research rows (gap-odd, gap-stale) and the stale-line legs (stalelines.js)
    // are their own kinds, never the headline
    const all = every.filter(b => !RESEARCH.has(b.kind) && !STALE.has(b.kind));
    const by = f => {
      const m = {};
      for (const b of all) (m[f(b)] ||= []).push(b);
      return Object.fromEntries(Object.entries(m).map(([k, l]) => [k, stats(l)]).sort((a, b) => b[1].signals - a[1].signals));
    };
    const byKind = {};
    for (const b of every) (byKind[b.kind] ||= []).push(b);
    return { overall: stats(all), bySource: sourceScores(all), byStale: by(b => (b.kind !== 'sharp' ? 'other' : b.stale ? 'stale' : 'fresh')), byKind: Object.fromEntries(Object.entries(byKind).map(([k, l]) => [k, stats(l)])), bySport: by(b => b.sport), byBook: by(b => b.signalBook), byStat: by(b => `${b.sport} ${b.mkey}`),
      voided: (await store.all()).filter(b => b.status === 'void').length };
  }
  async function list({ status, limit = 100 } = {}) {
    await loaded;
    return (await store.all()).filter(b => !status || b.status === status).sort((a, b) => Date.parse(b.signalAt) - Date.parse(a.signalAt)).slice(0, limit);
  }
  return { record, grade, summary, list, ready: () => loaded, store };
}

module.exports = { createSportTracker, legDecimal, idOf, CODE, closeState, CLOSE_FRESH_MS };
