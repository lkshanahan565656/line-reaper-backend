// Pull Kalshi esports match markets (settled, live + historical API) with
// hourly candles over the 72h before start and minute candles around start.
const fs = require('fs'), zlib = require('zlib');
const K = 'https://api.elections.kalshi.com/trade-api/v2';
const SERIES = (process.env.SERIES || 'KXCS2GAME,KXLOLGAME,KXVALORANTGAME,KXDOTA2GAME,KXR6GAME,KXCODGAME,KXOWGAME').split(',');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
let calls = 0, errs = 0; const T0 = Date.now(), BUDGET = Number(process.env.BUDGET_MIN || 140) * 60e3;
async function get(path, params = {}, tries = 6) {
  const u = new URL(K + path); for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.set(k, v);
  for (let i = 0; i < tries; i++) {
    calls++;
    try {
      const r = await fetch(u, { signal: AbortSignal.timeout(30000) });
      if (r.status === 429) { await sleep(1000 * (i + 1)); continue; }
      if (r.status >= 400 && r.status < 500) { errs++; if (errs < 15) log('4xx', r.status, u.pathname + u.search, (await r.text()).slice(0, 200)); return null; }
      if (!r.ok) { await sleep(1500 * (i + 1)); continue; }
      return await r.json();
    } catch (e) { await sleep(1500 * (i + 1)); }
  }
  errs++; return null;
}
async function pool(items, n, fn) { let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < items.length && Date.now() - T0 < BUDGET) { const x = items[i++]; await fn(x); } })); }
const num = v => (v == null || v === '' ? null : Number(v));
const MON = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
// ET wall clock -> UTC ms
function etToUtc(y, mo, d, h, mi) {
  const guess = Date.UTC(y, mo, d, h + 4, mi);
  const f = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  for (const off of [4, 5]) { const t = Date.UTC(y, mo, d, h + off, mi); const p = Object.fromEntries(f.formatToParts(t).map(x => [x.type, x.value])); if (+p.hour % 24 === h && +p.minute === mi && +p.day === d) return t; }
  return guess;
}
function startFromTicker(ev) {
  const m = /-(\d{2})([A-Z]{3})(\d{2})(\d{2})(\d{2})/.exec(ev);
  if (!m) return null;
  return etToUtc(2000 + +m[1], MON[m[2]], +m[3], +m[4], +m[5]);
}
async function listMarkets(series, hist) {
  const out = []; let cursor = null;
  for (let p = 0; p < 200; p++) {
    const d = await get(hist ? '/historical/markets' : '/markets', { series_ticker: series, status: hist ? undefined : 'settled', limit: 1000, cursor });
    if (!d) break;
    out.push(...(d.markets || []));
    cursor = d.cursor; if (!cursor || !(d.markets || []).length) break;
  }
  return out;
}
(async () => {
  log('cutoff', JSON.stringify(await get('/historical/cutoff')));
  const evs = [];
  for (const s of SERIES) {
    const live = await listMarkets(s, false), hist = await listMarkets(s, true);
    const all = new Map(); for (const m of [...hist, ...live]) all.set(m.ticker, { ...m, _hist: !live.some(x => x.ticker === m.ticker) });
    const byEv = new Map(); for (const m of all.values()) { if (!(m.result === 'yes' || m.result === 'no')) continue; (byEv.get(m.event_ticker) || byEv.set(m.event_ticker, []).get(m.event_ticker)).push(m); }
    log(s, 'live', live.length, 'hist', hist.length, 'events', byEv.size, 'sample', JSON.stringify(live[0] || hist[0] || {}).slice(0, 1500));
    for (const [ev, ms] of byEv) evs.push({ s, ev, ms });
  }
  evs.sort((x, y) => (startFromTicker(y.ev) || 0) - (startFromTicker(x.ev) || 0));
  log('events total', evs.length);
  const out = []; let done = 0;
  await pool(evs, 8, async ({ s, ev, ms }) => {
    const start = startFromTicker(ev) || Date.parse(ms[0].occurrence_datetime || '') || null;
    const rec = { s, ev, start, title: ms[0].title, ms: [] };
    for (const [mi_, m] of ms.entries()) {
      const hist = m._hist;
      const path = hist ? `/historical/markets/${m.ticker}/candlesticks` : `/series/${s}/markets/${m.ticker}/candlesticks`;
      const ref = start || Date.parse(m.close_time);
      const conv = (cs, refT) => (cs || []).map(k => [Math.round((k.end_period_ts * 1000 - refT) / 60e3), num(k.yes_ask?.close_dollars ?? k.yes_ask?.close), num(k.yes_bid?.close_dollars ?? k.yes_bid?.close), Math.round(num(k.volume_fp ?? k.volume) || 0), num(k.price?.close_dollars ?? k.price?.close)]);
      const h = mi_ ? null : await get(path, { start_ts: Math.floor(ref / 1000) - 96 * 3600, end_ts: Math.floor(ref / 1000) + 4 * 3600, period_interval: 60 });
      const mi = mi_ ? null : await get(path, { start_ts: Math.floor(ref / 1000) - 180 * 60, end_ts: Math.floor(ref / 1000) + 20 * 60, period_interval: 1 });
      rec.ms.push({ t: m.ticker, sub: m.yes_sub_title, res: m.result, vol: num(m.volume_fp ?? m.volume), open: m.open_time, close: m.close_time, occ: m.occurrence_datetime, exp: m.expected_expiration_time, rules: done < 3 ? m.rules_primary : undefined, hist, h: conv(h?.candlesticks, ref), mi: conv(mi?.candlesticks, ref) });
    }
    out.push(rec);
    if (++done % 200 === 0) { fs.mkdirSync('data', { recursive: true }); fs.writeFileSync('data/kalshi-es.json.gz', zlib.gzipSync(JSON.stringify(out))); } if (done % 200 === 0) log('events', done, '/', evs.length, 'calls', calls, 'errs', errs);
  });
  fs.mkdirSync('data', { recursive: true });
  fs.writeFileSync('data/kalshi-es.json.gz', zlib.gzipSync(JSON.stringify(out)));
  log('saved', out.length, 'events; calls', calls, 'errs', errs);
})();
