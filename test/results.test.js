const test = require('node:test');
const assert = require('node:assert/strict');
const { scoreboard, score, tStat } = require('../results');

const tail = (i, o = {}) => ({ id: `t${i}`, status: 'settled', recordedAt: new Date().toISOString(), grade: 'A', category: 'sports', units: 1, ...o });

test('t-stat needs spread and 3 values', () => {
  assert.equal(tStat([1, 2]), null);
  assert.equal(tStat([1, 1, 1]), null);
  assert.ok(tStat([0.1, 0.12, 0.08, 0.11]) > 2);
});

test('verdicts: proven on CLV, avoid when losing, early on small samples', () => {
  const good = Array.from({ length: 25 }, (_, i) => ({ profit: i % 2 ? 1 : -1, staked: 1, clv: 0.04 + (i % 3) * 0.01 }));
  assert.equal(score(good).verdict, 'proven');
  const bad = Array.from({ length: 10 }, (_, i) => ({ profit: -1, staked: 1, clv: -0.03 - (i % 2) * 0.01 }));
  assert.equal(score(bad).verdict, 'avoid');
  assert.equal(score(good.slice(0, 5)).verdict, 'early');
  const clvOnly = Array.from({ length: 9 }, (_, i) => ({ profit: null, staked: 0, clv: i % 3 ? 0.02 : -0.01 }));
  assert.equal(score(clvOnly).verdict, 'promising');
});

test('scoreboard cuts plays per source and ranks proven first', () => {
  const recs = [
    ...Array.from({ length: 22 }, (_, i) => tail(i, { grade: 'A', category: 'sports', profit: i % 2 ? 0.9 : -1, clv: 0.05 + (i % 4) * 0.01 })),
    ...Array.from({ length: 10 }, (_, i) => tail(100 + i, { grade: 'B', category: 'politics', profit: -1, clv: -0.04 - (i % 2) * 0.01 })),
    tail(200, { status: 'open' }),
  ];
  const edges = Array.from({ length: 4 }, (_, i) => ({ id: `e${i}`, status: 'closed', flaggedAt: new Date().toISOString(), sport: 'cs2', book: 'kalshi', market: 'match', clv: 3 + i }));
  const b = scoreboard({ tail: recs, esportsEdges: edges });
  assert.equal(b.sources.tail.open, 1);
  assert.equal(b.sources.tail.overall.n, 32);
  assert.equal(b.sources.esportsEdges.overall.avgClv, 0.045);
  const first = b.plays[0];
  assert.equal(first.verdict, 'proven');
  assert.equal(first.source, 'tail');
  const avoid = b.plays.find(p => p.play === 'B grade · politics');
  assert.equal(avoid.verdict, 'avoid');
  assert.equal(b.plays.at(-1).verdict, 'avoid');
  assert.ok(b.plays.some(p => p.source === 'esportsEdges' && p.play === 'cs2 · kalshi'));
});

test('days filter drops old records', () => {
  const old = tail(1, { recordedAt: '2020-01-01T00:00:00Z', profit: 1, clv: 0.1 });
  const b = scoreboard({ tail: [old] }, { sinceMs: Date.now() - 86400e3 });
  assert.equal(b.sources.tail.overall.n, 0);
});
