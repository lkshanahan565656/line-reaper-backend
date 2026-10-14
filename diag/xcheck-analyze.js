// node diag/xcheck-analyze.js <dir with out/*.gz>
const fs = require('fs'), zlib = require('zlib'), path = require('path');
const ev = require('../ev');
const dir = process.argv[2];
const rd = f => zlib.gunzipSync(fs.readFileSync(path.join(dir, f))).toString();
const keys = JSON.parse(rd('keys.json.gz'));
const cycles = rd('quotes.jsonl.gz').trim().split('\n').map(l => JSON.parse(l));
const K = keys.map(k => { const p = k.split('|'); const book = p.pop(), side = p.pop(); return { group: p.join('|'), side, book }; });
const prob = a => (a > 0 ? 100 / (a + 100) : -a / (-a + 100));
const dec = a => (a > 0 ? 1 + a / 100 : 1 + 100 / -a);
const med = xs => { const s = xs.slice().sort((a, b) => a - b); return s.length ? s[s.length >> 1] : null; };
const pct = (xs, q) => { const s = xs.slice().sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : null; };
const isFdAn = b => /^fanduel_an/.test(b), isBrAn = b => /^betrivers_an/.test(b);
const RELAYED = new Set(['draftkings', 'betmgm', 'caesars', 'bet365', 'fanatics', 'hardrock', 'thescore']);
const out = {};

// state per cycle: Map id -> price
const states = [];
let st = new Map();
for (const c of cycles) {
  st = new Map(st);
  for (const id of c.rm || []) st.delete(id);
  for (const [id, p] of c.ch) st.set(id, p);
  states.push(st);
}
out.cycles = cycles.length;
out.span = [new Date(cycles[0].stamp.pin).toISOString(), new Date(cycles.at(-1).stamp.end).toISOString()];
const startOf = {};
for (const c of cycles) if (c.starts) for (const [id, t] of Object.entries(c.starts)) startOf[id] = Date.parse(t);
// event start from group: eventId = away@home|day; need start: build from quotes? use pinnacle game start not in key -> approximate via starts map keyed by pin id, unknown. Use day only.

// index by group|side -> {book: id}
const bySide = new Map();
K.forEach((k, id) => { const gs = `${k.group}|${k.side}`; if (!bySide.has(gs)) bySide.set(gs, {}); bySide.get(gs)[k.book] = id; });
const anIds = [...new Set(K.map(k => k.book).filter(b => isFdAn(b) || isBrAn(b)))];
out.anBooks = anIds;
const bookCounts = {};
for (const [id] of states.at(-1)) bookCounts[K[id].book] = (bookCounts[K[id].book] || 0) + 1;
out.lastCycleQuotesByBook = bookCounts;

