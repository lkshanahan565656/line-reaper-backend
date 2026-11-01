// ─── PICK'EM STALE AT PINNACLE'S OWN NUMBER: THE DAILY CHECK ─────────────────
// One kind is still standing after the 10-24 re-checks: an app leg left on the
// number Pinnacle just moved away from, where Pinnacle's own line IS the app's
// line, at the flag and at its last read before the start. Its close is
// Pinnacle's raw price there, with no curve in between (sporttrack pinClose).
//
// The 10-24 backfit (116 PrizePicks legs, 67-49, +5.8u, Unders 51-33) was
// found by looking at old data, so it proves nothing. This report keeps it
// apart and judges only legs on games that started after it (LIVE_START_FROM):
//
//   added     stale legs at Pinnacle's number at the flag, by US day of the game
//   graded    of those, legs whose close was still Pinnacle's own price at the
//             app's number (pinExact) with an ESPN result
//   left      legs Pinnacle moved off before the start (or stopped reading):
//             no raw close, so not graded, but their results are shown so a
//             filter that drops the losers can't hide
//   win rate  against each leg's own break-even (1 / its per-leg decimal: the
//             3-pick Power 55.03% on PrizePicks, the leg's payout on the
//             others) and against the 55% bar
//   CLV       Pinnacle's raw close at the app's number, with its t
//   close z   wins against what Pinnacle's close expected (1.5 sd under fails)
//
// One leg per player stat per app per game (the same leg flagged confirmed and
// Pinnacle-only is one bet), as the close scoreboard counts it. Each app is
// judged on its own; Unders and Overs are the split fixed before the live
// legs came in. Pure: the server passes the props record.

const { pinLineOf } = require('./sporttrack');
const { legCluster, propsVenue } = require('./closeboard');

const TARGET = 50;
const BAR = 0.55;
// games starting after the backfit's last graded game (10-24 02:30Z)
const LIVE_START_FROM = '2026-10-24T06:00:00Z';
const STALE = new Set(['stale', 'stale-single', 'p6-stale', 'p6-stale-single']);
// The 10-24 re-check (checks/ppstale-recheck-2026-10-24, pp-stale-legs-full.csv):
// legs whose pinPost label sat on the app's line, graded from ESPN box scores.
// The close was never Pinnacle's raw number, so these are leads only.
const BACKFIT = {
  games: '2026-10-15 to 2026-10-24',
  note: 'Found after looking at the data, close read off our curve where Pinnacle moved again: a lead, not proof.',
  books: {
    prizepicks: { n: 116, w: 67, l: 49, units: 5.8, be: 0.5503, Under: { w: 51, l: 33, units: 8.7 }, Over: { w: 16, l: 16, units: -2.9 } },
    underdog: { n: 29, w: 15, l: 14, Under: { w: 9, l: 7 }, Over: { w: 6, l: 7 } },
    sleeper: { n: 8, w: 4, l: 4, Under: { w: 3, l: 1 }, Over: { w: 1, l: 3 } },
  },
};

const { r1OrNull: r1, r2OrNull: r2 } = require('./mathutil');
const mean = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
// the game's day on the US clock, as the apps list it
const usDay = t => { const x = Date.parse(t || ''); return Number.isFinite(x) ? new Date(x - 6 * 3600e3).toISOString().slice(0, 10) : ''; };

// a leg flagged with Pinnacle's own number on the app's line
const atFlag = b => (b.signalPinLine ?? pinLineOf(b.stale)) === b.signalLine;
const won = b => b.status === 'graded' && (b.outcome === 'win' || b.outcome === 'loss');
// open (game not started), exact (raw close at the app's number), left (no raw close), void
function stateOf(b) {
  if (b.status === 'void') return 'void';
  if (b.status === 'open') return 'open';
  return b.pinExact === true ? 'exact' : 'left';
}

// graded legs → the numbers a verdict needs
function stats(legs) {
  const g = legs.filter(won);
  const w = g.filter(b => b.outcome === 'win').length, n = g.length;
  const be = mean(g.map(b => 1 / b.signalDecimal));
  const units = g.reduce((s, b) => s + (b.outcome === 'win' ? b.signalDecimal - 1 : -1), 0);
  // what Pinnacle's raw close expected of the same legs
  const withP = g.filter(b => b.closePinFair != null);
  const expW = withP.reduce((s, b) => s + b.closePinFair, 0), varW = withP.reduce((s, b) => s + b.closePinFair * (1 - b.closePinFair), 0);
  const wP = withP.filter(b => b.outcome === 'win').length;
  const expUnits = withP.reduce((s, b) => s + b.closePinFair * b.signalDecimal - 1, 0);
  // CLV on every locked leg with a raw close, graded or not
  const clvs = legs.filter(b => b.closePinEv != null && b.status !== 'open' && b.status !== 'void').map(b => b.closePinEv);
  const m = mean(clvs), sd = clvs.length > 1 ? Math.sqrt(clvs.reduce((s, x) => s + (x - m) ** 2, 0) / (clvs.length - 1)) : null;
  const ex = g.filter(b => b.execOk === true);
  return {
    graded: n, wins: w, losses: n - w, winPct: n ? r1((100 * w) / n) : null,
    breakEven: be == null ? null : r1(be * 100), vsBar: n ? r1((100 * w) / n - BAR * 100) : null,
    // wins against the leg's own break-even, in sd
    zVsBreakEven: n && be > 0 && be < 1 ? r2((w - n * be) / Math.sqrt(n * be * (1 - be))) : null,
    units: n ? r2(units) : null, roi: n ? r1((100 * units) / n) : null,
    closeExpUnits: withP.length ? r2(expUnits) : null, closeExpWins: withP.length ? r1(expW) : null,
    closeZ: withP.length && varW > 0 ? r2((wP - expW) / Math.sqrt(varW)) : null,
    clvN: clvs.length, avgClv: r2(m), clvT: sd > 0 ? r2(m / (sd / Math.sqrt(clvs.length))) : null,
    beatPct: clvs.length ? r1((100 * clvs.filter(x => x > 0).length) / clvs.length) : null,
    execGraded: ex.length, execUnits: ex.length ? r2(ex.reduce((s, b) => s + (b.outcome === 'win' ? b.signalDecimal - 1 : -1), 0)) : null,
  };
}

