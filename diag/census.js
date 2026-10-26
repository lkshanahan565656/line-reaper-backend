// Futures census: raw Pinnacle season futures, Kalshi sports futures series + books,
// Polymarket US futures events, and the live /api/outrights. Raw dumps only.
const fs = require('fs'), zlib = require('zlib');
const PIN = 'https://guest.api.arcadia.pinnacle.com/0.1';
const K = 'https://api.elections.kalshi.com/trade-api/v2';
const PM = 'https://gateway.polymarket.us';
const SITE = 'https://line-reaper-backend-production.up.railway.app';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const H = { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' };
const log = [];
async function get(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: H, signal: AbortSignal.timeout(30000) });
      if (r.status === 429) { await sleep(3000 * (i + 1)); continue; }
      if (!r.ok) { log.push(`${r.status} ${url}`); return null; }
      return await r.json();
    } catch (e) { log.push(`ERR ${url} ${e.message}`); await sleep(1000); }
  }
  return null;
}
const out = {};
(async () => {
  fs.mkdirSync('data', { recursive: true });
  // Pinnacle: football 15, basketball 4, hockey 19, baseball 3, soccer skipped (huge)
  out.pin = {};
  for (const [name, id] of Object.entries({ football: 15, basketball: 4, hockey: 19, baseball: 3 })) {
    const lg = await get(`${PIN}/sports/${id}/leagues?all=false`) || [];
    const fl = lg.filter(l => l.matchupCount > 0);
    out.pin[name] = { leagues: fl.map(l => ({ id: l.id, name: l.name, n: l.matchupCount })), specials: [] };
    for (const l of fl) {
      const mu = await get(`${PIN}/leagues/${l.id}/matchups`);
      const sp = (mu || []).filter(m => m.type === 'special');
      if (!sp.length) continue;
      const mk = await get(`${PIN}/leagues/${l.id}/markets/straight`) || [];
      const ids = new Set(sp.map(m => m.id));
      out.pin[name].specials.push({ league: l, matchups: sp, markets: mk.filter(m => ids.has(m.matchupId)) });
      await sleep(150);
    }
    console.log('pin', name, fl.length, 'leagues', out.pin[name].specials.reduce((a, s) => a + s.matchups.length, 0), 'specials');
  }
  // Kalshi: every sports series
  const ser = await get(`${K}/series?category=Sports`);
  out.kseries = (ser?.series || []).map(s => ({ ticker: s.ticker, title: s.title, frequency: s.frequency, tags: s.tags }));
  console.log('kalshi series', out.kseries.length);
  const longSeries = out.kseries.filter(s => !/daily|weekly|hourly/i.test(s.frequency || ''));
  out.kevents = [];
  const nowS = Date.now();
  for (const s of longSeries) {
    let cursor = '';
    for (let p = 0; p < 4; p++) {
      const d = await get(`${K}/events?series_ticker=${s.ticker}&status=open&with_nested_markets=true&limit=100${cursor ? '&cursor=' + cursor : ''}`);
      if (!d) break;
      for (const e of d.events || []) {
        const ms = e.markets || [];
        const far = ms.some(m => Date.parse(m.close_time || m.expected_expiration_time || 0) - nowS > 5 * 86400e3);
        if (far) out.kevents.push({ ...e, frequency: s.frequency });
      }
      cursor = d.cursor; if (!cursor) break;
      await sleep(120);
    }
    await sleep(100);
  }
  console.log('kalshi far events', out.kevents.length, 'markets', out.kevents.reduce((a, e) => a + (e.markets || []).length, 0));
  // Kalshi books on every active market of a far event (cap 1500)
  out.kbooks = {};
  let nb = 0;
  for (const e of out.kevents) for (const m of e.markets || []) {
    if (nb >= 1500 || !/active|open/i.test(m.status || '')) continue;
    const b = await get(`${K}/markets/${m.ticker}/orderbook?depth=30`);
    if (b) out.kbooks[m.ticker] = b.orderbook_fp || b.orderbook || b;
    nb++; await sleep(110);
  }
  console.log('kalshi books', nb);
  // Polymarket US
  const sports = await get(`${PM}/v2/sports`);
  out.pmsports = sports;
  out.pmevents = [];
  const lgs = (sports?.sports || []).flatMap(x => (x.leagues || []).map(l => ({ sport: x.slug, slug: l.slug, n: l.activeEventCount })));
  for (const l of lgs.filter(l => /football|basketball|hockey|baseball/i.test(l.sport) || /^(nfl|nba|nhl|mlb|cfb|ncaaf|cbb|ncaab|wnba)/i.test(l.slug))) {
    const d = await get(`${PM}/v2/leagues/${encodeURIComponent(l.slug)}/events?type=futures&limit=100`, 1);
    if (d?.events) out.pmevents.push(...d.events.map(e => ({ ...e, _league: l.slug })));
    await sleep(2500);
  }
  console.log('pm futures events', out.pmevents.length);
  // live site
  out.site = { outrights: await get(`${SITE}/api/outrights?t=${Date.now()}`), status: (await get(`${SITE}/api/status`))?.exchangeOutrights };
  out.log = log;
  fs.writeFileSync('data/census.json.gz', zlib.gzipSync(JSON.stringify(out)));
  console.log('errors', log.length, log.slice(0, 20).join('\n'));
})();
