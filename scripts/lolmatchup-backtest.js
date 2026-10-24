#!/usr/bin/env node
// Walk-forward backtest of the LoL head-to-head engine (esmatchup.js).
//
//   node scripts/lolmatchup-backtest.js <kalshi-LOL.json.gz> [series.json.gz] [out.json]
//
// series: lolesports finished series (default seeds/lol-series.json.gz).
// kalshi: settled KXLOLGAME events with hourly (-48h..+1h) and minute
//         (-150..+15 min) candles [minute, yes ask, yes bid, volume, price],
//         from the diag-esh2h workflow (branch diag-esh2h-out-k-LOL).
//
// No leakage: ratings only ever see series that finished (start + 45 min a
// map) before the moment priced. The model's settings were fitted on
// 2024-07 to 2025-12 series only; 2026 is out of sample. Kalshi's price is
// the no-vig mid of its two books (each spread 8c or less) at the time.
// Model-side bets pay Kalshi's ask plus the 0.07 p(1-p) taker fee and are
// graded on the result and on Kalshi's price a minute before the start.

const fs = require('fs');
const zlib = require('zlib');
const path = require('path');
const M = require('../esmatchup');

const [kFile, sFile = path.join(__dirname, '..', 'seeds', 'lol-series.json.gz'), outFile = path.join(__dirname, '..', 'seeds', 'lol-matchup-backtest.json')] = process.argv.slice(2);
if (!kFile) { console.error('usage: lolmatchup-backtest.js <kalshi-LOL.json.gz> [series.json.gz] [out.json]'); process.exit(1); }
const gz = f => JSON.parse(zlib.gunzipSync(fs.readFileSync(f)));

const series = gz(sFile).map(s => ({ ...s, t: Date.parse(s.t) })).filter(s => Number.isFinite(s.t) && s.s1 != null).sort((a, b) => a.t - b.t);
const kal = gz(kFile).filter(e => e.kind === 'match' && e.ms?.length === 2 && e.start);
const TRAIN = [Date.parse('2024-07-01'), Date.parse('2026-01-01')];
const r4 = x => (x == null || !Number.isFinite(x) ? null : Math.round(x * 1e4) / 1e4);
const r1 = x => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10) / 10);
const ll = (p, y) => { p = Math.min(1 - 1e-6, Math.max(1e-6, p)); return -(y ? Math.log(p) : Math.log(1 - p)); };
const fee = p => 0.07 * p * (1 - p);
const mean = (a, f) => (a.length ? a.reduce((s, x) => s + f(x), 0) / a.length : null);
const MAJOR = /^(LCK|LPL|LEC|LCS|LTA North|LTA South|CBLOL|LCP|Worlds|MSI|First Stand|Esports World Cup)$/;

// 1. every series, predicted before it was played
function walk(opts) {
  const R = M.createRatings(opts);
  const out = [];
  for (let i = 0; i < series.length;) {
    let j = i;
    while (j < series.length && series[j].t === series[i].t) j++;
    for (let k = i; k < j; k++) {
      const s = series[k];
      if (s.s1 === s.s2) continue;
      const p = R.predict(s.a, s.b, { bestOf: s.bo, t: s.t });
      if (p.series) out.push({ t: s.t, lg: s.lg, bo: s.bo, y: s.s1 > s.s2 ? 1 : 0, p: p.series.win, priced: p.priced, map: p.map, s1: s.s1, s2: s.s2 });
    }
    for (let k = i; k < j; k++) R.update(series[k]);
    i = j;
  }
  return out;
}
const score = rows => ({ n: rows.length, logLoss: r4(mean(rows, x => ll(x.p, x.y))), brier: r4(mean(rows, x => (x.p - x.y) ** 2)), favHit: r4(mean(rows, x => ((x.p >= 0.5) === (x.y === 1) ? 1 : 0))) });
function calib(rows, key = 'p') {
  const b = {};
  for (const x of rows) { const p = Math.max(x[key], 1 - x[key]), y = x[key] >= 0.5 ? x.y : 1 - x.y; const k = Math.min(9, Math.floor(p * 10)); (b[k] ||= []).push([p, y]); }
  return Object.entries(b).map(([k, v]) => ({ bucket: `${k * 10}-${k * 10 + 10}%`, n: v.length, predicted: r4(mean(v, q => q[0])), actual: r4(mean(v, q => q[1])) }));
}

