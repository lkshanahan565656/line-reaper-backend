const { bets, table } = require('./analyze.js');
const root = s => s.replace(/(GAME|MATCH|FIGHT|TOTAL|SPREAD|BTTS|1H|2H)$/, '');
const kindOf = s => (s.match(/(GAME|MATCH|FIGHT|TOTAL|SPREAD)$/) || ['other'])[0];
const b2 = p => p < 0.2 ? '<20' : p < 0.5 ? '20-50' : p < 0.8 ? '50-80' : p < 0.9 ? '80-90' : '90-99';
const hb = h => h <= 60 ? 'h1' : h <= 360 ? 'h3-6' : 'h12+';
const show = (title, rows) => { const x = rows.filter(r => r.h1 > 0 && r.h2 > 0); console.log(`--> ${title}: ${x.length} of ${rows.length} positive in both halves`); for (const r of x.slice(0, 40)) console.log('   ', r.k, 'n', r.n, 'ev', r.ev, 'roi', r.roi, 'se', r.se, 'h1', r.h1, 'h2', r.h2); };
show('series kind x side x bucket', table('series x side x bucket', b => `${b.r.s} ${b.side} ${b2(b.p)}`, () => true, 400).filter(()=>false) || []);
