// ─── MLB BOARD: EVERY APP LEG NEXT TO PINNACLE'S OWN NUMBER ─────────────────
// For each MLB player prop the pick'em apps hang (PrizePicks, Underdog,
// Sleeper, DK Pick6) and Pinnacle also prices, this puts the app's number next
// to Pinnacle's own line and no-vig price, and FanDuel's and BetRivers' where
// they post the same stat. Pre-registered 2026-10-25 before any MLB leg was
// matched (checks/mlb-ws-2026-10-25/PREREGISTERED.md):
//
//   gap leg   the app's line differs from Pinnacle's. Side: Over when
//             Pinnacle's line is higher, Under when it is lower (the app's
//             number is on the good side of Pinnacle's). Kinds, one per app,
//             never pooled: mlb-pin (PrizePicks), p6-mlb-pin, ud-mlb-pin, sl-mlb-pin.
//   even leg  the same number: the side Pinnacle's no-vig price favours. A
//             control, never a play: mlb-even, p6-mlb-even, ud-mlb-even, sl-mlb-even.
//
// A kind is a bet only at 50+ graded live legs with the hit rate 2+ standard
// errors above its app's break-even and an independent re-check. Until then
// it is a lead: no alerts, research record only.
//
// Results: the MLB Stats API box score (statsapi.mlb.com, no key) carries
// total bases, singles, doubles, stolen bases and walks, which ESPN's box
// doesn't; parseMlbBox / mlbStat read it, sportgrade.js uses them for MLB
// first and ESPN as the second source.
//
// Pure functions: the server and the backtest (checks/mlb-ws-2026-10-25) feed
// rows in the same shape.

const { canonName } = require('./ev');
const NS = require('./nflsunday');
const SP = require('./sportprops');

const APPS = ['prizepicks', 'underdog', 'sleeper', 'pick6'];
const GAP_KIND = { prizepicks: 'mlb-pin', pick6: 'p6-mlb-pin', underdog: 'ud-mlb-pin', sleeper: 'sl-mlb-pin' };
const EVEN_KIND = { prizepicks: 'mlb-even', pick6: 'p6-mlb-even', underdog: 'ud-mlb-even', sleeper: 'sl-mlb-even' };
const KINDS = new Set([...Object.values(GAP_KIND), ...Object.values(EVEN_KIND)]);
const EVEN = new Set(Object.values(EVEN_KIND));
const appOfKind = k => Object.keys(GAP_KIND).find(a => GAP_KIND[a] === k || EVEN_KIND[a] === k) || null;
const EPS = 1e-9;
const r4 = x => Math.round(x * 1e4) / 1e4;

