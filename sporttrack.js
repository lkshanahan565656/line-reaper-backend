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
//   grade  ESPN's box score settles it (sportgrade.js; tennis, UFC, NASCAR
//          and soccer from extragrade.js). A player who didn't play, or a
//          box that never shows him, is void after voidAfterMs.
//
// Rows: open → locked (game started) → graded | void.

const { canonName } = require('./ev');
const { gapOutcome } = require('./esgaps');

const CODE = { prizepicks: 'PP', underdog: 'UD', sleeper: 'SL', pick6: 'P6' };
const RESEARCH = new Set(['gap-odd', 'gap-stale']);
// FanDuel and BetRivers alone (no Pinnacle, no Kalshi): a lead of its own,
// never in the headline (the apps' margin against the soft books, not an edge)
const BOOK_FAIR = new Set(['book-fair', 'book-fair-single', 'book-consensus']);
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
// Underdog's multiplier is a decimal payout only when the other side doesn't
// pay under 1x; a boost past 1.35 on a lopsided line (Under 1.44x, Over 0.7x)
// pays mult / 0.5623, the regime server.js udPricing prices it in.
function udIsDecimal(m, other) {
  const o = Number(other);
  return m > UD_DECIMAL && !(o > 0 && o < 1);
}
function legDecimal(book, mult, other = null) {
  const m = Number(mult) || 1;
  if (book === 'prizepicks') return 1 / PP_IMPLIED;
  if (book === 'underdog') return udIsDecimal(m, other) ? m : m / UD_IMPLIED;
  // a Pick6 pick pays its table times its own multiplier, at the 3-pick entry
  // of the table Pick6 shows now (6x: 1.817 a leg; 5.5x since 10-24: 1.765)
  if (book === 'pick6') return m / (require('./sportprops').FIXED.pick6?.grade?.be || P6_BE);
  return m;
}

// a stale-line leg keeps its own id, so the same leg flagged on the consensus
// and as stale lands in both records
const STALE = new Set(['stale', 'stale-single', 'p6-stale', 'p6-stale-single']);
// Pinnacle's number at the flag: the row's pinX, else its "o24.5 55.3%" label
function pinLineOf(stale) {
  if (!stale) return null;
  if (Number.isFinite(stale.pinX)) return stale.pinX;
  const m = /^o(-?\d+(?:\.\d+)?)\b/.exec(stale.pinNow || stale.pinPost || '');
  return m ? Number(m[1]) : null;
}
// At the lock: a stale leg's raw close. pinExact = Pinnacle sat on the app's
// own number at the flag and at its last read inside the hour before the
// start, so closePinEv is Pinnacle's own price, no curve. Else closePinEv is null.
function pinClose(b, start) {
  const fresh = b.closePinAt != null && start - Date.parse(b.closePinAt) <= CLOSE_FRESH_MS;
  // a leg logged before signalPinLine existed reads it off its stale label
  const atFlag = b.signalPinLine ?? pinLineOf(b.stale);
  const pinExact = !!(fresh && atFlag === b.signalLine && b.closePinLine === b.signalLine && b.closePinFair != null);
  return { closePinOk: fresh, pinExact, closePinEv: pinExact ? r2((b.closePinFair * b.signalDecimal - 1) * 100) : null };
}
// a book-consensus leg too: the same leg can be a sharp or book-fair play and a consensus one
// and a three-sharps one (sharp3): the same leg can sit in the consensus record too
const THREE = new Set(['sharp3', 'p6-sharp3']);
// and a combo one (points + rebounds and the rest, off the books and Pinnacle's parts)
const COMBO = new Set(['combo', 'p6-combo']);
const OWN_ID = new Set([...STALE, 'book-consensus', 'p6-book-consensus', ...THREE, ...COMBO]);
const idOf = (row, p, kind) => `${row.sport}|${canonName(row.player)}|${row.mkey}|${p.book}|${p.side}|${p.line}|${String(row.startTime || '').slice(0, 10)}${OWN_ID.has(kind) ? `|${kind}` : ''}`;
const linesOf = row => Object.fromEntries(Object.entries(row.books || {}).map(([b, c]) => [CODE[b] || b, c.line]));

