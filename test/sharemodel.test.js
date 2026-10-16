const test = require('node:test');
const assert = require('node:assert');
const sm = require('../sharemodel');
const { createTracker, createMemoryStore } = require('../tracker');

const five = (rates, games = 20) => rates.map((rate, i) => ({ key: `p${i}`, rate, games }));

test('teamShares splits the team by kills a game, shrunk toward a fifth', () => {
  const sh = sm.teamShares(five([6, 4, 4, 4, 2]), { shrinkGames: 0 });
  assert.equal(sh.get('p0').share, 0.3);
  assert.equal(sh.get('p4').share, 0.1);
  const shrunk = sm.teamShares(five([6, 4, 4, 4, 2]), { shrinkGames: 20 });
  assert.ok(shrunk.get('p0').share < 0.3 && shrunk.get('p0').share > 0.2);
  const sum = [...shrunk.values()].reduce((a, x) => a + x.share, 0);
  assert.ok(Math.abs(sum - 1) < 1e-3);
});

test('teamShares needs a known lineup', () => {
  assert.equal(sm.teamShares(five([6, 4, 4, 4])), null);                      // four players
  assert.equal(sm.teamShares([...five([6, 4, 4, 4]), { key: 'x', rate: 0, games: 0 }]), null);   // one unknown
  assert.equal(sm.teamShares(five([6, 4, 4, 4, 2], 3)), null);               // too few games
});

test('shareMean sums Pinnacle maps times the share', () => {
  assert.equal(sm.shareMean([15, 16], 0.25), 7.75);
  assert.equal(sm.shareMean([15, null], 0.25), null);
  assert.equal(sm.shareMean([], 0.25), null);
});

test('shareProb reads the mean as a mean: a player under his mean more often than not', () => {
  const over = sm.shareProb(5.4, 5.5, 'OVER', { game: 'DOTA', share: 0.2 });
  const under = sm.shareProb(5.4, 5.5, 'UNDER', { game: 'DOTA', share: 0.2 });
  assert.ok(Math.abs(over + under - 1) < 1e-9);
  assert.ok(over < 0.5);
  // the team total's uncertainty widens the curve: a line far over the mean is likelier
  const tight = sm.shareProb(5, 9.5, 'OVER', { game: 'DOTA', share: 0.2, o: { teamSd: 0 } });
  const wide = sm.shareProb(5, 9.5, 'OVER', { game: 'DOTA', share: 0.2 });
  assert.ok(wide > tight);
});

const fairAt = (m, line, side) => sm.shareProb(m, line, side, { game: 'LOL', share: 0.3, maps: 2 });
const evPP = prob => (prob / 0.5622 - 1) * 100;

test('priceShare clears only when Pinnacle split the books way agrees', () => {
  const p = { share: { mean: 10, pinMean: 9.6 } };
  const r = sm.priceShare(p, { fairAt, books: [{ book: 'PP', line: 7.5, evAt: evPP }] });
  assert.equal(r.side, 'OVER');
  assert.ok(r.ev > 2);
  assert.equal(r.clears, true);
  // the books' own split says the line is right: no clear
  const q = sm.priceShare({ share: { mean: 10, pinMean: 7.5 } }, { fairAt, books: [{ book: 'PP', line: 7.5, evAt: evPP }] });
  assert.equal(q.clears, false);
  // no Pinnacle-by-the-books number: never clears
  const n = sm.priceShare({ share: { mean: 10, pinMean: null } }, { fairAt, books: [{ book: 'PP', line: 7.5, evAt: evPP }] });
  assert.equal(n.clears, false);
});

test('priceShare skips closed sides and prices each app at its own line', () => {
  const p = { share: { mean: 10, pinMean: 9.8 } };
  const r = sm.priceShare(p, { fairAt, books: [
    { book: 'PP', line: 9.5, evAt: evPP },
    { book: 'UD', line: 7.5, open: { OVER: false, UNDER: true }, evAt: prob => (prob * 1.8 - 1) * 100 },
  ] });
  assert.equal(r.cells.UD.side, 'UNDER');
  assert.equal(r.cells.PP.line, 9.5);
  assert.equal(r.book, 'PP');
});

