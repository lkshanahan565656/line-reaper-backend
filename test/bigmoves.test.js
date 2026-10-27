'use strict';
// Biggest moves (bigmoves.js): moves ranked per venue, and each other venue's answer.
const test = require('node:test');
const assert = require('node:assert');
const M = require('../bigmoves');
const stale = require('../stalelines');

const H = 3600e3;
const NOW = Date.parse('2026-10-26T18:00:00Z');
const START = new Date(NOW + 3 * H).toISOString();

// one game on the odds screen now: Pinnacle's main total 47.5, FanDuel on 47, Kalshi and BetRivers at 47.5
function screen({ total = 47.5 } = {}) {
  const cell = (venue, american, extra = {}) => ({ venue, name: venue, american, url: `https://example.test/${venue}`, point: total, lineDiffers: false, ref: venue === 'pinnacle', secondHand: false, ...extra });
  return {
    games: [{
      id: 'pin-1', league: 'nfl', leagueLabel: 'NFL', start: START, home: 'Dallas', away: 'Philadelphia',
      markets: [
        { key: 'ml', label: 'Moneyline', point: null, sides: [
          { name: 'Dallas', label: 'Dallas', venues: [cell('pinnacle', -150, { point: null }), cell('kalshi', -155, { point: null }), cell('fanduel', -130, { point: null }), cell('betrivers', -145, { point: null })] },
          { name: 'Philadelphia', label: 'Philadelphia', venues: [cell('pinnacle', 135, { point: null }), cell('kalshi', 130, { point: null }), cell('fanduel', 110, { point: null }), cell('betrivers', 120, { point: null })] },
        ] },
        { key: 'total', label: 'Total', point: total, sides: [
          { name: 'Over', label: `Over ${total}`, venues: [cell('pinnacle', -110), cell('betrivers', -110), cell('fanduel', -110, { point: 47, lineDiffers: true })] },
          { name: 'Under', label: `Under ${total}`, venues: [cell('pinnacle', -110), cell('betrivers', -110), cell('fanduel', -110, { point: 47, lineDiffers: true })] },
        ] },
      ],
    }],
  };
}
// the odds screen's history: Dallas went from -120 to -150 at Pinnacle two hours ago; Kalshi
// followed, FanDuel didn't move, BetRivers moved part way. The total went 47 → 47.5 at 17:30.
function series() {
  return [
    { id: 'pin-1|ml|Dallas', game: 'pin-1', start: START, market: 'ml', label: 'Dallas', pts: [
      [NOW - 5 * H, null, null, { pinnacle: -120, kalshi: -122, fanduel: -130, betrivers: -125 }],
      [NOW - 2 * H, null, null, { pinnacle: -150, kalshi: -122, fanduel: -130, betrivers: -125 }],
      [NOW - 1 * H, null, null, { pinnacle: -150, kalshi: -155, fanduel: -130, betrivers: -145 }],
    ] },
    { id: 'pin-1|ml|Philadelphia', game: 'pin-1', start: START, market: 'ml', label: 'Philadelphia', pts: [
      [NOW - 5 * H, null, null, { pinnacle: 105, kalshi: 100, fanduel: 110, betrivers: 105 }],
      [NOW - 2 * H, null, null, { pinnacle: 135, kalshi: 100, fanduel: 110, betrivers: 105 }],
      [NOW - 1 * H, null, null, { pinnacle: 135, kalshi: 130, fanduel: 110, betrivers: 120 }],
    ] },
    { id: 'pin-1|total|Over', game: 'pin-1', start: START, market: 'total', label: 'Over 47.5', pts: [
      [NOW - 5 * H, 47, null, { pinnacle: -110, betrivers: -110, fanduel: -110 }],
      [NOW - 0.5 * H, 47.5, null, { pinnacle: -110, betrivers: -110 }],
    ] },
    { id: 'pin-1|total|Under', game: 'pin-1', start: START, market: 'total', label: 'Under 47.5', pts: [
      [NOW - 5 * H, 47, null, { pinnacle: -110, betrivers: -110, fanduel: -110 }],
      [NOW - 0.5 * H, 47.5, null, { pinnacle: -110, betrivers: -110 }],
    ] },
  ];
}

test('a price move is ranked at each venue, only on the side that went up', () => {
  const { rows } = M.gameMoves(series(), screen(), { now: NOW });
  const price = rows.filter(r => r.type === 'price');
  const pin = price.find(r => r.venue === 'pinnacle');
  assert.ok(pin, 'Pinnacle moved');
  assert.strictEqual(pin.side, 'Dallas');
  // -120 is 54.5%, -150 is 60%: 5.5 cents
  assert.strictEqual(pin.move, 5.5);
  assert.strictEqual(pin.from, -120);
  assert.strictEqual(pin.to, -150);
  assert.ok(!price.some(r => r.side === 'Philadelphia' && r.venue === 'pinnacle'), 'the mirror side is not a second row');
  const st = Object.fromEntries(pin.followers.map(f => [f.venue, f.status]));
  assert.deepStrictEqual(st, { kalshi: 'moved', fanduel: 'old', betrivers: 'moved' });
  // the venue's own link and price ride along
  assert.strictEqual(pin.followers.find(f => f.venue === 'fanduel').url, 'https://example.test/fanduel');
});