// ── results: the MLB Stats API box score ──
// /api/v1/game/{gamePk}/boxscore → Map(canonName → { name, team, bat, pit })
function parseMlbBox(box) {
  const out = new Map();
  for (const side of ['home', 'away']) {
    const t = box?.teams?.[side];
    for (const p of Object.values(t?.players || {})) {
      const bat = p?.stats?.batting || {}, pit = p?.stats?.pitching || {};
      const name = p?.person?.fullName;
      if (!name || (!Object.keys(bat).length && !Object.keys(pit).length)) continue;
      out.set(canonName(name), { name, team: t.team?.name || '', bat, pit });
    }
  }
  return out;
}
const n = v => (Number.isFinite(Number(v)) ? Number(v) : null);
const has = o => o && Object.keys(o).length > 0;
// a hitter with no plate appearance (on the card, never batted) is void at
// the apps, so his batting stats read null
const batted = b => has(b) && (n(b.plateAppearances) ?? n(b.atBats) ?? 0) + (n(b.baseOnBalls) || 0) > 0;
// market key → the stat off one player's box, or null (no stat: stays ungraded)
const BAT = {
  hits: b => n(b.hits), runs: b => n(b.runs), rbis: b => n(b.rbi), home_runs: b => n(b.homeRuns),
  total_bases: b => n(b.totalBases), walks: b => n(b.baseOnBalls), batter_walks: b => n(b.baseOnBalls),
  stolen_bases: b => n(b.stolenBases), doubles: b => n(b.doubles), triples: b => n(b.triples),
  singles: b => (b.hits == null ? null : n(b.hits) - (n(b.doubles) || 0) - (n(b.triples) || 0) - (n(b.homeRuns) || 0)),
  hits_runs_rbis: b => (b.hits == null ? null : n(b.hits) + (n(b.runs) || 0) + (n(b.rbi) || 0)),
  batter_strikeouts: b => n(b.strikeOuts), hitter_strikeouts: b => n(b.strikeOuts),
};
const PIT = {
  strikeouts: p => n(p.strikeOuts), pitcher_strikeouts: p => n(p.strikeOuts), pitcher_outs: p => n(p.outs),
  hits_allowed: p => n(p.hits), earned_runs: p => n(p.earnedRuns), walks_allowed: p => n(p.baseOnBalls),
  pitcher_walks_allowed: p => n(p.baseOnBalls), pitches_thrown: p => n(p.numberOfPitches ?? p.pitchesThrown),
};
const MLB_MARKETS = [...Object.keys(BAT), ...Object.keys(PIT)];
function mlbStat(mkey, player) {
  if (!player) return null;
  if (PIT[mkey]) return has(player.pit) && (n(player.pit.battersFaced) ?? 1) > 0 ? PIT[mkey](player.pit) : null;
  if (BAT[mkey]) return batted(player.bat) ? BAT[mkey](player.bat) : null;
  return null;
}

// ── Pinnacle's own number for a row ──
// quotes: Pinnacle's quotes for the row's game ({ line, pOver, over, under }).
// Its main line is the one nearest 50/50 (an alternate rung is never the main).
function pinMain(quotes) {
  const qs = (quotes || []).filter(q => Number.isFinite(q?.line) && q.pOver > 0 && q.pOver < 1);
  if (!qs.length) return null;
  return qs.reduce((a, b) => (Math.abs(b.pOver - 0.5) < Math.abs(a.pOver - 0.5) ? b : a));
}
// P(over) at `line` off Pinnacle's main: its own price when it sits there,
// else the stat's curve through its number ({ p, exact })
function pinAtLine(mkey, pin, line) {
  if (!pin) return null;
  if (Math.abs(pin.line - line) < EPS) return { p: pin.pOver, exact: true };
  if (SP.K[mkey] == null) return null;
  const mean = SP.meanFor(mkey, 'MLB', pin.line, pin.pOver);
  const p = SP.pOver(mkey, 'MLB', mean, line);
  return Number.isFinite(p) && p > 0 && p < 1 ? { p, exact: false } : null;
}

// one app cell → the leg against Pinnacle, or null
// { app, kind, rel: 'gap'|'even', side, line, gap, pinLine, pinOver, fair, exact, be, ev, mult }
function classify(app, cell, pin, mkey) {
  if (!cell || cell.line == null || !pin) return null;
  const line = Number(cell.line);
  let side, rel;
  if (Math.abs(pin.line - line) < EPS) { rel = 'even'; side = pin.pOver >= 0.5 ? 'Over' : 'Under'; }
  else { rel = 'gap'; side = pin.line > line ? 'Over' : 'Under'; }
  if (side === 'Over' ? cell.overOpen === false : cell.underOpen === false) return null;
  const v = [line, cell.over ?? null, cell.under ?? null, 1, 1];
  const be = NS.breakEven(app, side, v);
  if (!(be > 0 && be < 1)) return null;
  const at = pinAtLine(mkey, pin, line);
  const fair = at ? (side === 'Over' ? at.p : 1 - at.p) : null;
  const mult = side === 'Over' ? cell.over ?? 1 : cell.under ?? 1;
  return { app, kind: (rel === 'gap' ? GAP_KIND : EVEN_KIND)[app], rel, side, line, gap: +Math.abs(pin.line - line).toFixed(2), pinLine: pin.line, pinOver: r4(pin.pOver),
    fair: fair == null ? null : r4(fair), exact: !!at?.exact, be: r4(be), ev: fair == null ? null : +((fair / be - 1) * 100).toFixed(2), mult };
}

