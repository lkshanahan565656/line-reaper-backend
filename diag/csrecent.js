// Recent CS2 maps with per-player kills from bo3.gg (s/a/b tier), same shape as diag-mapstats-out data/ps.json.gz
const fs = require('fs'), zlib = require('zlib');
const BO3 = 'https://api.bo3.gg/api/v1', H = { origin: 'https://bo3.gg', referer: 'https://bo3.gg/', 'User-Agent': 'Mozilla/5.0 (LineReaper research)', Accept: 'application/json' };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const SINCE = Date.parse(process.env.SINCE || '2026-10-01');
async function get(url, params = {}, tries = 6) {
  const u = new URL(url); for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.set(k, v);
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(u, { headers: H, signal: AbortSignal.timeout(30000) });
      if (r.status === 429) { await sleep(2000 * (i + 1)); continue; }
      if (r.status >= 400 && r.status < 500) return null;
      if (!r.ok) { await sleep(1500 * (i + 1)); continue; }
      return await r.json(); } catch { await sleep(1500 * (i + 1)); }
  }
  return null;
}
async function pool(items, n, fn) { let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const x = items[i++]; await fn(x); } })); }
(async () => {
  fs.mkdirSync('out', { recursive: true });
  const ms = [];
  for (let p = 0; p < 200; p++) {
    const d = await get(`${BO3}/matches`, { 'page[offset]': p * 100, 'page[limit]': 100, sort: '-start_date', 'filter[matches.status][in]': 'finished', 'filter[matches.discipline_id][eq]': 1 });
    const rows = d?.results || [];
    ms.push(...rows.filter(m => ['s', 'a', 'b'].includes(m.tier)).map(m => ({ id: m.id, a: m.team1_id, b: m.team2_id, s1: m.team1_score, s2: m.team2_score, t: m.start_date, bo: m.bo_type, tier: m.tier })));
    const oldest = Math.min(...rows.map(m => Date.parse(m.start_date) || Infinity));
    if (rows.length < 100 || oldest < SINCE) break;
    await sleep(250);
  }
  const keep = ms.filter(m => Date.parse(m.t) >= SINCE);
  const ids = [...new Set(keep.flatMap(m => [m.a, m.b]).filter(x => x != null))], names = {};
  for (let i = 0; i < ids.length; i += 100) {
    const d = await get(`${BO3}/teams`, { 'filter[teams.id][in]': ids.slice(i, i + 100).join(','), 'page[limit]': 100 });
    for (const t of d?.results || []) names[t.id] = t.name; await sleep(200);
  }
  const byId = new Map(keep.map(m => [m.id, { ...m, an: names[m.a] || null, bn: names[m.b] || null, games: [] }]));
  const chunks = []; const mids = [...byId.keys()]; for (let i = 0; i < mids.length; i += 60) chunks.push(mids.slice(i, i + 60));
  await pool(chunks, 3, async ch => {
    for (let off = 0; off < 1000; off += 100) {
      const d = await get(`${BO3}/games`, { 'filter[games.match_id][in]': ch.join(','), 'page[limit]': 100, 'page[offset]': off });
      const rows = d?.results || [];
      for (const g of rows) byId.get(g.match_id)?.games.push({ gid: g.id, n: g.number, map: g.map_name, begin: g.begin_at, w: g.winner_clan_name, l: g.loser_clan_name, ws: g.winner_clan_score, ls: g.loser_clan_score, rounds: g.rounds_count ?? null, st: g.status });
      if (rows.length < 100) break;
    }
  });
  const games = [...byId.values()].flatMap(m => m.games.filter(g => g.st === 'finished' && g.map));
  log('matches', keep.length, 'games', games.length);
  await pool(games, 4, async g => {
    const d = await get(`${BO3}/games/${g.gid}/players_stats`);
    const rows = Array.isArray(d) ? d : (d?.results || d?.data || []);
    g.p = rows.map(r => [r?.steam_profile?.player?.slug || r?.steam_profile?.player?.nickname || r?.steam_profile?.nickname || null, r?.steam_profile?.player?.nickname || r?.steam_profile?.nickname || null, r.clan_name ?? r.team_clan?.clan_name ?? r.clan?.name ?? null, r.kills ?? null, r.death ?? r.deaths ?? null, r.assists ?? null, r.headshots ?? null, r.adr ?? null]);
  });
  fs.writeFileSync('out/cs-recent.json.gz', zlib.gzipSync(JSON.stringify([...byId.values()])));
  log('saved', games.filter(g => g.p?.length).length, 'maps with stats');
})();
