const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../esmatch');
const { bo3Candidates } = require('../graders');

// WBT's three Bo1s on 10-15 as the apps listed them (diag-rawes): the apps
// disagree on the ENCE start by two hours, so the opponent has to decide
const ud = (line, opp, start, gameId) => ({ book: 'underdog', sport: 'CS', player: 'DemQQ', team: 'WBT', market: 'Kills on Map 1', line, startTime: start, matchTitle: `WBT vs ${opp}`, gameId });
const pp = (line, opp, start, gameId) => ({ book: 'prizepicks', sport: 'CS2', player: 'DemQQ', team: 'WBT', market: 'MAP 1 Kills', line, startTime: start, matchTitle: `${opp} MAP 1`, gameId });
const sl = (line, team, gameId, player = 'DemQQ') => ({ book: 'sleeper', sport: 'CS', player, team, market: 'Kills Map 1', line, gameId, startTime: '', matchTitle: '' });
const LINES = [
  ud(14.5, 'Esport Academy Copenhagen', '2026-10-15T08:00:00Z', 266491), ud(15.5, 'ENCE', '2026-10-15T14:00:00Z', 266493), ud(14.5, 'BOJONG', '2026-10-15T16:00:00Z', 266495),
  pp(15.5, 'EAC', '2026-10-15T04:00:00.000-04:00', 'EACWBT1'), pp(16, 'ENCE', '2026-10-15T08:00:00.000-04:00', 'ENCEWBT1'), pp(15.5, 'BOJONG', '2026-10-15T12:00:00.000-04:00', 'BOJONGWBT1'),
  sl(15.5, 'WBT', 'match-14'), sl(13.5, 'Esport Academy Copenhagen', 'match-14', 'Nodios'),
  sl(16.5, 'WBT', 'match-17'), sl(17.5, 'ENCE', 'match-17', 'gla1ve'),
];
const tagsOf = lines => M.matchTags(lines, { playerOf: l => l.player.toLowerCase(), sportOf: l => (l.sport === 'CS2' ? 'CS' : l.sport) });

test('a player in three same-day Bo1s gets a match per opponent, whatever each app says the start is', () => {
  const tags = tagsOf(LINES);
  const tag = l => tags.get(l);
  assert.equal(new Set(LINES.filter(l => l.player === 'DemQQ').map(tag)).size, 3);
  assert.equal(tag(LINES[0]), tag(LINES[3]), 'Underdog "Esport Academy Copenhagen" is PrizePicks "EAC"');
  assert.equal(tag(LINES[1]), tag(LINES[4]), 'ENCE at 14:00 on Underdog, 12:00 on PrizePicks: one match');
  assert.equal(tag(LINES[2]), tag(LINES[5]));
  assert.equal(tag(LINES[6]), tag(LINES[0]), 'Sleeper: the other team on its game id names the opponent');
  assert.equal(tag(LINES[8]), tag(LINES[1]));
  assert.equal(tag(LINES[1]), '2026-10-15T12:00:00.000Z', 'the tag is the earliest Underdog or PrizePicks start');
});

test('a Sleeper name nobody else uses still finds the only match; a second Sleeper match stays apart', () => {
  const u = { book: 'underdog', sport: 'CS', player: 'jame', team: 'PARIVISION', market: 'Kills on Map 1', line: 15.5, startTime: '2026-10-15T13:30:00Z', matchTitle: 'PARIVISION vs BetBoom', gameId: 1 };
  const s1 = sl(16.5, 'PARIVISION', 'match-25', 'jame'), other = sl(14.5, 'BB Team', 'match-25', 'Boombl4');
  const tags = tagsOf([u, s1, other]);
  assert.equal(tags.get(s1), tags.get(u));
  const s2 = sl(15.5, 'PARIVISION', 'match-26', 'jame'), other2 = sl(14.5, 'Aurora', 'match-26', 'XANTARES');
  const t2 = tagsOf([u, s1, other, s2, other2]);
  assert.notEqual(t2.get(s2), t2.get(u), 'a different opponent on a second Sleeper game is its own match');
});

