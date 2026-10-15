const test = require('node:test');
const assert = require('node:assert');
const x = require('../extragrade');
const { createSportTracker } = require('../sporttrack');

// trimmed copies of the live feeds (diag-bfair, 2026-10-15)
const tennis = require('./fixtures/extragrade/tennis.json');
const ufc = require('./fixtures/extragrade/ufc.json');
const kalshi = require('./fixtures/extragrade/kalshi.json');

const leg = (o) => ({ signalSide: 'Over', ...o });

test('sourceFor: which results source settles each newly priced market', () => {
  assert.strictEqual(x.sourceFor('TENNIS', 'games_played'), 'espn');
  assert.strictEqual(x.sourceFor('TENNIS', 'aces'), null);
  assert.strictEqual(x.sourceFor('MMA', 'fight_time'), 'espn');
  assert.strictEqual(x.sourceFor('MMA', 'knockouts'), 'kalshi');
  assert.strictEqual(x.sourceFor('MMA', 'significant_strikes'), null);
  assert.strictEqual(x.sourceFor('MOTORSPORTS', 'finishing_position', 10.5), 'kalshi');
  assert.strictEqual(x.sourceFor('MOTORSPORTS', 'finishing_position', 15.5), null);
  assert.strictEqual(x.sourceFor('SOCCER', 'goals', 0.5), 'kalshi');
  assert.strictEqual(x.sourceFor('SOCCER', 'shots_attempted', 1.5), null);
  assert.strictEqual(x.sourceFor('NFL', 'rec_yds', 50.5), null);
});

test('tennis: games, sets and tiebreaks from ESPN set scores; doubles skipped; retirement voids', () => {
  const ms = x.tennisMatches(tennis);
  assert.strictEqual(ms.length, 2, 'singles only');
  // Basilashvili bt Ilagan 6-3 6-7(1) 7-5
  const start = '2026-10-05T04:00:00Z';
  const m = x.findTennis(ms, { player: 'Nikoloz Basilashvili', startTime: start });
  assert.ok(m);
  assert.strictEqual(x.tennisStat(m, 'Nikoloz Basilashvili', 'games_played'), 34);
  assert.strictEqual(x.tennisStat(m, 'Nikoloz Basilashvili', 'games_won'), 19);
  assert.strictEqual(x.tennisStat(m, 'Andre Ilagan', 'games_won'), 15);
  assert.strictEqual(x.tennisStat(m, 'Andre Ilagan', '1st_set_games_played'), 9);
  assert.strictEqual(x.tennisStat(m, 'Andre Ilagan', 'sets_won'), 1);
  assert.strictEqual(x.tennisStat(m, 'Andre Ilagan', 'sets_played'), 3);
  assert.strictEqual(x.tennisStat(m, 'Andre Ilagan', 'tiebreakers_played'), 1);
  assert.deepStrictEqual(x.gradeTennis(m, leg({ player: 'Nikoloz Basilashvili', mkey: 'games_played', signalLine: 22.5, startTime: start })),
    { result: 34, outcome: 'win', source: 'espn' });
  assert.strictEqual(x.gradeTennis(m, leg({ player: 'Andre Ilagan', mkey: 'games_won', signalLine: 15.5, startTime: start })).outcome, 'loss');
  assert.strictEqual(x.gradeTennis(m, leg({ player: 'Andre Ilagan', mkey: 'games_won', signalLine: 15, startTime: start })).outcome, 'push');
  // a match two days off isn't his
  assert.strictEqual(x.findTennis(ms, { player: 'Nikoloz Basilashvili', startTime: '2026-10-07T04:00:00Z' }), null);
  const r = x.findTennis(ms, { player: 'Nicolas Mejia', startTime: '2026-10-05T05:30:00Z' });
  assert.deepStrictEqual(x.gradeTennis(r, leg({ player: 'Nicolas Mejia', mkey: 'games_played', signalLine: 20.5 })), { void: 'tennis retired' });
});

