// Held-out backtest of the soccer match model against Kalshi and Polymarket
// (checks/soccer-model-2026-10-25/PREREGISTERED.md).
//   node scripts/soccermodel-backtest.js <football-data dir> <data dir with k-*.json.gz, pm-*.json.gz> [out.json]
// Every three-way contract since 2025-07-01 in a league football-data covers:
// our chance from ratings built only on earlier finals with the frozen
// parameters, the exchange's price 60 minutes before kickoff with its fee, its
// mid a minute before kickoff, Pinnacle's closing no-vig price (football-data)
// and the final. Bets: our chance 3+ (and 5+) points over the all-in cost.
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const M = require('../soccermodel');
const P = require('../seeds/soccermodel-params.json');
const { loadFd } = require('./soccer-load');
const [fdDir, dataDir, outPath = 'seeds/soccermodel-backtest.json'] = process.argv.slice(2);
const TEST_FROM = Date.parse('2025-07-01T00:00:00Z'), SPLIT = Date.parse('2026-04-01T00:00:00Z'), TEST_TO = Date.parse(process.env.TEST_TO || '2026-10-25T00:00:00Z');
const load = f => JSON.parse(zlib.gunzipSync(fs.readFileSync(f)));
const r4 = x => (x == null || !Number.isFinite(x) ? null : Math.round(x * 1e4) / 1e4);
const clampP = p => Math.min(1 - 1e-4, Math.max(1e-4, p));
const logit = p => Math.log(clampP(p) / (1 - clampP(p)));
const kalshiFee = p => Math.ceil(7 * p * (1 - p)) / 100;           // per contract, one at a time (worst case)
const pmusFee = p => 0.0695 * p * (1 - p);
const mean = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const sdev = a => { const m = mean(a); return a.length > 1 ? Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)) : null; };
const tOf = a => (a.length > 2 && sdev(a) > 0 ? r4(mean(a) / (sdev(a) / Math.sqrt(a.length))) : null);

const KALSHI_LEAGUE = { KXEPLGAME: 'E0', KXEFLCHAMPIONSHIPGAME: 'E1', KXLALIGAGAME: 'SP1', KXSERIEAGAME: 'I1', KXBUNDESLIGAGAME: 'D1', KXLIGUE1GAME: 'F1', KXEREDIVISIEGAME: 'N1',
  KXLIGAPORTUGALGAME: 'P1', KXPRIMEIRALIGAGAME: 'P1', KXMLSGAME: 'USA', KXLIGAMXGAME: 'MEX', KXBRASILEIROGAME: 'BRA', KXBUNDESLIGA2GAME: 'D2', KXSERIEBGAME: 'I2', KXLIGUE2GAME: 'F2',
  KXSCOTTISHPREMGAME: 'SC0', KXLALIGA2GAME: 'SP2', KXEFLLEAGUEONEGAME: 'E2', KXARGPDGAME: 'ARG', KXJLEAGUEGAME: 'JPN', KXALLSVENSKANGAME: 'SWE', KXELITESERIENGAME: 'NOR' };
const PM_LEAGUE = { epl: 'E0', lal: 'SP1', elc: 'E1', sea: 'I1', bun: 'D1', fl1: 'F1', ere: 'N1', por: 'P1', mls: 'USA', mex: 'MEX' };

// ── football-data matches with our pre-match chances ──
const matches = loadFd(fdDir);
const byLeague = new Map();
M.walk(matches, P, { from: TEST_FROM - 3 * 86400e3, to: TEST_TO, onPredict: (m, p) => {
  if (!byLeague.has(m.league)) byLeague.set(m.league, []);
  byLeague.get(m.league).push({ ...m, p });
} });
// an exchange's two team names and a rough time → the football-data match (either way round)
function findMatch(league, a, b, t, slackMs = 36 * 3600e3) {
  const hits = (byLeague.get(league) || []).filter(m => Math.abs(m.kickoff - t) < slackMs && ((M.sameClub(m.home, a) && M.sameClub(m.away, b)) || (M.sameClub(m.home, b) && M.sameClub(m.away, a))));
  return hits.length === 1 ? hits[0] : null;
}
const outOf = m => (m.hg > m.ag ? 'h' : m.hg === m.ag ? 'd' : 'a');

