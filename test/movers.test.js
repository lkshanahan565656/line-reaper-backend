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

test('a mover is a bet once its book is read, at its cheapest venue at or under fair', () => {
  const { moverBets } = require('../movers');
  const B = require('../bestplays'), R = require('../results');
  // Polymarket 57.5¢ to 59¢ on Boston (up 6¢ today), Kalshi sells it at 56¢ + fee
  const k = kRow({ yesAsk: 0.56, noAsk: 0.46 }), p = pRow({ yesAsk: 0.59, noAsk: 0.425 });
  const input = { matches: [{ kalshi: k, polymarket: p, same: true, by: 'teams' }], kalshi: [k] };
  const { quotes } = V.screen(input, { now: NOW, venues: ['kalshi'] });
  const mv = findMovers(quotes, [p]);
  assert.equal(mv.length, 1);
  assert.equal(mv[0].refId, '555');
  // no book read yet: no bet
  assert.equal(moverBets(mv, { fairs: new Map() }).length, 0);
  const found = V.findValue(input, { now: NOW, venues: ['kalshi'], books: new Map([['555', { bid: 0.58, ask: 0.59 }]]), requireBook: true });
  assert.equal(found.edges.length, 0, 'not an exchange value edge');
  const [b] = moverBets(mv, { fairs: found.fairs, edges: found.edges });
  assert.ok(b, 'a mover bet');
  assert.equal(b.pick, 'Boston');
  assert.equal(b.venue, 'kalshi');
  assert.equal(b.fair, 0.585);
  assert.ok(b.ev >= 0 && b.ev < 0.02);
  assert.equal(b.mover.day, 0.06);
  assert.equal(V.trackRows([b])[0].source, 'mover');
  assert.match(V.describe(b), /^LINE MOVER: Polymarket moved it 6¢ today \(52\.3¢ → 58\.3¢\)\. NBA · /);
  // a side already flagged as an edge stays that edge
  assert.equal(moverBets(mv, { fairs: found.fairs, edges: [{ id: b.id }] }).length, 0);
  // over fair: no bet
  const dear = V.findValue(input, { now: NOW, venues: ['kalshi'], books: new Map([['555', { bid: 0.56, ask: 0.57 }]]), requireBook: true });
  assert.equal(moverBets(mv, { fairs: dear.fairs }).length, 0);

  // Best Plays: nothing until line movers' own record beats the close
  const later = NOW + 3600e3;
  assert.equal(B.bestPlays({ value: [b] }, { now: later }).rows.length, 0);
  const rec = (clv, i) => ({ id: `m${i}`, status: 'closed', source: 'mover', clv, sport: 'nba', book: 'kalshi', market: 'moneyline', flaggedAt: '2026-10-12T00:00:00Z' });
  const good = R.scoreboard({ exchangeValue: Array.from({ length: 10 }, (_, i) => rec(i % 2 ? 2 : 3, i)) });
  assert.equal(good.plays.find(x => x.play === 'line mover').verdict, 'promising');
  const [row] = B.bestPlays({ value: [b], plays: good.plays }, { now: later }).rows;
  assert.ok(row && row.units > 0, 'listed once promising');
  assert.match(row.label, /NBA line mover/);
  assert.match(row.why[0], /^Line mover: Polymarket moved it 6¢ today/);
  assert.ok(row.ev > 0.02, 'sized on the record\'s CLV');
  // other signals doing well don't promote line movers
  const steamOnly = R.scoreboard({ exchangeValue: Array.from({ length: 10 }, (_, i) => ({ ...rec(3, i), source: 'steam' })) });
  assert.equal(B.bestPlays({ value: [b], plays: steamOnly.plays }, { now: later }).rows.length, 0);
});
