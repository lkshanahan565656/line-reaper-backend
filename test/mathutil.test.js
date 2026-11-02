// mathutil.js: the shared rounding, odds and escaping helpers that replaced
// 124 module-local copies. Same results as those copies, edge cases included.
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../mathutil');

test('plain roundings are plain arithmetic (null reads as 0, as the old copies did)', () => {
  assert.equal(M.r1(1.25), 1.3);
  assert.equal(M.r2(1.005 * 100 / 100), Math.round(1.005 * 100) / 100);
  assert.equal(M.r4(0.123456), 0.1235);
  assert.equal(M.r2(null), 0);
  assert.ok(Number.isNaN(M.r4(undefined)));
});

test('OrNull roundings give null for missing or non-finite values', () => {
  for (const f of [M.r1OrNull, M.r2OrNull, M.r4OrNull]) {
    assert.equal(f(null), null);
    assert.equal(f(undefined), null);
    assert.equal(f(NaN), null);
    assert.equal(f(Infinity), null);
  }
  assert.equal(M.r2OrNull(-0.126), -0.13);
  assert.equal(M.r4OrNull(0.55555), 0.5556);
});

test('toProb: American odds to implied probability', () => {
  assert.equal(M.toProb(100), 0.5);
  assert.equal(M.toProb(-200), 2 / 3);
  assert.equal(M.toProb(150), 0.4);
});

test('num and numNoBool', () => {
  assert.equal(M.num('1.5'), 1.5);
  assert.equal(M.num(''), null);
  assert.equal(M.num(null), null);
  assert.equal(M.num('x'), null);
  assert.equal(M.num(true), 1, 'num keeps the old copies\' reading of true');
  assert.equal(M.numNoBool(true), null);
  assert.equal(M.numNoBool('2'), 2);
});

test('escHtml escapes the five characters', () => {
  assert.equal(M.escHtml(`<a href="x">'&'</a>`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
  assert.equal(M.escHtml(null), '');
});
