#!/usr/bin/env node
// Fit and check the same-match stack link (esstackmodel.js) on finished series.
//   node scripts/esstacks-fit.js <dir with cs/dota/val/lol .json.gz> [out.json]
// Each player's line for a series is his trailing 10-series mean over the same
// span (5+ series behind it), set on a half number (floor + 0.5), so a leg is
// over or under, never a push. Series are split by time: the first 70% fit,
// the last 30% are held out. Every stack shape with both teams in it (1+1 up
// to 3+3 and 4+2) is scored in every series, each series weighed once per shape.
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');
const M = require('../esstackmodel');
const { FACTORS } = require('../slip');

const dir = process.argv[2];
const outFile = process.argv[3] || null;
const read = name => { try { return JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(dir, `${name}.json.gz`)))); } catch { return []; } };
const sq = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// ── normalise: series { id, t, teams, maps: [{ n, players: [{ pid, ti, kills, assists, headshots }] }] }
function csSeries(rows) {
  return rows.map(s => ({ id: s.id, t: Date.parse(s.t), bo: s.bo, maps: s.maps.filter(m => m.p.length >= 10).map(m => ({
    n: m.n, players: m.p.map(([team, pid, k, hs, a]) => ({ pid: `cs:${pid}`, ti: sq(team) === sq(s.teams[0]) ? 0 : sq(team) === sq(s.teams[1]) ? 1 : -1, kills: k, headshots: hs, assists: a })).filter(p => p.ti >= 0),
  })).filter(m => m.players.filter(p => p.ti === 0).length === 5 && m.players.filter(p => p.ti === 1).length === 5) })).filter(s => s.maps.length);
}
function valSeries(rows) {
  return rows.map(s => ({ id: s.id, t: s.t, maps: s.maps.map(m => ({ n: m.n, players: m.p.filter(p => p[0] === 0 || p[0] === 1).map(([ti, pid, k, a]) => ({ pid: `val:${pid}`, ti, kills: k, assists: a })) }))
    .filter(m => m.players.filter(p => p.ti === 0).length === 5 && m.players.filter(p => p.ti === 1).length === 5) })).filter(s => s.maps.length);
}
function dotaSeries(rows) {
  const by = new Map();
  for (const g of rows) {
    if (!g.sid || g.p.length !== 10) continue;
    if (!by.has(g.sid)) by.set(g.sid, []);
    by.get(g.sid).push(g);
  }
  const out = [];
  for (const [sid, games] of by) {
    games.sort((a, b) => a.t - b.t);
    const ref = games[0].tid;
    out.push({ id: `dota:${sid}`, t: games[0].t * 1000, maps: games.map((g, i) => ({ n: i + 1, players: g.p.map(([side, acct, k, a]) => {
      const tid = g.tid[side];
      return { pid: `dota:${acct}`, ti: tid === ref[0] ? 0 : tid === ref[1] ? 1 : -1, kills: k, assists: a };
    }).filter(p => p.ti >= 0) })) });
  }
  return out;
}
function lolSeries(rows) {
  const by = new Map();
  for (const r of rows) {
    if (!r.MatchId) continue;
    if (!by.has(r.MatchId)) by.set(r.MatchId, new Map());
    const g = by.get(r.MatchId);
    if (!g.has(r.GameId)) g.set(r.GameId, { n: parseInt(r.GameN) || 1, t: Date.parse(String(r.DateTime).replace(' ', 'T') + 'Z'), rows: [] });
    g.get(r.GameId).rows.push(r);
  }
  const out = [];
  for (const [mid, games] of by) {
    const list = [...games.values()].sort((a, b) => a.n - b.n);
    const teams = [...new Set(list[0].rows.map(r => sq(r.Team)))];
    if (teams.length !== 2) continue;
    out.push({ id: `lol:${mid}`, t: list[0].t, maps: list.map(g => ({ n: g.n, players: g.rows.map(r => ({ pid: `lol:${sq(r.Link)}`, ti: teams.indexOf(sq(r.Team)), kills: +r.Kills, assists: +r.Assists })).filter(p => p.ti >= 0 && Number.isFinite(p.kills)) }))
      .filter(m => m.players.filter(p => p.ti === 0).length === 5 && m.players.filter(p => p.ti === 1).length === 5) });
  }
  return out.filter(s => s.maps.length);
}

// lolesports (diag fetch-lol.js): maps [{ n, p: [[ti, playerId, kills, assists, role]] }]
function loleSeries(rows) {
  return rows.map(s => ({ id: s.id, t: Date.parse(s.t), bo: s.bo, maps: s.maps.map(m => ({ n: m.n, players: m.p.filter(x => x[0] === 0 || x[0] === 1).map(([ti, pid, k, a]) => ({ pid: `lol:${pid}`, ti, kills: k, assists: a })) }))
    .filter(m => m.players.filter(p => p.ti === 0).length === 5 && m.players.filter(p => p.ti === 1).length === 5) })).filter(s => s.maps.length);
}

