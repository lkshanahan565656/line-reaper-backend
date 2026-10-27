// Esports series bets from MATCHUPS (esbets.js): the start is the matchup
// engine's, Pinnacle's series price is followed to the start where Pinnacle
// prices it, unpriced otherwise, and the result comes from the engine's
// finished series. TEST DATA: every series, price and result below is made up
// here to exercise the rules.
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../esbets');
const P = require('../pubrecord');
const { createMemoryStore } = require('../evtrack');

const T0 = Date.parse('2026-10-27T10:00:00Z');
const START = '2026-10-27T14:00:00Z';
const mu = (o = {}) => ({ id: 'm1', start: START, teams: [{ name: 'Gen.G Esports' }, { name: 'T1' }], league: 'Worlds', state: 'unstarted', ...o });
// Pinnacle lists the same series the other way round, home T1 at 40% no-vig
const pinRow = (p = 0.4, o = {}) => ({ id: 901, game: 'LOL', teams: ['T1', 'Gen.G'], start: Date.parse(START), ladders: new Map([['series|0|ml', [{ x: 0, p, limit: 1000 }]]]), ...o });
const track = (side = 0, o = {}) => ({ kind: 'es', game: 'LOL', match: 'm1', side, ...o });

function setup() {
  let t = T0;
  const eb = E.createEsBets({ store: createMemoryStore(), now: () => t, log: { warn() {} } });
  return { eb, at: x => { t = x; }, now: () => t };
}

test('a track is cleaned to its key fields; junk is refused', () => {
  assert.deepEqual(E.clean(track(1, { start: 'whatever' })), { game: 'LOL', match: 'm1', side: 1 });
  assert.equal(E.clean(track(2)), null, 'a side is 0 or 1');
  assert.equal(E.clean(track(0, { game: 'DOTA' })), null, 'only the MATCHUPS games');
  assert.equal(E.clean({ kind: 'line', game: 'x' }), null);
  assert.equal(E.clean(track(0, { match: '' })), null);
});

test('Pinnacle\'s series price is found with the teams either way round', () => {
  const teams = ['Gen.G Esports', 'T1'];
  assert.equal(E.pinFair([pinRow()], 'LOL', teams, START, 0).p, 0.6, 'Gen.G is Pinnacle\'s away side');
  assert.equal(E.pinFair([pinRow()], 'LOL', teams, START, 1).p, 0.4);
  assert.equal(E.pinFair([pinRow()], 'CS2', teams, START, 0), null, 'another game');
  assert.equal(E.pinFair([pinRow(0.4, { start: Date.parse(START) + 20 * 3600e3 })], 'LOL', teams, START, 0), null, 'a series a day away');
  assert.equal(E.pinFair([pinRow(0.4, { teams: ['T1', 'Hanwha Life'] })], 'LOL', teams, START, 0), null, 'one team must not be enough');
});

test('logged before the start on the engine\'s time; followed to the close; graded from the result', async () => {
  const { eb, at } = setup();
  const pin = { list: [pinRow(0.4)], at: new Date(T0).toISOString() };
  const v = (await eb.settle([{ id: 'b1', track: track(0) }], { lookup: () => mu(), pin })).b1;
  assert.equal(v.close.status, 'open');
  assert.equal(v.close.logFair, 0.6);
  assert.equal(v.close.start, new Date(START).toISOString());
  // Pinnacle moves to Gen.G 65% thirty minutes before the start
  at(Date.parse(START) - 30 * 60e3);
  await eb.observe({ lookup: () => mu(), pin: { list: [pinRow(0.35)], at: new Date(Date.parse(START) - 30 * 60e3).toISOString() } });
  // the series starts: Pinnacle takes it off (live), the close is the last read
  at(Date.parse(START) + 60e3);
  await eb.observe({ lookup: () => mu({ state: 'inProgress' }), pin: { list: [], at: new Date(Date.parse(START) + 60e3).toISOString() } });
  const c = (await eb.settle([{ id: 'b1', track: track(0) }], {})).b1;
  assert.equal(c.close.status, 'closed');
  assert.equal(c.close.fair, 0.65);
  assert.equal(c.close.closeOk, true);
  assert.equal(c.closeOdds, Math.round(1e4 / 0.65) / 1e4);
  at(Date.parse(START) + 3 * 3600e3);
  const g = await eb.grade(() => ({ s1: 3, s2: 1 }));
  assert.equal(g.graded, 1);
  const d = (await eb.settle([{ id: 'b1', track: track(0) }, { id: 'b2', track: track(1) }], { lookup: () => mu({ state: 'inProgress' }) }));
  assert.equal(d.b1.result, 'win');
  assert.equal(d.b2.close.status, 'late', 'the other side logged after the start is late');
});

