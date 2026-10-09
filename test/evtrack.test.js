const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { createEvTracker, createFileStore } = require('../evtrack');

const T0 = Date.parse('2026-10-08T12:00:00Z');
const START = '2026-10-08T23:00:00Z';
const row = (o = {}) => ({ group: 'knicks@celtics|2026-10-08|h2h', side: 'New York Knicks', book: 'draftkings', sport: 'nba',
  event: 'New York Knicks @ Boston Celtics', market: 'h2h', price: 150, decimal: 2.5, fairProb: 42, ev: 5, source: 'sharp', start: START, ...o });

test('flags once, follows the fair price to the close, then scores CLV', async () => {
  let t = T0;
  const tr = createEvTracker({ now: () => t, minEv: 2 });
  await tr.recordBoard([row(), row({ book: 'fanduel', ev: 1 })]);
  assert.equal((await tr.list()).length, 1, 'FD at 1% is below the bar');

  t += 3600e3;
  await tr.recordBoard([row({ price: 140, decimal: 2.4, fairProb: 44, ev: 5.6 })]);   // same bet, better fair later
  const [open] = await tr.list({ status: 'open' });
  assert.equal(open.price, 150, 'logged at the first price');
  assert.equal(open.closeFair, 44);

  t = Date.parse(START) + 1000;
  await tr.recordBoard([]);
  const [b] = await tr.list({ status: 'closed' });
  assert.equal(b.clv, 10, '0.44 × 2.5 − 1');
  assert.equal(b.fairMove, 2);
  const s = await tr.summary();
  assert.deepEqual(s.overall, { n: 1, avgEvAtFlag: 5, avgClv: 10, beatClosePct: 100 });
  assert.equal(s.byBook.draftkings.n, 1);
  assert.equal(s.open, 0);
});

test('a price that loses to the close scores negative CLV', async () => {
  let t = T0;
  const tr = createEvTracker({ now: () => t });
  await tr.recordBoard([row()]);
  await tr.recordBoard([row({ fairProb: 38, ev: -5 })]);   // market moved away from us
  t = Date.parse(START) + 1;
  await tr.recordBoard([]);
  const [b] = await tr.list();
  assert.equal(b.clv, -5);
  assert.equal((await tr.summary()).overall.beatClosePct, 0);
});

test('skips DFS legs and started games; survives a restart from the file store', async () => {
  const file = path.join(os.tmpdir(), `evtrack-${Date.now()}.json`);
  let t = T0;
  const a = createEvTracker({ store: createFileStore(file), now: () => t });
  await a.recordBoard([row(), row({ book: 'prizepicks', dfs: true, decimal: null }), row({ book: 'caesars', start: '2026-10-08T11:00:00Z' })]);
  assert.equal((await a.list()).length, 1);
  await new Promise(r => setTimeout(r, 20));
  const b = createEvTracker({ store: createFileStore(file), now: () => t });
  await b.recordBoard([row({ fairProb: 45 })]);
  const bets = await b.list();
  assert.equal(bets.length, 1, 'reloaded bet is not logged twice');
  assert.equal(bets[0].closeFair, 45);
});

test('a bet keeps following the fair price after its edge disappears', async () => {
  let t = T0;
  const tr = createEvTracker({ now: () => t });
  await tr.recordBoard([row()]);
  // no +EV rows now, only the market's fair price
  await tr.recordBoard([], new Map([[`${row().group}|New York Knicks`, 38]]));
  t = Date.parse(START) + 1;
  await tr.recordBoard([]);
  assert.equal((await tr.list())[0].clv, -5);
});