// ── legs: one per player per series per (stat, span), with its trailing line
const SPANS = { '1': [1], '1-2': [1, 2] };
function legsFor(series, stat, span) {
  const maps = SPANS[span];
  const hist = new Map();
  const out = [];
  for (const s of series.slice().sort((a, b) => a.t - b.t)) {
    const ms = maps.map(n => s.maps.find(m => m.n === n));
    if (ms.some(m => !m)) continue;
    const by = new Map();
    for (const m of ms) for (const p of m.players) {
      const v = p[stat];
      if (!Number.isFinite(v)) continue;
      const cur = by.get(p.pid) || { ti: p.ti, v: 0, n: 0 };
      cur.v += v; cur.n++;
      by.set(p.pid, cur);
    }
    const legs = [];
    for (const [pid, x] of by) {
      if (x.n !== maps.length) continue;
      const h = hist.get(pid) || [];
      if (h.length >= 5) {
        const last = h.slice(-10);
        const line = Math.floor(last.reduce((a, b) => a + b, 0) / last.length) + 0.5;
        legs.push({ ti: x.ti, over: x.v > line ? 1 : 0 });
      }
      h.push(x.v);
      hist.set(pid, h);
    }
    if (legs.filter(l => l.ti === 0).length >= 3 && legs.filter(l => l.ti === 1).length >= 3) out.push({ id: s.id, t: s.t, legs });
  }
  return out;
}

const SHAPES = [[1, 1], [2, 1], [2, 2], [3, 1], [3, 2], [3, 3], [4, 2]];
const choose = (n, k) => { let r = 1; for (let i = 0; i < k; i++) r = r * (n - i) / (i + 1); return r; };
// fraction of shape (x from team 0 + y from team 1, and the mirror) that swept on SIDE in one series
function sweepFrac(legs, [x, y], side) {
  const hit = l => (side === 'OVER' ? l.over : 1 - l.over);
  const A = legs.filter(l => l.ti === 0), B = legs.filter(l => l.ti === 1);
  const frac = (P, Q, a, b) => {
    if (P.length < a || Q.length < b) return null;
    const hp = P.filter(hit).length, hq = Q.filter(hit).length;
    return (choose(hp, a) / choose(P.length, a)) * (choose(hq, b) / choose(Q.length, b));
  };
  const f = [frac(A, B, x, y), x !== y ? frac(B, A, x, y) : null].filter(v => v != null);
  return f.length ? f.reduce((a, b) => a + b, 0) / f.length : null;
}

// model sweep chance for shape at leg chance p
function modelSweep(p, shape, f, tail) {
  const [x, y] = shape;
  const legs = [];
  const a = f ? Math.sqrt(Math.max(0, f[0])) : null, b = f ? Math.sqrt(Math.max(0, f[1])) : null;
  for (let i = 0; i < x; i++) legs.push({ p, a, b, s: 1 });
  for (let i = 0; i < y; i++) legs.push({ p, a, b, s: -1 });
  return M.hitsDistribution(legs, tail)[x + y];
}

function table(rows, side) {
  // per shape: [fractions per series]
  return SHAPES.map(sh => ({ shape: sh, f: rows.map(r => sweepFrac(r.legs, sh, side)).filter(v => v != null) }));
}
function logLoss(tab, p, f, tail) {
  let ll = 0, n = 0;
  for (const { shape, f: fr } of tab) {
    const q = Math.min(1 - 1e-9, Math.max(1e-9, modelSweep(p, shape, f, tail)));
    for (const v of fr) { ll -= v * Math.log(q) + (1 - v) * Math.log(1 - q); n++; }
  }
  return ll / Math.max(1, n);
}

