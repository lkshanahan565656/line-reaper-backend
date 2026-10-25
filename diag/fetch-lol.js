// One-shot: LoL per-game player kills and assists from lolesports (schedule,
// event details, the live-stats window's last frame), for the stack fit.
const fs = require('fs');
const zlib = require('zlib');
const axios = require('axios');
const http = axios.create({ validateStatus: s => s < 500 });
const wait = ms => new Promise(r => setTimeout(r, ms));
const API = 'https://esports-api.lolesports.com/persisted/gw';
const FEED = 'https://feed.lolesports.com/livestats/v1/window';
const H = { 'x-api-key': '0TvQnueqKa5mxJntVWt0w4LpLfEkrV1Ta8rQBb9Z', 'User-Agent': 'Mozilla/5.0 (LineReaper stack fit)' };
const SINCE = Date.now() - Number(process.env.DAYS || 200) * 86400e3;
const DEADLINE = Date.now() + Number(process.env.MINUTES || 34) * 60e3;
fs.mkdirSync('out', { recursive: true });
const log = (...a) => { const s = `[${new Date().toISOString()}] ${a.join(' ')}`; console.log(s); fs.appendFileSync('out/log-lol.txt', s + '\n'); };
async function get(url, opt = {}, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try { const r = await http.get(url, { timeout: 30000, ...opt }); if (r.status === 429 || r.status >= 500) { await wait(2000 * 2 ** i); continue; } return r; } catch { await wait(2000 * 2 ** i); }
  }
  return null;
}
(async () => {
  const events = [];
  let token = null;
  for (let p = 0; p < 200 && Date.now() < DEADLINE; p++) {
    const r = await get(`${API}/getSchedule`, { params: { hl: 'en-US', ...(token ? { pageToken: token } : {}) }, headers: H });
    const sc = r?.data?.data?.schedule;
    const ev = sc?.events || [];
    events.push(...ev);
    token = sc?.pages?.older;
    const oldest = Math.min(...ev.map(e => Date.parse(e.startTime) || Infinity));
    if (!token || oldest < SINCE) break;
    await wait(300);
  }
  const done = events.filter(e => e.type === 'match' && e.state === 'completed' && Date.parse(e.startTime) > SINCE && Date.parse(e.startTime) < Date.now() - 3 * 3600e3)
    .sort((a, b) => Date.parse(b.startTime) - Date.parse(a.startTime));
  log('lol matches', done.length, 'events', events.length);
  const out = [];
  const save = () => { fs.writeFileSync('out/lol2.json.gz', zlib.gzipSync(JSON.stringify(out))); log('saved', out.length); };
  for (const e of done) {
    if (Date.now() > DEADLINE) { log('deadline'); break; }
    const d = await get(`${API}/getEventDetails`, { params: { hl: 'en-US', id: e.match.id }, headers: H });
    const m = d?.data?.data?.event?.match;
    const teams = (m?.teams || []).map(t => ({ id: t.id, name: t.name, code: t.code }));
    const games = (m?.games || []).filter(g => g.state === 'completed').sort((a, b) => a.number - b.number);
    if (teams.length !== 2 || !games.length) continue;
    const s = { id: `lole:${e.match.id}`, t: e.startTime, lg: e.league?.name || null, bo: e.match?.strategy?.count || null, teams: teams.map(t => t.name), maps: [] };
    const start = Date.parse(e.startTime);
    for (const g of games) {
      const t = Math.floor(Math.min(Date.now() - 60e3, start + 14 * 3600e3) / 10000) * 10000;
      const r = await get(`${FEED}/${g.id}`, { params: { startingTime: new Date(t).toISOString() }, headers: { 'User-Agent': H['User-Agent'] } });
      const data = r?.data;
      const frames = data?.frames || [];
      const last = frames[frames.length - 1];
      if (!last || last.gameState !== 'finished') { await wait(120); continue; }
      const p = [];
      for (const side of ['blue', 'red']) {
        const md = data.gameMetadata?.[`${side}TeamMetadata`];
        const ti = teams.findIndex(x => x.id === md?.esportsTeamId);
        for (const pm of md?.participantMetadata || []) {
          const row = (last[`${side}Team`]?.participants || []).find(x => x.participantId === pm.participantId);
          if (row) p.push([ti, pm.esportsPlayerId || pm.summonerName, row.kills, row.assists, pm.role || null]);
        }
      }
      s.maps.push({ n: g.number, p, len: Date.parse(last.rfc460Timestamp) - Date.parse(frames[0]?.rfc460Timestamp) });
      await wait(120);
    }
    if (s.maps.length) out.push(s);
    if (out.length % 100 === 0) save();
    await wait(150);
  }
  save();
  log('done');
})();
