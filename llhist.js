// Lead-lag history pull: for each Kalshi/Polymarket pair (pairs.json), the 48 h before
// Polymarket's game start: Kalshi 1-minute candles (yes bid/ask/last) and Polymarket
// 1-minute prices for the matching token. Shard SHARD of SHARDS. → data/hist-SHARD.json.gz
const fs = require('fs'), zlib = require('zlib');
const K = 'https://api.elections.kalshi.com/trade-api/v2', C = 'https://clob.polymarket.com';
const SHARD = +process.env.SHARD || 0, SHARDS = +process.env.SHARDS || 1;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let calls = 0, r429 = 0, errs = 0;
async function get(url, tries = 8) {
  for (let i = 0; i < tries; i++) {
    calls++;
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(30000), headers: { 'user-agent': 'line-reaper-diag', accept: 'application/json' } });
      if (r.status === 429) { r429++; await sleep(1000 * (i + 1)); continue; }
      if (r.status >= 400 && r.status < 500) { errs++; return { err: r.status, body: (await r.text()).slice(0, 200) }; }
      if (!r.ok) { await sleep(1000 * (i + 1)); continue; }
      return await r.json();
    } catch (e) { await sleep(1000 * (i + 1)); }
  }
  errs++; return null;
}
const d = x => (x == null ? null : +Number(x).toFixed(4));
(async () => {
  const pairs = JSON.parse(fs.readFileSync('pairs.json')).filter((_, i) => i % SHARDS === SHARD);
  const out = [];
  const pmDone = new Map();
  let i = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (i < pairs.length) {
      const p = pairs[i++];
      const end = Math.floor(p.pmstart / 1000) + 300, start = end - 48 * 3600 - 300;
      const ser = p.kt.split('-')[0];
      const kc = await get(`${K}/series/${ser}/markets/${p.kt}/candlesticks?start_ts=${start}&end_ts=${end}&period_interval=1`);
      const k = (kc?.candlesticks || []).map(c => [c.end_period_ts, d(c.yes_bid?.close_dollars ?? (c.yes_bid?.close != null ? c.yes_bid.close / 100 : null)), d(c.yes_ask?.close_dollars ?? (c.yes_ask?.close != null ? c.yes_ask.close / 100 : null)),
        d(c.price?.close_dollars ?? (c.price?.close != null ? c.price.close / 100 : null)), c.volume_fp != null ? +c.volume_fp : c.volume ?? null]);
      let pm = pmDone.get(p.tok);
      if (!pm) {
        const h = await get(`${C}/prices-history?market=${p.tok}&startTs=${start}&endTs=${end}&fidelity=1`);
        pm = (h?.history || []).map(x => [x.t, d(x.p)]);
        pmDone.set(p.tok, pm);
      }
      out.push({ ...p, k, pm, kerr: kc?.err || null, kraw: out.length < 2 ? JSON.stringify(kc).slice(0, 1500) : undefined });
      if (out.length % 200 === 0) console.log(new Date().toISOString(), out.length, pairs.length, 'calls', calls, '429', r429, 'errs', errs);
    }
  }));
  fs.mkdirSync('data', { recursive: true });
  fs.writeFileSync(`data/hist-${SHARD}.json.gz`, zlib.gzipSync(JSON.stringify(out)));
  console.log('done', out.length, 'calls', calls, '429', r429, 'errs', errs);
})();
