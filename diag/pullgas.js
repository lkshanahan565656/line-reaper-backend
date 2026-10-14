// Every settled Kalshi daily AAA gas market (state + national), live API and
// /historical archive, with hourly yes ask/bid candles from open to close.
const fs = require('fs'), zlib = require('zlib');
const K = 'https://api.elections.kalshi.com/trade-api/v2';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
let calls = 0, errs = 0, last429 = 0;
async function get(path, params = {}, tries = 8) {
  const u = new URL(K + path); for (const [k, v] of Object.entries(params)) if (v != null && v !== '') u.searchParams.set(k, v);
  for (let i = 0; i < tries; i++) {
    calls++;
    try {
      const r = await fetch(u, { signal: AbortSignal.timeout(30000) });
      if (r.status === 429) { last429++; await sleep(1500 * (i + 1)); continue; }
      if (r.status === 404) return { __404: true };
      if (r.status >= 400 && r.status < 500) { errs++; log('4xx', r.status, u.pathname + u.search, (await r.text()).slice(0, 200)); return null; }
      if (!r.ok) { await sleep(1500 * (i + 1)); continue; }
      return await r.json();
    } catch (e) { await sleep(1500 * (i + 1)); }
  }
  errs++; return null;
}
async function pool(items, n, fn) { let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const x = items[i++]; await fn(x); } })); }
const num = v => (v == null || v === '' ? null : Number(v));
const slim = (m, src) => ({ t: m.ticker, ev: m.event_ticker, s: m.ticker.split('-')[0], src, open: m.open_time, close: m.close_time, exp: m.expected_expiration_time, sts: m.settlement_ts, ev_val: num(m.expiration_value), strike: num(m.floor_strike), st: m.strike_type, res: m.result, pay: num(m.settlement_value_dollars) ?? (m.result === 'yes' ? 1 : m.result === 'no' ? 0 : null), vol: Math.round(num(m.volume_fp) || 0), rules: undefined });
(async () => {
  const ser = ((await get('/series'))?.series || []).filter(s => /^KXAAAGASD[A-Z]{0,2}$/.test(s.ticker)).map(s => s.ticker);
  log('daily gas series', ser.length);
  const mk = new Map(); let rulesSample = null;
  // live: settled events per series
  await pool(ser, 4, async s => {
    let cur = null, n = 0;
    for (let p = 0; p < 200; p++) {
      const d = await get('/events', { series_ticker: s, status: 'settled', with_nested_markets: true, limit: 200, cursor: cur });
      if (!d || d.__404) break;
      for (const e of d.events || []) for (const m of e.markets || []) { rulesSample ??= m.rules_primary; mk.set(m.ticker, slim(m, 'live')); n++; }
      cur = d.cursor; if (!cur || !(d.events || []).length) break;
    }
    // historical archive
    let cur2 = null, h = 0;
    for (let p = 0; p < 400; p++) {
      const d = await get('/historical/markets', { series_ticker: s, limit: 1000, cursor: cur2 });
      if (!d || d.__404) break;
      for (const m of d.markets || []) { if (!mk.has(m.ticker)) { mk.set(m.ticker, slim(m, 'hist')); h++; } }
      cur2 = d.cursor; if (!cur2 || !(d.markets || []).length) break;
    }
    log(s, 'live', n, 'hist', h);
  });
  const all = [...mk.values()];
  const rng = l => { const c = l.map(x => x.close).sort(); return [c[0], c.at(-1)]; };
  log('markets', all.length, 'live', all.filter(x => x.src === 'live').length, rng(all.filter(x => x.src === 'live')), 'hist', all.filter(x => x.src === 'hist').length, rng(all.filter(x => x.src === 'hist')));
  log('rules', rulesSample);
  // candles: keep markets whose strike is within 25c of that event's settled value (others sit at 0/100)
  const todo = all.filter(m => m.pay === 0 || m.pay === 1).filter(m => m.ev_val == null || m.strike == null || Math.abs(m.strike - m.ev_val) <= 0.25);
  log('candle todo', todo.length);
  const cs2row = (m, cs) => { const ct = Date.parse(m.close); const c = []; for (const k of cs || []) { const a = num(k.yes_ask?.close_dollars ?? (k.yes_ask?.close != null ? k.yes_ask.close / 100 : null)), b = num(k.yes_bid?.close_dollars ?? (k.yes_bid?.close != null ? k.yes_bid.close / 100 : null)); const al = num(k.yes_ask?.low_dollars), bh = num(k.yes_bid?.high_dollars); if (a == null && b == null) continue; c.push([Math.round((ct - k.end_period_ts * 1000) / 60e3), a == null ? null : Math.round(a * 100), b == null ? null : Math.round(b * 100), Math.round(num(k.volume_fp) || k.volume || 0), al == null ? null : Math.round(al * 100), bh == null ? null : Math.round(bh * 100)]); } m.c = c; };
  // live in batches of 20 per event
  const live = todo.filter(m => m.src === 'live'), hist = todo.filter(m => m.src === 'hist');
  const byEv = new Map(); for (const m of live) (byEv.get(m.ev) || byEv.set(m.ev, []).get(m.ev)).push(m);
  const groups = []; for (const l of byEv.values()) for (let i = 0; i < l.length; i += 20) groups.push(l.slice(i, i + 20));
  let done = 0, sampleShown = false;
  await pool(groups, 8, async g => {
    const st = Math.min(...g.map(m => Date.parse(m.open))), en = Math.max(...g.map(m => Date.parse(m.close)));
    const d = await get('/markets/candlesticks', { market_tickers: g.map(m => m.t).join(','), start_ts: Math.floor(st / 1000) - 3600, end_ts: Math.ceil(en / 1000) + 3600, period_interval: 60 });
    if (!sampleShown && d?.markets?.[0]) { sampleShown = true; log('candle sample', JSON.stringify(d.markets[0].candlesticks?.[3] || d.markets[0]).slice(0, 800)); }
    const arr = d?.markets || [];
    g.forEach((m, j) => cs2row(m, (arr.find(x => (x.market_ticker || x.ticker) === m.t) || arr[j] || {}).candlesticks));
    if (++done % 500 === 0) log('live groups', done, '/', groups.length, 'calls', calls, '429s', last429);
  });
  let hpath = null; done = 0;
  await pool(hist, 8, async m => {
    const q = { start_ts: Math.floor(Date.parse(m.open) / 1000) - 3600, end_ts: Math.ceil(Date.parse(m.close) / 1000) + 3600, period_interval: 60 };
    let d = null;
    for (const p of hpath ? [hpath] : [`/historical/markets/${m.t}/candlesticks`, `/series/${m.s}/markets/${m.t}/candlesticks`]) {
      d = await get(p.replace(/\/markets\/[^/]+\//, `/markets/${m.t}/`), q);
      if (d && !d.__404 && d.candlesticks) { if (!hpath) { hpath = p; log('hist candle path', p, JSON.stringify(d.candlesticks[2] || d).slice(0, 600)); } break; }
    }
    cs2row(m, d?.candlesticks);
    if (++done % 1000 === 0) log('hist', done, '/', hist.length, 'calls', calls, '429s', last429);
  });
  fs.mkdirSync('data', { recursive: true });
  fs.writeFileSync('data/gas-all.json.gz', zlib.gzipSync(JSON.stringify(all)));
  log('saved', all.length, 'with candles', all.filter(m => m.c?.length).length, 'calls', calls, 'errs', errs, '429s', last429);
})();
