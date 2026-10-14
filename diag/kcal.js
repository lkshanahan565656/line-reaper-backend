// Settled Kalshi player-prop ladders with hourly bid/ask before close, for a
// calibration test of the ladder mid as the fair price of a pick'em line.
const fs = require('fs');
const { SERIES } = require('../kprops');
const K = 'https://api.elections.kalshi.com/trade-api/v2';
const DAYS = Number(process.env.KCAL_DAYS || 9);
const T0 = Date.now(), BUDGET = 22 * 60e3;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
let calls = 0;
async function get(path, params = {}) {
  const u = new URL(K + path); for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.set(k, v);
  for (let i = 0; i < 6; i++) {
    calls++;
    try {
      const r = await fetch(u, { signal: AbortSignal.timeout(30000) });
      if (r.status === 429) { await sleep(1200 * (i + 1)); continue; }
      if (r.status >= 400 && r.status < 500) { log('4xx', r.status, path); return null; }
      if (!r.ok) { await sleep(1500 * (i + 1)); continue; }
      return await r.json();
    } catch (e) { await sleep(1500 * (i + 1)); }
  }
  return null;
}
const num = v => (v == null || v === '' ? null : Number(v));
(async () => {
  const since = Date.now() - DAYS * 86400e3;
  const events = [];
  for (const [league, tickers] of Object.entries(SERIES)) for (const s of tickers) {
    let cursor = null, n = 0;
    for (let page = 0; page < 6; page++) {
      const d = await get('/events', { series_ticker: s, status: 'settled', with_nested_markets: true, limit: 200, cursor });
      if (!d) break;
      let old = false;
      for (const e of d.events || []) {
        const ms = (e.markets || []).filter(m => m.result === 'yes' || m.result === 'no');
        if (!ms.length) continue;
        if (Date.parse(ms[0].close_time) < since) { old = true; continue; }
        events.push({ league, s, e: e.event_ticker, title: e.title, sub: e.sub_title, ms: ms.map(m => ({ t: m.ticker, title: m.title, st: m.strike_type, fs: num(m.floor_strike), r: m.result, close: m.close_time, exp: m.expected_expiration_time, occ: m.occurrence_datetime, open: m.open_time, vol: Math.round(num(m.volume_fp) ?? m.volume ?? 0) })) });
        n++;
      }
      cursor = d.cursor;
      if (old || !cursor || !(d.events || []).length) break;
    }
    log(s, 'events', n);
    await sleep(150);
  }
  log('events', events.length, 'markets', events.reduce((a, e) => a + e.ms.length, 0), 'sample', JSON.stringify(events[0]?.ms?.[0]));
  let i = 0, done = 0;
  events.sort(() => Math.random() - 0.5);
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (i < events.length && Date.now() - T0 < BUDGET) {
      const ev = events[i++];
      const close = Math.max(...ev.ms.map(m => Date.parse(m.close)));
      const st = close - 40 * 3600e3;
      const d = await get(`/series/${ev.s}/events/${ev.e}/candlesticks`, { start_ts: Math.floor(st / 1000), end_ts: Math.ceil(close / 1000), period_interval: 60 });
      const tick = d?.market_tickers || [];
      for (const m of ev.ms) {
        const j = tick.indexOf(m.t);
        const cs = j >= 0 ? (d.market_candlesticks?.[j] || []) : [];
        m.c = cs.map(k => [k.end_period_ts, num(k.yes_ask?.close_dollars), num(k.yes_bid?.close_dollars), Math.round(num(k.volume_fp) ?? k.volume ?? 0)]).filter(x => x[1] != null || x[2] != null);
      }
      if (++done % 200 === 0) log('candles', done, 'calls', calls);
    }
  }));
  fs.writeFileSync('out/kcal.json', JSON.stringify(events.filter(e => e.ms.some(m => m.c))));
  log('done', events.length, 'calls', calls);
})();
