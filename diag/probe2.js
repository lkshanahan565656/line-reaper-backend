// probe 2: Action Network books/props, Matchbook esports + US sports, Smarkets quotes, Polymarket esports
const fs = require('fs');
fs.mkdirSync('out/raw2', { recursive: true });
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
const day = d => new Date(Date.now() + d * 864e5).toISOString().slice(0, 10).replace(/-/g, '');
const BOOKS = '68,69,75,123,79,2988,2724,4620,78,3,34,1,21,4727,4795,1467,71,15';
const get = async (url, hdr = {}) => { try { const r = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json', ...hdr }, signal: AbortSignal.timeout(25000) }); const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {} return { status: r.status, j, len: t.length, head: j ? null : t.slice(0, 200) }; } catch (e) { return { status: 0, err: String(e.message) }; } };
const save = (n, o) => fs.writeFileSync('out/raw2/' + n + '.json', JSON.stringify(o));
(async () => {
  const sum = {};
  // Action Network: which books post per league
  for (const lg of ['nfl', 'ncaaf', 'nhl', 'mlb', 'nba', 'wnba', 'soccer', 'atp', 'ufc']) {
    const r = await get(`https://api.actionnetwork.com/web/v1/scoreboard/${lg}?period=game&bookIds=${BOOKS}&date=${day(lg === 'ncaaf' ? 2 : 1)}`);
    const gs = r.j?.games || [];
    const byBook = {};
    for (const g of gs) for (const o of g.odds || []) if (o.type === 'game') byBook[o.book_id] = (byBook[o.book_id] || 0) + 1;
    sum['an-' + lg] = { status: r.status, games: gs.length, byBook, inserted: gs[0]?.odds?.map(o => [o.book_id, o.inserted]).slice(0, 20) };
    if (lg === 'nfl') save('an-nfl', r.j);
  }
  // Action Network v2 scoreboard and props guesses
  const nfl = (await get(`https://api.actionnetwork.com/web/v1/scoreboard/nfl?period=game&bookIds=${BOOKS}&date=${day(1)}`)).j;
  const gid = nfl?.games?.[0]?.id;
  for (const [k, u] of [
    ['v2-scoreboard', `https://api.actionnetwork.com/web/v2/scoreboard/nfl?bookIds=${BOOKS}&periods=event&date=${day(1)}`],
    ['v2-markets-event', `https://api.actionnetwork.com/web/v2/markets/event/${gid}?bookIds=${BOOKS}`],
    ['v2-game-props', `https://api.actionnetwork.com/web/v2/games/${gid}/props?bookIds=${BOOKS}`],
    ['v1-game-props', `https://api.actionnetwork.com/web/v1/games/${gid}/props?bookIds=${BOOKS}`],
    ['v2-games-polling', `https://api.actionnetwork.com/web/v2/games/${gid}/polling?bookIds=${BOOKS}`],
    ['v1-game', `https://api.actionnetwork.com/web/v1/games/${gid}?bookIds=${BOOKS}`],
    ['v2-markets-nfl', `https://api.actionnetwork.com/web/v2/scoreboard/nfl/markets?bookIds=${BOOKS}&date=${day(1)}&customPickTypes=core_bet_type_9_passing_yards`],
    ['v1-props-league', `https://api.actionnetwork.com/web/v1/leagues/1/props?bookIds=${BOOKS}`],
    ['v2-props-pass', `https://api.actionnetwork.com/web/v2/leagues/1/props/core_bet_type_9_passing_yards?bookIds=${BOOKS}`],
    ['v1-projections', `https://api.actionnetwork.com/web/v1/leagues/1/projections/core_bet_type_9_passing_yards?bookIds=${BOOKS}`],
  ]) { const r = await get(u); sum['an-' + k] = { status: r.status, len: r.len, head: r.head || JSON.stringify(r.j).slice(0, 400) }; if (r.j && r.status === 200) save('an-' + k, r.j); }
  // Matchbook
  for (const [k, sid] of [['esports', 123], ['amfootball', 1], ['ncaaf', 2], ['icehockey', 6], ['baseball', 3], ['basketball', 4], ['soccer', 15], ['tennis', 9]]) {
    const r = await get(`https://api.matchbook.com/edge/rest/events?sport-ids=${sid}&per-page=200&include-prices=true&price-depth=3&states=open&exchange-type=back-lay&odds-type=DECIMAL`);
    const ev = r.j?.events || [];
    const mt = {}; let vol = 0, depth = [];
    for (const e of ev) { vol += e.volume || 0; for (const m of e.markets || []) { mt[m['market-type']] = (mt[m['market-type']] || 0) + 1; for (const ru of m.runners || []) for (const p of ru.prices || []) if (p.side === 'back') depth.push(p['available-amount']); } }
    depth.sort((a, b) => a - b);
    sum['mb-' + k] = { status: r.status, total: r.j?.total, events: ev.length, marketTypes: mt, volume: Math.round(vol), medianBackDepth: depth[depth.length >> 1], names: ev.slice(0, 15).map(e => e.name + ' @' + e.start + ' v' + Math.round(e.volume || 0)) };
    save('mb-' + k, r.j);
  }
  // Smarkets
  const se = await get('https://api.smarkets.com/v3/events/?type_domain=esports&state=upcoming&limit=300&type=esport_match');
  sum['sm-esport-match'] = { status: se.status, n: se.j?.events?.length, head: JSON.stringify(se.j).slice(0, 300) };
  const se2 = await get('https://api.smarkets.com/v3/events/?type_scope=single_event&state=upcoming&limit=300&type_domain=esports');
  sum['sm-esports-single'] = { status: se2.status, n: se2.j?.events?.length, names: (se2.j?.events || []).slice(0, 20).map(e => e.name + ' ' + e.type) };
  const nf = await get('https://api.smarkets.com/v3/events/?type=american_football_match&state=upcoming&limit=50');
  const ids = (nf.j?.events || []).slice(0, 5).map(e => e.id).join(',');
  const mk = await get(`https://api.smarkets.com/v3/events/${ids}/markets/?limit_by_event=20`);
  const mids = (mk.j?.markets || []).slice(0, 10).map(m => m.id).join(',');
  const qt = await get(`https://api.smarkets.com/v3/markets/${mids}/quotes/`);
  const ct = await get(`https://api.smarkets.com/v3/markets/${mids}/contracts/`);
  const vols = await get(`https://api.smarkets.com/v3/markets/${mids}/volumes/`);
  sum.smarkets = { events: nf.j?.events?.length, names: (nf.j?.events || []).slice(0, 8).map(e => e.name), markets: (mk.j?.markets || []).slice(0, 10).map(m => m.name), quotes: qt.status, quoteHead: JSON.stringify(qt.j).slice(0, 600), contracts: JSON.stringify(ct.j).slice(0, 300), volumes: JSON.stringify(vols.j).slice(0, 600) };
  // Polymarket esports games via gamma
  const pm = await get('https://gamma-api.polymarket.com/events?tag_slug=esports&active=true&closed=false&limit=100&order=startDate&ascending=true');
  sum.polymarket = { status: pm.status, n: (pm.j || []).length };
  // Bovada esports + nfl props shape
  const bv = await get('https://www.bovada.lv/services/sports/event/coupon/events/A/description/esports?marketFilterId=def&preMatchOnly=true&lang=en');
  const bvn = (bv.j || []).reduce((n, x) => n + x.events.length, 0);
  const bev = (bv.j || [])[0]?.events?.[0];
  const one = bev ? await get(`https://www.bovada.lv/services/sports/event/coupon/events/A/description${bev.link}?lang=en`) : {};
  const dgs = (one.j || [])[0]?.events?.[0]?.displayGroups || [];
  sum.bovada = { esports: bvn, oneEvent: bev?.description, groups: dgs.map(d => d.description + ':' + d.markets.length), marketNames: dgs.flatMap(d => d.markets.map(m => m.description)).slice(0, 60) };
  save('bv-one', one.j);
  const bn = await get('https://www.bovada.lv/services/sports/event/coupon/events/A/description/football/nfl?lang=en');
  const ne = (bn.j || [])[0]?.events?.[0];
  const n1 = ne ? await get(`https://www.bovada.lv/services/sports/event/coupon/events/A/description${ne.link}?lang=en`) : {};
  const ndg = (n1.j || [])[0]?.events?.[0]?.displayGroups || [];
  sum.bovadaNfl = { event: ne?.description, groups: ndg.map(d => d.description + ':' + d.markets.length) };
  save('bv-nfl-one', n1.j);
  fs.writeFileSync('out/summary2.json', JSON.stringify(sum, null, 1));
})();