test('a started or unknown series is refused; the start comes from the engine, not the browser', async () => {
  const { eb } = setup();
  const pin = { list: [pinRow()], at: new Date(T0).toISOString() };
  const late = (await eb.settle([{ id: 'x', track: track(0, { start: '2030-01-01T00:00:00Z' }) }], { lookup: () => mu({ start: '2026-10-27T09:00:00Z' }), pin })).x;
  assert.equal(late.close.status, 'late');
  const live = (await eb.settle([{ id: 'y', track: track(0) }], { lookup: () => mu({ state: 'inProgress' }), pin })).y;
  assert.equal(live.close.status, 'late', 'a series the engine says is live is late whatever the clock');
  const gone = (await eb.settle([{ id: 'z', track: track(0) }], { lookup: () => null, pin })).z;
  assert.equal(gone.close.status, 'unknown');
  assert.equal(eb.rows.size, 0, 'nothing is logged for a refused bet');
});

test('a series Pinnacle never prices closes unpriced; a stale Pinnacle read is never used', async () => {
  const { eb, at } = setup();
  // the last Pinnacle read is an hour old: not used
  const old = { list: [pinRow()], at: new Date(T0 - 3600e3).toISOString() };
  const v = (await eb.settle([{ id: 'b', track: track(1) }], { lookup: () => mu(), pin: old })).b;
  assert.equal(v.close.logFair, null);
  assert.match(v.note, /no price/);
  at(Date.parse(START) + 60e3);
  await eb.observe({ lookup: () => mu({ state: 'inProgress' }), pin: { list: [], at: new Date(Date.parse(START)).toISOString() } });
  const c = (await eb.settle([{ id: 'b', track: track(1) }], {})).b;
  assert.equal(c.close.status, 'closed');
  assert.equal(c.close.fair, null);
  assert.equal(c.close.unpriced, true);
  assert.equal(c.closeOdds, undefined);
  assert.deepEqual(eb.counts(), { open: 0, closed: 1, graded: 0, closeOk: 0, noClose: 1 });
});

test('a close read over an hour before the start does not count', async () => {
  const { eb, at } = setup();
  await eb.settle([{ id: 'b', track: track(0) }], { lookup: () => mu(), pin: { list: [pinRow()], at: new Date(T0).toISOString() } });
  at(Date.parse(START) + 60e3);
  await eb.observe({ lookup: () => mu({ state: 'inProgress' }), pin: { list: [], at: new Date(Date.parse(START)).toISOString() } });
  const c = (await eb.settle([{ id: 'b', track: track(0) }], {})).b;
  assert.equal(c.close.closeOk, false);
  assert.equal(c.close.fair, 0.6);
  assert.equal(c.closeOdds, undefined);
});

test('on a public record: esports bets kept apart from the venue\'s game lines; unpriced shown, never graded on a close', () => {
  const T = Date.parse('2026-10-27T10:00:00Z');
  const esBet = (id, o = {}) => ({ id, venue: 'kalshi', venueName: 'Kalshi', event: 'Gen.G vs T1', pick: 'Gen.G to win the series', decimal: 1.8, stake: 50, track: track(0, { match: `m${id}` }), ...o });
  const lineBet = id => ({ id, venue: 'kalshi', venueName: 'Kalshi', event: 'A @ B', pick: 'B ML', decimal: 2, track: { kind: 'line', game: `g${id}`, league: 'NBA', market: 'ml', side: 'B', point: null } });
  const doc = (b, grade) => ({ id: `bet|h|${b.id}`, kind: 'bet', status: 'live', handle: 'h', bet: P.cleanBet(b), receivedAt: new Date(T).toISOString(), grade: grade && P.slimBetGrade(grade) });
  const c = P.cleanBet(esBet('1'));
  assert.deepEqual(c.track, { kind: 'es', game: 'LOL', match: 'm1', side: 0 });
  assert.ok(!('stake' in c));
  const priced = { close: { status: 'closed', start: START, logFair: 0.55, fair: 0.6, closeOk: true, outcome: 'win' }, note: 'Pinnacle close' };
  const unpriced = { close: { status: 'closed', start: START, logFair: null, fair: null, closeOk: false, outcome: 'loss', unpriced: true }, note: 'Pinnacle did not price this series: unpriced' };
  const v = P.betsView([doc(esBet('1'), priced), doc(esBet('2'), unpriced), doc(lineBet('3'), { close: { status: 'closed', start: START, logFair: 0.5, fair: 0.5, closeOk: true, outcome: 'loss' } })]);
  const es = v.venues.find(x => x.kind === 'esports series'), gl = v.venues.find(x => x.kind === 'game lines');
  assert.equal(es.venueName, 'Kalshi esports');
  assert.equal(es.bets, 2); assert.equal(es.pinN, 1, 'only the priced bet has a close');
  assert.equal(es.clv, 8);   // 1.8 × 0.6 − 1
  assert.equal(gl.bets, 1);
  const row = v.rows.find(r => r.id === '2');
  assert.equal(row.kind, 'esports'); assert.equal(row.clv, null); assert.match(row.note, /unpriced/);
  assert.equal(es.label, 'building');
  const html = P.pageHtml({ ...P.recordView({ handle: 'h', status: 'live', publishedAt: new Date(T).toISOString() }, [], { bets: [doc(esBet('1'), priced), doc(esBet('2'), unpriced)] }) });
  assert.match(html, /Kalshi esports/);
  assert.match(html, /unpriced/);
});