// ── Kalshi: one event = three contracts (home, tie, away) ──
const MON = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
function tickerDay(ev) { const m = /-(\d{2})([A-Z]{3})(\d{2})/.exec(ev || ''); return m ? Date.UTC(2000 + Number(m[1]), MON[m[2]], Number(m[3]), 15) : null; }
const lastAt = (rows, tsSec, i) => { let v = null; for (const r of rows || []) { if (r[0] > tsSec) break; if (r[i] != null && r[i] > 0 && r[i] < 1) v = r[i]; } return v; };
const unmatched = { kalshi: 0, pm: 0 }, matchedEv = { kalshi: 0, pm: 0 };
const rows = [];   // { venue, league, kickoff, pick, model, cost, mid, close, pin, win }
function kalshiRows(file) {
  const ms = load(file);
  const evs = new Map();
  for (const m of ms) { if (!evs.has(m.ev)) evs.set(m.ev, []); evs.get(m.ev).push(m); }
  for (const [ev, list] of evs) {
    const league = KALSHI_LEAGUE[list[0].s];
    if (!league) continue;
    const teams = list.filter(m => !/^(tie|draw)$/i.test(m.sub || '')).map(m => m.sub);
    if (teams.length !== 2) continue;
    const t = tickerDay(ev);
    const fm = t != null ? findMatch(league, teams[0], teams[1], t) : null;
    if (!fm) { unmatched.kalshi++; continue; }
    matchedEv.kalshi++;
    const k60 = Math.floor((fm.kickoff - 60 * 60e3) / 1000), k1 = Math.floor((fm.kickoff - 60e3) / 1000);
    // the three asks at T-60 must look like a pre-match book (a moved kickoff leaves an in-play or settled one)
    const asks = list.map(m => lastAt(m.mi, k60, 1));
    const sum = asks.reduce((s, a) => s + (a ?? NaN), 0);
    if (list.length !== 3 || !(sum >= 0.98 && sum <= 1.2)) { unmatched.kalshiBook = (unmatched.kalshiBook || 0) + 1; continue; }
    for (const m of list) {
      const pick = /^(tie|draw)$/i.test(m.sub || '') ? 'd' : M.sameClub(fm.home, m.sub) && !M.sameClub(fm.away, m.sub) ? 'h' : M.sameClub(fm.away, m.sub) && !M.sameClub(fm.home, m.sub) ? 'a' : null;
      if (!pick) continue;
      const ask = lastAt(m.mi, k60, 1), bid = lastAt(m.mi, k60, 2);
      const askC = lastAt(m.mi, k1, 1), bidC = lastAt(m.mi, k1, 2);
      if (ask == null) continue;
      const win = outOf(fm) === pick;
      if ((m.res === 'yes') !== win) { unmatched.kalshiResult = (unmatched.kalshiResult || 0) + 1; continue; }   // a wrong match or a void
      rows.push({ venue: 'kalshi', league, kickoff: fm.kickoff, game: `${fm.home} v ${fm.away}`, pick, model: fm.p[pick], cost: r4(ask + kalshiFee(ask)), ask,
        mid: bid != null ? r4((ask + bid) / 2) : null, close: askC != null && bidC != null ? r4((askC + bidC) / 2) : null, pin: fm.close ? fm.close[pick] : null, win });
    }
  }
}
// ── Polymarket: one event = three Yes/No markets ("Will X win?", "draw") ──
function pmRows(file) {
  for (const ev of load(file)) {
    const league = PM_LEAGUE[ev.code];
    if (!league || ev.mk.length !== 3 || !ev.mk.every(m => m.type === 'moneyline')) continue;
    const draw = ev.mk.find(m => /draw/i.test(m.group || m.q || '')), sides = ev.mk.filter(m => m !== draw);
    if (!draw || sides.length !== 2) continue;
    const fm = findMatch(league, sides[0].group, sides[1].group, ev.start, 6 * 3600e3);
    if (!fm) { unmatched.pm++; continue; }
    matchedEv.pm++;
    // a kickoff the two sources disagree on (moved games) or a book already in play at T-60: out
    if (Math.abs(fm.kickoff - ev.start) > 20 * 60e3) { unmatched.pmTime = (unmatched.pmTime || 0) + 1; continue; }
    const start = ev.start;   // Polymarket's own kickoff; minutes in mi are relative to it
    const at60 = m => { let v = null; for (const [mm, p] of m.mi || []) { if (mm > -60) break; if (p > 0 && p < 1) v = p; } return v; };
    const sum = ev.mk.reduce((s, m) => s + (at60(m) ?? NaN), 0);
    if (!(sum >= 0.95 && sum <= 1.08)) { unmatched.pmBook = (unmatched.pmBook || 0) + 1; continue; }
    for (const m of ev.mk) {
      const pick = m === draw ? 'd' : M.sameClub(fm.home, m.group) && !M.sameClub(fm.away, m.group) ? 'h' : M.sameClub(fm.away, m.group) && !M.sameClub(fm.home, m.group) ? 'a' : null;
      if (!pick) continue;
      const at = mins => { let v = null; for (const [mm, p] of m.mi || []) { if (mm > mins) break; if (p > 0 && p < 1) v = p; } return v; };
      const p60 = at(-60), p1 = at(-1);
      if (p60 == null) continue;
      const settled = (m.prices || []).map(Number);
      const win = outOf(fm) === pick;
      if (settled.length === 2 && (settled[0] > 0.5) !== win) { unmatched.pmResult = (unmatched.pmResult || 0) + 1; continue; }
      const ask = Math.min(0.99, p60 + 0.005);   // history is a mid-ish price: half a cent to the ask
      rows.push({ venue: 'polymarket', league, kickoff: start, game: `${fm.home} v ${fm.away}`, pick, model: fm.p[pick], cost: r4(ask + pmusFee(ask)), ask, mid: p60, close: p1, pin: fm.close ? fm.close[pick] : null, win });
    }
  }
}
for (const f of fs.readdirSync(dataDir)) {
  if (/^k-KX.*GAME\.json\.gz$/.test(f)) kalshiRows(path.join(dataDir, f));
  else if (/^pm-[a-z0-9]+\.json\.gz$/.test(f)) pmRows(path.join(dataDir, f));
}

