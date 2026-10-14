// ─── AUTO-BUILT SLIPS ─────────────────────────────────────────────────────────
// The best entry each pick'em book will take right now, built from the board's
// priced legs. A slip is placed on one book, so every leg is priced at THAT
// book's line and payout: PrizePicks power and flex tables, Underdog standard
// and flex (a boosted or discounted Underdog leg scales a standard entry's
// payout, and isn't allowed in flex here), Sleeper's legs multiplied together.
// slip.js prices the entry with legs from one series moving together.
//
// The board often has only a handful of +EV legs, so a book's best slip can sit
// just under break-even. That slip is still shown, marked 'near', so it's clear
// which entry is closest and by how much it falls short.

const { priceSlip, PAYOUTS, factorSport } = require('./slip');

const LEG_FLOOR = -6;      // % EV: legs further below their book's break-even never help a slip
const POOL_MAX = 20;       // best legs per book the greedy search looks at
const NEAR_PCT = 5;        // a slip within 5% of break-even is 'near'
const MAX_LEGS = { PP: 6, UD: 6, SL: 6 };

const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// One pick → the leg as BOOK takes it, or null when that book doesn't carry it
function bookLeg(p, book) {
  const b = p.pricing?.books?.[book];
  if (!b || !p.side) return null;
  const ev = book === 'PP' ? p.ppEv : book === 'UD' ? p.udEv : p.sleeperEv;
  if (ev == null || !Number.isFinite(b.prob)) return null;
  if (book === 'UD' && b.decimal) return null;   // decimal-priced Underdog legs pay differently
  return {
    player: p.player, team: p.team || '', gameId: p.gameId ?? null, sport: p.sport, matchTitle: p.matchTitle || '',
    market: p.displayMarket || p.market, rawMarket: p.market, side: p.side, startTime: p.startTime || '',
    line: b.line, prob: b.prob, ev, mult: b.mult ?? null, shift: b.shift || 0,
    meanPerMap: p.pricing.meanPerMap, k: p.pricing.k, stat: p.pricing.stat, scenarios: p.pricing.scenarios,
  };
}

// Expected log growth of a bankroll staking the slip's own Kelly fraction. EV
// alone always favours the longest entry (a 6-pick at +60% that hits 4% of the
// time); growth is what the bankroll actually compounds at, so it picks which
// size to play.
function growth(r, table) {
  if (!(r.kelly > 0)) return 0;
  return r.hits.reduce((g, p, h) => g + p * Math.log(1 + r.kelly * ((table[h] || 0) - 1)), 0);
}

// Every table BOOK offers for these legs, best EV first
function priceOn(book, legs) {
  const n = legs.length;
  const out = [];
  const add = (name, table) => { if (table) { const r = priceSlip(legs, name, { [name]: { [n]: table } }); if (r) out.push({ ...r, growth: growth(r, table) }); } };
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
  }
  return out.sort((a, b) => b.ev - a.ev);
}