test('the window decides the start: in the last hour nothing moved at Pinnacle', () => {
  const { rows } = M.gameMoves(series(), screen(), { now: NOW, window: '1h' });
  assert.ok(!rows.some(r => r.type === 'price' && r.venue === 'pinnacle'));
  // 3 hours back: Pinnacle was still at -120
  const r3 = M.gameMoves(series(), screen(), { now: NOW, window: '3h' }).rows.find(r => r.type === 'price' && r.venue === 'pinnacle');
  assert.strictEqual(r3.move, 5.5);
  // a venue that only moved part of the way
  const r = M.gameMoves(series(), screen(), { now: NOW, window: '3h' }).rows.find(r => r.venue === 'betrivers');
  assert.strictEqual(r.type, 'price');
});

test('a number move: Pinnacle 47 → 47.5, FanDuel still on 47, and no price move across the two numbers', () => {
  const { rows } = M.gameMoves(series(), screen(), { now: NOW });
  const line = rows.filter(r => r.type === 'line');
  assert.strictEqual(line.length, 1, 'one row per market, not per side');
  assert.strictEqual(line[0].from, 47);
  assert.strictEqual(line[0].to, 47.5);
  assert.strictEqual(line[0].side, 'Total 47 → 47.5');
  const st = Object.fromEntries(line[0].followers.map(f => [f.venue, f.status]));
  assert.deepStrictEqual(st, { betrivers: 'moved', fanduel: 'old' });
  assert.ok(!rows.some(r => r.type === 'price' && r.market === 'total'), 'prices at 47 and 47.5 are not compared');
});

test('a series that starts after the window start has no move for that window', () => {
  const s = series().map(x => ({ ...x, pts: x.pts.filter(p => p[0] >= NOW - 2 * H) }));
  const { rows } = M.gameMoves(s, screen(), { now: NOW, window: '3h' });
  assert.strictEqual(rows.length, 0);
  const open = M.gameMoves(s, screen(), { now: NOW, window: 'open' });
  assert.ok(open.considered > 0);
});

test('started games and markets no longer on the board are left out', () => {
  const old = series().map(x => ({ ...x, start: new Date(NOW - H).toISOString() }));
  const sc = screen();
  sc.games[0].start = new Date(NOW - H).toISOString();
  assert.strictEqual(M.gameMoves(old, sc, { now: NOW }).rows.length, 0);
  assert.strictEqual(M.gameMoves(series(), { games: [] }, { now: NOW }).rows.length, 0);
});

test('an exchange shows the size its book holds, from the sizer only', () => {
  const size = (g, m, s, v) => (v === 'kalshi' ? { topUsd: 340, fills: 200, ageSec: 30 } : null);
  const pin = M.gameMoves(series(), screen(), { now: NOW, size }).rows.find(r => r.venue === 'pinnacle' && r.type === 'price');
  assert.deepStrictEqual(pin.followers.find(f => f.venue === 'kalshi').size, { topUsd: 340, fills: 200, ageSec: 30 });
  assert.strictEqual(pin.followers.find(f => f.venue === 'fanduel').size, null, 'a book never gets a size');
});

test('rank: one row per market at the venue that moved most, or every move at one venue', () => {
  const { rows } = M.gameMoves(series(), screen(), { now: NOW });
  const all = M.rank(rows, { type: 'price' });
  const dallas = all.filter(r => r.side === 'Dallas');
  assert.strictEqual(dallas.length, 1);
  assert.strictEqual(dallas[0].venue, 'kalshi', 'Kalshi went -122 → -155, more than Pinnacle');
  const kal = M.rank(rows, { type: 'price', venue: 'betrivers' });
  assert.ok(kal.every(r => r.venue === 'betrivers'));
  assert.strictEqual(M.rank(rows, { type: 'price', league: 'nba' }).length, 0);
  assert.strictEqual(M.rank(rows, { type: 'line' }).length, 1);
  const f = M.facets(rows, 'price');
  assert.deepStrictEqual(f.leagues.map(x => x.key), ['nfl']);
  assert.ok(f.venues.some(v => v.key === 'pinnacle'));
});

