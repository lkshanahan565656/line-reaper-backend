// Held-out backtest of the NFL game-line model against Kalshi
// (checks/nfl-gameline-2026-10-25/PREREGISTERED.md).
//   node scripts/nflmodel-backtest.js <games.csv> <k-KXNFLGAME.json.gz> <k-KXNFLSPREAD.json.gz> <k-KXNFLTOTAL.json.gz> [out.json]
// Every game from 2025-01-01 Kalshi listed: our chance from ratings built only
// on earlier finals with the frozen parameters, Kalshi's price 60 minutes
// before kickoff, Kalshi's mid at kickoff, the market close (nflverse) and
// the final. Bets: our chance 3+ (and 5+) points over Kalshi's cost with fee.
const fs = require('fs'), zlib = require('zlib');
const M = require('../nflmodel');
const P = require('../seeds/nflmodel-params.json');
const [csv, kGame, kSpread, kTotal, outPath = 'seeds/nflmodel-backtest.json'] = process.argv.slice(2);
const TEST_FROM = Date.parse('2025-01-01T00:00:00Z'), TEST_TO = Date.parse(process.env.TEST_TO || '2026-10-25T00:00:00Z');
const load = f => (f && fs.existsSync(f) ? JSON.parse(zlib.gunzipSync(fs.readFileSync(f))) : []);
const fee = p => 0.07 * p * (1 - p);
const r4 = x => (x == null || !Number.isFinite(x) ? null : Math.round(x * 1e4) / 1e4);
const clampP = p => Math.min(1 - 1e-4, Math.max(1e-4, p));
const logit = p => Math.log(clampP(p) / (1 - clampP(p)));
const toProb = a => (a > 0 ? 100 / (a + 100) : -a / (-a + 100));
function devig2(a, b) {
  const pa = toProb(a), pb = toProb(b);
  let lo = 1, hi = 3;
  for (let i = 0; i < 60; i++) { const k = (lo + hi) / 2; if (pa ** k + pb ** k > 1) lo = k; else hi = k; }
  return pa ** ((lo + hi) / 2);
}

// ── games with our pre-game prediction ──
const games = M.parseNflverse(fs.readFileSync(csv, 'utf8'));
const R = M.createRatings(P);
const testGames = [];
for (const g of games) {
  if (!g.done) continue;
  if (g.kickoff >= TEST_FROM && g.kickoff < TEST_TO) {
    const pred = R.predict(g);
    testGames.push({ ...g, pred, ch: M.chances(pred, P), mk: g.spread != null && g.total != null ? M.marketChances(g.spread, g.total, P) : null,
      mlClose: g.homeMl != null && g.awayMl != null ? devig2(g.homeMl, g.awayMl) : null });
  }
  R.update(g);
}

// ── Kalshi tickers → games ──
// team code spellings Kalshi may use
const VAR = { LA: ['LA', 'LAR'], WAS: ['WAS', 'WSH'], JAX: ['JAX', 'JAC'], LV: ['LV', 'LVR'], NE: ['NE', 'NWE'], NO: ['NO', 'NOR'], GB: ['GB', 'GNB'], KC: ['KC', 'KAN'], SF: ['SF', 'SFO'], TB: ['TB', 'TAM'] };
const vars = c => VAR[c] || [c];
const MON = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
const byDay = new Map();
for (const g of testGames) { const d = g.day; if (!byDay.has(d)) byDay.set(d, []); byDay.get(d).push(g); }
function gameOfEvent(ev) {
  const m = String(ev).match(/-(\d{2})([A-Z]{3})(\d{2})([A-Z]+)$/);
  if (!m) return null;
  const day = `20${m[1]}-${String(MON[m[2]] + 1).padStart(2, '0')}-${m[3]}`;
  for (const g of byDay.get(day) || []) {
    for (const a of vars(g.away)) for (const h of vars(g.home)) if (m[4] === a + h || m[4] === h + a) return g;
  }
  return null;
}
function teamOfSuffix(sfx, g) {
  const s = String(sfx).replace(/\d+$/, '');
  if (vars(g.home).includes(s)) return 'home';
  if (vars(g.away).includes(s)) return 'away';
  return null;
}

