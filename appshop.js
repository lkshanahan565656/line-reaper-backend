// ─── APP SHOP: THE SOFTEST PICK'EM NUMBER ACROSS THE APPS, AND MIDDLES ──────
// PrizePicks, Underdog, Sleeper and DK Pick6 often hang the same player stat at
// different numbers. For each side this finds the app with the softest number
// (the lowest line for an Over, the highest for an Under), how far it sits from
// the nearest other app (the gap: the softest beats every other app by at
// least that much), each leg's break-even at its own app's real payout, and the
// sharp price at that number where Pinnacle or the books hang one.
//
// A middle is the Over at one app's low number with the Under at another
// app's high number: a result strictly between them wins both legs. Its
// expected units come from the stat's curve (sportprops.pOver) at both lines,
// each leg priced at its own app's break-even, and only middles worth more
// than zero are listed.
//
// Pure functions. The server feeds props-board rows in; the backtest
// (checks/app-shop-2026-10-25) feeds recorded boards in the same shape.
// Pre-registered 2026-10-25 before any cross-app gap was graded: kinds
// 'shop-pp' (P1), 'shop-p6' (P2), 'shop-any' (P3), gap >= 1 stat unit.

const NS = require('./nflsunday');
const SP = require('./sportprops');

const APPS = ['prizepicks', 'underdog', 'sleeper', 'pick6'];
const LABEL = { prizepicks: 'PrizePicks', underdog: 'Underdog', sleeper: 'Sleeper', pick6: 'DK Pick6' };
const MIN_GAP = 1;
const EPS = 1e-9;

// one app cell { line, over, under, overOpen, underOpen } → that side's
// break-even win chance at the app's real payout (nflsunday.breakEven), or null
function breakEven(app, side, c) {
  if (!c || c.line == null || !(side === 'Over' ? c.overOpen !== false : c.underOpen !== false)) return null;
  const be = NS.breakEven(app, side, [c.line, c.over ?? null, c.under ?? null, 1, 1]);
  return be > 0 && be < 1 ? be : null;
}

// a row's app cells → one entry per side where two or more apps list it at
// different numbers:
// { side, app, line, be, tied: [apps at the same number], gap, nearest: { app, line },
//   others: [{ app, line, be }] }
// gap: the distance to the nearest app NOT at the softest number (0 = all agree)
function softest(books, { apps = APPS, beOf = breakEven } = {}) {
  const out = [];
  for (const side of ['Over', 'Under']) {
    const list = [];
    for (const app of apps) {
      const c = books?.[app];
      const be = beOf(app, side, c);
      if (be != null) list.push({ app, line: c.line, be });
    }
    if (list.length < 2) continue;
    // softer first: the lower line for an Over, the higher for an Under
    const softer = (a, b) => (side === 'Over' ? a.line - b.line : b.line - a.line);
    list.sort((a, b) => softer(a, b) || a.be - b.be);
    const top = list[0];
    const tied = list.filter(x => Math.abs(x.line - top.line) < EPS);
    const rest = list.filter(x => Math.abs(x.line - top.line) >= EPS);
    if (!rest.length) continue;
    const nearest = rest[0];
    out.push({ side, app: top.app, line: top.line, be: +top.be.toFixed(4), tied: tied.map(x => x.app), gap: +Math.abs(nearest.line - top.line).toFixed(2),
      nearest: { app: nearest.app, line: nearest.line }, others: list.slice(1).map(x => ({ app: x.app, line: x.line, be: +x.be.toFixed(4) })) });
  }
  return out;
}

// the bet a judged kind takes from one side's entry: P1 at PrizePicks, P2 at
// Pick6 (either may sit tied with another app at the softest number), P3 the
// softest app with the lowest break-even. → { app, be } or null
const KINDS = ['shop-pp', 'shop-p6', 'shop-any'];
const RECORD_KINDS = [...KINDS, 'shop-mid'];
function kindLeg(kind, s, books, { beOf = breakEven, minGap = MIN_GAP } = {}) {
  if (!s || !(s.gap >= minGap)) return null;
  const pick = app => (s.tied.includes(app) ? { app, be: beOf(app, s.side, books[app]) } : null);
  if (kind === 'shop-pp') return pick('prizepicks');
  if (kind === 'shop-p6') return pick('pick6');
  if (kind === 'shop-any') return { app: s.app, be: s.be };
  return null;
}

