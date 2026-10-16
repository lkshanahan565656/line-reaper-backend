// ─── AUTO-BUILT SLIPS ─────────────────────────────────────────────────────────
// The best entry each pick'em book will take right now, built from the board's
// priced legs. A slip is placed on one book, so every leg is priced at THAT
// book's line and payout: PrizePicks power and flex tables, Underdog standard
// and flex (a boosted or discounted Underdog leg scales a standard entry's
// payout, and isn't allowed in flex here), Sleeper's legs multiplied together.
// slip.js prices the entry with legs from one series moving together.
//
// Every leg is priced at the fair the PROPS Lines table shows for that book's
// line (server attachLinesFair: our kill share, rounds or head-to-head model
// where they price it, the books' consensus elsewhere), and a best slip takes
// one leg a match: the apps cut the payout on same-match lineups (Underdog
// reprices them, PrizePicks says it lowers them), so a best slip's EV has to
// come from its legs, not from correlation the app won't pay for. Same-match
// entries live under MATCH STACKS with the payout they need.
//
// The board often has only a handful of +EV legs, so a book's best slip can sit
// just under break-even. That slip is still shown, marked 'near', so it's clear
// which entry is closest and by how much it falls short.

const { priceSlip, PAYOUTS, PICK6_PAYOUTS, factorSport, slipHitsDistribution } = require('./slip');

const LEG_FLOOR = -6;      // % EV: legs further below their book's break-even never help a slip
const POOL_MAX = 20;       // best legs per book the greedy search looks at
const NEAR_PCT = 5;        // a slip within 5% of break-even is 'near'
const MAX_LEGS = { PP: 6, UD: 6, SL: 6, P6: 6 };

const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// The calibration shift that moves a leg's own series pricing (slip.js, the
// consensus mean per map) onto PROB, so same-series legs keep their link but
// each one hits as often as the fair it was picked on says.
function shiftTo(leg, prob) {
  if (leg.meanPerMap == null || leg.k == null) return 0;
  const base = slipHitsDistribution([{ ...leg, shift: 0 }])[1];
  return Number.isFinite(base) ? +(prob - base).toFixed(4) : 0;
}

// One pick → the leg as BOOK takes it, or null when that book doesn't carry
// it. Priced at the Lines table's fair for that book's line. SIDE: the side
// the person picked (the slip bar); left out, the side the fair leans.
// BETTABLE: a model fair counts only where the Lines table marks it green
// (a Pinnacle-based price agrees); a model-only lean is no leg for an auto slip.
function bookLeg(p, book, { side = null, bettable = false, pick6 = null } = {}) {
  if (!p?.pricing) return null;
  const base = {
    player: p.player, team: p.team || '', gameId: p.gameId ?? null, sport: p.sport, matchTitle: p.matchTitle || '',
    market: p.displayMarket || p.market, rawMarket: p.market, startTime: p.startTime || '',
    meanPerMap: p.pricing.meanPerMap, k: p.pricing.k, stat: p.pricing.stat, scenarios: p.pricing.scenarios,
  };
  // DK Pick6 posts its own esports lines: priced only where they sit on a number
  // a Pinnacle-based model priced (propsboard twin cell), at Pick6's own payout.
  // pick6: Map(pick -> the props board's Pick6 cell), present only while PICK6 is on.
  if (book === 'P6') {
    const c = pick6?.get(p);
    if (!c?.ev || !Number.isFinite(c.ev.fair) || !Number.isFinite(c.ev.ev)) return null;
    const s = String(c.ev.side).toUpperCase();
    if ((side && side !== s) || (bettable && !c.ev.clears)) return null;
    const prob = c.ev.fair / 100;
    const leg = { ...base, side: s, line: c.line, prob, ev: c.ev.ev, mult: (s === 'OVER' ? c.over : c.under) ?? 1, fair: c.ev.share ? 'share' : 'h2h' };
    return { ...leg, shift: shiftTo(leg, prob) };
  }
  const lines = p.pricing.lines;
  const m = lines?.books?.[book];
  if (m) {
    if (bettable && !m.clears) return null;
    const s = side || m.side;
    const q = m.sides?.[s];
    if (!q || (book === 'UD' && q.decimal)) return null;
    const leg = { ...base, side: s, line: m.line, prob: q.prob, ev: q.ev, mult: q.mult ?? null, fair: m.src };
    return { ...leg, shift: shiftTo(leg, q.prob) };
  }
  if (lines && !lines.marketOk) return null;
  const b = p.pricing.books?.[book];
  if (!b || !p.side || (side && side !== p.side)) return null;
  const ev = book === 'PP' ? p.ppEv : book === 'UD' ? p.udEv : p.sleeperEv;
  if (ev == null || !Number.isFinite(b.prob)) return null;
  if (book === 'UD' && b.decimal) return null;   // decimal-priced Underdog legs pay differently
  return { ...base, side: p.side, line: b.line, prob: b.prob, ev, mult: b.mult ?? null, shift: b.shift || 0, fair: 'market' };
}

