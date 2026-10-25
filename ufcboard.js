// ─── UFC BOARD: EVERY APP UFC LEG NEXT TO PINNACLE AND THE UFC MODEL ────────
// For each UFC fighter leg the pick'em apps hang (PrizePicks, Underdog,
// Sleeper, DK Pick6), this finds Pinnacle's fight (moneyline and total
// rounds), prices the leg off it with ufcmodel.js (fight length from
// Pinnacle's total; strikes and takedowns from the fighter's own UFC rates
// over that fight length) and puts each app's number next to the price.
// Pre-registered 2026-10-25 (checks/ufc-pin-2026-10-25/PREREGISTERED.md):
//
//   every priced leg is recorded once per app, on the side the price favours,
//   with that app's break-even and whether it clears it. Kinds, never pooled:
//     ufc-time  p6-ufc-time  ud-ufc-time  sl-ufc-time   Fight Time
//     ufc-fin   p6-ufc-fin   ud-ufc-fin   sl-ufc-fin    Finishes, Nth Round Finish
//     ufc-stat  p6-ufc-stat  ud-ufc-stat  sl-ufc-stat   Significant Strikes, Takedowns
//   A kind is a bet only when its clearing legs reach 50+ graded live with
//   the hit rate 2+ standard errors above the app's break-even and an
//   independent re-check. Until then: research record only, no alerts.
//
// Pure functions: the server and the backtest feed rows in the same shape.

const { canonName } = require('./ev');
const NS = require('./nflsunday');
const UM = require('./ufcmodel');

const APPS = ['prizepicks', 'underdog', 'sleeper', 'pick6'];
const PREFIX = { prizepicks: '', pick6: 'p6-', underdog: 'ud-', sleeper: 'sl-' };
const TYPE_OF = { fight_time: 'time', finishes: 'fin', '1st_round_finish': 'fin', '2nd_round_finish': 'fin', '3rd_round_finish': 'fin', '4th_round_finish': 'fin', '5th_round_finish': 'fin',
  significant_strikes: 'stat', takedowns: 'stat' };
const MARKETS = Object.keys(TYPE_OF);
const kindOf = (app, mkey) => (TYPE_OF[mkey] && PREFIX[app] != null ? `${PREFIX[app]}ufc-${TYPE_OF[mkey]}` : null);
const KINDS = new Set(APPS.flatMap(a => ['time', 'fin', 'stat'].map(t => `${PREFIX[a]}ufc-${t}`)));
const appOfKind = k => APPS.find(a => k.startsWith(`${PREFIX[a]}ufc-`) && (PREFIX[a] || !/^(p6|ud|sl)-/.test(k))) || null;
const EPS = 1e-9;
const r4 = x => (Number.isFinite(x) ? Math.round(x * 1e4) / 1e4 : null);

