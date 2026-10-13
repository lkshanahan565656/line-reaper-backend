// ─── ESPORTS PROPS: PRICE OFF THE MARKET, NOT OFF OUR AVERAGES ───────────────
// The graded record says the books' lines are better forecasts than our player
// averages, in every game: on 92 graded picks (10-13) the line missed the
// result by less than our raw projection did, and how far our projection sat
// from the line barely predicted how far the result would (CS kills ran the
// wrong way). Picking wherever our number disagreed with a book was picking
// the spots where the book knew something we didn't.
//
// What does carry information is the books themselves. Underdog bends its
// payouts toward the side it fears (0.87x / 1.09x), Sleeper prices both sides
// (1.64 / 1.95), and PrizePicks often hangs a different number. Each quote says
// where that book thinks the player's median sits. Their weighted average is
// the market's number; our model only nudges it, by a weight the record earns.
//
// A book's quote → its probability of the over (vig out) → the projection that
// gives that probability on our own curve (the caller supplies the curve, so the
// map-count scenarios and the line's skew stay exactly as the board prices them).

const DEFAULTS = {
  modelPrior: 0.15,     // model weight before the record has a say
  priorN: 40,           // graded picks the prior is worth
  maxModelWeight: 0.5,
  vigProduct: 0.95,     // Underdog's two multipliers multiply to about this
  outlier: { rel: 0.3, abs: 2.5 },
  biasPriorN: 40,       // graded picks a book's bias needs before it counts in full
  maxBiasRel: 0.1,      // never move a book's line by more than 10%
};

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

// One book's view: P(over) with the vig out, and how much to trust it.
// q = { book: 'PP'|'UD'|'SL', line, over, under, overOpen, underOpen }
function bookOverShare(q, o = DEFAULTS) {
  if (!q || q.line == null) return null;
  if (q.book === 'PP') return { pOver: 0.5, weight: 1 };
  const overOk = q.overOpen !== false && q.over > 0;
  const underOk = q.underOpen !== false && q.under > 0;
  if (q.book === 'UD') {
    if (overOk && underOk) {
      const a = 1 / q.over, b = 1 / q.under;
      const pOver = a / (a + b);
      // a bent price is the book acting on what it knows: worth more than an even one
      return { pOver, weight: Math.abs(pOver - 0.5) > 0.01 ? 1.5 : 1 };
    }
    // One side shut: the closed side is the one they won't take, so the open
    // one is the long side. Its multiplier and the usual vig give the rest.
    if (overOk || underOk) {
      const m = overOk ? q.over : q.under;
      // a decimal payout (1.8x) is a price on its own; a boost (1.1x) is
      // relative to the standard entry, and the pair multiplies to about 0.95
      const pOpen = m > 1.35 ? Math.min(0.5, 1 / m) : (1 / m) / (1 / m + m / o.vigProduct);
      return { pOver: overOk ? pOpen : 1 - pOpen, weight: 0.75 };
    }
    return null;
  }
  if (q.book === 'SL') {
    if (!(overOk && underOk)) return null;   // one-sided Sleeper prices don't say where the middle is
    const a = 1 / q.over, b = 1 / q.under;
    return { pOver: a / (a + b), weight: 1.5 };
  }
  return null;
}

// The projection m at which overFair(line, m) = pOver, by bisection.
// overFair(line, m) returns P(over) in 0-1 on the board's curve, increasing in m.
function impliedMean(line, pOver, overFair, iters = 30) {
  if (!(line > 0) || !(pOver > 0 && pOver < 1)) return null;
  let lo = Math.max(0.05, line * 0.3), hi = line * 2 + 3;
  const flo = overFair(line, lo), fhi = overFair(line, hi);
  if (flo == null || fhi == null) return null;
  if (pOver <= flo) return lo;
  if (pOver >= fhi) return hi;
  for (let i = 0; i < iters; i++) {
    const mid = (lo + hi) / 2;
    const f = overFair(line, mid);
    if (f == null) return null;
    if (f < pOver) lo = mid; else hi = mid;
    if (hi - lo < 0.005) break;
  }
  return (lo + hi) / 2;
}

function weightedMedian(xs) {
  const s = xs.slice().sort((a, b) => a.v - b.v);
  const tot = s.reduce((a, x) => a + x.w, 0);
  let acc = 0;
  for (const x of s) { acc += x.w; if (acc >= tot / 2) return x.v; }
  return s[s.length - 1].v;
}

