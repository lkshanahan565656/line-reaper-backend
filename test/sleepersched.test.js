const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../sleepersched');
const P = require('../propsboard');

const schedule = [
  { status: 'pre_game', date: '2026-10-20', home: { team: 'DET' }, week: 1, game_id: '139', away: { team: 'BOS' } },
  { status: 'complete', date: '2026-09-13', home: 'CAR', week: 1, game_id: '2026101', away: 'CHI' },
];
const scores = [{ game_id: '139', start_time: 1792522800000, metadata: { scheduled: '2026-10-20T19:00:00+00:00' } }];

test('schedule and scores map a Sleeper game to its teams and tip-off', () => {
  const g = S.gamesFromSchedule(schedule);
  assert.deepEqual(g.get('139'), { date: '2026-10-20', week: 1, home: 'DET', away: 'BOS' });
  assert.equal(g.get('2026101').home, 'CAR', 'NFL rows name teams as plain strings');
  const st = S.startsFromScores(scores);
  assert.equal(st.get('139'), '2026-10-20T19:00:00.000Z');
  const [l] = S.attachGames([{ book: 'sleeper', gameId: '139', player: 'Jaylen Brown', startTime: '', matchTitle: '' }], g, st);
  assert.equal(l.startTime, '2026-10-20T19:00:00.000Z');
  assert.equal(l.matchTitle, 'BOS @ DET');
  assert.equal(l.gameDate, '2026-10-20');
});

test('refresh fetches each schedule once and only the weeks it needs', async () => {
  const urls = [];
  const http = { get: async url => { urls.push(url); return { data: /schedule/.test(url) ? schedule : scores }; } };
  const sch = S.createSleeperSchedule(http, { log: {} });
  const rows = [{ sport: 'nba', game_id: '139', season: '2026', season_type: 'regular' }, { sport: 'cs', game_id: 'match-1', season: '2026', season_type: 'regular' }];
  const sportOf = k => (k === 'nba' ? 'NBA' : null);
  const out = await sch.refresh(rows, sportOf);
  assert.equal(out.starts.get('139'), '2026-10-20T19:00:00.000Z');
  await sch.refresh(rows, sportOf);
  assert.deepEqual(urls, ['https://api.sleeper.com/schedule/nba/regular/2026', 'https://api.sleeper.com/scores/nba/regular/2026/1']);
});

test('borrowing respects a known game date; opening night never takes a preseason start', () => {
  const now = Date.parse('2026-10-14T00:00:00Z');
  const ref = [{ sport: 'NBA', player: 'Jaylen Brown', startTime: '2026-10-15T23:30:00Z', matchTitle: 'BOS @ NYK' }];
  const [dated] = P.borrowStarts([{ sport: 'NBA', player: 'Jaylen Brown', gameDate: '2026-10-20', startTime: '' }], ref, now);
  assert.equal(dated.startTime, '');
  const [same] = P.borrowStarts([{ sport: 'NBA', player: 'Jaylen Brown', gameDate: '2026-10-15', startTime: '' }], ref, now);
  assert.equal(same.startTime, '2026-10-15T23:30:00Z');
  const [undated] = P.borrowStarts([{ sport: 'NBA', player: 'Jaylen Brown', startTime: '' }], ref, now);
  assert.equal(undated.startTime, '2026-10-15T23:30:00Z');
});

test('board rows: a Sleeper line from another game gets its own row', () => {
  const now = Date.parse('2026-10-14T00:00:00Z');
  const lines = [
    { book: 'underdog', sport: 'NBA', player: 'Jaylen Brown', market: 'Points', line: 18.5, startTime: '2026-10-15T23:30:00Z' },
    { book: 'sleeper', sport: 'NBA', player: 'Jaylen Brown', market: 'Points', line: 24.5, startTime: '2026-10-20T19:00:00.000Z', overMultiplier: 1.8, underMultiplier: 1.9 },
    { book: 'prizepicks', sport: 'NBA', player: 'Jaylen Brown', market: 'Points', line: 18, startTime: '2026-10-15T23:30:00Z' },
  ];
  const rows = P.buildRows(lines, { now });
  assert.equal(rows.length, 2);
  const main = rows.find(r => r.books.underdog);
  assert.ok(main.books.prizepicks && !main.books.sleeper);
  assert.ok(rows.find(r => r.books.sleeper).key.endsWith('|2026-10-20'));
});
