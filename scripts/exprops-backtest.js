// Backtest of the EXCHANGE PROPS rules (exprops.js, checks/kxprops-2026-10-26/PREREGISTERED.md)
// on the 10-24..10-26 weekend: Kalshi 1-minute candles and every trade
// (diag-kxprops-out*: markets.json.gz, hist-*.json.gz, series.json) against
// Pinnacle's props read every 2 minutes by the weekend recorders
// (nflsun-/board-20261025-out-N changes.jsonl, Pinnacle lines only).
//   node scripts/exprops-backtest.js --data <dir> --pin <dir> [--json out.json] [--seed seeds/exchange-props-backtest.json]
// Kalshi's settlement is the result. The backtest has no order-book history:
// its size is the contracts traded at or better than the flag price in the
// next 10 minutes (a floor), never the book.
const fs = require('fs'), zlib = require('zlib'), path = require('path');
const R = require('path').join(__dirname, '..');
const { canonName } = require(R + '/ev');
const { devigPower: devigPow } = require(R + '/pinprops');
// DEVIG=mul re-prices on the multiplicative split (a sensitivity check; power is the rule)
const devigPower = process.env.DEVIG === 'mul' ? (a, b) => a / (a + b) : devigPow;
const fees = require(R + '/fees');
const args = process.argv.slice(2); const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const D = opt('--data', 'data'), PIN = opt('--pin', 'pin');
const EDGE = Number(process.env.EDGE || 0.02);
const MKEY = { KXNFLRECYDS: 'rec_yds', KXNFLREC: 'receptions', KXNFLPASSTDS: 'pass_tds', KXNFLPASSCOMP: 'pass_comp', KXNFLRSHATT: 'rush_att',
  KXNFLPASSYDS: 'pass_yds', KXNFLRSHYDS: 'rush_yds', KXNFLTD: 'anytime_td', KXNFLPASSATT: 'pass_att', KXNFLPASSINT: 'pass_ints',
  KXNBAPTS: 'points', KXNBAAST: 'assists', KXNBAREB: 'rebounds', KXNBA3PT: 'threes', KXNBAPRA: 'pra', KXNBASTL: 'steals', KXNBABLK: 'blocks',
  KXNHLPTS: 'points', KXNHLGOAL: 'goals', KXNHLAST: 'assists', KXNHLSAVE: 'saves' };
