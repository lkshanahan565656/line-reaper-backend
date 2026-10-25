// depthbook.js: the books behind the shopper's exchange prices, their size
// per tier after fees, the min-size filter and arbs sized by the thin side.
const test = require('node:test');
const assert = require('node:assert/strict');
const DB = require('../depthbook');
const D = require('../depthfill');
const shopper = require('../shopper');
const schema = require('../oddsschema');

const K = D.VENUES.kalshi;
const start = new Date(Date.now() + 5 * 3600e3).toISOString();
const q = (providerId, side, decimal, extra = {}) => schema.makeQuote({ providerId, sport: 'nfl', league: 'nfl', eventId: 'pin-1', home: 'Home', away: 'Away', startUtc: start,
  marketType: 'moneyline', marketName: 'Moneyline', marketId: 'pin-1|ml', selectionName: side, side, decimal, effectiveDecimal: decimal, updatedAt: new Date().toISOString(), ...extra });

test('refOf keys Kalshi, Gemini and Polymarket US prices the way the size record does', () => {
  assert.deepEqual(DB.refOf({ providerId: 'kalshi', sourceIds: { marketId: 'KX-1', buy: 'yes' } }), { key: 'kalshi|KX-1|yes', ref: { venue: 'kalshi', id: 'KX-1', buy: 'yes' } });
  assert.equal(DB.refOf({ provider: 'polymarketus', sourceIds: { venue: 'polymarketus', id: 'slug', buy: 'long', rate: 0.05 } }).key, 'polymarketus|slug|long');
  assert.equal(DB.refOf({ providerId: 'fanduel', sourceIds: { marketId: 'x', buy: 'yes' } }), null, 'a sportsbook has no book');
  assert.equal(DB.refOf({ providerId: 'kalshi', sourceIds: { marketId: 'KX-1' } }), null);
});

test('sizeOf walks the book per tier, fee in, and counts dollars at the fair', () => {
  const book = { asks: [[0.5, 100], [0.55, 1000]], fee: K, at: Date.now() - 30e3 };
  const z = DB.sizeOf(book, { fair: 0.54 });
  assert.equal(z.ageSec, 30);
  assert.equal(z.topPrice, 0.5);
  assert.equal(z.topUsd, Math.round(100 * (0.5 + 0.07 * 0.25)));
  assert.equal(z.tiers[50].full, true);
  assert.ok(z.tiers[50].ev > 0.03, 'all $50 at 0.50 + fee');
  assert.ok(z.tiers[1000].cost > z.tiers[50].cost, '$1,000 reaches the 0.55 level');
  assert.ok(z.tiers[1000].ev < 0, 'and is below the fair there');
  assert.equal(z.atFairUsd, z.topUsd, 'only the 0.50 level is at or above the fair');
  const thin = DB.sizeOf({ asks: [[0.4, 20]], fee: K, at: Date.now() }, { fair: null });
  assert.equal(thin.tiers[50].full, false);
  assert.equal(thin.tiers[200].full, false);
  assert.equal(thin.atFairUsd, null);
  assert.equal(DB.sizeOf({ asks: [], fee: K, at: Date.now() }).empty, true);
});

test('the cache drops old books, takes the size record\'s reads and reads within budget', async () => {
  let t = 1e12;
  const reads = [];
  const book = DB.createDepthBook({ now: () => t, budget: { kalshi: 2, gemini: 1, polymarketus: 0 }, readAsks: async ref => { reads.push(ref.id); return { asks: [[0.5, 10]], fee: K }; } });
  book.fromRecord({ venue: 'kalshi', id: 'A', buy: 'yes' }, { asks: [[0.5, 5]], fee: K }, t);
  assert.ok(book.get('kalshi|A|yes'));
  const cands = ['A', 'B', 'C', 'D'].map(id => ({ key: `kalshi|${id}|yes`, ref: { venue: 'kalshi', id, buy: 'yes' } }))
    .concat([{ key: 'polymarketus|s|long', ref: { venue: 'polymarketus', id: 's', buy: 'long' } }, { key: 'gemini|g|yes', ref: { venue: 'gemini', id: 'g', buy: 'yes' } }]);
  await book.readPass(cands);
  assert.deepEqual(reads.sort(), ['B', 'C', 'g'], 'A is fresh, Kalshi budget 2, Polymarket US 0');
  t += DB.MAX_AGE_MS + 1;
  assert.equal(book.get('kalshi|A|yes'), null, 'an old book is not a size');
  // a 429 holds the venue
  const held = DB.createDepthBook({ now: () => t, readAsks: async () => { throw Object.assign(new Error('x'), { response: { status: 429 } }); } });
  await held.readPass([cands[0], cands[1]]);
  assert.equal(held.state.reads.kalshi || 0, 0);
  assert.match(held.state.errors[0], /429/);
});

