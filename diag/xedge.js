const axios = require('axios');
const B = 'https://line-reaper-backend-production.up.railway.app';
const g = async p => (await axios.get(B + p, { timeout: 60000, validateStatus: () => true })).data;
(async () => {
  const st = await g('/api/status'); console.log('version', st.version, new Date().toISOString());
  const x = await g('/api/exchange-value');
  console.log('XV counts', JSON.stringify(x.counts), 'edges', x.count, 'steam', x.steamCount, 'updated', x.updated);
  for (const e of (x.edges || []).filter(e => e.steam).slice(0, 10)) console.log('STEAM', JSON.stringify(e).slice(0, 500));
  const b = await axios.get(B + '/api/results/backup', { timeout: 120000, validateStatus: () => true });
  console.log('BACKUP', b.status, JSON.stringify({ at: b.data.at, counts: b.data.counts, other: b.data.other, bytes: (b.data.data || '').length }));
})();