test('followOf: moved too, still at the old number, part way, the other way, new', () => {
  const o = M.DEFAULTS;
  assert.strictEqual(M.followOf(0.03, 0.05, o), 'moved');
  assert.strictEqual(M.followOf(0.005, 0.05, o), 'old');
  assert.strictEqual(M.followOf(0.015, 0.05, o), 'part');
  assert.strictEqual(M.followOf(-0.02, 0.05, o), 'against');
  assert.strictEqual(M.followOf(null, 0.05, o), 'new');
  assert.strictEqual(M.lineFollowOf(47.5, 47, 47.5), 'moved');
  assert.strictEqual(M.lineFollowOf(48, 47, 47.5), 'moved');
  assert.strictEqual(M.lineFollowOf(47, 47, 47.5), 'old');
  assert.strictEqual(M.lineFollowOf(46.5, 47, 47.5), 'other');
});

// props from the stale-lines engine's own change log
test('props: an app that moved its line, and the apps still on the old one', () => {
  const eng = stale.createStaleLines();
  const meta = { sport: 'NFL', kind: 'prop', market: 'pass_yds', marketLabel: 'Pass Yards', player: 'Dak Prescott', event: 'PHI @ DAL', start: START };
  const q = (source, x, p = 0.5) => ({ key: 'k1', source, q: { kind: 'prop', mkey: 'pass_yds', sport: 'NFL', pts: [{ x, p }] }, meta });
  const t0 = NOW - 2 * H, t1 = NOW - 10 * 60e3;
  eng.observe([q('prizepicks', 250.5), q('underdog', 250.5), q('sleeper', 250.5)], t0);
  eng.observe([q('prizepicks', 255.5), q('underdog', 250.5), q('sleeper', 255.5)], t1);
  // keep every app fresh at NOW
  eng.observe([q('prizepicks', 255.5), q('underdog', 250.5), q('sleeper', 255.5)], NOW - 60e3);
  const subjects = eng.sources(NOW, { kind: 'prop' });
  assert.strictEqual(subjects.length, 1);
  const { rows } = M.propMoves(subjects, { now: NOW });
  const pp = rows.find(r => r.venue === 'prizepicks');
  assert.strictEqual(pp.type, 'line');
  assert.strictEqual(pp.from, 250.5);
  assert.strictEqual(pp.to, 255.5);
  assert.strictEqual(pp.league, 'nfl');
  assert.ok(pp.url.startsWith('https://app.prizepicks.com'));
  const st = Object.fromEntries(pp.followers.map(f => [f.venue, f.status]));
  assert.deepStrictEqual(st, { underdog: 'old', sleeper: 'moved' });
  // one row per prop when no venue is picked
  assert.strictEqual(M.rank(rows, { type: 'line' }).length, 1);
  // the last hour: PrizePicks moved 10 minutes ago, inside it
  const r1 = M.propMoves(eng.sources(NOW, { kind: 'prop' }), { now: NOW, window: '1h' }).rows;
  assert.ok(r1.some(r => r.venue === 'prizepicks' && r.type === 'line'));
});

test('props: a book price move at the same line, read as the side that got likelier', () => {
  const eng = stale.createStaleLines();
  const meta = { sport: 'NBA', kind: 'prop', market: 'points', player: 'Luka Doncic', event: 'LAL @ DAL', start: START };
  // the engine notes a change by the prices, so each chance comes with its pair
  const q = (source, p) => ({ key: 'k2', source, q: { kind: 'prop', mkey: 'points', sport: 'NBA', pts: [{ x: 30.5, p, d0: 0.95 / p, d1: 0.95 / (1 - p) }] }, meta });
  eng.observe([q('fanduel', 0.5), q('betrivers', 0.5)], NOW - 2 * H);
  eng.observe([q('fanduel', 0.45), q('betrivers', 0.5)], NOW - 3 * 60e3);
  const rows = M.propMoves(eng.sources(NOW, { kind: 'prop' }), { now: NOW }).rows;
  const fd = rows.find(r => r.venue === 'fanduel');
  assert.strictEqual(fd.type, 'price');
  assert.strictEqual(fd.move, 5);
  assert.match(fd.side, /Under 30\.5/);
  assert.strictEqual(fd.followers[0].status, 'old');
  assert.strictEqual(fd.url, null, 'no link where the venue has none');
});

test('props: a venue no longer read is not counted', () => {
  const eng = stale.createStaleLines();
  const meta = { sport: 'NFL', kind: 'prop', market: 'rush_yds', player: 'Saquon Barkley', event: 'PHI @ DAL', start: START };
  const q = (source, x) => ({ key: 'k3', source, q: { kind: 'prop', mkey: 'rush_yds', sport: 'NFL', pts: [{ x, p: 0.5 }] }, meta });
  eng.observe([q('underdog', 80.5)], NOW - 2 * H);
  eng.observe([q('underdog', 85.5)], NOW - 90 * 60e3);
  // Underdog's quote is past its 20-minute age at NOW
  assert.strictEqual(M.propMoves(eng.sources(NOW, { kind: 'prop' }), { now: NOW }).rows.length, 0);
});
