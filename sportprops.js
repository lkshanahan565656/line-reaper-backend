// ─── SPORTS PROPS: THE BOOKS' CONSENSUS, LINE GAPS AND THEIR OWN RECORD ─────
// Underdog, PrizePicks and Sleeper hang their own line on the same player and
// stat. Each line is a book's read of the median (a PrizePicks standard line
// is 50/50; Underdog's and Sleeper's payouts tilt theirs), and Kalshi's player
// ladders, where they exist, price the curve outright. For any one book, the
// other books and Kalshi make the fair price: a book sitting a yard or a
// rebound off the rest is the soft side, and a ticket anyone can place at the
// line shown.
//
// Every play this flags is tracked like a bet: the line, payout and fair at
// signal; whether the same line was still up at the next read two or more
// minutes later (the executable check); the books' lines and fair at the last
// read before the game (CLV); and the result from ESPN's box score.
// Pure functions plus a small tracker; the server feeds board rows in.

const { sideProbs, SYM_MIN, nbCdf, nbPmf, normalCdf, useCount } = require('./dist');

// Spread of each stat around its median, as var = k × mean (dist.sideProbs:
// negative binomial for small counts, discretised normal above 8). Fitted on
// Kalshi's live ladders, 2026-10-14 (see the PR); unlisted stats take the
// nearest kind's default.
const K = {
  pass_yds: 14, rush_yds: 12, rec_yds: 14, rush_rec_yds: 13, pass_rush_yds: 14, longest_rec: 8, longest_rush: 8,
  receptions: 1.3, targets: 1.5, pass_comp: 1.3, pass_att: 1.3, rush_att: 1.5, pass_tds: 1.2, pass_ints: 1.1,
  points: 2.6, rebounds: 1.6, assists: 1.6, threes: 1.3, pra: 3.2, pts_rebs: 2.9, pts_asts: 2.9, rebs_asts: 1.9, steals: 1.1, blocks: 1.2, stocks: 1.2, turnovers: 1.2, ftm: 1.5,
  strikeouts: 1.3, pitcher_outs: 1.6, hits_allowed: 1.3, earned_runs: 1.6, hits: 1.05, total_bases: 1.6, runs: 1.05, rbis: 1.4, hits_runs_rbis: 1.6,
  // touchdowns: near Poisson (a k of 1.5 put 2+ TDs at 17% for a 13% bet)
  anytime_td: 1.05,
  shots_on_goal: 1.2, saves: 1.6, goals: 1.05, points_nhl: 1.1, kicking_points: 1.6, fg_made: 1.2,
  // tennis games (best of three: total games sd about 5 at a mean of 22)
  games_played: 1.2, games_won: 1.1,
};
// Stats whose curve isn't a count around a median (a fight's minutes, sets in a
// match, a yes/no like a knockout, a finishing position): a source prices only
// the line it sits on, never a line read off it.
const EXACT = new Set(['fight_time', 'knockouts', 'submissions', 'finishes', '1st_round_finish', '2nd_round_finish',
  '3rd_round_finish', '4th_round_finish', '5th_round_finish', 'sets_played', 'sets_won', '1st_set_games_played', 'finishing_position']);
const sameLine = (mkey, a, b) => !EXACT.has(mkey) || Math.abs(a - b) < 1e-6;
const kFor = (mkey, sport) => K[sport === 'NHL' && mkey === 'points' ? 'points_nhl' : mkey] ?? 1.5;