// ── read-outs ──
// logistic blend: outcome ~ a + b·logit(exchange mid) + c·logit(model), Newton steps
function blend(rs) {
  const X = rs.map(r => [1, logit(r.mid), logit(r.model)]), y = rs.map(r => (r.win ? 1 : 0));
  let w = [0, 1, 0];
  for (let it = 0; it < 30; it++) {
    const g = [0, 0, 0], H = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (let i = 0; i < X.length; i++) {
      const z = X[i].reduce((s, x, j) => s + x * w[j], 0), p = 1 / (1 + Math.exp(-z));
      for (let j = 0; j < 3; j++) { g[j] += (y[i] - p) * X[i][j]; for (let k = 0; k < 3; k++) H[j][k] += p * (1 - p) * X[i][j] * X[i][k]; }
    }
    const inv = inv3(H), step = [0, 1, 2].map(j => [0, 1, 2].reduce((s, k) => s + inv[j][k] * g[k], 0));
    w = w.map((x, j) => x + step[j]);
    if (Math.max(...step.map(Math.abs)) < 1e-8) break;
  }
  const H = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < X.length; i++) { const z = X[i].reduce((s, x, j) => s + x * w[j], 0), p = 1 / (1 + Math.exp(-z)); for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) H[j][k] += p * (1 - p) * X[i][j] * X[i][k]; }
  const se = Math.sqrt(inv3(H)[2][2]);
  return { market: r4(w[1]), model: r4(w[2]), modelT: r4(w[2] / se) };
}
function inv3(m) {
  const [[a, b, c], [d, e, f], [g, h, i]] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g, det = a * A + b * B + c * C;
  return [[A / det, -(b * i - c * h) / det, (b * f - c * e) / det], [B / det, (a * i - c * g) / det, -(a * f - c * d) / det], [C / det, -(a * h - b * g) / det, (a * e - b * d) / det]];
}
const ll = (rs, f) => r4(mean(rs.map(r => -Math.log(clampP(r.win ? f(r) : 1 - f(r))))));
function bets(rs, pts) {
  const b = rs.filter(r => r.model - r.cost >= pts);
  const profit = b.map(r => (r.win ? (1 - r.cost) / r.cost : -1));
  // z vs break-even: wins against the chances the costs imply
  const exp = b.reduce((s, r) => s + r.cost, 0), vr = b.reduce((s, r) => s + r.cost * (1 - r.cost), 0), wins = b.filter(r => r.win).length;
  const clv = b.filter(r => r.pin != null).map(r => r.pin / r.cost - 1);
  const exClv = b.filter(r => r.close != null).map(r => r.close / r.cost - 1);
  return { n: b.length, wins, roi: r4(mean(profit)), z: vr > 0 ? r4((wins - exp) / Math.sqrt(vr)) : null,
    clvPin: { n: clv.length, mean: r4(mean(clv)), t: tOf(clv) }, clvExchange: { n: exClv.length, mean: r4(mean(exClv)), t: tOf(exClv) } };
}
function readout(rs) {
  const withMid = rs.filter(r => r.mid != null);
  const withPin = rs.filter(r => r.pin != null);
  return { contracts: rs.length, games: new Set(rs.map(r => `${r.game}|${r.kickoff}`)).size,
    logLoss: { model: ll(withMid, r => r.model), exchange: ll(withMid, r => r.mid), n: withMid.length,
      modelOnPin: ll(withPin, r => r.model), pinnacleClose: ll(withPin, r => r.pin), nPin: withPin.length },
    blend: withMid.length > 50 ? blend(withMid) : null,
    exchangeVsPinnacle: (() => { const d = withPin.filter(r => r.mid != null).map(r => r.pin - r.mid); return { n: d.length, meanGap: r4(mean(d)) }; })(),
    bets3: bets(rs, 0.03), bets5: bets(rs, 0.05),
    byPick: Object.fromEntries(['h', 'd', 'a'].map(k => [k, bets(rs.filter(r => r.pick === k), 0.03)])) };
}
const out = { verdict: null, testFrom: '2025-07-01', split: '2026-04-01', testTo: new Date(TEST_TO).toISOString().slice(0, 10), params: { ...P, fitted: undefined }, fitted: P.fitted,
  matched: matchedEv, unmatched, venues: {} };
