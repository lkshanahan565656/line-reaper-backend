process.env.GAMEH = '0'; process.env.H = '720,1080';
const { bets, agg } = require('./analyze.js');
const rule = b => /^KXAAAGASD../.test(b.r.s) && b.p >= 0.9 && b.p <= 0.99;
const one = new Map(); for (const b of bets.filter(rule)) { const k = b.r.t + b.side; if (!one.has(k) || one.get(k).h > b.h) one.set(k, b); }
const L = [...one.values()];
const by = new Map(); for (const b of L) (by.get(b.r.s) || by.set(b.r.s, []).get(b.r.s)).push(b);
const pick = [...by].filter(([s, l]) => { const a = agg(l.filter(b => b.half === 1)); return a && a.n >= 40 && a.roi > 1; }).map(([s]) => s);
console.log('states picked on half 1:', pick.length, pick.join(' '));
const test = L.filter(b => b.half === 2 && pick.includes(b.r.s)), rest = L.filter(b => b.half === 2 && !pick.includes(b.r.s));
console.log('half 2, picked states:', JSON.stringify(agg(test)), 'losses', test.filter(b => !b.win).length);
console.log('half 2, other states:', JSON.stringify(agg(rest)), 'losses', rest.filter(b => !b.win).length);
// pnl per day for $100 per bet on picked states, half 2
const d = new Map(); for (const b of test) { const k = b.r.close.slice(0, 10); d.set(k, (d.get(k) || 0) + 100 * b.pnl / b.cost); }
console.log('half-2 daily $ at $100/bet:', [...d].sort().map(([k, v]) => k.slice(5) + ':' + v.toFixed(0)).join(' '));
