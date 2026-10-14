// Pull long esports results history (series level where possible) for model backtests.
const fs = require('fs'), zlib = require('zlib'), path = require('path');
const axios = require(path.resolve('node_modules/axios'));
const R = require(path.resolve('ratings.js'));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const DAYS = Number(process.env.RDAYS || 1000), cutoff = Date.now() - DAYS * 86400e3;
const http = { get: async (u, o = {}) => { for (let i = 0; i < 5; i++) { try { return await axios.get(u, o); } catch (e) { const s = e.response?.status; if (s && s < 500 && s !== 429) throw e; await sleep(2000 * (i + 1)); } } throw new Error('retries ' + u); } };
const save = (k, v) => { fs.mkdirSync('data', { recursive: true }); fs.writeFileSync(`data/res-${k}.json.gz`, zlib.gzipSync(JSON.stringify(v))); log('saved', k, v.length); };
async function cs() {
  const BO3 = 'https://api.bo3.gg/api/v1', H = { origin: 'https://bo3.gg', referer: 'https://bo3.gg/', 'User-Agent': 'Mozilla/5.0 (LineReaper research)' };
  const ms = [];
  for (let p = 0; p < 900; p++) {
    const r = await http.get(`${BO3}/matches`, { params: { 'page[offset]': p * 100, 'page[limit]': 100, sort: '-start_date', 'filter[matches.status][in]': 'finished', 'filter[matches.discipline_id][eq]': 1 }, headers: H, timeout: 20000 });
    const rows = r?.data?.results || []; if (p === 0) log('bo3 sample', JSON.stringify(rows[0]).slice(0, 1500));
    ms.push(...rows.map(m => ({ id: m.id, a: m.team1_id, b: m.team2_id, s1: m.team1_score, s2: m.team2_score, t: m.start_date, bo: m.bo_type, tier: m.tier, tr: m.tier_rank, tour: m.tournament_id, w: m.winner_team_id })));
    const oldest = Math.min(...rows.map(m => Date.parse(m.start_date) || Infinity));
    if (rows.length < 100 || oldest < cutoff) break;
    if (p % 50 === 0) log('bo3 page', p, rows.slice(-1)[0]?.start_date);
    await sleep(500);
  }
  const ids = [...new Set(ms.flatMap(m => [m.a, m.b]).filter(x => x != null))], names = {};
  for (let i = 0; i < ids.length; i += 100) {
    const r = await http.get(`${BO3}/teams`, { params: { 'filter[teams.id][in]': ids.slice(i, i + 100).join(','), 'page[limit]': 100 }, headers: H, timeout: 20000 });
    for (const t of r?.data?.results || []) names[t.id] = t.name; await sleep(500);
  }
  save('cs', ms.map(m => ({ ...m, a: names[m.a] || m.a, b: names[m.b] || m.b })));
}
async function dota() {
  const rows = []; let before = null;
  for (let i = 0; i < 2500; i++) {
    const r = await http.get('https://api.opendota.com/api/proMatches', { params: before ? { less_than_match_id: before } : {}, timeout: 20000 });
    const b = Array.isArray(r.data) ? r.data : []; if (!b.length) break;
    rows.push(...b.map(m => ({ a: m.radiant_name, b: m.dire_name, aw: m.radiant_win ? 1 : 0, t: m.start_time * 1000, sid: m.series_id, st: m.series_type, lg: m.league_name, ra: m.radiant_team_id, da: m.dire_team_id })));
    before = Math.min(...b.map(m => m.match_id));
    if (Math.min(...b.map(m => m.start_time * 1000)) < cutoff) break;
    if (i % 50 === 0) save('dota', rows);
    if (i % 100 === 0) log('dota page', i, new Date(b.slice(-1)[0].start_time * 1000).toISOString());
    await sleep(1500);
  }
  save('dota', rows);
}
async function lol() { const g = await R.fetchLoLesportsGames(http, { days: DAYS, maxPages: 600 }); save('lol', g); }
async function val() { const g = await R.fetchVlrGames(http, { pages: 800 }); save('val', g); }
(async () => {
  await Promise.all([dota, lol, val].map(f => f().catch(e => log('FAIL', f.name, e.message))));
})();
