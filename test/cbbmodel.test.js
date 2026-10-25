// College basketball prop model (cbbmodel.js, cbbdata.js): the NBA model on
// college boxes with players keyed by ESPN athlete id and teams by ESPN team
// id, a name index that picks the player whose school plays in the row's
// window, strict school matching, its own kinds and the college constants.
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../cbbmodel');
const D = require('../cbbdata');
const NM = require('../nbamodel');

const DAY = 86400e3;
const T0 = Date.parse('2025-12-01T00:00:00Z');
const KEYS = ['minutes', 'points', 'fieldGoalsMade-fieldGoalsAttempted', 'threePointFieldGoalsMade-threePointFieldGoalsAttempted', 'freeThrowsMade-freeThrowsAttempted',
  'rebounds', 'assists', 'turnovers', 'steals', 'blocks', 'offensiveRebounds', 'defensiveRebounds', 'fouls'];
function ath(name, id, min, pts) {
  return { athlete: { displayName: name, id }, starter: true, stats: [String(min), String(pts), '6-13', '2-5', '3-4', '5', '3', '2', '1', '0', '1', '4', '2'] };
}
const five = (pre, star) => [0, 1, 2, 3, 4].map(i => ath(i === 0 && star ? star.name : `${pre} P${i}`, i === 0 && star ? star.id : `${pre}${i}`, i === 0 && star ? star.min : 34, i === 0 && star ? star.pts : 12));
// two schools both abbreviated "WIS" would clash by abbreviation; ids keep them apart
function summary(id, t, home, away, ha, aa) {
  return { id, comp: { date: new Date(t).toISOString(), competitors: [{ homeAway: 'home', team: { abbreviation: home.ab, id: home.id }, score: '71' }, { homeAway: 'away', team: { abbreviation: away.ab, id: away.id }, score: '66' }] },
    players: [{ team: { abbreviation: home.ab, id: home.id }, statistics: [{ keys: KEYS, athletes: ha }] }, { team: { abbreviation: away.ab, id: away.id }, statistics: [{ keys: KEYS, athletes: aa }] }],
    pickcenter: [{ details: `${home.ab} -5.5`, overUnder: 141.5, spread: -5.5, homeTeamOdds: { favorite: true }, awayTeamOdds: { favorite: false } }] };
}
const DUKE = { ab: 'DUKE', id: '150' }, UNC = { ab: 'UNC', id: '153' }, KU = { ab: 'KU', id: '2305' }, BAY = { ab: 'BAY', id: '239' };
// two different players called "Jalen Smith": one at Duke (20 a game), one at Kansas (6 a game)
function games(n = 20) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = T0 + i * 3 * DAY;
    out.push(C.compactGame(summary(`d${i}`, t, DUKE, UNC, five('Duk', { name: 'Jalen Smith', id: '9001', min: 32, pts: 20 }), five('Unc'))));
    out.push(C.compactGame(summary(`k${i}`, t + 3600e3, KU, BAY, five('Kan', { name: 'Jalen Smith', id: '9002', min: 18, pts: 6 }), five('Bay'))));
  }
  return out;
}

test('a college box is keyed by athlete id and team id, with the college total kept', () => {
  const g = games(1)[0];
  assert.equal(g.home, '150');
  assert.equal(g.away, '153');
  assert.equal(g.total, 141.5);   // the NBA floor (150) would drop it
  assert.equal(g.spread, -5.5);
  assert.equal(g.abbr['150'], 'DUKE');
  const p = g.players.find(x => x.name === 'Jalen Smith');
  assert.equal(p.key, 'a9001');
  assert.equal(p.team, '150');
  assert.equal(NM.compactGame(summary('x', T0, DUKE, UNC, five('a'), five('b'))).total, null, 'the NBA reading would drop a 141.5 total');
});

test('the college constants: 40-minute games, 200 player-minutes, totals and pace floors', () => {
  assert.equal(C.PARAMS.teamMinutes, 200);
  assert.ok(C.PARAMS.maxMin <= 40 && C.PARAMS.gameMin <= 45);
  assert.ok(C.PARAMS.minPoss < 60);
  const H = C.buildHistory(games(12));
  const pr = C.project(H, 'a9001', { t: T0 + 40 * DAY, team: '150', opp: '153', home: true, out: [] });
  assert.ok(pr.minutes.mean <= C.PARAMS.maxMin);
  assert.ok(Math.abs(C.expected(pr, 'points') - 20) < 4, `about 20 points (${C.expected(pr, 'points')})`);
});

test('the live layer picks the Jalen Smith whose school plays in the row window, and logs CBB kinds', () => {
  const seed = games(20);
  const tip = T0 + 70 * DAY;
  const m = D.createCbbModel({ http: { get: async () => { throw new Error('offline'); } }, seed, now: () => tip - 3 * 3600e3 });
  m.state.schedule = [{ id: 'live1', t: tip, home: '2305', away: '239', done: false, total: 145.5, spread: -8.5, homeName: 'Kansas Jayhawks', awayName: 'Baylor Bears', homeAbbr: 'KU', awayAbbr: 'BAY' }];
  m.state.refreshedAt = new Date(tip - 3 * 3600e3).toISOString();
  const row = { key: 'r1', sport: 'CBB', player: 'Jalen Smith', team: 'KU', mkey: 'points', startTime: new Date(tip).toISOString(), books: { prizepicks: { line: 15.5 } } };
  const p = m.projectionFor(row);
  assert.ok(p.proj, p.reason);
  assert.equal(p.proj.key, 'a9002', 'the Kansas player, not the Duke one');
  const sec = m.section([row]);
  assert.equal(sec.length, 1);
  assert.equal(sec[0].team, 'KU');
  assert.equal(sec[0].opp, 'BAY');
  assert.equal(sec[0].version, D.MODEL_VERSION);
  assert.equal(sec[0].apps.prizepicks.side, 'Under', '6 a game against a 15.5 line');
  // the record's legs: CBB kinds only, research, never an NBA kind
  const legs = m.plays([row]);
  assert.ok(legs.length >= 1);
  assert.ok(legs.every(l => l.kind === 'cbb-model' && l.research === true && l.play.modelVersion === D.MODEL_VERSION));
  // an NBA row is not the college model's
  assert.equal(m.section([{ ...row, sport: 'NBA' }]).length, 0);
  // no college injury list is read
  assert.equal(m.state.injuriesAt, null);
});

test('school matching is exact: abbreviation or full name, never a shared nickname', () => {
  assert.equal(D.teamMatch('2305', 'Kansas Jayhawks', 'KU', 'KU'), true);
  assert.equal(D.teamMatch('2305', 'Kansas Jayhawks', 'kansas jayhawks', 'KU'), true);
  assert.equal(D.teamMatch('2509', 'Kentucky Wildcats', 'Wildcats', 'UK'), false);
  assert.equal(D.teamMatch('2509', 'Kentucky Wildcats', '', 'UK'), false);
  assert.deepEqual(D.KINDS, { prizepicks: 'cbb-model', pick6: 'p6-cbb-model', underdog: 'ud-cbb-model' });
});
