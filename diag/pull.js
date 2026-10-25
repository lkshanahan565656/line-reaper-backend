// NFL game-line model research pull. One PART per job:
//   res:nflverse  nflverse games.csv (schedules, scores, closing spread/total/moneyline, QBs, rest) saved raw
//   k:<SERIES>    every settled Kalshi market in that series since SINCE: hourly candles 6 days back and
//                 minute candles the 8 hours before the anchor (expected expiration / occurrence)
//   pm:nfl        Polymarket NFL events (moneyline / spread / total), price history around the start
const fs = require('fs'), zlib = require('zlib');
const PART = process.env.PART || '';
const SINCE = Date.parse(process.env.SINCE || '2025-01-01');
const BUDGET = Number(process.env.BUDGET_MIN || 150) * 60e3, T0 = Date.now();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
let calls = 0, errs = 0;
async function get(url, params = {}, headers = {}, tries = 6, text = false) {
  const u = new URL(url); for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.set(k, v);
  for (let i = 0; i < tries; i++) {
    calls++;
    try {
      const r = await fetch(u, { headers, signal: AbortSignal.timeout(45000) });
      if (r.status === 429) { await sleep(2000 * (i + 1)); continue; }
      if (r.status >= 400 && r.status < 500) { errs++; if (errs < 40) log('4xx', r.status, (u.host + u.pathname + u.search).slice(0, 220), (await r.text()).slice(0, 200)); return null; }
      if (!r.ok) { await sleep(1500 * (i + 1)); continue; }
      return text ? await r.text() : await r.json();
    } catch (e) { await sleep(1500 * (i + 1)); }
  }
  errs++; return null;
}
async function pool(items, n, fn) { let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < items.length && Date.now() - T0 < BUDGET) { const x = items[i++]; await fn(x); } })); }
const save = (name, v) => { fs.mkdirSync('data', { recursive: true }); fs.writeFileSync(`data/${name}.json.gz`, zlib.gzipSync(JSON.stringify(v))); log('saved', name, Array.isArray(v) ? v.length : ''); };
const num = v => (v == null || v === '' ? null : Number(v));

async function nflverse() {
  fs.mkdirSync('data', { recursive: true });
  for (const [name, url] of [['games.csv', 'https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv'],
    ['games-release.csv', 'https://github.com/nflverse/nflverse-data/releases/download/schedules/games.csv']]) {
    const t = await get(url, {}, {}, 4, true);
    log(name, t ? t.length : 'none');
    if (t) fs.writeFileSync(`data/${name}`, t);
  }
}

const K = 'https://api.elections.kalshi.com/trade-api/v2';
async function listMarkets(series, hist) {
  const out = []; let cursor = null;
  for (let p = 0; p < 400; p++) {
    const d = await get(K + (hist ? '/historical/markets' : '/markets'), { series_ticker: series, status: hist ? undefined : 'settled', limit: 1000, cursor });
    if (!d) break; out.push(...(d.markets || [])); cursor = d.cursor; if (!cursor || !(d.markets || []).length) break;
  }
  return out;
}
const conv = cs => (cs || []).map(k => [k.end_period_ts, num(k.yes_ask?.close_dollars ?? k.yes_ask?.close), num(k.yes_bid?.close_dollars ?? k.yes_bid?.close), Math.round(num(k.volume_fp ?? k.volume) || 0), num(k.price?.close_dollars ?? k.price?.close)]);
async function kalshi(series) {
  const sl = await get(K + '/series', { category: 'Sports' });
  const nfl = (sl?.series || []).filter(s => /NFL/i.test(s.ticker));
  log('kalshi NFL series', nfl.map(s => `${s.ticker}:${s.title}`).join(' | ').slice(0, 3000));
  save('k-series', nfl);
  const live = await listMarkets(series, false), hist = await listMarkets(series, true);
  const liveSet = new Set(live.map(m => m.ticker));
  const ms = [...hist, ...live].filter(m => (m.result === 'yes' || m.result === 'no') && Date.parse(m.close_time || '') >= SINCE);
  log(series, 'live', live.length, 'hist', hist.length, 'settled since', ms.length, 'sample', JSON.stringify(live[0] || hist[0] || {}).slice(0, 2000));
  const out = [], seen = new Set(); let done = 0;
  await pool(ms, 12, async m => {
    if (seen.has(m.ticker)) return; seen.add(m.ticker);
    const p = !liveSet.has(m.ticker) ? `/historical/markets/${m.ticker}/candlesticks` : `/series/${series}/markets/${m.ticker}/candlesticks`;
    const close = Date.parse(m.close_time), open = Date.parse(m.open_time);
    const anc = Math.min(close, Date.parse(m.expected_expiration_time || m.occurrence_datetime || '') || close);
    const a = Math.floor(anc / 1000);
    const h = await get(K + p, { start_ts: Math.max(Math.floor(open / 1000), a - 6 * 86400), end_ts: a, period_interval: 60 });
    const mi = await get(K + p, { start_ts: Math.max(Math.floor(open / 1000), a - 8 * 3600), end_ts: a, period_interval: 1 });
    out.push({ s: series, ev: m.event_ticker, t: m.ticker, title: m.title, sub: m.yes_sub_title, nosub: m.no_sub_title, strike: num(m.floor_strike), stype: m.strike_type,
      res: m.result, vol: num(m.volume_fp ?? m.volume), open: m.open_time, close: m.close_time, exp: m.expected_expiration_time ?? null, occ: m.occurrence_datetime ?? null,
      rules: (m.rules_primary || '').slice(0, 400), h: conv(h?.candlesticks), mi: conv(mi?.candlesticks) });
    if (++done % 400 === 0) { log(series, done, '/', ms.length, 'calls', calls, 'errs', errs); save(`k-${series}`, out); }
  });
  save(`k-${series}`, out);
}