// Pinnacle's fights → finder by fighter: the fight naming the row's fighter
// (and its opponent when the row names one) within 36 hours of the row's start
function fightIndex(fights) {
  const by = new Map();
  for (const f of fights || []) for (const n of [f.home, f.away]) { const k = canonName(n); if (!by.has(k)) by.set(k, []); by.get(k).push(f); }
  const surname = n => String(n || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').split(/\s+/).pop().replace(/[^a-z]/g, '');
  return function find(row) {
    const t = Date.parse(row.startTime || '');
    const near = list => (list || []).filter(f => Math.abs(Date.parse(f.start) - t) < 36 * 3600e3);
    let list = near(by.get(canonName(row.player)));
    // a spelling apart (Soyoung You / SuYoung You): the fight whose two
    // surnames are the row's matchTitle ("You vs Chovancek")
    if (!list.length && row.matchTitle) {
      const sn = String(row.matchTitle).split(/\s+vs\.?\s+/i).map(surname);
      if (sn.length === 2) list = near((fights || []).filter(f => { const a = [surname(f.home), surname(f.away)]; return a.includes(sn[0]) && a.includes(sn[1]); }));
    }
    if (!list.length) return null;
    const f = list.reduce((a, b) => (Math.abs(Date.parse(b.start) - t) < Math.abs(Date.parse(a.start) - t) ? b : a));
    const meHome = canonName(f.home) === canonName(row.player) || (canonName(f.away) !== canonName(row.player) && surname(f.home) === surname(row.player));
    return { fight: f, me: meHome ? f.home : f.away, op: meHome ? f.away : f.home, pWin: f.pHome == null ? null : (meHome ? f.pHome : 1 - f.pHome) };
  };
}

// one row → the fight's prices for it: { sched, rounds, pOver, pWin: { [canon]: p } } | null
function fightFor(found, { fiveRounds = false, appMinutes = null } = {}) {
  if (!found || !(found.fight.pOver > 0)) return null;
  const f = found.fight;
  const sched = UM.schedOf({ rounds: f.rounds, appMinutes, mainEvent: f.mainEvent || fiveRounds });
  return { sched, rounds: f.rounds, pOver: f.pOver, pWin: found.pWin == null ? {} : { [canonName(found.me)]: found.pWin } };
}

// one app cell priced at p (P over at its line) → the leg, or null
function classify(app, cell, pOver, mkey, extra = {}) {
  if (!cell || cell.line == null || !(pOver >= 0 && pOver <= 1)) return null;
  const line = Number(cell.line);
  const v = [line, cell.over ?? null, cell.under ?? null, 1, 1];
  const sides = ['Over', 'Under'].filter(s => (s === 'Over' ? cell.overOpen !== false : cell.underOpen !== false))
    .map(s => { const be = NS.breakEven(app, s, v); const fair = s === 'Over' ? pOver : 1 - pOver; return be > 0 && be < 1 ? { side: s, be, fair, ev: (fair / be - 1) * 100 } : null; })
    .filter(Boolean);
  if (!sides.length) return null;
  // the side the price favours: the better value (on a fixed payout, the likelier side)
  const s = sides.reduce((a, b) => (b.ev > a.ev ? b : a));
  const mult = s.side === 'Over' ? cell.over ?? 1 : cell.under ?? 1;
  return { app, kind: kindOf(app, mkey), side: s.side, line, fair: r4(s.fair), be: r4(s.be), ev: +s.ev.toFixed(2), clears: s.fair > s.be + EPS, mult, ...extra };
}

// rows: props-board rows. fights: Pinnacle's MMA fights (pinextra.parseMmaFights).
// careerOf(name) → UFC career ({ n, mins, sigL, ... }) or null.
// fiveRoundsOf(row) → true when another source says five rounds (optional).
// → [{ row, fight, price: { pOver, exact, basis, rate }, legs: [classify…] }]
function board(rows, { fights, careerOf = () => null, fiveRoundsOf = () => false, apps = APPS } = {}) {
  const find = fightIndex(fights);
  const out = [];
  for (const row of rows || []) {
    if (row?.sport !== 'MMA' || row.esports || !TYPE_OF[row.mkey]) continue;
    const found = find(row);
    if (!found) continue;
    const minutes = row.mkey === 'fight_time' ? Math.max(...apps.map(a => Number(row.books?.[a]?.line) || 0)) : null;
    const fight = fightFor(found, { fiveRounds: fiveRoundsOf(row), appMinutes: minutes });
    if (!fight) continue;
    const me = TYPE_OF[row.mkey] === 'stat' ? careerOf(found.me) : null, op = TYPE_OF[row.mkey] === 'stat' ? careerOf(found.op) : null;
    const legs = [];
    let any = null;
    for (const a of apps) {
      const cell = row.books?.[a];
      if (!cell || cell.line == null) continue;
      const pr = UM.priceLeg(fight, { mkey: row.mkey, line: Number(cell.line), player: canonName(found.me), me, op });
      if (!pr) continue;
      any = any || pr;
      const l = classify(a, cell, pr.pOver, row.mkey, { exact: pr.exact, basis: pr.basis });
      if (l) legs.push(l);
    }
    if (!legs.length) continue;
    out.push({ row, fight: { ...found.fight, sched: fight.sched, me: found.me, op: found.op, pWin: r4(found.pWin) }, price: any, legs,
      rates: me && op ? { me: { n: me.n, mins: +me.mins.toFixed(1), sigPm: +(me.sigL / me.mins).toFixed(2), tdPm: +(me.tdL / me.mins).toFixed(3) }, op: { n: op.n, mins: +op.mins.toFixed(1), sigAbsPm: +(op.sigA / op.mins).toFixed(2), tdAbsPm: +(op.tdA / op.mins).toFixed(3) } } : null });
  }
  return out;
}

// the record: every leg under its kind, as the app shows it now. play: what
// sporttrack.record logs (clears says whether it counts toward the bar).
function plays(rows, opts) {
  const out = [];
  for (const { row, fight, legs } of board(rows, opts)) {
    for (const l of legs) {
      out.push({ row, kind: l.kind, research: true,
        play: { book: l.app, side: l.side, line: l.line, mult: l.mult, decimal: r4(1 / l.be), fair: l.fair, ev: l.ev, clears: l.clears, exact: l.exact,
          pinRounds: fight.rounds, pinOver: fight.pOver, pinWin: fight.pWin, sched: fight.sched } });
    }
  }
  return out;
}

// the close for a leg: the same price off Pinnacle's fight as it stands now
// (its total and moneyline at the start) → { pOver, x (rounds), pinOver } | null
function closeAt(row, line, { fights, careerOf = () => null, fiveRoundsOf = () => false } = {}) {
  const found = fightIndex(fights)(row);
  const fight = fightFor(found, { fiveRounds: fiveRoundsOf(row), appMinutes: row.mkey === 'fight_time' ? Number(line) : null });
  if (!fight) return null;
  const stat = TYPE_OF[row.mkey] === 'stat';
  const pr = UM.priceLeg(fight, { mkey: row.mkey, line: Number(line), player: canonName(found.me), me: stat ? careerOf(found.me) : null, op: stat ? careerOf(found.op) : null });
  return pr ? { pOver: pr.pOver, exact: pr.exact, x: found.fight.rounds, pinOver: found.fight.pOver } : null;
}

// ── the bar ──
// graded legs [{ outcome, signalDecimal, profit }] → the tally against their own break-evens
function tally(legs) {
  const g = legs.filter(l => l.outcome === 'win' || l.outcome === 'loss');
  const w = g.filter(l => l.outcome === 'win').length;
  const be = g.length ? g.reduce((a, l) => a + 1 / (l.signalDecimal || 2), 0) / g.length : null;
  const sd = g.length ? Math.sqrt(g.reduce((a, l) => { const p = 1 / (l.signalDecimal || 2); return a + p * (1 - p); }, 0)) : null;
  const z = sd ? +((w - g.length * be) / sd).toFixed(2) : null;
  return { n: g.length, w, l: g.length - w, hit: g.length ? r4(w / g.length) : null, be: r4(be), z,
    units: +g.reduce((a, l) => a + (l.profit ?? (l.outcome === 'win' ? (l.signalDecimal || 2) - 1 : -1)), 0).toFixed(2), passes: g.length >= 50 && z >= 2 };
}

module.exports = { APPS, PREFIX, TYPE_OF, MARKETS, KINDS, kindOf, appOfKind, fightIndex, fightFor, classify, board, plays, closeAt, tally };
