// Record the live site's GET responses the app reads, keyed by path.
const axios = require('axios');
const BASE = 'https://line-reaper-backend-production.up.railway.app';
const PATHS = ['/', '/api/status', '/api/tail/settings', '/api/tail/signals?limit=300', '/api/tail/board?limit=100', '/api/tail/traders?limit=200',
  '/api/whales?limit=150', '/api/xarbs', '/api/xarbs?limit=1000', '/api/tail/record?limit=60', '/api/tail/fresh', '/api/esports/picks', '/api/ev', '/api/ev/record',
  '/api/sharp/signals', '/api/alerts/recent', '/api/exchanges', '/api/licence', '/api/auth/me'];
(async () => {
  const out = {};
  for (const p of PATHS) {
    try { const r = await axios.get(BASE + p, { timeout: 30000, validateStatus: () => true }); out[p] = { status: r.status, data: r.data }; }
    catch (e) { out[p] = { error: e.message }; }
  }
  console.log(JSON.stringify(out));
})();
