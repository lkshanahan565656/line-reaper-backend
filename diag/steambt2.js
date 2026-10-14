// Steam replay with the live Polymarket spread filter rebuilt from trades.
// steambt.js's data (Polymarket minute prices, Kalshi minute asks/bids) plus
// every Polymarket taker trade in the 6h before each game: a YES buy (or NO
// sell) prints near the ask, a YES sell (or NO buy) near the bid, so the
// latest of each in the last W minutes is that minute's quoted spread.
const axios = require('axios');
const fs = require('fs');
const zlib = require('zlib');
const A = process.env.APP || './app';
const X = require(`${A}/xarb`), { createSteamWatch } = require(`${A}/steam`), { kalshiFee } = require(`${A}/exchanges`), V = require(`${A}/xvalue`);
const K = 'https://api.elections.kalshi.com/trade-api/v2';
const DAYS = parseFloat(process.env.BT_DAYS || '4');
const NOW = Date.now(), FROM = NOW - DAYS * 86400e3, TO = NOW - 30 * 60e3;
const LOOKBACK = 6 * 3600e3, MIN = 60e3;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
async function get(u, params, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try { return (await axios.get(u, { params, timeout: 30000 })).data; }
    catch (e) { const s = e.response?.status; if (s === 404 || s === 400 || s === 422) return null; await sleep(1500 * (i + 1)); }
  }
  return null;
}
async function pool(items, n, fn) { let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const x = items[i++]; await fn(x); } })); }

