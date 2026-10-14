const { bets, agg } = require('./analyze.js');
const b2 = p => p < 0.2 ? '<20' : p < 0.5 ? '20-50' : p < 0.8 ? '50-80' : p < 0.9 ? '80-90' : '90-99';
const hb = h => h <= 60 ? 'h1' : h <= 360 ? 'h3-6' : 'h12+';
const kindOf = s => (s.match(/(GAME|MATCH|FIGHT|TOTAL|SPREAD)$/) || ['other'])[0];
function scan(title, keyOf, min) {
  const g = new Map(); for (const b of bets) { const k = keyOf(b); (g.get(k) || g.set(k, []).get(k)).push(b); }
  const rows = [...g].map(([k, l]) => ({ k, ...agg(l) })).filter(r => r.n >= min);
  // discover on first half: segments with h1 > +2%; confirm on second half
  const disc = rows.filter(r => r.h1 > 2);
  const conf = disc.filter(r => r.h2 > 0);
  console.log(`\n### ${title}: ${rows.length} segments (n>=${min}); ${disc.length} beat +2% in half 1; ${conf.length} still positive in half 2`);
  for (const r of conf.sort((a, b) => b.h2 - a.h2).slice(0, 25)) console.log(`  ${r.k.padEnd(44)} n=${r.n} ev=${r.ev} all=${r.roi}% se=${r.se} h1=${r.h1} h2=${r.h2} p=${r.avgP}`);
  const tot = conf.length ? conf.reduce((s, r) => s + r.h2 * r.n, 0) / conf.reduce((s, r) => s + r.n, 0) : null;
  console.log(`  weighted half-2 ROI of the survivors: ${tot?.toFixed(2)}%`);
}
scan('series x side x bucket', b => `${b.r.s} ${b.side} ${b2(b.p)}`, 300);
scan('series x side x bucket x horizon', b => `${b.r.s} ${b.side} ${b2(b.p)} ${hb(b.h)}`, 300);
scan('kind x side x bucket x horizon', b => `${kindOf(b.r.s)} ${b.side} ${b2(b.p)} ${hb(b.h)}`, 300);
