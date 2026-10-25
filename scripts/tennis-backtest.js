// Held-out test of the frozen tennis model (PREREGISTERED.md in
// checks/tennis-model-2026-10-25) against Kalshi and the Polymarket proxy.
//   node scripts/tennis-backtest.js --seed seeds/tennis-matches.json.gz --espn a.gz,b.gz \
//        --pm pm-atp.gz,pm-wta.gz --kalshi k-tennis.gz --out seeds/tennis-matchup-backtest.json
// Every match is predicted from ratings built only on matches before it.
const fs = require('fs'), zlib = require('zlib');
const T = require('../tennismodel');
const D = require('../tennisdata');

const arg = k => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
const gz = f => JSON.parse(zlib.gunzipSync(fs.readFileSync(f)));
const list = s => (s ? s.split(',').filter(Boolean) : []);
const HELD = Date.parse('2025-01-01');
const EDGE = 0.03, ENTRY_MIN = 60;
const KFEE = p => 0.07 * p * (1 - p), PMFEE = p => 0.0695 * p * (1 - p);

const matches = D.loadSeed(arg('seed') || D.SEED);
// ESPN scheduled times (a real time only) by competition id
const sched = new Map();
for (const f of list(arg('espn'))) for (const r of gz(f)) if (r.tbd === 0 && r.date) sched.set(String(r.cid), Date.parse(r.date));

// held-out results indexed by day for name joins
const held = matches.filter(m => m.t >= HELD - 2 * 86400e3);
const byDay = new Map();
for (const m of held) { const d = Math.floor(m.t / 864e5); if (!byDay.has(d)) byDay.set(d, []); byDay.get(d).push(m); }
// "A vs B" at time t → { m, flip } (flip: the market's first name is the result's b)
function findMatch(n1, n2, t) {
  let best = null;
  const d0 = Math.floor(t / 864e5);
  for (let d = d0 - 2; d <= d0 + 2; d++) for (const m of byDay.get(d) || []) {
    const dt = Math.abs(m.t - t);
    if (dt > 36 * 3600e3) continue;
    const s0 = Math.min(T.nameScore(n1, m.an), T.nameScore(n2, m.bn)), s1 = Math.min(T.nameScore(n1, m.bn), T.nameScore(n2, m.an));
    const s = Math.max(s0, s1);
    if (s < 0.8) continue;
    if (!best || s > best.s || (s === best.s && dt < best.dt)) best = { m, flip: s1 > s0, s, dt };
  }
  return best;
}

// ── market rows: { venue, id, n1, n2, start, entry: {cost1, cost2, mid1}, close: {mid1}, settle1 } ──
const rows = [];
let pmSeen = 0, pmNoHist = 0;
for (const f of list(arg('pm'))) for (const e of gz(f)) {
  pmSeen++;
  const [n1, n2] = e.outcomes || [];
  const start = Date.parse(String(e.gst || '').replace(' ', 'T').replace(/\+00$/, 'Z')) || e.start;
  const pts = [...(e.h || []), ...(e.mi || [])].filter(([m, p]) => m <= -ENTRY_MIN && p > 0 && p < 1).sort((a, b) => a[0] - b[0]);
  const cl = [...(e.h || []), ...(e.mi || [])].filter(([m, p]) => m < 0 && p > 0 && p < 1).sort((a, b) => a[0] - b[0]);
  if (!n1 || !n2 || !pts.length) { pmNoHist++; continue; }
  const p1 = pts[pts.length - 1][1];
  const settle = (e.prices || []).map(Number);
  rows.push({ venue: 'polymarket', id: e.slug, title: e.title, n1, n2, start, vol: e.mvol,
    cost1: p1 + 0.01 + PMFEE(p1 + 0.01), cost2: 1 - p1 + 0.01 + PMFEE(1 - p1 + 0.01), mid1: p1, close1: cl.length ? cl[cl.length - 1][1] : null,
    settle1: settle[0] === 1 ? 1 : settle[1] === 1 ? 0 : null });
}
// Kalshi: one market per player; pair them by event
const kEv = new Map();
let kSeen = 0;
for (const f of list(arg('kalshi'))) for (const m of gz(f)) { kSeen++; if (!kEv.has(m.ev)) kEv.set(m.ev, []); kEv.get(m.ev).push(m); }
const pmStart = new Map();   // "lastname|lastname|day" → start
const lk = (a, b, t) => `${[T.nameKey(a).last, T.nameKey(b).last].sort().join('|')}|${Math.floor(t / 864e5)}`;
for (const r of rows) pmStart.set(lk(r.n1, r.n2, r.start), r.start);
const kRows = [];
let kNoPair = 0;
for (const [ev, ms] of kEv) {
  if (ms.length !== 2) { kNoPair++; continue; }
  const [a, b] = ms;
  kRows.push({ ev, a, b, close: Date.parse(a.close), title: a.title });
}

