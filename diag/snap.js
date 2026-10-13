// Saves the live JSON the app reads, for rendering the page offline.
const fs = require('fs');
const U = 'https://line-reaper-backend-production.up.railway.app';
const paths = ['/api/status', '/api/tail/settings', '/api/tail/signals?limit=300', '/api/tail/board?limit=100', '/api/tail/traders?limit=200&grade=graded',
  '/api/whales?limit=150', '/api/tail/record?limit=60', '/api/sharp', '/api/sharp-moves', '/api/exchange-value', '/api/exchanges', '/api/xarb', '/api/bestplays', '/api/results'];
(async () => {
  fs.mkdirSync('snap', { recursive: true });
  const index = {};
  for (const p of paths) {
    try { const r = await fetch(U + p, { signal: AbortSignal.timeout(60000) }); const t = await r.text(); const f = p.replace(/[^a-z0-9]+/gi, '_') + '.json'; fs.writeFileSync('snap/' + f, t); index[p] = { status: r.status, f, bytes: t.length }; }
    catch (e) { index[p] = { error: e.message }; }
  }
  fs.writeFileSync('snap/index.json', JSON.stringify(index, null, 1));
})();