// P(over line) for a median-ish mean on the stat's curve. dist.sideProbs
// switches from the negative binomial to a discretised normal at a mean of
// SYM_MIN, and the two disagree there by up to 17 points of P(over) for the
// yardage stats (k 12 to 14). A line whose read mean landed on that step came
// back at a different price: Pinnacle's 47.3% over on Tory Horton's 5.5
// receiving yards read back as 59.3% and flagged PrizePicks' over at +5.5%
// (2026-10-14). Across BLEND means either side of SYM_MIN the curve slides
// from one to the other, so a price read as a mean reads back as itself.
const BLEND = 3;
const whole = line => Math.abs(line - Math.round(line)) < 1e-9;
// P(over | no push) on the negative binomial and on the discretised normal
function nbPOver(line, mean, k) {
  if (!whole(line)) return Math.max(0, 1 - nbCdf(Math.floor(line), mean, k));
  const under = nbCdf(Math.round(line) - 1, mean, k), over = Math.max(0, 1 - under - nbPmf(Math.round(line), mean, k));
  return under + over > 0 ? over / (under + over) : 0;
}
function symPOver(line, mean, k) {
  const sd = Math.sqrt(mean * k);
  if (!whole(line)) return 1 - normalCdf(Math.floor(line) + 0.5, mean, sd);
  const under = normalCdf(line - 0.5, mean, sd), over = 1 - normalCdf(line + 0.5, mean, sd);
  return under + over > 0 ? over / (under + over) : 0;
}
function pOver(mkey, sport, mean, line) {
  if (!(mean > 0)) return line < 0 ? 1 : 0;
  const k = kFor(mkey, sport);
  if (!useCount('kills', mean, k)) { const r = sideProbs(line, mean, k, 'kills'); return r.over; }
  const w = Math.min(1, Math.max(0, (mean - (SYM_MIN - BLEND)) / (2 * BLEND)));
  return (w < 1 ? (1 - w) * nbPOver(line, mean, k) : 0) + (w > 0 ? w * symPOver(line, mean, k) : 0);
}

