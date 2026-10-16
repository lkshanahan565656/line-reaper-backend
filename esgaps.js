// ─── LINE GAPS: ONE PICK'EM BOOK OFF FROM THE OTHERS ─────────────────────────
// PrizePicks, Underdog and Sleeper post their own line on the same player and
// stat, and now and then one of them sits a kill or two off the rest (PP 1.5
// where Underdog and Sleeper hang 3.5). Taking the soft side at the odd book
// out is a ticket anyone can place at the line shown, and the record says
// whether it beat the close: either that book moves its line to the others
// (we got the number before it was fixed) or the others come to it.
// Pure functions; the server feeds picks in, the tracker keeps the outcome.

const DEFAULTS = {
  // the gap must be worth this many points of win chance on our side. A one-kill
  // difference on a CS line (about 5 points) is everyday shading between books
  // (live 2026-10-14: 69 of 78 gaps were under 8); a LoL 1.5 vs 3.5 is 20 to 37.
  minProbPts: 8,
};

// Each book's own line on a board pick. ppLine is the base line, which is the
// Underdog or Sleeper line when PrizePicks doesn't carry the prop.
function bookLines(p) {
  const out = {};
  if (!p) return out;
  if (p.lineSource === 'pp' && p.ppLine != null) out.PP = p.ppLine;
  if (p.udLine != null) out.UD = p.udLine;
  else if (p.lineSource === 'ud' && p.ppLine != null) out.UD = p.ppLine;
  if (p.sleeperLine != null) out.SL = p.sleeperLine;
  else if (p.lineSource === 'sl' && p.ppLine != null) out.SL = p.ppLine;
  return out;
}

// The pick's gap, when the book it's played at sits on the soft side of
// another book's line: an over at a lower line, an under at a higher one.
// fairAt(line) → our side's chance (0-1) at that line on the books' consensus.
// Returns { book, line, side, vs: [{ book, line }], pts, probPts } or null.
function lineGap(p, fairAt, o = DEFAULTS) {
  if (!p || !p.side || !p.bestBook) return null;
  const lines = bookLines(p);
  const line = lines[p.bestBook];
  if (line == null) return null;
  const better = l => (p.side === 'OVER' ? l > line : l < line);
  const vs = Object.entries(lines).filter(([b, l]) => b !== p.bestBook && l != null && better(l)).map(([book, l]) => ({ book, line: l }));
  if (!vs.length) return null;
  const far = vs.reduce((a, b) => (Math.abs(b.line - line) > Math.abs(a.line - line) ? b : a));
  const pts = +Math.abs(far.line - line).toFixed(2);
  let probPts = null;
  if (typeof fairAt === 'function') {
    const here = fairAt(line), there = fairAt(far.line);
    if (Number.isFinite(here) && Number.isFinite(there)) probPts = +((here - there) * 100).toFixed(1);
  }
  if (probPts == null || probPts < o.minProbPts) return null;
  return { book: p.bestBook, line, side: p.side, vs: vs.sort((a, b) => a.book.localeCompare(b.book)), pts, probPts };
}

// How a tracked gap ended by lock. signal: row.gapVs (the other books' lines
// at signal) and row.signalLine; close: row.closeLines ({ PP, UD, SL } at the
// last refresh before lock).
//   'caught'  our book moved its line at least halfway to the others: we had
//             the number before it was fixed
//   'joined'  the others moved at least halfway to our book's line
//   'pulled'  our book took the line down before lock
//   'held'    still apart at lock
//   null      not a gap, or nothing to compare
function gapOutcome(row) {
  if (!row || !Array.isArray(row.gapVs) || !row.gapVs.length || row.signalLine == null || !row.closeLines) return null;
  const far = row.gapVs.reduce((a, b) => (Math.abs(b.line - row.signalLine) > Math.abs(a.line - row.signalLine) ? b : a));
  const gap = far.line - row.signalLine;
  if (!gap) return null;
  const ours = row.closeLines[row.signalBook];
  const theirs = row.closeLines[far.book];
  if (ours == null) return 'pulled';
  if ((ours - row.signalLine) / gap >= 0.5) return 'caught';
  if (theirs != null && (far.line - theirs) / gap >= 0.5) return 'joined';
  return 'held';
}

module.exports = { DEFAULTS, bookLines, lineGap, gapOutcome };
