// Adds /api/outrights to the browser-test recording (e2e/fixtures/snapshot.json.gz).
// The board is outrights.boardOf over real reads of the 10-25 US Grand Prix
// (test/fixtures/outrights-2026-10-25.json: Pinnacle ~17:25Z, Kalshi and
// Polymarket US ~17:45Z, read by the diag-outrights probes), shifted to the
// recording's clock; the record is empty (nothing had closed). Season futures
// rows are real reads of 10-26 (test/fixtures/futures-2026-10-26.json); their
// record is empty too.
//   node scripts/outrights-e2e-fixture.js
const fs = require('fs'), zlib = require('zlib');
const o = require('../outrights');
const fx = require('../test/fixtures/outrights-2026-10-25.json');
const FILE = 'e2e/fixtures/snapshot.json.gz';
const snap = JSON.parse(zlib.gunzipSync(fs.readFileSync(FILE)));
const readAt = Date.parse('2026-10-25T17:40:00Z');
const pins = o.parsePinLeague('f1', fx.pinF1.matchups, fx.pinF1.markets, readAt);
const exch = [o.parseKalshiEvent(fx.kalshiEvent), o.parsePmusEvent(fx.pmusEvent, 'f1')];
const fu = require('../test/fixtures/futures-2026-10-26.json');
const execcheck = require('../execcheck');
const fNow = Date.parse('2026-10-26T20:30:00Z');
const fPins = [...o.parsePinLeague('nba', fu.pinNbaEast.matchups, fu.pinNbaEast.markets, fNow), ...o.parsePinLeague('nba', fu.pinNbaChamp.matchups, fu.pinNbaChamp.markets, fNow),
  ...o.parsePinLeague('cfb', fu.pinCfbPlayoffs.matchups, fu.pinCfbPlayoffs.markets, fNow)];
const fBooks = new Map();
for (const [t, b] of Object.entries(fu.kalshiBooks)) for (const buy of ['yes', 'no']) fBooks.set(`kalshi|${t}|${buy}`, execcheck.kalshiAsks({ orderbook_fp: b }, buy));
const fBoard = o.boardOf({ pins: fPins, exch: [o.parseKalshiEvent(fu.kalshiNbaEast), o.parseKalshiEvent(fu.kalshiCfbPlayoffs), o.parsePmusSeasonEvent(fu.pmusNbaEast)].filter(Boolean), books: fBooks }).filter(x => x.season);
const board = [...o.boardOf({ pins, exch }), ...fBoard];
const empty = sp => ({ key: sp, kind: `${o.KIND}:${sp}`, ...o.summarize([]) });
const body = { label: 'research', kind: o.KIND, note: 'e2e fixture: the board is real reads of the 10-25 US Grand Prix (Pinnacle, Kalshi, Polymarket US); no flag had closed', edge: o.EDGE, flagTier: o.FLAG_TIER, minFair: o.MIN_FAIR,
  kalshi: true, polymarketus: true, record: o.summarize([]), bySport: o.SPORTS.map(empty), byVenue: [], byType: [], board, boardAt: '2026-10-25T17:40:00.000Z', pinAt: '2026-10-25T17:39:00.000Z',
  state: { scans: 0, errors: [] }, feed: { reads: {}, errors: [] }, recent: [],
  futures: { kind: o.FUTURES_KIND, note: 'e2e fixture: season futures rows are real reads of 10-26; no flag had a 24 h read', edge: o.SEASON.edge, tier: o.SEASON.tier, minFair: o.SEASON.minFair, maxMargin: o.SEASON.maxMargin,
    byVenue: ['kalshi', 'polymarketus'].map(v => ({ key: v, kind: `${o.FUTURES_KIND}:${v}`, ...o.summarizeFutures([]) })), byMarket: [], recent: [] } };
for (const sp of ['', 'f1', 'golf', 'season']) {
  const rows = sp === 'f1' ? board.filter(x => x.sport === 'f1' && !x.season) : sp === 'golf' ? [] : sp === 'season' ? board.filter(x => x.season) : board;
  snap.responses[`/api/outrights${sp ? `?sport=${sp}` : ''}`] = { status: 200, type: 'application/json', body: JSON.stringify({ ...body, board: rows }) };
}
fs.writeFileSync(FILE, zlib.gzipSync(JSON.stringify(snap)));
console.log('board', board.length);
