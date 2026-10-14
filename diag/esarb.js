// Live census of arbs inside Kalshi esports: buy YES on both teams of the same
// match (or map) when ask A + ask B + taker fees < $1. Reads both order books
// together and records how many contracts fill, the locked profit, and how long
// each gap lasts. Pre-match vs in-play by the ticker's start time.
const fs = require('fs');
const axios = require('axios');
const K = 'https://api.elections.kalshi.com/trade-api/v2';
const DUR = Number(process.env.DUR_MIN || 120) * 60e3, EVERY = Number(process.env.EVERY_S || 20) * 1e3;
const http = axios.create({ timeout: 15000, headers: { 'user-agent': 'line-reaper-diag' } });
http.interceptors.response.use(null, async e => {
  const c = e.config || {};
  if (e.response?.status === 429 && (c.__t || 0) < 4) { c.__t = (c.__t || 0) + 1; await new Promise(r => setTimeout(r, 1000 * c.__t)); return http(c); }
  throw e;
});
const sleep = ms => new Promise(r => setTimeout(r, ms));
const SERIES = (process.env.SERIES || 'KXCS2GAME,KXLOLGAME,KXVALORANTGAME,KXDOTA2GAME,KXCODGAME,KXR6GAME,KXOWGAME,KXRLGAME,KXMLBBGAME,KXCS2MAP,KXVALORANTMAP,KXLOLMAP,KXDOTA2MAP,KXCODMAP,KXR6MAP').split(',');
const MON = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
function startOf(t) { const m = /-(\d{2})([A-Z]{3})(\d{2})(\d{2})(\d{2})/.exec(t); return m ? Date.UTC(2000 + +m[1], MON[m[2]], +m[3], +m[4] + 4, +m[5]) : null; }
const num = x => (x == null ? NaN : Number(x));
const dol = x => { const n = num(x); return n > 1 ? n / 100 : n; };
// Kalshi taker fee per order: ceil to the cent of mult * 0.07 * n * p * (1-p)
const fee = (n, p, mult) => Math.ceil(mult * 0.07 * n * p * (1 - p) * 100 - 1e-9) / 100;
async function asks(ticker) {
  const { data } = await http.get(`${K}/markets/${ticker}/orderbook`, { params: { depth: 30 } });
  const ob = data?.orderbook_fp || data?.orderbook || {};
  const no = ob.no_dollars || ob.no || [];
  return no.map(([p, q]) => ({ p: Math.round((1 - dol(p)) * 1e4) / 1e4, q: Number(q) })).filter(l => l.q > 0 && l.p > 0 && l.p < 1).sort((a, b) => a.p - b.p);
}
// walk both books one contract-step at a time; best total profit over fill size
function fill(bA, bB, mult) {
  let i = 0, j = 0, la = bA[0]?.q || 0, lb = bB[0]?.q || 0, n = 0, costA = 0, costB = 0, best = { n: 0, profit: 0, cost: 0 };
  const legsA = [], legsB = [];
  while (i < bA.length && j < bB.length) {
    const pa = bA[i].p, pb = bB[j].p;
    if (pa + pb >= 1) break;
    const take = Math.min(la, lb);
    n += take; costA += take * pa; costB += take * pb;
    // fees charged per price level (separate fills)
    legsA.push([take, pa]); legsB.push([take, pb]);
    const fees = [...legsA.map(([q, p]) => fee(q, p, mult)), ...legsB.map(([q, p]) => fee(q, p, mult))].reduce((s, x) => s + x, 0);
    const profit = n - costA - costB - fees;
    if (profit > best.profit) best = { n, profit: Math.round(profit * 100) / 100, cost: Math.round((costA + costB + fees) * 100) / 100, pa, pb };
    la -= take; lb -= take;
    if (la <= 0) { i++; la = bA[i]?.q || 0; }
    if (lb <= 0) { j++; lb = bB[j]?.q || 0; }
  }
  return best;
}
(async () => {
  const t0 = Date.now(); const mult = {}; const seen = new Map(); const cycles = []; const ties = {};
  const ruleNotes = {};
  for (const s of SERIES) { try { const { data } = await http.get(`${K}/series/${s}`); mult[s] = Number(data?.series?.fee_multiplier ?? 1) || 1; } catch { mult[s] = 1; } }
  console.log('fee mult', JSON.stringify(mult));
  const save = () => {
    const arbs = [...seen.values()].sort((a, b) => b.maxProfit - a.maxProfit);
    fs.writeFileSync('esarb-out.json', JSON.stringify({ started: new Date(t0).toISOString(), now: new Date().toISOString(), cycles: cycles.length, mult, ties, arbs, cycleLog: cycles }, null, 1));
  };
  while (Date.now() - t0 < DUR) {
    const c0 = Date.now(); const cyc = { t: new Date().toISOString(), events: 0, two: 0, pre: 0, live: 0, screenNear: 0, booksRead: 0, fillable: 0, err: 0, hist: {} };
    for (const s of SERIES) {
      let cursor = null;
      for (let pg = 0; pg < 5; pg++) {
        let data;
        try { ({ data } = await http.get(`${K}/events`, { params: { series_ticker: s, status: 'open', limit: 200, with_nested_markets: true, cursor } })); } catch (e) { cyc.err++; break; }
        for (const e of data?.events || []) {
          cyc.events++;
          const ms = (e.markets || []).filter(m => m.status === 'active' || m.status === 'open');
          if (ms.length !== 2) { if (ms.length > 2) ties[e.event_ticker] = ms.map(m => m.yes_sub_title).join(' / '); continue; }
          cyc.two++;
          const st = startOf(e.event_ticker); const live = st != null && Date.now() >= st;
          live ? cyc.live++ : cyc.pre++;
          const [a, b] = ms; const pa = dol(a.yes_ask_dollars ?? a.yes_ask), pb = dol(b.yes_ask_dollars ?? b.yes_ask);
          if (!(pa > 0 && pb > 0 && pa < 1 && pb < 1)) continue;
          const allIn = pa + pb + 0.07 * mult[s] * (pa * (1 - pa) + pb * (1 - pb));
          const bk = Math.round((allIn - 1) * 100); cyc.hist[bk] = (cyc.hist[bk] || 0) + 1;
          if (pa + pb >= 1.0) continue;
          cyc.screenNear++;
          let A, B; try { [A, B] = await Promise.all([asks(a.ticker), asks(b.ticker)]); cyc.booksRead++; } catch { cyc.err++; continue; }
          const f = fill(A, B, mult[s]);
          const key = e.event_ticker;
          const r = seen.get(key) || { event: key, title: e.title, series: s, start: st ? new Date(st).toISOString() : null, firstSeen: cyc.t, lastSeen: cyc.t, cyclesSeen: 0, cyclesFillable: 0, maxProfit: 0, maxN: 0, samples: [] };
          r.lastSeen = cyc.t; r.cyclesSeen++;
          if (f.profit > 0) { r.cyclesFillable++; cyc.fillable++; r.lastFillable = cyc.t; if (!r.firstFillable) r.firstFillable = cyc.t; }
          r.maxProfit = Math.max(r.maxProfit, f.profit); r.maxN = Math.max(r.maxN, f.n);
          if (r.samples.length < 40) r.samples.push({ t: cyc.t, live, screen: [pa, pb], topA: A.slice(0, 3), topB: B.slice(0, 3), fill: f, volA: a.volume_fp ?? a.volume, volB: b.volume_fp ?? b.volume });
          seen.set(key, r);
        }
        cursor = data?.cursor; if (!cursor) break;
      }
    }
    cycles.push(cyc);
    console.log(cyc.t.slice(11, 19), `ev ${cyc.events} two ${cyc.two} pre ${cyc.pre} live ${cyc.live} near ${cyc.screenNear} books ${cyc.booksRead} fillable ${cyc.fillable} err ${cyc.err} took ${Math.round((Date.now() - c0) / 1000)}s`);
    if (cycles.length % 3 === 1) save();
    await sleep(Math.max(1000, EVERY - (Date.now() - c0)));
  }
  save();
  const arbs = [...seen.values()];
  console.log('\nSUMMARY events with screen sum<1:', arbs.length, 'ever fillable:', arbs.filter(a => a.maxProfit > 0).length);
  for (const a of arbs.sort((x, y) => y.maxProfit - x.maxProfit).slice(0, 40)) console.log(a.event, a.series, 'start', a.start, 'seen', a.cyclesSeen, 'fillable', a.cyclesFillable, 'maxN', a.maxN, 'max$', a.maxProfit, a.firstFillable, '->', a.lastFillable);
})();