// gap as a share of the line, and the buckets the check reports
const gapBucket = g => (g >= 5 ? '5+' : g >= 2 ? '2-5' : g >= 1 ? '1-2' : '<1');
const gapShareBucket = (g, line) => { const r = line > 0 ? g / line : 0; return r >= 0.1 ? '10%+' : r >= 0.05 ? '5-10%' : '<5%'; };

// P(over line) for a row: a function line → p, from a mean on the stat's curve.
// mean: from the sharp fair at one line ({ line, p }) or, without one, the
// apps' median number read as 50/50. → { pOverAt, mean, source } or null
// Only stats with a fitted spread (sportprops.K): a fantasy score or a
// first-quarter stat on the default spread made middles out of noise.
const hasCurve = (mkey, sport) => SP.K[sport === 'NHL' && mkey === 'points' ? 'points_nhl' : mkey] != null && !SP.EXACT.has(mkey);
function curveFor(mkey, sport, { sharp = null, lines = [], anyStat = false } = {}) {
  if (!anyStat && !hasCurve(mkey, sport)) return null;
  let mean = null, source = null;
  if (sharp && sharp.line != null && sharp.p > 0 && sharp.p < 1) { mean = SP.meanFor(mkey, sport, sharp.line, sharp.p); source = sharp.source || 'pinnacle'; }
  if (mean == null && lines.length) {
    const s = [...lines].sort((a, b) => a - b), mid = s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
    mean = SP.meanFor(mkey, sport, mid, 0.5); source = 'apps';
  }
  if (mean == null) return null;
  return { mean: +mean.toFixed(3), source, pOverAt: line => SP.pOver(mkey, sport, mean, line) };
}

// middles on one row: the Over at one app's number a with the Under at
// another app's number b > a. Each pair once (the softest number per side
// against every other app's opposite side). curve: curveFor output.
// → [{ over: { app, line, be, p }, under: { app, line, be, p }, width, pMiddle, expUnits }]
function middles(books, curve, { apps = APPS, beOf = breakEven, minUnits = 0 } = {}) {
  if (!curve) return [];
  const out = [];
  for (const oa of apps) for (const ub of apps) {
    if (oa === ub) continue;
    const co = books?.[oa], cu = books?.[ub];
    const beO = beOf(oa, 'Over', co), beU = beOf(ub, 'Under', cu);
    if (beO == null || beU == null || !(cu.line > co.line + EPS)) continue;
    const pO = curve.pOverAt(co.line), pU = 1 - curve.pOverAt(cu.line);
    if (!(pO >= 0 && pU >= 0)) continue;
    const expUnits = pO / beO + pU / beU - 2;
    if (!(expUnits > minUnits)) continue;
    out.push({ over: { app: oa, line: co.line, be: +beO.toFixed(4), p: +pO.toFixed(4) }, under: { app: ub, line: cu.line, be: +beU.toFixed(4), p: +pU.toFixed(4) },
      width: +(cu.line - co.line).toFixed(2), pMiddle: +Math.max(0, pO + pU - 1).toFixed(4), expUnits: +expUnits.toFixed(3), source: curve.source });
  }
  return out.sort((a, b) => b.expUnits - a.expUnits);
}

// graded outcome of a middle from the stat's result: 'both' | 'one' | 'none' (+ pushes)
function middleOutcome(m, result) {
  const o = NS.outcome('Over', m.over.line, result), u = NS.outcome('Under', m.under.line, result);
  const won = (o === 'win') + (u === 'win');
  const units = (o === 'win' ? 1 / m.over.be - 1 : o === 'loss' ? -1 : 0) + (u === 'win' ? 1 / m.under.be - 1 : u === 'loss' ? -1 : 0);
  return { result: won === 2 ? 'both' : won === 1 ? 'one' : (o === 'push' || u === 'push') ? 'push' : 'none', units: +units.toFixed(4) };
}

