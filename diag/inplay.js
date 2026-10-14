// In-play arb watch: games already under way on both Kalshi and Polymarket
// US, each pair's two books read together every TICK_S seconds. Logs every
// moment a pair costs under $1 after taker fees with size, and how long each
// gap stays open (consecutive ticks).
const APP = process.env.APP || require('path').resolve(__dirname, '..');
const axios = require('axios');
const fs = require('fs');
const xarb = require(APP + '/xarb');
const pmus = require(APP + '/pmus');
const DUR = Number(process.env.DUR_MIN || 45) * 60e3, TICK = Number(process.env.TICK_S || 3) * 1e3, MAXP = Number(process.env.MAX_PAIRS || 16);
const http = axios.create({ timeout: 8000, headers: { 'user-agent': 'line-reaper-diag' } });
http.interceptors.response.use(null, async e => { const c = e.config || {}; if (e.response?.status === 429 && (c.__t || 0) < 2) { c.__t = (c.__t || 0) + 1; await new Promise(r => setTimeout(r, 700)); return http(c); } throw e; });
const K = 'https://api.elections.kalshi.com/trade-api/v2';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const r4 = x => Math.round(x * 1e4) / 1e4;
const kFee = p => 0.07 * p * (1 - p), uFee = (p, rate = 0.0695) => rate * p * (1 - p);
async function pool(items, n, fn) { let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const x = items[i++]; await fn(x).catch(() => {}); } })); }
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function kalshiBook(ticker) {
  const { data } = await http.get(`${K}/markets/${ticker}/orderbook`, { params: { depth: 10 } });
  const ob = data?.orderbook || data?.orderbook_fp || {};
  const lv = arr => (arr || []).map(([p, q]) => ({ p: Number(p) > 1 ? Number(p) / 100 : Number(p), q: Number(q) }));
  const yesBids = lv(ob.yes_dollars || ob.yes), noBids = lv(ob.no_dollars || ob.no);
  const asks = bids => bids.map(l => ({ p: r4(1 - l.p), q: l.q })).filter(l => l.p > 0 && l.p < 1 && l.q > 0).sort((a, b) => a.p - b.p);
  return { yes: asks(noBids), no: asks(yesBids) };
}
async function usBook(slug, yesSide) {
  const { data } = await http.get(`${pmus.GATEWAY}/v1/markets/${encodeURIComponent(slug)}/book`);
  const d = data?.marketData || data || {};
  const px = l => Number(l?.px?.value ?? l?.px ?? l?.price?.value ?? l?.price);
  const long = (d.offers || []).map(l => ({ p: px(l), q: Number(l.qty) })).filter(l => l.p > 0 && l.p < 1 && l.q > 0).sort((a, b) => a.p - b.p);
  const short = (d.bids || []).map(l => ({ p: r4(1 - px(l)), q: Number(l.qty) })).filter(l => l.p > 0 && l.p < 1 && l.q > 0).sort((a, b) => a.p - b.p);
  const open = !d.state || String(d.state).toLowerCase() === 'market_state_open';
  return yesSide === 'long' ? { yes: long, no: short, open, state: d.state } : { yes: short, no: long, open, state: d.state };
}
function fill(a, b, fa, fb) {
  let i = 0, j = 0, qa = a[0]?.q || 0, qb = b[0]?.q || 0, n = 0, spent = 0;
  while (i < a.length && j < b.length) {
    const c = a[i].p + fa(a[i].p) + b[j].p + fb(b[j].p);
    if (c >= 1) break;
    const t = Math.min(qa, qb); n += t; spent += t * c; qa -= t; qb -= t;
    if (qa <= 0) { i++; qa = a[i]?.q || 0; } if (qb <= 0) { j++; qb = b[j]?.q || 0; }
  }
  const top = a[0] && b[0] ? r4(a[0].p + fa(a[0].p) + b[0].p + fb(b[0].p)) : null;
  return { n: Math.floor(n), profit: Math.round((n - spent) * 100) / 100, top };
}

