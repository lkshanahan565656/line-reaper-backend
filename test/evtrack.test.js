const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os'), path = require('path');
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
  assert.deepEqual(s.overall, { n: 1, avgEvAtFlag: 5, avgClv: 10, beatClosePct: 100, execN: 0 });
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

test('summary grades the two-minute price too', async () => {
  let t = Date.parse('2026-10-14T12:00:00Z');
  const tr = createEvTracker({ now: () => t });
  const row = { group: 'g|h2h', sport: 'nba', event: 'A @ B', start: '2026-10-14T13:00:00Z', market: 'h2h', side: 'A', book: 'fanduel', price: 100, decimal: 2, fairProb: 52, ev: 4, source: 'sharp' };
  await tr.recordBoard([row], null);
  t += 2 * 60e3;
  await tr.recordBoard([], new Map([['g|h2h|A', 52]]), { costs: new Map([['g|h2h|A|fanduel', 0.5128]]) });
  t = Date.parse('2026-10-14T13:00:01Z');
  await tr.recordBoard([], null);
  const s = await tr.summary();
  assert.equal(s.byBook.fanduel.execN, 1);
  assert.ok(Math.abs(s.byBook.fanduel.avgExecClv - 1.4) < 0.1);
});

test('the +2 min grade at $100 rides along, and the summary compares like for like', async () => {
  let t = Date.parse('2026-10-14T12:00:00Z');
  const tr = createEvTracker({ now: () => t, minEv: 0 });
  const r = { group: 'kalshi|KX-A', sport: 'nfl', event: 'A @ B', start: '2026-10-14T13:00:00Z', market: 'moneyline', side: 'A', book: 'kalshi',
    price: 0.5, decimal: 2, fairProb: 52, ev: 4, source: 'xvalue', contract: 'yes', marketId: 'KX-A' };
  await tr.recordBoard([r]);
  await tr.recordBoard([r, { ...r, group: 'kalshi|KX-B', marketId: 'KX-B', side: 'B' }]);
  assert.deepEqual(await tr.dueForExec(), [], 'not due yet');
  t += 2 * 60e3;
  const due = await tr.dueForExec();
  assert.deepEqual(due.map(b => [b.id, b.venue, b.marketId, b.contract]), [['kalshi|KX-A|A|kalshi', 'kalshi', 'KX-A', 'yes'], ['kalshi|KX-B|B|kalshi', 'kalshi', 'KX-B', 'yes']]);
  await tr.recordBoard([], null, { costs: new Map([['kalshi|KX-A|A', 0.5], ['kalshi|KX-B|B', 0.5]]), sized: new Map([['kalshi|KX-A|A|kalshi', { cost: 0.52, usd: 100 }]]) });
  assert.deepEqual(await tr.dueForExec(), [], 'graded: no longer due');
  t = Date.parse('2026-10-14T13:00:01Z');
  await tr.recordBoard([]);
  const [a] = (await tr.list()).filter(b => b.marketId === 'KX-A');
  assert.equal(a.execSized, 0.52);
  assert.equal(a.execSizedClv, 0);
  const s = await tr.summary();
  assert.equal(s.overall.execN, 2);
  assert.equal(s.overall.execAlertClv, 4);
  assert.equal(s.overall.sizedN, 1);
  assert.equal(s.overall.avgSizedClv, 0);
});