// Rows written before the fix stored a boosted Underdog leg's multiplier as its
// decimal price (1.44x paid 0.44u, closeEv about -45%). The signal's own EV says
// which regime it was priced in: (fair x m - 1) is the decimal regime, (fair x m
// / 0.5623 - 1) the boost. Where the stored EV matches the boost, the decimal is
// m / 0.5623; the close EV and a graded win's profit are redone. → the fixed
// row, or null when nothing changed.
function fixUnderdogDecimal(b) {
  if (b.book !== 'underdog' || b.udFixed || !(b.signalMult > UD_DECIMAL) || b.signalFair == null || b.signalEv == null) return null;
  if (Math.abs(b.signalDecimal - b.signalMult) > 0.001) return null;
  const dec = (b.signalFair * b.signalMult - 1) * 100, boost = (b.signalFair * b.signalMult / UD_IMPLIED - 1) * 100;
  if (!(Math.abs(b.signalEv - boost) + 0.5 < Math.abs(b.signalEv - dec))) return null;
  const fixed = { ...b, udFixed: true, signalDecimal: r4(b.signalMult / UD_IMPLIED) };
  if (b.closeFair != null && b.closeEv != null) fixed.closeEv = r2((b.closeFair * fixed.signalDecimal - 1) * 100);
  if (b.closeSharpFair != null && b.closeSharpEv != null) fixed.closeSharpEv = r2((b.closeSharpFair * fixed.signalDecimal - 1) * 100);
  if (b.status === 'graded' && b.outcome === 'win') fixed.profit = r4(fixed.signalDecimal - 1);
  return fixed;
}

