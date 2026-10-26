// Kalshi player-prop census + history (props lane, 10-26).
// 1) every Sports series, 2) prop series = player stat ladders, 3) every
// market of those series closing in [FROM, now+4d], 4) for markets already
// closed: 1-minute candles over the 40h before expected expiration, and every
// trade in that window. Output: out/series.json, out/markets.json.gz,
// out/hist-N.json.gz, out/log.txt
const fs = require('fs'), zlib = require('zlib');
const K = 'https://api.elections.kalshi.com/trade-api/v2';
const FROM = Date.parse(process.env.FROM || '2026-10-23T12:00:00Z');
const T0 = Date.now(), BUDGET = Number(process.env.BUDGET_MIN || 100) * 60e3;
const sleep = ms => new Promise(r => setTimeout(r, ms));
fs.mkdirSync('out', { recursive: true });
const L = fs.createWriteStream('out/log.txt');
const log = (...a) => { const s = new Date().toISOString().slice(11, 19) + ' ' + a.join(' '); console.log(s); L.write(s + '\n'); };
let calls = 0, errs = 0;
async function get(path, params = {}, tries = 6) {
  const u = new URL(K + path); for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.set(k, v);
  for (let i = 0; i < tries; i++) {
    calls++;
    try {
      const r = await fetch(u, { signal: AbortSignal.timeout(30000) });
      if (r.status === 429) { await sleep(1000 * (i + 1)); continue; }
      if (r.status >= 400 && r.status < 500) { errs++; log('4xx', r.status, u.pathname, u.search.slice(0, 120)); return null; }
      if (!r.ok) { await sleep(1500 * (i + 1)); continue; }
      return await r.json();
    } catch (e) { await sleep(1500 * (i + 1)); }
  }
  errs++; return null;
}
async function pool(items, n, fn) { let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < items.length && Date.now() - T0 < BUDGET) { const x = items[i++]; await fn(x); } })); }
const num = v => (v == null || v === '' ? null : Number(v));
const LEAGUE = /^KX(NFL|NBA|NHL|MLB|NCAAF|CFB|WNBA|NCAAB|CBB)/;
const STATWORD = /yard|point|rebound|assist|three|recept|touchdown|td|strikeout|hit|home run|base|rbi|goal|save|shot|steal|block|pass|rush|complet|attempt|interception|sack|kick|field goal|runs|outs|earned|double|player/i;
const NOT = /game|spread|total$|totals|series|champion|winner|mvp|season|draft|award|playoff|division|conference|wins|coach|trade|week|record|standings|futures|attendance|announ|mention|ratings|viewer/i;
(async () => {
  const ser = (await get('/series', { category: 'Sports' }))?.series || [];
  log('sports series', ser.length);
  const slimS = ser.map(s => ({ t: s.ticker, title: s.title, ft: s.fee_type, fm: s.fee_multiplier, tags: s.tags, freq: s.frequency }));
  fs.writeFileSync('out/series.json', JSON.stringify(slimS));
  const ONLY = process.env.SERIES ? process.env.SERIES.split(',') : null;
  const props = ONLY ? slimS.filter(s => ONLY.includes(s.t)) : slimS.filter(s => LEAGUE.test(s.t) && (STATWORD.test(s.title || '') || /YDS|PTS|REB|AST|3PT|REC|TD|KS|HIT|HR|RBI|GOAL|SAVE|SOG|STL|BLK|PRA|TB|SHOT/.test(s.t)) && !NOT.test(s.title || ''));
  log('prop series', props.length, props.map(s => s.t).join(','));
  const markets = [];
  await pool(props, 4, async s => {
    let cursor = null, n = 0;
    do {
      const d = await get('/markets', { series_ticker: s.t, min_close_ts: Math.floor(FROM / 1000), limit: 1000, cursor });
      if (!d) break;
      for (const m of d.markets || []) {
        n++;
        markets.push({ s: s.t, t: m.ticker, ev: m.event_ticker, title: m.title, sub: m.yes_sub_title, st: m.strike_type, fs: num(m.floor_strike), cs: num(m.cap_strike),
          status: m.status, result: m.result, sv: num(m.settlement_value_dollars), open: m.open_time, close: m.close_time, exp: m.expected_expiration_time, occ: m.occurrence_datetime,
          bid: num(m.yes_bid_dollars), ask: num(m.yes_ask_dollars), last: num(m.last_price_dollars), vol: num(m.volume_fp) ?? m.volume, oi: num(m.open_interest_fp) ?? m.open_interest,
          liq: num(m.liquidity_dollars), rules: (m.rules_primary || '').slice(0, 300) });
      }
      cursor = d.cursor;
    } while (cursor);
    if (n) log('series', s.t, 'markets', n);
  });
  log('markets', markets.length, 'calls', calls);
  fs.writeFileSync('out/markets.json.gz', zlib.gzipSync(JSON.stringify(markets)));
  const E0 = Date.parse(process.env.EXP_FROM || '2000-01-01'), E1 = Date.parse(process.env.EXP_TO || '2100-01-01');
  const done = markets.filter(m => Date.parse(m.close) < Date.now() && (m.vol || 0) > 0 || (process.env.EXP_FROM && m.result));
  for (let i = done.length - 1; i >= 0; i--) { const e = Date.parse(done[i].exp); if (!(e >= E0 && e <= E1)) done.splice(i, 1); }
  log('closed markets with volume', done.length);
  const hist = []; let k = 0;
  await pool(done, 8, async m => {
    const end = Math.min(Date.parse(m.exp || m.close), Date.parse(m.close));
    const st = Math.max(Date.parse(m.open), end - 40 * 3600e3);
    const d = await get(`/series/${m.s}/markets/${m.t}/candlesticks`, { start_ts: Math.floor(st / 1000), end_ts: Math.ceil(end / 1000), period_interval: 1 });
    const c = [];
    for (const x of d?.candlesticks || []) {
      const a = num(x.yes_ask?.close_dollars), b = num(x.yes_bid?.close_dollars);
      c.push([x.end_period_ts, a == null ? null : Math.round(a * 100), b == null ? null : Math.round(b * 100), Math.round(num(x.volume_fp) ?? x.volume ?? 0),
        num(x.yes_ask?.low_dollars) == null ? null : Math.round(num(x.yes_ask.low_dollars) * 100), num(x.yes_bid?.high_dollars) == null ? null : Math.round(num(x.yes_bid.high_dollars) * 100)]);
    }
    const tr = []; let cursor = null;
    do {
      const q = await get('/markets/trades', { ticker: m.t, min_ts: Math.floor(st / 1000), max_ts: Math.ceil(end / 1000), limit: 1000, cursor });
      if (!q) break;
      for (const x of q.trades || []) tr.push([Math.floor(Date.parse(x.created_time) / 1000), Math.round(num(x.yes_price_dollars) * 100), Math.round(num(x.count_fp) ?? x.count), x.taker_side === 'yes' ? 1 : 0]);
      cursor = q.cursor;
    } while (cursor && tr.length < 20000);
    hist.push({ t: m.t, c, tr });
    if (++k % 200 === 0) log('hist', k, 'of', done.length, 'calls', calls, 'errs', errs);
  });
  if (!hist[0]?.c.length) log('first candle sample', JSON.stringify(hist[0]).slice(0, 400));
  for (let i = 0, p = 0; i < hist.length; i += 1500, p++) fs.writeFileSync(`out/hist-${p}.json.gz`, zlib.gzipSync(JSON.stringify(hist.slice(i, i + 1500))));
  log('done hist', hist.length, 'calls', calls, 'errs', errs);
})();
