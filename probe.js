const PIN = 'https://guest.api.arcadia.pinnacle.com/0.1';
const H = { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' };
const K = 'https://api.elections.kalshi.com/trade-api/v2';
const j = async (u, h = {}) => { try { const r = await fetch(u, { headers: h }); const t = await r.text(); let d = null; try { d = JSON.parse(t); } catch {} return { s: r.status, d, t: t.slice(0, 300) }; } catch (e) { return { s: 0, d: null, t: e.message }; } };
const show = (x, n = 1500) => JSON.stringify(x)?.slice(0, n);
(async () => {
  for (const sp of [29, 33, 4, 19, 15]) {
    const mu = await j(`${PIN}/sports/${sp}/matchups`, H);
    const arr = Array.isArray(mu.d) ? mu.d : [];
    const live = arr.filter(m => m.isLive);
    console.log(`\n== sport ${sp} matchups ${mu.s} n=${arr.length} live=${live.length} ${mu.s !== 200 ? mu.t : ''}`);
    const types = {}; for (const m of arr) { const k = `${m.type}|live=${!!m.isLive}|parent=${m.parentId != null}|units=${m.units}`; types[k] = (types[k] || 0) + 1; }
    console.log('types', show(types));
    const top = live.find(m => m.parentId == null && m.type === 'matchup') || live[0];
    if (top) console.log('LIVE matchup sample', show(top, 2500));
    if (top?.parentId) { const par = arr.find(m => m.id === top.parentId); console.log('its parent', show(par, 800)); }
    const mk = await j(`${PIN}/sports/${sp}/markets/straight`, H);
    const mks = Array.isArray(mk.d) ? mk.d : [];
    const liveIds = new Set(live.map(m => m.id));
    const lm = mks.filter(m => liveIds.has(m.matchupId));
    console.log(`markets/straight ${mk.s} n=${mks.length} onLive=${lm.length}`, lm[0] ? show(lm.slice(0, 3), 1500) : '');
    const ml = await j(`${PIN}/sports/${sp}/markets/live/straight`, H);
    const mls = Array.isArray(ml.d) ? ml.d : [];
    console.log(`markets/live/straight ${ml.s} n=${mls.length} onLive=${mls.filter(m => liveIds.has(m.matchupId)).length}`, mls[0] ? show(mls.slice(0, 3), 1500) : ml.t);
    const mul = await j(`${PIN}/sports/${sp}/matchups/live`, H);
    console.log(`matchups/live ${mul.s} n=${Array.isArray(mul.d) ? mul.d.length : '-'}`, mul.s !== 200 ? mul.t : show(mul.d?.[0], 600));
    if (top) { const rel = await j(`${PIN}/matchups/${top.id}/markets/related/straight`, H); console.log(`related ${rel.s} n=${Array.isArray(rel.d) ? rel.d.length : '-'}`, show(rel.d?.slice?.(0, 3), 1500)); }
    if (top) { const m1 = await j(`${PIN}/matchups/${top.id}`, H); console.log('matchup by id', m1.s, show(m1.d, 1500)); }
  }
  for (const s of ['KXEPLGAME', 'KXSERIEAGAME', 'KXNBAGAME', 'KXNHLGAME', 'KXNFLGAME', 'KXNBASPREAD', 'KXNBATOTAL', 'KXATPMATCH']) {
    const r = await j(`${K}/markets?series_ticker=${s}&status=open&limit=200`);
    const ms = r.d?.markets || [];
    console.log(`\n== kalshi ${s} ${r.s} n=${ms.length}`, ms.slice(0, 6).map(m => `${m.ticker} ${m.status} exp=${m.expected_expiration_time} yb=${m.yes_bid_dollars ?? m.yes_bid} ya=${m.yes_ask_dollars ?? m.yes_ask}`).join(' ; '));
    if (ms[0]) console.log('sample', show(ms[0], 2500));
    if (ms[0]) { const ob = await j(`${K}/markets/${ms[0].ticker}/orderbook`); console.log('orderbook', ob.s, show(ob.d, 800)); }
  }
  const e = await j('https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard');
  console.log('\nESPN nba', e.s, (e.d?.events || []).map(x => `${x.shortName} ${x.date} ${x.status?.type?.name}`).join(' | '));
  for (const [sp, lg] of [['hockey', 'nhl'], ['football', 'nfl']]) { const x = await j(`https://site.api.espn.com/apis/site/v2/sports/${sp}/${lg}/scoreboard`); console.log('ESPN', lg, x.s, (x.d?.events || []).map(y => `${y.shortName} ${y.date} ${y.status?.type?.name}`).join(' | ')); }
})();
