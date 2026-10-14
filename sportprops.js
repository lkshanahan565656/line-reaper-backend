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
  shots_on_goal: 1.2, saves: 1.6, goals: 1.05, points_nhl: 1.1, kicking_points: 1.6, fg_made: 1.2,
};
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
    // one side only: a plain 1x side on Underdog still reads as the median
    return book === 'underdog' && (c.overOpen ? o : u) === 1 ? 0.5 : null;
  }
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
  weights: { prizepicks: 1, underdog: 1, sleeper: 1 },
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
    if (b === book) continue;
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
  } else if (kalshi?.size) {
    for (const [l, p] of kalshi) {
      const m = meanFor(row.mkey, row.sport, l, p);
      if (m != null) { means.push([m, o.kalshiWeight]); sources.push({ book: 'kalshi', line: l, p: +(p * 100).toFixed(1) }); break; }
    }
  }
  // Pinnacle: its own line and devigged price, read as a mean on the curve
  if (pin && pin.line != null && pin.pOver > 0 && pin.pOver < 1) {
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

module.exports = { K, kFor, pOver, meanFor, bookPOver, fairFor, rowPlays, playKind, researchGap, DEFAULTS };
