// Adds /api/exchange-props to the browser-test recording (e2e/fixtures/snapshot.json.gz).
// The board is rebuilt with exprops.priceRung from real reads at the recording's
// own minute: Kalshi's 1-minute prices (diag-kxprops-out*) and Pinnacle's props
// from the weekend recorders. The live record is empty (nothing had closed then);
// the backtest is seeds/exchange-props-backtest.json.
//   node scripts/exprops-e2e-fixture.js --data <dir> --pin <dir>
const fs = require('fs'), zlib = require('zlib'), path = require('path');
const X = require('../exprops');
const { devigPower } = require('../pinprops');
const args = process.argv.slice(2), opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const D = opt('--data', 'data'), PIN = opt('--pin', 'pin');
const FILE = 'e2e/fixtures/snapshot.json.gz';
const snap = JSON.parse(zlib.gunzipSync(fs.readFileSync(FILE)));
const at = Date.parse(snap.recordedAt);
const MKEY = { KXNFLRECYDS: 'rec_yds', KXNFLREC: 'receptions', KXNFLPASSTDS: 'pass_tds', KXNFLPASSCOMP: 'pass_comp', KXNFLRSHATT: 'rush_att', KXNFLPASSYDS: 'pass_yds', KXNFLRSHYDS: 'rush_yds', KXNFLTD: 'anytime_td', KXNFLPASSATT: 'pass_att', KXNFLPASSINT: 'pass_ints',
  KXNBAPTS: 'points', KXNBAAST: 'assists', KXNBAREB: 'rebounds', KXNBA3PT: 'threes', KXNBAPRA: 'pra', KXNHLPTS: 'points', KXNHLGOAL: 'goals', KXNHLAST: 'assists', KXNHLSAVE: 'saves' };
const toProb = a => (a > 0 ? 100 / (a + 100) : -a / (-a + 100));
// Pinnacle's standing quote per key at the recording's minute
const pin = new Map();
for (const f of fs.readdirSync(PIN)) for (const l of fs.readFileSync(path.join(PIN, f), 'utf8').split('\n')) {
  if (!l) continue; const r = JSON.parse(l); if (r.t > at) continue;
  const [a, b, c] = r.k.split('|'); const key = c ? r.k : `NFL|${a}|${b}`;
  const P = pin.get(key) || { st: null }; if (r.m?.st) P.st = r.m.st; P.v = r.gone ? null : r.v[0]; P.t = r.t; pin.set(key, P);
}
const idx = new Map();
for (const [k, P] of pin) if (P.v && P.st && at - P.t < 6 * 3600e3) idx.set(k, [{ line: P.v[0], pOver: +devigPower(toProb(P.v[1]), toProb(P.v[2])).toFixed(4), start: P.st }]);
const M = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(D, 'markets.json.gz'))));
const H = new Map(); for (const f of fs.readdirSync(D).filter(f => /^hist/.test(f))) for (const h of JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(D, f))))) H.set(h.t, h);
const rungs = [];
for (const m of M) {
  const mkey = MKEY[m.s], h = H.get(m.t);
  if (!mkey || !h || m.st !== 'greater') continue;
  let ask = null, bid = null;
  for (const c of [...h.c].sort((x, y) => x[0] - y[0])) { if (c[0] * 1000 > at) break; ask = c[1]; bid = c[2]; }
  if (ask == null) continue;
  rungs.push({ ticker: m.t, league: m.s.slice(2, 5), player: String(m.title).split(':')[0].trim(), mkey, line: m.fs, start: new Date(Date.parse(m.exp) - 3 * 3600e3).toISOString(),
    yesBid: bid > 0 ? bid / 100 : null, yesAsk: ask < 100 ? ask / 100 : null, eventTicker: m.ev, url: `https://kalshi.com/markets/${String(m.ev).toLowerCase()}` });
}
const board = X.boardOf({ rungs, pinIdx: idx }, { now: at }).filter(x => Date.parse(x.start) > at && Date.parse(x.start) - at <= 24 * 3600e3)
  .map(x => ({ ...x, best: Math.max(x.sides.yes.ev ?? -1, x.sides.no.ev ?? -1) })).sort((a, b) => b.best - a.best);
const backtest = JSON.parse(fs.readFileSync('seeds/exchange-props-backtest.json', 'utf8'));
const body = { label: 'research', note: "e2e fixture: the board is real Kalshi and Pinnacle reads at the recording's minute; no live flag had closed", edge: X.EDGE, of: X.MIN_N, takerRate: X.TAKER_RATE, makerRate: X.MAKER_RATE, kalshi: true, pinnacle: true,
  kinds: [], board: board.slice(0, 300), boardAt: snap.recordedAt, state: { scans: 0, errors: [] }, recent: [], backtest };
for (const lg of ['', 'NFL', 'NBA', 'NHL', 'MLB']) {
  const k = `/api/exchange-props${lg ? `?league=${lg}` : ''}`;
  snap.responses[k] = { status: 200, type: 'application/json', body: JSON.stringify({ ...body, board: lg ? body.board.filter(x => x.league === lg) : body.board }) };
}
fs.writeFileSync(FILE, zlib.gzipSync(JSON.stringify(snap)));
console.log('board', board.length, 'by league', JSON.stringify(board.reduce((o, x) => ((o[x.league] = (o[x.league] || 0) + 1), o), {})), 'taking 2%+', board.filter(x => x.best >= X.EDGE).length);