let pass = true;
for (const venue of ['kalshi', 'polymarket']) {
  const rs = rows.filter(r => r.venue === venue && r.kickoff >= TEST_FROM && r.kickoff < TEST_TO);
  if (!rs.length) { out.venues[venue] = null; continue; }
  const s1 = rs.filter(r => r.kickoff < SPLIT), s2 = rs.filter(r => r.kickoff >= SPLIT);
  const v = { all: readout(rs), slice1: readout(s1), slice2: readout(s2),
    byLeague: Object.fromEntries([...new Set(rs.map(r => r.league))].map(l => [l, (({ contracts, logLoss, bets3 }) => ({ contracts, logLoss, bets3 }))(readout(rs.filter(r => r.league === l)))])) };
  const ok = s => s.bets3.n >= 50 && s.bets3.z >= 2 && s.bets3.clvPin.mean > 0 && s.bets3.clvPin.t >= 2;
  v.verdict = ok(v.slice1) && ok(v.slice2) ? 'PASS' : 'FAIL';
  if (v.verdict !== 'PASS') pass = false;
  out.venues[venue] = v;
}
out.verdict = pass ? 'PASS' : 'FAIL';
if (process.env.DUMP) fs.writeFileSync(process.env.DUMP, JSON.stringify(rows));
fs.writeFileSync(outPath, JSON.stringify(out, null, 1) + '\n');
console.log(JSON.stringify(out, (k, v) => (k === 'params' ? undefined : v), 1));
