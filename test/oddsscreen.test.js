const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../oddsscreen');

const NOW = Date.parse('2026-10-25T12:00:00Z');
const START = '2026-10-25T17:00:00Z';
const game = (books, o = {}) => ({ id: 'pin-111', sport_key: 'nfl', commence_time: START, home_team: 'Dallas Cowboys', away_team: 'New York Giants', bookmakers: books, ...o });
const pin = {
  key: 'pinnacle', markets: [
    { key: 'h2h', outcomes: [{ name: 'Dallas Cowboys', price: -150 }, { name: 'New York Giants', price: 135 }] },
    { key: 'spreads', outcomes: [
      { name: 'Dallas Cowboys', price: -105, point: -3 }, { name: 'New York Giants', price: -105, point: 3 },
      { name: 'Dallas Cowboys', price: 140, point: -7 }, { name: 'New York Giants', price: -160, point: 7 }] },
    { key: 'totals', outcomes: [{ name: 'Over', price: -108, point: 44.5 }, { name: 'Under', price: -102, point: 44.5 }] },
  ],
};
const fd = { key: 'fanduel', markets: [
  { key: 'h2h', outcomes: [{ name: 'Dallas Cowboys', price: -140 }, { name: 'New York Giants', price: 120 }] },
  { key: 'spreads', outcomes: [{ name: 'Dallas Cowboys', price: -110, point: -3.5 }, { name: 'New York Giants', price: -110, point: 3.5 }] },
  { key: 'totals', outcomes: [{ name: 'Over', price: -110, point: 44.5 }, { name: 'Under', price: -110, point: 44.5 }] },
] };
const gem = { key: 'gemini', markets: [{ key: 'h2h', outcomes: [{ name: 'Dallas Cowboys', price: -145 }, { name: 'New York Giants', price: 140 }] }] };
const dk = { key: 'draftkings', markets: [{ key: 'h2h', outcomes: [{ name: 'Dallas Cowboys', price: -135 }, { name: 'New York Giants', price: 115 }] }] };

test('the main number is Pinnacle\'s most even line', () => {
  assert.deepEqual(S.pointsOf(pin, 'spreads', 'Dallas Cowboys'), [-3, -7]);
  assert.deepEqual(S.pointsOf(pin, 'totals', 'Dallas Cowboys'), [44.5]);
});

test('every venue on one row, de-vigged fair, EV and the best price', () => {
  const sc = S.build({ nfl: [game([pin, fd, gem, dk])] }, { now: NOW });
  assert.equal(sc.games.length, 1);
  const g = sc.games[0];
  const ml = g.markets.find(m => m.key === 'ml');
  const dal = ml.sides.find(s => s.name === 'Dallas Cowboys');
  // fair sums to 1 with the giants
  const nyg = ml.sides.find(s => s.name === 'New York Giants');
  assert.ok(Math.abs(dal.fair + nyg.fair - 1) < 1e-3);
  assert.ok(dal.fair > 0.57 && dal.fair < 0.6);
  // best Dallas price is DraftKings -135, but best Giants is Gemini +140
  assert.equal(dal.best.venue, 'draftkings');
  assert.equal(nyg.best.venue, 'gemini');
  const pinCell = dal.venues.find(v => v.venue === 'pinnacle');
  assert.equal(pinCell.ref, true); assert.equal(pinCell.ev, null); assert.equal(pinCell.best, false);
  assert.equal(dal.venues.find(v => v.venue === 'draftkings').secondHand, true);
  const gemCell = nyg.venues.find(v => v.venue === 'gemini');
  assert.ok(Math.abs(gemCell.ev - (nyg.fair * 2.4 - 1)) < 1e-3);
  // columns in order, Texas flags
  assert.deepEqual(sc.venues.map(v => v.key), ['pinnacle', 'gemini', 'fanduel', 'draftkings']);
  assert.equal(sc.venues.find(v => v.key === 'gemini').tx, true);
  assert.equal(sc.venues.find(v => v.key === 'fanduel').tx, false);
});

