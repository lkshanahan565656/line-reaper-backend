// soccer lane discovery: what each free source answers from Actions
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function get(url, text = false) {
  try { const r = await fetch(url, { signal: AbortSignal.timeout(30000), headers: { 'user-agent': 'Mozilla/5.0 line-reaper-research' } });
    const b = await r.text(); return { s: r.status, n: b.length, b: text ? b : (() => { try { return JSON.parse(b); } catch { return b.slice(0, 300); } })() };
  } catch (e) { return { s: 0, err: e.message }; } }
const show = (k, r, f) => console.log('==', k, r.s, r.n, f ? f(r.b) : (typeof r.b === 'string' ? r.b.slice(0, 400) : JSON.stringify(r.b).slice(0, 800)));
(async () => {
  for (const u of ['https://www.football-data.co.uk/mmz4281/2526/E0.csv', 'https://www.football-data.co.uk/new/USA.csv', 'https://www.football-data.co.uk/fixtures.csv'])
    show(u, await get(u, true), b => String(b).slice(0, 700));
  const K = 'https://api.elections.kalshi.com/trade-api/v2';
  const s = await get(K + '/series?category=Sports');
  const all = s.b?.series || [];
  console.log('== kalshi sports series', all.length);
  const soc = all.filter(x => /soccer|premier|liga|serie a|bundesliga|ligue|mls|champions|europa|eredivisie|fa cup|carabao|copa|world cup|uefa|epl|football club|libertadores|liga mx|primeira|saudi|scottish|championship/i.test(`${x.title} ${x.ticker} ${(x.tags || []).join(' ')}`) && !/NFL|NCAAF|college football/i.test(`${x.title} ${x.ticker}`));
  for (const x of soc) console.log('KS', x.ticker, '|', x.title, '|', (x.tags || []).join(','), '|', x.frequency);
  for (const t of soc.filter(x => /GAME$/.test(x.ticker)).slice(0, 40)) {
    const m = await get(`${K}/markets?series_ticker=${t.ticker}&status=settled&limit=1000`);
    const h = await get(`${K}/historical/markets?series_ticker=${t.ticker}&limit=1000`);
    const ms = m.b?.markets || [], hs = h.b?.markets || [];
    console.log('KM', t.ticker, 'settled', ms.length, m.b?.cursor ? '+' : '', 'hist', hs.length, h.b?.cursor ? '+' : '', 'oldest', [...ms, ...hs].map(x => x.close_time).sort()[0]);
    if (t === soc.find(x => /GAME$/.test(x.ticker))) console.log('KSAMPLE', JSON.stringify(ms[0] || hs[0]).slice(0, 2500));
    await sleep(200);
  }
  const G = 'https://gamma-api.polymarket.com';
  const sp = await get(G + '/sports');
  for (const r of (Array.isArray(sp.b) ? sp.b : [])) console.log('PMS', r.sport, r.series, r.tags);
  const espn = await get('https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/scoreboard?dates=20251025');
  show('espn eng.1', espn, b => JSON.stringify((b.events || []).slice(0, 1)).slice(0, 2500));
  const e2 = await get('https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/scoreboard?dates=20160820');
  show('espn eng.1 2016', e2, b => `${(b.events || []).length} events`);
  const ce = await get('http://api.clubelo.com/2025-10-01', true);
  show('clubelo', ce, b => String(b).slice(0, 300));
  const us = await get('https://www.pinnacle.com', true); show('pin', us, () => '');
})();
