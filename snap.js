// Records every GET the scan's matcher inputs take (Kalshi events, Gamma events, Polymarket US leagues)
const path = require('path');
const R = p => require(path.join(__dirname, 'repo', p));
const axios = R('node_modules/axios');
const xarb = R('xarb.js'), pmus = R('pmus.js');
const zlib = require('zlib'), fs = require('fs');
const lines = [];
const http = { get: async (url, cfg = {}) => {
  const res = await axios.get(url, { ...cfg, headers: { 'User-Agent': 'Mozilla/5.0' } });
  lines.push(JSON.stringify({ url, params: cfg.params || null, at: new Date().toISOString(), data: res.data }));
  return res;
} };
(async () => {
  const [k, p] = await Promise.all([xarb.fetchKalshiEvents(http, { onPage: () => {} }), xarb.fetchPolymarketEvents(http, { onPage: () => {} })]);
  console.log('kalshi', k.pages, k.count, k.errors, 'poly', p.pages, p.count, p.errors);
  const series = [];
  for (const g of ['NFL', 'NBA', 'NHL', 'MLB', 'NCAAF', 'EPL', 'LALIGA', 'BUNDESLIGA', 'SERIEA', 'UCL', 'MLS', 'LOL', 'CS2']) series.push(`KX${g}GAME`, `KX${g}TOTAL`, `KX${g}SPREAD`);
  series.push('KXATPMATCH', 'KXWTAMATCH', 'KXVALORANTGAME', 'KXDOTA2GAME');
  for (const t of series) { const r = await xarb.fetchKalshiEvents(http, { seriesTicker: t, maxPages: 3, onPage: () => {} }); console.log(t, r.count, r.errors.length); }
  try {
    const us = pmus.createPolymarketUs({ http });
    const rows = await us.arbRows({});
    console.log('pmus rows', rows.length);
  } catch (e) { console.log('pmus', e.message); }
  try {
    const pg = R('pingames.js'), fb = R('freebooks.js');
    const sports = Object.fromEntries(Object.entries(pg.SPORTS).filter(([k]) => k !== 'soccer'));
    const a = await pg.fetchPinnacleGames(axios, { sports });
    const b = await pg.fetchPinnacleGames(axios, { sports: {}, leagues: { soccer: fb.PIN_SOCCER_LEAGUES } });
    console.log('pinnacle', a.games.length, b.games.length, a.errors, b.errors);
    lines.push(JSON.stringify({ url: 'pinnacle:games', at: new Date().toISOString(), data: [...a.games, ...b.games] }));
  } catch (e) { console.log('pin', e.message); }
  fs.writeFileSync(`snap-${Date.now()}.jsonl.gz`, zlib.gzipSync(lines.join('\n')));
})();
