const { bets, agg, table } = require('./analyze.js');
const b2 = p => p < 0.2 ? '<20' : p < 0.5 ? '20-50' : p < 0.8 ? '50-80' : p < 0.9 ? '80-90' : '90-99';
const hb = h => h <= 60 ? 'h1' : h <= 360 ? 'h3-6' : 'h12+';
const kindOf = s => (s.match(/(GAME|MATCH|FIGHT|TOTAL|SPREAD)$/) || ['other'])[0];
function oos(title, keyOf, min) {
  const g = new Map(); for (const b of bets) { const k = keyOf(b); (g.get(k) || g.set(k, []).get(k)).push(b); }
  const seg = [...g].map(([k, l]) => ({ k, l, a: agg(l.filter(b => b.half === 1)) })).filter(x => x.a && x.a.n >= min && x.a.roi > 2);
  const test = seg.flatMap(x => x.l.filter(b => b.half === 2));
  const a2 = agg(test);
  console.log(`${title}: ${seg.length} segments beat +2% in half 1 (n>=${min}); all of them in half 2: ${JSON.stringify(a2 && { n: a2.n, ev: a2.ev, roi: a2.roi, se: a2.se })}`);
}
oos('series x side x bucket x horizon', b => `${b.r.s} ${b.side} ${b2(b.p)} ${hb(b.h)}`, 300);
oos('series x side x bucket', b => `${b.r.s} ${b.side} ${b2(b.p)}`, 300);
oos('kind x side x bucket x horizon', b => `${kindOf(b.r.s)} ${b.side} ${b2(b.p)} ${hb(b.h)}`, 300);
table('kind x side x bucket (pregame)', b => `${kindOf(b.r.s)} ${b.side} ${b2(b.p)}`, () => true, 1000);
