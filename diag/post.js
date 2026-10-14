const axios = require('axios');
const B = 'https://line-reaper-backend-production.up.railway.app';
const g = async p => (await axios.get(B + p, { timeout: 60000, validateStatus: () => true })).data;
(async () => {
  for (let i = 0; i < 3; i++) {
    const st = await g('/api/status'); const x = await g('/api/exchange-value');
    console.log('version', st.version, new Date().toISOString(), 'counts', JSON.stringify(x.counts), 'exec settings', JSON.stringify(x.settings?.executable));
    for (const e of (x.edges || []).slice(0, 8)) console.log('  EDGE', e.venue, e.league, e.pick, 'price', e.price, 'ev', e.ev, e.steam ? 'STEAM' : '', 'depth', JSON.stringify(e.depth));
    await new Promise(r => setTimeout(r, 90000));
  }
  const r = await g('/api/results'); console.log('XV', JSON.stringify(r.sources.exchangeValue.overall));
})();
