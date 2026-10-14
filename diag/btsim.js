// Replays bt-data.json with the live steam rules and a sweep of settings.
const fs = require('fs');
const A = process.env.APP || './app';
const { createSteamWatch } = require(`${A}/steam`), { kalshiFee } = require(`${A}/exchanges`);
const D = JSON.parse(fs.readFileSync(process.argv[2] || 'bt-data.json'));
const pH = new Map(D.pHist), kH = new Map(D.kHist);
const MIN = 60e3, fee = p => kalshiFee(p, 100, 0.07) / 100;
const at = (h, t, maxAge) => { let lo = 0, hi = h.length - 1, j = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (h[m][0] <= t) { j = m; lo = m + 1; } else hi = m - 1; } return j >= 0 && t - h[j][0] <= maxAge ? h[j] : null; };
function run({ minMove = 0.03, windowMs = 20 * MIN, maxFollow = 0.4, minEv = 0.01, gapEv = 0.02, maxEv = 0.12, lookback = 6 * 3600e3 } = {}) {
  const bets = [];
  for (const x of D.list) {
    const ph = pH.get(x.ref), kh = kH.get(x.id);
    if (!ph || !kh) continue;
    const w = createSteamWatch({ minMove, windowMs, maxFollow, maxSpread: 0.03, minEv });
    const fairAt = t => { const p = at(ph, t, 10 * MIN); return p ? (x.same ? p[1] : 1 - p[1]) : null; };   // the Kalshi market's YES
    const close = fairAt(x.start - MIN);
    if (close == null) continue;
    const flagged = new Set();
    for (let t = x.start - lookback; t < x.start - MIN; t += MIN) {
      const fy = fairAt(t), k = at(kh, t, 5 * MIN);
      if (fy == null || !k) continue;
      const quotes = new Map();
      for (const side of ['yes', 'no']) {
        const price = side === 'yes' ? k[1] : 1 - k[2];
        if (!(price >= 0.05 && price <= 0.95)) continue;
        quotes.set(side, { fair: side === 'yes' ? fy : 1 - fy, cost: price + fee(price), price, spread: 0.01 });
      }
      for (const [side, q] of quotes) {
        if (flagged.has(side)) continue;
        const ev = q.fair / q.cost - 1;
        if (ev > maxEv) continue;
        const s = w.steamOf(side, q.fair, q.cost, t);
        const kind = s && ev >= minEv ? 'steam' : ev >= gapEv ? 'gap' : null;
        if (!kind) continue;
        flagged.add(side);
        const cf = side === 'yes' ? close : 1 - close;
        bets.push({ kind, id: x.id, side, league: x.league, market: x.market, ev, clv: cf / q.cost - 1, minsToStart: (x.start - t) / MIN, move: s?.move ?? null, cost: q.cost });
      }
      w.observe(quotes, t);
    }
  }
  return bets;
}
const stat = b => { const n = b.length; if (!n) return 'n 0'; const avg = b.reduce((a, x) => a + x.clv, 0) / n; const sd = Math.sqrt(b.reduce((a, x) => a + (x.clv - avg) ** 2, 0) / Math.max(1, n - 1)); return `n ${n} clv ${(avg * 100).toFixed(2)}% t ${(avg / (sd / Math.sqrt(n))).toFixed(2)} beat ${(100 * b.filter(x => x.clv > 0).length / n).toFixed(0)}% ev ${(100 * b.reduce((a, x) => a + x.ev, 0) / n).toFixed(2)}%`; };
const by = (b, f) => { const g = {}; for (const x of b) (g[f(x)] ||= []).push(x); return Object.entries(g).sort((a, c) => c[1].length - a[1].length).map(([k, v]) => `    ${k}: ${stat(v)}`).join('\n'); };
console.log('pairs', D.list.length, 'with both histories', D.list.filter(x => pH.has(x.ref) && kH.has(x.id)).length);
const base = run();
const steam = base.filter(b => b.kind === 'steam'), gap = base.filter(b => b.kind === 'gap');
console.log('DEFAULT steam', stat(steam)); console.log('DEFAULT gap', stat(gap));
console.log('  steam by league\n' + by(steam, b => b.league)); console.log('  steam by market\n' + by(steam, b => b.market));
console.log('  steam by EV\n' + by(steam, b => b.ev < 0.02 ? '1-2%' : b.ev < 0.04 ? '2-4%' : '4%+'));
console.log('  steam by move\n' + by(steam, b => b.move < 0.04 ? '3-4c' : b.move < 0.06 ? '4-6c' : '6c+'));
console.log('  steam by time to start\n' + by(steam, b => b.minsToStart < 30 ? '<30m' : b.minsToStart < 120 ? '30m-2h' : '2h+'));
console.log('  gap by league\n' + by(gap, b => b.league));
console.log('SWEEP (steam only)');
for (const minMove of [0.02, 0.03, 0.04, 0.05]) for (const win of [10, 20, 40]) for (const maxFollow of [0.25, 0.4, 0.6]) for (const minEv of [0.01, 0.02]) {
  const b = run({ minMove, windowMs: win * MIN, maxFollow, minEv }).filter(x => x.kind === 'steam');
  console.log(`  move ${minMove} win ${win} follow ${maxFollow} minEv ${minEv}: ${stat(b)}`);
}
fs.writeFileSync('bt-bets.json', JSON.stringify(base));