const sportOf = s => s.slice(2, 5);
const toProb = a => (a > 0 ? 100 / (a + 100) : -a / (-a + 100));
const takerFee = p => fees.orderFee('kalshi', p, 100, { rate: 0.07, round: true }) / 100;
// ── Pinnacle timelines
const pin = new Map(), spans = [];
for (const f of fs.readdirSync(PIN)) {
  let t0 = Infinity, t1 = 0;
  for (const l of fs.readFileSync(path.join(PIN, f), 'utf8').split('\n')) {
    if (!l) continue; const r = JSON.parse(l);
    t0 = Math.min(t0, r.t); t1 = Math.max(t1, r.t);
    const [a, b, c] = r.k.split('|'); const key = c ? r.k : `NFL|${a}|${b}`;
    if (!pin.has(key)) pin.set(key, { st: null, rec: [] });
    const P = pin.get(key); if (r.m?.st) P.st = r.m.st; if (r.m?.p) P.player = r.m.p;
    P.rec.push({ t: r.t, v: r.gone ? null : r.v[0] });
  }
  spans.push([t0, t1 + 3 * 60e3]);
}
for (const P of pin.values()) P.rec.sort((a, b) => a.t - b.t);
const inSpan = t => spans.some(([a, b]) => t >= a && t <= b);
function pinAt(P, t) {   // last record ≤ t, during a recorder run
  if (!inSpan(t)) return null;
  let v = null; for (const r of P.rec) { if (r.t > t) break; v = r.v; }
  return v;
}
// ── Kalshi
const M = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(D, 'markets.json.gz'))));
const H = new Map();
for (const f of fs.readdirSync(D).filter(f => /^hist/.test(f))) for (const h of JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(D, f))))) H.set(h.t, h);
const ser = JSON.parse(fs.readFileSync(path.join(D, 'series.json')));
const makerRate = s => (ser.find(x => x.t === s)?.ft === 'quadratic_with_maker_fees' ? 0.0175 : 0);
const census = {}, bets = [], makers = [];
for (const m of M) {
  const mkey = MKEY[m.s]; if (!mkey || m.st !== 'greater') continue;
  const sp = sportOf(m.s), c = (census[`${sp} ${mkey}`] ||= { rungs: 0, withHist: 0, pinPlayer: 0, exactLine: 0, vol: 0 });
  const exp = Date.parse(m.exp);
  if (!(exp > Date.parse('2026-10-24T18:00:00Z') && exp < Date.parse('2026-10-26T14:00:00Z'))) continue;
  c.rungs++; c.vol += m.vol || 0;
  const h = H.get(m.t); if (h) c.withHist++;
  const player = String(m.title || '').split(':')[0].trim();
  const P = pin.get(`${sp}|${canonName(player)}|${mkey}`);
  if (!P || !P.st) continue;
  const st = Date.parse(P.st); if (!(exp - st > 0 && exp - st <= 12 * 3600e3)) continue;
  c.pinPlayer++;
  if (!P.rec.some(r => r.v && Math.abs(r.v[0] - m.fs) < 1e-6)) continue;
  c.exactLine++;
  if (!h || !h.c.length || !(m.result === 'yes' || m.result === 'no')) continue;
  const win = m.result === 'yes';
  // Pinnacle's close: last fair <= 20 min before start (the value standing at st - 1 min)
  const cv = pinAt(P, st - 60e3);
  const lastRec = P.rec.filter(r => r.t <= st).pop();
  const closeOk = cv && Math.abs(cv[0] - m.fs) < 1e-6 && lastRec;
  const pClose = closeOk ? devigPower(toProb(cv[1]), toProb(cv[2])) : null;
  const cs = [...h.c].sort((a, b) => a[0] - b[0]);
  const tr = [...h.tr].sort((a, b) => a[0] - b[0]);
  const flagged = { yes: null, no: null }, mk = { yes: null, no: null };
  let ask = null, bid = null, ci = 0;
  for (let t = st - 24 * 3600e3; t <= st - 2 * 60e3; t += 60e3) {
    while (ci < cs.length && cs[ci][0] * 1000 <= t) { ask = cs[ci][1]; bid = cs[ci][2]; ci++; }
    if (ask == null) continue;
    const v = pinAt(P, t); if (!v || Math.abs(v[0] - m.fs) > 1e-6) { for (const s of ['yes', 'no']) if (mk[s] && !mk[s].end) mk[s].end = t, mk[s].why = 'line off'; continue; }
    const pO = devigPower(toProb(v[1]), toProb(v[2]));
    const side = { yes: { p: pO, price: ask }, no: { p: 1 - pO, price: bid == null ? null : 100 - bid } };
    for (const s of ['yes', 'no']) {
      const { p, price } = side[s];
      // taker
      if (!flagged[s] && price > 0 && price < 100) {
        const pr = price / 100, cost = pr + takerFee(pr), ev = p / cost - 1;
        if (ev >= EDGE) {
          // fill proxy: contracts printed at or better than the price within 10 min, taker on our side
          let size = 0; for (const x of tr) { if (x[0] * 1000 < t) continue; if (x[0] * 1000 > t + 600e3) break; const yp = x[1]; if (s === 'yes' ? (x[3] === 1 && yp <= price) : (x[3] === 0 && 100 - yp <= price)) size += x[2]; }
          flagged[s] = { t, price, cost, p, ev, size };
        }
      }
      // maker: place once, cancel when the edge is gone
      const mr = makerRate(m.s);
      if (!mk[s] && price > 1 && price <= 100) {
        let b = null; for (let x = Math.min(price - 1, 99); x >= 1; x--) { const pr = x / 100, cst = pr + mr * pr * (1 - pr); if (p / cst - 1 >= EDGE) { b = x; break; } }
        if (b) mk[s] = { t, b, cost: b / 100 + mr * (b / 100) * (1 - b / 100), pAt: p };
      } else if (mk[s] && !mk[s].end && p / mk[s].cost - 1 < 0) { mk[s].end = t; mk[s].why = 'fair fell'; }
    }
  }
  const base = { t: m.t, sp, mkey, player, line: m.fs, st: P.st, win, pClose, closeOk: !!closeOk, vol: m.vol };
  for (const s of ['yes', 'no']) {
    const f = flagged[s];
    if (f) {
      const pc = pClose == null ? null : (s === 'yes' ? pClose : 1 - pClose);
      const won = s === 'yes' ? win : !win;
      bets.push({ ...base, side: s, at: f.t, minsBefore: Math.round((st - f.t) / 60e3), price: f.price, cost: +f.cost.toFixed(4), pFlag: +f.p.toFixed(4), ev: +f.ev.toFixed(4), size: f.size,
        pc, clv: pc == null ? null : pc / f.cost - 1, won, profit: won ? 1 / f.cost - 1 : -1 });
    }
    const q = mk[s];
    if (q) {
      const end = Math.min(q.end || Infinity, st);
      let fill = null;
      for (const x of tr) { const tt = x[0] * 1000; if (tt <= q.t) continue; if (tt >= end) break; const ourPrice = s === 'yes' ? x[1] : 100 - x[1]; const takerAgainst = s === 'yes' ? x[3] === 0 : x[3] === 1; if (takerAgainst && ourPrice < q.b) { fill = tt; break; } }
      const pc = pClose == null ? null : (s === 'yes' ? pClose : 1 - pClose);
      const won = s === 'yes' ? win : !win;
      makers.push({ ...base, side: s, placed: q.t, b: q.b, cost: +q.cost.toFixed(4), filled: !!fill, fillAt: fill, cancel: q.why || null,
        pc, clv: fill && pc != null ? pc / q.cost - 1 : null, won, profit: fill ? (won ? 1 / q.cost - 1 : -1) : null });
    }
  }
}
function stats(list) {
  const g = list.filter(b => b.clv != null), n = g.length;
  const mean = n ? g.reduce((a, b) => a + b.clv, 0) / n : null;
  const sd = n > 1 ? Math.sqrt(g.reduce((a, b) => a + (b.clv - mean) ** 2, 0) / (n - 1)) : null;
  const res = list.filter(b => b.profit != null);
  const units = res.reduce((a, b) => a + b.profit, 0);
  const expU = res.filter(b => b.pc != null).reduce((a, b) => a + (b.pc / b.cost - 1), 0);
  const varU = res.filter(b => b.pc != null).reduce((a, b) => a + b.pc * (1 - b.pc) / b.cost ** 2, 0);
  return { bets: list.length, graded: n, clv: mean == null ? null : +(100 * mean).toFixed(2), t: sd ? +(mean / (sd / Math.sqrt(n))).toFixed(2) : null,
    w: res.filter(b => b.profit > 0).length, l: res.filter(b => b.profit < 0).length, units: +units.toFixed(2), expUnits: +expU.toFixed(2), resZ: varU ? +((units - expU) / Math.sqrt(varU)).toFixed(2) : null,
    medSize: list.length ? list.map(b => b.size ?? 0).sort((a, b) => a - b)[Math.floor(list.length / 2)] : null };
}
const group = (list, f) => { const o = {}; for (const b of list) (o[f(b)] ||= []).push(b); return Object.fromEntries(Object.entries(o).sort().map(([k, v]) => [k, stats(v)])); };
const filled = makers.filter(x => x.filled);
const out = { edge: EDGE, census, taker: { all: stats(bets), byKind: group(bets, b => `${b.sp} ${b.mkey}`), bySide: group(bets, b => b.side), byWhen: group(bets, b => b.minsBefore < 30 ? '0-30m' : b.minsBefore < 120 ? '30m-2h' : b.minsBefore < 360 ? '2-6h' : '6h+'), byEv: group(bets, b => b.ev < 0.05 ? '2-5%' : b.ev < 0.10 ? '5-10%' : '10%+') },
  maker: { placed: makers.length, filled: filled.length, all: stats(filled), byKind: group(filled, b => `${b.sp} ${b.mkey}`), placedByKind: Object.fromEntries(Object.entries(group(makers, b => `${b.sp} ${b.mkey}`)).map(([k, v]) => [k, v.bets])) } };
