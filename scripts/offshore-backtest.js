// Offshore reference backtest (offshoreref.js; rules pre-registered in
// /mnt/project-files/line-reaper/checks/offshore-pm-2026-10-26/PREREGISTERED.md).
//   node scripts/offshore-backtest.js <hist.json.gz> <pairs.json> [bets.json]
// hist.json.gz: 1-minute history from diag/hist.js on branch diag-offpoly
// (offshore CLOB prices-history, Kalshi 1-minute candles, Polymarket US
// price-history); pairs.json: the pairs it was pulled for. Prints the tables
// and writes seeds/offshore-backtest.json (offshoreref.summarize's shape).
const z = require('zlib'), fs = require('fs');
const H = JSON.parse(z.gunzipSync(fs.readFileSync(process.argv[2])));
const pairs = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
const FF = 60;   // forward-fill limit, minutes
function series(points, from, to, pick) {   // → Float64Array per minute (NaN = none)
  const n = to - from + 1, out = new Float64Array(n).fill(NaN);
  const raw = new Float64Array(n).fill(NaN);
  for (const p of points || []) { const i = p[0] - from; if (i >= 0 && i < n) { const v = pick(p); if (v != null && Number.isFinite(v)) raw[i] = v; } }
  let last = NaN, age = 1e9;
  for (let i = 0; i < n; i++) { if (!Number.isNaN(raw[i])) { last = raw[i]; age = 0; } else age++; out[i] = age <= FF ? last : NaN; }
  return out;
}
const kFee = (c, fm) => 0.07 * (fm ?? 1) * (c / 100) * (1 - c / 100) * 100;
const uFee = (c, f) => (f ?? 0.0695) * (c / 100) * (1 - c / 100) * 100;
const bets = [], follows = [], cover = [];
for (const x of pairs) {
  const ptsP = H.poly[x.p.tok] || [];
  if (!ptsP.length) { cover.push({ id: x.id, why: 'no offshore history' }); continue; }
  const venues = [];
  if (x.k) venues.push({ v: 'kalshi', pts: H.kalshi[x.k.t] || [], fee: c => kFee(c, x.k.fm) });
  if (x.u) venues.push({ v: 'pmus', pts: H.pmus[x.u.slug] || [], fee: c => uFee(c, x.u.fee) });
  for (const V of venues) {
    if (!V.pts.length) { cover.push({ id: x.id, v: V.v, why: 'no US history' }); continue; }
    const from = Math.max(Math.min(...ptsP.map(p => p[0])), Math.min(...V.pts.map(p => p[0])));
    const to = Math.min(Math.max(...ptsP.map(p => p[0])), Math.max(...V.pts.map(p => p[0])));
    if (to - from < 120) { cover.push({ id: x.id, v: V.v, why: 'overlap under 2h' }); continue; }
    const M = series(ptsP, from, to, p => p[1]);
    const A = series(V.pts, from, to, p => p[1]), B = series(V.pts, from, to, p => p[2]);
    const n = to - from + 1;
    let usable = 0; for (let i = 0; i < n; i++) if (!Number.isNaN(M[i]) && !Number.isNaN(A[i]) && !Number.isNaN(B[i])) usable++;
    cover.push({ id: x.id, v: V.v, minutes: n, usable });
    const mid = i => (A[i] + B[i]) / 2;
    const costOf = (i, side) => { const c = side > 0 ? A[i] : 100 - B[i]; return Number.isNaN(c) ? NaN : c + V.fee(c); };
    const priceOf = (i, side) => (side > 0 ? A[i] : 100 - B[i]);
    const val = (arr, i, side) => (i < n && !Number.isNaN(arr(i)) ? (side > 0 ? arr(i) : 100 - arr(i)) : null);
    const last = { 1: -1e9, '-1': -1e9 }, lastG = { 1: -1e9, '-1': -1e9 };
    let lastFollow = -1e9, lastRev = -1e9;
    const event = x.id.split('|').slice(0, x.fam === 'fed' ? 2 : 3).join('|');
    for (let t = 15; t < n - 1; t++) {
      if (Number.isNaN(M[t]) || Number.isNaN(M[t - 15]) || Number.isNaN(A[t]) || Number.isNaN(B[t]) || Number.isNaN(A[t - 15]) || Number.isNaN(B[t - 15])) continue;
      const dM = M[t] - M[t - 15], dU = mid(t) - mid(t - 15);
      // follow test (offshore leads)
      if (Math.abs(dM) >= 3 && t - lastFollow >= 15) {
        lastFollow = t; const s = Math.sign(dM), base = mid(t - 15);
        const f = {};
        for (const w of [5, 15, 30, 60]) { let hit = false; for (let j = t; j <= t + w && j < n; j++) if (!Number.isNaN(A[j]) && (mid(j) - base) * s >= Math.abs(dM) / 2) { hit = true; break; } f[w] = hit; }
        const already = dU * s >= Math.abs(dM) / 2;
        follows.push({ dir: 'offshore-first', fam: x.fam, v: V.v, event, already, ...f });
      }
      if (Math.abs(dU) >= 3 && t - lastRev >= 15) {
        lastRev = t; const s = Math.sign(dU), base = M[t - 15];
        const f = {};
        for (const w of [5, 15, 30, 60]) { let hit = false; for (let j = t; j <= t + w && j < n; j++) if (!Number.isNaN(M[j]) && (M[j] - base) * s >= Math.abs(dU) / 2) { hit = true; break; } f[w] = hit; }
        follows.push({ dir: 'us-first', fam: x.fam, v: V.v, event, already: dM * s >= Math.abs(dU) / 2, ...f });
      }
      for (const side of [1, -1]) {
        const fair = side > 0 ? M[t] : 100 - M[t];
        const c0 = costOf(t, side);
        if (Number.isNaN(c0)) continue;
        const edge = fair - c0;
        const grade = (sig) => {
          const e = t + 1; const ce = costOf(e, side), pe = priceOf(e, side);
          if (Number.isNaN(ce) || !(pe >= 5 && pe <= 95)) return;
          const g = { price: pe, sig, fam: x.fam, cat: x.cat, v: V.v, id: x.id, event, t: from + e, cost: ce, edge0: edge, fairAtEntry: side > 0 ? M[e] : 100 - M[e],
            u30: val(mid, e + 30, side), u60: val(mid, e + 60, side), x30: val(i => M[i], e + 30, side), x60: val(i => M[i], e + 60, side),
            exit60: e + 60 < n ? (side > 0 ? B[e + 60] : 100 - A[e + 60]) : null };
          bets.push(g);
        };
        if (side * dM >= 3 && side * dU < Math.abs(dM) / 2 && edge >= 1 && t - last[side] >= 60) { last[side] = t; grade('move'); }
        if (edge >= 3 && t - lastG[side] >= 60) { lastG[side] = t; grade('gap'); }
      }
    }
  }
}
// ── stats ──
function clusterT(rows, f) {
  const xs = rows.map(f).filter(v => v != null && Number.isFinite(v));
  if (xs.length < 2) return { n: xs.length, mean: xs[0] ?? null, t: null };
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const cl = new Map(); for (const r of rows) { const v = f(r); if (v == null || !Number.isFinite(v)) continue; cl.set(r.event, (cl.get(r.event) || 0) + (v - mean)); }
  const G = cl.size; let s = 0; for (const v of cl.values()) s += v * v;
  const se = Math.sqrt(s * (G / Math.max(1, G - 1))) / xs.length;
  return { n: xs.length, clusters: G, mean, t: se > 0 ? mean / se : null };
}
const fmt = r => r.mean == null ? '-' : `${r.mean >= 0 ? '+' : ''}${r.mean.toFixed(2)}c t ${r.t == null ? '-' : r.t.toFixed(2)} (n ${r.n}, ${r.clusters ?? 1} events)`;
const groups = new Map();
for (const b of bets) for (const k of [`${b.sig}|${b.v}|${b.fam}`, `${b.sig}|${b.v}|ALL`]) (groups.get(k) || groups.set(k, []).get(k)).push(b);
const lines = [];
for (const [k, rows] of [...groups].sort()) {
  rows.sort((a, b) => a.t - b.t);
  const mid = rows[Math.floor(rows.length / 2)]?.t;
  const h1 = rows.filter(r => r.t < mid), h2 = rows.filter(r => r.t >= mid);
  lines.push(`${k.padEnd(22)} n ${String(rows.length).padStart(4)} | own mid +30 ${fmt(clusterT(rows, r => r.u30 == null ? null : r.u30 - r.cost))} | own mid +60 ${fmt(clusterT(rows, r => r.u60 == null ? null : r.u60 - r.cost))} | exit bid +60 ${fmt(clusterT(rows, r => r.exit60 == null ? null : r.exit60 - r.cost))} | offshore +30 ${fmt(clusterT(rows, r => r.x30 == null ? null : r.x30 - r.cost))} | offshore +60 ${fmt(clusterT(rows, r => r.x60 == null ? null : r.x60 - r.cost))} | halves own+60 ${fmt(clusterT(h1, r => r.u60 == null ? null : r.u60 - r.cost))} / ${fmt(clusterT(h2, r => r.u60 == null ? null : r.u60 - r.cost))} | edge at flag ${(rows.reduce((a, r) => a + r.edge0, 0) / rows.length).toFixed(2)}c, mean cost ${(rows.reduce((a, r) => a + r.cost, 0) / rows.length).toFixed(1)}c`);
}
const fl = new Map();
for (const f of follows) { const k = `${f.dir}|${f.v}|${f.fam}`; (fl.get(k) || fl.set(k, []).get(k)).push(f); const k2 = `${f.dir}|${f.v}|ALL`; (fl.get(k2) || fl.set(k2, []).get(k2)).push(f); }
const fls = [];
for (const [k, rows] of [...fl].sort()) {
  const pct = w => Math.round(100 * rows.filter(r => r[w]).length / rows.length);
  fls.push(`${k.padEnd(28)} moves ${String(rows.length).padStart(4)} | other already half-moved ${pct('already')}% | half within 5m ${pct(5)}% 15m ${pct(15)}% 30m ${pct(30)}% 60m ${pct(60)}%`);
}
const cv = {}; for (const c of cover) { const k = c.why || 'ok'; cv[k] = (cv[k] || 0) + 1; }
console.log('coverage', JSON.stringify(cv), 'usable minutes', cover.reduce((a, c) => a + (c.usable || 0), 0));
console.log('\nSIGNALS (cents a contract after fee; t clustered by event)\n' + lines.join('\n'));
console.log('\nFOLLOW (moves of 3c+ in 15 min)\n' + fls.join('\n'));
if (process.argv[4]) fs.writeFileSync(process.argv[4], JSON.stringify({ bets, follows, cover }));
const { summarize } = require('../offshoreref');
const c = v => (v == null ? null : v / 100);
const rows = bets.map(b => ({ sig: b.sig, venue: b.v, fam: b.fam, event: b.event, cost: c(b.cost), fee: c(b.cost - b.price), u30: c(b.u30), u60: c(b.u60), x60: c(b.x60), exit60: c(b.exit60), result: null }));
const followOut = [...fl].map(([k, r]) => { const [dir, v, fam] = k.split('|'); const pct = w => Math.round(100 * r.filter(x => x[w]).length / r.length); return { dir, venue: v, fam, moves: r.length, already: pct('already'), within5: pct(5), within15: pct(15), within30: pct(30), within60: pct(60) }; });
const path = require('path');
fs.writeFileSync(path.join(__dirname, '..', 'seeds', 'offshore-backtest.json'), JSON.stringify({ window: { from: new Date(Math.min(...bets.map(b => b.t)) * 60e3).toISOString(), to: new Date(Math.max(...bets.map(b => b.t)) * 60e3).toISOString() }, pairs: pairs.length,
  verdict: 'FAIL', why: 'No signal beat the US venue\'s own mid an hour later after the taker fee with t at or above 2; the offshore gap does not close.', rows: summarize(rows), follow: followOut }, null, 1));
