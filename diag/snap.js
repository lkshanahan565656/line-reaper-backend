// production snapshot for the kill coverage thread: today's esports board, the
// model counts, the graded tracker rows (past app lines) and gol.gg's tables
const fs = require('fs');
fs.mkdirSync('out', { recursive: true });
const U = 'https://line-reaper-backend-production.up.railway.app';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const list = [['status', '/api/status'], ['picks', '/api/esports/picks'], ['h2h', '/api/esports/h2h?limit=5000'], ['share', '/api/esports/share'], ['rounds', '/api/esports/rounds'],
    ['pintotals', '/api/esports/pintotals'], ['board', '/api/props/board?limit=1000&sport=ESPORTS']];
  for (const s of ['CS', 'VAL', 'LOL', 'DOTA', 'CS2', 'VALORANT']) list.push([`graded-${s}`, `/api/tracker/picks?status=graded&limit=1000&sport=${s}`]);
  list.push(['graded-all', '/api/tracker/picks?status=graded&limit=1000']);
  for (const [n, p] of list) {
    try { const r = await fetch(U + p, { signal: AbortSignal.timeout(90000) }); fs.writeFileSync(`out/${n}.json`, await r.text()); console.log(n, r.status); } catch (e) { console.log(n, e.message); }
  }
  for (const [n, url] of [['gol-teams.html', 'https://gol.gg/teams/list/season-S16/split-ALL/tournament-ALL/'], ['gol-players.html', 'https://gol.gg/players/list/season-S16/split-ALL/tournament-ALL/']]) {
    try { const r = await fetch(url, { headers: { 'User-Agent': UA } }); fs.writeFileSync(`out/${n}`, await r.text()); console.log(n, r.status); } catch (e) { console.log(n, e.message); }
    await sleep(3000);
  }
  // Dota: games a tier over 90 days, and team-tagged games outside premium/professional
  const since = Math.floor(Date.now() / 1000 - 90 * 86400);
  const q = async sql => { const r = await fetch(`https://api.opendota.com/api/explorer?sql=${encodeURIComponent(sql)}`, { signal: AbortSignal.timeout(120000) }); return r.json(); };
  try {
    const j = await q(`SELECT l.tier, count(*) games, count(*) FILTER (WHERE m.radiant_team_id IS NOT NULL AND m.dire_team_id IS NOT NULL) teamed FROM matches m JOIN leagues l USING(leagueid) WHERE m.start_time > ${since} GROUP BY l.tier`);
    fs.writeFileSync('out/dota-tiers.json', JSON.stringify(j.rows || j));
  } catch (e) { console.log('dota', e.message); }
})();