test('UFC: fight time from round and clock, finishes and round finishes from the winner', () => {
  const bouts = x.ufcBouts(ufc);
  assert.strictEqual(bouts.length, 12);
  const start = '2026-10-10T23:00:00Z';
  const find = p => x.findBout(bouts, { player: p, startTime: start });
  // Allen Frye Jr. won in round 1 at 2:59
  const frye = find('Allen Frye Jr.');
  assert.strictEqual(x.ufcStat(frye, 'Allen Frye Jr.', 'fight_time'), 2.98);
  assert.strictEqual(x.ufcStat(frye, 'Allen Frye Jr.', 'finishes'), 1);
  assert.strictEqual(x.ufcStat(frye, 'Allen Frye Jr.', '1st_round_finish'), 1);
  assert.strictEqual(x.ufcStat(frye, 'RJ Harris', 'finishes'), 0);
  assert.strictEqual(x.ufcStat(frye, 'Allen Frye Jr.', '2nd_round_finish'), 0);
  // Brendan Allen won in round 5 at 2:46 of a five-round fight
  assert.strictEqual(x.ufcStat(find('Brendan Allen'), 'Brendan Allen', 'fight_time'), 22.77);
  assert.strictEqual(x.ufcStat(find('Brendan Allen'), 'Brendan Allen', '5th_round_finish'), 1);
  // Jai Herbert went the distance: 15 minutes, no finish
  const herb = find('Jai Herbert');
  assert.strictEqual(x.ufcStat(herb, 'Jai Herbert', 'fight_time'), 15);
  assert.strictEqual(x.ufcStat(herb, 'Jai Herbert', 'finishes'), 0);
  assert.deepStrictEqual(x.gradeUfc(herb, leg({ player: 'Matheus Camilo', mkey: 'fight_time', signalLine: 12.5, startTime: start })), { result: 15, outcome: 'win', source: 'espn' });
  // accents and suffixes match (Loopy Godínez)
  assert.ok(find('Loopy Godinez'));
});

test('Kalshi settled: knockouts, submissions, NASCAR top N and goalscorers', () => {
  const by = { KXUFCMOV: x.settledMarkets(kalshi.KXUFCMOV), KXNASCARTOP10: x.settledMarkets(kalshi.KXNASCARTOP10), KXEPLGOAL: x.settledMarkets(kalshi.KXEPLGOAL) };
  const fight = '2026-10-14T01:00:00Z';
  // Visconde won by decision: no knockout, no submission
  assert.deepStrictEqual(x.gradeKalshi(leg({ sport: 'MMA', mkey: 'knockouts', player: 'Erick Visconde', signalLine: 0.5, startTime: fight }), by),
    { result: 'no', outcome: 'loss', source: 'kalshi', market: 'KXUFCMOV-26OCT13BULVIS' });
  assert.strictEqual(x.gradeKalshi(leg({ sport: 'MMA', mkey: 'submissions', player: 'Ilias Bulaid', signalLine: 0.5, signalSide: 'Under', startTime: fight }), by).outcome, 'win');
  // a fight a week later isn't this one
  assert.strictEqual(x.gradeKalshi(leg({ sport: 'MMA', mkey: 'knockouts', player: 'Erick Visconde', signalLine: 0.5, startTime: '2026-10-21T01:00:00Z' }), by), null);
  // NASCAR at Charlotte 10-11: Hamlin top 10, Keselowski not
  const race = '2026-10-11T19:00:00Z';
  assert.strictEqual(x.gradeKalshi(leg({ sport: 'MOTORSPORTS', mkey: 'finishing_position', player: 'Denny Hamlin', signalLine: 10.5, signalSide: 'Under', startTime: race }), by).outcome, 'win');
  assert.strictEqual(x.gradeKalshi(leg({ sport: 'MOTORSPORTS', mkey: 'finishing_position', player: 'Brad Keselowski', signalLine: 10.5, startTime: race }), by).outcome, 'win');
  assert.strictEqual(x.gradeKalshi(leg({ sport: 'MOTORSPORTS', mkey: 'finishing_position', player: 'Brad Keselowski', signalLine: 10.5, signalSide: 'Under', startTime: race }), by).outcome, 'loss');
  // Botman scored for Newcastle at Coventry
  const ko = '2026-10-12T19:00:00Z';
  assert.strictEqual(x.gradeKalshi(leg({ sport: 'SOCCER', mkey: 'goals', player: 'Sven Botman', signalLine: 0.5, startTime: ko }), by).outcome, 'win');
  assert.strictEqual(x.gradeKalshi(leg({ sport: 'SOCCER', mkey: 'goals', player: 'Harvey Barnes', signalLine: 0.5, startTime: ko }), by).outcome, 'loss');
  assert.strictEqual(x.gradeKalshi(leg({ sport: 'SOCCER', mkey: 'goals', player: 'Sven Botman', signalLine: 1.5, startTime: ko }), by), null, 'no 2+ ladder: ungraded');
});

