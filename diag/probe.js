const axios = require('axios');
const get = async (u, params) => { try { const r = await axios.get(u, { params, timeout: 30000 }); return r.data; } catch (e) { return { ERR: e.message }; } };
(async () => {
  for (const tag of ['sports', 'games', 'esports']) {
    let n = 0, games = 0, offset = 0; const slugs = [];
    for (let p = 0; p < 30; p++) {
      const g = await get('https://gamma-api.polymarket.com/events', { closed: true, tag_slug: tag, limit: 100, offset, end_date_min: new Date(Date.now() - 3 * 86400e3).toISOString(), end_date_max: new Date().toISOString() });
      if (!Array.isArray(g)) { console.log(tag, 'ERR', JSON.stringify(g)); break; }
      n += g.length; offset += g.length;
      for (const e of g) if ((e.markets || []).some(m => m.sportsMarketType === 'moneyline' || m.gameStartTime)) { games++; if (slugs.length < 25) slugs.push(e.slug); }
      if (g.length < 100) break;
    }
    console.log(tag, 'events', n, 'games', games, slugs.join(' '));
  }
})();
