// Forward recorder (props lane): Kalshi player-prop tops of book each minute,
// Pinnacle props every 2 min, and the order book of each rung that matches
// Pinnacle's line exactly and is within 1% of a 2% edge (taker) — the size at
// the shown price. Writes out/rec.jsonl (changes only) + out/books.jsonl.
const fs = require('fs');
const A = process.env.APP || './app';
const axios = require(A + '/node_modules/axios');
const { canonName } = require(A + '/ev');
const pinprops = require(A + '/pinprops');
const execcheck = require(A + '/execcheck');
const fees = require(A + '/fees');
const K = 'https://api.elections.kalshi.com/trade-api/v2';
const RUN_MIN = Number(process.env.RUN_MIN || 330), T0 = Date.now(), STOP = Date.parse(process.env.STOP_AT || '2100-01-01');
const MKEY = { KXNFLRECYDS: 'rec_yds', KXNFLREC: 'receptions', KXNFLPASSTDS: 'pass_tds', KXNFLPASSCOMP: 'pass_comp', KXNFLRSHATT: 'rush_att',
  KXNFLPASSYDS: 'pass_yds', KXNFLRSHYDS: 'rush_yds', KXNFLTD: 'anytime_td', KXNFLPASSATT: 'pass_att', KXNFLPASSINT: 'pass_ints',
  KXNBAPTS: 'points', KXNBAAST: 'assists', KXNBAREB: 'rebounds', KXNBA3PT: 'threes', KXNBAPRA: 'pra',
  KXNHLPTS: 'points', KXNHLGOAL: 'goals', KXNHLAST: 'assists', KXNHLSAVE: 'saves' };
fs.mkdirSync('out', { recursive: true });
const rec = fs.createWriteStream('out/rec.jsonl', { flags: 'a' }), books = fs.createWriteStream('out/books.jsonl', { flags: 'a' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const num = v => (v == null || v === '' ? null : Number(v));
const toProb = a => (a > 0 ? 100 / (a + 100) : -a / (-a + 100));
const last = new Map();
const put = (k, v, m) => { const j = JSON.stringify(v); if (last.get(k) === j) return; const first = !last.has(k); last.set(k, j); rec.write(JSON.stringify({ t: Date.now(), k, v, ...(first && m ? { m } : {}) }) + '\n'); };
let pin = new Map(), stats = { ticks: 0, kalshi: 0, pin: 0, books: 0, errs: {} };
async function readPin() {
  const { props, errors } = await pinprops.fetchPinnacleProps(axios, '', { NFL: 889, NBA: 487, NHL: 1456 });
  if (errors.length) stats.errs.pin = errors.join('; ');
  const m = new Map();
  for (const p of props) { m.set(`${p.sport}|${canonName(p.player)}|${p.mkey}`, p); put('P|' + p.key, [p.line, p.over, p.under], { st: p.start, p: p.player }); }
  if (props.length) { for (const k of pin.keys()) if (!m.has(k)) put('P|' + k, null); pin = m; }
  stats.pin = props.length;
}
async function readKalshi() {
  const out = [];
  for (const s of Object.keys(MKEY)) {
    try {
      let cursor = null;
      do {
        const r = await axios.get(K + '/markets', { params: { series_ticker: s, status: 'open', limit: 1000, cursor }, timeout: 20000 });
        for (const x of r.data?.markets || []) out.push({ s, x });
        cursor = r.data?.cursor;
      } while (cursor);
    } catch (e) { stats.errs[s] = e.response?.status || e.message; if (e.response?.status === 429) await sleep(2000); }
    await sleep(120);
  }
  stats.kalshi = out.length;
  const near = [];
  for (const { s, x } of out) {
    const bid = num(x.yes_bid_dollars), ask = num(x.yes_ask_dollars);
    put('K|' + x.ticker, [bid, ask, num(x.yes_bid_size_fp) ?? null, num(x.yes_ask_size_fp) ?? null], { s, title: x.title, fs: num(x.floor_strike), exp: x.expected_expiration_time, ev: x.event_ticker });
    const sp = s.slice(2, 5), player = String(x.title || '').split(':')[0].trim();
    const p = pin.get(`${sp}|${canonName(player)}|${MKEY[s]}`);
    if (!p || Math.abs(p.line - num(x.floor_strike)) > 1e-6) continue;
    const st = Date.parse(p.start), exp = Date.parse(x.expected_expiration_time);
    if (!(exp - st > 0 && exp - st <= 12 * 3600e3) || st - Date.now() > 24 * 3600e3 || st < Date.now()) continue;
    const pO = pinprops.devigPower(toProb(p.over), toProb(p.under));
    for (const [side, pr, pf] of [['yes', ask, pO], ['no', bid == null ? null : 1 - bid, 1 - pO]]) {
      if (!(pr > 0 && pr < 1)) continue;
      const ev = pf / (pr + fees.orderFee('kalshi', pr, 100, { rate: 0.07, round: true }) / 100) - 1;
      if (ev >= 0.01) near.push({ t: x.ticker, side, ev, pf });
    }
  }
  near.sort((a, b) => b.ev - a.ev);
  for (const n of near.slice(0, 40)) {
    try {
      const r = await axios.get(`${K}/markets/${n.t}/orderbook`, { timeout: 10000 });
      const asks = execcheck.kalshiAsks(r.data, n.side);
      // contracts and dollars at an ask that still clears 2% after fee, and at the top price
      let atEdge = 0, usd = 0; const top = asks.length ? Math.min(...asks.map(a => a[0])) : null; let atTop = 0;
      for (const [p, q] of asks) { const c = p + fees.orderFee('kalshi', p, 100, { rate: 0.07, round: true }) / 100; if (n.pf / c - 1 >= 0.02) { atEdge += q; usd += q * p; } if (p === top) atTop += q; }
      books.write(JSON.stringify({ t: Date.now(), k: n.t, side: n.side, ev: +n.ev.toFixed(4), pf: +n.pf.toFixed(4), top, atTop: Math.round(atTop), atEdge: Math.round(atEdge), usdAtEdge: Math.round(usd), levels: asks.slice(0, 8) }) + '\n');
      stats.books++;
    } catch (e) { stats.errs.book = e.response?.status || e.message; }
    await sleep(100);
  }
}
(async () => {
  let lastPin = 0;
  while (Date.now() - T0 < RUN_MIN * 60e3 && Date.now() < STOP) {
    const t = Date.now();
    if (t - lastPin > 115e3) { try { await readPin(); } catch (e) { stats.errs.pin = e.message; } lastPin = t; }
    try { await readKalshi(); } catch (e) { stats.errs.k = e.message; }
    stats.ticks++;
    if (stats.ticks % 10 === 1) { fs.writeFileSync('out/stats.json', JSON.stringify({ ...stats, at: new Date().toISOString() })); console.log(JSON.stringify(stats)); }
    await sleep(Math.max(1000, 60e3 - (Date.now() - t)));
  }
  fs.writeFileSync('out/stats.json', JSON.stringify({ ...stats, at: new Date().toISOString(), done: true }));
})();
