// Kalshi maker backtest pull (diag only; Kalshi answers only from Actions).
// Reads every Kalshi game the lead-lag recorder matched to Pinnacle (nfl, ncaaf,
// nba, nhl), then saves each event's markets (status, result) and every trade
// printed from first sight to 5 min after the scheduled start, plus the series
// fee schedule. Output out/kmaker.json.gz.
import fs from 'fs';
import zlib from 'zlib';
const API = 'https://api.elections.kalshi.com/trade-api/v2';
const SPORTS = new Set(['nfl', 'ncaaf', 'nba', 'nhl']);
const wait = ms => new Promise(r => setTimeout(r, ms));
const stats = { req: 0, r429: 0, err: 0, events: 0, markets: 0, trades: 0 };
async function get(path, params = {}) {
  const u = new URL(API + path);
  for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.set(k, v);
  for (let i = 0; ; i++) {
    stats.req++;
    try {
      const r = await fetch(u, { headers: { accept: 'application/json' } });
      if (r.status === 429) { stats.r429++; await wait(1000 * (i + 1)); if (i < 8) continue; }
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`${r.status} ${path}`);
      await wait(120);
      return await r.json();
    } catch (e) { if (i >= 4) { stats.err++; console.log('ERR', e.message); return null; } await wait(1500 * (i + 1)); }
  }
}
// tk "kalshi:KXNFL|26OCT25PITNO" → first t, start
const games = new Map();
for (const f of fs.readdirSync('in')) {
  const lines = zlib.gunzipSync(fs.readFileSync('in/' + f)).toString().split('\n');
  for (const l of lines) {
    if (!l.includes('"tk"')) continue;
    let o; try { o = JSON.parse(l); } catch { continue; }
    const sport = o.k.split('|')[0];
    if (!SPORTS.has(sport) || !o.m?.tk) continue;
    const g = games.get(o.m.tk) || { tk: o.m.tk, sport, first: o.t, st: o.m.st, home: o.m.home, away: o.m.away };
    g.first = Math.min(g.first, o.t);
    games.set(o.m.tk, g);
  }
}
console.log('games', games.size);
const series = {};
const out = { at: new Date().toISOString(), games: [], series, stats };
for (const g of games.values()) {
  const [root, suffix] = g.tk.replace(/^kalshi:/, '').split('|');
  const ev = [];
  for (const kind of ['GAME', 'SPREAD', 'TOTAL']) {
    const s = root + kind;
    if (!(s in series)) { const r = await get(`/series/${s}`); series[s] = r?.series ? { fee_type: r.series.fee_type, fee_multiplier: r.series.fee_multiplier } : null; }
    const et = `${s}-${suffix}`;
    const r = await get('/markets', { event_ticker: et, limit: 200 });
    const mk = r?.markets || [];
    if (!mk.length) continue;
    stats.events++;
    const markets = [];
    const minTs = Math.floor(g.first / 1000) - 3600, maxTs = Math.floor(Date.parse(g.st) / 1000) + 300;
    for (const m of mk) {
      stats.markets++;
      const trades = [];
      let cursor = null;
      for (let p = 0; p < 50; p++) {
        const t = await get('/markets/trades', { ticker: m.ticker, limit: 1000, min_ts: minTs, max_ts: maxTs, cursor });
        for (const x of t?.trades || []) trades.push([Date.parse(x.created_time), x.yes_price_dollars != null ? +x.yes_price_dollars : x.yes_price / 100, x.taker_side, +(x.count_fp ?? x.count)]);
        cursor = t?.cursor || null;
        if (!cursor || !(t?.trades || []).length) break;
      }
      stats.trades += trades.length;
      markets.push({ ticker: m.ticker, title: m.title, yes_sub_title: m.yes_sub_title, sub_title: m.subtitle, status: m.status, result: m.result,
        floor_strike: m.floor_strike, strike_type: m.strike_type, functional_strike: m.functional_strike, expected_expiration_time: m.expected_expiration_time,
        close_time: m.close_time, rules_primary: (m.rules_primary || '').slice(0, 300), trades });
    }
    ev.push({ event_ticker: et, series: s, markets });
  }
  out.games.push({ ...g, events: ev });
  if (out.games.length % 20 === 0) console.log(out.games.length, JSON.stringify(stats));
}
fs.mkdirSync('out', { recursive: true });
fs.writeFileSync('out/kmaker.json.gz', zlib.gzipSync(JSON.stringify(out)));
console.log('done', JSON.stringify(stats));