// ── 1. direct vs Action Network copy ──
const kindOf = g => { const p = g.split('|'); const m = p[2]; return m === 'h2h' || m === 'spreads' || m === 'totals' ? m : 'prop'; };
out.copy = {};
for (const [direct, test] of [['fanduel', isFdAn], ['betrivers', isBrAn]]) {
  for (const anb of anIds.filter(test)) {
    const r = { obs: 0, same: 0, gaps: [], byKind: {}, lags: [], neverCaught: 0, directMoves: 0, anFirst: 0, sameLineGames: 0 };
    for (const [gs, books] of bySide) {
      if (books[direct] == null || books[anb] == null) continue;
      const kd = kindOf(gs);
      r.byKind[kd] = r.byKind[kd] || { obs: 0, same: 0 };
      let prevD = null;
      for (let c = 0; c < states.length; c++) {
        const d = states[c].get(books[direct]), a = states[c].get(books[anb]);
        if (d == null || a == null) { prevD = d ?? null; continue; }
        r.obs++; r.byKind[kd].obs++;
        if (d === a) { r.same++; r.byKind[kd].same++; } else r.gaps.push(Math.abs(prob(d) - prob(a)) * 100);
        if (prevD != null && d !== prevD) {
          r.directMoves++;
          // when does the copy show the new price
          let hit = null;
          for (let c2 = c; c2 < states.length; c2++) {
            const a2 = states[c2].get(books[anb]), d2 = states[c2].get(books[direct]);
            if (a2 === d) { hit = c2; break; }
            if (d2 !== d) break;   // moved again before the copy caught up
          }
          // copy already had it before the direct read moved?
          if (hit === c && states[c - 1]?.get(books[anb]) === d) r.anFirst++;
          if (hit == null) r.neverCaught++;
          else r.lags.push((cycles[hit].stamp.an - cycles[c].stamp.fd) / 60e3);
        }
        prevD = d;
      }
    }
    out.copy[anb] = { obs: r.obs, sameShare: +(r.same / r.obs).toFixed(3), medGapPts: +(med(r.gaps) || 0).toFixed(2), p90GapPts: +(pct(r.gaps, 0.9) || 0).toFixed(2),
      byKind: Object.fromEntries(Object.entries(r.byKind).map(([k, v]) => [k, { obs: v.obs, same: +(v.same / v.obs).toFixed(3) }])),
      directMoves: r.directMoves, caught: r.lags.length, copyAlreadyHadIt: r.anFirst, neverCaughtBeforeNextMove: r.neverCaught,
      lagMin: { p25: pct(r.lags, 0.25)?.toFixed(1), med: med(r.lags)?.toFixed(1), p75: pct(r.lags, 0.75)?.toFixed(1), p90: pct(r.lags, 0.9)?.toFixed(1), max: Math.max(...r.lags).toFixed(1) } };
  }
}
// main line agreement (same game, which point is the main one)
out.mainLine = {};
for (const [direct, test] of [['fanduel', isFdAn], ['betrivers', isBrAn]]) for (const anb of anIds.filter(test)) {
  let both = 0, samePt = 0;
  const last = states.at(-1);
  const pts = book => { const m = new Map(); for (const [id] of last) { const k = K[id]; if (k.book !== book) continue; const p = k.group.split('|'); if (p[2] !== 'spreads' && p[2] !== 'totals') continue; const gk = `${p[0]}|${p[1]}|${p[2]}`; if (!m.has(gk)) m.set(gk, new Set()); m.get(gk).add(p[3]); } return m; };
  const D = pts(direct), A = pts(anb);
  for (const [gk, s] of A) if (D.has(gk)) { both++; if ([...s].some(x => D.get(gk).has(x))) samePt++; }
  out.mainLine[anb] = { gameMarkets: both, sameMainPoint: samePt };
}

// ── 1b. would a +EV play on the copy have been there at the book? ──
// fair = Pinnacle (+ Matchbook 0.6) at that cycle, as ev.fairForGroup
const groupsByCycle = c => { const m = new Map(); for (const [id, p] of states[c]) { const k = K[id]; if (!m.has(k.group)) m.set(k.group, []); m.get(k.group).push({ side: k.side, book: k.book, price: p }); } return m; };
const playStats = {};
const relayedAge = [];
for (let c = 0; c < states.length; c++) {
  const G = groupsByCycle(c);
  for (const [g, qs] of G) {
    const f = ev.fairForGroup(qs.filter(q => q.book === 'pinnacle' || q.book === 'matchbook'));
    if (!f || f.source !== 'sharp') continue;
    for (const q of qs) {
      if (!(isFdAn(q.book) || isBrAn(q.book))) continue;
      const e = (f.fair[q.side] * dec(q.price) - 1) * 100;
      if (e < 2) continue;
      const direct = isFdAn(q.book) ? 'fanduel' : 'betrivers';
      const dq = qs.find(x => x.book === direct && x.side === q.side);
      const s = playStats[q.book] = playStats[q.book] || { plays: 0, directHasLine: 0, directSamePrice: 0, directStill2: 0, directPositive: 0, directEv: [] };
      s.plays++;
      if (dq) { s.directHasLine++; if (dq.price === q.price) s.directSamePrice++; const de = (f.fair[q.side] * dec(dq.price) - 1) * 100; s.directEv.push(de); if (de >= 2) s.directStill2++; if (de > 0) s.directPositive++; }
    }
  }
}
for (const s of Object.values(playStats)) { s.medDirectEv = +(med(s.directEv) || 0).toFixed(2); delete s.directEv; }
out.copyPlaysAtBook = playStats;

