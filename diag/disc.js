// Discovery dump: Kalshi non-sports events (open + settled last DAYS), Polymarket
// non-sports events (open + closed last DAYS), Polymarket US listing probes.
const fs = require('fs'), zlib = require('zlib');
const K = 'https://api.elections.kalshi.com/trade-api/v2';
const G = 'https://gamma-api.polymarket.com';
const U = 'https://gateway.polymarket.us';
const DAYS = Number(process.env.DAYS || 30);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
let calls = 0, errs = 0;
async function get(url, tries = 6, raw = false) {
  for (let i = 0; i < tries; i++) {
    calls++;
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(30000), headers: { 'user-agent': 'line-reaper-research' } });
      if (r.status === 429) { await sleep(1500 * (i + 1)); continue; }
      if (r.status >= 400 && r.status < 500) { errs++; if (raw) return { status: r.status, text: (await r.text()).slice(0, 400) }; return null; }
      if (!r.ok) { await sleep(1500 * (i + 1)); continue; }
      if (raw) return { status: r.status, text: (await r.text()).slice(0, 3000) };
      return await r.json();
    } catch (e) { await sleep(1500 * (i + 1)); }
  }
  errs++; return null;
}
const q = (base, p) => { const u = new URL(base); for (const [k, v] of Object.entries(p)) if (v != null) u.searchParams.set(k, v); return u.toString(); };
const cut = s => (s == null ? s : String(s).slice(0, 1500));
(async () => {
  fs.mkdirSync('data', { recursive: true });
  // PM US probes
  const probes = {};
  for (const p of [] && ['/v1/events?limit=5', '/v1/events?limit=5&active=true', '/v2/events?limit=5', '/v1/markets?limit=5', '/v2/leagues', '/v1/leagues', '/v2/categories', '/v1/categories', '/v1/series?limit=5', '/v2/series?limit=5', '/v1/events?limit=5&category=politics', '/v2/events?limit=5&category=politics', '/v1/search?query=fed', '/v2/search?q=fed']) {
    probes[p] = await get(U + p, 2, true);
  }
  fs.writeFileSync('data/pmus-probes.json', JSON.stringify(probes, null, 1));
  const uev = [];
  for (let off = 0; off < 40000; off += 100) {
    const d = await get(q(U + '/v1/events', { limit: 100, offset: off, active: true, closed: false }));
    const l = d?.events || []; if (!l.length) break;
    for (const e of l) {
      const cat = e.category || (e.markets || [])[0]?.category;
      if (/sport/i.test(String(cat)) || e.gameId || e.sportradarGameId) continue;
      uev.push({ id: e.id, slug: e.slug, title: e.title, cat, sub: e.subcategory, series: e.seriesSlug, tags: (e.tags || []).map(t => t.slug || t.label), end: e.endDate, desc: cut(e.description), rs: e.resolutionSource,
        ms: (e.markets || []).map(m => ({ id: m.id, slug: m.slug, q: m.question, cat: m.category, end: m.endDate, desc: cut(m.description), sides: (m.marketSides || []).map(x => ({ id: x.identifier, d: x.description, long: x.long, px: x.price })), bb: m.bestBidQuote, ba: m.bestAskQuote, fee: m.feeCoefficient, vol: m.volume, liq: m.liquidity, outcomes: m.outcomes, git: m.groupItemTitle, closed: m.closed, active: m.active })) });
    }
    if (off % 2000 === 0) log('pmus offset', off, 'kept', uev.length);
  }
  fs.writeFileSync('data/pmus-events.json.gz', zlib.gzipSync(JSON.stringify(uev)));
  log('pmus non-sports events', uev.length);
  // Kalshi series
  const ser = (await get(K + '/series'))?.series || [];
  const sMeta = {}; for (const s of ser) sMeta[s.ticker] = { cat: s.category, ft: s.fee_type, fm: s.fee_multiplier, freq: s.frequency, title: s.title, src: (s.settlement_sources || []).map(x => x.name || x.url).join('|'), tags: s.tags };
  fs.writeFileSync('data/kalshi-series.json.gz', zlib.gzipSync(JSON.stringify(sMeta)));
  log('series', ser.length);
  const slimK = m => ({ t: m.ticker, title: m.title, sub: m.yes_sub_title, nosub: m.no_sub_title, close: m.close_time, open: m.open_time, exp: m.expected_expiration_time, lx: m.latest_expiration_time, st: m.strike_type, fs: m.floor_strike, cs: m.cap_strike, rules: cut(m.rules_primary), rules2: cut(m.rules_secondary), ya: m.yes_ask_dollars, yb: m.yes_bid_dollars, last: m.last_price_dollars, vol: m.volume_fp ?? m.volume, v24: m.volume_24h_fp ?? m.volume_24h, oi: m.open_interest_fp ?? m.open_interest, liq: m.liquidity_dollars, res: m.result, sv: m.settlement_value_dollars, status: m.status });
  const kev = [];
  for (const status of ['open', 'settled']) {
    let cursor = null, pages = 0, staleP = 0;
    while (pages < 1500) {
      const d = await get(q(K + '/events', { status, with_nested_markets: true, limit: 200, cursor }));
      if (!d) break; pages++;
      let fresh = 0;
      for (const e of d.events || []) {
        if (/^KXMVE/.test(e.event_ticker)) continue;
        const cat = e.category || sMeta[e.series_ticker]?.cat;
        if (cat === 'Sports') continue;
        if (/fifteen|hour|minute/i.test(String(sMeta[e.series_ticker]?.freq || ''))) continue;
        let ms = e.markets || [];
        if (status === 'settled') ms = ms.filter(m => Number(m.volume_fp ?? m.volume ?? 0) >= 100);
        if (!ms.length) continue;
        if (status === 'settled') {
          const ct = Math.max(...(e.markets || []).map(m => Date.parse(m.close_time) || 0));
          if (ct < Date.now() - DAYS * 86400e3) continue;
          fresh++;
        }
        kev.push({ ev: e.event_ticker, s: e.series_ticker, cat, title: e.title, sub: e.sub_title, me: !!e.mutually_exclusive, status, ft: e.fee_type_override, fm: e.fee_multiplier_override, ms: ms.map(m => { const x = slimK(m); if (status === 'settled') { delete x.rules2; x.rules = x.rules && x.rules.slice(0, 300); } return x; }) });
      }
      if (status === 'settled') { staleP = fresh ? 0 : staleP + 1; if (staleP >= 40) break; }
      cursor = d.cursor; if (!cursor || !(d.events || []).length) break;
      if (pages % 50 === 0) log('kalshi', status, 'pages', pages, 'kept', kev.length);
    }
    log('kalshi', status, 'done pages', pages, 'kept', kev.length);
  }
  fs.writeFileSync('data/kalshi-events.json.gz', zlib.gzipSync(JSON.stringify(kev)));
  // Polymarket gamma
  const slimP = m => ({ id: m.id, q: m.question, cid: m.conditionId, tok: m.clobTokenIds, out: m.outcomes, px: m.outcomePrices, git: m.groupItemTitle, end: m.endDate, start: m.startDate, liq: m.liquidityNum, vol: m.volumeNum, v24: m.volume24hr, bb: m.bestBid, ba: m.bestAsk, desc: cut(m.description), rs: m.resolutionSource, closed: m.closed, active: m.active, neg: m.negRisk, ar: m.acceptingOrders, sm: m.sportsMarketType, slug: m.slug, umaEnd: m.umaEndDate, closedTime: m.closedTime, upd: m.updatedAt });
  const pev = []; const seen = new Set();
  for (const closed of [false, true]) {
    for (let off = 0; off < 60000; off += 100) {
      const p = closed ? { closed: true, limit: 100, offset: off, end_date_min: new Date(Date.now() - DAYS * 86400e3).toISOString(), order: 'endDate', ascending: false } : { closed: false, active: true, limit: 100, offset: off, order: 'volume24hr', ascending: false };
      const d = await get(q(G + '/events', p));
      if (!Array.isArray(d) || !d.length) break;
      for (const e of d) {
        if (seen.has(e.id)) continue; seen.add(e.id);
        const tags = (e.tags || []).map(t => t.slug || t.label);
        if (tags.includes('sports') || tags.includes('esports')) continue;
        pev.push({ id: e.id, slug: e.slug, title: e.title, desc: cut(e.description), rs: e.resolutionSource, end: e.endDate, start: e.startDate, tags, neg: e.negRisk, closed: e.closed, vol: e.volume, liq: e.liquidity, v24: e.volume24hr, ms: (e.markets || []).map(slimP) });
      }
      if (off % 2000 === 0) log('gamma closed', closed, 'offset', off, 'kept', pev.length);
    }
    log('gamma closed', closed, 'kept', pev.length);
  }
  fs.writeFileSync('data/poly-events.json.gz', zlib.gzipSync(JSON.stringify(pev)));
  log('done calls', calls, 'errs', errs);
})();