// a candle list → the last quote at or before t (within maxBack), {ask, bid}
function quoteAt(cands, tSec, maxBackSec) {
  let best = null;
  for (const c of cands || []) {
    if (c[0] > tSec || c[0] < tSec - maxBackSec) continue;
    if (c[1] == null || c[2] == null || !(c[1] > 0) || !(c[2] >= 0)) continue;
    if (!best || c[0] > best[0]) best = c;
  }
  return best ? { ask: best[1], bid: best[2], ts: best[0] } : null;
}
const volBefore = (cands, tSec) => (cands || []).reduce((a, c) => a + (c[0] <= tSec ? (c[3] || 0) : 0), 0);

// each Kalshi market → a priced contract row
const rows = [], miss = { noGame: 0, noSide: 0, noQuote: 0, wide: 0, noVol: 0 };
for (const [type, list] of [['ml', load(kGame)], ['spread', load(kSpread)], ['total', load(kTotal)]]) {
  for (const k of list) {
    const g = gameOfEvent(k.ev);
    if (!g) { miss.noGame++; continue; }
    const sfx = String(k.t).split('-').pop();
    let yesKey, line = null;
    if (type === 'ml') { const side = teamOfSuffix(sfx, g); if (!side) { miss.noSide++; continue; } yesKey = `ml|${side}`; }
    else if (type === 'spread') {
      const side = teamOfSuffix(sfx, g); line = k.strike;
      if (!side || !Number.isFinite(line)) { miss.noSide++; continue; }
      yesKey = `spread|${side}|${line}`;                // side wins by more than line
    } else { line = k.strike; if (!Number.isFinite(line)) { miss.noSide++; continue; } yesKey = `total|over|${line}`; }
    const kick = Math.floor(g.kickoff / 1000), bet = kick - 3600;
    const q = quoteAt(k.mi, bet, 30 * 60) || quoteAt(k.h, bet, 2 * 3600);
    if (!q) { miss.noQuote++; continue; }
    if (q.ask - q.bid > 0.2 || q.ask >= 1 || q.bid <= 0) { miss.wide++; continue; }
    if (volBefore(k.mi, bet) + volBefore(k.h, bet - 3600) <= 0) { miss.noVol++; continue; }
    const cq = quoteAt(k.mi, kick - 60, 30 * 60) || quoteAt(k.h, kick, 2 * 3600);
    const kClose = cq && cq.ask - cq.bid <= 0.2 ? (cq.ask + cq.bid) / 2 : null;
    // our chance, the market close's, the outcome, all of YES
    const m = g.homeScore - g.awayScore, t = g.homeScore + g.awayScore;
    let pModel, pClose, win;
    if (type === 'ml') {
      const home = yesKey.endsWith('home');
      pModel = home ? g.ch.pHome : 1 - g.ch.pHome;
      pClose = g.mlClose == null ? null : home ? g.mlClose : 1 - g.mlClose;
      win = m === 0 ? null : (m > 0) === home;
    } else if (type === 'spread') {
      const home = yesKey.startsWith('spread|home');
      pModel = home ? g.ch.home(line) : g.ch.away(line);
      pClose = g.mk ? (home ? g.mk.home(line) : g.mk.away(line)) : null;
      const tm = home ? m : -m;
      win = tm === line ? null : tm > line;
    } else {
      pModel = g.ch.over(line); pClose = g.mk ? g.mk.over(line) : null;
      win = t === line ? null : t > line;
    }
    rows.push({ type, gid: g.id, season: g.season, gtype: g.type, ticker: k.t, yesKey, line, ask: q.ask, bid: q.bid, mid: (q.ask + q.bid) / 2, kClose, pModel: r4(pModel), pClose: r4(pClose), win, vol: k.vol });
  }
}

