const test = require('node:test');
const assert = require('node:assert');
const A = require('../anchor');
const PB = require('../propsboard');

const row = (books, extra = {}) => ({ key: 'NBA|x|points', sport: 'NBA', player: 'X', mkey: 'points', market: 'Points', startTime: '2026-10-25T23:00:00Z', books, ...extra });

test('sportAnchor: only the four sharp books count, nearest line to the apps', () => {
  const r = row({ prizepicks: { line: 24.5 }, underdog: { line: 25.5 } });
  const a = A.sportAnchor(r, [{ book: 'pinnacle', line: 21.5 }, { book: 'pinnacle', line: 24.5 }, { book: 'draftkings', line: 24.5 }, { book: 'fanduel', line: 26.5 }]);
  assert.deepStrictEqual(a.books, ['pinnacle', 'fanduel']);
  assert.strictEqual(a.lines.pinnacle, 24.5);
  assert.strictEqual(a.lines.fanduel, 26.5);
  assert.strictEqual(A.label(a), 'PIN 24.5 · FD 26.5');
});

test('sportAnchor: no sharp quotes is unanchored; Kalshi at any rung anchors', () => {
  const r = row({ prizepicks: { line: 24.5 } });
  const none = A.sportAnchor(r, [{ book: 'betmgm', line: 24.5 }]);
  assert.deepStrictEqual(none.books, []);
  assert.strictEqual(A.label(none), 'no sharp line');
  assert.match(A.title(none), /No sharp book/);
  const k = A.sportAnchor(r, [], { kalshi: true });
  assert.deepStrictEqual(k.books, ['kalshi']);
  assert.strictEqual(A.label(k), 'KAL');
});

test('esportsAnchor: BetRivers map kills on the same player near the start', () => {
  const key = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const idx = A.brPlayerIndex([
    { book: 'betrivers', game: 'LOL', start: Date.parse('2026-10-25T10:00:00Z'), players: [{ player: 'Faker', period: 1, line: 4.5 }] },
    { book: 'bovada', game: 'LOL', players: [{ player: 'Chovy' }] },
    { book: 'betrivers', game: 'CS2', start: null, players: [{ player: 's1mple' }] },
  ], key);
  const lol = { sport: 'LOL', player: 'Faker', mkey: 'kills|maps 1-2', market: 'MAPS 1-2 Kills', startTime: '2026-10-25T11:00:00Z', books: {} };
  assert.deepStrictEqual(A.esportsAnchor(lol, idx, key).books, ['betrivers']);
  assert.deepStrictEqual(A.esportsAnchor({ ...lol, startTime: '2026-10-27T11:00:00Z' }, idx, key).books, []);
  assert.deepStrictEqual(A.esportsAnchor({ ...lol, market: 'MAPS 1-2 Assists', mkey: 'assists' }, idx, key).books, []);
  assert.deepStrictEqual(A.esportsAnchor({ ...lol, player: 'Chovy' }, idx, key).books, []);
  assert.deepStrictEqual(A.esportsAnchor({ ...lol, sport: 'CS', player: 's1mple' }, idx, key).books, ['betrivers']);
});

test('summarize counts each app cell; esports pooled', () => {
  const rows = [
    row({ prizepicks: { line: 1 }, underdog: { line: 1 } }, { anchor: { books: [] } }),
    row({ prizepicks: { line: 1 } }, { anchor: { books: ['pinnacle'] } }),
    { sport: 'CS', esports: true, books: { sleeper: { line: 30 } }, anchor: { books: [] } },
  ];
  const s = A.summarize(rows);
  assert.deepStrictEqual(s.total, { legs: 4, unanchored: 3 });
  assert.deepStrictEqual(s.bySport.NBA, { legs: 3, unanchored: 2 });
  assert.deepStrictEqual(s.bySport.ESPORTS, { legs: 1, unanchored: 1 });
  assert.deepStrictEqual(s.byApp.prizepicks.NBA, { legs: 2, unanchored: 1 });
});

test('queryRows anchor filter', () => {
  const rows = [
    row({ prizepicks: { line: 1 } }, { key: 'a', anchor: { books: [] } }),
    row({ prizepicks: { line: 1 } }, { key: 'b', anchor: { books: ['fanduel'] } }),
    row({ prizepicks: { line: 1 } }, { key: 'c' }),
  ];
  assert.deepStrictEqual(PB.queryRows(rows, { anchor: 'none', sort: 'player' }).map(r => r.key), ['a']);
  assert.deepStrictEqual(PB.queryRows(rows, { anchor: 'sharp', sort: 'player' }).map(r => r.key), ['b']);
  assert.strictEqual(PB.queryRows(rows, { sort: 'player' }).length, 3);
});

test('the shipped backtest says no edge', () => {
  const bt = require('../seeds/unanchored-backtest.json');
  assert.match(bt.verdict, /No side cleared/);
  assert.ok(bt.lines.length >= 3);
});
