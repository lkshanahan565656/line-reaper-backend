const test = require('node:test');
const assert = require('node:assert');
const C = require('../propcal');
const M = require('../nbamodel');
const CF = require('../cfbmodel');

test('calibrate: no cal passes through; slope shrinks toward 50%; range guard keeps it monotone', () => {
  assert.equal(C.calibrate(0.7, 'x', null), 0.7);
  const cal = { a: 0, b: 0.5, range: 1.5, stat: { y: [0.1, 0.2] } };
  const p = C.calibrate(0.7, 'x', cal);
  assert.ok(p > 0.5 && p < 0.7);
  assert.ok(C.calibrate(0.7, 'y', cal) < p);   // the per-stat fit wins
  assert.ok(C.calibrate(0.995, 'x', cal) > C.calibrate(0.9, 'x', cal));
  assert.ok(C.calibrate(0.9, 'x', cal) > C.calibrate(0.82, 'x', cal));
});

test('fitCal recovers a known slope and shrinks thin stats to the pooled fit', () => {
  // outcomes drawn from logit(true) = 0.5 * logit(raw)
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const rows = [];
  for (let i = 0; i < 20000; i++) {
    const raw = 0.2 + 0.6 * rnd();
    const pt = 1 / (1 + Math.exp(-0.5 * C.logit(raw)));
    rows.push({ stat: i % 50 ? 'big' : 'thin', raw, over: rnd() < pt ? 1 : 0 });
  }
  const cal = C.fitCal(rows);
  assert.ok(Math.abs(cal.b - 0.5) < 0.08, `pooled slope ${cal.b}`);
  assert.ok(cal.stat.big && Math.abs(cal.stat.big[1] - 0.5) < 0.08);
  assert.ok(cal.stat.thin, 'thin has 400 rows, over the 300 minimum');
  assert.equal(cal.range, 1.5);
});

test('NBA and CFB share one calibration', () => {
  const cal = { a: 0.02, b: 0.4, range: 1.5, stat: {} };
  assert.equal(M.calibrate(0.66, 'points', { cal }), C.calibrate(0.66, 'points', cal));
  // CFB: priceLine applies the params' cal; without one it is v1's raw number
  const proj = { mean: { rec_yds: 60 } };
  const dist = { rec_yds: [{ lo: 0, hi: Infinity, n: 101, q: Array.from({ length: 101 }, (_, i) => i / 50) }] };
  const raw = CF.priceLine(proj, 'rec_yds', 40.5, { ...CF.PARAMS, dist });
  const v2 = CF.priceLine(proj, 'rec_yds', 40.5, { ...CF.PARAMS, dist, cal });
  assert.ok(raw.pOver > v2.pOver && v2.pOver > 0.5);
});
