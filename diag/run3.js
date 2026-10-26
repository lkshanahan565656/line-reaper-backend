// settled season futures: markets via /markets?event_ticker (live and /historical), daily candles
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
const EVENTS = ['KXSB-26', 'KXSB-25', 'KXNBA-26', 'KXNBA-25', 'KXNHL-26', 'KXNHL-25', 'KXMLB-25', 'KXNBAEAST-26', 'KXNBAEAST-25', 'KXNBAWEST-26', 'KXNBAWEST-25', 'KXNHLEAST-26', 'KXNHLEAST-25',
  'KXNHLWEST-26', 'KXNHLWEST-25', 'KXNFLAFCCHAMP-25', 'KXNFLNFCCHAMP-25', 'KXMARMAD-26', 'KXMARMAD-25', 'KXNCAAF-26', 'KXWNBA-25', 'KXNFLMVP-25', 'KXNBAMVP-26', 'KXHEISMAN-25', 'KXNFLPLAYOFF-26', 'KXNBAPLAYOFF-26', 'KXNCAAFPLAYOFF-26',
  'KXNFLAFCEAST-25', 'KXNFLAFCNORTH-25', 'KXNFLAFCSOUTH-25', 'KXNFLAFCWEST-25', 'KXNFLNFCEAST-25', 'KXNFLNFCNORTH-25', 'KXNFLNFCSOUTH-25', 'KXNFLNFCWEST-25'];
(async () => {
  fs.mkdirSync('data', { recursive: true });
  const out = [];
  for (const ev of EVENTS) {
    const series = ev.split('-')[0];
    let ms = [];
    for (const base of [K, `${K}/historical`]) {
      let cursor = '';
      for (let p = 0; p < 3; p++) {
        const d = await get(`${base}/markets?event_ticker=${ev}&limit=200${cursor ? '&cursor=' + cursor : ''}`);
        ms.push(...(d?.markets || []).map(m => ({ ...m, _base: base })));
        cursor = d?.cursor; if (!cursor) break;
      }
      if (ms.length) break;
    }
    const rows = [];
    for (const m of ms) {
      const open = Math.floor(Date.parse(m.open_time) / 1000), close = Math.floor(Date.parse(m.close_time) / 1000);
      let c = null;
      if (m._base === K) c = await get(`${K}/series/${series}/markets/${m.ticker}/candlesticks?period_interval=1440&start_ts=${open}&end_ts=${close}`);
      if (!c?.candlesticks?.length) c = await get(`${K}/historical/markets/${m.ticker}/candlesticks?period_interval=1440&start_ts=${open}&end_ts=${close}`);
      rows.push({ ticker: m.ticker, name: m.yes_sub_title, result: m.result, status: m.status, open_time: m.open_time, close_time: m.close_time, settlement_ts: m.settlement_ts, expected: m.expected_expiration_time,
        candles: (c?.candlesticks || []).map(k => [k.end_period_ts, k.yes_bid?.close_dollars ?? k.yes_bid?.close, k.yes_ask?.close_dollars ?? k.yes_ask?.close, k.volume_fp ?? k.volume]) });
      await sleep(110);
    }
    out.push({ event: ev, series, markets: rows });
    console.log(ev, rows.length, rows.filter(r => r.candles.length).length, rows.find(r => r.result === 'yes')?.name);
  }
  fs.writeFileSync('data/run3.json.gz', zlib.gzipSync(JSON.stringify({ out, log })));
  console.log('errors', log.length, log.slice(0, 10).join('\n'));
})();
