const test = require('node:test');
const assert = require('node:assert/strict');
const { findMovers } = require('../movers');
const V = require('../xvalue');
const { parsePolymarketBinaries } = require('../xarb');

const START = '2026-10-12T23:00:00Z', NOW = Date.parse('2026-10-12T12:00:00Z');
const kRow = (o = {}) => ({
  exchange: 'kalshi', id: 'KXNBAGAME-26OCT12NYKBOS-BOS', eventKey: 'kalshi:KXNBAGAME-26OCT12NYKBOS', eventTitle: 'New York at Boston',
  title: 'New York at Boston Winner?', outcomeLabel: 'Boston', noLabel: 'New York', kind: 'teams', yesAsk: 0.55, noAsk: 0.47,
  startTime: START, tradable: true, league: 'nba', category: 'sports', url: 'https://kalshi.com/markets/x', ...o,
});
const pRow = (o = {}) => ({
  exchange: 'polymarket', id: '555', eventKey: 'polymarket:1', eventTitle: 'Knicks vs. Celtics', title: 'Knicks vs. Celtics',
  outcomeLabel: 'Celtics', noLabel: 'Knicks', kind: 'teams', yesAsk: 0.59, noAsk: 0.42, gameSlug: 'nba-nyk-bos-2026-10-12',
  startTime: START, tradable: true, liquidity: 50000, league: 'nba', category: 'sports', dayChange: 0.06, hourChange: 0.01, ...o,
});

test('a line Polymarket moved on today shows the side it moved to, with each venue\'s price', () => {
  const k = kRow(), p = pRow();
  const { quotes } = V.screen({ matches: [{ kalshi: k, polymarket: p, same: true, by: 'teams' }], kalshi: [k] }, { now: NOW, venues: ['kalshi'] });
  const [m, ...rest] = findMovers(quotes, [p]);
  assert.equal(rest.length, 0);                      // the Knicks side (down 6¢) isn't a second row
  assert.equal(m.pick, 'Boston');
  assert.equal(m.fair, 0.585);
  assert.equal(m.from, 0.525);
  assert.equal(m.move, 0.06);
  assert.equal(m.best.venue, 'kalshi');
  assert.ok(m.best.ev > 0);
  // small moves and wide books are left out
  assert.equal(findMovers(quotes, [pRow({ dayChange: 0.02, hourChange: 0.01 })]).length, 0);
  const wide = pRow({ yesAsk: 0.62, noAsk: 0.42 });
  const q2 = V.screen({ matches: [{ kalshi: k, polymarket: wide, same: true, by: 'teams' }], kalshi: [k] }, { now: NOW, venues: ['kalshi'] }).quotes;
  assert.equal(findMovers(q2, [wide]).length, 0);
  // a fall in YES is a rise on the other side
  const [down] = findMovers(quotes, [pRow({ dayChange: -0.05 })]);
  assert.equal(down.pick, 'New York');
});

test('Gamma\'s price changes are read as YES\'s', () => {
  const ev = { id: 1, slug: 'x', title: 'Will it?', markets: [{ id: '9', question: 'Will it?', outcomes: '["No","Yes"]', bestBid: 0.4, bestAsk: 0.41, oneDayPriceChange: 0.05, active: true, acceptingOrders: true }] };
  const [r] = parsePolymarketBinaries([ev]);
  assert.equal(r.dayChange, -0.05);
  assert.equal(r.hourChange, 0);
});
