// Kalshi settled sports markets (live + historical) closing since MIN_CLOSE, slim rows for matching.
const fs = require('fs'), zlib = require('zlib');
const K = 'https://api.elections.kalshi.com/trade-api/v2';
const MIN_CLOSE = Date.parse(process.env.MIN_CLOSE || '2026-03-25T00:00:00Z');
const NSH = Number(process.env.NSHARD || 1), SH = Number(process.env.SHARD || 0);
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
      if (r.status >= 400 && r.status < 500) { errs++; if (errs < 20) log('4xx', r.status, u.pathname + u.search, (await r.text()).slice(0, 200)); return null; }
      if (!r.ok) { await sleep(1500 * (i + 1)); continue; }
      return await r.json();
    } catch (e) { await sleep(1500 * (i + 1)); }
  }
  errs++; return null;
}
const slim = (m, src) => ({ t: m.ticker, ev: m.event_ticker, title: m.title, ys: m.yes_sub_title, ns: m.no_sub_title, open: m.open_time, close: m.close_time,
  exp: m.expected_expiration_time, occ: m.occurrence_datetime, res: m.result, fs: m.floor_strike ?? null, cs: m.cap_strike ?? null, st: m.strike_type, vol: Math.round(Number(m.volume_fp ?? m.volume ?? 0)), src });
(async () => {
  log('cutoff', JSON.stringify(await get('/historical/cutoff')));
  const ser = ((await get('/series', { category: 'Sports' }))?.series || []).filter(s => !/^KXMVE/.test(s.ticker));
  const mine = ser.filter((s, i) => i % NSH === SH);
  log('sports series', ser.length, 'mine', mine.length);
  const out = [], meta = [];
  let i = 0;
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (i < mine.length) {
      const s = mine[i++]; let n = 0;
      meta.push({ s: s.ticker, title: s.title, ft: s.fee_type, fm: s.fee_multiplier, tags: s.tags });
      for (const [path, src, extra] of [['/markets', 'live', { status: 'settled', min_close_ts: Math.floor(MIN_CLOSE / 1000) }], ['/historical/markets', 'hist', {}]]) {
        let cursor = null, pages = 0;
        while (pages < 400) {
          const d = await get(path, { series_ticker: s.ticker, limit: 1000, cursor, ...extra });
          if (!d) break; pages++;
          const ms = d.markets || [];
          for (const m of ms) if (Date.parse(m.close_time) >= MIN_CLOSE) { out.push(slim(m, src)); n++; }
          cursor = d.cursor; if (!cursor || !ms.length) break;
          if (src === 'hist' && ms.every(m => Date.parse(m.close_time) < MIN_CLOSE - 30 * 86400e3)) break;
        }
      }
      if (i % 50 === 0) log('series', i, 'markets', out.length, 'calls', calls, 'errs', errs);
    }
  }));
  log('done markets', out.length, 'calls', calls, 'errs', errs);
  fs.mkdirSync('data', { recursive: true });
  fs.writeFileSync('data/series.json.gz', zlib.gzipSync(JSON.stringify(meta)));
  fs.writeFileSync('data/kmarkets.json.gz', zlib.gzipSync(JSON.stringify(out)));
})();