function createSportTracker({ store, grader = null, now = () => Date.now(), lagMs = 2 * 60e3, voidAfterMs = 3 * 86400e3, log = console } = {}) {
  const ready = store.init();
  const open = new Map();
  const seen = new Map();   // id → last read that priced the leg (ms)
  const loaded = ready.then(async () => {
    for (const b of await store.all()) {
      const fix = fixUnderdogDecimal(b);
      if (fix) { Object.assign(b, fix); await store.put(b).catch(e => log.warn?.(`Sports record: ${e.message}`)); }
      if (b.status === 'open' || b.status === 'locked') open.set(b.id, b);
    }
  });
  const put = b => store.put(b).catch(e => log.warn?.(`Sports record: ${e.message}`));

  // rows: the props board's sports rows. flagged: [{ row, play, kind }].
  // fairAt(row, book, line) → P(over) on the other sources now, or null.
  // updated: { prizepicks: iso, ... } when each book's lines were last read.
  // sharpAt(row, line) → P(over) on a sharp price (Pinnacle or Kalshi), or
  // null: a book-fair leg keeps it as a second close when one appears
  // pinAt(row) → Pinnacle's own number on a stale leg's subject now, { x, p: P(over) },
  // or null: the raw close, kept beside the curve's (closePin*), so a stale
  // leg counts as a sharp close only where Pinnacle sat on the app's number
  // sourcesAt(row, line, kind) → { book: P(over) } at the leg's number now, or
  // null: a combo leg keeps every source's own close (closeSources, our side)
  async function record({ rows = [], flagged = [], fairAt, sharpAt = null, pinAt = null, sourcesAt = null, updated = {} } = {}) {
    await loaded;
    const t = now();
    const writes = [];
    for (const { row, play, kind } of flagged) {
      const id = idOf(row, play, kind);
      if (open.has(id)) continue;
      const start = Date.parse(row.startTime || '');
      if (!(start > t)) continue;
      // a consensus PrizePicks leg is priced at the entry it's graded on (play.decimal)
      const cell = row.books?.[play.book];
      const decimal = play.decimal ?? legDecimal(play.book, play.mult, cell ? (play.side === 'Over' ? cell.under : cell.over) : null);
      const b = {
        id, status: 'open', kind, sport: row.sport, player: row.player, team: row.team || '', matchTitle: row.matchTitle || '',
        market: row.market, mkey: row.mkey, start: row.startTime, startTime: row.startTime, rowKey: row.key,
        // a stale-line leg is logged as of the read it first showed on
        signalAt: new Date(STALE.has(kind) && play.signalAt ? Math.min(play.signalAt, t) : t).toISOString(), signalBook: CODE[play.book] || play.book, book: play.book, signalSide: play.side, signalLine: play.line,
        signalMult: play.mult, signalDecimal: r4(decimal), signalFair: play.fair == null ? null : r4(play.fair), signalEv: play.ev, sources: play.sources,
        signalLines: linesOf(row), gapVs: play.gap ? play.gap.vs.map(v => ({ book: CODE[v.book] || v.book, line: v.line })) : null,
        gapPts: play.gap?.pts ?? null, gapProbPts: play.gap?.probPts ?? null,
        ...(baseKind(kind) === 'sharp3' ? { evMin: play.evMin ?? null } : {}),
        ...(COMBO.has(kind) ? { evMin: play.evMin ?? null, comboBooks: play.books ?? null, comboParts: play.parts ?? null, comboShadow: play.shadow ?? null, entry: play.entry || null, entries: play.entries || null, spreadPts: play.spreadPts ?? null } : {}),
        ...(baseKind(kind) === 'sharp' || baseKind(kind) === 'sharp3' || BOOK_FAIR.has(baseKind(kind)) ? { entry: play.entry || null, entries: play.entries || null, spreadPts: play.spreadPts ?? null, stale: play.stale || null } : {}),
        ...(STALE.has(kind) ? { entry: play.entry || null, entries: play.entries || null, stale: play.stale || null, signalPinLine: pinLineOf(play.stale) } : {}),
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
        const cs = sourcesAt && COMBO.has(b.kind) ? sourcesAt(row, b.signalLine, b.kind) : null;
        if (cs) {
          const mine = Object.fromEntries(Object.entries(cs).map(([k, v]) => [k, r4(b.signalSide === 'Over' ? v : 1 - v)]));
          if (JSON.stringify(mine) !== JSON.stringify(b.closeSources)) { b.closeSources = mine; dirty = true; }
        }
        const pin = pinAt && STALE.has(b.kind) ? pinAt(row) : null;
        if (pin) {
          const pf = r4(b.signalSide === 'Over' ? pin.p : 1 - pin.p);
          if (pin.x !== b.closePinLine || pf !== b.closePinFair) { b.closePinLine = pin.x; b.closePinFair = pf; dirty = true; }
          if (dirty || !(t - Date.parse(b.closePinAt || 0) < SEEN_SAVE_MS)) { b.closePinAt = new Date(t).toISOString(); dirty = true; }
        }
        const sOver = sharpAt && BOOK_FAIR.has(baseKind(b.kind)) ? sharpAt(row, b.signalLine) : null;
        if (sOver != null) {
          const sf = r4(b.signalSide === 'Over' ? sOver : 1 - sOver);
          if (sf !== b.closeSharpFair) { b.closeSharpFair = sf; dirty = true; }
          b.closeSharpAt = new Date(t).toISOString();
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
      // a sharp close counts only when it was read in the last hour before the start
      if (STALE.has(b.kind)) Object.assign(b, pinClose(b, start));
      // a combo leg: each source's own close EV, and the worst of them
      if (b.closeSources && Object.keys(b.closeSources).length) { b.closeSourceEv = Object.fromEntries(Object.entries(b.closeSources).map(([k, v]) => [k, r2((v * b.signalDecimal - 1) * 100)])); b.closeEvMin = Math.min(...Object.values(b.closeSourceEv)); }
      if (b.closeSharpFair != null) { b.closeSharpOk = start - Date.parse(b.closeSharpAt) <= CLOSE_FRESH_MS; b.closeSharpEv = r2((b.closeSharpFair * b.signalDecimal - 1) * 100); }
      b.gapOutcome = gapOutcome({ gapVs: b.gapVs, signalLine: b.signalLine, signalBook: b.signalBook, closeLines: b.closeLines });
      writes.push(put(b));
    }
    await Promise.all(writes);
  }

  // Locked rows a few hours past the start go to the grader. A leg whose box
  // score had nothing yet waits retryMs before it is tried again, so a few
  // dozen stuck legs (a player the box never lists) can't use up every run's
  // budget while a Sunday's fresh legs queue behind them.
  const triedAt = new Map();
  async function grade({ afterMs = 3.5 * 3600e3, max = 60, retryMs = 30 * 60e3 } = {}) {
    await loaded;
    if (!grader) return { graded: 0 };
    const t = now();
    let graded = 0, voided = 0, tried = 0;
    for (const b of [...open.values()]) {
      if (b.status !== 'locked' || t - Date.parse(b.start) < afterMs) continue;
      // a stat no results source carries isn't tried (it would use up the
      // budget every run); it voids when the others would
      const can = !grader.canGrade || grader.canGrade(b);
      const waiting = can && t - (triedAt.get(b.id) || 0) < retryMs && t - Date.parse(b.start) <= voidAfterMs;
      if (waiting || (can && tried++ >= max)) continue;
      if (can) triedAt.set(b.id, t);
      let g = null;
      if (can) try { g = await grader.grade(b); } catch (e) { log.warn?.(`Sports grader: ${e.message}`); continue; }
      if (g && !g.pending && g.outcome) {
        Object.assign(b, { status: 'graded', result: g.result, outcome: g.outcome, eventId: g.eventId || null, gradeSource: g.source || 'espn', gradedAt: new Date(t).toISOString(),
          profit: g.outcome === 'win' ? r4(b.signalDecimal - 1) : g.outcome === 'loss' ? -1 : 0 });
        open.delete(b.id); triedAt.delete(b.id); graded++;
        await put(b);
      } else if (g?.void || t - Date.parse(b.start) > voidAfterMs) {
        // a retirement, walkover or no contest voids at once, as the apps void it
        Object.assign(b, { status: 'void', voidReason: g?.void || (!can ? 'no results source' : g?.pending ? 'never final' : 'no box score line'), gradedAt: new Date(t).toISOString() });
        open.delete(b.id); triedAt.delete(b.id); voided++;
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
      // book-fair legs: the close on Pinnacle or Kalshi, where one appeared
      sharpClosed: live.filter(b => b.closeSharpOk).length, sharpCloseEvAvg: avg(live.filter(b => b.closeSharpOk), b => b.closeSharpEv ?? 0),
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
    // research rows (gap-odd, gap-stale), the stale-line legs (stalelines.js),
    // the three-sharps legs and the book-fair legs are their own kinds, never the headline
    const all = every.filter(b => !RESEARCH.has(b.kind) && !STALE.has(b.kind) && !THREE.has(b.kind) && !COMBO.has(b.kind) && !BOOK_FAIR.has(baseKind(b.kind)));
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
  async function list({ status, kind, before, limit = 100 } = {}) {
    await loaded;
    const cut = before ? Date.parse(before) : NaN;
    return (await store.all()).filter(b => (!status || b.status === status) && (!kind || b.kind === kind) && (!Number.isFinite(cut) || Date.parse(b.signalAt) < cut)).sort((a, b) => Date.parse(b.signalAt) - Date.parse(a.signalAt)).slice(0, limit);
  }
  return { record, grade, summary, list, ready: () => loaded, store };
}

module.exports = { COMBO, THREE, pinClose, pinLineOf, BOOK_FAIR, createSportTracker, legDecimal, fixUnderdogDecimal, idOf, CODE, closeState, CLOSE_FRESH_MS };