// The mean whose curve gives P(over line) = p (bisection; the curve falls as
// the line rises)
function meanFor(mkey, sport, line, p) {
  if (!(p > 0.001 && p < 0.999) || !(line >= 0)) return null;
  let lo = 0.01, hi = Math.max(5, line * 4 + 10);
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (pOver(mkey, sport, mid, line) < p) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

const UD_DECIMAL = 1.35;
// One book cell (propsboard shape) → the book's own P(over) at its line, vig
// out, or null when the payouts say nothing (one side shut, odd regime).
function bookPOver(book, c) {
  if (!c || c.line == null) return null;
  if (book === 'prizepicks') return 0.5;
  const o = c.over ?? 1, u = c.under ?? 1;
  if (!c.overOpen || !c.underOpen) {
    // one side only: a plain 1x side on Underdog or Pick6 still reads as the median
    return (book === 'underdog' || book === 'pick6') && (c.overOpen ? o : u) === 1 ? 0.5 : null;
  }
  // Pick6 pays its table times each pick's multiplier (0.9x on the side it
  // thinks likelier), so the multipliers read like Underdog's: payout ∝ 1 / chance
  if (book === 'pick6') return o > 0 && u > 0 ? (1 / o) / (1 / o + 1 / u) : null;
  if (book === 'underdog') {
    if ((o > UD_DECIMAL) !== (u > UD_DECIMAL)) return null;
    return (1 / o) / (1 / o + 1 / u);   // both regimes: payout ∝ 1 / chance
  }
  if (book === 'sleeper') {
    if (!(o > 1 && u > 1)) return null;
    return (1 / o) / (1 / o + 1 / u);
  }
  return null;
}

const DEFAULTS = {
  // Pick6 weighs nothing in the other apps' fairs until its own record earns it
  weights: { prizepicks: 1, underdog: 1, sleeper: 1, pick6: 0 },
  kalshiWeight: 2,        // Kalshi's ladder counts as this many books
  pinWeight: 3,           // Pinnacle's devigged prop counts as this many books
  minProbPts: 6,          // a gap worth this many points of win chance on our side
  minEv: 2,               // a play needs this much EV at its book (percent)
  minOthers: 1,           // other books (Kalshi counts) behind the fair
  // With two books apart, either could be the soft one (PP 54.5 vs UD 48.5
  // prices UD's over and PP's under as edges alike). A gap play needs the odd
  // book against at least two other sources.
  gapMinSources: 2,
  // A gap wider than this many points of win chance is two different games or
  // markets merged on one row (a preseason line next to opening night's), not
  // a soft book (2026-10-14: PrizePicks 17.5 vs 26.5 on Tatum read as 36).
  maxProbPts: 25,
};

// Fair P(over) at `line` for one book, from every OTHER source on the row:
// the other books' lines read as means on the stat's curve, and Kalshi's own
// price at that line (kalshi: line → P(over), from the board's cells).
// → { p, mean, n, sources: [{ book, line, p }] } or null
function fairFor(row, book, line, { kalshi = null, pin = null, o = DEFAULTS } = {}) {
  const means = [];
  const sources = [];
  for (const [b, c] of Object.entries(row.books || {})) {
    if (b === book || o.weights[b] === 0 || !sameLine(row.mkey, c.line, line)) continue;
    const p = bookPOver(b, c);
    if (p == null) continue;
    const m = meanFor(row.mkey, row.sport, c.line, p);
    if (m == null) continue;
    means.push([m, o.weights[b] ?? 1]);
    sources.push({ book: b, line: c.line, p: +(p * 100).toFixed(1) });
  }
  // Kalshi: its price at our own line when it has one, else at any book line
  let kp = kalshi?.get(line);
  if (kp != null) {
    const m = meanFor(row.mkey, row.sport, line, kp);
    if (m != null) { means.push([m, o.kalshiWeight]); sources.push({ book: 'kalshi', line, p: +(kp * 100).toFixed(1) }); }
  } else if (kalshi?.size && !EXACT.has(row.mkey)) {
    for (const [l, p] of kalshi) {
      const m = meanFor(row.mkey, row.sport, l, p);
      if (m != null) { means.push([m, o.kalshiWeight]); sources.push({ book: 'kalshi', line: l, p: +(p * 100).toFixed(1) }); break; }
    }
  }
  // Pinnacle: its own line and devigged price, read as a mean on the curve
  // a list of Pinnacle's lines for this game: the one nearest ours
  if (Array.isArray(pin)) pin = pin.reduce((a, b) => (!a || Math.abs(b.line - line) < Math.abs(a.line - line) ? b : a), null);
  if (pin && pin.line != null && pin.pOver > 0 && pin.pOver < 1 && sameLine(row.mkey, pin.line, line)) {
    const m = meanFor(row.mkey, row.sport, pin.line, pin.pOver);
    if (m != null) { means.push([m, o.pinWeight]); sources.push({ book: 'pinnacle', line: pin.line, p: +(pin.pOver * 100).toFixed(1) }); }
  }
  if (means.length < o.minOthers) return null;
  const w = means.reduce((a, [, x]) => a + x, 0);
  const mean = means.reduce((a, [m, x]) => a + m * x, 0) / w;
  return { p: pOver(row.mkey, row.sport, mean, line), mean: +mean.toFixed(2), n: means.length, sources };
}

// Every side of every book on a sports row, priced on the others. dfsEv(p,
// book, mult, cell, side) is the server's dfsLegEv. → plays, best first:
// { book, side, line, mult, fair (0-1), ev, gap: { vs, pts, probPts } | null }
function rowPlays(row, { kalshi = null, pin = null, dfsEv, o = DEFAULTS } = {}) {
  if (row.esports || !row.mkey || row.mkey.includes('|')) return [];
  const out = [];
  for (const [book, c] of Object.entries(row.books || {})) {
    const f = fairFor(row, book, c.line, { kalshi, pin, o });
    if (!f) continue;
    for (const side of ['Over', 'Under']) {
      if (side === 'Over' ? !c.overOpen : !c.underOpen) continue;
      const fair = side === 'Over' ? f.p : 1 - f.p;
      const mult = side === 'Over' ? c.over : c.under;
      const ev = dfsEv(fair, book, mult ?? 1, { overMultiplier: c.over, underMultiplier: c.under }, side);
      if (ev == null || !Number.isFinite(ev)) continue;
      // the soft side: other books hang a line that makes our side harder
      const vs = Object.entries(row.books).filter(([b, x]) => b !== book && (side === 'Over' ? x.line > c.line : x.line < c.line)).map(([b, x]) => ({ book: b, line: x.line }));
      let gap = null;
      if (vs.length) {
        const far = vs.reduce((a, b) => (Math.abs(b.line - c.line) > Math.abs(a.line - c.line) ? b : a));
        const there = pOver(row.mkey, row.sport, f.mean, far.line);
        const probPts = +(((side === 'Over' ? f.p - there : there - f.p)) * 100).toFixed(1);
        gap = { vs, pts: +Math.abs(far.line - c.line).toFixed(2), probPts };
      }
      out.push({ book, side, line: c.line, mult: mult ?? 1, fair: +fair.toFixed(4), ev: +ev.toFixed(2), mean: f.mean, n: f.n, sources: f.sources, gap });
    }
  }
  return out.sort((a, b) => b.ev - a.ev);
}

// A play worth flagging: +EV at its book by minEv, and a gap of minProbPts
// when it's a gap play. kind 'gap' (its book off the others, with a sharp
// price behind the fair) or 'ev' (a sharp price alone says it).
//
// Without a sharp price a sports gap doesn't say which side is soft: in the
// 2026-10-14 lifetime study the other apps usually moved TO the odd one, so
// the odd line was often the right one. Those gaps aren't plays; researchGap
// tracks both directions until the record says which beats the close.
const hasSharp = p => p.sources.some(s => s.book === 'pinnacle' || s.book === 'kalshi');
function playKind(p, o = DEFAULTS) {
  if (!p || p.ev < o.minEv) return null;
  if (p.gap && p.gap.probPts > o.maxProbPts) return null;
  const gap = p.gap && p.gap.probPts >= o.minProbPts && p.n >= o.gapMinSources;
  if (gap && hasSharp(p)) return 'gap';
  // no gap: a sharp price says it, Pinnacle at any line or Kalshi at this one
  return p.sources.some(s => s.book === 'pinnacle' || (s.book === 'kalshi' && s.line === p.line)) ? 'ev' : null;
}

// An unpriced gap (no sharp source) → its two directions to track, not to show:
// the odd book's soft side ('gap-odd') and the opposite side at the stale
// books' line ('gap-stale'). plays: rowPlays output for the row.
function researchGap(plays, o = DEFAULTS) {
  const odd = plays.find(p => p.gap && p.gap.probPts >= o.minProbPts && p.gap.probPts <= o.maxProbPts && p.n >= o.gapMinSources && !hasSharp(p));
  if (!odd) return [];
  const flip = odd.side === 'Over' ? 'Under' : 'Over';
  const stale = plays.filter(p => p.book !== odd.book && p.side === flip && odd.gap.vs.some(v => v.book === p.book)).sort((a, b) => b.ev - a.ev)[0];
  return [{ play: odd, kind: 'gap-odd' }, ...(stale ? [{ play: stale, kind: 'gap-stale' }] : [])];
}

// ── SHARP CONSENSUS ──────────────────────────────────────────────────────────
// The pick'em apps are the soft side; the sportsbooks that take real action
// are the price. Pinnacle, FanDuel and BetRivers each post both sides of a
// player prop (vig out, power method), and Kalshi's player ladders trade it
// outright. Each source's line and no-vig chance read as a mean on the stat's
// curve, weighted by how sharp the source is, and the weighted mean prices the
// app's own line. No pick'em app is in it: an app's line is what's being
// priced, never the fair. A play needs two or more sharp sources that roughly
// agree; one book alone, or books far apart (often two different games), say
// nothing.
// Shadow books (DraftKings, BetMGM, Caesars, bet365, Fanatics, Hard Rock and
// theScore, read through Action Network): each one's own chance at our line is
// worked out and kept on the play, so the record scores it (sporttrack
// bySource Brier) from the first graded leg, but it weighs nothing and doesn't
// count toward the two sources until promoteShadows says it has earned it.
const { SOFT_BOOKS } = require('./xbooks');
const SHARP_BOOKS = ['pinnacle', 'kalshi', 'fanduel', 'betrivers', 'matchbook', ...SOFT_BOOKS];
const CONSENSUS = {
  // Starting weights (Pinnacle the market-maker, FanDuel the biggest US book,
  // Kambi copying the market, Matchbook's market makers). The record's
  // bySource Brier scores are what should set these: SPORT_SHARP_WEIGHTS=pinnacle:3,fanduel:2,...
  weights: { pinnacle: 3, kalshi: 2, fanduel: 2, betrivers: 1, matchbook: 1 },
  shadow: SOFT_BOOKS,
  promoteN: 50,         // graded legs a shadow book needs before it can count
  minSources: 2,
  maxSpreadPts: 12,     // sources this far apart at our line: not one market
  minEv: 2,             // % over the entry's break-even
};

// The cheapest break-even of each pick'em entry, from slip.js's payout tables:
// power pays on a sweep only, flex on a near miss too. A leg is priced at the
// entry it's graded against (gradeEntry), and every entry it clears is listed.
const { PAYOUTS } = require('./slip');
const choose = (n, k) => { let r = 1; for (let i = 0; i < k; i++) r = r * (n - i) / (i + 1); return r; };
function tableBreakEven(table, n) {
  const ev = p => Object.entries(table).reduce((a, [h, pay]) => a + choose(n, +h) * p ** +h * (1 - p) ** (n - +h) * pay, 0);
  let lo = 0.3, hi = 0.95;
  for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (ev(m) < 1) lo = m; else hi = m; }
  return +((lo + hi) / 2).toFixed(4);
}
const PP_ENTRIES = [
  ...Object.entries(PAYOUTS.prizepicks_power).map(([n, t]) => ({ name: `${n}-pick power`, legs: +n, be: tableBreakEven(t, +n) })),
  ...Object.entries(PAYOUTS.prizepicks_flex).map(([n, t]) => ({ name: `${n}-pick flex`, legs: +n, be: tableBreakEven(t, +n) })),
].sort((a, b) => a.be - b.be);
// PrizePicks legs are graded at a 3-pick power play (6x, 55.0% a leg): the
// smallest entry with a low break-even, built from the few legs that clear at
// once. A 5- or 6-pick flex needs less a leg but more legs at the same time.
const PP_GRADE = PP_ENTRIES.find(e => e.name === '3-pick power');
// DraftKings Pick6 the same way, on its own table (slip.js PICK6_PAYOUTS, or
// the one the last read showed): a leg is graded at its 3-pick entry (6x) and
// each pick's multiplier scales what it pays. setPick6Payouts swaps the table in.
const { PICK6_PAYOUTS } = require('./slip');
const entriesOf = table => Object.entries(table).map(([n, t]) => ({ name: `${n}-pick${Object.keys(t).length > 1 ? ' (pays a miss)' : ''}`, legs: +n, be: tableBreakEven(t, +n) })).sort((a, b) => a.be - b.be);
const FIXED = { prizepicks: { grade: PP_GRADE, entries: PP_ENTRIES }, pick6: null };
function setPick6Payouts(table) {
  const entries = entriesOf(table && Object.keys(table).length ? table : PICK6_PAYOUTS);
  FIXED.pick6 = { grade: entries.find(e => e.legs === 3) || entries[0], entries };
  return FIXED.pick6;
}
setPick6Payouts(PICK6_PAYOUTS);
// One leg on a fixed-table app (PrizePicks, Pick6): EV at the entry it's
// graded on, the per-leg decimal that implies, and every entry it clears.
// mult is the pick's own multiplier (always 1 on PrizePicks' standard lines).
function fixedLeg(book, fair, mult = 1) {
  const f = FIXED[book];
  if (!f) return null;
  const m = mult > 0 ? mult : 1;
  return { ev: (fair * m / f.grade.be - 1) * 100, decimal: +(m / f.grade.be).toFixed(4), entry: f.grade.name,
    entries: f.entries.filter(e => fair * m > e.be).map(e => e.name) };
}

