const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  createTracker, createMemoryStore, createFileStore,
  spanToMaps, statKind, outcomeFor, lineClv, legDecimal, PP_IMPLIED,
} = require('../tracker');
const { lolMapsFromRows, dotaMapsFromMatches } = require('../graders');

const HOUR = 3600000;
const T0 = Date.parse('2026-10-08T12:00:00Z');
const quiet = { warn() {}, log() {} };

function boardPick(over = {}) {
  return {
    sport: 'CS2', player: 'ZywOo', team: 'Vitality', market: 'MAPS 1-2 Kills',
    ppLine: 38.5, udLine: null, startTime: new Date(T0 + 4 * HOUR).toISOString(),
    side: 'OVER', prob: 58.4, modelPred: 40.1, predSource: 'auto', confidence: 'MED',
    bestBook: 'PP', bestEv: 3.9, lineSource: 'pp', ...over,
  };
}

function makeTracker(clock, graders = {}, store = createMemoryStore()) {
  const parseMapSpan = m => (/1-2|1\+2/.test(m) ? { count: 2, label: '1-2' } : /1-3|1\+2\+3/.test(m) ? { count: 3, label: '1-3' } : { count: 1, label: '1' });
  return createTracker({ store, graders, parseMapSpan, minEv: 0, now: () => clock.t, log: quiet });
}

test('pure helpers', () => {
  assert.deepEqual(spanToMaps('1-3'), [1, 2, 3]);
  assert.deepEqual(spanToMaps('2'), [2]);
  assert.equal(statKind('Kills on Maps 1+2'), 'kills');
  assert.equal(statKind('MAP 1 Headshots'), 'headshots');
  assert.equal(statKind('LoL Assists Maps 1-2'), 'assists');
  assert.equal(outcomeFor('OVER', 38.5, 40), 'win');
  assert.equal(outcomeFor('UNDER', 38.5, 40), 'loss');
  assert.equal(outcomeFor('OVER', 38, 38), 'push');
  assert.equal(lineClv('OVER', 38.5, 40.5), 2);      // line rose after an OVER signal: beat the close
  assert.equal(lineClv('UNDER', 38.5, 40.5), -2);
  assert.ok(Math.abs(legDecimal('PP', {}) - 1 / PP_IMPLIED) < 1e-9);
  assert.ok(Math.abs(legDecimal('UD', { udImplied: 50 }) - 2) < 1e-9);
});

test('records only qualifying picks and keeps the signal line fixed', async () => {
  const clock = { t: T0 };
  const tr = makeTracker(clock);
  await tr.recordBoard([boardPick(), boardPick({ player: 'NoEdge', bestEv: -2 }), boardPick({ player: 'NoSide', side: null })]);
  let rows = await tr.list();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].signalLine, 38.5);
  assert.deepEqual(rows[0].maps, [1, 2]);

  clock.t += HOUR;
  await tr.recordBoard([boardPick({ ppLine: 40.5, bestEv: 1.2 })]);
  rows = await tr.list();
  assert.equal(rows[0].signalLine, 38.5, 'signal never moves');
  assert.equal(rows[0].closeLine, 40.5);
  assert.equal(rows[0].clv, 2);

  // A pick that only goes +EV later is recorded at that later line
  await tr.recordBoard([boardPick({ player: 'NoEdge', ppLine: 20.5, bestEv: 4 })]);
  assert.equal((await tr.list()).length, 2);
});

test('locks at kickoff, ignores the board afterwards, and auto-grades', async () => {
  const clock = { t: T0 };
  const graders = { CS: async () => ({ maps: { 1: 22, 2: 19 }, complete: true }) };
  const tr = makeTracker(clock, graders);
  await tr.recordBoard([boardPick()]);

  clock.t = T0 + 4 * HOUR + 1;                       // kickoff passed
  assert.equal(await tr.lockStarted(), 1);
  await tr.recordBoard([boardPick({ ppLine: 50.5 })]);
  assert.equal((await tr.list())[0].closeLine, 38.5, 'frozen after lock');

  assert.deepEqual(await tr.gradeDue(), { graded: 0, review: 0, waiting: 0, errors: 0 }, 'too early to grade');
  clock.t += 2 * HOUR;
  const r = await tr.gradeDue();
  assert.equal(r.graded, 1);
  const [row] = await tr.list();
  assert.equal(row.result, 41);
  assert.equal(row.outcome, 'win');
  assert.ok(Math.abs(row.profit - (1 / PP_IMPLIED - 1)) < 1e-9);
});