// The match a leg belongs to, for one leg a match
const matchKey = l => (l.gameId != null ? `g:${l.gameId}` : norm(l.matchTitle) ? `t:${norm(l.matchTitle)}` : null);

// Expected log growth of a bankroll staking the slip's own Kelly fraction. EV
// alone always favours the longest entry (a 6-pick at +60% that hits 4% of the
// time); growth is what the bankroll actually compounds at, so it picks which
// size to play.
function growth(r, table) {
  if (!(r.kelly > 0)) return 0;
  return r.hits.reduce((g, p, h) => g + p * Math.log(1 + r.kelly * ((table[h] || 0) - 1)), 0);
}

// Every table BOOK offers for these legs, best EV first
function priceOn(book, legs, { pick6Table = null } = {}) {
  const n = legs.length;
  const out = [];
  const add = (name, table) => { if (table) { const r = priceSlip(legs, name, { [name]: { [n]: table } }); if (r) out.push({ ...r, growth: growth(r, table), payTable: name === 'pick6' ? table : undefined }); } };
  if (book === 'PP') {
    add('prizepicks_power', PAYOUTS.prizepicks_power[n]);
    add('prizepicks_flex', PAYOUTS.prizepicks_flex[n]);
  } else if (book === 'UD') {
    const boost = legs.reduce((m, l) => m * (l.mult || 1), 1);
    const std = PAYOUTS.underdog_standard[n];
    if (std) add('underdog_standard', { [n]: +(std[n] * boost).toFixed(4) });
    if (legs.every(l => Math.abs((l.mult || 1) - 1) < 1e-6)) add('underdog_flex', PAYOUTS.underdog_flex[n]);
  } else if (book === 'SL') {
    if (n >= 2 && legs.every(l => l.mult > 1)) add('sleeper', { [n]: +legs.reduce((m, l) => m * l.mult, 1).toFixed(4) });
  } else if (book === 'P6') {
    // Pick6's table (the last read's, else slip.js); a pick's own multiplier (1x, 0.9x on a
    // favoured side) multiplies what a clean sweep pays, the near-miss rows stay as posted
    const t = (pick6Table || PICK6_PAYOUTS)[n];
    if (t) {
      const boost = legs.reduce((m, l) => m * (l.mult > 0 ? l.mult : 1), 1);
      add('pick6', { ...t, [n]: +(t[n] * boost).toFixed(4) });
    }
  }
  return out.sort((a, b) => b.ev - a.ev);
}