// ── the live screen: props-board rows → SHOP rows ──
// rows: propsBoard rows (books keyed by app); sharpAt(row, line) → { p, source }
// or null (the sharp consensus at that number); evOf(p, app, side, cell) → EV
// % at the app's real payout. Sorted by gap, then EV.
function shopRows(rows, { sharpAt = () => null, evOf = null, minGap = MIN_GAP, now = Date.now(), withMiddles = true } = {}) {
  const out = [];
  for (const row of rows || []) {
    if (!row || row.esports || !row.mkey || String(row.mkey).includes('|')) continue;
    if (Date.parse(row.startTime || '') <= now) continue;
    const books = row.books || {};
    const sides = softest(books).filter(s => s.gap >= minGap);
    if (!sides.length) continue;
    const lines = APPS.map(a => books[a]?.line).filter(x => x != null);
    let sharp = null;
    const shopSides = sides.map(s => {
      const f = sharpAt(row, s.line);
      if (f && !sharp) sharp = { line: s.line, p: f.p, source: f.source || 'sharp' };
      const fair = f ? (s.side === 'Over' ? f.p : 1 - f.p) : null;
      const cell = books[s.app];
      const mult = s.side === 'Over' ? cell.over : cell.under;
      const ev = fair != null && evOf ? evOf(fair, s.app, s.side, cell, mult) : null;
      return { ...s, fair: fair != null ? +(fair * 100).toFixed(1) : null, fairSource: f ? (f.source || 'sharp') : null, ev: ev != null && Number.isFinite(ev) ? +ev.toFixed(2) : null };
    });
    const curve = withMiddles ? curveFor(row.mkey, row.sport, { sharp, lines }) : null;
    const mids = withMiddles ? middles(books, curve).slice(0, 3) : [];
    out.push({ key: row.key, sport: row.sport, player: row.player, team: row.team || '', market: row.market, mkey: row.mkey, startTime: row.startTime, matchTitle: row.matchTitle || '',
      apps: Object.fromEntries(APPS.filter(a => books[a]).map(a => [a, { line: books[a].line, over: books[a].over ?? null, under: books[a].under ?? null, overOpen: books[a].overOpen !== false, underOpen: books[a].underOpen !== false }])),
      sides: shopSides, gap: Math.max(...shopSides.map(s => s.gap)), bestEv: shopSides.reduce((m, s) => (s.ev != null && (m == null || s.ev > m) ? s.ev : m), null),
      middles: mids, curve: curve ? { mean: curve.mean, source: curve.source } : null });
  }
  return out.sort((a, b) => b.gap - a.gap || (b.bestEv ?? -1e9) - (a.bestEv ?? -1e9));
}

// SHOP rows → the legs the record follows, one per judged kind and side:
// 'shop-any' (P3, the softest app with the lowest break-even) on every side,
// and 'shop-pp' / 'shop-p6' (P1, P2) where PrizePicks or Pick6 sits tied at
// the softest number but another app took shop-any. So P1 = shop-pp plus the
// shop-any legs on PrizePicks; P2 the same for Pick6.
// → [{ rowKey, kind, play: { book, side, line, mult, decimal, fair, ev, sources } }]
function recordLegs(shop, { minGap = MIN_GAP } = {}) {
  const out = [];
  for (const r of shop || []) for (const s of r.sides || []) {
    if (!(s.gap >= minGap)) continue;
    const leg = (app, kind) => {
      const c = r.apps[app]; if (!c) return;
      const be = breakEven(app, s.side, c); if (be == null) return;
      out.push({ rowKey: r.key, kind, play: { book: app, side: s.side, line: s.line, mult: (s.side === 'Over' ? c.over : c.under) ?? 1, decimal: +(1 / be).toFixed(4),
        fair: app === s.app && s.fair != null ? s.fair / 100 : null, ev: app === s.app ? s.ev : null, sources: [],
        gap: { vs: s.others.filter(o => Math.abs(o.line - s.line) > EPS).map(o => ({ book: o.app, line: o.line })), pts: s.gap, probPts: null } } });
    };
    leg(s.app, 'shop-any');
    if (s.app !== 'prizepicks' && s.tied.includes('prizepicks')) leg('prizepicks', 'shop-pp');
    if (s.app !== 'pick6' && s.tied.includes('pick6')) leg('pick6', 'shop-p6');
  }
  // a middle worth more than zero: both legs, kind 'shop-mid', each naming the
  // other leg in its gap so the pair is rebuilt for grading (middleRecord)
  for (const r of shop || []) for (const m of r.middles || []) {
    if (m.locked || !(m.expUnits > 0)) continue;
    for (const [a, b, side] of [[m.over, m.under, 'Over'], [m.under, m.over, 'Under']]) {
      const c = r.apps[a.app]; if (!c) continue;
      out.push({ rowKey: r.key, kind: 'shop-mid', play: { book: a.app, side, line: a.line, mult: (side === 'Over' ? c.over : c.under) ?? 1, decimal: +(1 / a.be).toFixed(4),
        fair: a.p, ev: +((a.p / a.be - 1) * 100).toFixed(2), sources: [], gap: { vs: [{ book: b.app, line: b.line }], pts: m.width, probPts: +(m.pMiddle * 100).toFixed(1) } } });
    }
  }
  return out;
}

