const fs = require('fs');
fs.mkdirSync('out/raw5', { recursive: true });
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
const day = d => new Date(Date.now() + d * 864e5).toISOString().slice(0, 10).replace(/-/g, '');
const BOOKS = '68,69,75,123,79,2988,2724,4620,71,15';
const get = async url => { try { const r = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: AbortSignal.timeout(30000) }); const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {} return { status: r.status, j, len: t.length, head: t.slice(0, 200) }; } catch (e) { return { status: 0, head: String(e.message) }; } };
const types = j => { const c = {}; for (const g of j?.games || []) for (const [b, m] of Object.entries(g.markets || {})) for (const mk of Object.values(m)) for (const [t, o] of Object.entries(mk)) c[t] = (c[t] || 0) + o.length; return c; };
(async () => {
  const sum = {};
  const base = (lg, d) => `https://api.actionnetwork.com/web/v2/scoreboard/${lg}?bookIds=${BOOKS}&periods=event&date=${day(d)}`;
  let r = await get(base('nfl', 4) + '&customPickTypes=core_bet_type_9_xyz');
  sum.suffixIgnored = { status: r.status, types: types(r.j), rules: Object.keys(r.j?.market_rules || {}) };
  r = await get(base('nfl', 4) + '&customPickTypes=core_bet_type_9_passing_yards,core_bet_type_6_team_score');
  sum.comma = { status: r.status, types: types(r.j) };
  // enumerate ids in chunks per league with dummy suffix (if suffix ignored) else nothing
  for (const [lg, d] of [['nfl', 4], ['nba', 1], ['nhl', 1], ['mlb', 0], ['ncaaf', 2]]) {
    const found = {};
    for (let a = 1; a <= 400; a += 40) {
      const list = Array.from({ length: 40 }, (_, i) => `core_bet_type_${a + i}_x`).join(',');
      const x = await get(base(lg, d) + '&customPickTypes=' + list);
      Object.assign(found, x.j?.market_rules ? Object.fromEntries(Object.entries(x.j.market_rules).map(([k, v]) => [k, v.name])) : { ['err' + a]: x.status + ' ' + x.head.slice(0, 80) });
      for (const [t, n] of Object.entries(types(x.j))) found['n:' + t] = n;
    }
    sum[lg] = found;
    fs.writeFileSync('out/summary5.json', JSON.stringify(sum, null, 1));
  }
  fs.writeFileSync('out/summary5.json', JSON.stringify(sum, null, 1));
})();
