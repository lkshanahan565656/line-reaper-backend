const fs = require('fs');
const B = 'https://line-reaper-backend-production.up.railway.app';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
const sleep = ms => new Promise(r => setTimeout(r, ms));
fs.mkdirSync('out', { recursive: true });
const log = [];
async function save(name, url, opts = {}) {
  try { const r = await fetch(url, { headers: { 'User-Agent': UA, ...(opts.headers || {}) } }); const t = await r.text(); fs.writeFileSync('out/' + name, t); log.push([name, r.status, t.length]); return t; }
  catch (e) { log.push([name, 0, e.message]); return ''; }
}
(async () => {
  await save('status.json', B + '/api/status');
  await save('val-picks.json', B + '/api/tracker/picks?sport=VAL&limit=1000');
  await save('rounds.json', B + '/api/esports/rounds');
  await save('share.json', B + '/api/esports/share');
  await save('pingaps.json', B + '/api/esports/pingaps');
  for (const p of [1, 2]) { await save(`vlr-results-${p}.html`, `https://www.vlr.gg/matches/results${p > 1 ? `/?page=${p}` : ''}`); await sleep(1500); }
  const ids = [...fs.readFileSync('out/vlr-results-1.html', 'utf8').matchAll(/<a href="\/(\d+)\/[^"]*"[^>]*class="wf-module-item match-item/g)].map(m => m[1]).slice(0, 6);
  for (const id of ids) { await save(`vlr-match-${id}.html`, `https://www.vlr.gg/${id}`); await sleep(1200); }
  await save('vlr-matches.html', 'https://www.vlr.gg/matches'); await sleep(1200);
  await save('opendota-pro.json', 'https://api.opendota.com/api/proMatches');
  await save('bo3.json', 'https://api.bo3.gg/api/v1/matches?page[offset]=0&page[limit]=50&sort=-start_date&with=games&filter[matches.status][in]=finished&filter[matches.discipline_id][eq]=1', { headers: { origin: 'https://bo3.gg', referer: 'https://bo3.gg/', Accept: 'application/json' } });
  const LH = { 'x-api-key': '0TvQnueqKa5mxJntVWt0w4LpLfEkrV1Ta8rQBb9Z' };
  const sch = await save('lole-schedule.json', 'https://esports-api.lolesports.com/persisted/gw/getSchedule?hl=en-US', { headers: LH });
  try {
    const ev = JSON.parse(sch).data.schedule.events.filter(e => e.state === 'completed' && e.match?.id).pop();
    const det = await save('lole-event.json', `https://esports-api.lolesports.com/persisted/gw/getEventDetails?hl=en-US&id=${ev.match.id}`, { headers: LH });
    const g = JSON.parse(det).data.event.match.games.find(x => x.state === 'completed');
    const t = Math.floor((Date.parse(ev.startTime) + 3 * 3600e3) / 10000) * 10000;
    await save('lole-window.json', `https://feed.lolesports.com/livestats/v1/window/${g.id}?startingTime=${new Date(Math.min(t, Math.floor((Date.now() - 120e3) / 10000) * 10000)).toISOString()}`);
  } catch (e) { log.push(['lole', 0, e.message]); }
  await save('pin-matchups.json', 'https://guest.api.arcadia.pinnacle.com/0.1/sports/12/matchups', { headers: { Accept: 'application/json' } });
  await save('pin-markets.json', 'https://guest.api.arcadia.pinnacle.com/0.1/sports/12/markets/straight', { headers: { Accept: 'application/json' } });
  fs.writeFileSync('out/log.json', JSON.stringify(log, null, 1));
})();
