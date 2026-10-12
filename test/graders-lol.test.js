const test = require('node:test');
const assert = require('node:assert/strict');
const { createLoLesportsGrader, createLoLGraderChain, loleMatchFor, loleStatFromWindow, pickTeams, createCsGrader } = require('../graders');

const NOW = Date.parse('2026-10-12T21:00:00Z');
const ev = (id, start, a, b, state = 'completed') => ({ type: 'match', startTime: start, state,
  match: { id, teams: [{ name: a.name, code: a.code }, { name: b.name, code: b.code }] } });
const KT = { name: 'kt Rolster', code: 'KT' }, VIT = { name: 'Team Vitality', code: 'VIT' };
const BFX = { name: 'BNK FEARX', code: 'BFX' }, JDG = { name: 'Beijing JDG Esports', code: 'JDG' };
const win = (names, kills, state = 'finished') => ({
  gameMetadata: { blueTeamMetadata: { participantMetadata: names.slice(0, 5).map((n, i) => ({ participantId: i + 1, summonerName: n })) },
    redTeamMetadata: { participantMetadata: names.slice(5).map((n, i) => ({ participantId: i + 6, summonerName: n })) } },
  frames: [{ gameState: state, blueTeam: { participants: kills.slice(0, 5).map((k, i) => ({ participantId: i + 1, kills: k, assists: 10 + i })) },
    redTeam: { participants: kills.slice(5).map((k, i) => ({ participantId: i + 6, kills: k, assists: 20 + i })) } }],
});
const NAMES = ['VITNaakNako', 'VITLyncas', 'VITHumanoid', 'VITCarzzy', 'VITFleshy', 'KTPerfecT', 'KTCuzz', 'KTBdd', 'KTJiwoo', 'KTEffort'];

test('pickTeams: own team, else both teams from the match title', () => {
  assert.deepEqual(pickTeams({ team: 'LP' }), ['LP']);
  assert.deepEqual(pickTeams({ team: '', matchTitle: 'Nuclear TigeRES vs XI Esport' }), ['Nuclear TigeRES', 'XI Esport']);
  assert.deepEqual(pickTeams({ team: '' }), []);
});

test('lolesports helpers: the team\'s match near kickoff, the stat by team-code name', () => {
  const evs = [ev('m1', '2026-10-12T06:00:00Z', KT, VIT), ev('m2', '2026-10-12T09:00:00Z', BFX, JDG)];
  assert.equal(loleMatchFor(evs, { team: 'KT Rolster', startTime: '2026-10-12T07:00:00Z' }).match.id, 'm1');
  assert.equal(loleMatchFor(evs, { team: 'Team Vitality', startTime: '2026-10-12T09:00:00Z' }).match.id, 'm1');
  assert.equal(loleMatchFor(evs, { team: 'T1', startTime: '2026-10-12T09:00:00Z' }), null);
  const w = win(NAMES, [1, 5, 4, 6, 0, 3, 2, 7, 8, 1]);
  assert.equal(loleStatFromWindow(w, 'Lyncas', 'kills'), 5);
  assert.equal(loleStatFromWindow(w, 'Bdd', 'kills'), 7);
  assert.equal(loleStatFromWindow(w, 'Bdd', 'assists'), 22);
  assert.equal(loleStatFromWindow(w, 'Faker', 'kills'), undefined);
  assert.equal(loleStatFromWindow(win(NAMES, [1, 5, 4, 6, 0, 3, 2, 7, 8, 1], 'in_game'), 'Bdd', 'kills'), undefined, 'only a finished game counts');
});

test('lolesports grader: schedule, event details, each finished game\'s last frame', async () => {
  const calls = [];
  const http = { get: async (url, opts) => {
    calls.push(url);
    if (url.endsWith('/getSchedule')) return { data: { data: { schedule: { events: [ev('m1', '2026-10-12T06:00:00Z', KT, VIT)], pages: {} } } } };
    if (url.endsWith('/getEventDetails')) return { data: { data: { event: { match: { games: [
      { number: 1, id: 'g1', state: 'completed' }, { number: 2, id: 'g2', state: 'completed' }, { number: 3, id: 'g3', state: 'completed' },
      { number: 4, id: 'g4', state: 'unneeded' }] } } } } };
    assert.match(opts.params.startingTime, /0\.000Z$/, 'starting time on a 10 s boundary');
    const k = { g1: 3, g2: 0, g3: 4 }[url.split('/').pop()];
    return { data: win(NAMES, [0, 0, 0, 0, 0, 0, 0, k, 0, 0]) };
  } };
  const grade = createLoLesportsGrader(http, { now: () => NOW });
  const out = await grade({ player: 'Bdd', team: 'KT Rolster', stat: 'kills', startTime: '2026-10-12T06:00:00Z' });
  assert.deepEqual(out, { maps: { 1: 3, 2: 0, 3: 4 }, complete: true, matchId: 'm1' });
  // finished windows are kept: a second player in the same match re-reads nothing but the details
  const before = calls.length;
  await grade({ player: 'Cuzz', team: 'KT Rolster', stat: 'kills', startTime: '2026-10-12T06:00:00Z' });
  assert.equal(calls.length - before, 1);
});

test('LoL chain: falls through to the next source, and rethrows only when none answer', async () => {
  const chain = createLoLGraderChain(async () => null, async () => ({ maps: { 1: 2 }, complete: true }));
  assert.deepEqual((await chain({})).maps, { 1: 2 });
  const failing = createLoLGraderChain(async () => null, async () => { throw new Error('ratelimited'); });
  await assert.rejects(failing({}), /ratelimited/);
  assert.equal(await createLoLGraderChain(async () => null)({}), null);
});

test('CS grader: the pick\'s match never parsed and long over → unavailable; recent → keep waiting', async () => {
  const game = (id, number) => ({ id, number, status: 'finished', winner_team_clan: { clan_name: 'Nuclear TigeRES' }, loser_team_clan: { clan_name: 'XI Esport' } });
  const match = { id: 9, slug: 'nuclear-tigeres-vs-xi-esport', status: 'finished', start_date: '2026-10-12T14:10:00.000+00:00', end_date: '2026-10-12T16:00:00.000+00:00', games: [game(1, 1), game(2, 2)] };
  const http = { get: async url => (url.endsWith('/matches') ? { data: { results: [match] } } : { data: [] }) };
  const pick = { player: 'Djon8', team: '', matchTitle: 'Nuclear TigeRES vs XI Esport', stat: 'kills', startTime: '2026-10-12T14:10:00Z' };
  assert.equal(await createCsGrader(http, { now: () => NOW, pause: 0 })(pick), null, '5 hours after the end: bo3 may still parse it');
  const later = Date.parse('2026-10-13T12:00:00Z');
  const out = await createCsGrader(http, { now: () => later, pause: 0 })(pick);
  assert.match(out.unavailable, /nuclear-tigeres-vs-xi-esport/);
  assert.equal(await createCsGrader(http, { now: () => later, pause: 0 })({ ...pick, matchTitle: '' }), null, 'no team: no verdict');
});
