const test = require('node:test');
const assert = require('node:assert');
const { summarize, esportsSample } = require('../bookprobe');

test('book probe summarizes sport values and finds esports records', () => {
  const data = { lines: [{ sport: 'lol', wager_type: 'kills' }, { sport: 'nfl', wager_type: 'yards' }, { sport: 'lol', wager_type: 'kills', subject: 'Faker' }] };
  const s = summarize(data);
  assert.deepStrictEqual(s.top, { lines: 'array(3)' });
  assert.strictEqual(s.values.sport.lol, 2);
  assert.strictEqual(esportsSample(data).length, 2);
});