// ── 3. Matchbook vs Pinnacle ──
{
  const last = groupsByCycle(states.length - 1);
  const gaps = [], byKind = {};
  for (const [g, qs] of last) {
    const pin = qs.filter(q => q.book === 'pinnacle'), mb = qs.filter(q => q.book === 'matchbook');
    if (pin.length !== 2 || mb.length !== 2) continue;
    const sides = pin.map(q => q.side);
    if (!sides.every(s => mb.find(q => q.side === s))) continue;
    const nv = qsb => { const d = sides.map(s => dec(qsb.find(q => q.side === s).price)); return ev.devig(d)[0]; };
    const gap = Math.abs(nv(pin) - nv(mb)) * 100;
    gaps.push(gap);
    const k = kindOf(g); (byKind[k] = byKind[k] || []).push(gap);
  }
  out.matchbookVsPin = { pairs: gaps.length, medGapPts: +(med(gaps) || 0).toFixed(2), within1: +(gaps.filter(x => x <= 1).length / gaps.length).toFixed(3), within2: +(gaps.filter(x => x <= 2).length / gaps.length).toFixed(3), over5: gaps.filter(x => x > 5).length,
    byKind: Object.fromEntries(Object.entries(byKind).map(([k, v]) => [k, { n: v.length, med: +med(v).toFixed(2), within1: +(v.filter(x => x <= 1).length / v.length).toFixed(3) }])) };
  // who moves first: per group|side, change cycles of each
  let pinThenMb = 0, mbThenPin = 0, together = 0, pinAlone = 0, mbAlone = 0;
  for (const [gs, books] of bySide) {
    if (books.pinnacle == null || books.matchbook == null) continue;
    const moves = id => { const out = []; for (let c = 1; c < states.length; c++) { const a = states[c - 1].get(id), b = states[c].get(id); if (a != null && b != null && a !== b) out.push(c); } return out; };
    const P = moves(books.pinnacle), M = moves(books.matchbook);
    for (const c of P) { if (M.includes(c)) together++; else if (M.some(m => m > c && m <= c + 3)) pinThenMb++; else pinAlone++; }
    for (const c of M) { if (P.includes(c)) continue; if (P.some(p => p > c && p <= c + 3)) mbThenPin++; else mbAlone++; }
  }
  out.matchbookMoves = { sameMinute: together, pinFirstMbWithin3: pinThenMb, mbFirstPinWithin3: mbThenPin, pinMovedMbDidnt: pinAlone, mbMovedPinDidnt: mbAlone };
}
// Matchbook depth at the best back on main markets
try {
  const mb = rd('matchbook.jsonl.gz').trim().split('\n').map(l => JSON.parse(l));
  const lastMb = mb.at(-1);
  const depth = [], vol = [];
  for (const m of lastMb.m) {
    if (!/^(moneyline|handicap|total)$/i.test(m.mk)) continue;
    if (m.vol != null) vol.push(m.vol);
    for (const r of m.runners) { const b = r.p.filter(p => p[0] === 'back' || p[0] === 'win').sort((x, y) => y[1] - x[1])[0]; if (b) depth.push(b[2]); }
  }
  out.matchbookDepth = { runners: depth.length, medBestBack$: med(depth), p25: pct(depth, 0.25), p75: pct(depth, 0.75), under100: depth.filter(x => x < 100).length, over1000: depth.filter(x => x >= 1000).length, medMarketVolume: med(vol) };
} catch (e) { out.matchbookDepth = e.message; }

