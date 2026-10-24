const g = async (u) => { try { const r = await fetch(u, { signal: AbortSignal.timeout(20000) }); const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {} return [r.status, j, t]; } catch (e) { return [0, null, e.message]; } };
const G = 'https://gateway.polymarket.us';
(async () => {
  for (const lg of ['cs2', 'lol', 'dota2', 'val', 'valorant']) {
    const [s, j, t] = await g(`${G}/v2/leagues/${lg}/events?limit=50&offset=0`);
    const evs = j?.events || j?.data || (Array.isArray(j) ? j : []);
    console.log('league', lg, s, 'events', evs.length, t.slice(0, s === 200 ? 0 : 300));
    const types = {};
    for (const e of evs) for (const m of e.markets || []) types[m.sportsMarketType] = (types[m.sportsMarketType] || 0) + 1;
    console.log(' types', JSON.stringify(types));
    if (evs[0]) console.log(' sample event', JSON.stringify(evs[0]).slice(0, 3000));
    let shown = 0;
    for (const e of evs.slice(0, 6)) for (const m of (e.markets || [])) {
      if (shown > 14) break;
      const [bs, bj] = await g(`${G}/v1/markets/${encodeURIComponent(m.slug)}/book`);
      const bk = bj?.marketData || bj; shown++;
      console.log(' book', e.slug, m.sportsMarketType, m.question || m.title, bs, JSON.stringify({ bids: (bk?.bids || []).slice(0, 3), offers: (bk?.offers || []).slice(0, 3) }).slice(0, 400));
    }
  }
  for (const s of ['KXCS2TOTALMAPS', 'KXCS2SPREAD', 'KXCS2MAP', 'KXLOLTOTALMAPS', 'KXCS2GAME']) {
    const [st, j] = await g(`https://api.elections.kalshi.com/trade-api/v2/markets?series_ticker=${s}&status=open&limit=200`);
    const ms = j?.markets || []; const sp = ms.map(m => [+m.yes_ask_dollars, +m.yes_bid_dollars, +(m.yes_ask_size_fp || 0), +(m.yes_bid_size_fp || 0), +m.volume_fp]).filter(x => x[0] > 0 && x[0] < 1);
    const med = a => a.sort((x, y) => x - y)[a.length >> 1];
    console.log('kalshi open', s, st, ms.length, 'two-sided', sp.length, 'median spread', med(sp.map(x => x[0] - x[1])), 'median ask size', med(sp.map(x => x[2])), 'median vol', med(sp.map(x => x[4])));
  }
})();