// quotes → { mean, quotes: [{ book, line, pOver, mean, weight, dropped? }] }
// A quote far from the others (a different span under the same label, a stale
// line) is left out of the average rather than allowed to drag it.
function consensus(quotes, overFair, o = DEFAULTS) {
  const out = [];
  for (const q of quotes || []) {
    const s = bookOverShare(q, o);
    if (!s) continue;
    let m = impliedMean(q.line, clamp(s.pOver, 0.02, 0.98), overFair);
    if (m == null) continue;
    // a book whose lines have run high or low on this stat (lineBias)
    if (q.bias) m += q.bias * q.line;
    out.push({ book: q.book, line: q.line, pOver: +s.pOver.toFixed(4), mean: +m.toFixed(2), weight: s.weight, ...(q.bias ? { bias: q.bias } : {}) });
  }
  if (!out.length) return null;
  const med = weightedMedian(out.map(x => ({ v: x.mean, w: x.weight })));
  for (const x of out) {
    if (Math.abs(x.mean - med) > Math.max(o.outlier.abs, o.outlier.rel * med)) x.dropped = true;
  }
  const kept = out.filter(x => !x.dropped);
  const w = kept.reduce((a, x) => a + x.weight, 0);
  const mean = kept.reduce((a, x) => a + x.mean * x.weight, 0) / w;
  return { mean: +mean.toFixed(3), quotes: out };
}

// How much our projection is worth on top of the market, per sport and stat,
// from the graded record: the slope of (result − line) on (projection − line),
// through the origin, shrunk toward the prior. A model whose distance from the
// line doesn't show up in results earns nothing; one that runs backwards
// (CS kills on 10-13) earns nothing either, never a negative weight.
function modelWeights(rows, o = DEFAULTS) {
  const acc = {};
  for (const r of rows || []) {
    if (!r || r.status !== 'graded' || r.result == null || r.rawPred == null || r.signalLine == null) continue;
    const x = Number(r.rawPred) - Number(r.signalLine), y = Number(r.result) - Number(r.signalLine);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const k = `${r.sport}|${r.stat}`;
    const a = acc[k] || (acc[k] = { n: 0, sxy: 0, sxx: 0 });
    a.n++; a.sxy += x * y; a.sxx += x * x;
  }
  const out = {};
  for (const [k, a] of Object.entries(acc)) {
    const slope = a.sxx > 0 ? a.sxy / a.sxx : o.modelPrior;
    const w = (slope * a.n + o.modelPrior * o.priorN) / (a.n + o.priorN);
    const [sport, stat] = k.split('|');
    out[k] = { sport, stat, n: a.n, slope: +slope.toFixed(3), weight: +clamp(w, 0, o.maxModelWeight).toFixed(3) };
  }
  return {
    table: out,
    weight: (sport, stat) => out[`${sport}|${stat}`]?.weight ?? o.modelPrior,
  };
}

// Where a book's lines have landed against results, per sport, stat and book:
// the average of (result − line) / line, so a support's 2.5 and a carry's 27.5
// share one number, each pick clipped to ±50% and the whole shrunk toward 0 by
// biasPriorN picks. On the
// 10-13 record Underdog's CS headshot lines ran 1.4 high (overs hit 10 of 33),
// and the half-and-half check held: biases fit on the first 50 graded picks
// called the next 51 better than an even line did. Pushes count as 0.
function lineBias(rows, o = DEFAULTS) {
  const acc = {};
  for (const r of rows || []) {
    if (!r || r.status !== 'graded' || r.result == null || r.signalLine == null || !r.signalBook) continue;
    const line = Number(r.signalLine), d = (Number(r.result) - line) / line;
    if (!(line > 0) || !Number.isFinite(d)) continue;
    const k = `${r.sport}|${r.stat}|${r.signalBook}`;
    const a = acc[k] || (acc[k] = { n: 0, sum: 0 });
    a.n++; a.sum += clamp(d, -0.5, 0.5);
  }
  const out = {};
  for (const [k, a] of Object.entries(acc)) {
    const [sport, stat, book] = k.split('|');
    out[k] = { sport, stat, book, n: a.n, raw: +(a.sum / a.n).toFixed(4), bias: +clamp(a.sum / (a.n + o.biasPriorN), -o.maxBiasRel, o.maxBiasRel).toFixed(4) };
  }
  return {
    table: out,
    bias: (sport, stat, book) => out[`${sport}|${stat}|${book}`]?.bias ?? 0,
  };
}

// The number the board prices with: the market's, nudged by our projection.
function blend(marketMean, rawPred, weight) {
  if (marketMean == null) return null;
  if (rawPred == null || !(weight > 0)) return marketMean;
  return marketMean + weight * (rawPred - marketMean);
}

module.exports = { DEFAULTS, bookOverShare, impliedMean, consensus, modelWeights, lineBias, blend, weightedMedian };
