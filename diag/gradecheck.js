// Live check for the sized +2 min grade: today's exchange value edges from the
// live site, their books read and walked for $100 with execcheck.sized, plus
// the live record (what the tracker says now).
const axios = require('axios');
const X = require('../execcheck');
const pmus = require('../pmus');
const APP = 'https://line-reaper-backend-production.up.railway.app';
(async () => {
  const http = axios.create({ timeout: 15000, headers: { 'user-agent': 'line-reaper-diag' } });
  const { data } = await http.get(`${APP}/api/exchange-value`);
  console.log('version', (await http.get(`${APP}/api/status`)).data.version, 'edges', data.count, 'pro', data.pro);
  console.log('record', JSON.stringify(data.record?.overall), JSON.stringify(data.record?.bySource));
  const us = pmus.createPolymarketUs({ http });
  const dc = X.createDepthCheck({ http, pmus: us });
  const bets = (data.edges || []).map(e => ({ id: e.id, venue: e.venue, marketId: e.marketId, contract: e.side, yesSide: e.yesSide, cost: e.cost, fair: e.fair, title: e.title, pick: e.pick }));
  const out = await dc.sized(bets);
  for (const b of bets) { const w = out.get(b.id); console.log(b.venue, b.title, '|', b.pick, 'alert', b.cost, 'fair', b.fair, '$100 →', w ? `${w.cost} (${w.usd}$, ${w.contracts}c) ev ${(b.fair / w.cost - 1).toFixed(4)}` : 'no read'); }
  try { const r = await http.get(`${APP}/api/exchange-value/bets?status=&limit=1000`); require('fs').writeFileSync('bets.json', JSON.stringify(r.data)); console.log('bets', r.data.bets.length); } catch (e) { console.log('bets endpoint:', e.response?.status || e.message); }
})().catch(e => { console.error(e); process.exit(1); });