(async () => {
  const t0 = Date.now();
  let series = [];
  try { series = await xarb.fetchKalshiGameSeries(http); } catch (e) { log('series list failed', e.message); }
  const roots = new Set(xarb.PRIORITY_ROOTS);
  series = series.filter(s => roots.has(s.replace(/(GAME|MATCH|FIGHT|TOTAL|SPREAD)$/, '')));
  const pm = pmus.createPolymarketUs({ http, eventTtlMs: 5000, bookTtlMs: 0, log: null });
  let pairs = [], refreshed = 0, ticks = 0;
  const open = new Map(), gaps = [];
  const nearMiss = {};   // top-of-book all-in cost buckets
  async function refresh() {
    const kalshi = [];
    await pool(series, 4, async s => { await xarb.fetchKalshiEvents(http, { seriesTicker: s, maxPages: 2, onPage: p => kalshi.push(...xarb.parseKalshiBinaries(p)) }); });
    const us = await pm.arbRows({});
    const now = Date.now();
    const matches = xarb.matchMarkets(kalshi, us, { now, region: 'us' }).filter(m => {
      const st = Date.parse(m.polymarket.startTime || m.kalshi.startTime || '');
      return Number.isFinite(st) && st < now && st > now - 4 * 3600e3 && m.kalshi.tradable && m.polymarket.tradable;
    });
    // moneylines first, then totals and spreads nearest 50c
    const score = m => (m.kalshi.kind === 'teams' ? 0 : 1) + Math.abs((m.kalshi.yesAsk ?? 0.5) - 0.5);
    const seen = new Set();
    pairs = matches.sort((a, b) => score(a) - score(b)).filter(m => { const k = m.kalshi.eventKey + m.polymarket.id; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, MAXP);
    log('in-play pairs', matches.length, 'watching', pairs.length, pairs.map(m => `${m.kalshi.id}~${m.polymarket.id}`).join(' '));
  }
  while (Date.now() - t0 < DUR) {
    const c0 = Date.now();
    if (c0 - refreshed > 3 * 60e3) { refreshed = c0; try { await refresh(); } catch (e) { log('refresh failed', e.message); } }
    ticks++;
    await pool(pairs, 8, async m => {
      const [kb, ub] = await Promise.all([kalshiBook(m.kalshi.id), usBook(m.polymarket.id, m.polymarket.yesSide)]);
      const t = Date.now();
      for (const [ks, us] of [['yes', m.same ? 'no' : 'yes'], ['no', m.same ? 'yes' : 'no']]) {
        const f = fill(kb[ks], ub[us], kFee, p => uFee(p, m.polymarket.feeSchedule?.rate));
        if (f.top != null) { const b = Math.floor((f.top - 1) * 100); nearMiss[b] = (nearMiss[b] || 0) + 1; }
        const key = `${m.kalshi.id}:${ks}+${m.polymarket.id}:${us}`;
        if (f.n > 0 && ub.open) {
          const g = open.get(key) || { key, title: m.kalshi.eventTitle || m.kalshi.title, kind: m.kalshi.kind, first: t, ticks: 0, best: 0, bestN: 0, tops: [] };
          g.last = t; g.ticks++; g.best = Math.max(g.best, f.profit); g.bestN = Math.max(g.bestN, f.n); if (g.tops.length < 8) g.tops.push(f.top);
          g.lastTick = ticks;
          open.set(key, g);
        }
      }
    });
    for (const [k, g] of open) if (g.lastTick < ticks) { g.lastedSec = Math.round((g.last - g.first) / 1000); gaps.push(g); open.delete(k); log('gap closed', JSON.stringify(g)); }
    const wait = TICK - (Date.now() - c0); if (wait > 0) await sleep(wait);
  }
  for (const g of open.values()) { g.lastedSec = Math.round((g.last - g.first) / 1000); g.stillOpen = true; gaps.push(g); }
  console.log('\n=== ticks', ticks, 'tick ms target', TICK);
  console.log('top-of-book all-in cost minus $1, in cents (bucket: pair-side-ticks)', JSON.stringify(Object.fromEntries(Object.entries(nearMiss).sort((a, b) => a[0] - b[0]))));
  const by = (lo, hi) => gaps.filter(g => g.lastedSec >= lo && g.lastedSec < hi);
  console.log('gaps', gaps.length, 'lasting <5s', by(0, 5).length, '5-15s', by(5, 15).length, '15-30s', by(15, 30).length, '30-60s', by(30, 60).length, '60s+', by(60, 1e9).length);
  console.log('profit available in gaps lasting 15s+: $', gaps.filter(g => g.lastedSec >= 15).reduce((a, g) => a + g.best, 0).toFixed(2), ' all gaps: $', gaps.reduce((a, g) => a + g.best, 0).toFixed(2));
  for (const g of gaps.sort((a, b) => b.best - a.best).slice(0, 40)) console.log(JSON.stringify(g));
  fs.writeFileSync('inplay-out.json', JSON.stringify(gaps));
})();
