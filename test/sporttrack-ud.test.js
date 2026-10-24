const test = require('node:test');
const assert = require('node:assert/strict');
const { legDecimal, fixUnderdogDecimal } = require('../sporttrack');

test('Underdog boost past 1.35 pays mult / 0.5623, a true decimal pays mult', () => {
  assert.equal(legDecimal('underdog', 1.44, 0.7).toFixed(3), (1.44 / 0.5623).toFixed(3));
  assert.equal(legDecimal('underdog', 4.38, 1.2), 4.38);
  assert.equal(legDecimal('underdog', 2.2, null), 2.2);
  assert.equal(legDecimal('underdog', 1, 1).toFixed(3), (1 / 0.5623).toFixed(3));
});

test('old rows that stored a boost as a decimal are repaired once', () => {
  const row = { book: 'underdog', status: 'graded', outcome: 'win', signalMult: 1.44, signalDecimal: 1.44, signalFair: 0.6, signalEv: (0.6 * 1.44 / 0.5623 - 1) * 100, closeFair: 0.58, closeEv: -16.5, profit: 0.44 };
  const f = fixUnderdogDecimal(row);
  assert.equal(f.signalDecimal, 2.5609);
  assert.equal(f.profit, 1.5609);
  assert.equal(f.closeEv, Math.round((0.58 * 2.5609 - 1) * 1e4) / 100);
  assert.equal(fixUnderdogDecimal(f), null);
  const real = { book: 'underdog', signalMult: 4.38, signalDecimal: 4.38, signalFair: 0.3, signalEv: (0.3 * 4.38 - 1) * 100, status: 'graded', outcome: 'win', profit: 3.38 };
  assert.equal(fixUnderdogDecimal(real), null);
});
