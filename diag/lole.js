// LoL per-player, per-game kills from lolesports: schedule → event details → final live-stats frame
const fs = require('fs'), zlib = require('zlib');
const API = 'https://esports-api.lolesports.com/persisted/gw', FEED = 'https://feed.lolesports.com/livestats/v1/window';
const H = { 'x-api-key': '0TvQnueqKa5mxJntVWt0w4LpLfEkrV1Ta8rQBb9Z', 'User-Agent': 'Mozilla/5.0 (LineReaper research)', Accept: 'application/json' };
const sleep = ms => new Promise(r => setTimeout(r, ms));
fs.mkdirSync('out', { recursive: true });
const log = (...a) => { console.log(...a); fs.appendFileSync('out/lole-log.txt', a.join(' ') + '\n'); };
async function j(url) { for (let i = 0; i < 4; i++) { try { const r = await fetch(url, { headers: H, signal: AbortSignal.timeout(30000) }); if (r.status === 429 || r.status >= 500) { await sleep(3000 * (i + 1)); continue; } if (r.status !== 200) return null; return await r.json(); } catch { await sleep(2000); } } return null; }
const DAYS = +(process.env.LOLE_DAYS || 240), cutoff = Date.now() - DAYS * 86400e3;
(async () => {
  const events = []; let token = null;
  for (let p = 0; p < 400; p++) {
    const d = await j(`${API}/getSchedule?hl=en-US${token ? '&pageToken=' + encodeURIComponent(token) : ''}`);
    const sc = d?.data?.schedule; if (!sc) { log('schedule fail', p); break; }
    events.push(...(sc.events || []).filter(e => e.type === 'match' && e.state === 'completed'));
    token = sc.pages?.older;
    const oldest = Math.min(...(sc.events || []).map(e => Date.parse(e.startTime) || Infinity));
    if (!token || oldest < cutoff) break;
  }
  const ms = events.filter(e => Date.parse(e.startTime) >= cutoff && e.match?.id);
  log('matches', ms.length);
  const games = [];
  let done = 0;
  const work = async e => {
    const det = await j(`${API}/getEventDetails?hl=en-US&id=${e.match.id}`);
    const gs = (det?.data?.event?.match?.games || []).filter(g => g.state === 'completed');
    for (const g of gs) {
      const start = Date.parse(e.startTime);
      const t = Math.floor(Math.min(Date.now() - 60e3, start + 14 * 3600e3) / 10000) * 10000;
      const w = await j(`${FEED}/${g.id}?startingTime=${new Date(t).toISOString()}`);
      const fr = w?.frames || [], last = fr[fr.length - 1];
      if (!last || last.gameState !== 'finished') continue;
      const meta = [...(w.gameMetadata?.blueTeamMetadata?.participantMetadata || []), ...(w.gameMetadata?.redTeamMetadata?.participantMetadata || [])];
      const name = id => meta.find(m => m.participantId === id);
      const team = side => ({ kills: last[side]?.totalKills, players: (last[side]?.participants || []).map(p => ({ id: name(p.participantId)?.esportsPlayerId || name(p.participantId)?.summonerName, name: name(p.participantId)?.summonerName, role: name(p.participantId)?.role, kills: p.kills })) });
      games.push({ t: start, n: g.number, league: e.league?.name, teams: [team('blueTeam'), team('redTeam')] });
    }
    if (++done % 100 === 0) { log('done', done, games.length); fs.writeFileSync('out/lol-games.json.gz', zlib.gzipSync(JSON.stringify(games))); }
  };
  for (let i = 0; i < ms.length; i += 6) await Promise.all(ms.slice(i, i + 6).map(e => work(e).catch(() => {})));
  log('games', games.length);
  fs.writeFileSync('out/lol-games.json.gz', zlib.gzipSync(JSON.stringify(games)));
})();
