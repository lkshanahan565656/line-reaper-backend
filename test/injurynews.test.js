// injurynews.js: an NBA rotation player ruled out, Pinnacle reprices his
// teammates' props, an app still on the pre-news number. The ESPN feed, the
// watcher, the leg rule, the stale engine's history and the record.
const test = require('node:test');
const assert = require('node:assert/strict');
const I = require('../injurynews');
const ST = require('../sporttrack');
const SL = require('../stalelines');
const D = require('../nbadata');

const T0 = Date.parse('2026-10-25T22:00:00Z');
const MIN = 60e3;

test('ESPN entries: the team abbreviation comes off each athlete', () => {
  const data = { injuries: [{ id: '9', displayName: 'Golden State Warriors', injuries: [
    { status: 'Out', date: '2026-10-25T21:50Z', shortComment: 'Curry is out', athlete: { displayName: 'Stephen Curry', team: { abbreviation: 'GS' } } },
    { status: 'Day-To-Day', date: '2026-10-25T13:38Z', athlete: { displayName: 'Draymond Green', team: { abbreviation: 'GS' } } }] }] };
  const e = I.espnEntries(data);
  assert.deepEqual(e.map(x => [x.key, x.team, x.status]), [['stephencurry', 'GS', 'Out'], ['draymondgreen', 'GS', 'Day-To-Day']]);
  assert.equal(e[0].date, Date.parse('2026-10-25T21:50Z'));
  // the NBA model's Out list reads the same shape (it read none live before: teamsWithOuts 0)
  assert.deepEqual([...D.outsOf(data).get('GS')], ['stephencurry']);
});

test('the watcher: the first read is the baseline, a change to Out is news', () => {
  const w = I.createInjuryWatch();
  const e = (key, status, date = null) => ({ key, name: key, team: 'GS', status, date });
  assert.deepEqual(w.observe([e('a', 'Out'), e('b', 'Day-To-Day')], T0), [], 'already out at the first read: not news');
  const f = w.observe([e('a', 'Out'), e('b', 'Out', T0 + 2 * MIN), e('c', 'Out')], T0 + 3 * MIN);
  assert.deepEqual(f.map(x => [x.key, x.from]), [['b', 'Day-To-Day'], ['c', 'not listed']]);
  assert.equal(f[0].newsAt, T0 + 2 * MIN, "the feed's own time when it falls between reads");
  assert.equal(f[1].newsAt, T0 + 3 * MIN, 'else the read');
  // off the list, then out again: news again
  w.observe([e('a', 'Out')], T0 + 6 * MIN);
  assert.equal(w.observe([e('a', 'Out'), e('b', 'Doubtful')], T0 + 9 * MIN).length, 1);
  assert.equal(w.events().length, 3);
});

test('rotation: the last five games\' minutes and the last team', () => {
  const players = new Map([['x', [10, 30, 30, 30, 30, 30].map((min, i) => ({ t: T0 - (6 - i) * 86400e3, team: i < 2 ? 'BOS' : 'GS', min }))]]);
  const r = I.rotationOf(players, 'x', T0);
  assert.deepEqual([r.team, r.mpg, r.rotation], ['GS', 30, true]);
  assert.equal(I.rotationOf(players, 'x', T0 - 5.5 * 86400e3).rotation, false, 'one 10-minute game');
  assert.equal(I.rotationOf(players, 'nobody', T0), null);
});

