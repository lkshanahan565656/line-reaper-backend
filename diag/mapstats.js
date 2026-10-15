// Map-aware CS2 projection data: for s/a/b-tier bo3.gg matches since SINCE,
// every game's map, score and per-player kills/deaths (players_stats).
// Input: /tmp/bo3-cs.json.gz (the diag-veto pull). Output data/ps.json.gz.
const fs = require('fs'), zlib = require('zlib');
const BO3 = 'https://api.bo3.gg/api/v1', H = { origin: 'https://bo3.gg', referer: 'https://bo3.gg/', 'User-Agent': 'Mozilla/5.0 (LineReaper research)', Accept: 'application/json' };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const SINCE = process.env.SINCE || '2025-09-01';
let calls = 0, errs = 0;
async function get(url, params = {}, tries = 6) {
  const u = new URL(url); for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.set(k, v);
  for (let i = 0; i < tries; i++) {
    calls++;
    try {
      const r = await fetch(u, { headers: H, signal: AbortSignal.timeout(30000) });
      if (r.status === 429) { await sleep(2000 * (i + 1)); continue; }
      if (r.status >= 400 && r.status < 500) { errs++; return null; }
      if (!r.ok) { await sleep(1500 * (i + 1)); continue; }
      return await r.json();
    } catch (e) { await sleep(1500 * (i + 1)); }
  }
  errs++; return null;
}
async function pool(items, n, fn) { let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const x = items[i++]; await fn(x); } })); }
(async () => {
  const all = JSON.parse(zlib.gunzipSync(fs.readFileSync('/tmp/bo3-cs.json.gz')));
  const ms = all.filter(m => m.t >= SINCE && (process.env.TIERS || 's,a,b').split(',').includes(m.tier) && m.g.length);
  log('matches', ms.length);
  const byId = new Map(ms.map(m => [m.id, { id: m.id, t: m.t, tier: m.tier, bo: m.bo, an: m.an, bn: m.bn, a: m.a, b: m.b, s1: m.s1, s2: m.s2, games: [] }]));
  const chunks = []; const ids = [...byId.keys()]; for (let i = 0; i < ids.length; i += 60) chunks.push(ids.slice(i, i + 60));
  let raw = 0;
  await pool(chunks, 3, async ch => {
    for (let off = 0; off < 1000; off += 100) {
      const d = await get(`${BO3}/games`, { 'filter[games.match_id][in]': ch.join(','), 'page[limit]': 100, 'page[offset]': off });
      const rows = d?.results || [];
      if (raw++ === 0) fs.writeFileSync('data/game-raw.json', JSON.stringify(rows[0] || null));
      for (const g of rows) byId.get(g.match_id)?.games.push({ gid: g.id, n: g.number, map: g.map_name, begin: g.begin_at, w: g.winner_clan_name, l: g.loser_clan_name, ws: g.winner_clan_score, ls: g.loser_clan_score, rounds: g.rounds_count ?? null, st: g.status });
      if (rows.length < 100) break;
    }
  });
  const games = [...byId.values()].flatMap(m => m.games.filter(g => g.st === 'finished' && g.map).map(g => [m, g]));
  log('games', games.length);
  let done = 0, rawp = 0, withStats = 0;
  await pool(games, 4, async ([m, g]) => {
    const d = await get(`${BO3}/games/${g.gid}/players_stats`);
    const rows = Array.isArray(d) ? d : (d?.results || d?.data || []);
    if (rawp++ < 2) fs.writeFileSync(`data/ps-raw-${rawp}.json`, JSON.stringify(d).slice(0, 60000));
    g.p = rows.map(r => [r?.steam_profile?.player?.slug || r?.steam_profile?.player?.nickname || r?.steam_profile?.nickname || null, r?.steam_profile?.player?.nickname || r?.steam_profile?.nickname || null, r.clan_name ?? r.team_clan?.clan_name ?? r.clan?.name ?? null, r.kills ?? null, r.death ?? r.deaths ?? null, r.assists ?? null, r.headshots ?? null, r.adr ?? null]);
    if (g.p.length) withStats++;
    if (++done % 1000 === 0) log('stats', done, '/', games.length, 'with', withStats, 'calls', calls, 'errs', errs);
  });
  fs.writeFileSync('data/ps.json.gz', zlib.gzipSync(JSON.stringify([...byId.values()])));
  log('done', games.length, 'with stats', withStats, 'calls', calls, 'errs', errs);
})();