test('a venue at another number shows it, with no EV and never best', () => {
  const g = S.build({ nfl: [game([pin, fd])] }, { now: NOW }).games[0];
  const sp = g.markets.find(m => m.key === 'spread');
  assert.equal(sp.point, -3);
  const dal = sp.sides.find(s => s.name === 'Dallas Cowboys');
  assert.equal(dal.label, 'Dallas Cowboys -3');
  assert.equal(sp.sides[1].label, 'New York Giants +3');
  const f = dal.venues.find(v => v.venue === 'fanduel');
  assert.equal(f.lineDiffers, true); assert.equal(f.point, -3.5); assert.equal(f.ev, null);
  assert.equal(dal.best, null);
  const tot = g.markets.find(m => m.key === 'total');
  assert.equal(tot.sides[0].best.venue, 'fanduel');
  assert.equal(tot.sides[0].label, 'Over 44.5');
  // both FanDuel -110s: 4.76% hold
  assert.ok(Math.abs(tot.bestHold - 0.0476) < 1e-3);
  assert.equal(sp.bestHold, null);
});

test('Texas shows only Texas venues next to the fair', () => {
  const sc = S.build({ nfl: [game([pin, fd, gem, dk])] }, { now: NOW, state: 'TX' });
  const ml = sc.games[0].markets.find(m => m.key === 'ml');
  for (const s of ml.sides) assert.deepEqual(s.venues.map(v => v.venue), ['pinnacle', 'gemini']);
  assert.equal(ml.sides[0].best.venue, 'gemini');
  // spread and total have no Texas venue: dropped
  assert.deepEqual(sc.games[0].markets.map(m => m.key), ['ml']);
});

test('Kalshi joins from the exchange index at the same bet key', () => {
  const kalshi = new Map([['111|ml|away', { venues: [{ venue: 'kalshi', american: 150, decimal: 2.5, url: 'https://kalshi.com/markets/x' }] }]]);
  const sc = S.build({ nfl: [game([pin])] }, { now: NOW, kalshi });
  const nyg = sc.games[0].markets[0].sides.find(s => s.name === 'New York Giants');
  assert.equal(nyg.best.venue, 'kalshi');
  assert.ok(nyg.best.ev > 0.02 && nyg.best.ev < 0.04);
  assert.equal(sc.counts.plusEv, 1);
});

test('games outside the window, other leagues and search are left out', () => {
  const later = game([pin, fd], { id: 'pin-2', commence_time: '2026-10-29T17:00:00Z' });
  const old = game([pin, fd], { id: 'pin-3', commence_time: '2026-10-25T08:00:00Z' });
  const nba = game([pin, fd], { id: 'pin-4', home_team: 'Boston Celtics', away_team: 'Miami Heat' });
  const all = { nfl: [game([pin, fd]), later, old], nba: [nba] };
  assert.equal(S.build(all, { now: NOW }).games.length, 2);
  assert.equal(S.build(all, { now: NOW, league: 'nba' }).games.length, 1);
  assert.equal(S.build(all, { now: NOW, q: 'celtics' }).games[0].home, 'Boston Celtics');
  assert.deepEqual(S.build(all, { now: NOW }).leagues.map(l => l.key).sort(), ['nba', 'nfl']);
});

test('free viewers get the prices without the fair or EV', () => {
  const sc = S.stripPro(S.build({ nfl: [game([pin, fd, gem])] }, { now: NOW }));
  const s = sc.games[0].markets[0].sides[1];
  assert.equal(s.fair, null); assert.equal(s.best.ev, null);
  assert.ok(s.venues.every(v => v.ev == null && v.american != null));
});

test('history keeps moves, skips repeats inside the gap, and survives a dump and load', () => {
  const h = S.createHistory({ minGapMs: 60e3, heartbeatMs: 3600e3 });
  const sc1 = S.build({ nfl: [game([pin, fd])] }, { now: NOW });
  assert.ok(h.observe(sc1, NOW) > 0);
  assert.equal(h.observe(sc1, NOW + 120e3), 0);   // nothing moved
  const fd2 = { ...fd, markets: [{ key: 'h2h', outcomes: [{ name: 'Dallas Cowboys', price: -160 }, { name: 'New York Giants', price: 135 }] }, ...fd.markets.slice(1)] };
  const sc2 = S.build({ nfl: [game([pin, fd2])] }, { now: NOW });
  assert.equal(h.observe(sc2, NOW + 20e3), 0);    // moved, but inside the gap
  assert.ok(h.observe(sc2, NOW + 200e3) >= 2);
  const dal = h.forGame('pin-111').find(x => x.id === 'pin-111|ml|Dallas Cowboys');
  assert.deepEqual(dal.pts.map(p => p[3].fanduel), [-140, -160]);
  const h2 = S.createHistory();
  h2.load(h.dump());
  assert.equal(h2.points(), h.points());
  // dropped after the game is long over
  h.prune(Date.parse(START) + 7 * 3600e3);
  assert.equal(h.size(), 0);
});
