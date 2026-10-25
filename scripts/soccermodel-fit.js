// Fit the soccer model's parameters walk-forward (checks/soccer-model-2026-10-25/PREREGISTERED.md).
//   node scripts/soccermodel-fit.js <football-data dir> [out.json]
// Scored on 2013-07 to 2022-07 (the first season warms the ratings), checked on
// 2022-07 to 2025-07 beside Pinnacle's closing 1X2. Coordinate search, then frozen.
const fs = require('fs');
const M = require('../soccermodel');
const { loadFd } = require('./soccer-load');
const [dir, out = 'seeds/soccermodel-params.json'] = process.argv.slice(2);
const ms = loadFd(dir);
const FIT = { from: Date.parse('2013-07-01'), to: Date.parse('2022-07-01') }, CHECK = { from: Date.parse('2022-07-01'), to: Date.parse('2025-07-01') };
let p = { ...M.DEFAULTS, ...(process.env.START ? JSON.parse(fs.readFileSync(process.env.START, 'utf8')) : {}) };
delete p.fitted;
const score = q => M.walk(ms, q, FIT).logLoss;
let best = score(p);
console.log('start', best.toFixed(5));
const steps = { k: 0.01, kb: 0.0003, kh: 0.0003, shrink: 0.1, promo: 0.05, wSot: 0.1, sotConv: 0.03, rho: 0.03, tierShift: 0.05, hfa0: 0.05, base0: 0.05 };
const lim = { k: [0.002, 0.2], kb: [0, 0.02], kh: [0, 0.02], shrink: [0, 0.9], promo: [-0.3, 0.6], wSot: [0, 1], sotConv: [0.1, 0.6], rho: [-0.3, 0.2], tierShift: [-0.2, 0.8], hfa0: [0, 0.6], base0: [-0.2, 0.7] };
for (let round = 0; round < Number(process.env.ROUNDS || 4); round++) {
  for (const key of Object.keys(steps)) {
    let improved = true;
    while (improved) {
      improved = false;
      for (const dirn of [1, -1]) {
        const v = Math.round((p[key] + dirn * steps[key]) * 1e5) / 1e5;
        if (v < lim[key][0] || v > lim[key][1]) continue;
        const q = { ...p, [key]: v }, s = score(q);
        if (s < best - 1e-6) { best = s; p = q; improved = true; console.log(round, key, v, s.toFixed(5)); break; }
      }
    }
    steps[key] /= round >= 1 ? 2 : 1;
  }
}
// check: model vs Pinnacle's close on the same matches
let n = 0, llM = 0, llP = 0;
M.walk(ms, p, { ...CHECK, onPredict: (m, q, o) => { if (!m.close) return; n++; llM -= Math.log(q[o]); llP -= Math.log(m.close[o]); } });
const fitRes = M.walk(ms, p, FIT);
const res = { ...p, fitted: { on: '2013-07-01..2022-07-01', matches: fitRes.n, logLoss: Math.round(fitRes.logLoss * 1e5) / 1e5,
  check: { on: '2022-07-01..2025-07-01', matches: n, logLoss: Math.round(llM / n * 1e5) / 1e5, pinnacleClose: Math.round(llP / n * 1e5) / 1e5 } } };
console.log(JSON.stringify(res, null, 1));
fs.writeFileSync(out, JSON.stringify(res, null, 1) + '\n');
