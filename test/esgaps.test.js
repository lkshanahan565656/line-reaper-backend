const test = require('node:test');
const assert = require('node:assert');
const { bookLines, lineGap, gapOutcome, describeGap } = require('../esgaps');
const { createTracker, createMemoryStore, gapGroup } = require('../tracker');
const { diffBoards, describe } = require('../alerts');

// chance the over wins on a consensus mean of 3, a kill a line worth 12 points
const fairOver = line => Math.min(0.95, Math.max(0.05, 0.5 + (3 - line) * 0.12));

test('bookLines reads each book at its own line, whichever book sourced the pick', () => {
  assert.deepEqual(bookLines({ lineSource: 'pp', ppLine: 1.5, udLine: 3.5, sleeperLine: 3.5 }), { PP: 1.5, UD: 3.5, SL: 3.5 });
  assert.deepEqual(bookLines({ lineSource: 'ud', ppLine: 3.5, udLine: 3.5 }), { UD: 3.5 });
  assert.deepEqual(bookLines({ lineSource: 'sl', ppLine: 2.5, sleeperLine: 2.5 }), { SL: 2.5 });
});

test('lineGap: an over at the low book, worth enough win chance', () => {
  const p = { lineSource: 'pp', ppLine: 1.5, udLine: 3.5, sleeperLine: 3.5, side: 'OVER', bestBook: 'PP' };
  const g = lineGap(p, fairOver);
  assert.equal(g.book, 'PP');
  assert.equal(g.line, 1.5);
  assert.deepEqual(g.vs, [{ book: 'SL', line: 3.5 }, { book: 'UD', line: 3.5 }]);
  assert.equal(g.pts, 2);
  assert.equal(g.probPts, 24);
  assert.equal(describeGap(g), 'PrizePicks Over 1.5 (Sleeper 3.5, Underdog 3.5)');
});

test('lineGap: none when the other books sit on the wrong side, agree, or the gap is small', () => {
  // an under at the low book is the hard side
  assert.equal(lineGap({ lineSource: 'pp', ppLine: 1.5, udLine: 3.5, side: 'UNDER', bestBook: 'PP' }, l => 1 - fairOver(l)), null);
  assert.equal(lineGap({ lineSource: 'pp', ppLine: 3.5, udLine: 3.5, side: 'OVER', bestBook: 'PP' }, fairOver), null);
  // half a kill on a big line is worth almost nothing
  assert.equal(lineGap({ lineSource: 'pp', ppLine: 40.5, udLine: 41, side: 'OVER', bestBook: 'PP' }, () => 0.5), null);
  // no fair price, no gap
  assert.equal(lineGap({ lineSource: 'pp', ppLine: 1.5, udLine: 3.5, side: 'OVER', bestBook: 'PP' }, null), null);
});

test('lineGap: an under at the high book', () => {
  const g = lineGap({ lineSource: 'pp', ppLine: 3.5, udLine: 5.5, side: 'UNDER', bestBook: 'UD' }, l => 1 - fairOver(l));
  assert.equal(g.book, 'UD');
  assert.deepEqual(g.vs, [{ book: 'PP', line: 3.5 }]);
});

test('gapOutcome: our book fixed it, pulled it, the others came, or it held', () => {
  const row = { signalBook: 'PP', signalLine: 1.5, gapVs: [{ book: 'UD', line: 3.5 }] };
  assert.equal(gapOutcome({ ...row, closeLines: { PP: 3.5, UD: 3.5 } }), 'caught');
  assert.equal(gapOutcome({ ...row, closeLines: { PP: 2.5, UD: 3.5 } }), 'caught');
  assert.equal(gapOutcome({ ...row, closeLines: { UD: 3.5 } }), 'pulled');
  assert.equal(gapOutcome({ ...row, closeLines: { PP: 1.5, UD: 1.5 } }), 'joined');
  assert.equal(gapOutcome({ ...row, closeLines: { PP: 1.5, UD: 3.5 } }), 'held');
  assert.equal(gapOutcome({ signalBook: 'PP', signalLine: 1.5, gapVs: null, closeLines: {} }), null);
});

test('tracker keeps every book line, the gap, and how it ended', async () => {
  let t = Date.parse('2026-10-14T00:00:00Z');
  const tr = createTracker({ store: createMemoryStore(), now: () => t });
  const gap = { book: 'PP', line: 1.5, side: 'OVER', vs: [{ book: 'UD', line: 3.5 }], pts: 2, probPts: 24 };
  const pick = { sport: 'LOL', player: 'Keria', market: 'MAPS 1-2 Kills', lineSource: 'pp', ppLine: 1.5, udLine: 3.5, side: 'OVER', bestEv: 20, bestBook: 'PP', prob: 70,
    startTime: new Date(t + 3 * 3600e3).toISOString(), gameId: 7, lineGap: gap };
  const plain = { ...pick, player: 'Faker', udLine: 1.5, lineGap: null, gameId: 8 };
  await tr.recordBoard([pick, plain]);
  let rows = await tr.list();
  const g = rows.find(r => r.player === 'Keria');
  assert.deepEqual(g.signalLines, { PP: 1.5, UD: 3.5 });
  assert.deepEqual(g.gapVs, [{ book: 'UD', line: 3.5 }]);
  assert.equal(gapGroup(g), 'line gap');
  assert.equal(gapGroup(rows.find(r => r.player === 'Faker')), 'no gap');
  assert.equal(gapGroup({}), 'before gap tracking');
  t += 60e3;
  // PrizePicks fixes its number
  await tr.recordBoard([{ ...pick, ppLine: 3.5, lineGap: null }]);
  rows = await tr.list();
  assert.deepEqual(rows.find(r => r.player === 'Keria').closeLines, { PP: 3.5, UD: 3.5 });
  const sum = await tr.summary();
  assert.equal(sum.byGap['line gap'].picks, 1);
  assert.deepEqual(sum.gapOutcomes, { caught: 1 });
});

test('alerts: a new line gap fires once, naming the book, line and the others', () => {
  const now = Date.parse('2026-10-14T00:00:00Z');
  const base = { sport: 'LOL', player: 'Keria', market: 'MAPS 1-2 Kills', side: 'OVER', bestBook: 'PP', ppLine: 1.5, startTime: new Date(now + 3600e3).toISOString() };
  const gap = { book: 'PP', line: 1.5, side: 'OVER', vs: [{ book: 'UD', line: 3.5 }, { book: 'SL', line: 3.5 }], pts: 2, probPts: 24 };
  const seen = new Map();
  const ev = diffBoards([{ ...base, bestEv: -1 }], [{ ...base, bestEv: 12, lineGap: gap }], { now, seen });
  assert.equal(ev.length, 1);
  assert.equal(ev[0].kind, 'gap');
  assert.equal(describe(ev[0]), 'Line gap +12.0%: Keria Over 1.5 MAPS 1-2 Kills on PrizePicks (LOL) · Underdog 3.5, Sleeper 3.5');
  // the same gap on the next refresh is quiet, and no edge alert doubles it
  assert.equal(diffBoards([{ ...base, bestEv: 12, lineGap: gap }], [{ ...base, bestEv: 12.5, lineGap: gap }], { now: now + 60e3, seen }).length, 0);
  // a small gap play under the floor doesn't alert
  assert.equal(diffBoards([{ ...base, bestEv: -1 }], [{ ...base, player: 'Zeus', bestEv: 1, lineGap: gap }], { now }).length, 0);
});