test('borrowMatch: a Sleeper line takes the start of its own opponent\'s match', () => {
  const slOpp = M.sleeperTeams(LINES);
  const refs = LINES.filter(l => l.book !== 'sleeper');
  const b = M.borrowMatch(LINES[8], refs, { slOpp, now: Date.parse('2026-10-15T05:00:00Z') });
  assert.equal(b.startTime, '2026-10-15T14:00:00Z');
  assert.equal(b.matchTitle, 'WBT vs ENCE');
  // no game id partner and the team in three matches: no start to give it
  assert.equal(M.borrowMatch(sl(15.5, 'WBT', 'match-99'), refs, { slOpp, now: Date.parse('2026-10-15T05:00:00Z') }), null);
});

test('sideFor: a pick finds its own match against the opponent, and none when unsure', () => {
  const matches = [
    { id: 'a', teams: ['WBT', 'Esport Academy Copenhagen'], start: '2026-10-15T08:00:00Z' },
    { id: 'b', teams: ['ENCE', 'WBT'], start: '2026-10-15T14:00:00Z' },
    { id: 'c', teams: ['WBT', 'BOJONG'], start: '2026-10-15T16:00:00Z' },
  ];
  assert.equal(M.sideFor(matches, LINES[4]).m.id, 'b');
  assert.equal(M.sideFor(matches, LINES[4]).i, 1);
  assert.equal(M.sideFor(matches, LINES[3]).m.id, 'a');
  const bare = { team: 'WBT', matchTitle: '', startTime: '2026-10-15T15:00:00Z' };
  assert.equal(M.sideFor(matches, bare), null, 'an hour from two matches: neither');
  assert.equal(M.sideFor(matches, { ...bare, startTime: '2026-10-15T08:10:00Z' }).m.id, 'a');
});

test('multiMatchRows: record rows from a team\'s multi-match day', () => {
  const row = (id, team, title, start) => ({ id, sport: 'CS', team, matchTitle: title, startTime: start });
  const rows = [
    row(1, 'WBT', 'EAC MAP 1', '2026-10-14T08:00:00Z'), row(2, 'WBT', 'WBT vs ENCE', '2026-10-14T14:00:00Z'),
    row(3, 'Vitality', 'Vitality vs NAVI', '2026-10-14T16:00:00Z'), row(4, 'Vitality', 'NAVI MAPS 1-2', '2026-10-14T16:00:00Z'),
    row(5, 'WBT', 'WBT vs ENCE', '2026-10-14T14:00:00Z'),
  ];
  assert.deepEqual([...M.multiMatchRows(rows)].map(r => r.id).sort(), [1, 2, 5]);
});

test('the CS grader tries the match against the pick\'s opponent first', () => {
  const g = (n, w, l) => ({ number: n, winner_team_clan: { clan_name: w }, loser_team_clan: { clan_name: l } });
  const m = (slug, start, a, b) => ({ slug, status: 'finished', start_date: start, games: [g(1, a, b)] });
  const matches = [m('wbt-vs-bojong', '2026-10-15T16:05:00Z', 'WBT', 'BOJONG'), m('wbt-vs-ence', '2026-10-15T14:40:00Z', 'ENCE', 'WBT')];
  const pick = { team: 'WBT', matchTitle: 'ENCE MAP 1', startTime: '2026-10-15T16:00:00Z' };
  assert.equal(bo3Candidates(matches, pick)[0].m.slug, 'wbt-vs-ence');
  assert.equal(bo3Candidates(matches, { ...pick, matchTitle: '' })[0].m.slug, 'wbt-vs-bojong', 'no opponent: nearest start, as before');
});

test('the props board keeps one esports row per match when lines carry a match tag', () => {
  const pb = require('../propsboard');
  const now = Date.parse('2026-10-15T05:00:00Z');
  const tags = tagsOf(LINES);
  const rows = pb.buildRows(LINES.map(l => ({ ...l, matchTag: tags.get(l) ?? null })), { esKey: () => 'k|1', now });
  const demqq = rows.filter(r => r.player === 'DemQQ');
  assert.equal(demqq.length, 3);
  const ence = demqq.find(r => r.matchTag === '2026-10-15T12:00:00.000Z');
  assert.deepEqual([ence.books.underdog.line, ence.books.prizepicks.line, ence.books.sleeper.line], [15.5, 16, 16.5]);
});
