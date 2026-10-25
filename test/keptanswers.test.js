// ops.keptAnswers: the two-generation memo behind exchanges.teamMatches and
// pingames.sameTeam gives the same answer as asking afresh, keeps a working
// set as large as its limit across a rollover, and never holds more than two
// generations.
const test = require('node:test');
const assert = require('node:assert/strict');
const { keptAnswers } = require('../ops');
const { teamMatches } = require('../exchanges');
const pingames = require('../pingames');

test('keptAnswers: same answers as the function, a working set up to max is not asked again', () => {
  let calls = 0;
  const fn = (a, b) => { calls++; return String(a).length % 3 === String(b).length % 3; };
  const kept = keptAnswers(fn, 100);
  const pairs = [];
  for (let i = 0; i < 100; i++) pairs.push([`a${i}`, `team ${i * 7}`]);
  for (const [a, b] of pairs) assert.equal(kept(a, b), fn(a, b));
  calls = 0;
  // ask the same 100 again and again past several rollovers: nothing recomputed
  for (let r = 0; r < 5; r++) for (const [a, b] of pairs) kept(a, b);
  assert.equal(calls, 0);
  // non-strings are never kept
  calls = 0; kept(null, 'x'); kept(null, 'x');
  assert.equal(calls, 2);
});

test('keptAnswers: answers stay right after the oldest are dropped', () => {
  const fn = (a, b) => `${a}|${b}` .length % 2 === 0;
  const kept = keptAnswers(fn, 10);
  for (let i = 0; i < 200; i++) assert.equal(kept(`x${i}`, `y${i % 37}`), fn(`x${i}`, `y${i % 37}`));
  for (let i = 199; i >= 0; i--) assert.equal(kept(`x${i}`, `y${i % 37}`), fn(`x${i}`, `y${i % 37}`));
});

test('teamMatches and pingames matching give the same answers asked twice', () => {
  const cases = [['Kansas City', 'Kansas City Chiefs'], ['KC', 'Kansas City Chiefs'], ['Chiefs', 'Kansas City Chiefs'], ['Los Angeles R', 'Los Angeles Rams'], ['Rams', 'Los Angeles Chargers'], ['Boston', 'Boston Celtics'], ['Celtics', 'Brooklyn Nets']];
  const first = cases.map(([a, b]) => teamMatches(a, b));
  assert.deepEqual(cases.map(([a, b]) => teamMatches(a, b)), first);
  assert.equal(first[0], true); assert.equal(first[4], false);
  const games = [{ id: 'g1', home: 'Kansas City Chiefs', away: 'Las Vegas Raiders', start: '2026-10-25T17:00:00Z', ml: { home: 0.7, away: 0.3, vig: 0.03 }, spreads: [], totals: [] }];
  const rows = [{ exchange: 'kalshi', gameKey: 'KXNFLGAME-26OCT25LVKC', kind: 'teams', outcomeLabel: 'Kansas City', noLabel: 'Las Vegas', startTime: '2026-10-25T17:00:00Z' }];
  const a = pingames.matchRows(rows, games), b = pingames.matchRows(rows, games);
  assert.deepEqual(a, b);
  assert.equal(a.length, 1);
  assert.equal(a[0].pYes, 0.7);
});
