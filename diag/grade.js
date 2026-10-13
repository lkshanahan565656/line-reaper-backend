const axios = require('axios');
const H = { headers: { origin: 'https://bo3.gg', referer: 'https://bo3.gg/', 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' } };
(async () => {
  for (const id of [188535, 188536]) {
    const r = await axios.get(`https://api.bo3.gg/api/v1/games/${id}/players_stats`, H);
    const rows = Array.isArray(r.data) ? r.data : r.data.results || [];
    console.log(id, rows.length, JSON.stringify(rows.map(x => [x.steam_profile?.player?.nickname, x.steam_profile?.player?.slug, x.steam_profile?.nickname, x.kills, x.headshots])));
    if (rows[0]) console.log(JSON.stringify(rows[0]).slice(0, 800));
  }
  const m = await axios.get('https://api.bo3.gg/api/v1/matches/rooster-vs-orgless-aust-12-10-2026', H).catch(e => ({ data: e.message }));
  console.log(JSON.stringify(m.data).slice(0, 400));
})().catch(e => console.log('FATAL', e.message));