test('sharePlay opens a tracked row only when it clears, and the close follows the share', async () => {
  const p = { sport: 'LOL', player: 'Faker', team: 'T1', matchTitle: 'T1 vs GEN', gameId: 7, market: 'Kills on Maps 1+2', startTime: '2030-01-01T10:00:00Z',
    ppLine: 7.5, share: { mean: 10, pinMean: 9.6, share: 0.3, maps: 2, game: 'LOL' } };
  const priced = sm.priceShare(p, { fairAt, books: [{ book: 'PP', line: 7.5, evAt: evPP }] });
  const play = sm.sharePlay(p, priced);
  assert.equal(play.bestEv, priced.ev);
  const tr = createTracker({ store: createMemoryStore(), minEv: 0, now: () => Date.parse('2029-12-31T10:00:00Z'), log: { log() {}, warn() {} },
    fairProb: (x, line, side) => sm.shareProb(x.marketPred, line, side, x.shareCtx) });
  await tr.recordBoard([play]);
  let [row] = await tr.list({ limit: 10 });
  assert.equal(row.signalSide, 'OVER');
  assert.ok(row.signalFair > 0.6);
  // Pinnacle drops the total: the share's fair at the same ticket drops, and
  // a play that no longer clears still updates the open row
  const later = sm.sharePlay({ ...p, share: { ...p.share, mean: 8 } }, { ...priced, clears: false });
  assert.equal(later.bestEv, null);
  await tr.recordBoard([later]);
  [row] = await tr.list({ limit: 10 });
  assert.ok(row.closeFair < row.signalFair);
  // a fresh pick that never cleared opens nothing
  await tr.recordBoard([{ ...later, player: 'Zeus' }]);
  assert.equal((await tr.list({ limit: 10 })).length, 1);
});

test('shareRecord counts teams and the close', () => {
  const rows = [
    { status: 'graded', outcome: 'win', profit: 0.78, gameId: 1, team: 'T1', signalSide: 'OVER', signalBook: 'PP', sport: 'LOL', signalFair: 0.6, closeFair: 0.62 },
    { status: 'graded', outcome: 'loss', profit: -1, gameId: 1, team: 'T1', signalSide: 'OVER', signalBook: 'PP', sport: 'LOL', signalFair: 0.6, closeFair: 0.55 },
    { status: 'open', outcome: null },
  ];
  const r = sm.shareRecord(rows);
  assert.equal(r.all.plays, 2);
  assert.equal(r.all.teams, 1);
  assert.equal(r.all.closeBeat, 1);
  assert.equal(r.all.hitRate, 0.5);
});

test('priceBookPlayers prices BetRivers player kill rungs on the share', () => {
  const index = new Map([['LOL|caliste', { share: 0.3, teamName: 'Karmine Corp', start: Date.parse('2030-01-01T18:00:00Z'), pinByMap: { 1: 16, 2: 16.2 }, booksPerMap: 4.6 }]]);
  const books = [{ game: 'LOL', league: 'Worlds', teams: ['Cloud9', 'Karmine Corp'], start: Date.parse('2030-01-01T18:00:00Z'),
    players: [{ period: 3, player: 'Caliste', team: 1, line: 3.5, prices: [-110, -110] }, { period: 1, player: 'Caliste', team: 0, line: 3.5, prices: [-110, -110] }] }];
  const toDecimal = a => (a > 0 ? 1 + a / 100 : 1 + 100 / -a);
  const fairs = new Map();
  const r = sm.priceBookPlayers(books, index, { nameKey: n => n.toLowerCase(), sameTeam: (a, b) => a === b, toDecimal, now: Date.parse('2029-12-31T00:00:00Z'), fairs });
  assert.equal(r.priced, 1);                 // the wrong-team line is skipped
  const over = r.rows.find(x => x.side.includes('Over'));
  assert.ok(over.ev > 2);
  assert.equal(over.share.mean, 4.83);       // map 3 has no Pinnacle total: the average of maps 1 and 2
  assert.equal(over.clears, true);
  assert.ok(fairs.size === 2);
});

test('priceBookPlayers keeps one rung per player and map', () => {
  const index = new Map([['LOL|caliste', { share: 0.3, teamName: 'KC', start: Date.parse('2030-01-01T18:00:00Z'), pinByMap: { 1: 16 }, booksPerMap: 4.6 }]]);
  const books = [{ game: 'LOL', teams: ['C9', 'KC'], start: Date.parse('2030-01-01T18:00:00Z'),
    players: [2.5, 3.5, 4.5].map(line => ({ period: 1, player: 'Caliste', team: 1, line, prices: [150, -200] })) }];
  const r = sm.priceBookPlayers(books, index, { nameKey: n => n.toLowerCase(), sameTeam: (a, b) => a === b, toDecimal: a => (a > 0 ? 1 + a / 100 : 1 + 100 / -a), now: Date.parse('2029-12-31T00:00:00Z') });
  assert.equal(r.priced, 3);
  assert.equal(r.rows.length, 1);
  assert.equal(r.teams, r.rows[0].clears ? 1 : 0);
});