// sharp: [{ book, line, pOver }] (Pinnacle's quote, FanDuel's and BetRivers'
// props for this game); kalshi: line → P(over) from the board's cells.
// → { p, mean, n, spreadPts, sources: [{ book, line, p, at }] } or null.
// `at` is that source's own chance at our line, read off its own mean.
function consensusFor(row, line, { sharp = [], kalshi = null, o = CONSENSUS } = {}) {
  const srcs = [];
  const counts = b => o.weights[b] > 0, shadow = b => !counts(b) && (o.shadow || []).includes(b);
  // one source per book: the line nearest ours where a book hangs several
  const near = new Map();
  for (const s of sharp) if (s && s.line != null && (!near.has(s.book) || Math.abs(s.line - line) < Math.abs(near.get(s.book).line - line))) near.set(s.book, s);
  for (const s of near.values()) if (s && s.line != null && s.pOver > 0 && s.pOver < 1 && (counts(s.book) || shadow(s.book)) && sameLine(row.mkey, s.line, line)) srcs.push({ book: s.book, line: s.line, p: s.pOver });
  // Kalshi: its price at our line when it has one, else its nearest rung
  if (kalshi?.size && o.weights.kalshi > 0) {
    let best = null;
    for (const [l, p] of kalshi) if (p > 0 && p < 1 && sameLine(row.mkey, l, line) && (!best || Math.abs(l - line) < Math.abs(best[0] - line))) best = [l, p];
    if (best) srcs.push({ book: 'kalshi', line: best[0], p: best[1] });
  }
  const all = [];
  for (const s of srcs) {
    const m = meanFor(row.mkey, row.sport, s.line, s.p);
    if (m == null) continue;
    all.push({ ...s, m, w: o.weights[s.book] || 0, at: pOver(row.mkey, row.sport, m, line) });
  }
  const means = all.filter(x => x.w > 0), shadows = all.filter(x => !(x.w > 0));
  if (means.length < o.minSources) return null;
  const ats = means.map(x => x.at);
  const spreadPts = +((Math.max(...ats) - Math.min(...ats)) * 100).toFixed(1);
  if (spreadPts > o.maxSpreadPts) return null;
  const w = means.reduce((a, x) => a + x.w, 0);
  const mean = means.reduce((a, x) => a + x.m * x.w, 0) / w;
  return { p: pOver(row.mkey, row.sport, mean, line), mean: +mean.toFixed(2), n: means.length, spreadPts,
    sources: [...means, ...shadows].map(x => ({ book: x.book, line: x.line, p: +(x.p * 100).toFixed(1), at: +(x.at * 100).toFixed(1), ...(x.w > 0 ? {} : { shadow: true }) })) };
}
// Shadow books whose record has earned a say: promoteN graded legs and a
// Brier score at least as good as FanDuel's (bySource from sporttrack's
// summary). → weights with each of those at 1 (BetRivers' weight).
function promoteShadows(bySource, o = CONSENSUS) {
  const fd = bySource?.fanduel;
  const w = { ...o.weights };
  if (!(fd?.n > 0)) return { weights: w, promoted: [] };
  const promoted = (o.shadow || []).filter(b => !(w[b] > 0) && bySource[b]?.n >= o.promoteN && bySource[b].brier <= fd.brier);
  for (const b of promoted) w[b] = 1;
  return { weights: w, promoted };
}

