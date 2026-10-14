const axios = require('axios');
const G = require('../gaslocks');
(async () => {
  const http = { get: (u, o) => axios.get(u, o) };
  const now = Date.now();
  const out = await G.scan(http, { now, fromHours: 0, toHours: 40, maxBooks: 400 });
  const old = await G.scan(http, { now, fromHours: 0, toHours: 40, maxBooks: 400, maxSpread: 1 });
  console.log('new rule', JSON.stringify(out.counts), 'errors', out.errors.length, out.errors.slice(0, 3));
  console.log('no spread check', JSON.stringify(old.counts));
  const sp = old.rows.map(m => G.candidate(m, { now, fromHours: 0, toHours: 40, maxSpread: 1 })).filter(Boolean).map(c => Math.round(c.spread * 100));
  const h = {}; for (const s of sp) { const k = s <= 5 ? '<=5' : s <= 20 ? '6-20' : '>20'; h[k] = (h[k] || 0) + 1; } console.log('candidate spreads', JSON.stringify(h));
  for (const p of out.plays.slice(0, 8)) console.log(p.pick, p.day, p.price, 'spread', p.spread, 'depth', p.depth?.usd, 'h', p.hoursLeft);
})();
