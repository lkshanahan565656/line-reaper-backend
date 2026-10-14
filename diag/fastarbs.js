// Fast arb census: every EVERY_S seconds for DUR_MIN minutes, read Kalshi's
// sports game/spread/total series and Polymarket US's leagues, then count
//  - cross: same bet on both venues (findUsArbs pairs), all-in after taker fees
//  - ladder: one venue (or both) where buying "above t1" + "below t2" (t1 <= t2)
//    pays at least $1 whatever happens (moneyline vs spread, spread rungs, total rungs)
// For anything that clears (or comes within 1%) the live books are read for
// depth: contracts fillable while the pair still costs under $1 all-in.
// Each arb is followed across cycles (first/last seen) for how long it lasts.
const APP = process.env.APP || require('path').resolve(__dirname, '..');
const axios = require('axios');
const xarb = require(APP + '/xarb');
const pmus = require(APP + '/pmus');
const DUR = Number(process.env.DUR_MIN || 50) * 60e3, EVERY = Number(process.env.EVERY_S || 20) * 1e3;
const http = axios.create({ timeout: 15000, headers: { 'user-agent': 'line-reaper-diag' } });
const K = 'https://api.elections.kalshi.com/trade-api/v2';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const r4 = x => Math.round(x * 1e4) / 1e4;
const kFee = p => 0.07 * p * (1 - p), uFee = (p, rate = 0.0695) => rate * p * (1 - p);
const feeOf = (venue, p, rate) => (venue === 'kalshi' ? kFee(p) : uFee(p, rate));
async function pool(items, n, fn) { const out = []; let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const j = i++; out[j] = await fn(items[j]).catch(e => ({ error: e.message })); } })); return out; }

const norm = s => String(s || '').trim().toLowerCase();
// one venue's rows → ladder events per game: { subject, t, above: {price, leg}, below: {price, leg} }
function ladderEvents(rows) {
  const games = new Map();
  for (const r of rows) {
    if (!r.tradable) continue;
    const g = r.exchange === 'kalshi' ? r.gameKey : r.gameSlug;
    if (!g) continue;
    if (!games.has(g)) games.set(g, []);
    games.get(g).push(r);
  }
  const out = [];
  for (const [g, rs] of games) {
    const ml = rs.filter(r => r.kind === 'teams');
    const teams = [...new Set(ml.flatMap(r => [r.outcomeLabel, r.noLabel]).filter(Boolean))].slice(0, 2);
    const teamIx = name => {
      const exact = teams.findIndex(t => norm(t) === norm(name));
      if (exact >= 0) return exact;
      const fuzzy = teams.map((t, i) => (xarb.nameMatch(t, name) ? i : -1)).filter(i => i >= 0);
      return fuzzy.length === 1 ? fuzzy[0] : -2;
    };
    const ev = [];
    const add = (r, subject, t, flip) => {
      const yes = { price: r.yesAsk, side: 'yes' }, no = { price: r.noAsk, side: 'no' };
      const [above, below] = flip ? [no, yes] : [yes, no];
      ev.push({ game: g, row: r, subject, t, above, below });
    };
    for (const r of rs) {
      if (r.kind === 'total') add(r, 'total', r.line, false);
      else if (r.kind === 'spread' || r.kind === 'teams') {
        const team = r.kind === 'spread' ? r.lineTeam : r.outcomeLabel;
        const t = r.kind === 'spread' ? r.line : 0.5;
        const i = teamIx(team);
        if (i === 1 && (r.kind === 'spread' || r.noLabel)) add(r, 'margin:' + teams[0], -t, true);   // B by > t == not(A margin > -t)
        else if (i === 0) add(r, 'margin:' + teams[0], t, false);
        else if (i === -1) add(r, 'margin:' + team, t, false);   // no moneyline in this game: its own ladder
        // a two-way moneyline row is also the other team's (no draw): A wins == not(B wins)
      }
    }
    out.push(...ev);
  }
  return out;
}
function ladderArbs(events, nearPct = 1) {
  const by = new Map();
  for (const e of events) { const k = e.game + '|' + e.subject; if (!by.has(k)) by.set(k, []); by.get(k).push(e); }
  const out = [];
  for (const list of by.values()) {
    for (const a of list) for (const b of list) {
      if (a.row.id === b.row.id || !(a.t <= b.t)) continue;
      const pa = a.above.price, pb = b.below.price;
      if (!(pa > 0.01 && pa < 0.99 && pb > 0.01 && pb < 0.99)) continue;
      const cost = pa + feeOf(a.row.exchange, pa, a.row.feeSchedule?.rate) + pb + feeOf(b.row.exchange, pb, b.row.feeSchedule?.rate);
      const pct = (1 - cost) / cost * 100;
      if (pct < -nearPct) continue;
      out.push({ type: 'ladder', venue: a.row.exchange, title: a.row.eventTitle || a.row.title, subject: a.subject, startTime: a.row.startTime || b.row.startTime,
        legs: [{ venue: a.row.exchange, id: a.row.id, side: a.above.side, price: pa, t: a.t, row: a.row }, { venue: b.row.exchange, id: b.row.id, side: b.below.side, price: pb, t: b.t, row: b.row }],
        cost: r4(cost), pct: r4(pct), middle: a.t < b.t });
    }
  }
  return out;
}

