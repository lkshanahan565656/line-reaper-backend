const { bets, agg, table } = require('./analyze.js');
const kindOf = s => (s.match(/(GAME|MATCH|FIGHT|TOTAL|SPREAD)$/) || ['other'])[0];
const sel = b => kindOf(b.r.s) === 'other' && b.side === 'yes' && b.p < 0.2 && b.h <= 360;
const seg = bets.filter(sel);
console.log('segment', JSON.stringify(agg(seg)));
const fine = p => p < 0.05 ? '01-04' : p < 0.08 ? '05-07' : p < 0.11 ? '08-10' : p < 0.15 ? '11-14' : '15-19';
table('fine price', b => fine(b.p), sel, 100);
table('by series', b => b.r.s, sel, 300);
table('by spread', b => 'spr' + b.spread, sel, 100);
table('by horizon', b => 'h' + b.h, sel, 100);
table('by week', b => new Date(b.r.close).toISOString().slice(0, 8) + (new Date(b.r.close).getUTCDate() < 16 ? 'a' : 'b'), sel, 100);
// same thing for NO on the same markets (the other side of the bet)
table('NO side of props by fine price', b => fine(b.p), b => kindOf(b.r.s) === 'other' && b.side === 'no' && b.p > 0.8 && b.h <= 360, 100);