// Nelder-Mead on an unconstrained vector
function nelder(fn, x0, step = 0.3, iters = 160) {
  const n = x0.length;
  let pts = [x0.slice()];
  for (let i = 0; i < n; i++) { const p = x0.slice(); p[i] += step; pts.push(p); }
  let vals = pts.map(fn);
  for (let it = 0; it < iters; it++) {
    const idx = vals.map((v, i) => i).sort((a, b) => vals[a] - vals[b]);
    pts = idx.map(i => pts[i]); vals = idx.map(i => vals[i]);
    const c = new Array(n).fill(0);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) c[j] += pts[i][j] / n;
    const refl = c.map((v, j) => v + (v - pts[n][j]));
    const fr = fn(refl);
    if (fr < vals[0]) {
      const exp = c.map((v, j) => v + 2 * (v - pts[n][j]));
      const fe = fn(exp);
      if (fe < fr) { pts[n] = exp; vals[n] = fe; } else { pts[n] = refl; vals[n] = fr; }
    } else if (fr < vals[n - 1]) { pts[n] = refl; vals[n] = fr; }
    else {
      const con = c.map((v, j) => v + 0.5 * (pts[n][j] - v));
      const fc = fn(con);
      if (fc < vals[n]) { pts[n] = con; vals[n] = fc; }
      else { for (let i = 1; i <= n; i++) { pts[i] = pts[i].map((v, j) => pts[0][j] + 0.5 * (v - pts[0][j])); vals[i] = fn(pts[i]); } }
    }
  }
  return { x: pts[0], v: vals[0] };
}
const sig = x => 1 / (1 + Math.exp(-x));
// x → loadings [a², b²] (a² + b² < 0.9) and tails
function decode(x, withTail) {
  const tot = 0.9 * sig(x[0]), share = sig(x[1]);
  const f = [tot * share, tot * (1 - share)];
  const tail = withTail ? { m: [0.5 * sig(x[2]), 1 + 3 * sig(x[3])], d: [0.5 * sig(x[4]), 1 + 3 * sig(x[5])] } : {};
  return { f, tail };
}

// series-clustered bootstrap of observed minus model for one shape's sweep rate
function boot(fr, q, reps = 400) {
  const n = fr.length;
  if (!n) return null;
  const mean = fr.reduce((a, b) => a + b, 0) / n;
  let seed = 7;
  // mulberry32: a small seeded generator, so the intervals repeat run to run
  const rnd = () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const ms = [];
  for (let r = 0; r < reps; r++) { let s = 0; for (let i = 0; i < n; i++) s += fr[Math.floor(rnd() * n)]; ms.push(s / n); }
  ms.sort((a, b) => a - b);
  return { obs: +mean.toFixed(4), lo: +ms[Math.floor(reps * 0.025)].toFixed(4), hi: +ms[Math.floor(reps * 0.975)].toFixed(4), model: +q.toFixed(4) };
}

const GAMES = {
  cs: { series: () => csSeries(read('cs')), stats: ['kills', 'headshots'], spans: ['1', '1-2'] },
  val: { series: () => valSeries(read('val')), stats: ['kills'], spans: ['1', '1-2'] },
  lol: { series: () => { const lole = loleSeries(read('lol2')); return lole.length ? lole : lolSeries(read('lol')); }, stats: ['kills', 'assists'], spans: ['1', '1-2'] },
  dota: { series: () => dotaSeries(read('dota')), stats: ['kills', 'assists'], spans: ['1', '1-2'] },
};