// Greedy: start from the best leg, then add whichever leg lifts the entry most.
// The choice at each step doesn't depend on the final size, so one pass gives
// the best entry at every size. One pick per player, and the apps want at least
// two teams in an entry.
function buildForBook(pool, book, maxLegs, { poolMax = POOL_MAX, oneMatch = false, pick6Table = null } = {}) {
  let rest = pool.slice().sort((a, b) => b.ev - a.ev);
  if (oneMatch) {
    // the best few legs of each match, so one busy match can't fill the pool
    const per = new Map();
    rest = rest.filter(l => { const k = matchKey(l); if (!k) return true; const n = per.get(k) || 0; per.set(k, n + 1); return n < 2; });
  }
  rest = rest.slice(0, poolMax);
  const chosen = [];
  const sizes = [];
  while (chosen.length < maxLegs && rest.length) {
    const players = new Set(chosen.map(l => norm(l.player)));
    const matches = new Set(chosen.map(matchKey).filter(Boolean));
    const teams = new Set(chosen.map(l => norm(l.team)).filter(Boolean));
    const oneTeam = chosen.length > 0 && teams.size === 1 && chosen.every(l => norm(l.team));
    let bestIdx = -1, best = null;
    for (let i = 0; i < rest.length; i++) {
      const c = rest[i];
      if (players.has(norm(c.player))) continue;
      if (oneMatch && matches.has(matchKey(c))) continue;
      if (oneTeam && teams.has(norm(c.team))) continue;
      if (!chosen.length) { bestIdx = i; break; }
      const priced = priceOn(book, [...chosen, c], { pick6Table })[0];
      if (priced && (!best || priced.ev > best.ev)) { best = priced; bestIdx = i; }
    }
    if (bestIdx < 0) break;
    chosen.push(rest.splice(bestIdx, 1)[0]);
    if (best) sizes.push({ ...best, picks: chosen.slice() });
  }
  // +EV sizes by growth first, then the rest by how close they come
  return sizes.sort((a, b) => (b.growth > 0) - (a.growth > 0) || (b.growth - a.growth) || (b.ev - a.ev));
}

// ── SAME-MATCH STACKS ────────────────────────────────────────────────────────
// Legs from one CS or LoL match move together (slip.js FACTORS, measured on
// finished series): when the match runs long, everyone's kills go over. The
// apps price an entry as if its legs were independent, so a stack of one
// match's overs (or unders) can be +EV even when every leg alone is a little
// short. PrizePicks says it lowers the payout for lineups with several players
// from one team or game, so every stack carries the payout it needs
// (breakEvenPays): play it only where the app shows at least that.
const STACK_FLOOR = -15;   // % EV: a leg this far short still can't help a stack
const STACK_POOL = 16;     // legs per match the search looks at
const STACKS_PER_BOOK = 5;
const PP_BREAK_EVEN = 0.5622;

// PrizePicks takes either side of a standard line, so a leg's other side is a
// candidate too (a stack wants every leg on the same side). Half lines only,
// where the two sides cover every outcome.
function otherSide(l) {
  if (!(Math.abs(l.line % 1) === 0.5) || !(l.prob > 0 && l.prob < 1)) return null;
  const prob = 1 - l.prob;
  return { ...l, side: l.side === 'OVER' ? 'UNDER' : 'OVER', prob, ev: +((prob / PP_BREAK_EVEN - 1) * 100).toFixed(2), shift: -(l.shift || 0), flipped: true };
}

// One match's legs on BOOK → the best stack for each side pattern
function stackForMatch(legs, book) {
  const maxLegs = MAX_LEGS[book];
  const cands = [];
  for (const l of legs) {
    cands.push(l);
    if (book === 'PP') { const o = otherSide(l); if (o) cands.push(o); }
  }
  const out = [];
  for (const want of ['OVER', 'UNDER']) {
    const pool = cands.filter(l => l.side === want && l.ev >= STACK_FLOOR).sort((a, b) => b.ev - a.ev).slice(0, STACK_POOL);
    if (new Set(pool.map(l => norm(l.team))).size < 2) continue;
    for (const s of buildForBook(pool, book, maxLegs, { poolMax: STACK_POOL })) {
      if (new Set(s.picks.map(l => norm(l.team))).size < 2) continue;   // the apps want two teams
      out.push(s);
    }
  }
  return out;
}

function stacksForBook(legs, book) {
  const games = new Map();
  for (const l of legs) {
    if (!l.gameId || !l.team || !factorSport(l.sport)) continue;
    if (!games.has(l.gameId)) games.set(l.gameId, []);
    games.get(l.gameId).push(l);
  }
  const best = [];
  for (const g of games.values()) {
    if (new Set(g.map(l => norm(l.team))).size < 2) continue;
    // one leg per player: the board already holds one market per player per book
    const sizes = stackForMatch(g, book).filter(s => s.ev > 0 && s.correlated);
    sizes.sort((a, b) => (b.growth - a.growth) || (b.ev - a.ev));
    if (sizes.length) best.push(sizes[0]);
  }
  return best.sort((a, b) => (b.growth - a.growth) || (b.ev - a.ev)).slice(0, STACKS_PER_BOOK);
}