// the verdict at TARGET graded: CLV t 2+ on Pinnacle's raw close, results not
// 1.5 sd under that close, and wins past break-even (profit shown)
function verdictOf(s) {
  if (s.graded < TARGET) return { verdict: 'too early', why: `${s.graded} of ${TARGET} graded` };
  const fails = [];
  if (!(s.clvT >= 2)) fails.push(`CLV t ${s.clvT ?? 'n/a'} under 2`);
  if (s.closeZ != null && s.closeZ <= -1.5) fails.push(`results ${s.closeZ} sd under the close`);
  if (!(s.units > 0)) fails.push(`${s.units} units: no profit`);
  return fails.length ? { verdict: 'fail', why: fails.join('; ') } : { verdict: 'pass', why: `CLV t ${s.clvT}, ${s.units} units, ${s.winPct}% vs ${s.breakEven}% break-even` };
}

// one leg per app, player stat and game: the first flagged
function dedupe(legs) {
  const m = new Map();
  for (const b of [...legs].sort((a, c) => String(a.signalAt).localeCompare(String(c.signalAt)))) {
    const k = `${propsVenue(b)}|${legCluster(b)}|${b.signalSide}`;
    if (!m.has(k)) m.set(k, b);
  }
  return [...m.values()];
}

const groupBy = (l, f) => { const m = new Map(); for (const x of l) { const k = f(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); } return m; };

// legs: the props record (every kind) → the report
function report(legs, { now = Date.now(), from = LIVE_START_FROM, showOpen = false } = {}) {
  const fromMs = Date.parse(from);
  const pool = dedupe((legs || []).filter(b => STALE.has(b.kind) && atFlag(b) && Date.parse(b.start || '') >= fromMs));
  const exact = pool.filter(b => stateOf(b) === 'exact');
  const left = pool.filter(b => stateOf(b) === 'left');
  const count = l => ({ added: l.length, open: l.filter(b => stateOf(b) === 'open').length, exact: l.filter(b => stateOf(b) === 'exact').length,
    left: l.filter(b => stateOf(b) === 'left').length, void: l.filter(b => stateOf(b) === 'void').length });
  const books = {};
  for (const [book, l] of groupBy(pool, propsVenue)) {
    const ex = l.filter(b => stateOf(b) === 'exact');
    const s = stats(ex);
    books[book] = {
      ...count(l), ...s, ...verdictOf(s),
      sides: Object.fromEntries(['Under', 'Over'].map(side => { const x = stats(ex.filter(b => b.signalSide === side)); return [side, { ...x, ...verdictOf(x) }]; })),
      // Pinnacle moved off the app's number before the start: shown, never graded
      leftResults: stats(l.filter(b => stateOf(b) === 'left').map(b => ({ ...b, closePinFair: null, closePinEv: null }))),
    };
  }
  const days = [...groupBy(pool, b => usDay(b.start))].sort((a, b) => a[0].localeCompare(b[0])).map(([d, l]) => {
    const ex = l.filter(b => stateOf(b) === 'exact');
    return { day: d, ...count(l), byBook: Object.fromEntries([...groupBy(ex, propsVenue)].map(([k, x]) => [k, stats(x)])), ...stats(ex) };
  });
  const sports = Object.fromEntries([...groupBy(exact, b => b.sport)].map(([k, l]) => [k, stats(l)]));
  const leg = b => ({ book: propsVenue(b), sport: b.sport, player: b.player, market: b.market, side: b.signalSide, line: b.signalLine, start: b.start,
    signalAt: b.signalAt, payout: b.signalDecimal, kind: b.kind, state: stateOf(b), closePinLine: b.closePinLine ?? null, closePinFair: b.closePinFair ?? null,
    clv: b.closePinEv ?? null, execOk: b.execOk ?? null, outcome: b.outcome || null, result: b.result ?? null });
  return {
    at: new Date(now).toISOString(), target: TARGET, bar: r1(BAR * 100), liveFrom: from,
    definition: "Stale app leg where Pinnacle's own line equals the app's line at the flag and at its last read inside the hour before the start; closed on Pinnacle's raw price there; graded from ESPN box scores. One leg per app, player stat and game. Unders vs Overs fixed before the live legs.",
    live: { ...count(pool), ...stats(exact), books, days, sports, leftAll: left.length },
    backfit: BACKFIT,
    graded: exact.filter(won).sort((a, b) => String(b.start).localeCompare(String(a.start))).map(leg),
    left: left.filter(won).map(leg),
    ...(showOpen ? { open: pool.filter(b => stateOf(b) === 'open').map(leg) } : {}),
  };
}

module.exports = { report, stats, verdictOf, dedupe, atFlag, stateOf, usDay, TARGET, BAR, LIVE_START_FROM, BACKFIT };