// the record's shop-mid legs → middles rebuilt in pairs and graded:
// { n, both, one, units, open } (units at each leg's break-even, 1u a leg)
const CODE_APP = { PP: 'prizepicks', UD: 'underdog', SL: 'sleeper', P6: 'pick6' };
function middleRecord(legs) {
  const by = new Map();
  for (const b of legs || []) {
    if (b.kind !== 'shop-mid') continue;
    const vs = (b.gapVs || [])[0]; if (!vs) continue;
    const other = CODE_APP[vs.book] || vs.book;
    const [o, u] = b.signalSide === 'Over' ? [[b.book, b.signalLine], [other, vs.line]] : [[other, vs.line], [b.book, b.signalLine]];
    const id = `${b.sport}|${b.player}|${b.mkey}|${String(b.start || '').slice(0, 10)}|${o.join(':')}|${u.join(':')}`;
    (by.get(id) || by.set(id, []).get(id)).push(b);
  }
  let n = 0, both = 0, one = 0, units = 0, open = 0;
  for (const pair of by.values()) {
    if (pair.length < 2) continue;
    if (!pair.every(b => b.status === 'graded' && b.outcome)) { if (pair.some(b => b.status === 'open' || b.status === 'locked')) open++; continue; }
    n++;
    const won = pair.filter(b => b.outcome === 'win').length;
    if (won === 2) both++; else if (won === 1) one++;
    for (const b of pair) units += b.outcome === 'win' ? (b.signalDecimal || 0) - 1 : b.outcome === 'loss' ? -1 : 0;
  }
  return { n, both, one, units: +units.toFixed(2), open };
}

// the shop record's legs → the three judged slices and the middles, each at
// its own break-even (1 / the leg's decimal), with the project's bar: 50+
// graded, z >= 2 above break-even, units > 0 (then the independent re-check)
const PROVEN_N = 50, PROVEN_Z = 2;
function recordSummary(legs) {
  const graded = (legs || []).filter(b => b.status === 'graded' && (b.outcome === 'win' || b.outcome === 'loss'));
  const slice = list => {
    const t = NS.tally(list.map(b => ({ out: b.outcome, be: 1 / (b.signalDecimal || 2) })));
    return { ...t, bar: t.n >= PROVEN_N && t.z >= PROVEN_Z && t.units > 0 ? 'passes, needs the raw re-check' : t.n < PROVEN_N ? `${t.n} of ${PROVEN_N} graded` : 'fails' };
  };
  const open = k => (legs || []).filter(b => b.kind === k && (b.status === 'open' || b.status === 'locked')).length;
  return {
    P1: { label: 'Softest number at PrizePicks', ...slice(graded.filter(b => b.kind === 'shop-pp' || (b.kind === 'shop-any' && b.book === 'prizepicks'))), open: open('shop-pp') + (legs || []).filter(b => b.kind === 'shop-any' && b.book === 'prizepicks' && b.status !== 'graded' && b.status !== 'void').length },
    P2: { label: 'Softest number at DK Pick6', ...slice(graded.filter(b => b.kind === 'shop-p6' || (b.kind === 'shop-any' && b.book === 'pick6'))) },
    P3: { label: 'Softest number at any app', ...slice(graded.filter(b => b.kind === 'shop-any')), open: open('shop-any') },
    middles: { label: 'Middles worth more than zero', ...middleRecord(legs) },
    since: (legs || []).reduce((m, b) => (!m || b.signalAt < m ? b.signalAt : m), null),
  };
}

// free tier: the apps' numbers and the gap, no fair, EV or middle math
function redactShop(r) {
  return { ...r, sides: r.sides.map(s => ({ ...s, fair: null, fairSource: null, ev: null })), middles: r.middles.length ? [{ locked: true, count: r.middles.length }] : [], curve: null, bestEv: null };
}

module.exports = { RECORD_KINDS, hasCurve, APPS, LABEL, KINDS, MIN_GAP, breakEven, softest, kindLeg, gapBucket, gapShareBucket, curveFor, middles, middleOutcome, shopRows, recordLegs, middleRecord, recordSummary, redactShop };