test('createExtraGrader fetches the right feeds and grades end to end', async () => {
  const calls = [];
  const http = { get: async (url, { params }) => {
    calls.push(url.replace(/^.*\/(sports|v2)\//, '') + (params.series_ticker ? `?${params.series_ticker}` : `?${params.dates}`));
    if (url.includes('tennis/atp')) return { data: tennis };
    if (url.includes('tennis/wta')) return { data: { events: [] } };
    if (url.includes('mma/ufc')) return { data: ufc };
    if (url.includes('kalshi')) return { data: { events: kalshi[params.series_ticker] || [] } };
    return { data: {} };
  } };
  const g = x.createExtraGrader({ http });
  assert.strictEqual((await g.grade(leg({ sport: 'TENNIS', mkey: 'games_won', player: 'Nikoloz Basilashvili', signalLine: 18.5, startTime: '2026-10-05T04:00:00Z' }))).outcome, 'win');
  assert.strictEqual((await g.grade(leg({ sport: 'MMA', mkey: 'fight_time', player: 'Niko Price', signalLine: 7.5, startTime: '2026-10-10T23:00:00Z' }))).outcome, 'loss');
  assert.strictEqual((await g.grade(leg({ sport: 'MOTORSPORTS', mkey: 'finishing_position', player: 'Joey Logano', signalLine: 10.5, signalSide: 'Under', startTime: '2026-10-11T19:00:00Z' }))).outcome, 'win');
  assert.strictEqual(await g.grade(leg({ sport: 'TENNIS', mkey: 'aces', player: 'x', signalLine: 3.5, startTime: '2026-10-05T04:00:00Z' })), null);
  assert.ok(calls.some(c => c.startsWith('tennis/wta')), 'both tours read');
  assert.ok(calls.some(c => c.includes('?KXNASCARTOP10')));
});

test('sporttrack: an ungradeable stat skips the budget, a retirement voids at once, the source is kept', async () => {
  const mem = new Map();
  const store = { init: async () => {}, all: async () => [...mem.values()], put: async b => { mem.set(b.id, { ...b }); } };
  let t = Date.parse('2026-10-15T00:00:00Z');
  const rows = [];
  const add = (id, sport, mkey) => mem.set(id, { id, status: 'locked', kind: 'ev', sport, mkey, player: id, start: '2026-10-14T12:00:00Z', startTime: '2026-10-14T12:00:00Z',
    signalSide: 'Over', signalLine: 2.5, signalDecimal: 1.8, signalAt: '2026-10-14T11:00:00Z' });
  for (let i = 0; i < 5; i++) add(`aces${i}`, 'TENNIS', 'aces');
  add('ret', 'TENNIS', 'games_played');
  add('ko', 'MMA', 'knockouts');
  const grader = {
    canGrade: b => b.mkey !== 'aces',
    grade: async b => (b.id === 'ret' ? { void: 'tennis retired' } : { result: 'yes', outcome: 'win', source: 'kalshi' }),
  };
  const tr = createSportTracker({ store, grader, now: () => t, log: { warn() {} } });
  await tr.ready();
  const r = await tr.grade({ max: 2 });
  assert.deepStrictEqual(r, { graded: 1, voided: 1 });
  assert.strictEqual(mem.get('ko').gradeSource, 'kalshi');
  assert.strictEqual(mem.get('ret').voidReason, 'tennis retired');
  assert.strictEqual(mem.get('aces0').status, 'locked', 'kept until the void window');
  t += 4 * 86400e3;
  await tr.grade();
  assert.strictEqual(mem.get('aces0').voidReason, 'no results source');
  void rows;
});
