// ─── PROMOS: THE PICK'EM APPS' DISCOUNTED AND BOOSTED LEGS VS THE SHARP PRICE ─
// The apps cut lines and lift payouts on purpose: PrizePicks goblins, demons
// and promos (free squares, flash sales), Underdog discounted lines,
// higher-payout alternates and boosted sides, Sleeper's non-normal lines, and
// DK Pick6's Gimme Pick, Stat Slice, Power Up and one-sided alt ladders. The
// readers (pickem.js parse*Promos, server.js parseUnderdogPromos) keep each
// one as a leg with its own multiplier. This prices every leg at its own
// payout:
//   required hit rate: the leg's break-even at its multiplier, not the
//     standard slip's (PrizePicks 55.03% / m on its 3-pick Power, Pick6 its
//     3-pick table / m, Underdog 56.23% / m or 1 / m, Sleeper 1 / m)
//   fair: Pinnacle's no-vig chance at the leg's exact number, else FanDuel's
//     and BetRivers' at the exact number, else Pinnacle's (then the books')
//     nearest line read along the stat's curve, only when that moves the
//     chance by maxShiftPts or less
//   PrizePicks goblins and demons: the open feed doesn't carry their payout,
//     so there is no required rate; the leg shows the multiplier PrizePicks
//     would have to pay for it to break even (55.03% / fair) instead.
//
// Pre-registered 2026-10-25 (checks/promos-2026-10-25/PREREGISTERED.md):
// nothing here is a bet until one app and type has 50+ graded live legs, a hit
// rate z >= 2 above the legs' own required rate, and an independent raw
// re-check. Own record kinds promo-<app>-<type>, never in alerts.
//
// Pure functions; the server feeds the caches and the board rows in.

const SP = require('./sportprops');
const NS = require('./nflsunday');
const { canonName } = require('./ev');
const { sportMarketKey, normLine } = require('./propsboard');

const APPS = ['prizepicks', 'underdog', 'sleeper', 'pick6'];
const LABEL = { prizepicks: 'PrizePicks', underdog: 'Underdog', sleeper: 'Sleeper', pick6: 'DK Pick6' };
const CODE = { prizepicks: 'pp', underdog: 'ud', sleeper: 'sl', pick6: 'p6' };
const TYPE_LABEL = { goblin: 'Goblin', demon: 'Demon', promo: 'Promo', discount: 'Discounted', alt: 'Alt line', boost: 'Boosted',
  gimme: 'Gimme Pick', 'stat slice': 'Stat Slice', 'power up': 'Power Up' };
const typeLabel = t => TYPE_LABEL[t] || String(t || '').replace(/(^|\s)\S/g, c => c.toUpperCase());
const slug = t => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const kindOf = leg => `promo-${CODE[leg.book] || leg.book}-${slug(leg.type)}`;
const OPTS = { maxShiftPts: 10, provenN: 50, provenZ: 2 };
const EPS = 1e-9;
const r4 = x => Math.round(x * 1e4) / 1e4;

// one leg → its break-even hit rate at its own payout, or null when the
// payout isn't known (PrizePicks goblins and demons). Above 1: it can't pay.
function requiredRate(leg) {
  const m = Number(leg?.mult);
  if (!(m > 0)) return null;
  switch (leg.book) {
    case 'prizepicks': return SP.FIXED.prizepicks.grade.be / m;
    case 'pick6': return SP.FIXED.pick6.grade.be / m;
    case 'underdog': {
      const o = leg.otherMult ?? null;
      return NS.breakEven('underdog', leg.side, leg.side === 'Over' ? [leg.line, m, o] : [leg.line, o, m]);
    }
    case 'sleeper': return m > 1 ? 1 / m : null;
    default: return null;
  }
}

// sharp quotes [{ book, line, pOver }] → P(over) at `line`:
// { p, books, exact, from } (from: the sharp line it was read off) or null
function sharpAt(quotes, mkey, sport, line, { maxShiftPts = OPTS.maxShiftPts } = {}) {
  const ok = q => q && q.line != null && q.pOver > 0 && q.pOver < 1;
  const groups = [['pinnacle'], ['fanduel', 'betrivers']];
  for (const g of groups) {
    const at = (quotes || []).filter(q => ok(q) && g.includes(q.book) && Math.abs(q.line - line) < EPS);
    const byBook = new Map(at.map(q => [q.book, q]));
    if (byBook.size) {
      const ps = [...byBook.values()].map(q => q.pOver);
      return { p: ps.reduce((a, b) => a + b, 0) / ps.length, books: [...byBook.keys()], exact: true, from: line };
    }
  }
  if (SP.EXACT.has(mkey)) return null;   // a stat with no curve: the exact number only
  for (const g of groups) {
    const near = new Map();
    for (const q of quotes || []) if (ok(q) && g.includes(q.book) && (!near.has(q.book) || Math.abs(q.line - line) < Math.abs(near.get(q.book).line - line))) near.set(q.book, q);
    const reads = [];
    for (const q of near.values()) {
      const m = SP.meanFor(mkey, sport, q.line, q.pOver);
      if (m == null) continue;
      const p = SP.pOver(mkey, sport, m, line);
      if (!(p > 0 && p < 1) || Math.abs(p - q.pOver) * 100 > maxShiftPts) continue;
      reads.push({ book: q.book, p, line: q.line });
    }
    if (reads.length) return { p: reads.reduce((a, x) => a + x.p, 0) / reads.length, books: reads.map(x => x.book), exact: false, from: reads[0].line };
  }
  return null;
}

