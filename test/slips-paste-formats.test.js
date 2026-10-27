// Pasted slips in the shapes the apps' lineup screens copy as text, one piece
// of a pick a line. TEST DATA: reconstructed from the apps' public screens,
// not from a real export; the players and lines are made up here.
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../slips');
const NOW = Date.parse('2026-10-27T12:00:00Z');
const legs = t => { const r = S.parseSlips(t, { now: NOW }); return { app: r.slips[0]?.app, legs: r.slips.flatMap(s => s.legs.map(l => `${l.player}|${l.side}|${l.line}|${l.market}`)), skipped: r.skipped, slips: r.slips }; };

test('PrizePicks lineup, one piece a line: More / 27.5 / Points', () => {
  const r = legs('PrizePicks\n3-Pick Power Play\n$20 Entry · Pays $100\nJalen Brunson\nNYK - G\nvs BOS Tue 7:30pm\nMore\n27.5\nPoints\nJayson Tatum\nBOS - F\n@ NYK Tue 7:30pm\nLess\n8.5\nRebounds\nDerrick White\nBOS - G\nMore\n2.5\n3-PT Made');
  assert.equal(r.app, 'prizepicks');
  assert.deepEqual(r.legs, ['Jalen Brunson|Over|27.5|Points', 'Jayson Tatum|Under|8.5|Rebounds', 'Derrick White|Over|2.5|3-PT Made']);
  assert.deepEqual(r.skipped, []);
  assert.equal(r.slips[0].flex, false);
  assert.deepEqual([r.slips[0].stake, r.slips[0].payout], [20, 100]);
});

test('"27.5 Points" then "More"; "More than 27.5"', () => {
  assert.deepEqual(legs('Power Play 2-Pick\nJalen Brunson\nNYK - G\n27.5 Points\nMore\nJayson Tatum\n8.5 Rebounds\nLess').legs, ['Jalen Brunson|Over|27.5|Points', 'Jayson Tatum|Under|8.5|Rebounds']);
  assert.deepEqual(legs('PrizePicks 2-Pick Flex\nJalen Brunson More than 27.5 Points\nJayson Tatum Less than 8.5 Rebounds').legs, ['Jalen Brunson|Over|27.5|Points', 'Jayson Tatum|Under|8.5|Rebounds']);
});

test('Underdog: Points / 27.5 / Higher, read as Underdog', () => {
  const r = legs('Jalen Brunson\nPoints\n27.5\nHigher\nJayson Tatum\nRebounds\n8.5\nLower');
  assert.equal(r.app, 'underdog', 'Higher/Lower is Underdog\'s wording');
  assert.deepEqual(r.legs, ['Jalen Brunson|Over|27.5|Points', 'Jayson Tatum|Under|8.5|Rebounds']);
});

test('Sleeper: 27.5 / points / over', () => {
  const r = legs('Sleeper\nJalen Brunson\nNYK · PG\n27.5\npoints\nover\nJayson Tatum\n8.5\nrebounds\nunder');
  assert.equal(r.app, 'sleeper');
  assert.deepEqual(r.legs, ['Jalen Brunson|Over|27.5|points', 'Jayson Tatum|Under|8.5|rebounds']);
});

test('esports one-word handles and a team code with a digit', () => {
  const r = legs('PrizePicks\n2-Pick Power Play\nFaker\nT1 - MID\nvs GEN\nMore\n7.5\nMAPS 1-2 Kills\nChovy\nGEN - MID\nvs T1\nLess\n8.5\nMAPS 1-2 Kills');
  assert.deepEqual(r.legs, ['Faker|Over|7.5|MAPS 1-2 Kills', 'Chovy|Under|8.5|MAPS 1-2 Kills']);
  assert.deepEqual(r.skipped, []);
});

test('pieces that never make a pick are listed, not guessed', () => {
  const r = legs('Jalen Brunson\nMore\nPoints\nJayson Tatum\n8.5 Rebounds\nLess');
  assert.deepEqual(r.legs, ['Jayson Tatum|Under|8.5|Rebounds']);
  assert.deepEqual(r.skipped, ['Jalen Brunson'], 'a name whose pick has no line is not read as a leg');
});
