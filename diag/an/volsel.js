const { bets, table } = require('./analyze.js');
const kindOf = s => (s.match(/(GAME|MATCH|FIGHT|TOTAL|SPREAD)$/) || ['other'])[0];
const sel = b => kindOf(b.r.s) === 'other' && b.side === 'yes' && b.p < 0.2 && b.h <= 360;
const vb = v => v < 1000 ? 'a <1k' : v < 3000 ? 'b 1-3k' : v < 10000 ? 'c 3-10k' : v < 50000 ? 'd 10-50k' : 'e 50k+';
table('by total volume', b => vb(b.r.vol), sel, 100);
// volume traded before the snapshot (outcome-independent)
for (const b of bets) if (sel(b)) { const ct = Date.parse(b.r.close), anchor = Date.parse(b.r.exp) - 3 * 3600e3, t = anchor - b.h * 60e3; b.pre = b.r.c.filter(x => ct - x[0] * 60e3 <= t).reduce((s, x) => s + x[3], 0); }
table('by volume before the snapshot', b => vb(b.pre), sel, 100);
table('pre-volume>=1k by total-volume', b => vb(b.r.vol), b => sel(b) && b.pre >= 1000, 100);
// game markets too, sanity
table('GAME yes <20 by total volume', b => vb(b.r.vol), b => kindOf(b.r.s) === 'GAME' && b.side === 'yes' && b.p < 0.2 && b.h <= 360, 100);
