process.env.GAMEH = '0'; process.env.H = process.env.H || '60,180,360,720,1080,1440,2160';
const { bets, agg, table } = require('./analyze.js');
const gas = b => /^KXAAAGAS/.test(b.r.s);
table('gas by bucket x horizon', b => `${b.p < 0.8 ? '<80' : b.p < 0.9 ? '80-89' : b.p < 0.95 ? '90-94' : '95-99'} h${b.h}`, gas, 30);
const rule = b => gas(b) && b.p >= 0.85 && b.p <= 0.99 && b.h >= 720 && b.h <= 1440;
const l = bets.filter(rule);
console.log('\nRULE gas side 85-99c, 12-24h before expiry:', JSON.stringify(agg(l)));
// one bet per market (latest snapshot only) to avoid stacking
const one = new Map(); for (const b of l) { const k = b.r.t + b.side; if (!one.has(k) || one.get(k).h > b.h) one.set(k, b); }
console.log('one per market:', JSON.stringify(agg([...one.values()])));
const losses = [...one.values()].filter(b => b.win === 0); console.log('losses', losses.length, losses.slice(0, 10).map(b => `${b.r.t} ${b.side} p${b.p} h${b.h}`).join(' | '));
table('rule by series', b => b.r.s, rule, 20);
// volumes: contracts traded per market and in the hour of the snapshot
const vols = [...one.values()].map(b => b.r.vol).sort((a, b) => a - b); const q = f => vols[Math.floor(f * (vols.length - 1))];
console.log('market lifetime volume quartiles', q(0.25), q(0.5), q(0.75), q(0.9));
const days = new Map(); for (const b of one.values()) { const d = b.r.close.slice(0, 10); days.set(d, (days.get(d) || 0) + 1); } console.log('bets/day', [...days.values()].reduce((a, b) => a + b, 0) / days.size, 'days', days.size);
