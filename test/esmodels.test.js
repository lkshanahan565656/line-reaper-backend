const test = require('node:test');
const assert = require('node:assert');
const { modelCards, stackCards, gradeRows } = require('../esmodels');

const row = (i, win, extra = {}) => ({ id: 'r' + i, status: 'graded', outcome: win ? 'win' : 'loss', signalDecimal: 1.7787, signalProb: 60,
  profit: win ? 0.7787 : -1, sport: 'CS', player: 'p' + i, stat: 'kills', maps: [1, 2], gameId: 'g' + i, team: 'T' + i, startTime: '2026-10-17T10:00:00Z', matchTag: 'x', ...extra });

test('gradeRows: under 50 graded is early; 50+ well under break-even fails', () => {
  assert.equal(gradeRows(Array.from({ length: 20 }, (_, i) => row(i, i % 2))).verdict, 'early');
  const lost = gradeRows(Array.from({ length: 400 }, (_, i) => row(i, i % 2)));   // 50% vs 56.2% needed, z -2.5
  assert.equal(lost.graded, 400);
  assert.equal(gradeRows(Array.from({ length: 200 }, (_, i) => row(i, i % 2))).verdict, "losing");
  assert.equal(lost.breakEvenPct, 56.2);
  assert.equal(lost.verdict, 'failed');
  const won = gradeRows(Array.from({ length: 200 }, (_, i) => row(i, i % 3 !== 0)));  // 66.5%
  assert.equal(won.verdict, 'beats');
});

test('modelCards splits H2H alone from H2H with Pinnacle and drops untagged two-match days', () => {
  const h2h = [row(1, true, { fair: 'h2h' }), row(2, false, { fair: 'h2h-sharp' }),
    // the same team in two matches a day, no match tag: left out
    row(3, true, { fair: 'h2h', team: 'ENCE', matchTag: undefined, matchTitle: 'ENCE vs WBT', startTime: '2026-10-15T08:00:00Z' }),
    row(4, true, { fair: 'h2h', team: 'ENCE', matchTag: undefined, matchTitle: 'ENCE vs EAC', startTime: '2026-10-15T14:00:00Z' })];
  const cards = modelCards({ h2h });
  const alone = cards.find(c => c.key === 'h2h'), sharp = cards.find(c => c.key === 'h2hSharp');
  assert.equal(alone.graded, 1);
  assert.equal(alone.dropped, 2);
  assert.equal(sharp.graded, 1);
  assert.equal(cards.find(c => c.key === 'rounds').graded, 0);
});

test('stackCards: the payout a sweep needs is stakes over sweeps', () => {
  const legs = t => Array.from({ length: 6 }, (_, i) => ({ team: t, prob: 50, gameId: t }));
  const st = (i, hits) => ({ kind: 'stack', status: 'graded', book: 'PP', size: 6, table: 'prizepicks_power', hits, paysAll: 37.5, probAll: 0.05,
    profit: hits === 6 ? 36.5 : -1, start: `2026-10-${10 + (i % 9)}T10:00:00Z`, legs: legs('t' + i) });
  const list = [...Array.from({ length: 60 }, (_, i) => st(i, 3)), st(70, 6), st(71, 6), st(72, 6), st(73, 6)];
  const [pp] = stackCards(list);
  assert.equal(pp.stacks, 64);
  assert.equal(pp.swept, 4);
  assert.equal(pp.needsPays, 16);           // 64 / 4
  assert.equal(pp.needsPaysOneFewer, 21.3); // 64 / 3
  assert.equal(pp.independentSwept, +(64 / 64).toFixed(2));
  assert.equal(stackCards([{ ...st(1, 3), kind: 'best' }]).length, 0);
});
