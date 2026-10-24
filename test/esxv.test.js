const test = require('node:test');
const assert = require('node:assert');
const xv = require('../esxv');
const { createMemoryStore } = require('../evtrack');

const NOW = Date.parse('2026-10-24T17:00:00Z');
const board = (over = {}) => ({
  game: 'LOL', label: 'LoL', teams: ['Gen.G', 'Hanwha Life Esports'], start: NOW + 30 * 60e3, live: false, bestOf: 5,
  markets: [{ key: 'match', kind: 'match', outcomes: [
    { name: 'Gen.G', quotes: { kalshi: { bid: 0.6, ask: 0.61, ticker: 'KXLOLGAME-X-GEN' }, pinnacle: { prob: 0.6, limit: 1000 } } },
    { name: 'Hanwha Life Esports', quotes: { kalshi: { bid: 0.39, ask: 0.40, ticker: 'KXLOLGAME-X-HLE' }, pinnacle: { prob: 0.4, limit: 1000 } } },
  ] }],
  ...over,
});
const pmusPayload = (bid, ask, extra = {}) => ({ events: [{ slug: 'lol-hle-gen-2026-10-24', startTime: '2026-10-24T17:30:00Z', live: false, ended: false, markets: [{
  sportsMarketType: 'esports_match_winner', slug: 'aec-lol-hle-gen-2026-10-24', feeCoefficient: 0.0695,
  marketSides: [{ long: true, team: { name: 'Hanwha Life Esports' } }, { long: false, team: { name: 'Gen.G Esports' } }],
  bestBidQuote: { value: String(bid) }, bestAskQuote: { value: String(ask) }, ...extra }] }] });

test('parsePmusEvents reads the long team, the short team and the quotes', () => {
  const [q] = xv.parsePmusEvents(pmusPayload(0.3, 0.32), 'LOL');
  assert.equal(q.long, 'Hanwha Life Esports');
  assert.equal(q.short, 'Gen.G Esports');
  assert.equal(q.ask, 0.32);
  assert.equal(q.bid, 0.3);
  assert.equal(xv.parsePmusEvents({ events: [{ markets: [{ sportsMarketType: 'esports_total' }] }] }, 'LOL').length, 0);
});

test('kalshiFair normalises the two yes mids and refuses a wide book', () => {
  const f = xv.kalshiFair(board().markets[0]);
  assert.deepEqual(f.fair, [0.6050, 0.3950]);
  const wide = board(); wide.markets[0].outcomes[0].quotes.kalshi = { bid: 0.55, ask: 0.62 };
  assert.equal(xv.kalshiFair(wide.markets[0]), null);
});

test('scanSignals flags the Polymarket US side priced under Kalshi, fee in, and orients the teams', () => {
  // HLE is the long side at 0.32 ask: fair 0.395, cost 0.32 + 0.0695*0.32*0.68 = 0.3351, edge 6c
  const { signals, fairs } = xv.scanSignals([board()], xv.parsePmusEvents(pmusPayload(0.3, 0.32), 'LOL'), { now: NOW });
  assert.equal(signals.length, 1);
  const s = signals[0];
  assert.equal(s.team, 'Hanwha Life Esports');
  assert.equal(s.longSide, true);
  assert.equal(s.cost, 0.3351);
  assert.ok(Math.abs(s.edge - 0.0599) < 1e-4);
  assert.equal(s.kalshiTicker, 'KXLOLGAME-X-HLE');
  assert.equal(fairs.size, 1);
  // Gen.G is the short side: 1 - bid 0.3 = 0.70 > fair, no flag; a bid of 0.45 makes it 0.55 + fee
  const g = xv.scanSignals([board()], xv.parsePmusEvents(pmusPayload(0.45, 0.47), 'LOL'), { now: NOW }).signals;
  assert.equal(g.length, 1);
  assert.equal(g[0].team, 'Gen.G');
  assert.equal(g[0].price, 0.55);
});

test('scanSignals stays quiet outside the window, in play, on other titles and at fair prices', () => {
  const pm = xv.parsePmusEvents(pmusPayload(0.3, 0.32), 'LOL');
  assert.equal(xv.scanSignals([board({ start: NOW + 3 * 3600e3 })], pm, { now: NOW }).signals.length, 0);
  assert.equal(xv.scanSignals([board({ live: true })], pm, { now: NOW }).signals.length, 0);
  assert.equal(xv.scanSignals([board({ game: 'R6' })], pm, { now: NOW }).signals.length, 0);
  assert.equal(xv.scanSignals([board()], xv.parsePmusEvents(pmusPayload(0.38, 0.39), 'LOL'), { now: NOW }).signals.length, 0);
  // a different match between other teams is not paired
  assert.equal(xv.scanSignals([board({ teams: ['T1', 'KT Rolster'] })], pm, { now: NOW }).signals.length, 0);
});

test('tracker logs a flag once, follows Kalshi to the start and grades from the settled market', async () => {
  let t = NOW;
  const http = { get: async url => ({ data: { market: { result: url.endsWith('HLE') ? 'yes' : 'no' } } }) };
  const tr = xv.createXvTracker({ store: createMemoryStore(), http, now: () => t });
  const pm = xv.parsePmusEvents(pmusPayload(0.3, 0.32), 'LOL');
  await tr.record([board()], pm);
  await tr.record([board()], pm);
  assert.equal((await tr.list()).length, 1);
  // Kalshi moves toward the flagged side before the start: the close follows
  t = NOW + 20 * 60e3;
  const moved = board(); moved.markets[0].outcomes[0].quotes.kalshi = { bid: 0.57, ask: 0.58, ticker: 'KXLOLGAME-X-GEN' }; moved.markets[0].outcomes[1].quotes.kalshi = { bid: 0.42, ask: 0.43, ticker: 'KXLOLGAME-X-HLE' };
  await tr.record([moved], pm);
  let [r] = await tr.list();
  assert.equal(r.closeFair, 0.425);
  assert.equal(r.status, 'open');
  t = NOW + 31 * 60e3;
  await tr.record([], []);
  [r] = await tr.list();
  assert.equal(r.status, 'locked');
  await tr.grade();
  [r] = await tr.list();
  assert.equal(r.status, 'locked');   // too soon after the start
  t = NOW + 5 * 3600e3;
  await tr.grade();
  [r] = await tr.list();
  assert.equal(r.status, 'graded');
  assert.equal(r.outcome, 'win');
  assert.equal(r.profit, Math.round((1 - 0.3351) / 0.3351 * 1e4) / 1e4);
  const s = await tr.summary();
  assert.equal(s.graded, 1);
  assert.equal(s.verdict, 'early');
  assert.equal(s.left, 49);
  assert.equal(s.clvCents, 8.99);
});

test('summarize: failed needs 50 graded and 2 standard errors under break-even', () => {
  const rows = Array.from({ length: 60 }, (_, i) => ({ status: 'graded', outcome: i < 15 ? 'win' : 'loss', cost: 0.5, profit: i < 15 ? 1 : -1, closeFair: 0.49 }));
  const s = xv.summarize(rows);
  assert.equal(s.verdict, 'failed');
  assert.equal(xv.summarize(rows.slice(0, 30)).verdict, 'early');
});
