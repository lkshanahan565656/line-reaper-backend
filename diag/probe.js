// probe: which esports markets FanDuel, BetRivers (Kambi), Pinnacle and Kalshi expose
const fs = require('fs');
fs.mkdirSync('out', { recursive: true });
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
const get = async (url, hdr = {}) => { try { const r = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json', ...hdr } }); const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {} return { status: r.status, j, len: t.length, head: j ? null : t.slice(0, 300) }; } catch (e) { return { status: 0, err: e.message }; } };
const save = (n, o) => fs.writeFileSync('out/' + n + '.json', JSON.stringify(o, null, 1));
(async () => {
  const sum = {};
  // FanDuel
  const fd = {};
  for (const p of ['esports', 'e-sports', 'csgo', 'cs2', 'counter-strike', 'counter-strike-2', 'league-of-legends', 'lol', 'dota-2', 'dota2', 'valorant', 'call-of-duty', 'rainbow-six']) {
    const r = await get(`https://sbapi.nj.sportsbook.fanduel.com/api/content-managed-page?page=CUSTOM&customPageId=${p}&pbHorizontal=false&_ak=FhMFpcPWXMeyZxOx&timezone=America%2FNew_York`);
    const a = r.j?.attachments || {};
    fd[p] = { status: r.status, events: Object.keys(a.events || {}).length, markets: Object.keys(a.markets || {}).length, comps: Object.values(a.competitions || {}).map(c => c.name).slice(0, 30), types: [...new Set(Object.values(a.markets || {}).map(m => m.marketType))].slice(0, 40), head: r.head };
    if (fd[p].events) save('fd-' + p, r.j);
  }
  for (const p of ['SPORT', 'HOME']) { const r = await get(`https://sbapi.nj.sportsbook.fanduel.com/api/content-managed-page?page=${p}&eventTypeId=27454571&_ak=FhMFpcPWXMeyZxOx&timezone=America%2FNew_York`); fd['et-' + p] = { status: r.status, events: Object.keys(r.j?.attachments?.events || {}).length, head: r.head }; if (r.j) save('fd-et-' + p, r.j); }
  const nav = await get('https://sbapi.nj.sportsbook.fanduel.com/api/sports-nav?_ak=FhMFpcPWXMeyZxOx');
  fd.nav = { status: nav.status, head: nav.head }; if (nav.j) save('fd-nav', nav.j);
  sum.fanduel = fd;
  // Kambi
  const KB = 'https://eu-offering-api.kambicdn.com/offering/v2018/rsiusnj';
  const grp = await get(`${KB}/group.json?lang=en_US&market=US`);
  const es = (function find(g) { if (!g) return null; if (/esport/i.test(g.termKey || g.englishName || '')) return g; for (const c of g.groups || []) { const x = find(c); if (x) return x; } return null; })(grp.j?.group);
  sum.kambiGroup = { status: grp.status, esports: es ? JSON.stringify(es).slice(0, 4000) : null };
  const lv = await get(`${KB}/listView/esports/all/all/all/matches.json?lang=en_US&market=US&useCombined=true`);
  const evs = (lv.j?.events || []).map(x => x.event).filter(Boolean);
  sum.kambiList = { status: lv.status, events: evs.length, groups: [...new Set(evs.map(e => (e.path || []).map(p => p.englishName).join('/')))].slice(0, 60), states: evs.reduce((a, e) => (a[e.state] = (a[e.state] || 0) + 1, a), {}) };
  save('kb-list', lv.j);
  const crit = {}, samples = [];
  for (const e of evs.filter(e => e.state === 'NOT_STARTED').slice(0, 40)) {
    const r = await get(`${KB}/betoffer/event/${e.id}.json?lang=en_US&market=US&includeParticipants=true`);
    const sport = (e.path || []).map(p => p.englishName).slice(0, 2).join('/');
    for (const b of r.j?.betOffers || []) { const k = sport + ' | ' + (b.criterion?.englishLabel || '?') + ' | ' + (b.betOfferType?.englishName || ''); crit[k] = (crit[k] || 0) + 1; }
    if (samples.length < 6) samples.push(r.j);
  }
  sum.kambiCriteria = crit; save('kb-events', samples);
  // Pinnacle
  const PIN = 'https://guest.api.arcadia.pinnacle.com/0.1';
  const ph = {};
  const mu = await get(`${PIN}/sports/12/matchups?withSpecials=false&brandId=0`, ph), mk = await get(`${PIN}/sports/12/markets/straight?primaryOnly=false&withSpecials=false`, ph);
  const mus = Array.isArray(mu.j) ? mu.j : [], mks = Array.isArray(mk.j) ? mk.j : [];
  const byId = new Map(mus.map(m => [m.id, m]));
  const mt = {};
  for (const m of mks) { const u = byId.get(m.matchupId); const lab = u ? (u.parent ? 'child:' + (u.units || '') + ':' + (u.league?.name || '').split(' ')[0] : 'main:' + (u.league?.name || '').split(' ')[0]) : 'nomu'; const k = `${lab} ${m.type} p${m.period} ${m.side || ''}`; mt[k] = (mt[k] || 0) + 1; }
  sum.pinnacle = { status: [mu.status, mk.status], matchups: mus.length, markets: mks.length, top: mus.filter(m => !m.parent).length, types: mt, leagues: [...new Set(mus.map(m => m.league?.name))].slice(0, 80) };
  save('pin-mu', mus.slice(0, 400)); save('pin-mk', mks.slice(0, 2000));
  // Kalshi
  const kal = {};
  for (const s of ['KXCS2GAME', 'KXLOLGAME', 'KXDOTA2GAME', 'KXVALORANTGAME', 'KXCS2MAP', 'KXCS2TOTALMAPS', 'KXLOLMAP', 'KXR6GAME']) { const r = await get(`https://api.elections.kalshi.com/trade-api/v2/events?series_ticker=${s}&status=open&limit=200&with_nested_markets=true`); kal[s] = { status: r.status, events: (r.j?.events || []).length, sample: (r.j?.events || []).slice(0, 2).map(e => ({ t: e.event_ticker, title: e.title, mk: (e.markets || []).map(m => [m.ticker, m.yes_sub_title, m.yes_bid, m.yes_ask]) })) }; }
  const ser = await get('https://api.elections.kalshi.com/trade-api/v2/series?category=Sports');
  kal.esSeries = (ser.j?.series || []).filter(s => /esport|cs2|counter|league of legends|dota|valorant|lol|r6|overwatch|call of duty/i.test(s.title + ' ' + s.ticker + ' ' + (s.tags || []).join(' '))).map(s => s.ticker + ' ' + s.title);
  sum.kalshi = kal;
  save('summary', sum);
})();
