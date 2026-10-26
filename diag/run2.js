// (a) Kalshi books on every matched futures market; (b) settled season futures with daily price history.
const fs = require('fs'), zlib = require('zlib');
const K = 'https://api.elections.kalshi.com/trade-api/v2';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = [];
async function get(url) {
  for (let i = 0; i < 3; i++) {
    try { const r = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(30000) });
      if (r.status === 429) { await sleep(3000 * (i + 1)); continue; }
      if (!r.ok) { log.push(`${r.status} ${url}`); return null; }
      return await r.json(); } catch (e) { log.push(`ERR ${url} ${e.message}`); await sleep(1000); }
  }
  return null;
}
(async () => {
  fs.mkdirSync('data', { recursive: true });
  const out = { at: new Date().toISOString(), books: {}, settled: [] };
  for (const t of JSON.parse(fs.readFileSync('diag/tickers.json'))) {
    const b = await get(`${K}/markets/${t}/orderbook?depth=40`); if (b) out.books[t] = b.orderbook_fp || b.orderbook; await sleep(110);
  }
  console.log('books', Object.keys(out.books).length);
  const SERIES = ['KXSB', 'KXNBA', 'KXNHL', 'KXMLB', 'KXNBAEAST', 'KXNBAWEST', 'KXNHLEAST', 'KXNHLWEST', 'KXNFLAFCCHAMP', 'KXNFLNFCCHAMP', 'KXMARMAD', 'KXNCAAF', 'KXWNBA',
    'KXNFLAFCEAST', 'KXNFLAFCNORTH', 'KXNFLAFCSOUTH', 'KXNFLAFCWEST', 'KXNFLNFCEAST', 'KXNFLNFCNORTH', 'KXNFLNFCSOUTH', 'KXNFLNFCWEST', 'KXNFLMVP', 'KXNBAMVP', 'KXHEISMAN',
    'KXNFLPLAYOFF', 'KXNBAPLAYOFF', 'KXNCAAFPLAYOFF', 'KXPREMIERLEAGUE', 'KXUCL', 'KXF1', 'KXNASCARCUPSERIES', 'KXMLBALMVP', 'KXMLBNLMVP', 'KXMLBALCY', 'KXMLBNLCY'];
  for (const s of SERIES) {
    for (const base of [K, `${K}/historical`]) {
      const d = await get(`${base}/events?series_ticker=${s}&status=settled&with_nested_markets=true&limit=50`);
      for (const e of d?.events || []) {
        if (out.settled.some(x => x.event_ticker === e.event_ticker)) continue;
        const ms = [];
        for (const m of e.markets || []) {
          const open = Math.floor(Date.parse(m.open_time) / 1000), close = Math.floor(Date.parse(m.close_time) / 1000);
          let c = await get(`${K}/series/${s}/markets/${m.ticker}/candlesticks?period_interval=1440&start_ts=${open}&end_ts=${close}`);
          if (!c?.candlesticks?.length) c = await get(`${K}/historical/markets/${m.ticker}/candlesticks?period_interval=1440&start_ts=${open}&end_ts=${close}`);
          ms.push({ ticker: m.ticker, name: m.yes_sub_title, result: m.result, open_time: m.open_time, close_time: m.close_time, settlement_ts: m.settlement_ts,
            volume: m.volume_fp ?? m.volume, candles: (c?.candlesticks || []).map(k => [k.end_period_ts, k.yes_bid?.close_dollars ?? k.yes_bid?.close, k.yes_ask?.close_dollars ?? k.yes_ask?.close, k.volume_fp ?? k.volume]) });
          await sleep(110);
        }
        out.settled.push({ series: s, event_ticker: e.event_ticker, title: e.title, markets: ms });
      }
      await sleep(150);
    }
    console.log(s, out.settled.filter(x => x.series === s).length);
  }
  out.log = log;
  fs.writeFileSync('data/run2.json.gz', zlib.gzipSync(JSON.stringify(out)));
  console.log('errors', log.length, log.slice(0, 15).join('\n'));
})();