// rows: props-board rows. pinFor(row) → Pinnacle's quotes for the row's game.
// booksFor(row) → FanDuel/BetRivers quotes [{ book, line, pOver }] (optional).
// → [{ row, pin, books, legs: [classify…] }] for MLB rows Pinnacle prices
function board(rows, { pinFor, booksFor = null, apps = APPS } = {}) {
  const out = [];
  for (const row of rows || []) {
    if (row?.sport !== 'MLB' || row.esports || !row.mkey || String(row.mkey).includes('|')) continue;
    const pin = pinMain(pinFor(row));
    if (!pin) continue;
    const legs = apps.map(a => classify(a, row.books?.[a], pin, row.mkey)).filter(Boolean);
    if (!legs.length) continue;
    const books = booksFor ? (booksFor(row) || []).filter(q => q.book !== 'pinnacle' && Number.isFinite(q.line)) : [];
    out.push({ row, pin, books, legs });
  }
  return out;
}

// the record: every leg goes in under its kind (gap and even alike), as the
// app shows it now. play: what sporttrack.record logs.
function plays(rows, opts) {
  const out = [];
  for (const { row, legs } of board(rows, opts)) {
    for (const l of legs) {
      out.push({ row, kind: l.kind, research: true,
        play: { book: l.app, side: l.side, line: l.line, mult: l.mult, decimal: r4(1 / l.be), fair: l.fair, ev: l.ev, pinLine: l.pinLine, pinOver: l.pinOver, gapPts: l.gap, exact: l.exact } });
    }
  }
  return out;
}

// a sportsbook's P(over) at `line` from its quotes for the stat
// ([{ book, line, pOver }]): its own price at that number, else the curve
// through the quote nearest it → { pOver, source, exact } | null
function priceFrom(quotes, mkey, line) {
  const qs = (quotes || []).filter(q => Number.isFinite(q?.line) && q.pOver > 0 && q.pOver < 1);
  if (!qs.length) return null;
  const q = qs.reduce((a, b) => (Math.abs(b.line - line) < Math.abs(a.line - line) ? b : a));
  const at = pinAtLine(mkey, { line: q.line, pOver: q.pOver }, line);
  return at ? { pOver: at.p, source: q.book, exact: at.exact } : null;
}

// the close for a leg of these kinds: Pinnacle's P(over) at the leg's number
// (its own price when it sits there, else the curve), and its raw number
function closeAt(row, line, quotes) {
  const pin = pinMain(quotes);
  if (!pin) return null;
  const at = pinAtLine(row.mkey, pin, line);
  return at ? { pOver: at.p, exact: at.exact, x: pin.line, pinOver: pin.pOver } : null;
}

// ── the bar ──
const BE = { prizepicks: 0.5503, pick6: 0.567, underdog: 0.5623, sleeper: null };
function zOf(w, nn, be) { return nn && be ? +((w - nn * be) / Math.sqrt(nn * be * (1 - be))).toFixed(2) : null; }
// graded legs [{ outcome, signalDecimal, profit }] → the tally against be
function tally(legs, be) {
  const g = legs.filter(l => l.outcome === 'win' || l.outcome === 'loss');
  const w = g.filter(l => l.outcome === 'win').length;
  const bar = be ?? (g.length ? g.reduce((a, l) => a + 1 / (l.signalDecimal || 2), 0) / g.length : null);
  return { n: g.length, w, l: g.length - w, hit: g.length ? r4(w / g.length) : null, be: bar == null ? null : r4(bar), z: zOf(w, g.length, bar),
    units: +g.reduce((a, l) => a + (l.profit ?? (l.outcome === 'win' ? (l.signalDecimal || 2) - 1 : -1)), 0).toFixed(2),
    passes: g.length >= 50 && zOf(w, g.length, bar) >= 2 };
}