// Every open side of every app on a row, priced on the sharp consensus.
// dfsEv(p, book, mult, cell, side) prices Underdog and Sleeper at their own
// payouts (dfsLegEv); a PrizePicks leg is priced at PP_GRADE and lists every
// entry it clears. → plays, best first:
// { book, side, line, mult, fair, ev, decimal, entry, entries, n, spreadPts, sources }
function consensusPlays(row, { sharp = [], kalshi = null, dfsEv, o = CONSENSUS } = {}) {
  if (row.esports || !row.mkey || row.mkey.includes('|')) return [];
  const out = [];
  for (const [book, c] of Object.entries(row.books || {})) {
    const f = consensusFor(row, c.line, { sharp, kalshi, o });
    if (!f) continue;
    for (const side of ['Over', 'Under']) {
      if (side === 'Over' ? !c.overOpen : !c.underOpen) continue;
      const fair = side === 'Over' ? f.p : 1 - f.p;
      const mult = (side === 'Over' ? c.over : c.under) ?? 1;
      let ev, decimal = null, entry = null, entries = null;
      const fx = fixedLeg(book, fair, mult);
      if (fx) {
        ({ ev, decimal, entry, entries } = fx);
      } else {
        ev = dfsEv(fair, book, mult, { overMultiplier: c.over, underMultiplier: c.under }, side);
      }
      if (ev == null || !Number.isFinite(ev)) continue;
      out.push({ book, side, line: c.line, mult, fair: +fair.toFixed(4), ev: +ev.toFixed(2), decimal, entry, entries,
        mean: f.mean, n: f.n, spreadPts: f.spreadPts, sources: f.sources });
    }
  }
  return out.sort((a, b) => b.ev - a.ev);
}

