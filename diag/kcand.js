// 1-min Kalshi candles around each buy (+/- minutes) and before the start, for matched first-bet rows.
const fs = require('fs'), zlib = require('zlib');
const K = 'https://api.elections.kalshi.com/trade-api/v2';
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
      if (r.status >= 400 && r.status < 500) { errs++; if (errs < 30) log('4xx', r.status, u.pathname + u.search, (await r.text()).slice(0, 160)); return null; }
      if (!r.ok) { await sleep(1500 * (i + 1)); continue; }
      return await r.json();
    } catch (e) { await sleep(1500 * (i + 1)); }
  }
  errs++; return null;
}
const n = v => (v == null || v === '' ? null : Number(v));
const cs = d => (d?.candlesticks || []).map(k => [k.end_period_ts, n(k.yes_bid?.close_dollars ?? k.yes_bid?.close), n(k.yes_ask?.close_dollars ?? k.yes_ask?.close), n(k.price?.close_dollars ?? k.price?.close), n(k.volume_fp ?? k.volume)]);
(async () => {
  const todo = JSON.parse(zlib.gunzipSync(fs.readFileSync('diag/ktodo.json.gz'))).filter((x, i) => i % NSH === SH);
  log('todo', todo.length);
  const out = []; let i = 0, empty = 0;
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (i < todo.length) {
      const x = todo[i++];
      const one = async (s, e) => {
        const p = { start_ts: Math.floor(s / 1000), end_ts: Math.ceil(e / 1000), period_interval: 1 };
        let d = x.hist ? await get(`/historical/markets/${x.kt}/candlesticks`, p) : await get(`/series/${x.ser}/markets/${x.kt}/candlesticks`, p);
        if (!d?.candlesticks?.length) d = x.hist ? await get(`/series/${x.ser}/markets/${x.kt}/candlesticks`, p) : await get(`/historical/markets/${x.kt}/candlesticks`, p);
        return cs(d);
      };
      const buy = await one(x.at - 30 * 60e3, x.at + 15 * 60e3);
      const close = await one(x.start - 30 * 60e3, x.start + 60e3);
      if (!buy.length) empty++;
      out.push({ id: x.id, kt: x.kt, buy, close });
      if (i % 200 === 0) log('done', i, 'empty', empty, 'calls', calls, 'errs', errs);
    }
  }));
  log('done', out.length, 'empty buy windows', empty, 'calls', calls, 'errs', errs);
  fs.mkdirSync('data', { recursive: true });
  fs.writeFileSync('data/kcand.json.gz', zlib.gzipSync(JSON.stringify(out)));
})();
