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

const { priceSlip, PAYOUTS } = require('./slip');

const LEG_FLOOR = -6;      // % EV: legs further below their book's break-even never help a slip
const POOL_MAX = 20;       // best legs per book the greedy search looks at
const NEAR_PCT = 5;        // a slip within 5% of break-even is 'near'
const MAX_LEGS = { PP: 6, UD: 5, SL: 6 };

const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// One pick → the leg as BOOK takes it, or null when that book doesn't carry it
function bookLeg(p, book) {
  const b = p.pricing?.books?.[book];
  if (!b || !p.side) return null;
  const ev = book === 'PP' ? p.ppEv : book === 'UD' ? p.udEv : p.sleeperEv;
  if (ev == null || !Number.isFinite(b.prob)) return null;
  if (book === 'UD' && b.decimal) return null;   // decimal-priced Underdog legs pay differently
  return {
    player: p.player, team: p.team || '', gameId: p.gameId ?? null, sport: p.sport,
    market: p.displayMarket || p.market, rawMarket: p.market, side: p.side, startTime: p.startTime || '',
    line: b.line, prob: b.prob, ev, mult: b.mult ?? null, shift: b.shift || 0,
    meanPerMap: p.pricing.meanPerMap, k: p.pricing.k, stat: p.pricing.stat, scenarios: p.pricing.scenarios,
  };
}

// Every table BOOK offers for these legs, best EV first
function priceOn(book, legs) {
  const n = legs.length;
  const out = [];
  const add = (name, table) => { if (table) { const r = priceSlip(legs, name, { [name]: { [n]: table } }); if (r) out.push(r); } };
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
function buildForBook(pool, book, maxLegs) {
  const rest = pool.slice().sort((a, b) => b.ev - a.ev).slice(0, POOL_MAX);
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
  return sizes.sort((a, b) => b.ev - a.ev);
}

const BOOK_NAMES = { PP: 'PrizePicks', UD: 'Underdog', SL: 'Sleeper' };
const TABLE_NAMES = {
  prizepicks_power: 'Power', prizepicks_flex: 'Flex', underdog_standard: 'Standard', underdog_flex: 'Flex', sleeper: 'Picks',
};

const r1 = x => Math.round(x * 10) / 10;

function present(book, s) {
  const n = s.picks.length;
  const table = s.table;
  const prod = s.picks.reduce((m, l) => m * (l.mult || 1), 1);
  // what a sweep pays; flex tables also pay on a miss or two (hits[] has the odds)
  const pays = table === 'sleeper' ? prod
    : table === 'underdog_standard' ? PAYOUTS.underdog_standard[n][n] * prod
    : PAYOUTS[table]?.[n]?.[n] ?? null;
  return {
    book, bookName: BOOK_NAMES[book], table, tableName: TABLE_NAMES[table] || table, legs: n,
    status: s.ev > 0 ? 'plus' : 'near',
    ev: s.ev, evIndependent: s.evIndependent, probAll: +s.probAll.toFixed(4), correlated: s.correlated,
    paysAll: pays != null ? +pays.toFixed(2) : null,
    hits: s.hits, kelly: s.kelly,
    picks: s.picks.map(l => ({
      player: l.player, team: l.team, sport: l.sport, market: l.market, rawMarket: l.rawMarket, side: l.side, line: l.line,
      prob: r1(l.prob * 100), ev: l.ev, mult: l.mult, startTime: l.startTime,
    })),
  };
}

// picks: the esports board → { slips: [best per book, +EV first], books: { PP: [...every size] }, pool }
function autoSlips(picks, { now = Date.now(), near = NEAR_PCT } = {}) {
  const live = (picks || []).filter(p => {
    const t = Date.parse(p.startTime);
    return p.pricing && p.side && !(Number.isFinite(t) && t <= now);
  });
  const books = {}, pool = {}, slips = [];
  for (const book of ['PP', 'UD', 'SL']) {
    const legs = live.map(p => bookLeg(p, book)).filter(l => l && l.ev >= LEG_FLOOR);
    pool[book] = { legs: legs.length, plus: legs.filter(l => l.ev > 0).length };
    const sizes = buildForBook(legs, book, MAX_LEGS[book]).filter(s => s.ev > -near).map(s => present(book, s));
    books[book] = sizes;
    if (sizes.length) slips.push(sizes[0]);
  }
  slips.sort((a, b) => b.ev - a.ev);
  return { slips, books, pool, nearPct: near };
}

module.exports = { autoSlips, bookLeg, priceOn, buildForBook, LEG_FLOOR, NEAR_PCT };
