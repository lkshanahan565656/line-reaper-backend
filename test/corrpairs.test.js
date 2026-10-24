const test = require('node:test');
const assert = require('node:assert');
const C = require('../corrpairs');
const B = require('../propsboard');
const { PAYOUTS, PICK6_PAYOUTS } = require('../slip');
const { createSportTracker } = require('../sporttrack');

const T0 = Date.parse('2026-10-25T17:00:00Z');
const start = '2026-10-25T20:25:00.000Z';
const tables = { prizepicks: PAYOUTS.prizepicks_power, underdog: PAYOUTS.underdog_standard, pick6: PICK6_PAYOUTS };
const L = (book, player, team, market, line, extra = {}) => B.normLine({ book, sport: 'NFL', player, team, market, line, startTime: start, matchTitle: 'KC @ BUF', gameId: 77,
  ...(book === 'prizepicks' ? {} : { overMultiplier: 1, underMultiplier: 1, overOpen: true, underOpen: true }), ...extra });
const nflLines = () => [
  L('prizepicks', 'Patrick Mahomes', 'KC', 'Pass Yards', 262.5), L('prizepicks', 'Travis Kelce', 'KC', 'Receiving Yards', 58.5),
  L('prizepicks', 'Rashee Rice', 'KC', 'Receiving Yards', 71.5), L('prizepicks', 'Xavier Worthy', 'KC', 'Receiving Yards', 40.5),
  L('prizepicks', 'Josh Allen', 'BUF', 'Pass Yards', 248.5), L('prizepicks', 'Khalil Shakir', 'BUF', 'Receiving Yards', 52.5),
  L('prizepicks', 'Dalton Kincaid', 'BUF', 'Receiving Yards', 38.5),
];

test('a QB, his two highest receiving lines and the other QB make one 4-pick per team', () => {
  const lines = nflLines();
  const rows = B.buildRows(lines, { now: T0 });
  const s = C.buildStacks(lines, rows, { tables, now: T0 });
  assert.strictEqual(s.length, 2);
  const kc = s.find(x => x.team === 'KC');
  assert.deepStrictEqual(kc.legs.map(l => `${l.role}:${l.player}:${l.line}`), ['QB:Patrick Mahomes:262.5', 'WR1:Rashee Rice:71.5', 'WR2:Travis Kelce:58.5', 'Opp QB:Josh Allen:248.5']);
  assert.strictEqual(kc.opponent, 'BUF');
  assert.strictEqual(kc.entry, '4-pick Power Play');
  assert.strictEqual(kc.standard.pays, 10);
  // repriced: 10 x 0.5^4 / the measured 11.6% sweep = 5.39x
  assert.strictEqual(kc.repriced.pays, 5.39);
  assert.ok(kc.standard.ev > 0 && kc.repriced.ev < 0);
  assert.ok(kc.legs.every(l => l.rowKey && rows.some(r => r.key === l.rowKey)));
});

test('no stack without every role on the app, and only standard More lines count', () => {
  const noOpp = nflLines().filter(l => l.player !== 'Josh Allen');
  assert.strictEqual(C.buildStacks(noOpp, [], { tables, now: T0 }).filter(s => s.team === 'KC').length, 0);
  // Pick6: a 0.9x More is not the standard pick
  const p6 = nflLines().map(l => ({ ...l, book: 'pick6', overMultiplier: l.player === 'Rashee Rice' ? 0.9 : 1, underMultiplier: 1, overOpen: true }));
  const kc = C.buildStacks(p6, [], { tables, now: T0 }).find(s => s.team === 'KC');
  assert.deepStrictEqual(kc.legs.map(l => l.player), ['Patrick Mahomes', 'Travis Kelce', 'Xavier Worthy', 'Josh Allen']);
  assert.strictEqual(kc.standard.pays, PICK6_PAYOUTS[4][4]);
  // a game that started is gone
  assert.strictEqual(C.buildStacks(nflLines(), [], { tables, now: Date.parse(start) + 1 }).length, 0);
});