// ── 2. production rows ──
try {
  const prod = rd('prod.jsonl.gz').trim().split('\n').map(l => JSON.parse(l));
  out.prodSnapshots = prod.length;
  out.prodCounts = prod.map(p => ({ t: new Date(p.t).toISOString().slice(11, 16), ...p.counts, rows: p.rows.length }));
  const pick = prod.at(-1);
  const clear = pick.rows.filter(r => !r.dfs && r.ev >= 2);
  const tally = f => { const m = {}; for (const r of clear) { const k = f(r); m[k] = (m[k] || 0) + 1; } return m; };
  const mk = r => (r.player ? 'prop' : r.market);
  const src = r => { const s = (r.sharpBooks || []).slice().sort().join('+'); return s || r.source; };
  out.prodLast = { at: new Date(pick.t).toISOString(), clear2: clear.length, byBook: tally(r => r.book), byMarket: tally(mk), bySource: tally(src), bySport: tally(r => r.sport), agree: clear.filter(r => r.agree).length };
  // all distinct clear rows across snapshots
  const seen = new Map();
  for (const p of prod) for (const r of p.rows) if (!r.dfs && r.ev >= 2) { const k = `${r.group}|${r.side}|${r.book}`; if (!seen.has(k)) seen.set(k, { ...r, firstT: p.t, n: 0 }); seen.get(k).n++; seen.get(k).lastT = p.t; seen.get(k).lastEv = r.ev; }
  out.prodDistinct = { n: seen.size };
  fs.writeFileSync(path.join(dir, 'prod-distinct.json'), JSON.stringify([...seen.values()]));
  // check each distinct row against our own recorded quotes at the nearest cycle
  const nearest = t => { let b = 0; for (let c = 0; c < cycles.length; c++) if (Math.abs(cycles[c].stamp.end - t) < Math.abs(cycles[b].stamp.end - t)) b = c; return b; };
  const checks = [];
  for (const r of [...seen.values()].filter(r => r.lastT === pick.t)) {
    const c = nearest(pick.t);
    const G = groupsByCycle(c);
    const qs = G.get(r.group) || [];
    const mine = qs.find(q => q.book === r.book && q.side === r.side);
    const f = ev.fairForGroup(qs.filter(q => q.book === 'pinnacle' || q.book === 'matchbook'));
    const myEv = f && mine && f.fair[r.side] != null ? (f.fair[r.side] * dec(mine.price) - 1) * 100 : null;
    // Pinnacle moved in the 10 minutes before?
    const pinId = bySide.get(`${r.group}|${r.side}`)?.pinnacle;
    let pinMovedMin = null;
    if (pinId != null) for (let c2 = c; c2 > 0 && cycles[c].stamp.end - cycles[c2].stamp.end < 15 * 60e3; c2--) if (states[c2].get(pinId) !== states[c2 - 1].get(pinId)) { pinMovedMin = +((cycles[c].stamp.end - cycles[c2].stamp.pin) / 60e3).toFixed(1); break; }
    checks.push({ book: r.book, sport: r.sport, event: r.event, market: mk(r), player: r.player, point: r.point, side: r.side, price: r.price, prodEv: r.ev, fairProb: r.fairProb, sharp: src(r), agree: r.agree, srcP: r.srcP,
      myPrice: mine?.price ?? null, myEv: myEv == null ? null : +myEv.toFixed(2), pin: qs.filter(q => q.book === 'pinnacle').map(q => `${q.side} ${q.price}`).join(', '), mb: qs.filter(q => q.book === 'matchbook').map(q => `${q.side} ${q.price}`).join(', '),
      others: (r.others || []).slice(0, 6).map(o => `${o.book} ${o.price}`).join(', '), pinMovedMinAgo: pinMovedMin, seenSnapshots: seen.get(`${r.group}|${r.side}|${r.book}`).n });
  }
  checks.sort((a, b) => b.prodEv - a.prodEv);
  fs.writeFileSync(path.join(dir, 'prod-checks.json'), JSON.stringify(checks, null, 1));
  out.prodChecked = { n: checks.length, priceMatchesOurRead: checks.filter(x => x.myPrice === x.price).length, ourEvStill2: checks.filter(x => x.myEv >= 2).length, pinMovedWithin10: checks.filter(x => x.pinMovedMinAgo != null && x.pinMovedMinAgo <= 10).length };
} catch (e) { out.prodErr = e.stack; }
console.log(JSON.stringify(out, null, 1));