const report = { fitted: new Date().toISOString(), method: 'trailing-10 mean lines at x.5; 70/30 time split; shapes 1+1..4+2; log loss per series per shape', games: {} };
const params = { version: 1, fitted: report.fitted, source: 'checks/es-stacks-2026-10-25', games: {} };
for (const [g, def] of Object.entries(GAMES)) {
  const series = def.series();
  report.games[g] = { series: series.length, buckets: {} };
  if (series.length < 100) { console.log(g, 'too few series', series.length); continue; }
  const gp = { buckets: {}, heldOut: {} };
  for (const stat of def.stats) for (const span of def.spans) {
    const rows = legsFor(series, stat, span).sort((a, b) => a.t - b.t);
    if (rows.length < 150) continue;
    const cut = Math.floor(rows.length * 0.7);
    const train = rows.slice(0, cut), test = rows.slice(cut);
    const pOver = train.flatMap(r => r.legs).reduce((a, l) => a + l.over, 0) / train.flatMap(r => r.legs).length;
    const b = { series: rows.length, train: train.length, test: test.length, testFrom: new Date(test[0].t).toISOString().slice(0, 10), pOver: +pOver.toFixed(4), sides: {} };
    for (const side of ['OVER', 'UNDER']) {
      const p = side === 'OVER' ? pOver : 1 - pOver;
      const trT = table(train, side), teT = table(test, side);
      const g0 = nelder(x => logLoss(trT, p, decode(x, false).f, {}), [0, 0]);
      const gauss = decode(g0.x, false);
      const t0 = nelder(x => logLoss(trT, p, decode(x, true).f, decode(x, true).tail), [g0.x[0], g0.x[1], -2, 0, -2, 0], 0.5, 260);
      const mix = decode(t0.x, true);
      const old = FACTORS[g]?.[stat]?.[side] || null;
      const ll = {
        independent: logLoss(teT, p, null, {}),
        currentFactors: old ? logLoss(teT, p, old, {}) : null,
        fittedGaussian: logLoss(teT, p, gauss.f, {}),
        fittedTail: logLoss(teT, p, mix.f, mix.tail),
      };
      const shapes = teT.map(({ shape, f }) => ({ shape: shape.join('+'), series: f.length,
        independent: +(p ** (shape[0] + shape[1])).toFixed(4),
        current: old ? +modelSweep(p, shape, old, {}).toFixed(4) : null,
        ...boot(f, modelSweep(p, shape, mix.f, mix.tail)) }));
      b.sides[side] = { p: +p.toFixed(4), gaussian: gauss.f.map(v => +v.toFixed(4)), tailFit: { f: mix.f.map(v => +v.toFixed(4)), tail: mix.tail }, logLossHeldOut: Object.fromEntries(Object.entries(ll).map(([k, v]) => [k, v == null ? null : +v.toFixed(5)])), shapes };
      const key = `${stat}|${span}`;
      gp.buckets[key] = gp.buckets[key] || {};
      // The link this bucket and side ships with: whichever of the fit, the
      // old link and independence scored best on the held-out series. That
      // choice uses the held-out data, so the report says which won where.
      const pick = [['fitted', ll.fittedTail], ['current', ll.currentFactors], ['independent', ll.independent]].filter(x => x[1] != null).sort((x, y) => x[1] - y[1])[0][0];
      gp.buckets[key][side] = pick === 'fitted' ? { f: mix.f.map(v => +v.toFixed(4)), tail: { m: mix.tail.m.map(v => +v.toFixed(4)), d: mix.tail.d.map(v => +v.toFixed(4)) }, link: 'fitted' }
        : pick === 'current' ? { f: old, tail: {}, link: 'slip.js FACTORS' } : { f: [0, 0], tail: {}, link: 'independent' };
      gp.heldOut[`${key}|${side}`] = { series: test.length, from: b.testFrom, ships: pick, ...b.sides[side].logLossHeldOut, ...Object.fromEntries(shapes.filter(x => x.shape === '3+3').map(x => ['six', { obs: x.obs, lo: x.lo, hi: x.hi, model: x.model, current: x.current, independent: x.independent }])) };
      }
    report.games[g].buckets[`${stat}|${span}`] = b;
    console.log(g, stat, span, JSON.stringify({ n: rows.length, ll: Object.fromEntries(Object.entries(b.sides).map(([s, v]) => [s, v.logLossHeldOut])) }));
  }
  params.games[g] = gp;
}
// a game with no fit keeps the slip pricer's link (slip.js FACTORS), no tail
for (const g of Object.keys(GAMES)) {
  if (params.games[g]?.buckets && Object.keys(params.games[g].buckets).length) { params.games[g].source = 'fitted'; continue; }
  const buckets = {};
  for (const [stat, sides] of Object.entries(FACTORS[g] || {})) buckets[`${stat}|1-2`] = Object.fromEntries(Object.entries(sides).map(([side, f]) => [side, { f, tail: {} }]));
  params.games[g] = { source: 'slip.js FACTORS (no box scores fitted)', buckets, heldOut: {} };
}
params.rule = 'PrizePicks, Underdog, Sleeper: EV >= 0 at the repriced payout (standard x P(all, independent) / P(all, model)). DK Pick6: EV >= 0 at its own table.';
// one line for the page: six-leg (3+3) held-out sweeps, pooled over the fitted buckets, series-weighted
{
  let n = 0, obs = 0, mod = 0, cur = 0, ind = 0;
  const games = [];
  for (const [g, gp] of Object.entries(params.games)) {
    let any = false;
    for (const h of Object.values(gp.heldOut || {})) {
      if (!h.six) continue;
      any = true;
      const shipped = h.ships === 'fitted' ? h.six.model : h.ships === 'current' ? h.six.current : h.six.independent;
      n += h.series; obs += h.series * h.six.obs; mod += h.series * shipped; cur += h.series * (h.six.current ?? h.six.independent); ind += h.series * h.six.independent;
    }
    if (any) games.push(g.toUpperCase());
  }
  const pc = x => `${(x / n * 100).toFixed(1)}%`;
  if (n) params.heldOut = { window: `the latest 30% of series, ${games.join(', ')}`, series: n,
    ships: Object.fromEntries(['fitted', 'current', 'independent'].map(k => [k, Object.values(params.games).reduce((a, gp) => a + Object.values(gp.heldOut || {}).filter(h => h.ships === k).length, 0)])),
    summary: `six-leg one-side stacks (3+3) swept ${pc(obs)}; the shipped link said ${pc(mod)}, the old link ${pc(cur)}, independent ${pc(ind)} (trailing-average lines, not app lines)` };
}
if (outFile) fs.writeFileSync(outFile, JSON.stringify({ report, params }, null, 1));
if (process.env.SEED) fs.writeFileSync(process.env.SEED, JSON.stringify(params, null, 1) + '\n');
