// Head-to-head kill model data pull: Dota per-player per-game kills with team
// ids and duration (OpenDota explorer), runtime-source probes (gol.gg team
// list, OpenDota team aggregates), and the production tracker's graded rows.
const fs = require('fs'), zlib = require('zlib');
const sleep = ms => new Promise(r => setTimeout(r, ms));
fs.mkdirSync('out', { recursive: true });
const save = (f, x) => fs.writeFileSync(`out/${f}`, zlib.gzipSync(typeof x === 'string' ? x : JSON.stringify(x)));
const log = (...a) => { console.log(...a); fs.appendFileSync('out/log.txt', a.join(' ') + '\n'); };
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
async function get(url, tries = 5) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json,text/html' }, signal: AbortSignal.timeout(120000) });
      const t = await r.text();
      if (r.status === 429 || r.status >= 500) { log('retry', r.status, url.slice(0, 100)); await sleep(8000 * (i + 1)); continue; }
      return { status: r.status, text: t };
    } catch (e) { log('err', e.message, url.slice(0, 100)); await sleep(5000 * (i + 1)); }
  }
  return { status: 0, text: '' };
}
const explorer = async sql => { const r = await get(`https://api.opendota.com/api/explorer?sql=${encodeURIComponent(sql)}`); try { return JSON.parse(r.text); } catch { return { err: r.status + ' ' + r.text.slice(0, 200) }; } };

async function dota() {
  const out = [];
  const start = Date.parse(process.env.DOTA_SINCE || '2025-10-01') / 1000, now = Date.now() / 1000;
  for (let t = start; t < now; t += 10 * 86400) {
    const sql = `SELECT m.match_id, m.start_time, m.duration, m.radiant_score, m.dire_score, m.radiant_win, m.radiant_team_id, m.dire_team_id, m.leagueid, l.tier, pm.player_slot, pm.account_id, pm.kills, pm.deaths
      FROM matches m JOIN player_matches pm USING(match_id) JOIN leagues l USING(leagueid)
      WHERE m.start_time >= ${Math.floor(t)} AND m.start_time < ${Math.floor(t + 10 * 86400)} AND l.tier IN ('premium','professional')
      ORDER BY m.match_id`;
    const j = await explorer(sql);
    log('dota', new Date(t * 1000).toISOString().slice(0, 10), (j.rows || []).length, j.err || '');
    out.push(...(j.rows || []).map(r => [r.match_id, r.start_time, r.duration, r.radiant_score, r.dire_score, r.radiant_win ? 1 : 0, r.radiant_team_id, r.dire_team_id, r.leagueid, r.tier === 'premium' ? 1 : 0, r.player_slot, r.account_id, r.kills, r.deaths]));
    await sleep(2500);
  }
  const pros = await get('https://api.opendota.com/api/proPlayers');
  let pp = []; try { pp = JSON.parse(pros.text).map(p => [p.account_id, p.name, p.team_id, p.team_name, p.team_tag, p.fantasy_role]); } catch { /* */ }
  const teams = await get('https://api.opendota.com/api/teams');
  let tm = []; try { tm = JSON.parse(teams.text).map(t => [t.team_id, t.name, t.tag, t.rating]); } catch { /* */ }
  log('dota rows', out.length, 'pros', pp.length, 'teams', tm.length);
  save('dota.json.gz', { cols: ['match', 't', 'dur', 'rs', 'ds', 'rwin', 'rteam', 'dteam', 'league', 'premium', 'slot', 'acct', 'k', 'd'], rows: out, pros: pp, teams: tm });
}

async function probes() {
  // runtime probe: one explorer query for each team's kill pace over 60 days
  const since = Math.floor(Date.now() / 1000 - 60 * 86400);
  const t0 = Date.now();
  const j = await explorer(`SELECT team_id, count(*) games, avg(kf) kf, avg(ka) ka, avg(duration) dur FROM (
      SELECT m.radiant_team_id team_id, m.radiant_score kf, m.dire_score ka, m.duration FROM matches m JOIN leagues l USING(leagueid) WHERE m.start_time >= ${since} AND l.tier IN ('premium','professional') AND m.radiant_team_id IS NOT NULL
      UNION ALL
      SELECT m.dire_team_id, m.dire_score, m.radiant_score, m.duration FROM matches m JOIN leagues l USING(leagueid) WHERE m.start_time >= ${since} AND l.tier IN ('premium','professional') AND m.dire_team_id IS NOT NULL
    ) x GROUP BY team_id HAVING count(*) >= 3 ORDER BY games DESC`);
  log('dota team probe', (j.rows || []).length, 'teams', Date.now() - t0, 'ms', j.err || '', JSON.stringify((j.rows || [])[0] || null));
  save('dota-team-probe.json.gz', j);
  for (const [f, url] of [['gol-teams.html.gz', 'https://gol.gg/teams/list/season-S16/split-ALL/tournament-ALL/'], ['gol-players.html.gz', 'https://gol.gg/players/list/season-S16/split-ALL/tournament-ALL/']]) {
    const r = await get(url);
    log('gol', f, r.status, r.text.length);
    save(f, r.text);
    await sleep(3000);
  }
  const API = 'https://line-reaper-backend-production.up.railway.app';
  for (const [f, p] of [['tracker-graded.json.gz', '/api/tracker/picks?status=graded&limit=1000'], ['tracker-all.json.gz', '/api/tracker/picks?limit=1000'], ['share.json.gz', '/api/esports/share'], ['status.json.gz', '/api/status']]) {
    const r = await get(API + p);
    log('prod', p, r.status, r.text.length);
    save(f, r.text);
  }
}
const which = process.argv[2];
(which === 'dota' ? dota() : probes()).catch(e => log('fatal', e.stack));
