// bo3.gg: every finished CS2 match (all tiers) since SINCE, with each game's
// players_stats, in the ps.json format
const fs = require('fs'), zlib = require('zlib');
const BO3 = 'https://api.bo3.gg/api/v1', H = { origin: 'https://bo3.gg', referer: 'https://bo3.gg/', 'User-Agent': 'Mozilla/5.0 (LineReaper research)', Accept: 'application/json' };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const SINCE = Date.parse(process.env.SINCE || '2026-10-12');
async function get(url, params = {}) {
  const u = new URL(url); for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  for (let i = 0; i < 6; i++) {
    try { const r = await fetch(u, { headers: H, signal: AbortSignal.timeout(30000) }); if (r.status === 429 || r.status >= 500) { await sleep(2000 * (i + 1)); continue; } if (!r.ok) return null; return await r.json(); } catch { await sleep(1500 * (i + 1)); }
  }
  return null;
}
(async () => {
  fs.mkdirSync('data', { recursive: true });
  const ms = [];
  for (let off = 0; off < 3000; off += 100) {
    const d = await get(`${BO3}/matches`, { 'page[offset]': off, 'page[limit]': 100, sort: '-start_date', 'filter[matches.status][in]': 'finished', 'filter[matches.discipline_id][eq]': 1 });
    const rows = d?.results || [];
    ms.push(...rows.filter(m => Date.parse(m.start_date) >= SINCE));
    if (rows.length < 100 || Math.min(...rows.map(m => Date.parse(m.start_date))) < SINCE) break;
    await sleep(250);
  }
  log('matches', ms.length);
  const ids = [...new Set(ms.flatMap(m => [m.team1_id, m.team2_id]).filter(x => x != null))], names = {};
  for (let i = 0; i < ids.length; i += 100) { const d = await get(`${BO3}/teams`, { 'filter[teams.id][in]': ids.slice(i, i + 100).join(','), 'page[limit]': 100 }); for (const t of d?.results || []) names[t.id] = t.name; await sleep(250); }
  const byId = new Map(ms.map(m => [m.id, { id: m.id, t: m.start_date, tier: m.tier, bo: m.bo_type, an: names[m.team1_id] || null, bn: names[m.team2_id] || null, a: m.team1_id, b: m.team2_id, s1: m.team1_score, s2: m.team2_score, games: [] }]));
  const all = [...byId.keys()];
  for (let i = 0; i < all.length; i += 60) {
    const d = await get(`${BO3}/games`, { 'filter[games.match_id][in]': all.slice(i, i + 60).join(','), 'page[limit]': 100 });
    for (const g of d?.results || []) byId.get(g.match_id)?.games.push({ gid: g.id, n: g.number, map: g.map_name, begin: g.begin_at, w: g.winner_clan_name, l: g.loser_clan_name, ws: g.winner_clan_score, ls: g.loser_clan_score, rounds: g.rounds_count ?? null, st: g.status });
    await sleep(250);
  }
  let n = 0;
  for (const m of byId.values()) for (const g of m.games) {
    if (g.st !== 'finished') continue;
    const d = await get(`${BO3}/games/${g.gid}/players_stats`);
    const rows = Array.isArray(d) ? d : (d?.results || []);
    g.p = rows.map(r => [r?.steam_profile?.player?.slug || r?.steam_profile?.player?.nickname || r?.steam_profile?.nickname || null, r?.steam_profile?.player?.nickname || r?.steam_profile?.nickname || null, r.clan_name ?? r.team_clan?.clan_name ?? r.clan?.name ?? null, r.kills ?? null, r.death ?? r.deaths ?? null]);
    if (++n % 200 === 0) log('stats', n);
    await sleep(200);
  }
  fs.writeFileSync('data/recent.json.gz', zlib.gzipSync(JSON.stringify([...byId.values()])));
  log('done', n);
})();
