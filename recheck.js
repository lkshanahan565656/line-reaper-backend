// Independent re-grade of CS stack legs from bo3.gg box scores (own parse)
const fs = require('fs');
const H = { origin: 'https://bo3.gg', referer: 'https://bo3.gg/', 'User-Agent': 'Mozilla/5.0 (LineReaper recheck)', Accept: 'application/json' };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sq = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
async function get(url) { for (let i = 0; i < 4; i++) { try { const r = await fetch(url, { headers: H }); if (r.ok) return r.json(); await sleep(2000 * (i + 1)); } catch (e) { await sleep(2000); } } return null; }
(async () => {
  const stacks = JSON.parse(fs.readFileSync('stacks.json'));
  const from = Date.parse('2026-10-13T00:00:00Z');
  const matches = [];
  for (let off = 0; off < 4000; off += 100) {
    const u = `https://api.bo3.gg/api/v1/matches?page[offset]=${off}&page[limit]=100&sort=-start_date&with=games&filter[matches.status][in]=finished&filter[matches.discipline_id][eq]=1`;
    const d = await get(u); const rows = d?.results || []; matches.push(...rows);
    if (rows.length < 100 || Math.min(...rows.map(m => Date.parse(m.start_date))) < from) break; await sleep(400);
  }
  const names = m => { const s = new Set(); for (const g of m.games || []) for (const c of [g.winner_team_clan, g.loser_team_clan]) for (const v of [c?.clan_name, c?.team?.name, c?.team?.slug, c?.team?.acronym]) if (sq(v)) s.add(sq(v)); return [...s]; };
  const has = (m, t) => { t = sq(t); return t.length >= 2 && names(m).some(n => n === t || (Math.min(n.length, t.length) >= 4 && (n.includes(t) || t.includes(n)))); };
  const statsCache = new Map();
  async function mapStats(id) { if (statsCache.has(id)) return statsCache.get(id); const d = await get(`https://api.bo3.gg/api/v1/games/${id}/players_stats`); const rows = Array.isArray(d) ? d : d?.results || []; statsCache.set(id, rows); await sleep(300); return rows; }
  const out = [];
  for (const s of stacks) {
    const teams = [...new Set(s.legs.map(l => l.team).filter(Boolean))];
    const res = { id: s.id, book: s.book, size: s.size, hits: s.hits, legs: [] };
    for (const l of s.legs) {
      if (l.sport !== 'CS') { res.legs.push({ player: l.player, skip: l.sport }); continue; }
      const t0 = Date.parse(l.startTime);
      const c = matches.filter(m => Math.abs(Date.parse(m.start_date) - t0) < 4 * 3600e3 && teams.every(t => has(m, t)));
      if (c.length !== 1) { res.legs.push({ player: l.player, ambiguous: c.length }); continue; }
      const m = c[0]; let sum = 0, found = 0;
      const games = (m.games || []).filter(g => (l.maps || []).includes(g.number));
      for (const g of games) { const rows = await mapStats(g.id); const r = rows.find(r => [r?.steam_profile?.player?.nickname, r?.steam_profile?.nickname, r?.steam_profile?.player?.slug].some(n => sq(n) === sq(l.player))); if (r) { found++; sum += Number(l.stat === 'headshots' ? r.headshots : r.kills) || 0; } }
      const ok = found === games.length && games.length === (l.maps || []).length;
      res.legs.push({ player: l.player, match: m.slug, maps: games.length, found, mine: ok ? sum : null, theirs: l.result, line: l.line, side: l.side });
    }
    out.push(res);
  }
  fs.writeFileSync('out/recheck.json', JSON.stringify({ at: new Date().toISOString(), matches: matches.length, out }, null, 1));
})();
