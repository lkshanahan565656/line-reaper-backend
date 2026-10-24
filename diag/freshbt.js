// Fresh-wallet backtest pull (Polymarket raw data only).
// 1. every closed sports/esports market with a scheduled start in [START, END]
// 2. every pregame taker BUY >= MIN_USD on those markets (wallet, price, time)
// 3. each buying wallet's first trades (age and markets before the buy)
// 4. price history of the bought token: +2 min after the buy and the pregame close
// Also re-derives the live record rows (data/record.json from prod) the same way.
const fs = require('fs'), zlib = require('zlib');
const D = 'https://data-api.polymarket.com', G = 'https://gamma-api.polymarket.com', C = 'https://clob.polymarket.com';
const START = Date.parse(process.env.START || '2026-09-24T00:00:00Z'), END = Date.parse(process.env.END || '2026-10-24T12:00:00Z');
const MIN_USD = Number(process.env.MIN_USD || 1000);
const BUDGET = Number(process.env.BUDGET_MIN || 320) * 60e3, T0 = Date.now();
const left = () => BUDGET - (Date.now() - T0);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
let calls = 0, errs = 0, r429 = 0;
async function get(url, tries = 6) {
  for (let i = 0; i < tries; i++) {
    calls++;
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(30000), headers: { 'user-agent': 'line-reaper-diag' } });
      if (r.status === 429) { r429++; await sleep(1500 * (i + 1)); continue; }
      if (r.status >= 400 && r.status < 500) { errs++; return { err: r.status, body: (await r.text()).slice(0, 200) }; }
      if (!r.ok) { await sleep(1500 * (i + 1)); continue; }
      return await r.json();
    } catch (e) { await sleep(1500 * (i + 1)); }
  }
  errs++; return null;
}
const q = (base, p) => { const u = new URL(base); for (const [k, v] of Object.entries(p)) if (v != null) u.searchParams.set(k, v); return u.toString(); };
async function pool(items, n, fn, stopAt) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length && left() > stopAt) { const x = items[i++]; try { await fn(x); } catch (e) { errs++; } } }));
  return i;
}
const J = s => { try { return typeof s === 'string' ? JSON.parse(s) : s; } catch { return null; } };
const ms = v => (v == null || v === '' ? null : (typeof v === 'number' ? (v < 1e12 ? v * 1000 : v) : Date.parse(v)));
const save = (name, obj) => { fs.mkdirSync('data', { recursive: true }); fs.writeFileSync(`data/${name}.json.gz`, zlib.gzipSync(JSON.stringify(obj))); log('saved', name); };

function marketRow(m, e, tag) {
  const outcomes = J(m.outcomes) || [], prices = (J(m.outcomePrices) || []).map(Number), tokens = J(m.clobTokenIds) || [];
  const win = prices.findIndex(p => p === 1);
  const start = ms(m.gameStartTime) ?? ms(e?.startTime) ?? null;
  return { cid: m.conditionId, q: m.question, ev: e?.slug || null, tag, smt: m.sportsMarketType || null, start, end: ms(m.endDate),
    outcomes, tokens, win, closed: !!m.closed, vol: Number(m.volumeNum || m.volume || 0), feeBps: m.takerBaseFee ?? null,
    series: e?.seriesSlug || (e?.series && e.series[0]?.slug) || null, tags: (e?.tags || []).map(t => t.slug).slice(0, 8) };
}

