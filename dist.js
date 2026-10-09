// ─── DISTRIBUTIONS ────────────────────────────────────────────────────────────
// Kills are counts, not measurements. A normal curve is a decent approximation
// at 40 kills and a bad one at 2.5, where it puts real probability below zero
// and misses how skewed a small count is. Every low LoL and Dota line — the
// ones with the fattest edges on the board — lives in that bad region.
//
// A negative binomial is the standard choice for over-dispersed counts and
// costs nothing extra: it takes the same mean and the same variance multiplier
// k the model already carries (var = k · mean), and it has the property we need
// for map spans — the sum over n maps is again a negative binomial with the
// same p and r scaled by n, so a 3-map prop is exact rather than approximated.
//
//   var = k·m  ⇒  r = m/(k−1),  p = 1/k        (k must exceed 1)
//
// Books settle a half-integer line with no push, so P(over 20.5) = P(X ≥ 21).
// Whole-number lines can push, and we report that mass separately.
//
// Continuous stats (fantasy points) stay on the normal curve.

// log Γ via Lanczos; good to ~15 digits, which is far beyond what we need.
const LANCZOS = [
  676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61502916214059, 12.507343278686905, -0.13857109526572012,
  9.9843695780195716e-6, 1.5056327351493116e-7,
];

function logGamma(z) {
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z);
  z -= 1;
  let x = 0.99999999999980993;
  for (let i = 0; i < LANCZOS.length; i++) x += LANCZOS[i] / (z + i + 1);
  const t = z + LANCZOS.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

// P(X = n) for NB with mean m and variance k·m
function nbPmf(n, m, k) {
  if (n < 0) return 0;
  const r = m / (k - 1), p = 1 / k;
  return Math.exp(logGamma(n + r) - logGamma(r) - logGamma(n + 1) + r * Math.log(p) + n * Math.log(1 - p));
}

// P(X ≤ n), summed directly. n is small in practice (kills, assists); the loop
// is bounded so a pathological mean can't hang the request.
function nbCdf(n, m, k, maxTerms = 4000) {
  if (n < 0) return 0;
  const top = Math.min(Math.floor(n), maxTerms);
  let sum = 0;
  for (let i = 0; i <= top; i++) sum += nbPmf(i, m, k);
  return Math.min(1, sum);
}

function erf(x) {
  const s = x >= 0 ? 1 : -1;
  x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  return s * (1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x));
}
const normalCdf = (x, m, sd) => 0.5 * (1 + erf((x - m) / (sd * Math.SQRT2)));

// Use counts only where they are counts, and only where NB is defined.
function useCount(stat, mean, k) {
  if (stat === 'fantasy') return false;
  return k > 1.05 && mean > 0 && mean < 400;
}

// { under, over, push } for one scenario. `line` may be half-integer or whole.
function sideProbs(line, mean, k, stat = 'kills') {
  if (!useCount(stat, mean, k)) {
    const sd = Math.sqrt(Math.max(mean * k, 1e-9));
    const under = normalCdf(line, mean, sd);
    return { under, over: 1 - under, push: 0, model: 'normal' };
  }
  const whole = Math.abs(line - Math.round(line)) < 1e-9;
  if (whole) {
    const n = Math.round(line);
    const under = nbCdf(n - 1, mean, k);
    const push = nbPmf(n, mean, k);
    return { under, push, over: Math.max(0, 1 - under - push), model: 'nb' };
  }
  const under = nbCdf(Math.floor(line), mean, k);
  return { under, over: Math.max(0, 1 - under), push: 0, model: 'nb' };
}

// Probability for one side across a mixture of map-count scenarios.
// meanPerMap scales with maps; k is the variance multiplier per map, and since
// variance adds the same way the mean does, k stays constant across maps.
// Scenarios: [{ maps, weight }] from context.js, or a single one.
function propProb(line, side, { meanPerMap, k, stat = 'kills', scenarios = [{ maps: 1, weight: 1 }] }) {
  let under = 0, over = 0, push = 0;
  for (const sc of scenarios) {
    const r = sideProbs(line, meanPerMap * sc.maps, k, stat);
    under += sc.weight * r.under;
    over += sc.weight * r.over;
    push += sc.weight * r.push;
  }
  const model = useCount(stat, meanPerMap, k) ? 'nb' : 'normal';
  const win = side === 'UNDER' ? under : over;
  // a push refunds the leg, so the probability that matters is win / (1 − push)
  return { win, under, over, push, effective: push < 1 ? win / (1 - push) : 0, model };
}

module.exports = { logGamma, nbPmf, nbCdf, normalCdf, sideProbs, propProb, useCount };
