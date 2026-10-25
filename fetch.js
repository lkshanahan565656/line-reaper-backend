// Kalshi UFC history: settled go-the-distance, method and winner markets for
// the 10-17 and 10-24 cards, with hourly candlesticks over the last 12 hours
// before each fight (the price at the start = the last candle before it).
const fs = require('fs');
const K = 'https://api.elections.kalshi.com/trade-api/v2';
const j = async u => { for (let i = 0; i < 4; i++) { try { const r = await fetch(u, { headers: { Accept: 'application/json' } }); if (r.status === 429) { await new Promise(s => setTimeout(s, 2000 * (i + 1))); continue; } const t = await r.text(); return r.ok ? JSON.parse(t) : { _err: r.status, body: t.slice(0, 300) }; } catch (e) { if (i === 3) return { _err: e.message }; } } return { _err: 'retries' }; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  fs.mkdirSync('out', { recursive: true });
  const out = {};
  for (const s of ['KXUFCDISTANCE', 'KXUFCFIGHT', 'KXUFCVICROUND', 'KXUFCMOV']) {
    const mk = [];
    let cursor = '';
    for (let i = 0; i < 10; i++) {
      const r = await j(`${K}/markets?series_ticker=${s}&status=settled&limit=1000${cursor ? '&cursor=' + cursor : ''}`);
      mk.push(...(r.markets || []));
      cursor = r.cursor; if (!cursor || !(r.markets || []).length) break;
      await sleep(300);
    }
    const mine = mk.filter(m => { const t = Date.parse(m.close_time || m.expiration_time || ''); return t > Date.parse('2026-10-16T00:00Z') && t < Date.parse('2026-10-26T12:00Z'); });
    for (const m of mine) {
      const end = Math.floor(Date.parse(m.close_time) / 1000), start = end - 7 * 86400;
      const c = await j(`${K}/series/${s}/markets/${m.ticker}/candlesticks?start_ts=${start}&end_ts=${end}&period_interval=60`);
      m.candles = (c.candlesticks || []).map(x => ({ t: x.end_period_ts, bid: x.yes_bid?.close, ask: x.yes_ask?.close, price: x.price?.close, vol: x.volume }));
      await sleep(250);
    }
    out[s] = { total: mk.length, markets: mine };
    console.log(s, mk.length, mine.length);
  }
  fs.writeFileSync('out/kalshi-ufc.json', JSON.stringify(out));
})();