(async () => {
  const markets = new Map();
  // ── 0. the live record rows ──
  let record = [];
  try { record = JSON.parse(fs.readFileSync('data/record.json')).signals || []; } catch { }
  log('record rows', record.length);
  // ── 1. markets ──
  const DAY = 86400e3;
  for (const tag of (process.env.TAGS || 'sports,esports').split(',')) {
    for (let d0 = START; d0 < END + 2 * DAY; d0 += DAY) {
      for (let off = 0; off <= 2000; off += 100) {
        const d = await get(q(`${G}/events`, { tag_slug: tag, closed: 'true', end_date_min: new Date(d0).toISOString(), end_date_max: new Date(d0 + DAY).toISOString(), limit: 100, offset: off }));
        if (!Array.isArray(d) || !d.length) break;
        for (const e of d) for (const m of e.markets || []) {
          if (!m.conditionId || markets.has(m.conditionId)) continue;
          const r = marketRow(m, e, tag);
          if (r.start == null || r.start < START || r.start > END || r.win < 0 || r.vol < MIN_USD) continue;
          markets.set(m.conditionId, r);
        }
        if (d.length < 100) break;
        if (off === 2000) log('day capped', tag, new Date(d0).toISOString().slice(0, 10));
      }
      log('events', tag, new Date(d0).toISOString().slice(0, 10), 'markets', markets.size, 'calls', calls);
    }
  }
  // record rows' markets (any category)
  const need = [...new Set(record.map(r => r.conditionId).filter(c => c && !markets.has(c)))];
  for (let i = 0; i < need.length; i += 20) {
    for (const closed of ['true', 'false']) {
      const d = await get(`${G}/markets?${need.slice(i, i + 20).map(c => `condition_ids=${c}`).join('&')}&limit=50&closed=${closed}`);
      for (const m of Array.isArray(d) ? d : []) { const e = (m.events || [])[0]; const r = marketRow(m, e, 'record'); markets.set(m.conditionId, r); }
    }
  }
  log('markets', markets.size, 'calls', calls, 'errs', errs);
  save('markets', [...markets.values()]);

  // ── 2. pregame taker buys ──
  const buys = [];
  let list = [...markets.values()].filter(m => m.tag !== 'record');
  if (process.env.LIMIT) list = list.sort(() => Math.random() - 0.5).slice(0, Number(process.env.LIMIT));
  let truncated = 0;
  const done2 = await pool(list, Number(process.env.CONC || 8), async m => {
    const fills = new Map();
    for (let off = 0; off <= 3000; off += 500) {
      const d = await get(q(`${D}/trades`, { market: m.cid, takerOnly: 'true', filterType: 'CASH', filterAmount: Math.floor(MIN_USD / 4), limit: 500, offset: off }));
      if (!Array.isArray(d)) break;
      for (const t of d) {
        const at = ms(t.timestamp); if (!(at < m.start) || String(t.side).toUpperCase() !== 'BUY') continue;
        const k = `${t.transactionHash}|${t.proxyWallet}|${t.asset}`;
        const f = fills.get(k) || { w: String(t.proxyWallet).toLowerCase(), a: String(t.asset), oi: Number(t.outcomeIndex), at, c: 0, usd: 0, name: t.name || t.pseudonym || null };
        f.c += Number(t.size); f.usd += Number(t.size) * Number(t.price); f.at = Math.min(f.at, at); fills.set(k, f);
      }
      if (d.length < 500) break;
      if (off === 3000) truncated++;
    }
    for (const f of fills.values()) if (f.usd >= MIN_USD) buys.push({ cid: m.cid, ...f, p: f.usd / f.c, usd: Math.round(f.usd) });
  }, BUDGET * 0.55);
  log('trades: markets read', done2, 'of', list.length, 'buys', buys.length, 'truncated', truncated, 'calls', calls, 'errs', errs, '429', r429);
  save('buys', buys);

  // ── 3. wallets: first trades ──
  const wallets = new Map();
  const ws = [...new Set([...buys.map(b => b.w), ...record.map(r => String(r.wallet || '').toLowerCase()).filter(Boolean)])];
  // record wallets first, then by buy size so the big ones are read if time runs out
  const big = new Map(); for (const b of buys) big.set(b.w, Math.max(big.get(b.w) || 0, b.usd));
  const recW = new Set(record.map(r => String(r.wallet || '').toLowerCase()));
  ws.sort((a, b) => (recW.has(b) - recW.has(a)) || ((big.get(b) || 0) - (big.get(a) || 0)));
  let probe = null;
  const done3 = await pool(ws, Number(process.env.CONC || 8), async w => {
    const d = await get(q(`${D}/activity`, { user: w, limit: 500, offset: 0, sortBy: 'TIMESTAMP', sortDirection: 'ASC', type: 'TRADE' }));
    if (!Array.isArray(d)) { if (!probe) probe = d; return; }
    // [ts(s), conditionId, side(1 buy), usd]
    wallets.set(w, { n: d.length, full: d.length < 500, t: d.map(x => [Math.round(ms(x.timestamp) / 1000), x.conditionId, String(x.side).toUpperCase() === 'BUY' ? 1 : 0, Math.round(Number(x.usdcSize || 0))]) });
  }, BUDGET * 0.18);
  log('wallets read', done3, 'of', ws.length, 'ok', wallets.size, 'probe', JSON.stringify(probe), 'calls', calls, 'errs', errs, '429', r429);
  save('wallets', [...wallets.entries()]);

  // ── 4. prices: +2 min and the pregame close, for fresh-ish buys and a control sample ──
  const freshish = b => { const h = wallets.get(b.w); if (!h || !h.t.length) return false; const first = h.t[0][0] * 1000; return b.at - first <= 30 * 86400e3; };
  const recBuys = record.filter(r => r.asset && markets.get(r.conditionId)).map(r => ({ cid: r.conditionId, a: String(r.asset), at: Date.parse(r.at), rec: r.id }));
  const pick = [...recBuys, ...buys.filter(freshish)];
  const others = buys.filter(b => !freshish(b)).sort(() => Math.random() - 0.5).slice(0, Number(process.env.CONTROL || 4000));
  const todo = [...pick, ...others];
  const prices = new Map();
  const done4 = await pool(todo, Number(process.env.CONC || 8), async b => {
    const m = markets.get(b.cid); if (!m) return;
    const k = `${b.a}|${b.at}`; if (prices.has(k)) return;
    const s = Math.floor((b.at - 60e3) / 1000), e = Math.floor(Math.min(m.start, b.at + 7 * 86400e3) / 1000);
    const d = await get(q(`${C}/prices-history`, { market: b.a, startTs: s, endTs: e, fidelity: 1 }));
    let h = (d && d.history) || [];
    if (!h.length) { const d2 = await get(q(`${C}/prices-history`, { market: b.a, startTs: s, endTs: e, fidelity: 10 })); h = (d2 && d2.history) || []; }
    if (!h.length) { prices.set(k, null); return; }
    const after = x => h.find(p => p.t * 1000 >= x);
    const p2 = after(b.at + 120e3), p10 = after(b.at + 600e3), close = h[h.length - 1];
    prices.set(k, { p2: p2 ? p2.p : null, p10: p10 ? p10.p : null, close: close.p, closeAt: close.t, n: h.length });
  }, 60e3);
  log('prices read', done4, 'of', todo.length, 'calls', calls, 'errs', errs, '429', r429);
  save('prices', [...prices.entries()]);
  log('done in', Math.round((Date.now() - T0) / 60e3), 'min');
})();
