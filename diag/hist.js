// Minute price history for matched pairs: offshore Polymarket CLOB mid,
// Kalshi 1-minute candles (YES ask/bid), Polymarket US price-history (ask/bid).
// Input data/pairs.json: [{ id, k: {t, s} | null, u: {slug} | null, p: {tok}, from, to }]
const fs = require('fs'), zlib = require('zlib');
const K = 'https://api.elections.kalshi.com/trade-api/v2';
const C = 'https://clob.polymarket.com';
const U = 'https://gateway.polymarket.us';
const BUDGET = Number(process.env.BUDGET_MIN || 200) * 60e3, T0 = Date.now();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
let calls = 0, errs = 0; const errSamples = [];
async function get(url, tries = 5) {
  for (let i = 0; i < tries; i++) {
    calls++;
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(30000), headers: { 'user-agent': 'line-reaper-research' } });
      if (r.status === 429) { await sleep(2000 * (i + 1)); continue; }
      if (r.status >= 400 && r.status < 500) { errs++; if (errSamples.length < 30) errSamples.push(r.status + ' ' + url.slice(0, 160) + ' ' + (await r.text()).slice(0, 160)); return null; }
      if (!r.ok) { await sleep(1500 * (i + 1)); continue; }
      return await r.json();
    } catch (e) { await sleep(1500 * (i + 1)); }
  }
  errs++; return null;
}
async function pool(items, n, fn) { let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < items.length && Date.now() - T0 < BUDGET) { const x = items[i++]; await fn(x); } })); }
const num = v => (v == null || v === '' ? null : Number(v));
const DAY = 86400;
function chunks(from, to, size) { const out = []; for (let a = from; a < to; a += size) out.push([a, Math.min(to, a + size)]); return out; }
async function kalshi(t, s, from, to) {
  const out = [];
  for (const [a, b] of chunks(from, to, 3 * DAY)) {
    let d = await get(`${K}/series/${s}/markets/${t}/candlesticks?start_ts=${a}&end_ts=${b}&period_interval=1`);
    if (!d || !(d.candlesticks || []).length) { const h = await get(`${K}/historical/markets/${t}/candlesticks?start_ts=${a}&end_ts=${b}&period_interval=1`); if (h?.candlesticks?.length) d = h; }
    for (const k of d?.candlesticks || []) {
      const ask = num(k.yes_ask?.close_dollars ?? (k.yes_ask?.close != null ? k.yes_ask.close / 100 : null));
      const bid = num(k.yes_bid?.close_dollars ?? (k.yes_bid?.close != null ? k.yes_bid.close / 100 : null));
      out.push([Math.round(k.end_period_ts / 60), ask == null ? null : Math.round(ask * 100), bid == null ? null : Math.round(bid * 100), Math.round(num(k.volume_fp ?? k.volume) || 0)]);
    }
  }
  return out;
}
async function poly(tok, from, to) {
  const out = [];
  for (const [a, b] of chunks(from, to, DAY)) {
    const d = await get(`${C}/prices-history?market=${tok}&startTs=${a}&endTs=${b}&fidelity=1`);
    for (const x of d?.history || []) out.push([Math.round(x.t / 60), Math.round(x.p * 1000) / 10]);
  }
  return out;
}
async function pmus(slug, from, to) {
  const out = [];
  for (const [a, b] of chunks(from, to, DAY)) {
    const d = await get(`${U}/v1/price-history?symbol=${encodeURIComponent(slug)}&fidelity=1&timestamp.startTimestamp=${a}&timestamp.endTimestamp=${b}`);
    for (const x of d?.history || []) out.push([Math.round(Number(x.timestamp) / 60), num(x.longPrice) == null ? null : Math.round(num(x.longPrice) * 1000) / 10, num(x.shortPrice) == null ? null : Math.round((1 - num(x.shortPrice)) * 1000) / 10]);
  }
  return out;
}
(async () => {
  const pairs = JSON.parse(fs.readFileSync('diag/pairs.json', 'utf8'));
  log('pairs', pairs.length);
  const P = new Map(), KK = new Map(), UU = new Map();
  for (const x of pairs) {
    const f = Math.floor(x.from / 1000), t = Math.ceil(x.to / 1000);
    const pk = x.p.tok; const cur = P.get(pk); P.set(pk, cur ? [Math.min(cur[0], f), Math.max(cur[1], t)] : [f, t]);
    if (x.k) { const ck = KK.get(x.k.t); KK.set(x.k.t, { s: x.k.s, f: ck ? Math.min(ck.f, f) : f, t: ck ? Math.max(ck.t, t) : t }); }
    if (x.u) { const cu = UU.get(x.u.slug); UU.set(x.u.slug, { f: cu ? Math.min(cu.f, f) : f, t: cu ? Math.max(cu.t, t) : t }); }
  }
  log('poly tokens', P.size, 'kalshi', KK.size, 'pmus', UU.size);
  const res = { poly: {}, kalshi: {}, pmus: {} };
  let n = 0;
  await pool([...P], 8, async ([tok, [f, t]]) => { res.poly[tok] = await poly(tok, f, t); if (++n % 100 === 0) log('poly', n, calls, errs); });
  log('poly done', n); n = 0;
  await pool([...KK], 6, async ([tk, v]) => { res.kalshi[tk] = await kalshi(tk, v.s, v.f, v.t); if (++n % 100 === 0) log('kalshi', n, calls, errs); });
  log('kalshi done', n); n = 0;
  await pool([...UU], 4, async ([sl, v]) => { res.pmus[sl] = await pmus(sl, v.f, v.t); if (++n % 50 === 0) log('pmus', n, calls, errs); });
  log('pmus done', n, 'calls', calls, 'errs', errs);
  log('err samples', JSON.stringify(errSamples, null, 1));
  fs.mkdirSync('data', { recursive: true });
  fs.writeFileSync('data/hist.json.gz', zlib.gzipSync(JSON.stringify(res)));
  log('saved', (fs.statSync('data/hist.json.gz').size / 1e6).toFixed(1), 'MB');
})();
