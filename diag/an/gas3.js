process.env.GAMEH = '0'; process.env.H = '720,1080';
const { bets, agg, table } = require('./analyze.js');
const PICK = 'CA MA MD WA MI VA TX FL MN OH TN OR NY NJ SC'.split(' ').map(s => 'KXAAAGASD' + s);
const rule = b => PICK.includes(b.r.s) && b.p >= 0.9 && b.p <= 0.99;
console.log('fee types', JSON.stringify([...new Set(bets.filter(rule).map(b => b.r.ft + ':' + b.r.fm))]));
table('picked states by price', b => 'p' + Math.round(b.p * 100), rule, 10);
table('picked states by half x horizon', b => `half${b.half} h${b.h}`, rule, 10);
