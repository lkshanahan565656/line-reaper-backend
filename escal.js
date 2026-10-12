// ─── ESPORTS PROPS: CALIBRATE ON OUR OWN RECORD ──────────────────────────────
// The props model works off 90-day player averages that know nothing about the
// tier of opponent behind them. The book's line does know, so where the model
// keeps disagreeing with the line and losing, the line was right. The pick
// tracker grades every pick, so the board can learn which kinds of pick win.
//
// Picks are bucketed by sport, stat and side (CS kills OVER, CS headshots
// UNDER, ...). For each bucket, compare how often it hit with how often the
// model said it would, and shrink toward the model with a prior worth `prior`
// picks:
//
//     hit   = (wins + prior · p̄) / (n + prior)        p̄ = model's average prob
//     shift = hit − p̄                                  capped at ±maxShift
//
// Every new pick in that bucket has its probability moved by `shift` before EV
// is worked out. With a prior of 30, a bucket that went 0-5 at 57% predicted
// loses about 8 points (no longer a play), and a bucket on par moves nothing.
// The shift is measured against the probability the model gave BEFORE any
// calibration (rawProb), so it can't feed on itself.
//
// Pushes and voids don't count. Buckets with no graded picks get no shift.

const DEFAULTS = { prior: 30, maxShift: 0.12 };

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

function bucketKey(sport, stat, side) {
  return `${sport}|${stat}|${side}`;
}

// rows: tracker rows. Returns { buckets: { key: {...} }, shift(sport, stat, side) }
function calibrate(rows, opts = {}) {
  const { prior, maxShift } = { ...DEFAULTS, ...opts };
  const acc = new Map();
  for (const r of rows || []) {
    if (!r || r.status !== 'graded' || (r.outcome !== 'win' && r.outcome !== 'loss')) continue;
    const pct = r.rawProb ?? r.signalProb;
    if (pct == null || !Number.isFinite(Number(pct))) continue;
    const key = bucketKey(r.sport, r.stat, r.signalSide);
    const b = acc.get(key) || { n: 0, wins: 0, pSum: 0, profit: 0 };
    b.n++;
    if (r.outcome === 'win') b.wins++;
    b.pSum += Number(pct) / 100;
    b.profit += Number(r.profit) || 0;
    acc.set(key, b);
  }
  const buckets = {};
  for (const [key, b] of acc) {
    const pBar = b.pSum / b.n;
    const hit = (b.wins + prior * pBar) / (b.n + prior);
    const [sport, stat, side] = key.split('|');
    buckets[key] = {
      sport, stat, side, n: b.n, wins: b.wins, losses: b.n - b.wins,
      units: Math.round(b.profit * 100) / 100,
      predicted: Math.round(pBar * 1e4) / 1e4,
      actual: Math.round(b.wins / b.n * 1e4) / 1e4,
      shift: Math.round(clamp(hit - pBar, -maxShift, maxShift) * 1e4) / 1e4,
    };
  }
  return {
    prior, buckets,
    // probability shift (a fraction, e.g. −0.08) for one bucket, 0 if unseen
    shift: (sport, stat, side) => buckets[bucketKey(sport, stat, side)]?.shift ?? 0,
    bucket: (sport, stat, side) => buckets[bucketKey(sport, stat, side)] || null,
  };
}

// Apply a shift to a probability given in percent; keep it inside (1, 99).
function adjustPct(pct, shift) {
  if (pct == null || !shift) return pct;
  return clamp(pct + shift * 100, 1, 99);
}

module.exports = { DEFAULTS, calibrate, adjustPct, bucketKey };
