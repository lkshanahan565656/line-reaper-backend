const test = require('node:test');
const assert = require('node:assert/strict');
const { createSlipTracker } = require('../sliptrack');

const H = 3600e3;
const leg = (player, line, side, extra = {}) => ({ player, team: 't-' + player, sport: 'CS2', market: 'MAPS 1-2 Kills', rawMarket: 'MAPS 1-2 Kills', line, side, prob: 58, startTime: new Date(10 * H).toISOString(), gameId: 'g1', ...extra });
const slip = (picks, extra = {}) => ({ book: 'PP', bookName: 'PrizePicks', table: 'prizepicks_power', tableName: 'Power', status: 'plus', ev: 10, probAll: 0.34, paysAll: 3, payTable: { 2: 3 }, kelly: 0.05, picks, ...extra });
const span = () => ({ label: '1-2' });

test('logs each +EV slip once and skips near and started ones', async () => {
  let t = 0;
  const st = createSlipTracker({ parseMapSpan: span, now: () => t });
  const s = slip([leg('a', 30.5, 'OVER'), leg('b', 28.5, 'UNDER')]);
  await st.record([s, s, { ...s, status: 'near', table: 'prizepicks_flex' }]);
  assert.equal((await st.list()).length, 1);
  t = 11 * H;
  await st.record([slip([leg('c', 1, 'OVER'), leg('d', 2, 'OVER')])]);
  assert.equal((await st.list()).length, 1);
});

test('grades a power slip from the stats, with results from the pick tracker first', async () => {
  let t = 0, asked = 0;
  const graders = { CS: async row => { asked++; return { maps: { 1: 18, 2: 16 }, complete: true }; } };
  const st = createSlipTracker({ parseMapSpan: span, graders, now: () => t,
    keyFor: l => l.player === 'a' ? 'known-a' : null, lookup: async () => new Map([['known-a', 33]]) });
  await st.record([slip([leg('a', 30.5, 'OVER'), leg('b', 28.5, 'OVER')])]);
  t = 13 * H;
  const r = await st.grade();
  assert.equal(r.graded, 1);
  assert.equal(asked, 1);                 // only b went to the grader
  const [row] = await st.list();
  assert.equal(row.hits, 2);
  assert.equal(row.profit, 2);            // 3x on 1u
  const sum = await st.summary();
  assert.equal(sum.slips, 1); assert.equal(sum.units, 2); assert.equal(sum.byBook.PP.cashed, 1);
});

test('flex pays on its hit count; a power miss loses the unit', async () => {
  let t = 0;
  const graders = { CS: async row => ({ maps: { 1: 10, 2: 10 }, complete: true }) };   // 20 kills each
  const st = createSlipTracker({ parseMapSpan: span, graders, now: () => t });
  const legs = [leg('a', 18.5, 'OVER'), leg('b', 19.5, 'OVER'), leg('c', 25.5, 'OVER')];
  await st.record([slip(legs, { table: 'prizepicks_flex', payTable: { 3: 2.25, 2: 1.25 } }), slip(legs, { payTable: { 3: 5 } })]);
  t = 13 * H;
  await st.grade();
  const rows = await st.list();
  assert.deepEqual(rows.map(r => [r.table, r.hits, r.profit]).sort(), [['prizepicks_flex', 2, 0.25], ['prizepicks_power', 2, -1]]);
});

test('a leg that did not play or pushed voids the slip; no result for days voids it too', async () => {
  let t = 0;
  const graders = { CS: async row => row.player === 'a' ? { unavailable: 'did not play' } : row.player === 'p' ? { maps: { 1: 10, 2: 10 }, complete: true } : null };
  const st = createSlipTracker({ parseMapSpan: span, graders, now: () => t });
  await st.record([slip([leg('a', 30.5, 'OVER'), leg('b', 28.5, 'UNDER')]), slip([leg('p', 20, 'OVER'), leg('q', 28.5, 'UNDER')]), slip([leg('x', 1.5, 'OVER'), leg('y', 2.5, 'OVER')])]);
  t = 13 * H;
  await st.grade();
  t = 10 * H + 5 * 24 * H;
  await st.grade();
  const rows = await st.list();
  assert.ok(rows.every(r => r.status === 'void'));
  assert.equal((await st.summary()).slips, 0);
});
