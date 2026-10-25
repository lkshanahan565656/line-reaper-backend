// Fit the tennis model's parameters by walk-forward log loss on 2019-2023
// (ratings run from 2016), report 2024 as the check year. Nothing from 2025
// on is read. Writes the frozen parameters to stdout as JSON (last line).
//   node scripts/tennis-fit.js [seed]
const T = require('../tennismodel');
const D = require('../tennisdata');

const all = D.loadSeed(process.argv[2]).filter(m => m.t < Date.parse('2025-01-01'));
const FIT = [Date.parse('2019-01-01'), Date.parse('2024-01-01')], CHECK = [Date.parse('2024-01-01'), Date.parse('2025-01-01')];
function score(opts) {
  const R = T.createRatings(opts);
  const acc = { fit: [0, 0, 0], check: [0, 0, 0] };
  for (const m of all) {
    const span = m.t >= FIT[0] && m.t < FIT[1] ? 'fit' : m.t >= CHECK[0] && m.t < CHECK[1] ? 'check' : null;
    if (span) {
      const pr = R.predict(m.a, m.b, { surf: m.surf, t: m.t, bestOf: m.bo });
      if (pr.priced) { const a = acc[span]; a[0] += T.llOf(pr.p, m.w); a[1] += (pr.p - m.w) ** 2; a[2]++; }
    }
    R.add(m);
  }
  const f = x => ({ ll: x[0] / x[2], brier: x[1] / x[2], n: x[2] });
  return { fit: f(acc.fit), check: f(acc.check) };
}
const GRID = {
  kc: [150, 200, 250, 300, 400], off: [2, 5, 10, 20], shape: [0.3, 0.4, 0.5, 0.6], w: [0, 0.25, 0.5, 0.75, 1], scale: [0.8, 0.9, 1, 1.1, 1.2],
  bo5: [1, 1.1, 1.2, 1.3, 1.4], formW: [0, 0.5, 1, 2, 3], formShrink: [3, 6, 12], layoff: [0.7, 0.8, 0.9, 1], layoffDays: [45, 60, 90], r0: [1300, 1400, 1500],
};
let best = { ...T.DEFAULTS }, bestScore = score(best);
console.log('start', JSON.stringify(bestScore));
for (let round = 0; round < 3; round++) {
  let moved = false;
  for (const [k, vals] of Object.entries(GRID)) {
    for (const v of vals) {
      if (v === best[k]) continue;
      const cand = { ...best, [k]: v }, s = score(cand);
      if (s.fit.ll < bestScore.fit.ll - 1e-6) { best = cand; bestScore = s; moved = true; console.log('round', round, k, v, s.fit.ll.toFixed(5), 'check', s.check.ll.toFixed(5)); }
    }
  }
  if (!moved) break;
}
console.log('final', JSON.stringify(bestScore));
console.log(JSON.stringify(best));
