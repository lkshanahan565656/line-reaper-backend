const test = require('node:test');
const assert = require('node:assert');
const g = require('../sportgrade');
const fx = require('./fixtures/espn-box.json');

test('box scores parse into named stat groups per player', () => {
  const nfl = g.parseBox(fx.NFL.box);
  const allen = nfl.get('joshallen');
  assert.ok(allen.groups.passing && allen.groups.rushing);
  assert.strictEqual(g.statValue('NFL', 'pass_yds', allen.groups), 210);
  assert.strictEqual(g.statValue('NFL', 'rush_yds', allen.groups), 121);
  assert.strictEqual(g.statValue('NFL', 'pass_rush_yds', allen.groups), 331);
  assert.strictEqual(g.statValue('NFL', 'pass_comp', allen.groups), 12);
  const puka = nfl.get('pukanacua');
  assert.strictEqual(g.statValue('NFL', 'receptions', puka.groups), 17);
  assert.strictEqual(g.statValue('NFL', 'rec_yds', puka.groups), 138);
  assert.strictEqual(g.statValue('NFL', 'targets', puka.groups), 24);
});

test('basketball, baseball and hockey stats read off their keys', () => {
  const nba = g.parseBox(fx.NBA.box);
  const pb = nba.get('paolobanchero').groups;
  assert.strictEqual(g.statValue('NBA', 'points', pb), 24);
  assert.strictEqual(g.statValue('NBA', 'pra', pb), 35);
  assert.strictEqual(g.statValue('NBA', 'threes', pb), 2);
  const mlb = g.parseBox(fx.MLB.box);
  assert.strictEqual(g.statValue('MLB', 'strikeouts', mlb.get('freddyperalta').groups), 6);
  assert.strictEqual(g.statValue('MLB', 'pitcher_outs', mlb.get('freddyperalta').groups), 18);
  assert.strictEqual(g.statValue('MLB', 'hits', mlb.get('stevenkwan').groups), 2);
  const nhl = g.parseBox(fx.NHL.box);
  assert.strictEqual(g.statValue('NHL', 'saves', nhl.get('jakeallen').groups), 23);
  assert.strictEqual(g.statValue('NHL', 'shots_on_goal', nhl.get('viktorarvidsson').groups), 1);
  assert.strictEqual(g.statValue('NHL', 'fantasy_score', nhl.get('viktorarvidsson').groups), null);
});

test('a leg finds its game by team and grades over, under and push', () => {
  const ev = fx.NFL.event;
  const pick = { sport: 'NFL', player: 'Josh Allen', team: 'BUF', mkey: 'pass_yds', signalLine: 205.5, signalSide: 'Over', startTime: ev.date };
  assert.strictEqual(g.findEvent([ev], pick).id, ev.id);
  assert.strictEqual(g.findEvent([ev], { ...pick, team: 'KC', matchTitle: 'KC @ DEN' }), null);
  const box = g.parseBox(fx.NFL.box);
  assert.deepStrictEqual(g.gradeLeg(pick, box), { result: 210, outcome: 'win' });
  assert.deepStrictEqual(g.gradeLeg({ ...pick, signalSide: 'Under' }, box), { result: 210, outcome: 'loss' });
  assert.deepStrictEqual(g.gradeLeg({ ...pick, signalLine: 210 }, box), { result: 210, outcome: 'push' });
  assert.strictEqual(g.gradeLeg({ ...pick, player: 'Nobody Here' }, box), null);
});

test('the grader waits for a final and caches boards', async () => {
  const ev = fx.NBA.event;
  let calls = 0;
  const http = { get: async (url) => { calls++; return { data: url.endsWith('scoreboard') ? { events: [{ ...ev, status: { type: { completed: false } } }] } : { boxscore: fx.NBA.box } }; } };
  const gr = g.createSportsGrader({ http });
  const pick = { sport: 'NBA', player: 'Paolo Banchero', team: 'Orlando Magic', mkey: 'points', signalLine: 22.5, signalSide: 'Over', startTime: ev.date };
  assert.deepStrictEqual(await gr.grade(pick), { pending: true });
  const done = g.createSportsGrader({ http: { get: async (url) => ({ data: url.endsWith('scoreboard') ? { events: [ev] } : { boxscore: fx.NBA.box } }) } });
  assert.deepStrictEqual(await done.grade(pick), { result: 24, outcome: 'win', eventId: ev.id });
  assert.ok(calls >= 1);
});
