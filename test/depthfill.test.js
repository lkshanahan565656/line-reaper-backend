const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../depthfill');

test('fee: Kalshi and Gemini round up to the cent, Polymarket US does not', () => {
  assert.equal(D.feeOf(100, 0.5, D.VENUES.kalshi), 1.75);
  assert.equal(D.feeOf(1, 0.5, D.VENUES.kalshi), 0.02);   // 1.75c rounds up
  assert.equal(D.feeOf(1, 0.5, D.VENUES.polymarketus), 0.0695 * 0.25);
});

test('walk: cheapest first, whole contracts, fee in, short when the book runs out', () => {
  const asks = [[0.52, 100], [0.5, 50]];
  const w = D.walk(asks, 50, D.VENUES.kalshi);
  // 50 at 0.50 ($25 + fee 0.875 rounded to 0.88), then 44 at 0.52 ($22.88 + fee 0.77)
  assert.equal(w.contracts, 94);
  assert.equal(w.usd, 49.53);
  assert.ok(w.usd <= 50 && w.full);
  assert.equal(w.worst, 0.52);
  assert.ok(w.cost > 0.5 && w.cost < 0.54);
  const big = D.walk(asks, 1000, D.VENUES.kalshi);
  assert.equal(big.contracts, 150);
  assert.equal(big.full, false);
  assert.equal(D.walk([], 50), null);
});

test('fillsOf: EV per tier against the fair, dollars at the edge', () => {
  // fair 55%: 0.50 + fee is +6.3%, 0.54 + fee is about +0.1%
  const f = D.fillsOf([[0.5, 100], [0.54, 5000]], 0.55, D.VENUES.kalshi);
  assert.ok(f.top.ev > 0.06);
  assert.ok(f.tiers[50].ev > 0.05 && f.tiers[50].full);
  assert.ok(f.tiers[1000].ev < 0.01, 'the $1,000 fill is mostly at 54c');
  assert.equal(D.flagged(f.tiers[50]), true);
  assert.equal(D.flagged(f.tiers[1000]), false);
  assert.equal(f.atEdge, Math.round(100 * (0.5 + 0.07 * 0.25)));
});

test('Gemini book: YES takes the asks, NO sells into the YES bids at 1 - bid', () => {
  const book = { bids: [{ price: '0.97', amount: '309' }, { price: '0.96', amount: '3500' }], asks: [{ price: '0.99', amount: '34137' }] };
  assert.deepEqual(D.geminiAsks(book, 'yes'), [[0.99, 34137]]);
  assert.deepEqual(D.geminiAsks(book, 'no'), [[0.03, 309], [0.04, 3500]]);
});

test('start buckets', () => {
  assert.equal(D.startBucket(10), '0-30m');
  assert.equal(D.startBucket(90), '30m-2h');
  assert.equal(D.startBucket(200), '2-6h');
  assert.equal(D.startBucket(2000), '6h+');
  assert.equal(D.startBucket(-1), 'live');
});

test('Gemini outcomes name the contract and the side behind the price (cheaper way in)', () => {
  const gb = require('../geminibooks');
  const start = new Date(Date.now() + 3600e3).toISOString();
  const px = (by, bn) => ({ buy: { yes: by, no: bn } });
  const payload = { data: [{ id: '1', ticker: 'NFL-2610252000-PIT-NO-M', status: 'active', startTime: start, gameId: 'g1',
    participants: [{ name: 'New Orleans Saints', side: 'home' }, { name: 'Pittsburgh Steelers', side: 'away' }],
    contracts: [
      { sportsSide: 'home', instrumentSymbol: 'GEMI-NFL-M-NO', prices: px(0.42, 0.6) },
      { sportsSide: 'away', instrumentSymbol: 'GEMI-NFL-M-PIT', prices: px(0.6, 0.41) },
    ] }] };
  const g = gb.parseGemini(payload).nfl[0];
  // home: NO on Pittsburgh at 0.41 beats YES on New Orleans at 0.42
  assert.deepEqual(g.h2h[0].ref, { venue: 'gemini', id: 'GEMI-NFL-M-PIT', buy: 'no' });
  assert.deepEqual(g.h2h[1].ref, { venue: 'gemini', id: 'GEMI-NFL-M-PIT', buy: 'yes' });
});
