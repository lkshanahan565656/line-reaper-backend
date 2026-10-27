// farlines.js: an app line's distance from our projection in the model's own
// standard deviations, the book-agreement check, and the record's far legs.
const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('../farlines');
const { payoutFor } = require('../nbadata');

test('probit inverts the normal CDF', () => {
  assert.ok(Math.abs(F.probit(0.5)) < 1e-9);
  assert.ok(Math.abs(F.probit(0.8413447) - 1) < 1e-4);
  assert.ok(Math.abs(F.probit(0.1586553) + 1) < 1e-4);
  assert.ok(Math.abs(F.probit(0.975) - 1.959964) < 1e-4);
  assert.ok(Math.abs(F.probit(0.01) + 2.326348) < 1e-4);
  // clipped like the models' probabilities
  assert.equal(F.probit(1), F.probit(0.995));
  assert.equal(F.distance(null), null);
  assert.equal(F.distance(0.8413), 1);
});

test('far at one sd, and the book check', () => {
  assert.equal(F.isFar(1), true);
  assert.equal(F.isFar(-1.2), true);
  assert.equal(F.isFar(0.99), false);
  assert.equal(F.isFar(null), false);
  assert.equal(F.agreeOf('Over', 20.5, 20.5), 'same');
  assert.equal(F.agreeOf('Over', 20.5, 22.5), 'toward');   // book higher, our projection higher: app stale
  assert.equal(F.agreeOf('Over', 20.5, 19.5), 'away');
  assert.equal(F.agreeOf('Under', 20.5, 18.5), 'toward');
  assert.equal(F.agreeOf('Under', 20.5, null), null);
});

test('far legs: side toward the projection, apps priced right, the stale play left out', () => {
  const row = { key: 'k', sport: 'NBA', books: { prizepicks: { line: 20.5 }, pick6: { line: 20.5, over: 1, under: 1 }, underdog: { line: 20.5, over: 1.03, under: 0.88 }, sleeper: { line: 20.5, over: 1.8, under: 1.9 } } };
  // raw P(over) 10% (d -1.28): Under; the calibrated number only 45% over
  const priced = () => ({ raw: 0.1, pOver: 0.45, mean: 14.2 });
  const legs = F.farPlays('NBA', row, priced, { payoutFor, version: 'v2' });
  assert.deepEqual(legs.map(l => l.kind), ['far-nba', 'p6-far-nba', 'ud-far-nba']);
  for (const l of legs) {
    assert.equal(l.research, true);
    assert.equal(l.play.side, 'Under');
    assert.equal(l.play.fair, 0.55);
    assert.equal(l.play.farD, -1.28);
    assert.equal(l.play.modelVersion, 'v2');
  }
  assert.equal(legs[2].play.mult, 0.88);
  // not far: nothing
  assert.equal(F.farPlays('NBA', row, () => ({ raw: 0.3, pOver: 0.4, mean: 18 }), { payoutFor }).length, 0);
  // Pinnacle's line below the app's on an Under: the app hasn't followed the book (stale): nothing
  assert.equal(F.farPlays('NBA', row, priced, { payoutFor, pinLine: 18.5 }).length, 0);
  // Pinnacle on the same number: logged, marked same
  assert.equal(F.farPlays('NBA', row, priced, { payoutFor, pinLine: 20.5 })[0].play.pinAgree, 'same');
  // Underdog side with no multiplier read, a Pick6 boost, a closed side: skipped
  const r2 = { ...row, books: { underdog: { line: 20.5, over: 1, under: null }, pick6: { line: 20.5, over: 1, under: 1.5 }, prizepicks: { line: 20.5, underOpen: false } } };
  assert.equal(F.farPlays('NBA', r2, priced, { payoutFor }).length, 0);
  // CFB kinds; an unknown sport logs nothing
  assert.deepEqual(F.farPlays('CFB', { books: { prizepicks: { line: 20.5 } } }, priced, { payoutFor }).map(l => l.kind), ['far-cfb']);
  assert.equal(F.farPlays('NHL', row, priced, { payoutFor }).length, 0);
  assert.equal(F.ALL_KINDS.size, 6);
});