test('a leg: the app on its old number, Pinnacle 2+ points away there', () => {
  const app = { line: 14.5, over: null, under: null, overOpen: true, underOpen: true };
  const base = { app: 'prizepicks', mkey: 'points', appPre: app, appNow: app };
  // Pinnacle moved its number up a point: its chance over 14.5 rises well past 2 points
  const l = I.checkLeg({ ...base, pinPre: { line: 14.5, pOver: 0.5 }, pinNow: { line: 15.5, pOver: 0.5 } });
  assert.equal(l.side, 'Over');
  assert.equal(l.kind, 'injury-stale');
  assert.equal(l.be, 0.5503);
  assert.ok(l.dPts >= 2 && l.fair > 0.5 && l.exact === false);
  // on its own number: its own price, exact
  const e = I.checkLeg({ ...base, pinPre: { line: 14.5, pOver: 0.5 }, pinNow: { line: 14.5, pOver: 0.46 } });
  assert.deepEqual([e.side, e.fair, e.exact, e.dPts], ['Under', 0.54, true, 4]);
  // too small a move, or the app already moved, or the side is closed: nothing
  assert.equal(I.checkLeg({ ...base, pinPre: { line: 14.5, pOver: 0.5 }, pinNow: { line: 14.5, pOver: 0.515 } }), null);
  assert.equal(I.checkLeg({ ...base, appNow: { ...app, line: 15.5 }, pinPre: { line: 14.5, pOver: 0.5 }, pinNow: { line: 15.5, pOver: 0.5 } }), null);
  assert.equal(I.checkLeg({ ...base, appNow: { ...app, overOpen: false }, pinPre: { line: 14.5, pOver: 0.5 }, pinNow: { line: 15.5, pOver: 0.5 } }), null);
  // Underdog at its multiplier: break-even 0.5623 / 1.08
  const u = I.checkLeg({ app: 'underdog', mkey: 'points', appPre: { ...app, over: 1.08, under: 0.92 }, appNow: { ...app, over: 1.08, under: 0.92 }, pinPre: { line: 14.5, pOver: 0.5 }, pinNow: { line: 15.5, pOver: 0.5 } });
  assert.equal(u.kind, 'ud-injury-stale');
  assert.equal(u.be, +(0.5623 / 1.08).toFixed(4));
});

test('legsFor: teammates only, rotation players only, inside the window', () => {
  const ev = { key: 'stephencurry', name: 'Stephen Curry', team: 'GS', newsAt: T0 };
  const teams = { stephencurry: { team: 'GS', mpg: 32, rotation: true }, moses: { team: 'GS', mpg: 25, rotation: true }, jaylen: { team: 'BOS', mpg: 34, rotation: true } };
  const teamOf = key => teams[key] || null;
  const row = (player, extra = {}) => ({ key: `NBA|${player}|points`, sport: 'NBA', player, mkey: 'points', startTime: new Date(T0 + 90 * MIN).toISOString(), books: {}, ...extra });
  const rows = [row('Moses'), row('Jaylen'), row('Stephen Curry')];
  const cell = { line: 12.5, over: null, under: null, overOpen: true, underOpen: true };
  const pinAt = (r, t) => ({ line: t < T0 ? 12.5 : 13.5, pOver: 0.5 });
  const appAt = () => cell;
  const legs = I.legsFor(ev, rows, { teamOf, pinAt, appAt, t: T0 + 20 * MIN, apps: ['prizepicks'] });
  assert.deepEqual(legs.map(l => l.row.player), ['Moses']);
  assert.equal(legs[0].mins, 20);
  const p = I.playOf(legs[0]);
  assert.equal(p.kind, 'injury-stale');
  assert.equal(p.play.injury.out, 'Stephen Curry');
  assert.equal(p.play.pinLine, 13.5);
  assert.equal(I.legsFor(ev, rows, { teamOf, pinAt, appAt, t: T0 + 4 * 3600e3 }).length, 0, 'past the window');
  assert.equal(I.legsFor({ ...ev, key: 'bench' }, rows, { teamOf: k => (k === 'bench' ? { team: 'GS', mpg: 8, rotation: false } : teamOf(k)), pinAt, appAt, t: T0 + 20 * MIN }).length, 0, 'a bench player is not news');
});