test('partial series goes to review; unsupported sport waits then goes to review', async () => {
  const clock = { t: T0 };
  const graders = { CS: async () => ({ maps: { 1: 20, 2: 18 }, complete: true }) };
  const tr = makeTracker(clock, graders);
  await tr.recordBoard([
    boardPick({ market: 'MAPS 1-3 Kills', ppLine: 55.5 }),
    boardPick({ sport: 'VAL', player: 'aspas', market: 'MAPS 1-2 Kills' }),
  ]);
  clock.t = T0 + 7 * HOUR;
  await tr.lockStarted();
  let r = await tr.gradeDue();
  assert.equal(r.review, 1);
  assert.equal(r.waiting, 1);
  const cs = (await tr.list({ sport: 'CS' }))[0];
  assert.equal(cs.status, 'review');
  assert.equal(cs.result, 38);

  clock.t = T0 + 80 * HOUR;
  r = await tr.gradeDue();
  assert.equal(r.review, 1);
  assert.match((await tr.list({ sport: 'VAL' }))[0].note, /No automatic grader/);
});

test('manual grade, void, and summary math', async () => {
  const clock = { t: T0 };
  const tr = makeTracker(clock);
  await tr.recordBoard([
    boardPick({ player: 'A', bestEv: 2 }),
    boardPick({ player: 'B', bestEv: 7, side: 'UNDER' }),
    boardPick({ player: 'C', bestEv: 12, bestBook: 'UD', udLine: 38.5, udImplied: 52.63 }),
  ]);
  clock.t = T0 + 5 * HOUR;
  await tr.lockStarted();
  const ids = Object.fromEntries((await tr.list()).map(r => [r.player, r.id]));
  await tr.manualGrade(ids.A, { result: 40 });   // OVER 38.5 → win
  await tr.manualGrade(ids.B, { result: 40 });   // UNDER 38.5 → loss
  await tr.manualGrade(ids.C, { void: true });
  await assert.rejects(tr.manualGrade(ids.A, { result: 'abc' }));

  const s = await tr.summary();
  assert.equal(s.overall.graded, 2);
  assert.equal(s.overall.wins, 1);
  assert.equal(s.overall.losses, 1);
  assert.equal(s.overall.hitRate, 0.5);
  assert.equal(s.counts.void, 1);
  assert.ok(Math.abs(s.overall.units - ((1 / PP_IMPLIED - 1) - 1)) < 0.01);
  assert.equal(s.byEv['0-3%'].wins, 1);
  assert.equal(s.byEv['6-10%'].losses, 1);
  assert.equal(s.bySide.UNDER.losses, 1);

  const hi = await tr.summary({ minEv: 5 });
  assert.equal(hi.overall.graded, 1);
});

test('file store persists across restarts', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lr-')), 'picks.json');
  const clock = { t: T0 };
  const a = makeTracker(clock, {}, createFileStore(file));
  await a.recordBoard([boardPick()]);
  const b = makeTracker(clock, {}, createFileStore(file));
  const rows = await b.list();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].player, 'ZywOo');
});

test('LoL rows → maps of the first match only', () => {
  const rows = [
    { MatchId: 'M1', GameN: '2', Kills: '7', Assists: '3', DateTime: '2026-10-08 13:00:00' },
    { MatchId: 'M1', GameN: '1', Kills: '4', Assists: '9', DateTime: '2026-10-08 12:10:00' },
    { MatchId: 'M2', GameN: '1', Kills: '11', Assists: '1', DateTime: '2026-10-08 20:00:00' },
  ];
  assert.deepEqual(lolMapsFromRows(rows, 'kills'), { maps: { 1: 4, 2: 7 }, complete: true, matchId: 'M1' });
  assert.deepEqual(lolMapsFromRows(rows, 'assists').maps, { 1: 9, 2: 3 });
  assert.equal(lolMapsFromRows([], 'kills'), null);
});