// ── scoring ──
const mean = a => (a.length ? a.reduce((x, v) => x + v, 0) / a.length : null);
function tOf(a) { if (a.length < 3) return null; const m = mean(a); const sd = Math.sqrt(a.reduce((x, v) => x + (v - m) ** 2, 0) / (a.length - 1)); return sd > 0 ? r4(m / (sd / Math.sqrt(a.length))) : null; }
// game-clustered t: one mean per game
function clusterT(items, val) { const g = new Map(); for (const x of items) { if (!g.has(x.gid)) g.set(x.gid, []); g.get(x.gid).push(val(x)); } const per = [...g.values()].map(mean); return { games: per.length, t: tOf(per) }; }
const ll = (p, y) => -(y ? Math.log(clampP(p)) : Math.log(1 - clampP(p)));
// logistic outcome ~ a + b1 logit(kalshi) + b2 logit(model), game-clustered sandwich SEs
function blend(rs) {
  const X = rs.map(r => [1, logit(r.mid), logit(r.pModel)]), y = rs.map(r => (r.win ? 1 : 0));
  let b = [0, 1, 0];
  const inv3 = A => { const [a, b1, c, d, e, f, g, h, i] = A.flat(); const det = a * (e * i - f * h) - b1 * (d * i - f * g) + c * (d * h - e * g);
    return [[(e * i - f * h) / det, (c * h - b1 * i) / det, (b1 * f - c * e) / det], [(f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det], [(d * h - e * g) / det, (b1 * g - a * h) / det, (a * e - b1 * d) / det]]; };
  let H = null;
  for (let it = 0; it < 30; it++) {
    const g = [0, 0, 0]; H = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (let i = 0; i < X.length; i++) { const z = X[i].reduce((a, v, j) => a + v * b[j], 0), p = 1 / (1 + Math.exp(-z)); for (let j = 0; j < 3; j++) { g[j] += (y[i] - p) * X[i][j]; for (let k = 0; k < 3; k++) H[j][k] += p * (1 - p) * X[i][j] * X[i][k]; } }
    const Hi = inv3(H); const step = Hi.map(row => row.reduce((a, v, j) => a + v * g[j], 0));
    b = b.map((v, j) => v + step[j]);
    if (Math.max(...step.map(Math.abs)) < 1e-8) break;
  }
  const Hi = inv3(H);
  const meat = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], cl = new Map();
  for (let i = 0; i < X.length; i++) { const z = X[i].reduce((a, v, j) => a + v * b[j], 0), p = 1 / (1 + Math.exp(-z)); const s = X[i].map(v => (y[i] - p) * v); const k = rs[i].gid; if (!cl.has(k)) cl.set(k, [0, 0, 0]); const c = cl.get(k); for (let j = 0; j < 3; j++) c[j] += s[j]; }
  for (const c of cl.values()) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) meat[j][k] += c[j] * c[k];
  const V = Hi.map(r => [0, 1, 2].map(k => r.reduce((a, v, j) => a + v * meat[j].reduce((a2, m2, l) => a2 + m2 * Hi[l][k], 0), 0)));
  return { kalshiW: r4(b[1]), modelW: r4(b[2]), modelT: r4(b[2] / Math.sqrt(V[2][2])), kalshiT: r4(b[1] / Math.sqrt(V[1][1])), games: cl.size };
}
function betsOf(rs, pts) {
  const out = [];
  for (const r of rs) {
    const yesCost = r.ask + fee(r.ask), noPrice = 1 - r.bid, noCost = noPrice + fee(noPrice);
    for (const [side, p, cost, pc, kc] of [['yes', r.pModel, yesCost, r.pClose, r.kClose], ['no', 1 - r.pModel, noCost, r.pClose == null ? null : 1 - r.pClose, r.kClose == null ? null : 1 - r.kClose]]) {
      if (p - cost < pts) continue;
      const won = r.win == null ? null : side === 'yes' ? r.win : !r.win;
      out.push({ gid: r.gid, side, cost, p, profit: won == null ? 0 : won ? (1 - cost) / cost : -1, push: won == null, won,
        clvClose: pc != null ? pc / cost - 1 : null, clvKalshi: kc != null ? kc / cost - 1 : null, pc });
    }
  }
  return out;
}
function summary(bs) {
  const graded = bs.filter(b => !b.push);
  const cc = bs.filter(b => b.clvClose != null), ck = bs.filter(b => b.clvKalshi != null);
  const roiT = clusterT(graded, b => b.profit), clvT = clusterT(cc, b => b.clvClose), kT = clusterT(ck, b => b.clvKalshi);
  const units = graded.reduce((a, b) => a + b.profit, 0);
  const exp = graded.filter(b => b.pc != null).reduce((a, b) => a + b.pc / b.cost - 1, 0);
  const sd = Math.sqrt(graded.filter(b => b.pc != null).reduce((a, b) => a + b.pc * (1 - b.pc) / (b.cost * b.cost), 0));
  return { n: bs.length, graded: graded.length, wins: graded.filter(b => b.won).length, roi: r4(graded.length ? units / graded.length : null), roiT: roiT.t, units: r4(units),
    clvClose: r4(mean(cc.map(b => b.clvClose))), clvCloseT: clvT.t, clvKalshi: r4(mean(ck.map(b => b.clvKalshi))), clvKalshiT: kT.t, games: clvT.games,
    resultsVsCloseZ: sd > 0 ? r4((units - exp) / sd) : null };
}
const report = { generated: new Date().toISOString(), prereg: 'checks/nfl-gameline-2026-10-25/PREREGISTERED.md', testFrom: '2025-01-01', testTo: new Date(TEST_TO).toISOString().slice(0, 10),
  params: P.fitted, miss, contracts: rows.length, games: new Set(rows.map(r => r.gid)).size, types: {} };
