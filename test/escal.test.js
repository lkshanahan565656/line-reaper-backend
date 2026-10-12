const test = require('node:test');
const assert = require('node:assert/strict');

const E = require('../escal');
const C = require('../context');
const S = require('../slip');

const row = (sport, stat, side, outcome, prob = 57, extra = {}) => ({
  status: 'graded', sport, stat, signalSide: side, outcome, signalProb: prob, profit: outcome === 'win' ? 0.78 : -1, ...extra,
});

test('calibration: a bucket that went 0-5 at 57% loses about 8 points; an on-par bucket barely moves', () => {
  const rows = [
    ...Array.from({ length: 5 }, () => row('CS', 'kills', 'OVER', 'loss')),
    ...Array.from({ length: 6 }, (_, i) => row('CS', 'headshots', 'UNDER', i < 4 ? 'win' : 'loss', 60)),
    row('CS', 'kills', 'OVER', 'push'), { ...row('CS', 'kills', 'OVER', 'loss'), status: 'void' },
  ];
  const c = E.calibrate(rows);
  const b = c.bucket('CS', 'kills', 'OVER');
  assert.equal(b.n, 5, 'pushes and voids do not count');
  assert.equal(b.wins, 0);
  // (0 + 30·0.57)/35 − 0.57
  assert.ok(Math.abs(c.shift('CS', 'kills', 'OVER') - ((30 * 0.57) / 35 - 0.57)) < 1e-4);
  assert.ok(c.shift('CS', 'kills', 'OVER') < -0.08 && c.shift('CS', 'kills', 'OVER') > -0.09);
  assert.ok(Math.abs(c.shift('CS', 'headshots', 'UNDER')) < 0.02, '4-2 at 60% is about on par');
  assert.equal(c.shift('LOL', 'kills', 'OVER'), 0, 'no record, no shift');
});

test('calibration measures against the raw model probability, so it cannot feed on itself', () => {
  const rows = Array.from({ length: 10 }, () => row('CS', 'kills', 'UNDER', 'loss', 50, { rawProb: 60 }));
  const c = E.calibrate(rows);
  assert.equal(c.bucket('CS', 'kills', 'UNDER').predicted, 0.6);
});

test('calibration shift is capped and the adjusted probability stays inside 1..99', () => {
  const rows = Array.from({ length: 200 }, () => row('CS', 'kills', 'OVER', 'loss', 60));
  const c = E.calibrate(rows, { maxShift: 0.12 });
  assert.equal(c.shift('CS', 'kills', 'OVER'), -0.12);
  assert.equal(E.adjustPct(60, -0.12), 48);
  assert.equal(E.adjustPct(5, -0.12), 1);
  assert.equal(E.adjustPct(55, 0), 55);
});

test('slips re-price a calibrated leg with the same shift in every scenario', () => {
  const leg = { line: 27.5, side: 'OVER', meanPerMap: 14.5, k: 3.4, stat: 'kills' };
  const plain = S.legProbIn(leg, 2);
  assert.ok(Math.abs(S.legProbIn({ ...leg, shift: -0.08 }, 2) - (plain - 0.08)) < 1e-12);
});

test('matchContext: with no ratings, a player\'s usual map win rate is the baseline for his kill factor', () => {
  const book = C.createOddsBook();
  book.set({ sport: 'CS2', teamA: 'Underdogs', teamB: 'Giants', pA: 0.3 });
  const at50 = C.matchContext({ sport: 'CS2', team: 'Underdogs', opponent: 'Giants', maps: [1, 2] }, { oddsBook: book });
  const used = C.matchContext({ sport: 'CS2', team: 'Underdogs', opponent: 'Giants', maps: [1, 2], usual: 0.6 }, { oddsBook: book });
  assert.equal(at50.pTypical, 0.5);
  assert.equal(used.pTypical, 0.6);
  assert.ok(used.factor < at50.factor, 'a team that usually wins 60% of maps is further below its norm tonight');
});