// ── BOOK FAIR ──
// Where neither Pinnacle nor Kalshi prices a leg (college football and NHL
// props), FanDuel's and BetRivers' own two sides with the vig out price it
// through the same consensusFor, both books weighing the same (one book alone
// makes a 'book-fair-single' price, shown and not counted). Never sharp:
// a lead that measures the apps' margin against the soft books.
// maxOffPts: a book whose price moves further than this (points of win chance)
// when read along its curve from its own line to the app's is hanging a different number
// (another game, a stale or alternate line), not pricing the same prop: no
// price at all rather than a big fake one (a FanDuel 45.5 rush-yards line
// read at a PrizePicks 57.5 said 70% under, +26%)
// A single book's price is shown only at the app's own number: lineTol is the
// widest gap (in stat units, half-point steps) between the book's line and the
// app's it will convert, a share of the line by market type. Counting stats
// (receptions, shots, rebounds, assists, strikeouts, ...) take none: a 1-point
// move is a different bet at a line of 3 to 8. Points stats take none either (a
// Joel Embiid 22.5 is not 21.5). Yardage takes 2.5% of the line (1 yard at 40, 1.5 at 60,
// never the 3 to 5 yards that priced Bo Melton's 14.5 off a 17.5). Both books
// agreeing (n 2) are checked by maxOffPts alone.
const LINE_TOL_FRAC = { counting: 0, points: 0, yards: 0.025 };
const tolClass = mkey => (/yds|yards/.test(mkey) ? 'yards' : /points|^pra$|^pts_|^threes$|^ftm$/.test(mkey) ? 'points' : 'counting');
const lineTol = (mkey, line, frac = LINE_TOL_FRAC) => Math.floor((frac[tolClass(mkey)] || 0) * Math.abs(line) * 2) / 2;
const BOOK_FAIR = { ...CONSENSUS, weights: { fanduel: 1, betrivers: 1 }, shadow: [], minSources: 1, maxOffPts: 10, lineTolFrac: LINE_TOL_FRAC };
const isSharpSource = s => !s.shadow && (s.book === 'pinnacle' || s.book === 'kalshi');
// a consensus play that rests on a sharp source (not FanDuel and BetRivers alone)
const sharpBacked = p => (p.sources || []).some(isSharpSource);
function bookFairAll(row, quotes, { dfsEv, o = BOOK_FAIR } = {}) {
  const bq = (quotes || []).filter(q => o.weights[q.book] > 0);
  if (!bq.length) return [];
  const off = o.maxOffPts ?? BOOK_FAIR.maxOffPts;
  return consensusPlays(row, { sharp: bq, kalshi: null, dfsEv, o })
    .filter(p => p.sources.every(x => Math.abs(x.at - x.p) <= off))
    .map(p => ({ ...p, bookFair: p.n >= 2 ? 'both' : 'single' }));
}
const sameNumber = (row, p, o) => p.n >= 2 || p.sources.every(x => Math.abs(x.line - p.line) <= lineTol(row.mkey, p.line, o.lineTolFrac || LINE_TOL_FRAC) + 1e-9);
function bookFairPlays(row, quotes, opts = {}) {
  const o = opts.o || BOOK_FAIR;
  return bookFairAll(row, quotes, { ...opts, o }).filter(p => sameNumber(row, p, o));
}
// a book is posting this prop at another number than the app's, so it carries
// no price: the row says "line differs" ({ book, line, appLine } or null)
function bookFairLineDiffers(row, quotes, opts = {}) {
  const o = opts.o || BOOK_FAIR;
  const cut = bookFairAll(row, quotes, { ...opts, o }).filter(p => !sameNumber(row, p, o));
  if (!cut.length) return null;
  const s = cut[0].sources.find(x => x.line !== cut[0].line) || cut[0].sources[0];
  return { book: s.book, line: s.line, appLine: cut[0].line };
}
const bookFairKind = p => (p.n >= 2 ? 'book-fair' : 'book-fair-single');

