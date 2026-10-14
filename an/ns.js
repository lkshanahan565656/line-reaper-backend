process.env.GAMEH = '0'; process.env.H = process.env.H || '60,180,360,720,1080,1440,2160,2880';
const { bets, agg, table } = require('./analyze.js');
const b2 = p => p < 0.05 ? '01-04' : p < 0.2 ? '05-19' : p < 0.5 ? '20-50' : p < 0.8 ? '50-80' : p < 0.95 ? '80-94' : '95-99';
const hb = h => h <= 180 ? 'h<=3' : h <= 720 ? 'h6-12' : 'h18+';
table('cat x side x bucket', b => `${b.r.cat} ${b.side} ${b2(b.p)}`, () => true, 500);
function oos(title, keyOf, min) {
  const g = new Map(); for (const b of bets) { const k = keyOf(b); (g.get(k) || g.set(k, []).get(k)).push(b); }
  const seg = [...g].map(([k, l]) => ({ k, l, a: agg(l.filter(b => b.half === 1)) })).filter(x => x.a && x.a.n >= min && x.a.roi > 2);
  const a2 = agg(seg.flatMap(x => x.l.filter(b => b.half === 2)));
  console.log(`\nOOS ${title}: ${seg.length} segments beat +2% in half 1; together in half 2: ${JSON.stringify(a2 && { n: a2.n, ev: a2.ev, roi: a2.roi, se: a2.se })}`);
  for (const x of seg.slice(0, 30)) { const h2 = agg(x.l.filter(b => b.half === 2)); console.log('   ', x.k, 'h1', x.a.roi, 'n1', x.a.n, '-> h2', h2?.roi, 'n2', h2?.n, 'ev2', h2?.ev); }
}
oos('series x side x bucket', b => `${b.r.s} ${b.side} ${b2(b.p)}`, 300);
oos('series x side x bucket x horizon', b => `${b.r.s} ${b.side} ${b2(b.p)} ${hb(b.h)}`, 300);
oos('cat x side x bucket x horizon', b => `${b.r.cat} ${b.side} ${b2(b.p)} ${hb(b.h)}`, 300);
