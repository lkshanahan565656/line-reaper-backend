// series-length pull: production snapshot, Pinnacle esports raw, lolesports schedule, OpenDota series
const fs = require('fs'), zlib = require('zlib');
const B = 'https://line-reaper-backend-production.up.railway.app';
const sleep = ms => new Promise(r => setTimeout(r, ms));
fs.mkdirSync('out', { recursive: true });
const log = (...a) => { console.log(...a); fs.appendFileSync('out/log.txt', a.join(' ') + '\n'); };
async function get(url, h = {}) { for (let i = 0; i < 4; i++) { try { const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json', ...h }, signal: AbortSignal.timeout(60000) }); if (r.status === 429 || r.status >= 500) { await sleep(3000 * (i + 1)); continue; } return { status: r.status, text: await r.text() }; } catch (e) { await sleep(2000); } } return { status: 0, text: '' }; }
const save = (n, s) => fs.writeFileSync(`out/${n}.json.gz`, zlib.gzipSync(s));
(async () => {
  const what = process.argv[2] || 'all';
  if (what === 'all' || what === 'prod') {
    for (const [n, p] of [['status', '/api/status'], ['matches', '/api/esports/matches'], ['picks', '/api/esports/picks'],
      ['tr-LOL', '/api/tracker/picks?sport=LOL&limit=1000'], ['tr-CS', '/api/tracker/picks?sport=CS&limit=1000'], ['tr-DOTA', '/api/tracker/picks?sport=DOTA&limit=1000'], ['tr-VAL', '/api/tracker/picks?sport=VAL&limit=1000'],
      ['board-pp', '/api/props/board?book=prizepicks&sport=ESPORTS&limit=500'], ['board-ud', '/api/props/board?book=underdog&sport=ESPORTS&limit=500'], ['board-sl', '/api/props/board?book=sleeper&sport=ESPORTS&limit=500'],
      ['share', '/api/esports/share?limit=200'], ['h2h', '/api/esports/h2h?limit=200'], ['odds', '/api/esports/match-odds']]) {
      const r = await get(B + p); save(n, r.text); log(n, r.status, r.text.length);
    }
    const PIN = 'https://guest.api.arcadia.pinnacle.com/0.1/sports/12';
    const H = {};
    for (const [n, p] of [['pin-mu', '/matchups'], ['pin-mk', '/markets/straight']]) { const r = await get(PIN + p, H); save(n, r.text); log(n, r.status, r.text.length); }
  }
  if (what === 'all' || what === 'lol') {
    const API = 'https://esports-api.lolesports.com/persisted/gw', H = { 'x-api-key': '0TvQnueqKa5mxJntVWt0w4LpLfEkrV1Ta8rQBb9Z' };
    const ev = []; let token = null; const cutoff = Date.now() - 900 * 86400e3;
    for (let p = 0; p < 600; p++) {
      const r = await get(`${API}/getSchedule?hl=en-US${token ? '&pageToken=' + encodeURIComponent(token) : ''}`, H);
      let sc; try { sc = JSON.parse(r.text).data.schedule; } catch { log('lol sched fail', p, r.status); break; }
      for (const e of sc.events || []) if (e.type === 'match' && e.state === 'completed') ev.push({ t: e.startTime, league: e.league?.name, bo: e.match?.strategy?.count, teams: (e.match?.teams || []).map(t => [t.name, t.code, t.result?.gameWins, t.result?.outcome]) });
      token = sc.pages?.older;
      const oldest = Math.min(...(sc.events || []).map(e => Date.parse(e.startTime) || Infinity));
      if (!token || oldest < cutoff) break;
    }
    save('lol-series', JSON.stringify(ev)); log('lol series', ev.length);
  }
  if (what === 'all' || what === 'dota') {
    const out = []; let lt = null;
    for (let i = 0; i < 250; i++) {
      const r = await get(`https://api.opendota.com/api/proMatches${lt ? '?less_than_match_id=' + lt : ''}`);
      let a; try { a = JSON.parse(r.text); } catch { a = null; }
      if (!Array.isArray(a) || !a.length) { log('dota stop', i, r.status); if (r.status === 429) { await sleep(30000); continue; } break; }
      for (const m of a) out.push([m.match_id, m.start_time, m.series_id, m.series_type, m.radiant_team_id, m.dire_team_id, m.radiant_name, m.dire_name, m.radiant_win ? 1 : 0, m.league_name]);
      lt = a[a.length - 1].match_id;
      await sleep(1100);
    }
    save('dota-series', JSON.stringify(out)); log('dota maps', out.length);
  }
})();