test('arbSize: the thinner side sets the size, and a sportsbook leg has no published limit', () => {
  // two exchange legs that lock ~4% at the top; one side holds only $60
  const a = { provider: 'kalshi', decimal: 1 / (0.45 + 0.07 * 0.45 * 0.55), book: { asks: [[0.45, 2000]], fee: K, at: Date.now() } };
  const b = { provider: 'polymarketus', decimal: 1 / (0.5 + 0.0695 * 0.25), book: { asks: [[0.5, 110], [0.7, 5000]], fee: D.VENUES.polymarketus, at: Date.now() } };
  const z = DB.arbSize([a, b], { stake: 100 });
  assert.equal(z.sized, true);
  assert.ok(z.maxTotal > 50 && z.maxTotal < 130, `max total ${z.maxTotal}`);
  assert.equal(z.thin, 'polymarketus');
  assert.equal(z.atStake.ok, true);
  assert.equal(DB.arbSize([a, b], { stake: 1000 }).atStake.ok, false);
  const book = DB.arbSize([{ provider: 'fanduel', decimal: 2.1, book: null }, { provider: 'betrivers', decimal: 2.1, book: null }]);
  assert.equal(book.sized, false);
  assert.match(book.note, /not published/);
  const unread = DB.arbSize([{ provider: 'kalshi', decimal: 2.1, book: null }, { provider: 'fanduel', decimal: 2.1, book: null }]);
  assert.deepEqual(unread.unread, ['kalshi']);
});

test('the shopper carries each exchange price\'s size, and a minimum size reprices or drops it', () => {
  const quotes = [q('pinnacle', 'home', 1.9), q('pinnacle', 'away', 2.0),
    q('kalshi', 'home', 2.0, { sourceIds: { marketId: 'KX-H', buy: 'yes' } }), q('kalshi', 'away', 2.05, { sourceIds: { marketId: 'KX-H', buy: 'no' } }),
    q('gemini', 'away', 2.08, { sourceIds: { venue: 'gemini', id: 'GEM-A', buy: 'no' } })];
  const books = {
    'kalshi|KX-H|yes': { asks: [[0.48, 1000], [0.5, 5000]], fee: K, at: Date.now() },
    'gemini|GEM-A|no': { asks: [[0.46, 30], [0.6, 1000]], fee: K, at: Date.now() },
  };
  const depth = qq => { const r = DB.refOf(qq); return r ? books[r.key] || null : null; };
  const v = shopper.build(quotes, { depth, stake: 100 });
  const ml = v.markets[0];
  const home = ml.sides.find(s => s.side === 'home'), away = ml.sides.find(s => s.side === 'away');
  const kh = home.prices.find(c => c.provider === 'kalshi');
  assert.equal(kh.size.tiers[200].full, true);
  assert.equal(kh.liquidity, kh.size.topUsd, 'liquidity is the dollars at the top price');
  assert.ok(away.prices.find(c => c.provider === 'kalshi').size.unread, 'no book read: says so');
  assert.equal(away.best.provider, 'gemini');
  assert.equal(home.prices.find(c => c.provider === 'pinnacle').size, null, 'a reference has no size');
  // $200 minimum: Gemini's $14 at the top can't take it; its walked price falls behind Kalshi, Kalshi away is unread → dropped
  const s200 = shopper.build(quotes, { depth, stake: 100, minSize: 200 });
  const aw = s200.markets[0].sides.find(s => s.side === 'away');
  const gem = aw.prices.find(c => c.provider === 'gemini');
  assert.equal(gem.sizedAt, 200);
  assert.ok(gem.effective < gem.listed, 'priced at what $200 fills at');
  assert.equal(aw.prices.find(c => c.provider === 'kalshi').sizeOk, false);
  assert.equal(aw.best.provider, 'gemini');
  assert.equal(s200.minSize, 200);
  // free viewers see sizes but no EV in them
  const free = shopper.stripPro(v);
  const fk = free.markets[0].sides.find(s => s.side === 'home').prices.find(c => c.provider === 'kalshi');
  assert.equal(fk.size.tiers[50].ev, null);
  assert.ok(fk.size.tiers[50].decimal > 1);
  assert.ok(v.counts.sized >= 1 && v.counts.unsized >= 1);
});

test('candidates put arb legs first, then prices near the fair', () => {
  const views = [
    { hold: -0.02, start, sides: [{ prices: [{ provider: 'kalshi', sourceIds: { marketId: 'A', buy: 'yes' }, bettable: true, best: true, ev: 0.01 }] }] },
    { hold: 0.05, start, sides: [{ prices: [{ provider: 'gemini', sourceIds: { venue: 'gemini', id: 'G', buy: 'yes' }, bettable: true, best: false, ev: 0.03 },
      { provider: 'gemini', sourceIds: { venue: 'gemini', id: 'H', buy: 'yes' }, bettable: true, best: false, ev: -0.1 },
      { provider: 'fanduel', bettable: true, best: true, ev: 0.05 }] }] },
  ];
  const c = DB.candidates(views);
  assert.deepEqual(c.map(x => x.key), ['kalshi|A|yes', 'gemini|G|yes']);
});
