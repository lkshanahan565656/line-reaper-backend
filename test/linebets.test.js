const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../linebets');
const { createMemoryStore } = require('../evtrack');

const START = '2026-10-25T17:00:00Z';
const T0 = Date.parse('2026-10-25T12:00:00Z');
const pinWith = (spreadDal = -105, total = 44.5) => ({ key: 'pinnacle', markets: [
  { key: 'h2h', outcomes: [{ name: 'Dallas Cowboys', price: -150 }, { name: 'New York Giants', price: 135 }] },
  { key: 'spreads', outcomes: [
    { name: 'Dallas Cowboys', price: spreadDal, point: -3 }, { name: 'New York Giants', price: spreadDal === -105 ? -105 : -115, point: 3 },
    { name: 'Dallas Cowboys', price: 140, point: -7 }, { name: 'New York Giants', price: -160, point: 7 }] },
  { key: 'totals', outcomes: [{ name: 'Over', price: -108, point: total }, { name: 'Under', price: -102, point: total }] },
] });
const games = pin => ({ nfl: [{ id: 'pin-111', commence_time: START, home_team: 'Dallas Cowboys', away_team: 'New York Giants', bookmakers: [pin] }] });
const track = o => ({ kind: 'line', game: 'pin-111', league: 'nfl', ...o });

function setup() {
  let t = T0;
  const lb = L.createLineBets({ store: createMemoryStore(), now: () => t, log: { warn() {} } });
  return { lb, at: x => { t = x; } };
}

test('a track is cleaned to its key fields; junk is refused', () => {
  assert.deepEqual(L.clean(track({ market: 'spread', side: 'New York Giants', point: '-3' })), { game: 'pin-111', market: 'spread', side: 'New York Giants', point: -3 });
  assert.equal(L.clean(track({ market: 'spread', side: 'x' })), null);   // a spread needs its number
  assert.equal(L.clean({ kind: 'tail', id: 1 }), null);
  assert.equal(L.clean(track({ market: 'teaser', side: 'x' })), null);
  assert.equal(L.clean(track({ market: 'ml', side: 'Dallas Cowboys', point: 5 })).point, null);
});

test('Pinnacle no-vig fair at the exact number, spreads kept as the home number', () => {
  const g = games(pinWith()).nfl[0];
  const away = L.pinFair(g, { market: 'spread', side: 'New York Giants', point: -3 });
  const home = L.pinFair(g, { market: 'spread', side: 'Dallas Cowboys', point: -3 });
  assert.ok(Math.abs(away.p + home.p - 1) < 1e-3);
  assert.equal(away.p, 0.5);
  assert.deepEqual(away.raw, { 'Dallas Cowboys': -105, 'New York Giants': -105 });
  // an alt number Pinnacle hangs
  assert.ok(L.pinFair(g, { market: 'spread', side: 'Dallas Cowboys', point: -7 }).p < 0.45);
  // one it doesn't
  assert.equal(L.pinFair(g, { market: 'spread', side: 'Dallas Cowboys', point: -4 }), null);
  assert.equal(L.pinFair(g, { market: 'total', side: 'Over', point: 45.5 }), null);
});

test('logged before the start, followed to the close, graded from the final', async () => {
  const { lb, at } = setup();
  const bets = [{ id: 'b1', track: track({ market: 'spread', side: 'New York Giants', point: -3 }) }, { id: 'b2', track: track({ market: 'total', side: 'Under', point: 44.5 }) }];
  let r = await lb.settle(bets, { games: games(pinWith()) });
  assert.equal(r.b1.close.status, 'open');
  assert.equal(r.b1.close.logFair, 0.5);
  assert.equal(r.b1.closeOdds, undefined);   // no close until the start
  // the market moves toward the Giants
  at(Date.parse('2026-10-25T16:40:00Z'));
  await lb.observe(games(pinWith(-102 /* Dallas */)));
  at(Date.parse('2026-10-25T17:01:00Z'));
  await lb.observe(games(pinWith(-102)));
  r = await lb.settle(bets, { games: {} });
  assert.equal(r.b1.close.status, 'closed');
  assert.equal(r.b1.close.closeOk, true);
  assert.ok(r.b1.close.fair > 0.5, 'Giants side shortened');
  assert.equal(r.b1.close.pin, -115);
  assert.ok(Math.abs(r.b1.closeOdds - 1 / r.b1.close.fair) < 1e-3);
  // final: Giants 20 Cowboys 23 → Giants +3 pushes, under 44.5 wins
  at(Date.parse('2026-10-25T21:00:00Z'));
  const grader = { gradeGame: async g => { assert.equal(g.league, 'NFL'); return { home: 23, away: 20 }; } };
  const out = await lb.grade(grader, lg => (lg === 'nfl' ? 'NFL' : null));
  assert.equal(out.graded, 2);
  r = await lb.settle(bets, { games: {} });
  assert.equal(r.b1.result, 'push');
  assert.equal(r.b2.result, 'win');
  assert.deepEqual(r.b2.close.score, { home: 23, away: 20 });
});

test('a close read more than an hour before the start does not count', async () => {
  const { lb, at } = setup();
  const bets = [{ id: 'b1', track: track({ market: 'ml', side: 'Dallas Cowboys' }) }];
  await lb.settle(bets, { games: games(pinWith()) });
  at(Date.parse('2026-10-25T17:05:00Z'));
  await lb.observe({});   // Pinnacle pulled the game: nothing read since 12:00
  const r = await lb.settle(bets, { games: {} });
  assert.equal(r.b1.close.closeOk, false);
  assert.equal(r.b1.closeOdds, undefined);
  assert.ok(r.b1.close.closeAgeMin > 60);
});

test('late, unknown and unpriced tracks say why and are not logged', async () => {
  const { lb, at } = setup();
  const g = games(pinWith());
  let r = await lb.settle([{ id: 'x', track: track({ game: 'nope', market: 'ml', side: 'A' }) }], { games: g });
  assert.equal(r.x.close.status, 'unknown');
  r = await lb.settle([{ id: 'y', track: track({ market: 'spread', side: 'Dallas Cowboys', point: -4 }) }], { games: g });
  assert.equal(r.y.close.status, 'nopin');
  at(Date.parse('2026-10-25T17:30:00Z'));
  r = await lb.settle([{ id: 'z', track: track({ market: 'ml', side: 'Dallas Cowboys' }) }], { games: g });
  assert.equal(r.z.close.status, 'late');
  assert.equal(lb.rows.size, 0);
});

test('two users on the same side share one row (no stake, no user)', async () => {
  const { lb } = setup();
  const g = games(pinWith());
  await lb.settle([{ id: 'u1', track: track({ market: 'total', side: 'Over', point: 44.5 }) }], { games: g });
  await lb.settle([{ id: 'u2', track: track({ market: 'total', side: 'Over', point: '44.5' }) }], { games: g });
  assert.equal(lb.rows.size, 1);
  const row = [...lb.rows.values()][0];
  assert.deepEqual(Object.keys(row).filter(k => /stake|user|odds|price/i.test(k)), []);
});
