const axios = require('axios');
const { createLoLGrader, createCsGrader, bo3Candidates, bo3TeamNames } = require('../graders');
const BASE = 'https://line-reaper-backend-production.up.railway.app';
const log = (...a) => console.log(...a);
const http = { get: async (url, opts = {}) => {
  try { const r = await axios.get(url, opts); const d = r.data;
    log('  GET', url.replace(/https:\/\/[^/]+/, ''), JSON.stringify(opts.params || {}).slice(0, 120), '->', r.status, Array.isArray(d) ? `arr ${d.length}` : Array.isArray(d?.results) ? `results ${d.results.length}` : JSON.stringify(d).slice(0, 200));
    return r; }
  catch (e) { log('  ERR', url, e.response?.status, String(e.message).slice(0, 150)); throw e; } } };
(async () => {
  const st = await axios.get(BASE + '/api/status').catch(e => ({ data: { err: e.message }, headers: {} }));
  log('status date', st.headers.date, 'version', st.data.version, 'tracker', JSON.stringify(st.data.tracker));
  const picks = (await axios.get(BASE + '/api/tracker/picks')).data.picks;
  log('picks', picks.length, JSON.stringify(picks.reduce((a, p) => (a[p.status + ':' + p.sport] = (a[p.status + ':' + p.sport] || 0) + 1, a), {})));
  for (const p of picks.filter(p => p.status === 'graded' || p.status === 'review')) log('G', p.sport, p.player, p.stat, p.signalSide, p.signalLine, p.result, p.outcome, p.note);
  const locked = picks.filter(p => p.status === 'locked');
  log('locked starts', [...new Set(locked.map(p => p.startTime))].join(' '));
  log('sample locked', JSON.stringify(locked[0]));
  // CS raw: list matches near the starts
  const cs = createCsGrader(http, { pause: 200 });
  const csPicks = locked.filter(p => p.sport === 'CS');
  let i = 0;
  for (const p of csPicks.slice(0, 12)) {
    log(`\nCS ${p.player} team=${p.team} start=${p.startTime} stat=${p.stat} maps=${p.maps} gid=${p.gameId}`);
    try { log(' =>', JSON.stringify(await cs(p))); } catch (e) { log(' threw', e.message); }
  }
  // raw match list near the starts
  const res = await axios.get('https://api.bo3.gg/api/v1/matches', { headers: { origin: 'https://bo3.gg', referer: 'https://bo3.gg/', 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' }, params: { 'page[offset]': 0, 'page[limit]': 100, sort: '-start_date', with: 'games', 'filter[matches.status][in]': 'finished', 'filter[matches.discipline_id][eq]': 1 } }).catch(e => ({ data: { err: e.message, st: e.response?.status } }));
  const ms = res.data.results || [];
  log('\nbo3 finished matches', ms.length, res.data.err || '', res.data.st || '');
  for (const m of ms.slice(0, 60)) log(' ', m.start_date, m.slug, m.status, 'games', (m.games || []).length, [...bo3TeamNames(m)].join('/'), (m.games||[]).map(g => g.id + ':' + g.number + ':' + g.state).join(','));
  if (ms[0]?.games?.[0]) { const g = ms[0].games[0]; const r = await http.get(`https://api.bo3.gg/api/v1/games/${g.id}/players_stats`, { headers: { origin: 'https://bo3.gg', referer: 'https://bo3.gg/', 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' } }).catch(() => null);
    log('sample players_stats', JSON.stringify(r?.data).slice(0, 1500)); }
  log('sample match keys', JSON.stringify(ms[0]).slice(0, 1500));
  // LoL
  const lol = createLoLGrader(http);
  for (const p of locked.filter(p => p.sport === 'LOL').slice(0, 3)) {
    log(`\nLOL ${p.player} start=${p.startTime}`);
    try { log(' =>', JSON.stringify(await lol(p))); } catch (e) { log(' threw', e.message); }
  }
  // Dota
  for (const p of locked.filter(p => p.sport === 'DOTA')) log('DOTA locked', p.player, p.startTime, p.stat);
  // underdog esports raw sample for start time sanity
  const ud = await axios.get(BASE + '/api/underdog').catch(() => ({ data: {} }));
  const esp = (ud.data.data || []).filter(l => /cs|lol|val|dota/i.test(l.sport || ''));
  log('\nUD esports lines', esp.length, 'sample', JSON.stringify(esp[0]).slice(0, 800));
})().catch(e => log('FATAL', e.stack));