async function gather() {
  const pEvents = new Map();
  for (let t = FROM - 6 * 3600e3; t < NOW + 6 * 3600e3; t += 8 * 3600e3) {
    for (const tag of ['sports', 'esports']) for (let off = 0; off < 2100; off += 100) {
      const g = await get('https://gamma-api.polymarket.com/events', { closed: true, tag_slug: tag, limit: 100, offset: off, end_date_min: new Date(t).toISOString(), end_date_max: new Date(t + 8 * 3600e3).toISOString() });
      if (!Array.isArray(g)) break;
      for (const e of g) pEvents.set(e.id, e);
      if (g.length < 100) break;
    }
  }
  const vol = new Map();
  for (const e of pEvents.values()) for (const m of e.markets || []) vol.set(String(m.id), Number(m.volumeNum ?? m.volume) || 0);
  const iso = new Date(NOW).toISOString();
  const pSan = [...pEvents.values()].map(e => ({ ...e, closed: false, active: true, markets: (e.markets || []).map(m => ({ ...m, closed: false, active: true, acceptingOrders: true, archived: false, updatedAt: iso, bestAsk: 0.5, bestBid: 0.49, liquidityNum: 1e5, liquidity: 1e5 })) }));
  const poly = X.parsePolymarketBinaries(pSan, { now: NOW }).filter(p => p.startTime && Date.parse(p.startTime) >= FROM && Date.parse(p.startTime) <= TO);
  log('polymarket events', pEvents.size, 'rows in window', poly.length);
  let series = [];
  try { series = await X.fetchKalshiGameSeries({ get: (u, o) => axios.get(u, o) }); } catch (e) { log('series list failed', e.message); series = X.SEED_GAME_SERIES; }
  const kEvents = [];
  await pool(series, 4, async s => {
    let cursor = null;
    for (let p = 0; p < 10; p++) {
      const d = await get(K + '/events', { series_ticker: s, status: 'settled', with_nested_markets: true, limit: 200, min_close_ts: Math.floor((FROM - 86400e3) / 1000), ...(cursor ? { cursor } : {}) });
      if (!d) break;
      kEvents.push(...(d.events || []).map(e => ({ ...e, series_ticker: e.series_ticker || s })));
      cursor = d.cursor; if (!cursor || !(d.events || []).length) break;
    }
  });
  const kSan = kEvents.map(e => ({ ...e, markets: (e.markets || []).map(m => ({ ...m, status: 'active', result: '', yes_ask_dollars: '0.5', no_ask_dollars: '0.5', liquidity_dollars: '10000' })) }));
  const kalshi = X.parseKalshiBinaries(kSan);
  const seriesOf = new Map(); for (const e of kEvents) for (const m of e.markets || []) seriesOf.set(m.ticker, e.series_ticker);
  log('kalshi events', kEvents.length, 'rows', kalshi.length);
  const matches = X.matchMarkets(kalshi, poly).filter(m => m.by !== 'title');
  const teamMkts = new Map(); for (const k of kalshi) if (k.kind === 'teams') teamMkts.set(`${k.eventKey}|${k.outcomeLabel}`, k);
  const pairs = new Map();
  for (const m of matches) {
    pairs.set(m.kalshi.id, { target: m.kalshi, ref: m.polymarket, same: m.same });
    const twin = m.by === 'teams' && m.kalshi.noLabel ? teamMkts.get(`${m.kalshi.eventKey}|${m.kalshi.noLabel}`) : null;
    if (twin && !pairs.has(twin.id)) pairs.set(twin.id, { target: twin, ref: m.polymarket, same: !m.same });
  }
  const list = [...pairs.values()].map(x => ({ ...x, start: Date.parse(x.ref.startTime || x.target.startTime) })).filter(x => x.start >= FROM && x.start <= TO);
  log('pairs', list.length);
  const refs = list.map(x => x.ref).filter((r, i, a) => a.findIndex(y => y.id === r.id) === i);
  const pHist = new Map(), kHist = new Map(), trades = new Map();
  await pool(refs, 6, async r => {
    const tok = r.tokenIds?.[r.yesIndex ?? 0]; if (!tok) return;
    const st = Date.parse(r.startTime);
    const h = await get('https://clob.polymarket.com/prices-history', { market: tok, startTs: Math.floor((st - LOOKBACK) / 1000), endTs: Math.floor(st / 1000), fidelity: 1 });
    if (h?.history?.length) pHist.set(r.id, h.history.map(p => [p.t * 1000, p.p]));
  });
  log('polymarket histories', pHist.size, 'of', refs.length);
  // taker trades, newest first, back to 6h before the start
  let capped = 0;
  await pool(refs.filter(r => pHist.has(r.id) && r.conditionId), 4, async r => {
    const yesTok = r.tokenIds?.[r.yesIndex ?? 0], st = Date.parse(r.startTime);
    const out = [];
    let off = 0, done = false;
    while (!done) {
      const d = await get('https://data-api.polymarket.com/trades', { market: r.conditionId, limit: 500, offset: off, takerOnly: true });
      if (!Array.isArray(d) || !d.length) break;
      for (const tr of d) {
        const t = Number(tr.timestamp) * 1000, p = Number(tr.price);
        if (t < st - LOOKBACK) { done = true; break; }
        if (t >= st || !(p > 0 && p < 1)) continue;
        const yes = String(tr.asset) === String(yesTok);
        const buy = String(tr.side).toUpperCase() === 'BUY';
        // in YES terms: 'a' printed at the ask, 'b' at the bid
        out.push([t, yes ? p : 1 - p, yes === buy ? 'a' : 'b', Number(tr.size) || 0]);
      }
      if (d.length < 500) break;
      off += 500;
      if (off >= 10000) { capped++; break; }
    }
    trades.set(r.id, out.sort((a, b) => a[0] - b[0]));
  });
  log('trade lists', trades.size, 'capped', capped, 'trades', [...trades.values()].reduce((a, v) => a + v.length, 0));
  await pool(list, 6, async x => {
    const s = seriesOf.get(x.target.id) || x.target.id.split('-')[0];
    const d = await get(`${K}/series/${s}/markets/${x.target.id}/candlesticks`, { start_ts: Math.floor((x.start - LOOKBACK) / 1000), end_ts: Math.floor(x.start / 1000), period_interval: 1 });
    const c = (d?.candlesticks || []).map(k => [k.end_period_ts * 1000, parseFloat(k.yes_ask?.close_dollars), parseFloat(k.yes_bid?.close_dollars)]).filter(k => Number.isFinite(k[1]) && Number.isFinite(k[2]));
    if (c.length) kHist.set(x.target.id, c);
  });
  log('kalshi histories', kHist.size, 'of', list.length);
  return { at: NOW, list: list.map(x => ({ id: x.target.id, ref: x.ref.id, same: x.same, start: x.start, vol: vol.get(String(x.ref.id)) || 0, league: x.target.league || x.ref.league || V.leagueTag(x.target) || V.leagueTag(x.ref), market: x.target.kind === 'teams' || x.target.game3 ? 'moneyline' : x.target.kind, title: x.target.eventTitle })), pHist: [...pHist], kHist: [...kHist], trades: [...trades] };
}

