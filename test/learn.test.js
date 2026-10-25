// The Learn pages: every guide renders, its worked numbers come from the
// app's own math, it claims no results, and the routes serve and redirect.
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../learn');
const E = require('../oddsengine');
const C = require('../calc');
const R = require('../results');

test('every guide renders with no broken numbers and links to the next one', () => {
  for (const k of ['', ...L.ORDER]) {
    const h = L.render(k, { origin: 'https://x.test' });
    assert.ok(h && h.startsWith('<!doctype html>'), k);
    assert.ok(!/NaN|undefined|Infinity|>null</.test(h), `${k}: a number did not compute`);
    assert.ok(h.includes('href="/app"'), `${k}: links into the app`);
    assert.ok(/not a sportsbook/.test(h) && /1-800-GAMBLER/.test(h), `${k}: footer disclaimer`);
  }
  for (const k of L.ORDER) assert.ok(L.render('').includes(`href="/learn/${k}"`), `index lists ${k}`);
  assert.equal(L.render('nope'), null);
  assert.equal(L.canonicalOf('clv'), 'closing-line-value');
  assert.equal(L.canonicalOf('expected-value'), 'expected-value');
  assert.equal(L.canonicalOf('nope'), null);
});

test('worked examples are the engine’s own numbers', () => {
  const nv = L.render('no-vig-fair-odds');
  for (const m of E.DEVIG_METHODS) {
    const p = E.devig([C.americanToDecimal(-150), C.americanToDecimal(130)], m);
    assert.ok(nv.includes(`${(p[0] * 100).toFixed(2)}%`), `${m} favourite chance`);
  }
  const a = E.arb([C.americanToDecimal(105), C.americanToDecimal(102)], 100);
  assert.ok(L.render('hold-and-arbitrage').includes(`$${a.payout.toFixed(2)}`));
  const pp3 = C.pickemBreakeven(C.PICKEM.prizepicks_power.tables[3], 3);
  assert.ok(L.render('pickem-math').includes(`${(pp3 * 100).toFixed(1)}%`));
  assert.ok(L.render('how-the-record-works').includes(`<b>${R.PROVEN_N}</b>`));
  const c = C.clv(2.0, 1.87, 1.95, 'power');
  assert.ok(L.render('closing-line-value').includes(`+${(c.clv * 100).toFixed(2)}%`));
});

test('no guide claims a result or a win rate', () => {
  for (const k of L.ORDER) {
    const body = L.render(k).split('<main>')[1].split('</main>')[0];
    assert.ok(!/\b(we|our users) (won|made|hit)\b|\bROI of\b|guaranteed profit|sure thing|\+\d+u\b|Pikkit/i.test(body), k);
  }
});