// ── books: ask ladders for a leg [{p, q}] best first ──
async function kalshiAsks(ticker, side) {
  const { data } = await http.get(`${K}/markets/${ticker}/orderbook`, { params: { depth: 20 } });
  const ob = data?.orderbook || data?.orderbook_fp || {};
  // buying YES lifts NO bids (price 1 - noBid); levels [price, qty], cents or dollars
  const opp = side === 'yes' ? (ob.no_dollars || ob.no) : (ob.yes_dollars || ob.yes);
  const lv = (opp || []).map(([p, q]) => { const d = Number(p) > 1 ? Number(p) / 100 : Number(p); return { p: r4(1 - d), q: Number(q) }; });
  return lv.filter(l => l.p > 0 && l.p < 1 && l.q > 0).sort((a, b) => a.p - b.p);
}
async function usAsks(slug, side, yesSide) {
  const { data } = await http.get(`${pmus.GATEWAY}/v1/markets/${encodeURIComponent(slug)}/book`, { timeout: 6000 });
  const d = data?.marketData || data || {};
  const px = l => Number(l?.px?.value ?? l?.px ?? l?.price?.value ?? l?.price);
  const longSide = side === 'yes' ? yesSide === 'long' : yesSide !== 'long';
  if (longSide) return (d.offers || []).map(l => ({ p: px(l), q: Number(l.qty) })).filter(l => l.p > 0 && l.p < 1 && l.q > 0).sort((a, b) => a.p - b.p);
  return (d.bids || []).map(l => ({ p: r4(1 - px(l)), q: Number(l.qty) })).filter(l => l.p > 0 && l.p < 1 && l.q > 0).sort((a, b) => a.p - b.p);
}
const asksOf = l => (l.venue === 'kalshi' ? kalshiAsks(l.id, l.side) : usAsks(l.id, l.side, l.row?.yesSide));
// walk every leg's book while one more set still costs under $1 all-in
function fill(books, legs) {
  const ix = books.map(() => 0), left = books.map(b => b[0]?.q || 0);
  let n = 0, spent = 0;
  while (books.every((b, k) => ix[k] < b.length)) {
    const c = books.reduce((s, b, k) => { const p = b[ix[k]].p; return s + p + feeOf(legs[k].venue, p, legs[k].row?.feeSchedule?.rate); }, 0);
    if (c >= 1) break;
    const take = Math.min(...left);
    n += take; spent += take * c;
    for (let k = 0; k < books.length; k++) { left[k] -= take; if (left[k] <= 0) { ix[k]++; left[k] = books[k][ix[k]]?.q || 0; } }
  }
  return { contracts: Math.floor(n), cost: Math.round(spent * 100) / 100, profit: Math.round((n - spent) * 100) / 100 };
}

