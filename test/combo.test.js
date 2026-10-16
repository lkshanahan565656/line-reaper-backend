const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../calc');

test('a combo is priced as the product of its legs, with the most a quote can ask', () => {
  const f = C.comboFair([{ fair: 0.55, game: 'a' }, { fair: 0.6, game: 'b' }]);
  assert.equal(f.fair, 0.33);
  assert.equal(f.american, 203);
  // 30¢ + Kalshi's fee is under 33¢ / 1.02; 31¢ only clears break-even
  assert.equal(f.maxAsk, 0.3);
  assert.equal(f.breakEven, 0.31);
  const cost = p => p + 0.07 * p * (1 - p);
  assert.ok(cost(f.maxAsk) <= 0.33 / 1.02 && cost(f.maxAsk + 0.01) > 0.33 / 1.02);
  assert.equal(f.sameGame, false);
});

test('same-game legs are flagged; one leg or a missing fair is no combo', () => {
  assert.equal(C.comboFair([{ fair: 0.5, game: 'a' }, { fair: 0.5, game: 'a' }]).sameGame, true);
  assert.equal(C.comboFair([{ fair: 0.5 }]), null);
  assert.equal(C.comboFair([{ fair: 0.5 }, { fair: null }]), null);
});