// The same stack if its legs hit GAP (a fraction: −0.08 is eight points) off
// their prices, as the stack record says they have so far (sliptrack.js
// legs.gap). Priced on the same table, so its breakEvenPays is the payout the
// stack needs if the legs keep hitting like that.
function atRecord(book, s, gap) {
  if (!Number.isFinite(gap) || !gap) return null;
  const legs = s.picks.map(l => {
    const prob = Math.min(0.98, Math.max(0.02, l.prob + gap));
    return { ...l, prob, shift: shiftTo(l, prob) };
  });
  const r = priceOn(book, legs).find(x => x.table === s.table);
  return r ? { gap, ev: r.ev, probAll: r.probAll, breakEvenScale: r.breakEvenScale } : null;
}

// The board → (book, logged stack leg) → that leg's price on the book now, at
// the book's current line: { line, prob in % } or null. The stack record follows
// each leg with it until the match starts (sliptrack follow), for the close.
function stackLegLookup(picks) {
  const key = (player, gameId, market) => [norm(player), gameId ?? '', String(market || '').toLowerCase()].join('|');
  const byKey = new Map((picks || []).map(p => [key(p.player, p.gameId, p.market), p]));
  return (book, leg) => {
    const p = byKey.get(key(leg.player, leg.gameId, leg.market));
    if (!p) return null;
    let q = bookLeg(p, book, { side: leg.side });
    // PrizePicks takes the other side of a half line too (otherSide)
    if (!q && book === 'PP') { const o = bookLeg(p, book); q = o && o.side !== leg.side ? otherSide(o) : null; }
    return q ? { line: q.line, prob: q.prob * 100 } : null;
  };
}

const BOOK_NAMES = { PP: 'PrizePicks', UD: 'Underdog', SL: 'Sleeper', P6: 'DK Pick6' };
const TABLE_NAMES = {
  prizepicks_power: 'Power', prizepicks_flex: 'Flex', underdog_standard: 'Standard', underdog_flex: 'Flex', sleeper: 'Picks', pick6: 'Picks',
};

const r1 = x => Math.round(x * 10) / 10;

function present(book, s, kind = 'best') {
  const n = s.picks.length;
  const table = s.table;
  const prod = s.picks.reduce((m, l) => m * (l.mult || 1), 1);
  // what a sweep pays; flex tables also pay on a miss or two (hits[] has the odds)
  const pays = table === 'sleeper' ? prod
    : table === 'pick6' ? s.payTable?.[n] ?? null
    : table === 'underdog_standard' ? PAYOUTS.underdog_standard[n][n] * prod
    : PAYOUTS[table]?.[n]?.[n] ?? null;
  return {
    book, bookName: BOOK_NAMES[book], table, tableName: TABLE_NAMES[table] || table, legs: n, kind,
    status: s.ev > 0 ? 'plus' : 'near',
    // the sweep payout this entry needs to break even; an app that cuts the
    // payout below it (correlated lineups) makes it a pass
    breakEvenPays: pays != null && s.breakEvenScale != null ? +(pays * s.breakEvenScale).toFixed(2) : null,
    matchTitle: kind === 'stack' ? [...new Set(s.picks.map(l => l.team).filter(Boolean))].join(' vs ') : undefined,
    // a stack priced again at the legs' record so far (atRecord), when there is one
    atRecord: s.atRecord ? {
      gap: +(s.atRecord.gap * 100).toFixed(1), ev: s.atRecord.ev, probAll: +s.atRecord.probAll.toFixed(4),
      breakEvenPays: pays != null ? +(pays * s.atRecord.breakEvenScale).toFixed(2) : null,
    } : undefined,
    ev: s.ev, evIndependent: s.evIndependent, probAll: +s.probAll.toFixed(4), correlated: s.correlated,
    paysAll: pays != null ? +pays.toFixed(2) : null,
    // what 1u returns on each hit count, for grading (sliptrack.js)
    payTable: pays == null ? null : table === 'pick6' ? { ...s.payTable } : table === 'sleeper' || table === 'underdog_standard' || table === 'prizepicks_power' ? { [n]: +pays.toFixed(4) } : { ...PAYOUTS[table][n] },
    hits: s.hits, kelly: s.kelly, growth: +(s.growth || 0).toFixed(6),
    picks: s.picks.map(l => ({
      player: l.player, team: l.team, sport: l.sport, market: l.market, rawMarket: l.rawMarket, side: l.side, line: l.line,
      gameId: l.gameId, matchTitle: l.matchTitle,
      prob: r1(l.prob * 100), ev: l.ev, mult: l.mult, startTime: l.startTime, flipped: l.flipped || undefined, fair: l.fair,
    })),
  };
}

