const test = require('node:test');
const assert = require('node:assert');
const { spanIsCertain, gapPlay, gapPlays, gapBucket, gapRecord } = require('../pingap');
const { createTracker, createMemoryStore } = require('../tracker');

const mapsOf = p => (p.market.includes('1+2+3') ? [1, 2, 3] : [1, 2]);
const pick = (o = {}) => ({ sport: 'LOL', player: 'Faker', team: 'T1', matchTitle: 'T1 vs GEN', gameId: 9, market: 'Kills on Maps 1+2', startTime: '2030-01-01T10:00:00Z',
  ppLine: 6.5, udLine: 7.5, marketPred: 7, context: { bestOf: 3 }, pinTeam: { factor: 1.08, pin: 16, books: 14.8, players: 5 }, ...o });

test('spanIsCertain keeps spans every series plays', () => {
  assert.equal(spanIsCertain([1, 2], 3), true);
  assert.equal(spanIsCertain([1, 2, 3], 3), false);
  assert.equal(spanIsCertain([1, 2, 3], 5), true);
  assert.equal(spanIsCertain([1, 2, 3], undefined), false);
  assert.equal(spanIsCertain([1], 1), true);
});

test('gapPlay takes Pinnacle side at the softest line', () => {
  const over = gapPlay(pick(), { mapsOf });
  assert.equal(over.side, 'OVER');
  assert.equal(over.bestBook, 'PP');
  assert.equal(over.ppLine, 6.5);
  const under = gapPlay(pick({ pinTeam: { factor: 0.9 } }), { mapsOf });
  assert.equal(under.side, 'UNDER');
  assert.equal(under.bestBook, 'UD');
  assert.equal(under.udLine, 7.5);
  assert.equal(under.bestEv, 0);
  assert.equal(under.pinTeam.factor, 0.9);
});

test('gapPlay skips small gaps, uncertain spans and missing lines', () => {
  assert.equal(gapPlay(pick({ pinTeam: { factor: 1.02 } }), { mapsOf }), null);
  assert.equal(gapPlay(pick({ pinTeam: null }), { mapsOf }), null);
  assert.equal(gapPlay(pick({ market: 'Kills on Maps 1+2+3' }), { mapsOf }), null);
  assert.ok(gapPlay(pick({ market: 'Kills on Maps 1+2+3', context: { bestOf: 5 } }), { mapsOf }));
  assert.equal(gapPlay(pick({ ppLine: null, udLine: null }), { mapsOf }), null);
  assert.equal(gapPlays([pick(), pick({ pinTeam: null })], { mapsOf }).length, 1);
});

test('gapBucket and gapRecord count plays and teams', () => {
  assert.equal(gapBucket(1.04), '3-5%');
  assert.equal(gapBucket(0.93), '5-10%');
  assert.equal(gapBucket(1.2), '10%+');
  const rows = [
    { status: 'graded', outcome: 'win', profit: 0.78, pinTeam: 1.08, signalSide: 'OVER', team: 'T1', gameId: 9 },
    { status: 'graded', outcome: 'loss', profit: -1, pinTeam: 1.08, signalSide: 'OVER', team: 'T1', gameId: 9 },
    { status: 'graded', outcome: 'win', profit: 0.78, pinTeam: 0.85, signalSide: 'UNDER', team: 'GEN', gameId: 9 },
    { status: 'open', pinTeam: 0.85 },
  ];
  const r = gapRecord(rows);
  assert.equal(r.all.plays, 3);
  assert.equal(r.all.teams, 2);
  assert.equal(r.all.hitRate, 0.6667);
  assert.equal(r['5-10%'].plays, 2);
  assert.equal(r['10%+'].wins, 1);
  assert.equal(r.unders.plays, 1);
});

test("gap plays are tracked like picks, on Pinnacle's side", async () => {
  let t = Date.parse('2030-01-01T08:00:00Z');
  const tr = createTracker({ store: createMemoryStore(), now: () => t, log: { log() {}, warn() {} },
    graders: { LOL: async () => ({ value: 9 }) }, parseMapSpan: () => ({ count: 2, label: '1-2' }) });
  await tr.recordBoard(gapPlays([pick()], { mapsOf }));
  const [row] = await tr.list();
  assert.equal(row.signalSide, 'OVER');
  assert.equal(row.signalBook, 'PP');
  assert.equal(row.signalLine, 6.5);
  assert.equal(row.pinTeam, 1.08);
});
