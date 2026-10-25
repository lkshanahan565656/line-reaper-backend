const fs = require('fs'); const axios = require('axios');
const H = { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' };
const out = []; const log = (...a) => { const s = a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' '); console.log(s); out.push(s); };
(async () => {
  const rs = [];
  for (let p = 0; p < 3; p++) { const r = await axios.get('https://api.bo3.gg/api/v1/matches', { headers: H, timeout: 20000, params: { 'page[offset]': p * 100, 'page[limit]': 100, sort: '-start_date', with: 'games', 'filter[matches.status][in]': 'finished', 'filter[matches.discipline_id][eq]': 1 } }); rs.push(...(r.data?.results || [])); }
  let withStats = 0, n = 0;
  for (const m of rs.filter(m => m.start_date >= '2026-10-23T00:00')) {
    const g = (m.games || [])[0]; if (!g) continue;
    let k = 0; try { const r = await axios.get(`https://api.bo3.gg/api/v1/games/${g.id}/players_stats`, { headers: H, timeout: 20000 }); k = (Array.isArray(r.data) ? r.data : r.data?.results || []).length; } catch (e) { k = 'err ' + (e.response?.status || e.message); }
    n++; if (k > 0) withStats++;
    log(m.start_date.slice(0, 16), m.slug, 'tier', m.tier, 'stats rows', k);
    await new Promise(r => setTimeout(r, 300));
  }
  log('matches', n, 'with stats', withStats);
  fs.mkdirSync('out', { recursive: true }); fs.writeFileSync('out/esgc.txt', out.join('\n'));
})();
