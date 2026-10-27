// Adds /api/kalshi-maker to the browser-test recording (e2e/fixtures/snapshot.json.gz).
// The board is rebuilt from the lead-lag recorder's real Pinnacle and Kalshi reads at the
// recording's own minute (the same kmaker.suggestBid as the server); the record is empty
// (none had closed then) and the backtest is seeds/kalshi-maker-backtest.json.
//   node scripts/kmaker-e2e-fixture.js <changes.jsonl.gz>...
const fs = require('fs'), zlib = require('zlib');
const pingames = require('../pingames');
const K = require('../kmaker');
const FILE = 'e2e/fixtures/snapshot.json.gz';
const snap = JSON.parse(zlib.gunzipSync(fs.readFileSync(FILE)));
const at = Date.parse(snap.recordedAt);
const last = { pinnacle: new Map(), kalshi: new Map() }, meta = new Map();
for (const f of process.argv.slice(2)) {
  for (const l of zlib.gunzipSync(fs.readFileSync(f)).toString().split('\n')) {
    if (!l) continue;
    let o; try { o = JSON.parse(l); } catch { continue; }
    if (o.t > at || !last[o.s] || !K.SPORTS.has(o.k.split('|')[0])) continue;
    if (o.gone) last[o.s].delete(o.k); else last[o.s].set(o.k, o.v);
    if (o.m && o.s === 'pinnacle') meta.set(o.k.split('|').slice(0, 2).join('|'), o.m);
  }
}
const cents = x => Math.round(x * 100) / 100;
const board = [];
for (const [k, kv] of last.kalshi) {
  const pv = last.pinnacle.get(k);
  const [sport, gid, market, point] = k.split('|');
  const m = meta.get(`${sport}|${gid}`);
  if (!pv || !m || Date.parse(m.st) <= at || Date.parse(m.st) - at > 24 * 3600e3) continue;
  const alt = market !== 'h2h' && pv[2] === 1;
  if (alt || (market === 'h2h' && pv[2] != null)) continue;
  const f = pingames.devig(pv.slice(0, 2));
  if (!f) continue;
  const event = `${m.away} @ ${m.home}`;
  const sides = market === 'h2h' ? [[m.home, kv[3], null], [m.away, kv[4], null]]
    : market === 'totals' ? [[`Over ${point}`, kv[2], kv[3]], [`Under ${point}`, kv[3], kv[2]]]
      : [[`${m.home} ${+point > 0 ? '+' : ''}${point}`, kv[2], kv[3]], [`${m.away} ${-point > 0 ? '+' : ''}${-point}`, kv[3], kv[2]]];
  sides.forEach(([side, ask, other], i) => {
    if (!(ask > 0 && ask < 1)) return;
    const fair = Math.round(f[i] * 1e4) / 1e4;
    // Kalshi's series schedule at the pull (diag-kmaker-out): NHL spreads and totals carry no maker fee
    const rate = sport === 'nhl' && market !== 'h2h' ? 0 : K.MAKER_RATE;
    const bid = K.suggestBid({ fair, ask, rate });
    const taker = ask + 0.07 * ask * (1 - ask);
    board.push({ sideKey: `e2e|${k}|${i}`, sport, event, start: m.st, market, side, point: market === 'h2h' ? null : +point, marketId: null, buy: market === 'h2h' || !i ? 'yes' : 'no', alt: false,
      fair, ask, bestBid: other > 0 && other < 1 ? cents(1 - other) : null, takerCost: Math.round(taker * 1e4) / 1e4, takerEv: Math.round((fair / taker - 1) * 1e4) / 1e4, makerRate: rate,
      ...(bid ? bid : { bid: null }) });
  });
}
board.sort((a, b) => (b.bid != null) - (a.bid != null) || Date.parse(a.start) - Date.parse(b.start));
const bt = JSON.parse(fs.readFileSync('seeds/kalshi-maker-backtest.json', 'utf8'));
const empty = K.summarize([]);
const body = { label: 'research', kind: K.KIND, note: "e2e fixture: the board is the lead-lag recorder's real reads at the recording's minute; no live bid had closed", edge: K.EDGE, makerRate: K.MAKER_RATE, kalshi: true,
  kinds: K.byKind([]), kindsAtBid: K.byKind([], { fill: 'atBid' }), record: empty, atBid: K.summarize([], { fill: 'atBid' }), bySport: [], board: board.slice(0, 300), boardAt: snap.recordedAt, state: { scans: 0, errors: [] }, recent: [],
  backtest: { at: bt.at, summary: bt.summary, verdict: bt.verdict, data: { from: bt.data.from, to: bt.data.to, games: bt.data.games, sides: bt.data.sides },
    byEdge: Object.fromEntries(Object.entries(bt.byEdge).map(([e, x]) => [e, { all: x.all, atBid: x.atBid, kinds: x.kinds, kindsAtBid: x.kindsAtBid, bySport: x.bySport, byMarket: x.byMarket, unfilledCloseDrift: x.unfilledCloseDrift, kalshiAfter30: x.kalshiAfter30, requote: x.requote }])) } };
for (const k of ['/api/kalshi-maker', ...['nfl', 'ncaaf', 'nba', 'nhl'].map(s => `/api/kalshi-maker?sport=${s}`)]) {
  const sp = k.split('=')[1];
  snap.responses[k] = { status: 200, type: 'application/json', body: JSON.stringify({ ...body, board: sp ? body.board.filter(x => x.sport === sp) : body.board }) };
}
fs.writeFileSync(FILE, zlib.gzipSync(JSON.stringify(snap)));
console.log('board', board.length, 'with bid', board.filter(x => x.bid != null).length);
