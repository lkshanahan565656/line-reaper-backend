// Live check of gaslocks.scan from the PR branch: tomorrow's markets with the
// window widened so they qualify now, plus the normal window; saves a snapshot
// shaped like /api/gas-locks for rendering.
const axios = require('axios'); const fs = require('fs');
const G = require('../app/gaslocks');
(async () => {
  for (const [name, o] of [['normal window', {}], ['widened 12-40h', { toHours: 40 }]]) {
    const t0 = Date.now();
    const out = await G.scan(axios, o);
    console.log(name, JSON.stringify(out.counts), 'errors', out.errors.length, out.errors.slice(0, 3), 'ms', Date.now() - t0);
    for (const p of out.plays.slice(0, 8)) console.log('  ', G.describe({ ...p, depthUsd: p.depth?.usd }), 'cost', p.cost, 'hrs', p.hoursLeft);
    if (o.toHours) {
      fs.mkdirSync('data', { recursive: true });
      const byState = {}; for (const p of out.plays) byState[p.state] = (byState[p.state] || 0) + 1; console.log('plays by state', JSON.stringify(byState));
      const usd = out.plays.map(p => p.depth.usd).sort((a, b) => a - b); console.log('depth $ median', usd[Math.floor(usd.length / 2)], 'total', usd.reduce((a, b) => a + b, 0));
      fs.writeFileSync('data/gas-snap.json', JSON.stringify({ count: out.plays.length, updated: new Date().toISOString(), pro: true, record: { open: 0, graded: 0, wins: 0, losses: 0, units: 0, roi: null, avgClv: null, clvN: 0 }, backtest: G.BACKTEST,
        rule: { states: G.DEFAULTS.states, minPrice: G.DEFAULTS.minPrice, maxPrice: G.DEFAULTS.maxPrice, fromHours: G.DEFAULTS.fromHours, toHours: G.DEFAULTS.toHours, minDepthUsd: G.DEFAULTS.minDepthUsd }, plays: out.plays, recent: [], counts: out.counts, errors: out.errors }));
    }
  }
})();