// Greedy: start from the best leg, then add whichever leg lifts the entry most.
// The choice at each step doesn't depend on the final size, so one pass gives
// the best entry at every size. One pick per player, and the apps want at least
// two teams in an entry.
function buildForBook(pool, book, maxLegs, { poolMax = POOL_MAX } = {}) {
  const rest = pool.slice().sort((a, b) => b.ev - a.ev).slice(0, poolMax);
  const chosen = [];
  const sizes = [];
  while (chosen.length < maxLegs && rest.length) {
    const players = new Set(chosen.map(l => norm(l.player)));
    const teams = new Set(chosen.map(l => norm(l.team)).filter(Boolean));
    const oneTeam = chosen.length > 0 && teams.size === 1 && chosen.every(l => norm(l.team));
    let bestIdx = -1, best = null;
    for (let i = 0; i < rest.length; i++) {
      const c = rest[i];
      if (players.has(norm(c.player))) continue;
      if (oneTeam && teams.has(norm(c.team))) continue;
      if (!chosen.length) { bestIdx = i; break; }
      const priced = priceOn(book, [...chosen, c])[0];
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

const BOOK_NAMES = { PP: 'PrizePicks', UD: 'Underdog', SL: 'Sleeper' };
const TABLE_NAMES = {
  prizepicks_power: 'Power', prizepicks_flex: 'Flex', underdog_standard: 'Standard', underdog_flex: 'Flex', sleeper: 'Picks',
};

const r1 = x => Math.round(x * 10) / 10;

function present(book, s, kind = 'best') {
  const n = s.picks.length;
  const table = s.table;
  const prod = s.picks.reduce((m, l) => m * (l.mult || 1), 1);
  // what a sweep pays; flex tables also pay on a miss or two (hits[] has the odds)
  const pays = table === 'sleeper' ? prod
    : table === 'underdog_standard' ? PAYOUTS.underdog_standard[n][n] * prod
    : PAYOUTS[table]?.[n]?.[n] ?? null;
  return {
    book, bookName: BOOK_NAMES[book], table, tableName: TABLE_NAMES[table] || table, legs: n, kind,
    status: s.ev > 0 ? 'plus' : 'near',
    // the sweep payout this entry needs to break even; an app that cuts the
    // payout below it (correlated lineups) makes it a pass
    breakEvenPays: pays != null && s.breakEvenScale != null ? +(pays * s.breakEvenScale).toFixed(2) : null,
    matchTitle: kind === 'stack' ? [...new Set(s.picks.map(l => l.team).filter(Boolean))].join(' vs ') : undefined,
    ev: s.ev, evIndependent: s.evIndependent, probAll: +s.probAll.toFixed(4), correlated: s.correlated,
    paysAll: pays != null ? +pays.toFixed(2) : null,
    // what 1u returns on each hit count, for grading (sliptrack.js)
    payTable: pays == null ? null : table === 'sleeper' || table === 'underdog_standard' || table === 'prizepicks_power' ? { [n]: +pays.toFixed(4) } : { ...PAYOUTS[table][n] },
    hits: s.hits, kelly: s.kelly, growth: +(s.growth || 0).toFixed(6),
    picks: s.picks.map(l => ({
      player: l.player, team: l.team, sport: l.sport, market: l.market, rawMarket: l.rawMarket, side: l.side, line: l.line,
      gameId: l.gameId, matchTitle: l.matchTitle,
      prob: r1(l.prob * 100), ev: l.ev, mult: l.mult, startTime: l.startTime, flipped: l.flipped || undefined,
    })),
  };
}

// picks: the esports board → { slips: [best per book, fastest growth first], books: { PP: [...every size] }, pool }
function autoSlips(picks, { now = Date.now(), near = NEAR_PCT, withStacks = true } = {}) {
  const live = (picks || []).filter(p => {
    const t = Date.parse(p.startTime);
    return p.pricing && p.side && !(Number.isFinite(t) && t <= now);
  });
  const books = {}, pool = {}, slips = [], stacks = {};
  for (const book of ['PP', 'UD', 'SL']) {
    const all = live.map(p => bookLeg(p, book)).filter(Boolean);
    const legs = all.filter(l => l.ev >= LEG_FLOOR);
    pool[book] = { legs: legs.length, plus: legs.filter(l => l.ev > 0).length };
    const sizes = buildForBook(legs, book, MAX_LEGS[book]).filter(s => s.ev > -near).map(s => present(book, s));
    books[book] = sizes;
    if (sizes.length) slips.push(sizes[0]);
    stacks[book] = withStacks ? stacksForBook(all, book).map(s => present(book, s, 'stack')) : [];
  }
  slips.sort((a, b) => (b.growth > 0) - (a.growth > 0) || (b.growth - a.growth) || (b.ev - a.ev));
  const stackList = Object.values(stacks).flat().sort((a, b) => (b.growth - a.growth) || (b.ev - a.ev));
  return { slips, books, pool, nearPct: near, stacks: stackList, stacksByBook: stacks };
}

// One slip the user built, priced on each book that takes every leg, at that
// book's own lines → { PP: entry | null, UD: ..., SL: ... }. A book that doesn't
// carry a leg, or wants two picks on one player, can't take the slip.
function priceOnBooks(picks) {
  const out = {};
  for (const book of ['PP', 'UD', 'SL']) {
    const legs = picks.map(p => p && bookLeg(p, book));
    const players = new Set(legs.map(l => l && norm(l.player)));
    const best = legs.length >= 2 && legs.every(Boolean) && players.size === legs.length ? priceOn(book, legs)[0] : null;
    out[book] = best ? present(book, { ...best, picks: legs }) : null;
  }
  return out;
}

module.exports = { autoSlips, priceOnBooks, bookLeg, priceOn, buildForBook, stacksForBook, otherSide, LEG_FLOOR, NEAR_PCT, STACK_FLOOR };