// picks: the esports board → { slips: [best per book, fastest growth first], books: { PP: [...every size] }, pool }
// stackLegGap: how far (a fraction) the stack record's legs have hit off their
// prices; each stack is also priced at that (atRecord). Left out, it isn't.
function autoSlips(picks, { now = Date.now(), near = NEAR_PCT, withStacks = true, pick6 = null, pick6Table = null, stackLegGap = null } = {}) {
  const live = (picks || []).filter(p => {
    const t = Date.parse(p.startTime);
    return p.pricing && p.side && !(Number.isFinite(t) && t <= now);
  });
  const books = {}, pool = {}, slips = [], stacks = {};
  // Pick6 is a book here only while its esports lines are being read (pick6 is then a Map)
  for (const book of pick6?.size ? ['PP', 'UD', 'SL', 'P6'] : ['PP', 'UD', 'SL']) {
    const all = live.map(p => bookLeg(p, book, { bettable: true, pick6 })).filter(Boolean);
    const legs = all.filter(l => l.ev >= LEG_FLOOR);
    pool[book] = { legs: legs.length, plus: legs.filter(l => l.ev > 0).length, model: legs.filter(l => l.fair !== 'market').length };
    const sizes = buildForBook(legs, book, MAX_LEGS[book], { oneMatch: true, pick6Table }).filter(s => s.ev > -near).map(s => present(book, s));
    books[book] = sizes;
    if (sizes.length) slips.push(sizes[0]);
    stacks[book] = withStacks && book !== 'P6'
      ? stacksForBook(all, book).map(s => present(book, { ...s, atRecord: atRecord(book, s, stackLegGap) }, 'stack')) : [];
  }
  slips.sort((a, b) => (b.growth > 0) - (a.growth > 0) || (b.growth - a.growth) || (b.ev - a.ev));
  const stackList = Object.values(stacks).flat().sort((a, b) => (b.growth - a.growth) || (b.ev - a.ev));
  return { slips, books, pool, nearPct: near, stacks: stackList, stacksByBook: stacks };
}

// One slip the user built, priced on each book that takes every leg, at that
// book's own lines → { PP: entry | null, UD: ..., SL: ... }. A book that doesn't
// carry a leg, or wants two picks on one player, can't take the slip.
// SIDES: the side picked for each leg (the slip bar), else the fair's lean.
function priceOnBooks(picks, sides = [], { pick6 = null, pick6Table = null } = {}) {
  const out = {};
  for (const book of pick6?.size ? ['PP', 'UD', 'SL', 'P6'] : ['PP', 'UD', 'SL']) {
    const legs = picks.map((p, i) => p && bookLeg(p, book, { side: sides[i] || null, pick6 }));
    const players = new Set(legs.map(l => l && norm(l.player)));
    const best = legs.length >= 2 && legs.every(Boolean) && players.size === legs.length ? priceOn(book, legs, { pick6Table })[0] : null;
    out[book] = best ? present(book, { ...best, picks: legs }) : null;
  }
  return out;
}

module.exports = { autoSlips, priceOnBooks, bookLeg, matchKey, priceOn, buildForBook, stacksForBook, otherSide, atRecord, stackLegLookup, LEG_FLOOR, NEAR_PCT, STACK_FLOOR };
