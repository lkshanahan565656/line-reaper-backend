const test = require('node:test');
const assert = require('node:assert');
const { createTracker, createMemoryStore, marketClv, clvKind } = require('../tracker');

const future = t => new Date(t + 3 * 3600e3).toISOString();

test('marketClv: move, direction and EV at the close', () => {
  const up = marketClv({ signalFair: 0.55, closeFair: 0.6, signalDecimal: 1.8 });
  assert.ok(Math.abs(up.move - 0.05) < 1e-9);
  assert.equal(up.dir, 1);
  assert.ok(Math.abs(up.closeEv - 0.08) < 1e-9);
  assert.equal(marketClv({ signalFair: 0.55, closeFair: 0.553, signalDecimal: 1.8 }).dir, 0);
  assert.equal(marketClv({ signalFair: 0.55, closeFair: 0.5, signalDecimal: 1.8 }).dir, -1);
  assert.equal(marketClv({ signalFair: null, closeFair: 0.5 }), null);
});

test('clvKind pools board picks and rows alike', () => {
  assert.equal(clvKind({ sport: 'LoL', market: 'Kills on Maps 1-3', bestBook: 'UD', side: 'OVER' }), clvKind({ sport: 'LOL', stat: 'kills', signalBook: 'UD', signalSide: 'OVER' }));
});

test('tracker prices the signal ticket at signal and at close', async () => {
  let t = Date.parse('2026-10-14T00:00:00Z');
  // the consensus mean drives the chance: over wins more often as it rises
  const fairProb = (p, line, side) => { const over = Math.min(0.95, Math.max(0.05, 0.5 + (p.marketPred - line) * 0.1)); return side === 'OVER' ? over : 1 - over; };
  const tr = createTracker({ store: createMemoryStore(), fairProb, now: () => t });
  const pick = { sport: 'LOL', player: 'Faker', market: 'Kills on Maps 1-3', ppLine: 4.5, udLine: 4.5, side: 'OVER', bestEv: 5, bestBook: 'PP', prob: 58, startTime: future(t), gameId: 1, marketPred: 4.5 };
  await tr.recordBoard([pick]);
  let [row] = await tr.list();
  assert.equal(row.signalFair, 0.5);
  assert.equal(row.closeFair, null);
  t += 60e3;
  // PrizePicks moves to 5.5 and Underdog follows: the market now sees 5.3
  await tr.recordBoard([{ ...pick, ppLine: 5.5, udLine: 5.5, marketPred: 5.3 }]);
  [row] = await tr.list();
  assert.equal(row.closeFair, 0.58);
  assert.equal(row.clv, 1);   // line CLV still kept
  const sum = await tr.summary();
  assert.equal(sum.overall.mktMoved, 1);
  assert.equal(sum.overall.mktBeat, 1);
  assert.ok(sum.overall.closeEvAvg > 0);
  assert.ok(sum.byKind['LOL|kills|PP|OVER']);
  const kinds = await tr.clvByKind();
  assert.equal(kinds['LOL|kills|PP|OVER'].mktBeatShare, 1);
});

test('rows signaled before market CLV never get a close price', async () => {
  let t = Date.parse('2026-10-14T00:00:00Z');
  const store = createMemoryStore([{ id: 'x', status: 'open', sport: 'LOL', player: 'Faker', market: 'Kills on Maps 1-3', stat: 'kills', maps: [1, 2, 3], startTime: future(t), gameId: 1, signalAt: new Date(t).toISOString(), signalSide: 'OVER', signalLine: 4.5, signalBook: 'PP', signalDecimal: 1.78, closeAt: new Date(t).toISOString() }]);
  const tr = createTracker({ store, fairProb: () => 0.6, now: () => t + 60e3 });
  await tr.recordBoard([{ sport: 'LOL', player: 'Faker', market: 'Kills on Maps 1-3', ppLine: 4.5, side: 'OVER', bestEv: 5, startTime: future(t), gameId: 1, marketPred: 5 }]);
  const [row] = await tr.list();
  assert.equal(row.closeFair, undefined);
});
