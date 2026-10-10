// Dump the live site's arbs, status and settings as JSON.
const axios = require('axios');
const BASE = 'https://line-reaper-backend-production.up.railway.app';
(async () => {
  const out = {};
  for (const [k, p] of [['xarbs', '/api/xarbs?limit=1000'], ['settings', '/api/tail/settings'], ['status', '/api/status']]) {
    try { out[k] = (await axios.get(BASE + p, { timeout: 30000 })).data; } catch (e) { out[k] = { error: e.message, status: e.response?.status }; }
  }
  console.log(JSON.stringify(out));
})();