test('MLB: three highest H+R+RBI lines and the other starter\'s earned runs', () => {
  const M = (player, team, market, line) => B.normLine({ book: 'underdog', sport: 'MLB', player, team, market, line, startTime: start, matchTitle: 'LAD @ NYY', gameId: 9,
    overMultiplier: 1, underMultiplier: 1, overOpen: true, underOpen: true });
  const lines = [M('Shohei Ohtani', 'LAD', 'Hits + Runs + RBIs', 2.5), M('Mookie Betts', 'LAD', 'Hits + Runs + RBIs', 1.5), M('Freddie Freeman', 'LAD', 'Hits + Runs + RBIs', 1.5),
    M('Will Smith', 'LAD', 'Hits + Runs + RBIs', 0.5), M('Gerrit Cole', 'NYY', 'Earned Runs Allowed', 2.5)];
  const s = C.buildStacks(lines, [], { tables, now: T0 });
  assert.strictEqual(s.length, 1);
  assert.deepStrictEqual(s[0].legs.map(l => l.player), ['Shohei Ohtani', 'Freddie Freeman', 'Mookie Betts', 'Gerrit Cole']);
  assert.strictEqual(s[0].shape, 'hrr3-oppsp');
  assert.strictEqual(s[0].standard.pays, PAYOUTS.underdog_standard[4][4]);
});

test('stack legs get their own record rows, and a leg in two stacks is two rows', async () => {
  const lines = nflLines();
  const rows = B.buildRows(lines, { now: T0 });
  const stacks = C.buildStacks(lines, rows, { tables, now: T0 });
  const flagged = C.flaggedLegs(stacks, new Map(rows.map(r => [r.key, r])));
  assert.strictEqual(flagged.length, 8);
  const mem = new Map();
  const store = { init: async () => {}, all: async () => [...mem.values()], put: async b => { mem.set(b.id, { ...b }); } };
  let t = T0;
  const grades = { 'Patrick Mahomes': 300, 'Rashee Rice': 90, 'Travis Kelce': 70, 'Josh Allen': 260, 'Khalil Shakir': 20, 'Dalton Kincaid': 50 };
  const grader = { grade: async b => ({ result: grades[b.player], outcome: grades[b.player] > b.signalLine ? 'win' : 'loss' }) };
  const tr = createSportTracker({ store, grader, now: () => t });
  await tr.record({ rows, flagged, fairAt: () => null, updated: {} });
  const legs = await tr.list({ limit: 1e9 });
  assert.strictEqual(legs.length, 8);
  assert.strictEqual(legs.filter(b => b.player === 'Josh Allen').length, 2);
  assert.ok(legs.every(b => b.kind === 'corr' && b.stackId && b.stackLegs === 4 && b.stackPays === 10));
  // corr legs never reach the headline
  assert.strictEqual((await tr.summary()).overall.signals, 0);
  t = Date.parse(start) + 60e3; await tr.record({ rows, flagged: [], fairAt: () => null, updated: {} });
  t = Date.parse(start) + 5 * 3600e3; await tr.grade();
  const sum = C.summarize(await tr.list({ limit: 1e9 }));
  assert.strictEqual(sum.overall.graded, 2);
  assert.strictEqual(sum.overall.swept, 1);   // KC swept, BUF's Shakir missed
  assert.strictEqual(sum.overall.unitsStd, 8);   // +9 and -1
  assert.strictEqual(sum.overall.unitsRep, r2(sum.stacks.find(s => s.swept).repriced - 2));
  assert.strictEqual(sum.overall.needStd, 0.1);
});
const r2 = x => Math.round(x * 100) / 100;

test('a void leg voids its stack', () => {
  const leg = (p, o, st = 'graded') => ({ kind: 'corr', stackId: 's1', stackLegs: 2, stackPays: 3, stackRepriced: 2, sport: 'NFL', book: 'prizepicks', player: p, status: st, outcome: o, start });
  assert.strictEqual(C.summarize([leg('a', 'win'), leg('b', null, 'void')]).void, 1);
  assert.strictEqual(C.summarize([leg('a', 'win')]).open, 1);
  assert.strictEqual(C.summarize([leg('a', 'win'), leg('b', 'win')]).overall.unitsRep, 1);
});
