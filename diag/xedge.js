const axios = require('axios');
const B = 'https://line-reaper-backend-production.up.railway.app';
const g = async p => (await axios.get(B + p, { timeout: 60000, validateStatus: () => true })).data;
(async () => {
  const st = await g('/api/status'); console.log('version', st.version, new Date().toISOString());
  const r = await g('/api/results');
  console.log('SOURCES', JSON.stringify(r.sources.exchangeValue), JSON.stringify(r.sources.bidArbs), JSON.stringify(r.sources.middles));
  for (const p of r.plays.filter(p => ['exchangeValue','middles','bidArbs'].includes(p.source))) console.log(p.source, p.by, '|', p.play, '| n', p.n, '| clv', p.avgClv, '| beat', p.beatClosePct ?? p.beat, '| roi', p.roi, '|', p.verdict);
  const x = await g('/api/exchange-value');
  console.log('XV counts', JSON.stringify(x.counts), 'edges', x.count, 'steam', x.steamCount, 'movers', x.moverCount);
  console.log('XV record', JSON.stringify(x.record));
  for (const e of (x.edges || []).slice(0, 25)) console.log('EDGE', JSON.stringify(e).slice(0, 600));
  for (const m of (x.movers || []).slice(0, 10)) console.log('MOVER', JSON.stringify(m).slice(0, 400));
  const a = await g('/api/xarbs');
  console.log('XARB counts', JSON.stringify(a.counts).slice(0, 3000));
})();