// ── same-game stacks ──
// Two-team stacks of one game on one app: a starter's strikeouts Over with
// the other team's hitters, in the direction the box scores link them
// (checks/corr-pairs-2026-10-24: Ks Over + opposing hitter H+R+RBI Under
// phi .117, + opposing hitter strikeouts Over .231). Each leg is priced at its
// own number by priceOf(row, line) → { pOver, source, exact } (Pinnacle, else
// FanDuel or BetRivers); a leg nothing prices leaves the stack out. At the
// repriced payout (slips.js) the link cancels, so a stack clears only if
// its legs' own prices do: clears = P(all) x repriced payout > 1.
// → [{ app, game, players, sources, exact, linked, pInd, pLinked, standard, repriced, evStd, evRep, clears }]
const OPP_SIDE = { hits_runs_rbis: 'Under', batter_strikeouts: 'Over', hitter_strikeouts: 'Over' };
function stacks(rows, { priceOf, slips, tables = { prizepicks: { 2: 3, 3: 6 }, pick6: { 3: 5.5 } }, maxPerGame = 6 } = {}) {
  const out = [];
  const byGame = new Map();
  for (const row of rows || []) {
    if (row?.sport !== 'MLB' || row.esports || !row.team) continue;
    const g = `${row.startTime}|${row.matchTitle || ''}`;
    if (!byGame.has(g)) byGame.set(g, []);
    byGame.get(g).push(row);
  }
  for (const [game, list] of byGame) {
    const mine = [];
    for (const app of Object.keys(tables)) {
      const legOf = (row, side) => {
        const c = row.books?.[app];
        if (!c || c.line == null || (side === 'Over' ? c.overOpen === false : c.underOpen === false)) return null;
        const q = priceOf(row, Number(c.line));
        if (!q || !(q.pOver > 0 && q.pOver < 1)) return null;
        return { sport: 'MLB', market: row.market, mkey: row.mkey, side, team: row.team, game, player: row.player, line: Number(c.line),
          prob: side === 'Over' ? q.pOver : 1 - q.pOver, source: q.source, exact: !!q.exact };
      };
      for (const p of list.filter(r => r.mkey === 'strikeouts')) {
        const k = legOf(p, 'Over');
        if (!k) continue;
        const opp = list.filter(r => r.team !== p.team && OPP_SIDE[r.mkey]).map(r => legOf(r, OPP_SIDE[r.mkey])).filter(Boolean).sort((a, b) => b.prob - a.prob);
        for (const size of [2, 3]) {
          if (!tables[app][size] || opp.length < size - 1) continue;
          const legs = [k, ...opp.slice(0, size - 1)];
          const pInd = legs.reduce((a, l) => a * l.prob, 1);
          const rep = slips.repriced(legs, tables[app][size], app);
          const pLinked = rep ? pInd / rep.ratio : pInd;
          const repMult = rep ? rep.mult : tables[app][size];
          mine.push({ app, game, players: legs.map(l => `${l.player} ${l.side} ${l.line} ${l.market}`), sources: legs.map(l => l.source), exact: legs.every(l => l.exact), linked: rep?.linked || 0,
            pInd: r4(pInd), pLinked: r4(pLinked), standard: tables[app][size], repriced: repMult,
            evStd: +((pLinked * tables[app][size] - 1) * 100).toFixed(2), evRep: +((pLinked * repMult - 1) * 100).toFixed(2), clears: pLinked * repMult > 1 });
        }
      }
    }
    out.push(...mine.sort((a, b) => b.evRep - a.evRep).slice(0, maxPerGame));
  }
  return out.sort((a, b) => b.evRep - a.evRep);
}

module.exports = { APPS, GAP_KIND, EVEN_KIND, KINDS, EVEN, BE, appOfKind, parseMlbBox, mlbStat, MLB_MARKETS, pinMain, pinAtLine, priceFrom, classify, board, plays, closeAt, tally, zOf, stacks };
