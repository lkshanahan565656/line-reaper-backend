// probe: Pinnacle live 401 rate, league endpoints, freshness
const PIN = 'https://guest.api.arcadia.pinnacle.com/0.1', H = { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' };
const j = async u => { try { const r = await fetch(u, { headers: H }); const t = await r.text(); let d = null; try { d = JSON.parse(t); } catch {} return { s: r.status, d, h: Object.fromEntries([...r.headers].filter(([k]) => /cache|age|date|ratelimit|retry/i.test(k))) }; } catch (e) { return { s: 0, e: e.message }; } };
(async () => {
  for (const [lg, id] of [['nba', 487], ['nhl', 1456], ['nfl', 889]]) {
    for (const p of ['matchups', 'matchups/live', 'markets/straight', 'markets/live/straight']) {
      const r = await j(`${PIN}/leagues/${id}/${p}`);
      const a = Array.isArray(r.d) ? r.d : [];
      console.log(lg, p, r.s, 'n', a.length, 'live', a.filter(m => m.isLive).length, JSON.stringify(r.h));
    }
  }
  const t0 = Date.now(); const cnt = {};
  let prev = '';
  while (Date.now() - t0 < 180e3) {
    const mu = await j(`${PIN}/leagues/487/matchups/live`);
    const mk = await j(`${PIN}/leagues/487/markets/live/straight`);
    const s = await j(`${PIN}/sports/4/matchups/live`);
    for (const [k, r] of [['lgmu', mu], ['lgmk', mk], ['spmu', s]]) cnt[`${k}${r.s}`] = (cnt[`${k}${r.s}`] || 0) + 1;
    const live = (Array.isArray(mu.d) ? mu.d : []).filter(m => m.isLive && m.type === 'matchup' && m.units === 'Regular');
    const ids = new Set(live.map(m => m.id));
    const ml = (Array.isArray(mk.d) ? mk.d : []).filter(m => ids.has(m.matchupId) && m.period === 0 && (m.type === 'moneyline' || (m.type === 'total' && !m.isAlternate)));
    const sig = live.map(m => `${m.participants?.[0]?.name?.slice(0, 8)} ${JSON.stringify(m.parent?.state)} ${m.parent?.participants?.map(p => p.state?.score).join('-')}`).join(' | ') + ' || ' + ml.map(m => `${m.matchupId % 1000}:${m.type[0]}:${m.prices.map(p => (p.points ?? '') + '/' + p.price).join(',')}:v${m.version % 100000}`).join(' ');
    if (sig !== prev) { console.log(new Date().toISOString(), sig.slice(0, 1500)); prev = sig; }
    await new Promise(r => setTimeout(r, 5000));
  }
  console.log('status counts', JSON.stringify(cnt));
})();
