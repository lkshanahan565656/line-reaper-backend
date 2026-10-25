const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../calc');
const { PAYOUTS, PICK6_PAYOUTS } = require('../slip');
const S = require('../slips');

test("pick'em tables match the slip pricer and MY SLIPS", () => {
  for (const k of ['prizepicks_power', 'prizepicks_flex', 'underdog_standard', 'underdog_flex']) assert.deepEqual(C.PICKEM[k].tables, PAYOUTS[k]);
  assert.deepEqual(C.PICKEM.pick6.tables, PICK6_PAYOUTS);
  for (const [n, t] of Object.entries(C.PICKEM.prizepicks_power.tables)) assert.equal(S.POWER.prizepicks[n], t[n]);
  for (const [n, t] of Object.entries(C.PICKEM.betr.tables)) assert.equal(S.POWER.betr[n], t[n]);
  assert.deepEqual(C.PICKEM.prizepicks_flex.tables, S.FLEX.prizepicks);
  assert.deepEqual(C.PICKEM.underdog_flex.tables, S.FLEX.underdog);
});

test('break-even per pick: 2-pick 3x is sqrt(1/3), PP 3-pick power about 55%', () => {
  const two = C.pickemSlip('prizepicks_power', 2);
  assert.ok(Math.abs(two.breakeven - Math.sqrt(1 / 3)) < 1e-4);
  assert.equal(two.breakevenAmerican, -137);
  const three = C.pickemSlip('prizepicks_power', 3);
  assert.ok(Math.abs(three.breakeven - Math.cbrt(1 / 6)) < 1e-4);
  // EV is zero at the break-even, positive above it
  assert.ok(Math.abs(C.pickemEv(three.table, 3, three.breakeven)) < 1e-3);
  assert.ok(C.pickemSlip('prizepicks_power', 3, { p: 0.6 }).ev > 0);
});

test('flex pays partial hits, and the shown payout replaces the top one', () => {
  const f = C.pickemSlip('prizepicks_flex', 5, { p: 0.55 });
  assert.deepEqual(f.outcomes.map(o => o.hits), [5, 4, 3]);
  const exp = 10 * 0.55 ** 5 + 2 * 5 * 0.55 ** 4 * 0.45 + 0.4 * 10 * 0.55 ** 3 * 0.45 ** 2 - 1;
  assert.ok(Math.abs(f.ev - exp) < 1e-4);
  const sg = C.pickemSlip('prizepicks_power', 2, { shown: 2.4 });
  assert.equal(sg.top, 2.4);
  assert.ok(sg.breakeven > 0.64);
  // a table that can never pay back has no break-even
  assert.equal(C.pickemBreakeven({ 2: 0.9 }, 2), null);
  assert.equal(C.pickemSlip('underdog_flex', 2), null);
});

test('grid lists every slip type and size, live Pick6 tables override', () => {
  const g = C.pickemGrid({ p: 0.56 });
  assert.ok(g.some(x => x.type === 'pick6' && x.n === 8));
  const live = C.pickemGrid({ tables: { pick6: { 3: { 3: 5.5 } } } }).filter(x => x.type === 'pick6');
  assert.equal(live.length, 1);
  assert.ok(Math.abs(live[0].breakeven - Math.cbrt(1 / 5.5)) < 1e-4);
});