// ── replay ──
const fee = p => kalshiFee(p, 100, 0.07) / 100;
const at = (h, t, maxAge) => { let lo = 0, hi = h.length - 1, j = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (h[m][0] <= t) { j = m; lo = m + 1; } else hi = m - 1; } return j >= 0 && t - h[j][0] <= maxAge ? h[j] : null; };
// quoted spread at t from the last ask print and the last bid print in W minutes (null: no quote)
function spreadAt(tr, t, W) {
  let a = null, b = null, n = 0;
  let lo = 0, hi = tr.length - 1, j = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (tr[m][0] <= t) { j = m; lo = m + 1; } else hi = m - 1; }
  for (let i = j; i >= 0 && tr[i][0] > t - W; i--) { n++; if (a == null && tr[i][2] === 'a') a = tr[i][1]; if (b == null && tr[i][2] === 'b') b = tr[i][1]; if (a != null && b != null) break; }
  return a == null || b == null ? { spread: null, n } : { spread: Math.max(0, a - b), n };
}
function run(D, { minMove = 0.03, windowMs = 20 * MIN, maxFollow = 0.4, minEv = 0.01, gapEv = 0.02, maxEv = 0.12, maxSpread = 0.03, W = 10 * MIN, filter = true, minVol = 0 } = {}) {
  const pH = new Map(D.pHist), kH = new Map(D.kHist), TR = new Map(D.trades);
  const bets = [];
  for (const x of D.list) {
    const ph = pH.get(x.ref), kh = kH.get(x.id), tr = TR.get(x.ref);
    if (!ph || !kh || (filter && !tr) || x.vol < minVol) continue;
    const w = createSteamWatch({ minMove, windowMs, maxFollow, maxSpread, minEv });
    const fairAt = t => { const p = at(ph, t, 10 * MIN); return p ? (x.same ? p[1] : 1 - p[1]) : null; };
    const close = fairAt(x.start - MIN);
    if (close == null) continue;
    const flagged = new Set();
    for (let t = x.start - LOOKBACK; t < x.start - MIN; t += MIN) {
      const fy = fairAt(t), k = at(kh, t, 5 * MIN);
      if (fy == null || !k) continue;
      const sp = filter ? spreadAt(tr, t, W).spread : 0.01;
      const quotes = new Map();
      for (const side of ['yes', 'no']) {
        const price = side === 'yes' ? k[1] : 1 - k[2];
        if (!(price >= 0.05 && price <= 0.95)) continue;
        quotes.set(side, { fair: side === 'yes' ? fy : 1 - fy, cost: price + fee(price), price, spread: sp == null ? 1 : sp });
      }
      for (const [side, q] of quotes) {
        if (flagged.has(side) || !(q.spread <= maxSpread + 1e-9)) continue;
        const ev = q.fair / q.cost - 1;
        if (ev > maxEv) continue;
        const s = w.steamOf(side, q.fair, q.cost, t);
        const kind = s && ev >= minEv ? 'steam' : ev >= gapEv ? 'gap' : null;
        if (!kind) continue;
        flagged.add(side);
        const cf = side === 'yes' ? close : 1 - close;
        const costAt = u => { if (u >= x.start) return null; const kk = at(kh, u, 5 * MIN); if (!kk) return null; const pr = side === 'yes' ? kk[1] : 1 - kk[2]; return pr > 0 && pr < 1 ? pr + fee(pr) : null; };
        const lag = {};
        for (const L of [1, 2, 5]) { const c = costAt(t + L * MIN); lag[L] = c == null ? null : cf / c - 1; }
        let lasted = 0; for (let u = 1; u <= 30; u++) { const c = costAt(t + u * MIN); if (c == null || c > q.cost + 1e-9) break; lasted = u; }
        bets.push({ kind, id: x.id, side, league: x.league, market: x.market, vol: x.vol, ev, clv: cf / q.cost - 1, clv1: lag[1], clv2: lag[2], clv5: lag[5], lasted, minsToStart: (x.start - t) / MIN, move: s?.move ?? null, spread: q.spread, cost: q.cost });
      }
      w.observe(quotes, t);
    }
  }
  return bets;
}
const pc = v => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(2)}%`;
function stat(b, k = 'clv') { const v = b.map(x => x[k]).filter(z => z != null); const n = v.length; if (!n) return `n 0`; const m = v.reduce((a, z) => a + z, 0) / n; const sd = Math.sqrt(v.reduce((a, z) => a + (z - m) ** 2, 0) / Math.max(1, n - 1)); return `${pc(m)} t ${(m / (sd / Math.sqrt(n) || 1)).toFixed(2)} n ${n} beat ${Math.round(100 * v.filter(z => z > 0).length / n)}%`; }
const line = (name, b) => console.log(`${name.padEnd(34)} alert ${stat(b)} | +2m ${stat(b, 'clv2')} | +5m ${stat(b, 'clv5')} | lasted≥2m ${b.length ? Math.round(100 * b.filter(x => x.lasted >= 2).length / b.length) : 0}%`);
function report(D) {
  const pH = new Map(D.pHist), kH = new Map(D.kHist), TR = new Map(D.trades);
  console.log('pairs', D.list.length, 'with both histories', D.list.filter(x => pH.has(x.ref) && kH.has(x.id)).length, 'with trades too', D.list.filter(x => pH.has(x.ref) && kH.has(x.id) && TR.get(x.ref)?.length).length);
  // spread proxy sanity: share of minutes with a quote, and its median
  const sps = []; let mins = 0;
  for (const x of D.list.slice(0, 400)) { const tr = TR.get(x.ref); if (!tr) continue; for (let t = x.start - LOOKBACK; t < x.start; t += 10 * MIN) { mins++; const s = spreadAt(tr, t, 10 * MIN).spread; if (s != null) sps.push(s); } }
  sps.sort((a, b) => a - b);
  console.log(`spread proxy: quoted in ${Math.round(100 * sps.length / Math.max(1, mins))}% of sampled minutes, median ${(sps[sps.length >> 1] * 100).toFixed(1)}c, p25 ${(sps[sps.length >> 2] * 100).toFixed(1)}c, p75 ${(sps[(3 * sps.length) >> 2] * 100).toFixed(1)}c, share ≤3c ${Math.round(100 * sps.filter(s => s <= 0.03).length / Math.max(1, sps.length))}%`);
  const unf = run(D, { filter: false }), fil = run(D, {});
  line('UNFILTERED steam', unf.filter(b => b.kind === 'steam'));
  line('UNFILTERED gap', unf.filter(b => b.kind === 'gap'));
  line('FILTERED steam (PM spread≤3c)', fil.filter(b => b.kind === 'steam'));
  line('FILTERED gap', fil.filter(b => b.kind === 'gap'));
  const st = fil.filter(b => b.kind === 'steam');
  for (const [nm, f] of [['market', b => b.market], ['league', b => b.league], ['EV', b => b.ev < 0.02 ? '1-2%' : b.ev < 0.04 ? '2-4%' : '4%+'], ['move', b => b.move < 0.04 ? '3-4c' : b.move < 0.06 ? '4-6c' : '6c+'], ['to start', b => b.minsToStart < 30 ? '<30m' : b.minsToStart < 120 ? '30m-2h' : '2h+'], ['PM volume', b => b.vol < 50e3 ? '<50k' : b.vol < 250e3 ? '50-250k' : '250k+']]) {
    const g = {}; for (const b of st) (g[f(b)] ||= []).push(b);
    for (const [k, v] of Object.entries(g).sort((a, c) => c[1].length - a[1].length)) if (v.length >= 5) line(`  steam ${nm} ${k}`, v);
  }
  console.log('SWEEP filtered steam');
  for (const maxSpread of [0.02, 0.03]) for (const W of [5, 10, 20]) for (const minMove of [0.02, 0.03, 0.04]) for (const minEv of [0.01, 0.02, 0.03]) {
    const b = run(D, { maxSpread, W: W * MIN, minMove, minEv }).filter(x => x.kind === 'steam');
    if (b.length >= 10) line(`  sp${maxSpread} W${W} mv${minMove} ev${minEv}`, b);
  }
  for (const minVol of [50e3, 250e3, 1e6]) { const b = run(D, { minVol }); line(`  vol≥${minVol / 1e3}k steam`, b.filter(x => x.kind === 'steam')); line(`  vol≥${minVol / 1e3}k gap`, b.filter(x => x.kind === 'gap')); }
  return fil;
}

(async () => {
  let D;
  if (process.argv[2]) D = JSON.parse(zlib.gunzipSync(fs.readFileSync(process.argv[2])));
  else { D = await gather(); fs.writeFileSync('bt2-data.json.gz', zlib.gzipSync(JSON.stringify(D))); log('saved bt2-data.json.gz', fs.statSync('bt2-data.json.gz').size); }
  const bets = report(D);
  fs.writeFileSync('bt2-bets.json', JSON.stringify(bets));
})();
