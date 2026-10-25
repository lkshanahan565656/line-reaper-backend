// pingames.matchRows on a recorded live list (10-25 02:21Z: Kalshi's events
// and game series, Gamma's sports markets, Polymarket US, Pinnacle's games;
// see fixtures/pingames-match-snapshot.json.gz). The expected pairs were found
// by matchRows before it read the games by start time; it must find the same.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const pingames = require('../pingames');

const fix = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname, 'fixtures', 'pingames-match-snapshot.json.gz'))));
const fp = ms => ms.map(m => ({ row: m.row.id, venue: m.row.exchange, game: m.game.id, kind: m.kind, pYes: m.pYes, line: m.line, alt: m.alt }));

test('snapshot: matchRows pairs the recorded rows with the same Pinnacle games', () => {
  assert.ok(fix.expect.length > 1000);
  assert.deepStrictEqual(fp(pingames.matchRows(fix.rows, fix.games)), fix.expect);
  // twice: the second pass answers from the name memo
  assert.deepStrictEqual(fp(pingames.matchRows(fix.rows, fix.games)), fix.expect);
});

test('snapshot: the order the games come in changes nothing', () => {
  const reversed = [...fix.games].reverse();
  assert.deepStrictEqual(fp(pingames.matchRows(fix.rows, reversed)), fix.expect);
});

test('matchRows: games without a start are skipped, an empty list pairs nothing', () => {
  assert.deepStrictEqual(pingames.matchRows(fix.rows, fix.games.map(g => ({ ...g, start: null }))), []);
  assert.deepStrictEqual(pingames.matchRows(fix.rows, []), []);
  assert.deepStrictEqual(pingames.matchRows([], fix.games), []);
});
