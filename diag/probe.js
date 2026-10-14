const K = 'https://api.elections.kalshi.com/trade-api/v2';
const j = async (u) => { const r = await fetch(u); const t = await r.text(); try { return { s: r.status, d: JSON.parse(t) }; } catch { return { s: r.status, d: t.slice(0, 300) }; } };
const show = (x, n = 1500) => console.log(JSON.stringify(x).slice(0, n));
(async () => {
  const s = await j(K + '/series');
  const ser = s.d.series || [];
  console.log('series', s.s, ser.length);
  const cat = {}; for (const x of ser) cat[x.category] = (cat[x.category] || 0) + 1; console.log(cat);
  show(ser[0], 800);
  for (const st of ['KXNFLGAME', 'KXMLBGAME', 'KXHIGHNY', 'KXBTCD', 'KXEPLGAME']) {
    const e = await j(`${K}/events?series_ticker=${st}&status=settled&with_nested_markets=true&limit=200`);
    const ev = e.d.events || [];
    const ms = ev.flatMap(x => x.markets || []);
    console.log('\n==', st, e.s, 'events', ev.length, 'markets', ms.length, 'cursor', !!e.d.cursor, 'oldest close', ms.map(m => m.close_time).sort()[0]);
    if (ms[0]) { show(ev[0].markets ? { ...ev[0], markets: undefined } : ev[0], 700); show(ms[0], 2500); }
    const m = ms.find(m => (m.volume || m.volume_fp || 0) > 0) || ms[0];
    if (m) {
      const end = Math.floor(Date.parse(m.close_time) / 1000), st0 = end - 3 * 86400;
      for (const p of [60, 1]) {
        const c = await j(`${K}/series/${st}/markets/${m.ticker}/candlesticks?start_ts=${p === 1 ? end - 7200 : st0}&end_ts=${end}&period_interval=${p}`);
        const cs = c.d.candlesticks || [];
        console.log('candles p', p, c.s, cs.length); if (cs[0]) { show(cs[0], 900); show(cs[cs.length - 1], 900); }
      }
    }
  }
  for (const u of ['/historical/markets?limit=2', '/historical/cutoff', '/markets?status=settled&limit=3', '/markets/candlesticks?market_tickers=x']) { const r = await j(K + u); console.log('\n', u, r.s); show(r.d, 1200); }
})();