const all = walk({});
const train = all.filter(x => x.t >= TRAIN[0] && x.t < TRAIN[1]), test = all.filter(x => x.t >= TRAIN[1]);
const indep = walk({ kappa: Infinity }).filter(x => x.t >= TRAIN[1]);
const noH2h = walk({ h2hWeight: 0 }).filter(x => x.t >= TRAIN[1]);
// series-shape check: score likelihood on Bo3/Bo5 at the model's map chance
function shapeLL(kappa) {
  const rows = test.filter(x => x.bo >= 3);
  return r4(mean(rows, x => { const sc = M.seriesScores(x.map, x.bo, kappa).find(q => q.a === x.s1 && q.b === x.s2); return sc ? -Math.log(sc.prob) : 0; }));
}

// 2. Kalshi join
const joined = [];
for (const e of kal) {
  const [m0, m1] = e.ms;
  let best = null;
  for (const s of series) {
    if (Math.abs(s.t - e.start) > 5 * 3600e3) continue;
    const d = Math.min(M.nameScore(m0.sub, s.a, s.ac), M.nameScore(m1.sub, s.b, s.bc));
    const f = Math.min(M.nameScore(m0.sub, s.b, s.bc), M.nameScore(m1.sub, s.a, s.ac));
    const sc = Math.max(d, f);
    if (sc < 0.6) continue;
    const key = sc * 10 - Math.abs(s.t - e.start) / 3600e3;
    if (!best || key > best.key) best = { s, or: d >= f ? 0 : 1, key };
  }
  if (best) joined.push({ e, ...best });
}
function quote(m, kStart, T) {
  const off = (T - kStart) / 60e3;
  let c = null;
  for (const arr of [m.h, m.mi]) for (const x of arr || []) if (x[0] <= off && x[0] > off - 240 && x[1] != null && x[2] != null && (!c || x[0] >= c[0])) c = x;
  return c && { ask: c[1], bid: c[2] };
}
function fair(j, T) {
  const [m0, m1] = j.e.ms;
  const a = quote(m0, j.e.start, T), b = quote(m1, j.e.start, T);
  if (!a || !b || a.ask - a.bid > 0.08 || b.ask - b.bid > 0.08) return null;
  const ma = (a.ask + a.bid) / 2, mb = (b.ask + b.bid) / 2;
  if (Math.abs(ma + mb - 1) > 0.04) return null;   // the two books disagree: a bad snapshot
  const p0 = ma / (ma + mb);
  return j.or === 0 ? { p: p0, askA: a.ask, askB: b.ask } : { p: 1 - p0, askA: b.ask, askB: a.ask };
}
const ENTRIES = [['T-6h', 360], ['T-60', 60], ['T-30', 30]];
const ev = [];
for (const s of series) ev.push({ t: s.t + (s.bo || 1) * 45 * 60e3, kind: 'done', s });
for (const j of joined) for (const [lab, min] of ENTRIES) ev.push({ t: j.s.t - min * 60e3, kind: 'entry', j, lab });
ev.sort((a, b) => a.t - b.t || (a.kind === 'done' ? -1 : 1));
const R = M.createRatings({});
const rows = [];
for (const e of ev) {
  if (e.kind === 'done') { R.update(e.s); continue; }
  const s = e.j.s;
  if (s.s1 === s.s2) continue;
  const f = fair(e.j, e.t), close = fair(e.j, s.t - 60e3);
  if (!f) continue;
  const p = R.predict(s.a, s.b, { bestOf: s.bo, t: e.t });
  if (!p.series || !p.priced) continue;
  rows.push({ lab: e.lab, t: s.t, lg: s.lg, bo: s.bo, y: s.s1 > s.s2 ? 1 : 0, p: p.series.win, k: f.p, askA: f.askA, askB: f.askB, close: close?.p ?? null });
}
// walk-forward blend: logit(kalshi) + w (logit(model) - logit(kalshi)), w fitted on earlier months only
function blend(list) {
  const months = [...new Set(list.map(x => new Date(x.t).toISOString().slice(0, 7)))].sort();
  const out = [];
  for (const mo of months) {
    const past = list.filter(x => new Date(x.t).toISOString().slice(0, 7) < mo);
    let w = 0;
    if (past.length >= 100) {
      let best = [0, Infinity];
      for (let v = -0.5; v <= 1.0001; v += 0.05) { const L = mean(past, x => ll(M.sigmoid(M.logit(x.k) + v * (M.logit(x.p) - M.logit(x.k))), x.y)); if (L < best[1]) best = [v, L]; }
      w = best[0];
    }
    for (const x of list.filter(y => new Date(y.t).toISOString().slice(0, 7) === mo)) out.push({ ...x, b: M.sigmoid(M.logit(x.k) + w * (M.logit(x.p) - M.logit(x.k))), w });
  }
  return out;
}
function bets(list, th) {
  let n = 0, won = 0, roi = 0, clv = 0, nc = 0;
  for (const x of list) {
    const d = x.p - x.k;
    if (Math.abs(d) < th) continue;
    const a = d > 0, ask = a ? x.askA : x.askB;
    if (ask == null || ask < 0.05 || ask > 0.95) continue;
    const cost = ask + fee(ask), w = a ? x.y : 1 - x.y;
    n++; won += w; roi += (w - cost) / cost;
    if (x.close != null) { nc++; clv += ((a ? x.close : 1 - x.close) - cost) / cost; }
  }
  return { edgePts: Math.round(th * 100), bets: n, won, roi: n ? r1((roi / n) * 100) : null, clv: nc ? r1((clv / nc) * 100) : null };
}
function kScore(list) {
  const b = blend(list);
  const d = list.map(x => ll(x.p, x.y) - ll(x.k, x.y));
  const md = mean(d, x => x), sd = Math.sqrt(mean(d, x => (x - md) ** 2));
  return {
    n: list.length,
    logLoss: { model: r4(mean(list, x => ll(x.p, x.y))), kalshi: r4(mean(list, x => ll(x.k, x.y))), blend: r4(mean(b, x => ll(x.b, x.y))) },
    brier: { model: r4(mean(list, x => (x.p - x.y) ** 2)), kalshi: r4(mean(list, x => (x.k - x.y) ** 2)) },
    llGapT: r1(md / (sd / Math.sqrt(list.length))),
    blendWeightLast: b.length ? r4(b[b.length - 1].w) : null,
    bets: [0.03, 0.05, 0.08, 0.12].map(th => bets(list, th)),
  };
}
const kalshi = {};
for (const [lab] of ENTRIES) {
  const list = rows.filter(x => x.lab === lab);
  kalshi[lab] = { ...kScore(list), major: kScore(list.filter(x => MAJOR.test(x.lg || ''))), other: kScore(list.filter(x => !MAJOR.test(x.lg || ''))) };
}
const t60 = rows.filter(x => x.lab === 'T-60');