// Sportsbook props (freebooks' Odds API games) → [{ sport, key, book, line, pOver, start }]:
// one no-vig quote per book, player, stat and game, in pinprops' row keys.
// sportOf maps the feed's sport key (nfl) to the board's (NFL).
function bookPropQuotes(gamesBySport, sportOf, canonName, books = ['fanduel', 'betrivers', 'matchbook', ...SOFT_BOOKS]) {
  const toProb = a => (a > 0 ? 100 / (a + 100) : -a / (-a + 100));
  const out = [];
  for (const [s, games] of Object.entries(gamesBySport || {})) {
    const sport = sportOf(s);
    if (!sport) continue;
    for (const g of games || []) {
      for (const bm of g.bookmakers || []) {
        if (!books.includes(bm.key)) continue;
        for (const m of bm.markets || []) {
          if (/^(h2h|spreads|totals)$/.test(m.key)) continue;
          const pairs = new Map();
          for (const x of m.outcomes || []) {
            if (!x.description || x.point == null) continue;
            const k = `${x.description}|${x.point}`;
            if (!pairs.has(k)) pairs.set(k, {});
            pairs.get(k)[x.name] = x;
          }
          for (const { Over, Under } of pairs.values()) {
            if (!Over || !Under) continue;
            const po = toProb(Over.price), pu = toProb(Under.price);
            if (!(po > 0 && pu > 0) || po + pu < 1) continue;
            out.push({ sport, key: `${sport}|${canonName(Over.description)}|${m.key}`, book: bm.key, player: Over.description, mkey: m.key,
              line: Number(Over.point), pOver: +devigPower(po, pu).toFixed(4), start: g.commence_time });
          }
        }
      }
    }
  }
  return out;
}
// power devig: p^k + q^k = 1 (as pinprops does)
function devigPower(po, pu) {
  let lo = 0.5, hi = 2;
  for (let i = 0; i < 50; i++) { const k = (lo + hi) / 2; if (po ** k + pu ** k > 1) lo = k; else hi = k; }
  return po ** ((lo + hi) / 2);
}
// One quote per book for a board row: that book's line in the same game
// (start within slackMs), the nearest start when it lists two.
function quotesFor(idx, row, slackMs = 3 * 3600e3) {
  const list = idx?.get(row?.key);
  const t = Date.parse(row?.startTime || '');
  if (!list?.length || !t) return [];
  const best = new Map();
  for (const q of list) {
    const d = Math.abs(Date.parse(q.start) - t);
    if (d > slackMs) continue;
    const b = best.get(q.book);
    if (!b || d < b.d) best.set(q.book, { q, d });
  }
  return [...best.values()].map(x => x.q);
}