test('the stale engine keeps each source\'s numbers as they stood', () => {
  const E = SL.createStaleLines();
  const key = SL.propKey('NBA', 'Moses Moody', 'points', '2026-10-25T23:30:00Z');
  const pin = (line, pOver, t) => E.observe([{ key, source: 'pinnacle', q: { kind: 'prop', mkey: 'points', sport: 'NBA', pts: [{ x: line, p: pOver, d0: 1.9, d1: 1.9 }] }, meta: { sport: 'NBA', kind: 'prop', market: 'points', player: 'Moses Moody', start: '2026-10-25T23:30:00Z' } }], t, 'pin');
  const pp = (line, t) => E.observe([{ key, source: 'prizepicks', q: { kind: 'prop', mkey: 'points', sport: 'NBA', pts: [{ x: line, p: 0.5, cell: { over: null, under: null, overOpen: true, underOpen: true } }] }, meta: { sport: 'NBA', kind: 'prop', market: 'points', player: 'Moses Moody', start: '2026-10-25T23:30:00Z' } }], t, 'prizepicks');
  pin(12.5, 0.5, T0 - 30 * MIN); pp(12.5, T0 - 25 * MIN); pin(13.5, 0.52, T0 + 5 * MIN);
  assert.equal(E.quoteAt(key, 'pinnacle', T0 - 40 * MIN), null, 'nothing before its first read');
  assert.deepEqual(E.quoteAt(key, 'pinnacle', T0 - 15 * MIN), { line: 12.5, pOver: 0.5 });
  assert.deepEqual(E.quoteAt(key, 'pinnacle', T0 + 10 * MIN), { line: 13.5, pOver: 0.52 });
  assert.deepEqual(E.quoteAt(key, 'prizepicks', T0), { line: 12.5, over: null, under: null, overOpen: true, underOpen: true });
});

test('the record: its own kind and id, Pinnacle\'s raw close, out of the headline', async () => {
  assert.deepEqual([...I.KINDS].sort(), [...ST.INJ].sort());
  const mem = new Map();
  const store = { init: async () => {}, all: async () => [...mem.values()], put: async b => { mem.set(b.id, { ...b }); } };
  let t = T0 + 20 * MIN;
  const tr = ST.createSportTracker({ store, now: () => t });
  const row = { key: 'NBA|mosesmoody|points', sport: 'NBA', player: 'Moses Moody', team: 'GS', mkey: 'points', market: 'Points', startTime: new Date(T0 + 90 * MIN).toISOString(), books: { prizepicks: { line: 12.5, overOpen: true, underOpen: true } } };
  const leg = I.checkLeg({ app: 'prizepicks', mkey: 'points', appPre: { line: 12.5 }, appNow: { line: 12.5 }, pinPre: { line: 12.5, pOver: 0.5 }, pinNow: { line: 13.5, pOver: 0.5 } });
  const flagged = [I.playOf({ row, leg, event: { key: 'stephencurry', name: 'Stephen Curry', team: 'GS', newsAt: T0 }, mins: 20 })];
  let pinNow = { x: 13.5, p: 0.5 };
  const pinAt = (r, kind) => { assert.ok(I.KINDS.has(kind)); return pinNow; };
  const fairAt = () => 0.6;
  await tr.record({ rows: [row], flagged, fairAt, pinAt });
  const id = [...mem.keys()][0];
  assert.match(id, /\|injury-stale$/);
  assert.equal(mem.get(id).injury.out, 'Stephen Curry');
  assert.equal(mem.get(id).signalPinLine, 13.5);
  t = T0 + 85 * MIN; pinNow = { x: 12.5, p: 0.6 };
  await tr.record({ rows: [row], flagged: [], fairAt, pinAt });
  t = T0 + 91 * MIN;
  await tr.record({ rows: [row], flagged: [], fairAt, pinAt });
  const b = mem.get(id);
  assert.equal(b.status, 'locked');
  assert.equal(b.pinExact, true);
  assert.equal(b.pinMove, 'toward');
  const sum = await tr.summary();
  assert.equal(sum.overall.signals, 0);
  assert.equal(sum.byKind['injury-stale'].signals, 1);
});
