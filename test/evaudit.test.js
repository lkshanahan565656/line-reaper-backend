// The three systematic errors the 2026-10-15 re-check found from raw feeds
const test = require('node:test');
const assert = require('node:assert');
const E = require('../ev');
const sp = require('../sportprops');

const NOW = Date.parse('2026-10-15T06:00:00Z');
const game = (id, start, outcomes) => ({ id, sport_key: 'basketball_nba', home_team: 'New York Knicks', away_team: 'Philadelphia 76ers', commence_time: start,
  bookmakers: [{ key: 'pinnacle', markets: [{ key: 'player_rebounds', outcomes }] }] });
const dfsEv = (p, book) => (book === 'prizepicks' ? (p / 0.5622 - 1) * 100 : null);

test('a DFS leg is priced only on the books\' game that starts with it', () => {
  const later = '2026-10-20T23:30:00Z';
  const feeds = [{ sport: 'nba', games: [game('g1', later, [
    { name: 'Over', description: 'Jalen Brunson', point: 2.5, price: -150 },
    { name: 'Under', description: 'Jalen Brunson', point: 2.5, price: 125 },
  ])] }];
  // PrizePicks' 2.5 is the 10-15 preseason game; the books' prop is 10-20
  const preseason = E.screen({ now: NOW, minEv: -100, feeds, dfsEv, dfsLines: [{ book: 'prizepicks', player: 'Jalen Brunson', market: 'Rebounds', line: 2.5, startTime: '2026-10-15T23:30:00Z' }] });
  assert.equal(preseason.filter(r => r.dfs).length, 0);
  const same = E.screen({ now: NOW, minEv: -100, feeds, dfsEv, dfsLines: [{ book: 'prizepicks', player: 'Jalen Brunson', market: 'Rebounds', line: 2.5, startTime: later }] });
  assert.equal(same.filter(r => r.dfs).length, 2);
  // no start time: only a lone game
  assert.ok(E.dfsGame([{ head: { start: later } }], null));
  assert.equal(E.dfsGame([{ head: { start: later } }, { head: { start: '2026-10-22T23:30:00Z' } }], null), null);
  // the nearer of two games inside the window
  const a = { head: { start: '2026-10-15T23:30:00Z' } }, b = { head: { start: '2026-10-16T01:00:00Z' } };
  assert.equal(E.dfsGame([a, b], '2026-10-16T00:50:00Z'), b);
});

const cell = (line, over = null, under = null, extra = {}) => ({ line, over, under, overOpen: true, underOpen: true, ...extra });
const appEv = (p, b, m) => (b === 'prizepicks' ? (p / 0.5622 - 1) * 100 : b === 'underdog' ? (p * m / 0.5623 - 1) * 100 : (p * m - 1) * 100);

test('the other apps\' lines never make a play on their own', () => {
  // Kalshi 25.5% anytime TD; Underdog's 0.5 at 1x reads as 50%; Sleeper pays 3.14x
  const row = { key: 'NFL|douglas|anytime_td', sport: 'NFL', player: 'DeMario Douglas', mkey: 'anytime_td', books: { underdog: cell(0.5, 1, 1), sleeper: cell(0.5, 3.14, 1.2) } };
  const kalshi = new Map([[0.5, 0.255]]);
  const plays = sp.rowPlays(row, { kalshi, dfsEv: appEv });
  const sl = plays.find(p => p.book === 'sleeper' && p.side === 'Over');
  assert.ok(sl.ev > 5, 'blended fair shows a big number');
  assert.ok(sl.sharpEv < -15, 'Kalshi alone says it loses');
  assert.ok(Math.abs(sl.sharpFair - 0.255) < 1e-3);
  assert.equal(sp.playKind(sl), null);
  // a play the sharp price alone backs still clears
  const ok = sp.rowPlays(row, { kalshi: new Map([[0.5, 0.4]]), dfsEv: appEv }).find(p => p.book === 'sleeper' && p.side === 'Over');
  assert.ok(ok.sharpEv >= 2);
  assert.equal(sp.playKind(ok), 'ev');
});

test('sharp consensus leaves out a source stretched far from its own line', () => {
  const row = { key: 'NFL|cousins|rush_yds', sport: 'NFL', player: 'Kirk Cousins', mkey: 'rush_yds', books: { underdog: cell(0.5, 1, 1) } };
  const far = [{ book: 'pinnacle', line: 2.5, pOver: 0.385 }, { book: 'fanduel', line: 2.5, pOver: 0.388 }];
  assert.equal(sp.consensusFor(row, 0.5, { sharp: far }), null, '2.5 read at 0.5 is not a price for 0.5');
  assert.equal(sp.consensusPlays(row, { sharp: far, dfsEv: appEv }).length, 0);
  // near lines still price
  const near = sp.consensusFor({ ...row, mkey: 'rec_yds' }, 50.5, { sharp: [{ book: 'pinnacle', line: 49.5, pOver: 0.52 }, { book: 'fanduel', line: 51.5, pOver: 0.48 }] });
  assert.equal(near.n, 2);
  // book fair keeps its own rule (whole price dropped at maxOffPts)
  assert.equal(sp.BOOK_FAIR.maxShiftPts, null);
});