test('Dota matches → series split on a long gap', () => {
  const s = T0 / 1000;
  const matches = [
    { start_time: s + 600, duration: 2400, kills: 8, assists: 10 },
    { start_time: s + 3600 + 600, duration: 2000, kills: 3, assists: 12 },
    { start_time: s + 6 * 3600, duration: 2000, kills: 15, assists: 2 },   // next series
    { start_time: s - 86400, duration: 2000, kills: 99, assists: 0 },     // yesterday
  ];
  assert.deepEqual(dotaMapsFromMatches(matches, T0, 'kills'), { maps: { 1: 8, 2: 3 }, complete: true });
  assert.equal(dotaMapsFromMatches([], T0, 'kills'), null);
});

test('gradeDue skips ungradable rows until give-up so graded sports are not starved', async () => {
  const clock = { t: T0 };
  const calls = [];
  const tr = makeTracker(clock, { LOL: async row => { calls.push(row.player); return { maps: { 1: 5, 2: 6 }, complete: true }; } });
  const csPicks = Array.from({ length: 30 }, (_, i) => boardPick({ player: `cs${i}` }));
  await tr.recordBoard([...csPicks, boardPick({ sport: 'LOL', player: 'Faker', market: 'MAPS 1-2 Kills' })]);
  clock.t = T0 + 7 * HOUR;
  await tr.lockStarted();
  const out = await tr.gradeDue({ limit: 25 });
  assert.deepEqual(calls, ['Faker']);
  assert.equal(out.graded, 1);
  assert.equal(out.waiting, 30, 'ungradable rows are counted as waiting without taking a slot');
  // once past the give-up window the CS rows still move to review
  clock.t = T0 + 80 * HOUR;
  const later = await tr.gradeDue({ limit: 100 });
  assert.equal(later.review, 30);
});

test('a rescheduled match updates the existing row instead of adding a second', async () => {
  const clock = { t: T0 };
  const tr = makeTracker(clock);
  // no game id: same UTC day
  await tr.recordBoard([boardPick()]);
  await tr.recordBoard([boardPick({ startTime: new Date(T0 + 6 * HOUR).toISOString() })]);
  let rows = await tr.list();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].startTime, new Date(T0 + 6 * HOUR).toISOString());
  // with a game id: moved to the next day, still one row
  await tr.recordBoard([boardPick({ player: 'm0NESY', gameId: 'g42' })]);
  await tr.recordBoard([boardPick({ player: 'm0NESY', gameId: 'g42', startTime: new Date(T0 + 30 * HOUR).toISOString() })]);
  rows = (await tr.list()).filter(r => r.player === 'm0NESY');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].startTime, new Date(T0 + 30 * HOUR).toISOString());
  // a different game id is a different match
  await tr.recordBoard([boardPick({ player: 'm0NESY', gameId: 'g43', startTime: new Date(T0 + 9 * HOUR).toISOString() })]);
  assert.equal((await tr.list()).filter(r => r.player === 'm0NESY').length, 2);
});

test('rows stored under the old exact-start id still match', async () => {
  const clock = { t: T0 };
  const start = new Date(T0 + 4 * HOUR).toISOString();
  const legacy = {
    id: `CS|zywoo|maps 1-2 kills|${start}`, status: 'open', sport: 'CS', player: 'ZywOo', market: 'MAPS 1-2 Kills',
    stat: 'kills', maps: [1, 2], startTime: start, signalSide: 'OVER', signalLine: 38.5, signalBook: 'PP',
    signalDecimal: 1 / PP_IMPLIED, closeLine: 38.5, signalAt: new Date(T0).toISOString(), closeAt: new Date(T0).toISOString(),
  };
  const tr = makeTracker(clock, {}, createMemoryStore([legacy]));
  const r = await tr.recordBoard([boardPick({ ppLine: 39.5, gameId: 'g1' })]);
  assert.deepEqual(r, { created: 0, updated: 1 });
  const rows = await tr.list();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, legacy.id);
  assert.equal(rows[0].closeLine, 39.5);
});