// pass 1: join markets to results (PM directly; Kalshi needs the start time from PM or ESPN)
const joined = new Map();   // match id → [{ row, flip }]
const stats = { polymarket: { seen: pmSeen, noHistory: pmNoHist, noResult: 0, noStart: 0 }, kalshi: { seen: kSeen, events: kEv.size, notTwoSided: kNoPair, noResult: 0, noStart: 0 } };
const attach = (row, hit) => { if (!joined.has(hit.m.id)) joined.set(hit.m.id, []); joined.get(hit.m.id).push({ row, flip: hit.flip }); };
for (const r of rows) {
  const hit = findMatch(r.n1, r.n2, r.start);
  if (!hit) { stats.polymarket.noResult++; continue; }
  attach(r, hit);
}
for (const k of kRows) {
  const n1 = k.a.sub || '', n2 = k.b.sub || '';
  const ref = Date.parse(k.a.occ || '') || Date.parse(k.a.exp || '') || k.close;
  const hit = findMatch(n1, n2, ref);
  if (!hit) { stats.kalshi.noResult++; continue; }
  // the scheduled start: Polymarket's for the same match, else ESPN's real time
  let start = null;
  for (const dd of [-1, 0, 1]) { const s = pmStart.get(lk(n1, n2, hit.m.t + dd * 864e5)); if (s && Math.abs(s - hit.m.t) < 36 * 3600e3) { start = s; break; } }
  if (!start) start = sched.get(hit.m.id) || null;
  if (!start) { stats.kalshi.noStart++; continue; }
  const before = (mk, cutMs) => (mk.h || []).filter(c => c[0] * 1000 <= cutMs && c[1] > 0 && c[1] < 1 && c[2] > 0).pop() || null;
  const ea = before(k.a, start - ENTRY_MIN * 60e3), eb = before(k.b, start - ENTRY_MIN * 60e3);
  const ca = before(k.a, start), cb = before(k.b, start);
  if (!ea || !eb) { stats.kalshi.noEntry = (stats.kalshi.noEntry || 0) + 1; continue; }
  const midA = (ea[1] + ea[2]) / 2, midB = (eb[1] + eb[2]) / 2;
  const cmA = ca && cb ? (ca[1] + ca[2]) / 2 : null, cmB = ca && cb ? (cb[1] + cb[2]) / 2 : null;
  attach({ venue: 'kalshi', id: k.ev, title: k.title, n1, n2, start, vol: (k.a.vol || 0) + (k.b.vol || 0),
    cost1: ea[1] + KFEE(ea[1]), cost2: eb[1] + KFEE(eb[1]), mid1: midA / (midA + midB), close1: cmA != null ? cmA / (cmA + cmB) : null,
    settle1: k.a.res === 'yes' ? 1 : k.b.res === 'yes' ? 0 : null, spread: (ea[1] - ea[2] + eb[1] - eb[2]) / 2 }, hit);
}

// pass 2: walk every match in time order, predict the joined ones before adding them
const R = T.createRatings();
const scored = [];
for (const m of matches) {
  const js = joined.get(m.id);
  if (js) {
    const pr = R.predict(m.a, m.b, { surf: m.surf, t: m.t, bestOf: m.bo });
    for (const { row, flip } of js) {
      const pModel1 = pr.priced ? (flip ? 1 - pr.p : pr.p) : null;
      const y1 = flip ? 1 - m.w : m.w;
      scored.push({ ...row, y1, pModel1, priced: pr.priced, tour: m.tour, ev: m.ev, round: m.round, settleAgrees: row.settle1 == null ? null : row.settle1 === y1 });
    }
  }
  R.add(m);
}

