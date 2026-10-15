// Dota per-player per-game kills for every team-tagged game (premium,
// professional and the 'excluded' qualifier leagues) since SINCE, OpenDota explorer
const fs = require('fs'), zlib = require('zlib');
fs.mkdirSync('data', { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
async function get(url, tries = 5) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url, { signal: AbortSignal.timeout(120000) }); const t = await r.text(); if (r.status === 429 || r.status >= 500) { await sleep(8000 * (i + 1)); continue; } return t; }
    catch (e) { await sleep(5000 * (i + 1)); }
  }
  return '';
}
(async () => {
  const out = [];
  const start = Date.parse(process.env.SINCE || '2026-04-01') / 1000, now = Date.now() / 1000;
  for (let t = start; t < now; t += 10 * 86400) {
    const sql = `SELECT m.match_id, m.start_time, m.radiant_score, m.dire_score, m.radiant_team_id, m.dire_team_id, l.tier, pm.player_slot, pm.account_id, pm.kills
      FROM matches m JOIN player_matches pm USING(match_id) JOIN leagues l USING(leagueid)
      WHERE m.start_time >= ${Math.floor(t)} AND m.start_time < ${Math.floor(t + 10 * 86400)} AND l.tier IN ('premium','professional','excluded')
      AND m.radiant_team_id IS NOT NULL AND m.dire_team_id IS NOT NULL ORDER BY m.match_id`;
    let j = {}; try { j = JSON.parse(await get(`https://api.opendota.com/api/explorer?sql=${encodeURIComponent(sql)}`)); } catch { /* */ }
    log('dota', new Date(t * 1000).toISOString().slice(0, 10), (j.rows || []).length, j.err || '');
    out.push(...(j.rows || []));
    await sleep(3000);
  }
  let pros = [], teams = [];
  try { pros = JSON.parse(await get('https://api.opendota.com/api/proPlayers')).map(p => [p.account_id, p.name]); } catch { /* */ }
  try { teams = JSON.parse(await get('https://api.opendota.com/api/teams')).map(t => [t.team_id, t.name, t.tag]); } catch { /* */ }
  log('rows', out.length, 'pros', pros.length, 'teams', teams.length);
  fs.writeFileSync('data/dota.json.gz', zlib.gzipSync(JSON.stringify({ rows: out, pros, teams })));
})();
