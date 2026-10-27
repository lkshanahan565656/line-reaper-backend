// ─── APP LINE FAR FROM OUR PROJECTION (NBA and CFB models) ────────────────────
// A pick'em app's line sitting far from our own model's projection, as a play
// of its own (pre-registered: checks/far-lines-2026-10-25/PREREGISTERED.md).
//
// Distance d = Φ⁻¹(raw P(over)): the model's predictive P(over) at the app's
// line BEFORE calibration, as a standard-normal score. For a normal predictive
// distribution that is (projection − line) / sd, so d counts our projection's
// standard deviations between it and the line. Far: |d| ≥ FAR_D; the play is
// the model's side (toward the projection).
//
// A far line where Pinnacle's own line sits toward our projection is the app
// not moving with the book: the stale-line play (already failed), so it is
// left out of this record.
//
// Backtest (held out, scored once): no app cleared the bar on either sport;
// far lines are rare (NBA 1.5%, CFB 5% of app lines). Live record kinds
// far-nba / p6-far-nba / ud-far-nba and far-cfb / p6-far-cfb / ud-far-cfb:
// research, alerts off, out of the headline, own record from 0, "model, not
// an edge" until 50 graded live legs on one app at z 2+ over its break-even
// and an independent re-check.

const FAR_D = 1.0;
const KINDS = {
  NBA: { prizepicks: 'far-nba', pick6: 'p6-far-nba', underdog: 'ud-far-nba' },
  CFB: { prizepicks: 'far-cfb', pick6: 'p6-far-cfb', underdog: 'ud-far-cfb' },
};
const ALL_KINDS = new Set(Object.values(KINDS).flatMap(k => Object.values(k)));
// the PrizePicks 3-pick Power break-even (as the model records)
const PP_BE = 0.5503;

// inverse standard normal CDF (Acklam's rational approximation, |error| < 1.2e-9)
function probit(p) {
  const a = [-39.6968302866538, 220.946098424521, -275.928510446969, 138.357751867269, -30.6647980661472, 2.50662827745924];
  const b = [-54.4760987982241, 161.585836858041, -155.698979859887, 66.8013118877197, -13.2806815528857];
  const c = [-0.00778489400243029, -0.322396458041136, -2.40075827716184, -2.54973253934373, 4.37466414146497, 2.93816398269878];
  const d = [0.00778469570904146, 0.32246712907004, 2.445134137143, 3.75440866190742];
  const q = Math.min(0.995, Math.max(0.005, p));
  if (q < 0.02425) {
    const r = Math.sqrt(-2 * Math.log(q));
    return (((((c[0] * r + c[1]) * r + c[2]) * r + c[3]) * r + c[4]) * r + c[5]) / ((((d[0] * r + d[1]) * r + d[2]) * r + d[3]) * r + 1);
  }
  if (q > 1 - 0.02425) return -probit(1 - q);
  const r = q - 0.5, s = r * r;
  return (((((a[0] * s + a[1]) * s + a[2]) * s + a[3]) * s + a[4]) * s + a[5]) * r / (((((b[0] * s + b[1]) * s + b[2]) * s + b[3]) * s + b[4]) * s + 1);
}

// raw P(over) → the line's distance from the projection, rounded to 0.01 (null when unknown)
function distance(raw) {
  if (!Number.isFinite(raw)) return null;
  return Math.round(probit(raw) * 100) / 100;
}
const isFar = d => Number.isFinite(d) && Math.abs(d) >= FAR_D;

// A book's line against the app's, for the model's side: 'same' number,
// 'toward' our projection (the app has not followed the book: stale), 'away',
// or null when there is no book line.
function agreeOf(side, appLine, bookLine) {
  if (!Number.isFinite(bookLine) || !Number.isFinite(appLine)) return null;
  if (bookLine === appLine) return 'same';
  return (side === 'Over' ? bookLine > appLine : bookLine < appLine) ? 'toward' : 'away';
}

// One app cell's far fields: { d, far, pinAgree }. raw = the model's raw P(over) at the cell's line.
function cellFar(raw, side, line, pinLine) {
  const d = distance(raw);
  return { d, far: isFar(d), pinAgree: agreeOf(side, line, pinLine) };
}

// The record's far legs for one board row. priced(line) → the model's
// { raw, pOver, mean } at a line; pinLine = Pinnacle's own line
// for the prop (or null). PrizePicks standard; Pick6 at 1x (or no multiplier
// read); Underdog only with a multiplier read on the model's side, priced at it.
function farPlays(sport, row, priced, { pinLine = null, payoutFor, version = null } = {}) {
  const kinds = KINDS[sport];
  if (!kinds) return [];
  const out = [];
  for (const book of ['prizepicks', 'pick6', 'underdog']) {
    const cell = row.books?.[book];
    if (!cell || !Number.isFinite(cell.line)) continue;
    const pr = priced(cell.line);
    if (!pr || !Number.isFinite(pr.raw)) continue;
    // the side is toward the projection (the raw distance's sign, as pre-registered); its
    // fair is the calibrated model's, which can sit near or even under 50% on a stat the
    // model barely knows (points, PRA): the record judges the side, not the fair
    const d0 = distance(pr.raw);
    const side = d0 > 0 ? 'Over' : 'Under';
    const f = cellFar(pr.raw, side, cell.line, pinLine);
    if (!f.far || f.pinAgree === 'toward') continue;
    const pSide = side === 'Over' ? pr.pOver : 1 - pr.pOver;
    if (side === 'Over' ? cell.overOpen === false : cell.underOpen === false) continue;
    const mult = side === 'Over' ? cell.over : cell.under;
    let m = 1, ev;
    if (book === 'prizepicks') ev = pSide / PP_BE - 1;
    else if (book === 'pick6') {
      if (mult != null && Number(mult) !== 1) continue;
      const pay = payoutFor ? payoutFor('pick6', side, pSide, cell) : null;
      ev = pay ? pay.ev : pSide / PP_BE - 1;
    } else {
      if (mult == null || !(Number(mult) > 0)) continue;
      const pay = payoutFor ? payoutFor('underdog', side, pSide, cell) : null;
      if (!pay) continue;
      m = Number(mult); ev = pay.ev;
    }
    out.push({ row, kind: kinds[book], research: true,
      play: { book, side: side, line: cell.line, mult: m, ev: +(ev * 100).toFixed(2), fair: pSide, modelMean: pr.mean,
        modelVersion: version, farD: f.d, pinLine: Number.isFinite(pinLine) ? pinLine : null, pinAgree: f.pinAgree } });
  }
  return out;
}

const NOTE = 'An app line far from our projection: the line sits 1+ of the model\'s own standard deviations from its projection (d, from the model\'s raw P(over) before calibration). Model, not an edge: the held-out test (checks/far-lines-2026-10-25) cleared no app on either sport, and far lines are rare. Lines where Pinnacle\'s own number sits toward our projection are the stale-line play and are left out of the record.';
const BAR = 'Not a bet until its own record has 50+ graded live legs on one app with the hit rate 2+ standard errors above that app\'s break-even (PrizePicks 55.03%, Pick6 56.7%, Underdog at its real multipliers), and an independent re-check of the results.';

module.exports = { FAR_D, KINDS, ALL_KINDS, probit, distance, isFar, agreeOf, cellFar, farPlays, NOTE, BAR };
