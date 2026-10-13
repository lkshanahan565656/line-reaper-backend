const U = 'https://line-reaper-backend-production.up.railway.app';
const get = async (p, abs) => { try { const r = await fetch(abs ? p : U + p, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(60000) }); return await r.json(); } catch (e) { return { error: e.message }; } };
const out = (n, v) => console.log(`==== ${n}\n${JSON.stringify(v)}\n`);
const cnt = (xs, f) => xs.reduce((o, x) => { const k = f(x); o[k] = (o[k] || 0) + 1; return o; }, {});
const nm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
(async () => {
  const ud = (await get('/api/underdog')).data || [], pp = (await get('/api/prizepicks')).data || [], sl = (await get('/api/sleeper')).data || [];
  for (const [n, d] of [['ud', ud], ['pp', pp], ['sl', sl]]) {
    out(n + '-bySport', cnt(d, x => x.sport));
    const bs = {};
    for (const x of d) { (bs[x.sport] = bs[x.sport] || {}); bs[x.sport][x.market] = (bs[x.sport][x.market] || 0) + 1; }
    out(n + '-markets', bs);
    out(n + '-sample', d.filter((x, i) => i % Math.max(1, Math.floor(d.length / 4)) === 0).slice(0, 4));
  }
  // overlap of players by sport
  const players = d => new Set(d.map(x => `${String(x.sport).toUpperCase()}|${nm(x.player)}`));
  const P = { ud: players(ud), pp: players(pp), sl: players(sl) };
  const ov = (a, b) => [...P[a]].filter(k => P[b].has(k)).length;
  out('player-overlap', { ud: P.ud.size, pp: P.pp.size, sl: P.sl.size, udpp: ov('ud', 'pp'), udsl: ov('ud', 'sl'), ppsl: ov('pp', 'sl') });
  const ep = await get('/api/esports/picks');
  const picks = ep.picks || [];
  out('esports-picks', { n: picks.length, bySource: cnt(picks, p => p.lineSource), books: cnt(picks, p => [p.ppEv != null || p.lineSource === 'pp' ? 'PP' : '', p.udLine != null ? 'UD' : '', p.sleeperLine != null ? 'SL' : ''].filter(Boolean).join('+') || 'none'), withSide: picks.filter(p => p.side).length, sample: picks.slice(0, 2) });
  // raw sleeper rows
  const raw = await get('https://api.sleeper.app/lines/available?dynamic=true&include_preseason=true&eg=15.control', true);
  const rows = Array.isArray(raw) ? raw : [];
  out('sleeper-raw', { n: rows.length, bySport: cnt(rows, r => r.sport), subj: cnt(rows, r => r.subject_type), outcome: cnt(rows, r => r.outcome_type), status: cnt(rows, r => r.status), gstatus: cnt(rows, r => r.game_status), keys: Object.keys(rows[0] || {}), optKeys: Object.keys(rows[0]?.options?.[0] || {}) });
  const bySp = {};
  for (const r of rows) { bySp[r.sport] = bySp[r.sport] || {}; bySp[r.sport][r.wager_type] = (bySp[r.sport][r.wager_type] || 0) + 1; }
  out('sleeper-wagers', bySp);
  for (const s of ['nfl', 'mlb', 'nba', 'nhl']) out('sleeper-row-' + s, rows.find(r => r.sport === s && r.subject_type === 'player'));
  const pl = await get('https://api.sleeper.app/players/nfl', true);
  const k = Object.keys(pl || {});
  out('sleeper-players-nfl', { n: k.length, sample: pl[k[100]] && { first_name: pl[k[100]].first_name, last_name: pl[k[100]].last_name, full_name: pl[k[100]].full_name, team: pl[k[100]].team, metadata: pl[k[100]].metadata } });
  const ev = await get('/api/ev?limit=2000');
  const er = ev.rows || ev.edges || [];
  out('ev', { keys: Object.keys(ev), n: er.length, dfs: cnt(er.filter(r => r.dfs), r => r.book), sample: er.filter(r => r.dfs).slice(0, 2) });
})();