for (const type of ['ml', 'spread', 'total']) {
  const rs = rows.filter(r => r.type === type && r.win != null);
  if (!rs.length) { report.types[type] = { n: 0 }; continue; }
  const llK = mean(rs.map(r => ll(r.mid, r.win))), llM = mean(rs.map(r => ll(r.pModel, r.win)));
  const rsC = rs.filter(r => r.pClose != null);
  const brier = f => mean(rs.map(r => (f(r) - (r.win ? 1 : 0)) ** 2));
  const gapT = clusterT(rs, r => ll(r.pModel, r.win) - ll(r.mid, r.win));
  const b3 = summary(betsOf(rs, 0.03)), b5 = summary(betsOf(rs, 0.05));
  const pass = b3.n >= 50 && b3.clvClose > 0 && (b3.clvCloseT ?? 0) >= 2 && b3.roi > 0 && !((b3.resultsVsCloseZ ?? 0) <= -1.5);
  report.types[type] = { contracts: rs.length, games: new Set(rs.map(r => r.gid)).size,
    logLoss: { kalshiT60: r4(llK), model: r4(llM), modelMinusKalshiT: gapT.t, marketClose: rsC.length ? r4(mean(rsC.map(r => ll(r.pClose, r.win)))) : null, marketCloseN: rsC.length },
    brier: { kalshiT60: r4(brier(r => r.mid)), model: r4(brier(r => r.pModel)) },
    blend: blend(rs), bets3: b3, bets5: b5, verdict: pass ? 'PASS' : 'FAIL' };
}
report.verdict = Object.values(report.types).some(t => t.verdict === 'PASS') ? 'at least one market type passed the pre-registered bar' : 'no market type passed: model, not an edge';
fs.writeFileSync(outPath, JSON.stringify(report, null, 1));
console.log(JSON.stringify(report, null, 1));