// a raw promo leg (the readers' shape) → the board's terms: base sport, stat key
function normLeg(leg) {
  const l = normLine(leg);
  return { ...l, mkey: sportMarketKey(l.market, l.sport) };
}

// one leg, its board row (or null) and the sharp quotes for that row → the
// priced promo the strip and the record show
function priceLeg(raw, { row = null, quotes = [], o = OPTS } = {}) {
  const leg = normLeg(raw);
  const req = requiredRate(leg);
  const mkey = row?.mkey || leg.mkey;
  const sport = row?.sport || leg.sport;
  const s = row ? sharpAt(quotes, mkey, sport, leg.line, o) : null;
  const fair = s ? (leg.side === 'Over' ? s.p : 1 - s.p) : null;
  const beMult = fair != null && leg.mult == null && leg.book === 'prizepicks' ? SP.FIXED.prizepicks.grade.be / fair : null;
  const ev = fair != null && req != null ? (fair / req - 1) * 100 : null;
  const startTime = leg.startTime || row?.startTime || '';
  return {
    id: `${leg.book}|${leg.type}|${leg.sport}|${canonName(leg.player)}|${mkey}|${leg.side}|${leg.line}|${String(startTime).slice(0, 10)}`,
    app: leg.book, appLabel: LABEL[leg.book] || leg.book, type: leg.type, typeLabel: typeLabel(leg.type), kind: kindOf(leg),
    sport, player: leg.player, team: leg.team || row?.team || '', market: row?.market || leg.market, mkey, side: leg.side, line: leg.line,
    baseLine: leg.baseLine ?? null, mult: leg.mult ?? null, otherMult: leg.otherMult ?? null, multKnown: leg.mult != null, note: leg.note || null,
    startTime, matchTitle: leg.matchTitle || row?.matchTitle || '', rowKey: row?.key || null,
    req: req == null ? null : r4(req), canPay: req == null ? null : req < 1,
    fair: fair == null ? null : r4(fair), fairBooks: s?.books || [], fairExact: s ? s.exact : null, fairFrom: s ? s.from : null,
    edgePts: fair != null && req != null ? +((fair - req) * 100).toFixed(1) : null, ev: ev == null ? null : +ev.toFixed(1),
    beMult: beMult == null ? null : +beMult.toFixed(3),
  };
}

// every promo leg → priced rows, best first (known payout with the most EV,
// then PrizePicks' unknown-payout legs by the lowest multiplier they'd need)
// rowFor(leg) → the board row for the leg's player and stat, or null
// quotesFor(row) → that row's sharp quotes
// (buildPromosSteps: the same build as a generator that stops every 64 legs,
// so the server can run it a slice at a time; buildPromos runs it in one go)
/** @param {any[]} legs @param {any} [opts] */
function buildPromos(legs, opts) {
  const it = buildPromosSteps(legs, opts);
  for (;;) { const r = it.next(); if (r.done) return r.value; }
}
/** @param {any[]} legs @param {any} [opts] */
function* buildPromosSteps(legs, { rowFor = () => null, quotesFor = () => [], now = Date.now(), o = OPTS } = {}) {
  const out = [], seen = new Set();
  let n = 0;
  for (const raw of legs || []) {
    if (++n % 64 === 0) yield;
    if (!raw || !raw.player || !Number.isFinite(Number(raw.line)) || !raw.side) continue;
    const row = rowFor(normLeg(raw));
    const t = Date.parse(raw.startTime || row?.startTime || '');
    if (t && t <= now) continue;   // started
    const p = priceLeg(raw, { row, quotes: row ? quotesFor(row) : [], o });
    if (!p.startTime || seen.has(p.id)) continue;
    seen.add(p.id);
    out.push(p);
  }
  const score = p => (p.ev != null ? 1e6 + p.ev : p.beMult != null ? -p.beMult : -1e9);
  return out.sort((a, b) => score(b) - score(a) || Date.parse(a.startTime) - Date.parse(b.startTime));
}