// "SPORT_SHARP_WEIGHTS=pinnacle:3,fanduel:2" → weights over the defaults
function parseWeights(s, base = CONSENSUS.weights) {
  const w = { ...base };
  for (const part of String(s || '').split(',')) {
    const [k, v] = part.split(':').map(x => x && x.trim().toLowerCase());
    if (SHARP_BOOKS.includes(k) && Number.isFinite(parseFloat(v))) w[k] = parseFloat(v);
  }
  return w;
}

// ── STALE LINES ──
// A pick'em line that sat still while the sharp books moved: the app hasn't
// caught up yet. moves() keeps each row's consensus mean and each app's line
// over the last hour; stale(row, book, side) is how many points of win chance
// the consensus moved toward our side since that app's line last changed.
function createMoveTracker({ windowMs = 60 * 60e3, now = () => Date.now() } = {}) {
  const hist = new Map();   // row key → [{ t, mean }]
  const since = new Map();  // row key|book → { line, t }
  function observe(row, mean) {
    const t = now();
    if (mean != null) {
      const h = hist.get(row.key) || [];
      if (!h.length || h[h.length - 1].mean !== mean) h.push({ t, mean });
      while (h.length && t - h[0].t > windowMs) h.shift();
      hist.set(row.key, h);
    }
    for (const [b, c] of Object.entries(row.books || {})) {
      const k = `${row.key}|${b}`, s = since.get(k);
      if (!s || s.line !== c.line) since.set(k, { line: c.line, t });
    }
  }
  // → { pts, mins } or null: the consensus at the app's line now vs when it set it
  function stale(row, book, line, side) {
    const h = hist.get(row.key), s = since.get(`${row.key}|${book}`);
    if (!h?.length || !s || s.line !== line) return null;
    const then = h.filter(x => x.t <= s.t).pop() || h[0];
    const cur = h[h.length - 1];
    if (cur === then) return null;
    const d = pOver(row.mkey, row.sport, cur.mean, line) - pOver(row.mkey, row.sport, then.mean, line);
    const pts = +((side === 'Over' ? d : -d) * 100).toFixed(1);
    return { pts, mins: Math.round((now() - Math.max(s.t, then.t)) / 60e3) };
  }
  function prune() {
    const t = now();
    for (const [k, h] of hist) if (!h.length || t - h[h.length - 1].t > windowMs * 3) hist.delete(k);
    for (const [k, s] of since) if (t - s.t > 2 * 86400e3) since.delete(k);
  }
  return { observe, stale, prune, size: () => hist.size };
}

module.exports = { EXACT, promoteShadows, K, kFor, pOver, meanFor, bookPOver, fairFor, rowPlays, playKind, researchGap, DEFAULTS,
  SHARP_BOOKS, CONSENSUS, BOOK_FAIR, sharpBacked, bookFairPlays, bookFairLineDiffers, lineTol, LINE_TOL_FRAC, bookFairKind, PP_ENTRIES, PP_GRADE, FIXED, fixedLeg, setPick6Payouts, tableBreakEven, consensusFor, consensusPlays, bookPropQuotes, quotesFor, parseWeights, createMoveTracker };
