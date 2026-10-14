const fs = require('fs');
fs.mkdirSync('out/raw3', { recursive: true });
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
const day = d => new Date(Date.now() + d * 864e5).toISOString().slice(0, 10).replace(/-/g, '');
const BOOKS = '68,69,75,123,79,2988,2724,4620,4727,4795,71,15';
const get = async (url, hdr = {}) => { try { const r = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json', ...hdr }, signal: AbortSignal.timeout(25000) }); const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {} return { status: r.status, j, len: t.length, head: t.slice(0, 300) }; } catch (e) { return { status: 0, head: String(e.message) }; } };
const sum = {};
const step = async (k, fn) => { try { sum[k] = await fn(); } catch (e) { sum[k] = { err: String(e.stack).slice(0, 300) }; } fs.writeFileSync('out/summary3.json', JSON.stringify(sum, null, 1)); };
(async () => {
  const sb = (await get(`https://api.actionnetwork.com/web/v2/scoreboard/nfl?bookIds=${BOOKS}&periods=event&date=${day(4)}`)).j;
  const gid = sb?.games?.[0]?.id;
  await step('an-props', async () => {
    const o = {};
    for (const [k, u] of [
      ['v1-league-props-date', `https://api.actionnetwork.com/web/v1/leagues/1/props/core_bet_type_9_passing_yards?bookIds=${BOOKS}&date=${day(4)}`],
      ['v2-league-props', `https://api.actionnetwork.com/web/v2/leagues/1/props/core_bet_type_9_passing_yards?bookIds=${BOOKS}&date=${day(4)}`],
      ['v2-game-props-noBooks', `https://api.actionnetwork.com/web/v2/games/${gid}/props`],
      ['v2-game-props-state', `https://api.actionnetwork.com/web/v2/games/${gid}/props?bookIds=${BOOKS}&stateCode=NJ`],
      ['v1-game-props', `https://api.actionnetwork.com/web/v1/games/${gid}/props?bookIds=${BOOKS}`],
      ['v2-markets-event', `https://api.actionnetwork.com/web/v2/markets/event/${gid}?bookIds=${BOOKS}`],
      ['v2-markets-event-props', `https://api.actionnetwork.com/web/v2/markets/event/${gid}/props?bookIds=${BOOKS}`],
      ['v2-scoreboard-props', `https://api.actionnetwork.com/web/v2/scoreboard/nfl?bookIds=${BOOKS}&periods=event&date=${day(4)}&customPickTypes=core_bet_type_9_passing_yards`],
      ['v2-scoreboard-alt', `https://api.actionnetwork.com/web/v2/scoreboard/nfl?bookIds=${BOOKS}&periods=event&date=${day(4)}&includeAlt=true`],
      ['v2-ncaaf', `https://api.actionnetwork.com/web/v2/scoreboard/ncaaf?bookIds=${BOOKS}&periods=event&date=${day(1)}&division=FBS`],
      ['v2-nhl', `https://api.actionnetwork.com/web/v2/scoreboard/nhl?bookIds=${BOOKS}&periods=event&date=${day(1)}`],
      ['v2-nba', `https://api.actionnetwork.com/web/v2/scoreboard/nba?bookIds=${BOOKS}&periods=event&date=${day(0)}`],
      ['v2-mlb', `https://api.actionnetwork.com/web/v2/scoreboard/mlb?bookIds=${BOOKS}&periods=event&date=${day(0)}`],
      ['v2-wnba', `https://api.actionnetwork.com/web/v2/scoreboard/wnba?bookIds=${BOOKS}&periods=event&date=${day(0)}`],
      ['v2-nfl-week', `https://api.actionnetwork.com/web/v2/scoreboard/nfl?bookIds=${BOOKS}&periods=event&week=6&season=2026&seasonType=reg`],
    ]) { const r = await get(u); o[k] = { status: r.status, len: r.len, head: r.head.slice(0, 250), games: r.j?.games?.length }; if (r.status === 200 && r.len > 200) fs.writeFileSync(`out/raw3/an-${k}.json`, JSON.stringify(r.j)); }
    return o;
  });
  await step('smarkets', async () => {
    const o = {};
    for (const q of ['type_domain=esports&state=upcoming&limit=300', 'type=esport_match&state=upcoming&limit=300', 'type_scope=single_event&type_domain=esports&limit=300', 'parent_id=&type_domain=esports&type_scope=single_event&state=upcoming']) {
      const r = await get(`https://api.smarkets.com/v3/events/?${q}`);
      o[q] = { status: r.status, n: r.j?.events?.length, names: (r.j?.events || []).slice(0, 12).map(e => `${e.name} | ${e.type} | ${e.start_datetime}`) };
    }
    return o;
  });
  await step('polymarket', async () => {
    const r = await get('https://gamma-api.polymarket.com/events?tag_slug=esports&active=true&closed=false&limit=100&order=startDate&ascending=false');
    const ev = Array.isArray(r.j) ? r.j : [];
    return { status: r.status, n: ev.length, games: ev.filter(e => / vs\.? /i.test(e.title)).slice(0, 20).map(e => `${e.title} liq ${Math.round(e.liquidity || 0)} vol24 ${Math.round(e.volume24hr || 0)} mk ${(e.markets || []).length}`) };
  });
  await step('bovada', async () => {
    const lst = (await get('https://www.bovada.lv/services/sports/event/coupon/events/A/description/esports?marketFilterId=def&preMatchOnly=true&lang=en')).j || [];
    const evs = lst.flatMap(x => x.events.map(e => ({ comp: x.path?.[0]?.description, game: x.path?.slice(-1)?.[0]?.description, e })));
    const one = evs[0]?.e;
    const r = one ? await get(`https://www.bovada.lv/services/sports/event/coupon/events/A/description${one.link}?lang=en`) : {};
    const ev1 = Array.isArray(r.j) ? r.j[0]?.events?.[0] : null;
    if (r.j) fs.writeFileSync('out/raw3/bv-es-one.json', JSON.stringify(r.j));
    const nfl = (await get('https://www.bovada.lv/services/sports/event/coupon/events/A/description/football/nfl?lang=en')).j || [];
    const ne = nfl[0]?.events?.[0];
    const rn = ne ? await get(`https://www.bovada.lv/services/sports/event/coupon/events/A/description${ne.link}?lang=en`) : {};
    if (rn.j) fs.writeFileSync('out/raw3/bv-nfl-one.json', JSON.stringify(rn.j));
    const nev = Array.isArray(rn.j) ? rn.j[0]?.events?.[0] : null;
    return { esports: evs.length, list: evs.slice(0, 30).map(x => `${x.game} | ${x.comp} | ${x.e.description} | ${new Date(x.e.startTime).toISOString()}`),
      oneGroups: (ev1?.displayGroups || []).map(d => d.description + ':' + d.markets.length + ' ' + d.markets.slice(0, 6).map(m => m.description).join('/')),
      nflGroups: (nev?.displayGroups || []).map(d => d.description + ':' + d.markets.length) };
  });
})();
