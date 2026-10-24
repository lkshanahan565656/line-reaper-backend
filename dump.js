// raw shapes: Gemini events (every sport), Polymarket US leagues + events, live site record rows
const fs = require('fs'); fs.mkdirSync('out', { recursive: true });
const B = 'https://line-reaper-backend-production.up.railway.app';
const H = { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' };
async function get(u, t = 60000) {
  try { const r = await fetch(u, { headers: H, signal: AbortSignal.timeout(t) }); const txt = await r.text(); let j; try { j = JSON.parse(txt); } catch { j = { raw: txt.slice(0, 2000) }; } return { status: r.status, j }; }
  catch (e) { return { status: 0, j: { error: String(e) } }; }
}
const save = (f, x) => fs.writeFileSync('out/' + f, JSON.stringify(x));
(async () => {
  const log = [];
  // Gemini: every active event, no sport filter
  const gem = [];
  for (let i = 0; i < 12; i++) {
    const r = await get(`https://api.gemini.com/v1/prediction-markets/events?status=active&limit=500&offset=${i * 500}`);
    log.push(`gemini all p${i} ${r.status} ${r.j?.data?.length} total=${r.j?.pagination?.total}`);
    gem.push(r.j); if (!r.j?.data?.length || r.j.data.length < 500) break;
  }
  save('gemini-all.json', gem);
  for (const s of ['soccer', 'esports', 'tennis', 'mma', 'golf', 'american_football', 'basketball', 'hockey', 'baseball', 'cricket', 'boxing', 'motorsport']) {
    const r = await get(`https://api.gemini.com/v1/prediction-markets/events?status=active&sport=${s}&limit=500`);
    log.push(`gemini sport=${s} ${r.status} ${r.j?.data?.length} total=${r.j?.pagination?.total}`);
    save(`gemini-${s}.json`, r.j);
  }
  for (const p of ['/v1/prediction-markets/categories', '/v1/prediction-markets/sports', '/v1/prediction-markets/series']) { const r = await get('https://api.gemini.com' + p); log.push(`gemini ${p} ${r.status}`); save('gemini' + p.replace(/\//g, '_') + '.json', r.j); }
  // Polymarket US
  for (const p of ['/v2/leagues', '/v1/leagues', '/v2/sports', '/v1/sports', '/v2/series']) { const r = await get('https://gateway.polymarket.us' + p); log.push(`pmus ${p} ${r.status} ${JSON.stringify(r.j).length}`); save('pmus' + p.replace(/\//g, '_') + '.json', r.j); }
  const L = ['nfl', 'cfb', 'nba', 'nhl', 'mlb', 'wnba', 'cbb', 'wcbb', 'mls', 'epl', 'ucl', 'uefa', 'lal', 'bun', 'sea', 'fl1', 'lol', 'cs2', 'valorant', 'cod', 'dota2', 'dota', 'ufc', 'mma', 'atp', 'wta', 'tennis', 'pga', 'golf', 'boxing', 'f1', 'nascar', 'r6', 'rl', 'ow', 'kbo', 'npb', 'cfl', 'ncaab', 'euroleague', 'lig', 'ere', 'ser', 'por', 'mex', 'arg', 'bra', 'efl', 'uel', 'khl', 'shl', 'ahl'];
  for (const l of L) {
    const evs = [];
    for (let pg = 0; pg < 8; pg++) {
      const r = await get(`https://gateway.polymarket.us/v2/leagues/${l}/events?limit=50&offset=${pg * 50}`);
      const list = r.j?.events || [];
      if (pg === 0) log.push(`pmus league ${l} ${r.status} ${list.length}`);
      evs.push(...list); if (list.length < 50) break;
    }
    if (evs.length) save(`pmus-league-${l}.json`, evs);
  }
  // live site
  for (const q of ['/api/status', '/api/ev/record?book=gemini', '/api/ev/record?state=TX', '/api/ev/scoreboard?state=TX']) { const r = await get(B + q, 300000); log.push(`site ${q} ${r.status}`); save('site' + q.replace(/[\/?&=]/g, '_') + '.json', r.j); }
  for (const bk of ['gemini', 'polymarketus']) for (const st of ['', '&status=settled', '&status=open']) {
    const r = await get(`${B}/api/ev/record/bets?book=${bk}${st}&limit=500`, 300000); log.push(`site bets ${bk}${st} ${r.status} ${r.j?.bets?.length}`); save(`site-bets-${bk}${st.replace(/[&=]/g, '_')}.json`, r.j);
  }
  fs.writeFileSync('out/log.txt', log.join('\n'));
})();