const out = {
  generated: new Date().toISOString(),
  model: { opts: M.DEFAULTS, fittedOn: '2024-07-01 to 2025-12-31 series (walk-forward log loss); 2026 is out of sample' },
  data: { series: series.length, from: new Date(series[0].t).toISOString().slice(0, 10), to: new Date(series[series.length - 1].t).toISOString().slice(0, 10), kalshiEvents: kal.length, kalshiJoined: joined.length },
  allSeries: {
    train: score(train), test: score(test), testPriced: score(test.filter(x => x.priced)), coinFlip: r4(Math.LN2),
    testIndependentMaps: score(indep), testNoH2h: score(noH2h),
    seriesShape: { kappa10: shapeLL(10), kappa4: shapeLL(4), independent: shapeLL(Infinity), note: 'mean -log P(exact score) on 2026 Bo3/Bo5' },
    calibration: calib(test.filter(x => x.priced)),
  },
  kalshi,
  kalshiCalibration: { model: calib(t60), kalshi: calib(t60, 'k') },
  verdict: null,
};
const k30 = kalshi['T-30'], k60 = kalshi['T-60'];
out.verdict = `Kalshi's price beats the model: log loss ${k60.logLoss.kalshi} vs ${k60.logLoss.model} an hour out on ${k60.n} series (t ${k60.llGapT}), ${k30.logLoss.kalshi} vs ${k30.logLoss.model} at 30 minutes. Betting the model's side when it was 5+ points off Kalshi: ${k60.bets[1].bets} bets, ROI ${k60.bets[1].roi}% after the fee, ${k60.bets[1].clv}% against Kalshi's close. Blending the model into Kalshi's price (weight fitted on earlier months) gives ${k60.logLoss.blend}, no better than Kalshi alone. The model is a research and explanation tool, not a betting signal.`;
fs.writeFileSync(outFile, JSON.stringify(out, null, 1));
console.log(JSON.stringify({ data: out.data, allSeries: { train: out.allSeries.train, test: out.allSeries.test, indep: out.allSeries.testIndependentMaps.logLoss, noH2h: out.allSeries.testNoH2h.logLoss, shape: out.allSeries.seriesShape }, kalshi: Object.fromEntries(Object.entries(kalshi).map(([k, v]) => [k, { n: v.n, ll: v.logLoss, t: v.llGapT, w: v.blendWeightLast, bets: v.bets, majorLL: v.major.logLoss, otherLL: v.other.logLoss }])) }, null, 1));
console.log(out.verdict);