// counts for the strip's header: by app and type, and how many have a fair
function promoCounts(promos) {
  const byApp = {}, byType = {};
  let priced = 0, plusEv = 0;
  for (const p of promos || []) {
    byApp[p.app] = (byApp[p.app] || 0) + 1;
    const k = `${p.app}|${p.type}`;
    byType[k] = byType[k] || { app: p.app, type: p.type, label: `${p.appLabel} ${p.typeLabel}`, n: 0, priced: 0, plusEv: 0 };
    byType[k].n++;
    if (p.fair != null) { priced++; byType[k].priced++; }
    if (p.ev > 0) { plusEv++; byType[k].plusEv++; }
  }
  return { total: (promos || []).length, priced, plusEv, byApp, byType: Object.values(byType).sort((a, b) => b.n - a.n) };
}

// priced promos → what the record follows: one synthetic board row per leg
// (the leg's own line in its app's cell, so the 2-minute executable check
// reads the promo itself) and the play. Only legs with a sharp fair.
// → [{ row, play, kind }]
function recordLegs(promos, { boardRow = () => null } = {}) {
  const out = [];
  for (const p of promos || []) {
    if (p.fair == null || !p.rowKey) continue;
    const base = boardRow(p.rowKey);
    if (!base) continue;
    const row = promoRow(p, base);
    const decimal = p.req != null ? 1 / p.req : 1 / SP.FIXED.prizepicks.grade.be;
    out.push({ row, kind: p.kind, play: { book: p.app, side: p.side, line: p.line, mult: p.mult ?? 1, decimal: +decimal.toFixed(4), fair: p.fair, ev: p.ev,
      sources: p.fairBooks.map(b => ({ book: b, line: p.fairFrom, exact: p.fairExact })), gap: null } });
  }
  return out;
}
// the synthetic row: key `${board row key}|promo|...` so the record's id and
// its close both follow this one leg
function promoRow(p, base) {
  const over = p.side === 'Over';
  return { key: `${base.key}|promo|${p.app}|${slug(p.type)}|${p.side}|${p.line}`, baseKey: base.key, sport: base.sport, player: base.player, team: base.team || '', market: base.market,
    mkey: base.mkey, startTime: base.startTime, matchTitle: base.matchTitle || '',
    books: { [p.app]: { line: p.line, over: over ? p.mult : p.otherMult, under: over ? p.otherMult : p.mult, overOpen: over, underOpen: !over } } };
}
const baseKeyOf = key => String(key || '').split('|promo|')[0];

// the record's legs → one slice per kind, each at its own break-even, with
// the bar. PrizePicks goblins and demons have no known payout: their slice
// compares the hit rate with the sharp fair the legs were logged at
// (calibration), never units.
function recordSummary(legs, o = OPTS) {
  const graded = (legs || []).filter(b => b.status === 'graded' && (b.outcome === 'win' || b.outcome === 'loss'));
  const kinds = new Map();
  for (const b of legs || []) if (!kinds.has(b.kind)) kinds.set(b.kind, { open: 0, graded: [] });
  for (const b of legs || []) if (b.status === 'open' || b.status === 'locked') kinds.get(b.kind).open++;
  for (const b of graded) kinds.get(b.kind).graded.push(b);
  const slices = [];
  for (const [kind, v] of kinds) {
    const unknown = /^promo-pp-(goblin|demon)$/.test(kind);
    const be = b => (unknown ? b.signalFair : 1 / (b.signalDecimal || 2));
    const rows = v.graded.filter(b => be(b) > 0 && be(b) < 1).map(b => ({ out: b.outcome, be: be(b) }));
    const t = NS.tally(rows);
    const bar = unknown ? 'payout not published: hit rate vs the sharp fair only'
      : t.n >= o.provenN && t.z >= o.provenZ && t.units > 0 ? 'passes, needs the raw re-check' : t.n < o.provenN ? `${t.n} of ${o.provenN} graded` : 'fails';
    slices.push({ kind, ...t, units: unknown ? null : t.units, roi: unknown ? null : t.roi, vs: unknown ? 'sharp fair' : 'required rate', open: v.open, bar });
  }
  slices.sort((a, b) => b.n - a.n || a.kind.localeCompare(b.kind));
  return { slices, graded: graded.length, legs: (legs || []).length, since: (legs || []).reduce((m, b) => (!m || b.signalAt < m ? b.signalAt : m), null) };
}

// free tier: the apps' legs and the required rate, no fair or EV
function redactPromo(p) {
  return { ...p, fair: null, fairBooks: [], fairExact: null, fairFrom: null, edgePts: null, ev: null, beMult: null };
}

module.exports = { APPS, LABEL, CODE, TYPE_LABEL, OPTS, typeLabel, kindOf, requiredRate, sharpAt, normLeg, priceLeg, buildPromos, buildPromosSteps, promoCounts, recordLegs, promoRow, baseKeyOf, recordSummary, redactPromo };
