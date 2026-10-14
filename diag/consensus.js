// Snapshot prod's sports PROPS board (every page) and read Pinnacle, FanDuel and
// BetRivers props directly, N times, so a consensus fair can be tested offline.
const fs = require('fs');
const axios = require('axios');
const pingames = require('../pingames'), pinprops = require('../pinprops'), freebooks = require('../freebooks');
const P = 'https://line-reaper-backend-production.up.railway.app';
const wait = ms => new Promise(r => setTimeout(r, ms));
const get = async p => { try { const r = await fetch(P + p, { signal: AbortSignal.timeout(120000) }); return await r.json(); } catch (e) { return { error: e.message }; } };
(async () => {
  fs.mkdirSync('out', { recursive: true });
  fs.writeFileSync('out/record.json', JSON.stringify(await get('/api/props/record')));
  fs.writeFileSync('out/picks.json', JSON.stringify(await get('/api/props/record/picks?limit=1000')));
  fs.writeFileSync('out/status.json', JSON.stringify(await get('/api/status')));
  const N = +(process.env.N || 4);
  for (let i = 0; i < N; i++) {
    const at = new Date().toISOString();
    const rows = [];
    for (let off = 0; off < 20000; off += 500) {
      const d = await get(`/api/props/board?sport=SPORTS&sort=start&limit=500&offset=${off}`);
      rows.push(...(d.rows || []));
      if (!d.rows || d.rows.length < 500) break;
    }
    let fb = null, pp = null;
    try {
      const pin = await pingames.fetchPinnacleGames(axios, { sports: { football: pingames.SPORTS.football, basketball: pingames.SPORTS.basketball, hockey: pingames.SPORTS.hockey, baseball: pingames.SPORTS.baseball } });
      pp = await pinprops.fetchPinnacleProps(axios);
      fb = await freebooks.fetchFreeBooks(axios, pin.games, { pinProps: pp.props, fdProps: true });
    } catch (e) { fb = { error: e.message }; }
    fs.writeFileSync(`out/snap${i}.json`, JSON.stringify({ at, rows, pin: pp, games: fb.games, counts: fb.counts, errors: fb.errors }));
    if (i < N - 1) await wait(+(process.env.GAP || 8) * 60e3);
  }
})();