(async () => {
  const t0 = Date.now();
  let series = [];
  try { series = await xarb.fetchKalshiGameSeries(http); } catch (e) { console.log('series list failed', e.message); }
  const roots = new Set(xarb.PRIORITY_ROOTS);
  const prio = series.filter(s => roots.has(s.replace(/(GAME|MATCH|FIGHT|TOTAL|SPREAD)$/, '')));
  const rest = series.filter(s => !prio.includes(s));
  console.log(`series ${series.length}, priority ${prio.length}`);
  const pm = pmus.createPolymarketUs({ http, eventTtlMs: 5000, bookTtlMs: 0, log: null });
  const kCache = new Map();   // series → rows
  const seen = new Map();     // arb key → tracking
  const cycles = [];
  const bestHist = {};        // bucket of each matched pair's best all-in %
  let rot = 0, cycle = 0, kErr = 0;
  while (Date.now() - t0 < DUR) {
    const c0 = Date.now(); cycle++; kErr = 0;
    const batch = [...prio, ...rest.slice(rot, rot + 25)]; rot = rest.length ? (rot + 25) % rest.length : 0;
    await pool(batch, 6, async s => { const rows = []; const r = await xarb.fetchKalshiEvents(http, { seriesTicker: s, maxPages: 3, onPage: p => rows.push(...xarb.parseKalshiBinaries(p)) }); if (r.errors.length) kErr++; else kCache.set(s, rows); });
    const kalshi = [...kCache.values()].flat();
    let us = [];
    try { us = await pm.arbRows({}); } catch (e) { console.log('pmus failed', e.message); }
    const now = Date.now();
    const o = { now, region: 'us' };
    const matches = xarb.matchMarkets(kalshi, us, o);
    const near = xarb.findNearArbs({ matches, rows: us }, { ...o, minPct: 1000, nearPct: 1000, nearMax: 1e6 });
    for (const a of near) { const b = Math.max(-10, Math.floor(a.profitPct)); bestHist[b] = (bestHist[b] || 0) + 1; }
    const cands = [];
    for (const a of near) if (a.profitPct > -1 && !(a.startTime && Date.parse(a.startTime) < now)) cands.push({ type: 'cross', title: a.title, pct: a.profitPct, cost: a.totalCost, startTime: a.startTime || null,
      legs: a.legs.map(l => ({ venue: l.venue, id: l.marketId, side: l.side, price: l.price, row: l.venue === 'kalshi' ? null : us.find(r => r.id === l.marketId) })) });
    const ladK = ladderArbs(ladderEvents(kalshi)), ladU = ladderArbs(ladderEvents(us));
    for (const a of [...ladK, ...ladU]) if (!(a.startTime && Date.parse(a.startTime) < now)) cands.push(a);
    let mid = [];
    try { mid = xarb.findMiddles(kalshi, us, matches, { ...o, middleMinEv: -1000, middleMaxEv: 1e9, middleMax: 1e6 }).filter(m => m.totalCost < 1.01); } catch (e) { console.log('middles', e.message); }
    for (const m of mid) cands.push({ type: 'xladder', title: m.title, pct: r4((1 - m.totalCost) / m.totalCost * 100), cost: m.totalCost, startTime: m.startTime, middle: true,
      legs: m.legs.map(l => ({ venue: l.venue, id: l.marketId, side: l.side, price: l.price, row: l.venue === 'kalshi' ? null : us.find(r => r.id === l.marketId) })) });
    // depth for the best 40 candidates
    cands.sort((a, b) => b.pct - a.pct);
    const deep = cands.slice(0, 40);
    await pool(deep, 6, async a => {
      const books = await Promise.all(a.legs.map(asksOf));
      a.depth = fill(books, a.legs);
      a.top = books.map(b => b[0] || null);
    });
    let live = 0;
    for (const a of deep) {
      if (!a.depth || a.depth.contracts <= 0) continue;
      live++;
      const key = a.type + '|' + a.legs.map(l => `${l.venue}:${l.id}:${l.side}`).join('+');
      const s = seen.get(key) || { key, type: a.type, title: a.title, subject: a.subject, middle: !!a.middle, first: now, last: now, cycles: 0, gaps: 0, bestPct: -99, bestContracts: 0, bestProfit: 0, startTime: a.startTime, legs: a.legs.map(l => `${l.venue} ${l.side} ${l.id} @${l.price}`), suspect: a.pct > 15 };
      if (s.lastCycle != null && s.lastCycle !== cycle - 1) s.gaps++;
      s.last = now; s.lastCycle = cycle; s.cycles++;
      s.bestPct = Math.max(s.bestPct, a.pct); s.bestContracts = Math.max(s.bestContracts, a.depth.contracts); s.bestProfit = Math.max(s.bestProfit, a.depth.profit);
      seen.set(key, s);
    }
    const row = { cycle, at: new Date(now).toISOString(), kalshiRows: kalshi.length, usRows: us.length, matches: matches.length, pairs: near.length,
      snapCross: cands.filter(a => a.type === 'cross' && a.pct > 0).length, snapLadder: cands.filter(a => a.type !== 'cross' && a.pct > 0).length, live, kalshiErrors: kErr, ms: Date.now() - c0 };
    cycles.push(row);
    console.log(JSON.stringify(row));
    const wait = EVERY - (Date.now() - c0);
    if (wait > 0) await sleep(wait);
  }
  const list = [...seen.values()].map(s => ({ ...s, lastedSec: Math.round((s.last - s.first) / 1000) })).sort((a, b) => b.bestProfit - a.bestProfit);
  console.log('\n=== best all-in % per matched pair, per cycle (floor bucket: count) ===');
  console.log(JSON.stringify(Object.fromEntries(Object.entries(bestHist).sort((a, b) => a[0] - b[0]))));
  console.log(`\n=== fillable arbs (book depth > 0): ${list.length} distinct ===`);
  for (const s of list.slice(0, 80)) console.log(JSON.stringify(s));
  require('fs').writeFileSync('fastarbs-out.json', JSON.stringify({ cycles, bestHist, arbs: list }, null, 1));
})();
