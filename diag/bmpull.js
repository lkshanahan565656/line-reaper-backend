// Big money backtest pull: every pregame trade on settled Kalshi sports game
// and player-prop markets (Sep 18 - Oct 14 2026), grouped into prints, with the
// prices that followed. Output data/prints-*.json.gz.
const fs = require('fs'), zlib = require('zlib');
const K = 'https://api.elections.kalshi.com/trade-api/v2';
const BUDGET = Number(process.env.BUDGET_MIN || 300) * 60e3, T0 = Date.now();
const MIN_PRINT = Number(process.env.MIN_PRINT || 250);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
let calls = 0, errs = 0, r429 = 0;
async function get(path, params = {}, tries = 6) {
  const u = new URL(K + path); for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.set(k, v);
  for (let i = 0; i < tries; i++) {
    calls++;
    try {
      const r = await fetch(u, { signal: AbortSignal.timeout(30000) });
      if (r.status === 429) { r429++; await sleep(1000 * (i + 1)); continue; }
      if (r.status >= 400 && r.status < 500) { errs++; return null; }
      if (!r.ok) { await sleep(1500 * (i + 1)); continue; }
      return await r.json();
    } catch (e) { await sleep(1500 * (i + 1)); }
  }
  errs++; return null;
}
async function pool(items, n, fn) { let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < items.length && Date.now() - T0 < BUDGET) { const x = items[i++]; await fn(x); } })); }
const num = v => (v == null || v === '' ? null : Number(v));
function side(t) {
  const old = String(t.taker_side || '').toLowerCase(); if (old === 'yes' || old === 'no') return old;
  const o = String(t.taker_outcome_side || '').toLowerCase(), b = String(t.taker_book_side || '').toLowerCase();
  if (o !== 'yes' && o !== 'no') return null; return b === 'ask' || b === 'sell' ? (o === 'yes' ? 'no' : 'yes') : o;
}
(async () => {
  let markets = JSON.parse(zlib.gunzipSync(fs.readFileSync('diag/markets.json.gz')));
  if (process.env.LIMIT) markets = markets.sort(() => Math.random() - 0.5).slice(0, Number(process.env.LIMIT));
  log('markets', markets.length);
  const out = []; let done = 0, trades = 0, truncated = 0;
  await pool(markets, Number(process.env.CONC || 8), async m => {
    const start = Date.parse(m.exp) - 3 * 3600e3;
    const fills = []; let cursor = null, pages = 0;
    while (pages < 60) {
      const d = await get('/markets/trades', { ticker: m.t, limit: 1000, min_ts: Math.floor((start - 72 * 3600e3) / 1000), max_ts: Math.floor(start / 1000), cursor });
      if (!d) break; pages++;
      for (const t of d.trades || []) {
        const s = side(t); if (!s) continue;
        let y = num(t.yes_price_dollars); if (y == null && t.yes_price != null) y = t.yes_price / 100;
        const c = num(t.count_fp) ?? num(t.count);
        if (!(y > 0 && y < 1) || !(c > 0)) continue;
        fills.push({ at: Date.parse(t.created_time), time: t.created_time, s, y, c, b: !!t.is_block_trade });
      }
      cursor = d.cursor; if (!cursor || !(d.trades || []).length) break;
    }
    if (pages >= 60) truncated++;
    trades += fills.length;
    fills.sort((a, b) => a.at - b.at);
    // the price series (yes) for later lookups: [at, yes] of every fill
    // group sweeps: same side + same created_time with sub-second precision
    const groups = new Map();
    for (const f of fills) {
      const key = !f.b && /\.\d*[1-9]/.test(f.time) ? `${f.s}|${f.time}` : `${f.s}|${f.time}|${Math.random()}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(f);
    }
    const prints = [];
    for (const g of groups.values()) {
      const s = g[0].s, c = g.reduce((a, f) => a + f.c, 0);
      const usd = g.reduce((a, f) => a + f.c * (s === 'yes' ? f.y : 1 - f.y), 0);
      const ys = g.map(f => f.y);
      prints.push({ at: g[0].at, s, c, usd, p: usd / c, y0: s === 'yes' ? Math.min(...ys) : Math.max(...ys), y1: s === 'yes' ? Math.max(...ys) : Math.min(...ys), n: g.length, b: g[0].b });
    }
    prints.sort((a, b) => a.at - b.at);
    // compact series: every print [at(min since start, neg), side, usd, yes avg, y0, y1, nfills, block]
    const ser = prints.map(p => [Math.round((p.at - start) / 1000), p.s === 'yes' ? 1 : 0, Math.round(p.usd), +((p.s === 'yes' ? p.p : 1 - p.p)).toFixed(4), p.y0, p.y1, p.n, p.b ? 1 : 0]);
    if (prints.some(p => p.usd >= MIN_PRINT)) out.push({ t: m.t, ev: m.ev, s: m.s, title: m.title, et: m.et, start: new Date(start).toISOString(), pay: m.pay, fm: m.fm, ft: m.ft, ser });
    if (++done % 2000 === 0) log('done', done, 'kept', out.length, 'trades', trades, 'calls', calls, 'errs', errs, '429', r429, 'trunc', truncated);
  });
  log('finished', done, 'kept', out.length, 'trades', trades, 'calls', calls, 'errs', errs, '429', r429, 'trunc', truncated);
  fs.mkdirSync('data', { recursive: true });
  for (let i = 0, part = 0; i < out.length; i += 10000, part++) fs.writeFileSync(`data/prints-${part}.json.gz`, zlib.gzipSync(JSON.stringify(out.slice(i, i + 10000))));
})();
