// Pull Kalshi settled markets (live API window) with hourly ask/bid history
// over each market's final 72h, for calibration / favourite-longshot tests.
const fs = require('fs'), zlib = require('zlib');
const K = 'https://api.elections.kalshi.com/trade-api/v2';
const BUDGET = Number(process.env.BUDGET_MIN || 270) * 60e3, T0 = Date.now();
const MINVOL = Number(process.env.MINVOL || 300);
const PER_SERIES = Number(process.env.PER_SERIES || 500);
const HOURS = 72;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
let calls = 0, errs = 0;
async function get(path, params = {}, tries = 6) {
  const u = new URL(K + path); for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.set(k, v);
  for (let i = 0; i < tries; i++) {
    calls++;
    try {
      const r = await fetch(u, { signal: AbortSignal.timeout(30000) });
      if (r.status === 429) { await sleep(1000 * (i + 1)); continue; }
      if (r.status >= 400 && r.status < 500) { errs++; return null; }
      if (!r.ok) { await sleep(1500 * (i + 1)); continue; }
      return await r.json();
    } catch (e) { await sleep(1500 * (i + 1)); }
  }
  errs++; return null;
}
async function pool(items, n, fn) { let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < items.length && Date.now() - T0 < BUDGET) { const x = items[i++]; await fn(x); } })); }
const num = v => (v == null || v === '' ? null : Number(v));
const PRI = { Sports: 0, 'Climate and Weather': 1, Financials: 2, Economics: 2, Crypto: 3, Politics: 4, Elections: 4, Mentions: 4, Entertainment: 5, Companies: 5, 'Science and Technology': 5, World: 5 };
(async () => {
  const ser = (await get('/series'))?.series || [];
  const sMeta = new Map(ser.map(s => [s.ticker, { cat: s.category, ft: s.fee_type, fm: s.fee_multiplier, freq: s.frequency }]));
  log('series', ser.length);
  // discover settled events (global paging, newest first)
  const events = []; let cursor = null, pages = 0;
  while (pages < 3000) {
    const d = await get('/events', { status: 'settled', with_nested_markets: true, limit: 200, cursor });
    if (!d) break; pages++;
    for (const e of d.events || []) {
      if (/^KXMVE/.test(e.event_ticker)) continue;
      const ms = (e.markets || []).filter(m => (num(m.volume_fp) ?? m.volume ?? 0) >= MINVOL && (m.result === 'yes' || m.result === 'no' || num(m.settlement_value_dollars) != null));
      const slim = m => ({ ticker: m.ticker, title: m.title, yes_sub_title: m.yes_sub_title, close_time: m.close_time, open_time: m.open_time, expected_expiration_time: m.expected_expiration_time, occurrence_datetime: m.occurrence_datetime, latest_expiration_time: m.latest_expiration_time, settlement_value_dollars: m.settlement_value_dollars, result: m.result, volume_fp: m.volume_fp, strike_type: m.strike_type });
      if (ms.length) events.push({ e: { event_ticker: e.event_ticker, series_ticker: e.series_ticker, category: e.category, title: e.title, mutually_exclusive: e.mutually_exclusive, markets: { length: (e.markets || []).length }, fee_type_override: e.fee_type_override, fee_multiplier_override: e.fee_multiplier_override }, ms: ms.map(slim) });
    }
    cursor = d.cursor; if (!cursor || !(d.events || []).length) break;
    if (pages % 50 === 0) log('pages', pages, 'events kept', events.length, 'oldest', (d.events || []).slice(-1)[0]?.markets?.[0]?.close_time);
  }
  log('discovery pages', pages, 'events kept', events.length, 'calls', calls);
  // cap per series, priority order
  const bySer = new Map(); for (const x of events) { const s = x.e.series_ticker; (bySer.get(s) || bySer.set(s, []).get(s)).push(x); }
  let todo = [];
  for (const [s, l] of bySer) { l.sort(() => Math.random() - 0.5); todo.push(...l.slice(0, PER_SERIES)); }
  const cat = x => x.e.category || sMeta.get(x.e.series_ticker)?.cat || '?';
  todo.sort((a, b) => (PRI[cat(a)] ?? 9) - (PRI[cat(b)] ?? 9) || Math.random() - 0.5);
  const cc = {}; for (const x of todo) cc[cat(x)] = (cc[cat(x)] || 0) + 1; log('todo events', todo.length, JSON.stringify(cc));
  let useBatch = true;
  { const x = todo[0], m = x.ms[0], ct = Date.parse(m.close_time);
    const d = await get('/markets/candlesticks', { market_tickers: m.ticker, start_ts: Math.floor(ct / 1000) - 7200, end_ts: Math.floor(ct / 1000), period_interval: 60 });
    log('batch probe', JSON.stringify(d).slice(0, 600)); useBatch = !!d?.markets?.length; log('useBatch', useBatch); }
  const out = []; let done = 0, nocandle = 0;
  await pool(todo, 10, async ({ e, ms }) => {
    const meta = sMeta.get(e.series_ticker) || {};
    for (let i = 0; i < ms.length; i += 20) {
      const grp = ms.slice(i, i + 20);
      const close = Math.max(...grp.map(m => Date.parse(m.close_time)));
      const open = Math.min(...grp.map(m => Date.parse(m.open_time)));
      const st = Math.max(open, close - HOURS * 3600e3);
      let arr = [];
      if (useBatch) { const d = await get('/markets/candlesticks', { market_tickers: grp.map(m => m.ticker).join(','), start_ts: Math.floor(st / 1000), end_ts: Math.ceil(close / 1000) + 3600, period_interval: 60 }); arr = (d?.markets || []).map((x, j) => ({ market_ticker: x.market_ticker || x.ticker || grp[j].ticker, candlesticks: x.candlesticks || [] })); }
      if (!arr.length) {
        const d = await get(`/series/${e.series_ticker}/events/${e.event_ticker}/candlesticks`, { start_ts: Math.floor(st / 1000), end_ts: Math.ceil(close / 1000) + 3600, period_interval: 60 });
        arr = (d?.market_tickers || []).map((t, j) => ({ market_ticker: t, candlesticks: d.market_candlesticks?.[j] || [] }));
      }
      if (!arr.length) nocandle++;
      for (const m of grp) {
        const cs = (arr.find(x => x.market_ticker === m.ticker)?.candlesticks) || [];
        const ct = Date.parse(m.close_time);
        const c = [];
        for (const k of cs) {
          const a = num(k.yes_ask?.close_dollars), b = num(k.yes_bid?.close_dollars);
          if (a == null && b == null) continue;
          c.push([Math.round((ct - k.end_period_ts * 1000) / 60e3), a == null ? null : Math.round(a * 100), b == null ? null : Math.round(b * 100), Math.round(num(k.volume_fp) || 0), num(k.price?.close_dollars) == null ? null : Math.round(num(k.price.close_dollars) * 100)]);
        }
        const pay = num(m.settlement_value_dollars) ?? (m.result === 'yes' ? 1 : 0);
        out.push({ t: m.ticker, ev: e.event_ticker, s: e.series_ticker, cat: e.category || meta.cat, title: m.title, sub: m.yes_sub_title, et: e.title, me: !!e.mutually_exclusive, n: e.markets?.length || 0,
          close: m.close_time, exp: m.expected_expiration_time, occ: m.occurrence_datetime, lx: m.latest_expiration_time, open: m.open_time, pay, vol: Math.round(num(m.volume_fp) || 0),
          ft: e.fee_type_override || meta.ft, fm: e.fee_multiplier_override ?? meta.fm, st: m.strike_type, c });
      }
    }
    if (++done % 1000 === 0) log('events done', done, 'markets', out.length, 'calls', calls, 'errs', errs);
  });
  log('done events', done, 'markets', out.length, 'nocandle groups', nocandle, 'calls', calls, 'errs', errs);
  fs.mkdirSync('data', { recursive: true });
  // split into files under ~80MB compressed
  const byCat = {}; for (const r of out) (byCat[r.cat] ||= []).push(r);
  for (const [k, l] of Object.entries(byCat)) {
    const name = k.replace(/[^A-Za-z]/g, '').toLowerCase();
    for (let i = 0, part = 0; i < l.length; i += 40000, part++) fs.writeFileSync(`data/${name}-${part}.json.gz`, zlib.gzipSync(JSON.stringify(l.slice(i, i + 40000))));
    log('saved', k, l.length);
  }
})();
