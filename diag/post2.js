const axios = require('axios');
const B = 'https://line-reaper-backend-production.up.railway.app';
const g = async p => (await axios.get(B + p, { timeout: 60000, validateStatus: () => true })).data;
(async () => {
  const r0 = await g('/api/results');
  const brief = s => s && JSON.stringify({ open: s.open, n: s.overall.n, avgClv: s.overall.avgClv, execN: s.overall.execN, execClv: s.overall.execClv, verdict: s.overall.verdict });
  console.log('backup', JSON.stringify(r0.backup));
  for (const k of ['exchangeValue', 'esportsEdges', 'ev']) console.log('SRC', k, brief(r0.sources[k]));
  for (const p of r0.plays.filter(p => ['exchangeValue', 'esportsEdges'].includes(p.source) && (p.by === 'signal' || p.play === 'all' || p.by === 'sport'))) console.log('  PLAY', p.source, p.by || '', p.play, 'n', p.n, 'clv', p.avgClv, 'execN', p.execN, 'execClv', p.execClv, p.verdict);
  for (let i = 0; i < 6; i++) {
    const st = await g('/api/status'); const x = await g('/api/exchange-value');
    console.log('version', st.version, new Date().toISOString(), 'counts', JSON.stringify(x.counts));
    for (const e of (x.edges || []).slice(0, 10)) console.log('  EDGE', e.venue, e.league, e.pick, 'price', e.price, 'ev', e.ev, e.steam ? 'STEAM' : '', 'depth', JSON.stringify(e.depth));
    await new Promise(r => setTimeout(r, 120000));
  }
  const r = await g('/api/results');
  for (const k of ['exchangeValue', 'esportsEdges', 'ev']) console.log('SRC after', k, brief(r.sources[k]));
})();
