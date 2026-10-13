// How stale is Gamma next to Polymarket's live book, and how long do Kalshi
// prices take to follow a Polymarket move? Watches paired pregame lines for RUN_MIN.
const axios = require('axios');
const WebSocket = require('ws');
const xarb = require('../xarb');
const RUN_MIN = parseFloat(process.env.RUN_MIN || '14');
const http = axios.create({ timeout: 20000 });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const now = () => Date.now();
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

(async () => {
  const poly = [];
  await xarb.fetchPolymarketEvents(http, { maxPages: 15, onPage: p => poly.push(...xarb.parsePolymarketBinaries(p)) });
  const sweep = xarb.createKalshiGameSweep({ http, perScan: 80 });
  let kalshi = [];
  for (let i = 0; i < 4; i++) kalshi = await sweep.step();
  const matches = xarb.matchMarkets(kalshi, poly, { now: now() });
  const t = now();
  const pairs = [], why = {};
  const no = k => { why[k] = (why[k] || 0) + 1; };
  for (const m of matches) {
    const p = m.polymarket, k = m.kalshi;
    if (m.by === 'title') { no('title'); continue; }
    if (!p.tradable || !k.tradable) { no('untradable'); continue; }
    const st = Date.parse(p.startTime || k.startTime || k.closeTime || '');
    if (!Number.isFinite(st)) { no('nostart'); continue; }
    if (!(st - t > -3 * 3600e3 && st - t < 48 * 3600e3)) { no('window'); continue; }
    if (p.yesAsk == null || p.noAsk == null || p.yesAsk + p.noAsk - 1 > 0.08) { no('wide'); continue; }
    const tok = p.tokenIds?.[p.yesIndex ?? 0];
    if (!tok) { no('notoken'); continue; }
    pairs.push({ live: st <= t, tok, pid: p.id, yesIndex: p.yesIndex ?? 0, kt: k.id, same: m.same, title: p.title, league: p.league, start: st, ws: [], gm: [], km: [] });
  }
  pairs.splice(400);
  log('poly rows', poly.length, 'kalshi rows', kalshi.length, 'matches', matches.length, 'watched', pairs.length, JSON.stringify(why), 'pregame', pairs.filter(p => p.start > t).length);
  const byTok = new Map(pairs.map(p => [p.tok, p]));
  const book = new Map();   // tok → {bid, ask}
  const stats = { msgs: 0, types: {}, opens: 0, errors: [], gammaPolls: 0, kalshiPolls: 0, kalshiErr: null, gammaErr: null };
  const push = (arr, v) => { const last = arr[arr.length - 1]; if (v == null) return; if (!last || Math.abs(last.v - v) > 1e-9) arr.push({ t: now(), v }); };
  const wsMid = (p, b) => b && b.bid != null && b.ask != null && b.ask - b.bid <= 0.06 ? (b.bid + b.ask) / 2 : null;
  let sock;
  function connect() {
    sock = new WebSocket('wss://ws-subscriptions-clob.polymarket.com/ws/market');
    sock.on('open', () => { stats.opens++; sock.send(JSON.stringify({ type: 'market', assets_ids: pairs.map(p => p.tok) })); });
    sock.on('message', buf => {
      const s = buf.toString(); if (s === 'PONG') return;
      let d; try { d = JSON.parse(s); } catch { return; }
      for (const m of Array.isArray(d) ? d : [d]) {
        stats.msgs++; stats.types[m.event_type] = (stats.types[m.event_type] || 0) + 1;
        if (m.event_type === 'book') {
          const bids = (m.bids || []).map(x => +x.price), asks = (m.asks || []).map(x => +x.price);
          const b = { bid: bids.length ? Math.max(...bids) : null, ask: asks.length ? Math.min(...asks) : null };
          book.set(m.asset_id, b); const p = byTok.get(m.asset_id); if (p) push(p.ws, wsMid(p, b));
        } else if (m.event_type === 'price_change') {
          for (const c of m.price_changes || []) {
            if (c.best_bid == null && c.best_ask == null) continue;
            const b = { bid: c.best_bid != null ? +c.best_bid : null, ask: c.best_ask != null ? +c.best_ask : null };
            book.set(c.asset_id, b); const p = byTok.get(c.asset_id); if (p) push(p.ws, wsMid(p, b));
          }
        } else if (m.event_type === 'best_bid_ask') {
          const b = { bid: +m.best_bid, ask: +m.best_ask }; book.set(m.asset_id, b); const p = byTok.get(m.asset_id); if (p) push(p.ws, wsMid(p, b));
        }
      }
    });
    sock.on('error', e => stats.errors.push(e.message));
    sock.on('close', () => { if (now() < end) setTimeout(connect, 1000); });
  }
  const end = now() + RUN_MIN * 60e3;
  connect();
  const ping = setInterval(() => { try { sock.send('PING'); } catch {} }, 10e3);
  while (now() < end) {
    // Gamma, batched by id
    for (let i = 0; i < pairs.length; i += 40) {
      const ids = pairs.slice(i, i + 40);
      try {
        const qs = ids.map(p => `id=${p.pid}`).join('&');
        const r = await http.get(`https://gamma-api.polymarket.com/markets?${qs}&limit=100`);
        for (const m of r.data || []) {
          const p = pairs.find(x => String(x.pid) === String(m.id)); if (!p) continue;
          const bb = +m.bestBid, ba = +m.bestAsk; if (!(ba > 0) || !(bb >= 0) || ba - bb > 0.06) continue;
          const mid = (bb + ba) / 2; push(p.gm, p.yesIndex === 0 ? mid : 1 - mid);
        }
        stats.gammaPolls++;
      } catch (e) { stats.gammaErr = e.message; }
    }
    for (let i = 0; i < pairs.length; i += 100) {
      const ids = pairs.slice(i, i + 100);
      try {
        const r = await http.get('https://api.elections.kalshi.com/trade-api/v2/markets', { params: { tickers: ids.map(p => p.kt).join(','), limit: 200 } });
        for (const m of r.data?.markets || []) {
          const p = pairs.find(x => x.kt === m.ticker); if (!p) continue;
          const ya = m.yes_ask_dollars != null ? +m.yes_ask_dollars : m.yes_ask / 100, yb = m.yes_bid_dollars != null ? +m.yes_bid_dollars : m.yes_bid / 100;
          if (!(ya > 0) || !(yb > 0) || ya - yb > 0.06) continue;
          const mid = (ya + yb) / 2; push(p.km, p.same ? mid : 1 - mid);
        }
        stats.kalshiPolls++;
      } catch (e) { stats.kalshiErr = e.message; }
    }
    await sleep(15e3);
  }
  clearInterval(ping); try { sock.close(); } catch {}
  // moves: WS mid up or down 3c+ off its 20-min extreme
  const at = (arr, t) => { let v = null; for (const x of arr) { if (x.t > t) break; v = x.v; } return v; };
  const moves = [];
  for (const p of pairs) {
    let lastMoveT = -Infinity;
    for (let i = 0; i < p.ws.length; i++) {
      const x = p.ws[i]; if (x.t - lastMoveT < 5 * 60e3) continue;
      const win = p.ws.filter(y => y.t >= x.t - 20 * 60e3 && y.t <= x.t);
      const lo = win.reduce((a, y) => (y.v < a.v ? y : a)), hi = win.reduce((a, y) => (y.v > a.v ? y : a));
      let from = null, dir = 0;
      if (x.v - lo.v >= 0.03) { from = lo; dir = 1; } else if (hi.v - x.v >= 0.03) { from = hi; dir = -1; }
      if (!from) continue;
      lastMoveT = x.t;
      const move = (x.v - from.v);
      const g0 = at(p.gm, from.t), k0 = at(p.km, x.t), kFrom = at(p.km, from.t);
      const gT = p.gm.find(y => y.t >= from.t && g0 != null && (y.v - g0) * dir >= 0.02);
      const kT = p.km.find(y => y.t >= from.t && kFrom != null && (y.v - kFrom) * dir >= 0.6 * Math.abs(move));
      moves.push({ live: p.live, title: p.title, league: p.league, from: +from.v.toFixed(3), to: +x.v.toFixed(3), wsAt: new Date(x.t).toISOString().slice(11, 19),
        buildSec: Math.round((x.t - from.t) / 1e3), gammaLagSec: gT ? Math.round((gT.t - x.t) / 1e3) : null,
        kalshiAtMove: k0 != null ? +k0.toFixed(3) : null, kalshiFrom: kFrom != null ? +kFrom.toFixed(3) : null, kalshiFollowSec: kT ? Math.round((kT.t - x.t) / 1e3) : null });
    }
  }
  // Gamma vs WS divergence, sampled every 15s
  let samples = 0, diverge = 0, sumAbs = 0;
  for (const p of pairs) for (let tt = end - RUN_MIN * 60e3 + 60e3; tt < end; tt += 15e3) {
    const a = at(p.ws, tt), b = at(p.gm, tt); if (a == null || b == null) continue;
    samples++; sumAbs += Math.abs(a - b); if (Math.abs(a - b) >= 0.015) diverge++;
  }
  const med = xs => { const s = xs.filter(x => x != null).sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
  console.log(JSON.stringify({ stats, watched: pairs.length, withWs: pairs.filter(p => p.ws.length).length, withGamma: pairs.filter(p => p.gm.length).length, withKalshi: pairs.filter(p => p.km.length).length,
    wsChanges: pairs.reduce((a, p) => a + p.ws.length, 0), gammaChanges: pairs.reduce((a, p) => a + p.gm.length, 0), kalshiChanges: pairs.reduce((a, p) => a + p.km.length, 0),
    gammaVsWs: { samples, avgAbsDiffC: samples ? +(sumAbs / samples * 100).toFixed(2) : null, over1_5c: diverge },
    moves: moves.length, medGammaLagSec: med(moves.map(m => m.gammaLagSec)), gammaNeverCaught: moves.filter(m => m.gammaLagSec == null).length,
    medKalshiFollowSec: med(moves.map(m => m.kalshiFollowSec)), kalshiNeverFollowed: moves.filter(m => m.kalshiFollowSec == null).length,
    examples: moves.slice(0, 40) }, null, 1));
  process.exit(0);
})().catch(e => { console.error('FAILED', e.stack); process.exit(1); });