// the same summary and verdict as the live record (exprops.byKind)
const X = require(path.join(R, 'exprops'));
const asLive = [
  ...bets.map(b => ({ id: `t|${b.t}|${b.side}`, role: 'taker', kind: X.kindOf('taker', b.sp, b.mkey), status: 'graded', cost: b.cost, closeFair: b.pc, clv: b.clv, outcome: b.won ? 'win' : 'loss', profit: b.profit, size: b.size })),
  ...makers.map(b => ({ id: `m|${b.t}|${b.side}`, role: 'maker', kind: X.kindOf('maker', b.sp, b.mkey), status: b.filled ? 'graded' : 'unfilled', filled: b.filled, cost: b.cost, closeFair: b.pc, clv: b.filled ? b.clv : null, outcome: b.filled ? (b.won ? 'win' : 'loss') : null, profit: b.filled ? b.profit : null })),
];
// The raw re-check a kind that clears the bar gets (pre-registered): every NHL
// kind beat Pinnacle's close on CLV while its results ran short, and the side
// a bet takes flips with the de-vig (power vs multiplicative), so Pinnacle's
// lopsided NHL prop prices are not a fair the record can stand on.
const RECHECK = { NHL: 'fail (re-check): NHL bids and takes lost to the box score as a league (218 resting bids filled, -30.4u vs +5.8u the close expects, z -2.3) and the side flips with the de-vig, so Pinnacle\'s NHL prop close is not a fair to judge on' };
const kinds = X.byKind(asLive).map(k => {
  const mine = bets.filter(b => X.kindOf('taker', b.sp, b.mkey) === k.kind).map(b => b.size).sort((a, b) => a - b);
  const rc = k.verdict === 'passes the record' && RECHECK[k.league] && !process.env.DEVIG ? { verdict: 'fail (re-check)', recheck: RECHECK[k.league] } : {};
  return { ...k, ...(k.role === 'taker' && mine.length ? { medSize: mine[Math.floor((mine.length - 1) / 2)] } : {}), ...rc };
});
const pooled = { taker: X.summarize(asLive.filter(b => b.role === 'taker')), maker: X.summarize(asLive.filter(b => b.role === 'maker')) };
const games = new Set([...bets, ...makers.filter(m => m.filled)].map(b => b.t.split('-').slice(0, 2).join('-'))).size;
const seed = { at: new Date().toISOString(), data: { from: '2026-10-24T18:22Z', to: '2026-10-26T08:56Z', rungsMatched: Object.values(census).reduce((a, c) => a + c.exactLine, 0), games },
  summary: `Backtest, weekend of 10-24 to 10-26 (Kalshi 1-minute prices and every trade against Pinnacle's props read every 2 minutes; Kalshi's settlement as the result). Taking Kalshi's ask at 2%+ over Pinnacle's fair: ${pooled.taker.graded} graded, CLV ${(100 * (pooled.taker.clv ?? 0)).toFixed(1)}%, ${pooled.taker.won}-${pooled.taker.lost}, ${pooled.taker.profit >= 0 ? '+' : ''}${pooled.taker.profit.toFixed(1)}u. Resting bids: ${pooled.maker.posted} posted, ${Math.round(100 * (pooled.maker.fillRate || 0))}% filled through the bid, ${pooled.maker.graded} graded, CLV ${(100 * (pooled.maker.clv ?? 0)).toFixed(1)}% (t ${pooled.maker.clvT}), ${pooled.maker.won}-${pooled.maker.lost}, ${pooled.maker.profit >= 0 ? '+' : ''}${pooled.maker.profit.toFixed(1)}u vs ${pooled.maker.expected >= 0 ? '+' : ''}${pooled.maker.expected.toFixed(1)}u the close expects. Four kinds reached 50: maker NFL receptions and NHL points failed, maker NBA threes is short of the CLV bar (t 1.2) and lost 10.3u, and maker NHL goals cleared CLV but failed the box-score re-check. Every other kind is under 50. Research only, never pooled for the bar.`,
  pooled, kinds, census };
const jsonOut = opt('--json', null), seedOut = opt('--seed', null);
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify({ ...out, bets, makers }));
if (seedOut) fs.writeFileSync(seedOut, JSON.stringify(seed, null, 1) + '\n');
console.log(seed.summary);
for (const k of kinds) console.log(k.kind.padEnd(34), String(k.graded).padStart(4), 'graded', 'clv', k.clv == null ? '—' : (100 * k.clv).toFixed(2), 't', k.clvT, `${k.won}-${k.lost}`, 'u', k.profit, 'exp', k.expected, 'z', k.z, k.fillRate != null ? `fill ${k.fillRate}` : '', k.verdict);