const GAMMA = 'https://gamma-api.polymarket.com', CLOB = 'https://clob.polymarket.com';
const pj = s => { try { return typeof s === 'string' ? JSON.parse(s) : s; } catch { return null; } };
async function history(token, startMs) {
  const s0 = Math.floor(startMs / 1000);
  const a = await get(`${CLOB}/prices-history`, { market: token, startTs: s0 - 72 * 3600, endTs: s0 + 600, fidelity: 10 });
  const b = await get(`${CLOB}/prices-history`, { market: token, startTs: s0 - 180 * 60, endTs: s0 + 5 * 60, fidelity: 1 });
  const rows = x => (x?.history || []).map(r => [Math.round((r.t * 1000 - startMs) / 60e3), r.p]);
  return { h: rows(a), mi: rows(b) };
}
async function polymarket() {
  const sp = await get(`${GAMMA}/sports`);
  const row = (sp || []).find(x => x.sport === 'nfl');
  log('pm nfl row', JSON.stringify(row));
  const seriesIds = String(row?.series || '').split(',').map(Number).filter(Boolean);
  const evs = [];
  for (const series of seriesIds) {
    for (let off = 0; off < 20000; off += 100) {
      const d = await get(`${GAMMA}/events`, { series_id: series, closed: true, limit: 100, offset: off, order: 'startDate', ascending: false });
      if (!d || !d.length) break;
      evs.push(...d);
      if (off === 0) log('pm sample', JSON.stringify(d[0]).slice(0, 2500));
      const oldest = Math.min(...d.map(e => Date.parse(e.startDate || e.startTime || '') || Infinity));
      if (oldest < SINCE - 30 * 86400e3) break;
      await sleep(120);
    }
  }
  log('pm events', evs.length);
  const out = []; let done = 0;
  await pool(evs, 6, async ev => {
    const start = Date.parse(ev.startTime || ev.markets?.[0]?.gameStartTime || '') || null;
    if (!start || start < SINCE) return;
    const ms = (ev.markets || []).filter(m => ['moneyline', 'spreads', 'totals'].includes(m.sportsMarketType));
    const mk = [];
    for (const m of ms) {
      const toks = pj(m.clobTokenIds) || [];
      if (!toks[0]) continue;
      mk.push({ type: m.sportsMarketType, q: m.question, line: num(m.line), outcomes: pj(m.outcomes), prices: pj(m.outcomePrices), vol: num(m.volumeNum ?? m.volume), ...(await history(toks[0], start)) });
    }
    out.push({ slug: ev.slug, title: ev.title, start, vol: num(ev.volume), mk });
    if (++done % 100 === 0) { log('pm', done, '/', evs.length, 'calls', calls, 'errs', errs); save('pm-nfl', out); }
  });
  save('pm-nfl', out);
}

(async () => {
  const [kind, arg] = PART.split(':');
  if (kind === 'res') await nflverse();
  else if (kind === 'k') await kalshi(arg);
  else if (kind === 'pm') await polymarket();
  log('done', PART, 'calls', calls, 'errs', errs, 'min', Math.round((Date.now() - T0) / 60e3));
})();
