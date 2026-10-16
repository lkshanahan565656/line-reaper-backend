const test = require('node:test');
const assert = require('node:assert');
const { buildElo, matchContext, describeContext, TUNING } = require('../context');
const { matchupWeights } = require('../esmarket');

const day = 86400e3, now = Date.parse('2026-10-14T00:00:00Z');
const games = [];
// A and B trade wins with the field, so their ratings sit close; A beats B 5-1
for (let i = 0; i < 20; i++) games.push({ a: 'Alpha', b: 'Field' + (i % 4), aWon: i % 2 === 0, t: now - (40 - i) * day });
for (let i = 0; i < 20; i++) games.push({ a: 'Bravo', b: 'Field' + (i % 4), aWon: i % 2 === 0, t: now - (40 - i) * day });
for (let i = 0; i < 6; i++) games.push({ a: 'Alpha', b: 'Bravo', aWon: i !== 3, t: now - (10 - i) * day });

test('h2h counts maps between the two teams, either way round', () => {
  const elo = buildElo(games);
  assert.deepEqual(elo.h2h('Alpha', 'Bravo'), { w: 5, l: 1, n: 6 });
  assert.deepEqual(elo.h2h('Bravo', 'Alpha'), { w: 1, l: 5, n: 6 });
  assert.equal(elo.h2h('Alpha', 'Bravo', now - 6 * day).n, 2);
});

test('head-to-head moves a rating price a little, never an exchange price', () => {
  const elo = { LOL: buildElo(games) };
  const base = elo.LOL.mapProb('Alpha', 'Bravo');
  const c = matchContext({ sport: 'LOL', team: 'Alpha', opponent: 'Bravo', maps: [1, 2, 3] }, { elo, now });
  assert.equal(c.source, 'elo');
  assert.ok(c.h2h.shift > 0 && c.h2h.shift <= TUNING.h2hMax);
  assert.ok(Math.abs(c.pMap - (base + c.h2h.shift)) < 1e-9);
  assert.match(describeContext(c), /H2H 5-1/);
  const oddsBook = { lookup: () => ({ pMap: 0.6, bestOf: 3, source: 'kalshi' }) };
  const k = matchContext({ sport: 'LOL', team: 'Alpha', opponent: 'Bravo', maps: [1, 2, 3] }, { elo, oddsBook, now });
  assert.equal(k.pMap, 0.6);
  assert.equal(k.h2h.shift, 0);
  assert.equal(k.h2h.n, 6);
});

test('matchupWeights: prior with no record, the slope as picks come in', () => {
  assert.equal(matchupWeights([]).weight('LOL'), 0.5);
  // results move fully with the factor: slope 1, pulled toward 0.5 by 40 picks
  const rows = [];
  for (let i = 0; i < 40; i++) { const f = i % 2 ? 1.1 : 0.9; rows.push({ status: 'graded', sport: 'LOL', signalLine: 10, ctxFactor: f, result: 10 * f }); }
  const w = matchupWeights(rows).weight('LOL');
  assert.ok(Math.abs(w - 0.75) < 1e-6, String(w));
  // results that ignore the factor drag it toward 0
  const flat = rows.map(r => ({ ...r, result: 10 }));
  assert.ok(Math.abs(matchupWeights(flat).weight('LOL') - 0.25) < 1e-6);
  assert.equal(matchupWeights(rows).weight('CS'), 0.5);
});