// ── summaries ──
const mean = a => a.reduce((s, x) => s + x, 0) / (a.length || 1);
const sd = a => { const mu = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - mu) ** 2, 0) / Math.max(1, a.length - 1)); };
const tOf = a => (a.length > 1 ? mean(a) / (sd(a) / Math.sqrt(a.length)) : null);
const r4 = x => (x == null || !Number.isFinite(x) ? null : Math.round(x * 1e4) / 1e4);
// blend: logistic fit of y on [logit(mkt), logit(model)] by Newton steps
function blend(rs) {
  let w = [0, 1, 0];
  const X = rs.map(r => [1, T.logit(r.mid1), T.logit(r.pModel1)]), Y = rs.map(r => r.y1);
  let H;
  for (let it = 0; it < 30; it++) {
    const g = [0, 0, 0]; H = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    X.forEach((x, i) => { const p = T.sigmoid(x[0] * w[0] + x[1] * w[1] + x[2] * w[2]); for (let a = 0; a < 3; a++) { g[a] += (Y[i] - p) * x[a]; for (let b = 0; b < 3; b++) H[a][b] += p * (1 - p) * x[a] * x[b]; } });
    const inv = inv3(H); const step = [0, 1, 2].map(a => inv[a][0] * g[0] + inv[a][1] * g[1] + inv[a][2] * g[2]);
    w = w.map((v, a) => v + step[a]);
    if (Math.max(...step.map(Math.abs)) < 1e-8) break;
  }
  const inv = inv3(H);
  return { market: r4(w[1]), model: r4(w[2]), modelZ: r4(w[2] / Math.sqrt(inv[2][2])) };
}
function inv3(m) {
  const [[a, b, c], [d, e, f], [g, h, i]] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g, det = a * A + b * B + c * C;
  return [[A / det, -(b * i - c * h) / det, (b * f - c * e) / det], [B / det, (a * i - c * g) / det, -(a * f - c * d) / det], [C / det, -(a * h - b * g) / det, (a * e - b * d) / det]];
}
function summarize(rs) {
  const priced = rs.filter(r => r.priced);
  const llM = priced.map(r => T.llOf(r.pModel1, r.y1)), llK = priced.map(r => T.llOf(r.mid1, r.y1));
  const diff = priced.map((r, i) => llK[i] - llM[i]);   // > 0: model better
  const bets = [];
  for (const r of priced) {
    const e1 = r.pModel1 - r.cost1, e2 = (1 - r.pModel1) - r.cost2;
    const side = e1 >= EDGE && e1 >= e2 ? 1 : e2 >= EDGE ? 2 : 0;
    if (!side) continue;
    const cost = side === 1 ? r.cost1 : r.cost2, won = side === 1 ? r.y1 === 1 : r.y1 === 0;
    const close = r.close1 == null ? null : side === 1 ? r.close1 : 1 - r.close1;
    bets.push({ profit: won ? 1 / cost - 1 : -1, clv: close != null ? close / cost - 1 : null, edge: side === 1 ? e1 : e2, cost, won, fav: (side === 1 ? r.mid1 : 1 - r.mid1) >= 0.5 });
  }
  const pr = bets.map(b => b.profit), clv = bets.filter(b => b.clv != null).map(b => b.clv);
  // results vs what the cost said: z of wins
  const expW = bets.reduce((s, b) => s + b.cost, 0), varW = bets.reduce((s, b) => s + b.cost * (1 - b.cost), 0);
  return {
    matched: rs.length, insufficient: rs.length - priced.length, priced: priced.length,
    logLoss: { model: r4(mean(llM)), market: r4(mean(llK)), modelMinusMarketT: r4(-tOf(diff)) },
    brier: { model: r4(mean(priced.map(r => (r.pModel1 - r.y1) ** 2))), market: r4(mean(priced.map(r => (r.mid1 - r.y1) ** 2))) },
    blend: priced.length > 30 ? blend(priced) : null,
    bets: { n: bets.length, wins: bets.filter(b => b.won).length, roi: r4(mean(pr)), z: r4(tOf(pr)), profitUnits: r4(pr.reduce((s, x) => s + x, 0)),
      winsVsCostZ: r4(varW ? (bets.filter(b => b.won).length - expW) / Math.sqrt(varW) : null),
      clvN: clv.length, clvMean: r4(mean(clv)), clvT: r4(tOf(clv)), favourites: bets.filter(b => b.fav).length, avgEdge: r4(mean(bets.map(b => b.edge))) },
    settleDisagree: rs.filter(r => r.settleAgrees === false).length,
  };
}
const slices = { '2025': [Date.parse('2025-01-01'), Date.parse('2026-01-01')], '2026': [Date.parse('2026-01-01'), Date.parse('2026-10-25')] };
const out = { generated: new Date().toISOString(), rule: { edge: EDGE, entryMin: ENTRY_MIN, fees: 'Kalshi 0.07p(1-p); Polymarket proxy +1c half spread and 0.0695p(1-p)' }, params: T.DEFAULTS, joins: stats, venues: {} };
for (const venue of ['kalshi', 'polymarket']) {
  const vr = scored.filter(r => r.venue === venue && r.start >= HELD);
  out.venues[venue] = { all: summarize(vr) };
  for (const [k, [a, b]] of Object.entries(slices)) out.venues[venue][k] = summarize(vr.filter(r => r.start >= a && r.start < b));
  for (const tour of ['atp', 'wta']) out.venues[venue][tour] = summarize(vr.filter(r => r.tour === tour));
  const months = [...new Set(vr.map(r => new Date(r.start).toISOString().slice(0, 7)))].sort();
  out.venues[venue].months = Object.fromEntries(months.map(mo => [mo, vr.filter(r => new Date(r.start).toISOString().slice(0, 7) === mo).length]));
}
// the pre-registered bar, read off the numbers above
const K = out.venues.kalshi, P = out.venues.polymarket;
const sliceOk = x => x && x.bets.n > 0 && x.bets.z >= 2 && (x.logLoss.modelMinusMarketT <= -2 || (x.blend && x.blend.model > 0 && x.blend.modelZ >= 2));
// the Pinnacle-close leg needs the live record (no historical closes), so the backtest alone can only make a lead
out.edge = !!(sliceOk(K['2025']) && sliceOk(K['2026']) && P.all.bets.roi > 0);
const pick = v => ({ n: v.all.priced, logLoss: v.all.logLoss, blend: v.all.blend, bets: v.all.bets, slices: { 2025: { n: v['2025'].priced, bets: v['2025'].bets.n, roi: v['2025'].bets.roi, z: v['2025'].bets.z }, 2026: { n: v['2026'].priced, bets: v['2026'].bets.n, roi: v['2026'].bets.roi, z: v['2026'].bets.z } } });
out.headline = { kalshi: pick(K), polymarket: pick(P) };
const pct = x => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`;
out.verdict = `${out.edge ? 'A lead, not proven: it still needs CLV against Pinnacle\'s close from the live record.' : 'Not an edge.'} On ${K.all.priced.toLocaleString()} held-out Kalshi matches the model's log loss was ${K.all.logLoss.model} against Kalshi's ${K.all.logLoss.market}${K.all.blend ? ` (blend weight on the model ${K.all.blend.model}, z ${K.all.blend.modelZ})` : ''}; backing its side at 3+ points over the ask went ${pct(K.all.bets.roi)} on ${K.all.bets.n.toLocaleString()} bets after fees, CLV ${pct(K.all.bets.clvMean)} against Kalshi's last price. On ${P.all.priced.toLocaleString()} Polymarket matches (a proxy for Polymarket US): ${P.all.logLoss.model} vs ${P.all.logLoss.market}, ${pct(P.all.bets.roi)} on ${P.all.bets.n.toLocaleString()} bets.`;
const file = arg('out');
if (file) fs.writeFileSync(file, JSON.stringify(out, null, 1));
if (arg('rows')) fs.writeFileSync(arg('rows'), zlib.gzipSync(JSON.stringify(scored)));
console.log(JSON.stringify(out, null, 1));
