// Esports on Pinnacle's guest feed vs our pick'em board and Kalshi. One snapshot, raw dumps.
const fs = require('fs');
const G = 'https://guest.api.arcadia.pinnacle.com/0.1';
const KEY = 'CmX2KcMrXuFmNg6YFbmTxE0y9CIrOi0R';
const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36', Accept: 'application/json', Origin: 'https://www.pinnacle.com', Referer: 'https://www.pinnacle.com/' };
const get = async (u, h = {}) => { try { const r = await fetch(u, { headers: { ...UA, ...h }, signal: AbortSignal.timeout(40000) }); const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {} return { status: r.status, j, t: j ? '' : t.slice(0, 300) }; } catch (e) { return { status: 'ERR ' + e.message, j: null }; } };
const PROD = 'https://line-reaper-backend-production.up.railway.app';
const KAL = 'https://api.elections.kalshi.com/trade-api/v2';
(async () => {
  const out = { at: new Date().toISOString() };
  let r = await get(`${G}/sports/12/leagues?all=false`);
  if (r.status !== 200) { console.log('nokey leagues', r.status); r = await get(`${G}/sports/12/leagues?all=false`, { 'X-API-Key': KEY }); }
  console.log('leagues', r.status, Array.isArray(r.j) ? r.j.length : r.t);
  out.leagues = r.j;
  const mu = await get(`${G}/sports/12/matchups`), mk = await get(`${G}/sports/12/markets/straight`);
  console.log('sport matchups', mu.status, mu.j?.length, 'markets', mk.status, mk.j?.length);
  out.sportMatchups = mu.j; out.sportMarkets = mk.j;
  out.leagueData = {};
  for (const L of (out.leagues || []).filter(l => (l.matchupCount || 0) > 0).slice(0, 80)) {
    const a = await get(`${G}/leagues/${L.id}/matchups`), b = await get(`${G}/leagues/${L.id}/markets/straight`);
    out.leagueData[L.id] = { name: L.name, matchups: a.j, markets: b.j, st: [a.status, b.status] };
    console.log('league', L.id, L.name, a.status, a.j?.length, b.j?.length);
  }
  // related markets for a few matchups (props often hang off /matchups/{id}/related)
  const ids = (mu.j || []).filter(m => m.type === 'matchup' && !m.parentId).slice(0, 6).map(m => m.id);
  out.related = {};
  for (const id of ids) { const a = await get(`${G}/matchups/${id}/related`), b = await get(`${G}/matchups/${id}/markets/related/straight`); out.related[id] = { rel: a.j, mk: b.j, st: [a.status, b.status] }; console.log('related', id, a.status, a.j?.length, b.status, b.j?.length); }
  // our board
  const pk = await get(`${PROD}/api/esports/picks`);
  console.log('picks', pk.status, pk.j?.count); out.picks = pk.j;
  const st = await get(`${PROD}/api/status`); out.status = st.j && { version: st.j.version };
  // Kalshi esports
  out.kalshi = {};
  for (const s of ['KXLOLGAME','KXCS2GAME','KXVALORANTGAME','KXDOTA2GAME','KXLOLMAP','KXCS2MAP','KXVALORANTMAP','KXDOTA2MAP','KXLOLTOTALMAPS','KXCS2TOTALMAPS','KXLOLSPREAD','KXCS2SPREAD']) {
    const a = await get(`${KAL}/markets?series_ticker=${s}&status=open&limit=1000`);
    const ms = a.j?.markets || [];
    console.log('kalshi', s, a.status, ms.length);
    out.kalshi[s] = ms;
    if (/GAME$/.test(s)) for (const m of ms) { const b = await get(`${KAL}/markets/${m.ticker}/orderbook?depth=10`); m._book = b.j?.orderbook || b.j; }
  }
  fs.writeFileSync('out/espin.json', JSON.stringify(out));
  console.log('done');
})();
