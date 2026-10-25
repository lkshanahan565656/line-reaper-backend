// Fit the NFL game-line model (nflmodel.js) by walk-forward squared error.
//   node scripts/nflmodel-fit.js <games.csv> [out.json]
// Every game from 1999 runs through the ratings in kickoff order; the error
// is counted on 2006-2023 (fit) and reported on the 2024 regular season
// (check). Nothing from 2025 on is read for fitting. Writes the frozen
// parameters, key-number weights and residual sds.
const fs = require('fs');
const M = require('../nflmodel');
const [csvPath, outPath = 'seeds/nflmodel-params.json'] = process.argv.slice(2);
const games = M.parseNflverse(fs.readFileSync(csvPath, 'utf8')).filter(g => g.done && g.season <= 2024);
const inFit = g => g.season >= 2006 && g.season <= 2023;
const inCheck = g => g.season === 2024 && g.type === 'REG';

function run(opts, keep = false) {
  const R = M.createRatings(opts);
  let em = 0, et = 0, n = 0, cm = 0, ct = 0, cn = 0;
  const rows = [];
  for (const g of games) {
    const p = R.update(g);
    const dm = (g.homeScore - g.awayScore) - p.margin, dt = (g.homeScore + g.awayScore) - p.total;
    if (inFit(g)) { em += dm * dm; et += dt * dt; n++; }
    if (inCheck(g)) { cm += dm * dm; ct += dt * dt; cn++; }
    if (keep) rows.push({ g, p });
  }
  return { mse: em / n, mseT: et / n, n, check: { mse: cm / cn, mseT: ct / cn, n: cn }, rows };
}
// coordinate descent over a grid per parameter
function tune(opts, grid, key) {
  let best = { ...opts }, bestErr = run(best)[key];
  for (let pass = 0; pass < 3; pass++) {
    let moved = false;
    for (const [p, vals] of Object.entries(grid)) {
      for (const v of vals) {
        const o = { ...best, [p]: v };
        const e = run(o)[key];
        if (e < bestErr - 1e-6) { best = o; bestErr = e; moved = true; }
      }
    }
    console.log(key, 'pass', pass, bestErr.toFixed(3), JSON.stringify(Object.fromEntries(Object.keys(grid).map(k => [k, best[k]]))));
    if (!moved) break;
  }
  return best;
}
let o = { ...M.DEFAULTS, hfa: 3 };
o = tune(o, { k: [0.04, 0.06, 0.08, 0.1, 0.12, 0.14, 0.17, 0.2], cap: [14, 17, 21, 24, 28, 35, 99], shrink: [0.1, 0.2, 0.25, 0.33, 0.4, 0.5, 0.6],
  hfa: [1, 1.5, 2, 2.5, 3, 3.5], kh: [0, 0.0005, 0.001, 0.002, 0.004, 0.007], rest: [0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.4] }, 'mse');
o = tune(o, { kt: [0.02, 0.04, 0.05, 0.07, 0.09, 0.12], shrinkT: [0.1, 0.25, 0.4, 0.55, 0.7], meanRate: [0, 0.002, 0.005, 0.01, 0.02], dome: [0, 1, 2, 3, 4, 5], mean0: [40, 42, 44, 46] }, 'mseT');
const fin = run(o, true);
const fitRows = fin.rows.filter(r => inFit(r.g));
const sd = Math.sqrt(fin.mse), sdT = Math.sqrt(fin.mseT);
// the market's own misses on the same games (closing spread and total)
const mk = fitRows.filter(r => r.g.spread != null && r.g.total != null);
const sdMarket = Math.sqrt(mk.reduce((a, r) => a + ((r.g.homeScore - r.g.awayScore) - r.g.spread) ** 2, 0) / mk.length);
const sdTMarket = Math.sqrt(mk.reduce((a, r) => a + ((r.g.homeScore + r.g.awayScore) - r.g.total) ** 2, 0) / mk.length);
const keyMargin = M.keyWeights(fitRows.map(r => ({ mu: r.p.margin, actual: r.g.homeScore - r.g.awayScore })), sd, { abs: true, lo: -80, hi: 80 });
const keyTotal = M.keyWeights(fitRows.map(r => ({ mu: r.p.total, actual: r.g.homeScore + r.g.awayScore })), sdT, { abs: false, lo: 0, hi: 130 });
const keyMarginMarket = M.keyWeights(mk.map(r => ({ mu: r.g.spread, actual: r.g.homeScore - r.g.awayScore })), sdMarket, { abs: true, lo: -80, hi: 80 });
const keyTotalMarket = M.keyWeights(mk.map(r => ({ mu: r.g.total, actual: r.g.homeScore + r.g.awayScore })), sdTMarket, { abs: false, lo: 0, hi: 130 });
const chk = fin.rows.filter(r => inCheck(r.g) && r.g.spread != null);
const mkChk = { mse: chk.reduce((a, r) => a + ((r.g.homeScore - r.g.awayScore) - r.g.spread) ** 2, 0) / chk.length, mseT: chk.reduce((a, r) => a + ((r.g.homeScore + r.g.awayScore) - r.g.total) ** 2, 0) / chk.length };
const params = { ...o, sd: +sd.toFixed(3), sdT: +sdT.toFixed(3), sdMarket: +sdMarket.toFixed(3), sdTMarket: +sdTMarket.toFixed(3), keyMargin, keyTotal, keyMarginMarket, keyTotalMarket,
  fitted: { on: '2006-2023 all games, walk-forward from 1999', n: fin.n, mse: +fin.mse.toFixed(2), mseT: +fin.mseT.toFixed(2), marketMse: +(sdMarket ** 2).toFixed(2), marketMseT: +(sdTMarket ** 2).toFixed(2),
    check2024: { n: fin.check.n, mse: +fin.check.mse.toFixed(2), mseT: +fin.check.mseT.toFixed(2), marketMse: +mkChk.mse.toFixed(2), marketMseT: +mkChk.mseT.toFixed(2) }, frozen: new Date().toISOString() } };
fs.writeFileSync(outPath, JSON.stringify(params, null, 1));
console.log(JSON.stringify(params.fitted, null, 1));
console.log('market key margins', [0, 1, 2, 3, 4, 6, 7, 10, 14].map(k => `${k}:${keyMarginMarket[k]}`).join(' '));
console.log('key margins', [0, 1, 2, 3, 4, 6, 7, 10, 14].map(k => `${k}:${keyMargin[k]}`).join(' '));
