// Kalshi closing-price calibration: for every settled sports game, spread and
// total market in the last DAYS days, the ask/bid on the last hourly candle
// before the start (start = latest_expiration_time - 48h, Kalshi's
// postponement window), and what a taker would have made buying each side
// there after the 0.07 p(1-p) fee. Which segments, if any, beat the close?
const APP = process.env.APP || require('path').resolve(__dirname, '..');
const axios = require('axios');
const fs = require('fs');
const X = require(APP + '/xarb');
const K = 'https://api.elections.kalshi.com/trade-api/v2';
const DAYS = Number(process.env.DAYS || 35);
const NOW = Date.now(), FROM = NOW - DAYS * 86400e3;
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function get(u, params, tries = 5) {
  for (let i = 0; i < tries; i++) {
    try { return (await axios.get(u, { params, timeout: 30000 })).data; }
    catch (e) { const s = e.response?.status; if (s === 404 || s === 400) return null; await sleep(1200 * (i + 1)); }
  }
  return null;
}
async function pool(items, n, fn) { let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const x = items[i++]; await fn(x); } })); }
const num = v => (v == null || v === '' ? null : Number(v));
const fee = p => 0.07 * p * (1 - p);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

(async () => {
  let series = [];
  try { series = await X.fetchKalshiGameSeries({ get: (u, o) => axios.get(u, o) }); } catch (e) { log('series list failed', e.message); }
  const roots = new Set([...X.PRIORITY_ROOTS, 'KXATP', 'KXWTA', 'KXUFC', 'KXNBA', 'KXNCAAF', 'KXNFL']);
  series = series.filter(s => roots.has(s.replace(/(GAME|MATCH|FIGHT|TOTAL|SPREAD)$/, '')));
  log('series', series.length, series.join(' '));
  const events = [];
  await pool(series, 4, async s => {
    let cursor = null;
    for (let p = 0; p < 15; p++) {
      const d = await get(K + '/events', { series_ticker: s, status: 'settled', with_nested_markets: true, limit: 200, min_close_ts: Math.floor(FROM / 1000), ...(cursor ? { cursor } : {}) });
      if (!d) break;
      events.push(...(d.events || []).map(e => ({ ...e, series_ticker: e.series_ticker || s })));
      cursor = d.cursor; if (!cursor || !(d.events || []).length) break;
    }
  });
  log('settled events', events.length);
  // rows for kind / line / league (results stripped so the parser keeps them)
  const san = events.map(e => ({ ...e, markets: (e.markets || []).map(m => ({ ...m, status: 'active', result: '', yes_ask_dollars: '0.5', no_ask_dollars: '0.5', liquidity_dollars: '1000' })) }));
  const rowOf = new Map(X.parseKalshiBinaries(san).map(r => [r.id, r]));
  const out = [];
  let tickersField = 0, noStart = 0, noCandle = 0;
  await pool(events, 6, async e => {
    const ms = e.markets || [];
    const lx = ms.map(m => Date.parse(m.latest_expiration_time || '')).find(Number.isFinite);
    if (!lx) { noStart++; return; }
    const start = lx - 48 * 3600e3;
    if (start < FROM || start > NOW) return;
    const d = await get(`${K}/series/${e.series_ticker}/events/${e.event_ticker}/candlesticks`, { start_ts: Math.floor((start - 4 * 3600e3) / 1000), end_ts: Math.floor(start / 1000), period_interval: 60 });
    if (!d) { noCandle++; return; }
    const tickers = d.market_tickers || ms.map(m => m.ticker);
    if (d.market_tickers) tickersField++;
    (d.market_candlesticks || []).forEach((cs, i) => {
      const m = ms.find(x => x.ticker === tickers[i]);
      if (!m || !Array.isArray(cs)) return;
      const c = cs.filter(x => x.end_period_ts * 1000 <= start + 60e3 && num(x.yes_ask?.close_dollars) != null && num(x.yes_bid?.close_dollars) != null).pop();
      if (!c) return;
      const ask = num(c.yes_ask.close_dollars), bid = num(c.yes_bid.close_dollars);
      const pay = num(m.settlement_value_dollars) ?? (m.result === 'yes' ? 1 : m.result === 'no' ? 0 : null);
      if (pay == null || !(ask > 0 && ask < 1) || !(bid > 0 && bid < 1)) return;
      const r = rowOf.get(m.ticker) || {};
      const vol = cs.reduce((a, x) => a + (num(x.volume_fp) || 0), 0);
      out.push({ t: m.ticker, ev: e.event_ticker, s: e.series_ticker, lg: r.league || null, k: r.kind || null, line: r.line ?? null, start: new Date(start).toISOString(), ask, bid, pay, vol: Math.round(vol), oi: Math.round(num(c.open_interest_fp) || 0) });
    });
  });
  log('rows', out.length, 'no start', noStart, 'no candles', noCandle, 'market_tickers field', tickersField);
  fs.writeFileSync('calib-rows.json', JSON.stringify(out));
  // ── summary: buy YES at ask, buy NO at 1 - bid; spread <= 4c; price of the side bought
  const bets = [];
  for (const r of out) {
    if (r.ask - r.bid > 0.04) continue;
    const kind = r.k === 'teams' || r.k === 'yesno' && /GAME|MATCH|FIGHT/.test(r.s) ? 'moneyline' : r.k === 'total' ? 'total' : r.k === 'spread' ? 'spread' : 'other';
    for (const [side, p, win] of [['yes', r.ask, r.pay], ['no', 1 - r.bid, 1 - r.pay]]) {
      if (!(p >= 0.03 && p <= 0.97)) continue;
      const cost = p + fee(p);
      bets.push({ kind, lg: r.lg || r.s.replace(/(GAME|MATCH|FIGHT|TOTAL|SPREAD)$/, ''), side, p, roi: (win - cost) / cost, edge: win - (r.ask + r.bid) / 2 * (side === 'yes' ? 1 : 0) - (side === 'no' ? 1 - (r.ask + r.bid) / 2 : 0), ev: r.ev, start: r.start, week: Math.floor((Date.parse(r.start) - FROM) / (7 * 86400e3)) });
    }
  }
  const agg = (list) => { const n = list.length, m = list.reduce((a, b) => a + b.roi, 0) / (n || 1); const sd = Math.sqrt(list.reduce((a, b) => a + (b.roi - m) ** 2, 0) / Math.max(1, n - 1)); const evs = new Set(list.map(b => b.ev)).size; return { n, games: evs, roi: +(m * 100).toFixed(2), se: +(sd / Math.sqrt(Math.max(1, evs)) * 100).toFixed(2), half1: half(list, 0), half2: half(list, 1) }; };
  const mid = (FROM + NOW) / 2;
  const half = (list, h) => { const l = list.filter(b => (Date.parse(b.start) >= mid) === !!h); return l.length ? +((l.reduce((a, b) => a + b.roi, 0) / l.length) * 100).toFixed(2) : null; };
  const group = (keyOf, min = 40) => { const g = {}; for (const b of bets) { const k = keyOf(b); if (k == null) continue; (g[k] ||= []).push(b); } return Object.entries(g).map(([k, l]) => ({ k, ...agg(l) })).filter(x => x.n >= min).sort((a, b) => b.roi - a.roi); };
  const bucket = p => `${Math.floor(p * 10) * 10}-${Math.floor(p * 10) * 10 + 10}c`;
  console.log('\n=== all bets', JSON.stringify(agg(bets)));
  console.log('\n=== by kind x price bucket (taker ROI %, se clustered by game, first/second half)');
  for (const x of group(b => `${b.kind} ${bucket(b.p)}`)) console.log(JSON.stringify(x));
  console.log('\n=== by league x kind');
  for (const x of group(b => `${b.lg} ${b.kind}`, 60)) console.log(JSON.stringify(x));
  console.log('\n=== by league x kind x fav/dog');
  for (const x of group(b => `${b.lg} ${b.kind} ${b.p >= 0.5 ? 'fav' : 'dog'}`, 60)) console.log(JSON.stringify(x));
  console.log('\n=== totals: over vs under by league');
  for (const x of group(b => (b.kind === 'total' ? `${b.lg} ${b.side === 'yes' ? 'over' : 'under'}` : null), 60)) console.log(JSON.stringify(x));
})();
