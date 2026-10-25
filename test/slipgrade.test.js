// MY SLIPS grading (10-25): the prop close book keeps Pinnacle's and Kalshi's
// last number on every prop; a leg logged after the start (or imported from
// Pikkit) is graded from the box scores against that close; MY SLIPS shows
// the hit rate against each slip's break-even and the CLV against Pinnacle.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createPropCloseBook, fairAt } = require('../propclose');
const { createLateGrader, createBoxScan } = require('../slipgrade');
const { createMemoryStore } = require('../evtrack');
const S = require('../slips');

const START = '2026-10-25T23:00:00.000Z';
const T0 = Date.parse(START);
const row = (extra = {}) => ({ key: 'NBA|jaysontatum|points', sport: 'NBA', player: 'Jayson Tatum', team: 'Boston Celtics', matchTitle: 'NYK @ BOS', market: 'Points', mkey: 'points', startTime: START,
  books: { prizepicks: { line: 27.5 }, underdog: { line: 28.5 } }, ...extra });
const quotes = () => ({ pin: [{ line: 27.5, pOver: 0.46 }], kal: new Map([[29.5, 0.4]]) });

function book(t) {
  const clock = { t };
  const b = createPropCloseBook({ store: createMemoryStore(), now: () => clock.t });
  return { b, clock };
}

test('the close book keeps the last read before the start, marked fresh or not', async () => {
  const { b, clock } = book(T0 - 3 * 3600e3);
  await b.observe([row()], quotes);
  clock.t = T0 - 30 * 60e3;
  await b.observe([row()], () => ({ pin: [{ line: 27.5, pOver: 0.44 }], kal: new Map() }));
  assert.equal(b.status().live, 1);
  clock.t = T0 + 60e3;
  const r = await b.observe([], quotes);
  assert.equal(r.closed, 1);
  const e = b.get('NBA', 'Jayson Tatum', 'points', START);
  assert.equal(e.closeOk, true);
  assert.deepEqual(e.pin, [[27.5, 0.44]]);
  assert.deepEqual(e.apps, { prizepicks: 27.5, underdog: 28.5 });
  // a prop last read three hours early is kept, and marked
  const { b: b2, clock: c2 } = book(T0 - 3 * 3600e3);
  await b2.observe([row()], quotes);
  c2.t = T0 + 60e3;
  await b2.observe([], quotes);
  assert.equal(b2.get('NBA', 'Jayson Tatum', 'points', START).closeOk, false);
});

test('a prop with no sharp price is not kept; esports never', async () => {
  const { b } = book(T0 - 3600e3);
  await b.observe([row(), row({ key: 'x', esports: true })], () => ({ pin: [], kal: new Map() }));
  assert.equal(b.status().live, 0);
});

test("Pinnacle's close at the leg's line: exact, else read along the curve and marked", async () => {
  const { b, clock } = book(T0 - 20 * 60e3);
  await b.observe([row()], quotes);
  clock.t = T0 + 60e3;
  await b.observe([], quotes);
  const e = b.get('NBA', 'Jayson Tatum', 'points', START);
  const ex = fairAt(e, 27.5, 'Under');
  assert.equal(ex.source, 'pinnacle'); assert.equal(ex.exact, true); assert.equal(ex.fair, 0.54);
  const near = fairAt(e, 28.5, 'Over');
  assert.equal(near.source, 'pinnacle'); assert.equal(near.exact, false); assert.equal(near.line, 27.5);
  assert.ok(near.fair < 0.46, 'a higher line is less likely to go over');
  // Kalshi only when Pinnacle had nothing
  const kal = fairAt({ ...e, pin: [] }, 29.5, 'Over');
  assert.equal(kal.source, 'kalshi'); assert.equal(kal.fair, 0.4);
  assert.equal(fairAt({ ...e, pin: [], kal: [] }, 29.5, 'Over'), null);
});

test('find: a leg finds its prop by player and the next game from the bet; a short name only when one player fits', async () => {
  const { b, clock } = book(T0 - 20 * 60e3);
  await b.observe([row(), row({ key: 'b', player: 'Jalen Brunson', team: 'New York Knicks' })], quotes);
  clock.t = T0 + 60e3;
  await b.observe([], quotes);
  assert.equal(b.find({ player: 'Jayson Tatum', mkey: 'points', betAt: T0 - 3600e3 })?.player, 'Jayson Tatum');
  assert.equal(b.find({ player: 'J. Tatum', mkey: 'points', betAt: T0 - 3600e3 })?.player, 'Jayson Tatum');
  assert.equal(b.find({ player: 'Jayson Tatum', mkey: 'rebounds', betAt: T0 - 3600e3 }), null);
  // a slip typed in after the start still finds that night's game
  assert.equal(b.find({ player: 'Jayson Tatum', mkey: 'points', betAt: T0 + 2 * 3600e3 })?.start, START);
  // a bet a week later is another game
  assert.equal(b.find({ player: 'Jayson Tatum', mkey: 'points', betAt: T0 + 8 * 86400e3 }), null);
});

test('old days are written back empty', async () => {
  const store = createMemoryStore();
  const clock = { t: T0 - 20 * 60e3 };
  const b = createPropCloseBook({ store, now: () => clock.t, keepDays: 2 });
  await b.observe([row()], quotes);
  clock.t = T0 + 60e3;
  await b.observe([], quotes);
  await b.save(true);
  assert.equal(Object.keys((await store.all())[0].props).length, 1);
  clock.t = T0 + 5 * 86400e3;
  await b.save(true);
  const d = (await store.all())[0];
  assert.equal(Object.keys(d.props).length, 0); assert.equal(d.pruned, true);
});

// ── the late grader ──
function grader(outcomes = {}) {
  const calls = [];
  return { calls, canGrade: p => p.sport === 'NBA', sourceOf: () => 'espn box score',
    async grade(p) { calls.push(p); const v = outcomes[p.player]; return v == null ? null : { result: v, outcome: v === p.signalLine ? 'push' : (v > p.signalLine) === (p.signalSide === 'Over') ? 'win' : 'loss', eventId: 'e1' }; } };
}
const dec = () => 1.7787;

test('a leg logged after the start takes the game and close from the book, grades from the box score, and is kept', async () => {
  const { b, clock } = book(T0 - 20 * 60e3);
  await b.observe([row()], quotes);
  clock.t = T0 + 4 * 3600e3;
  await b.observe([], quotes);
  const store = createMemoryStore();
  const g = grader({ 'Jayson Tatum': 31 });
  const late = createLateGrader({ store, book: b, grader: g, scan: { findGame: async () => { throw new Error('no scan when the book has it'); } }, now: () => clock.t });
  const leg = { id: 'L1', app: 'prizepicks', sport: 'NBA', player: 'Jayson Tatum', market: 'Points', mkey: 'points', side: 'Over', line: 27.5, betAt: new Date(T0 - 3600e3).toISOString(), betAtExact: true };
  const r = (await late.grade([leg], { decimalOf: dec })).results.L1;
  assert.equal(r.status, 'graded'); assert.equal(r.outcome, 'win'); assert.equal(r.result, 31); assert.equal(r.final, true); assert.equal(r.late, true);
  assert.equal(r.gradeSource, 'ESPN box score'); assert.equal(r.gameSource, 'board');
  assert.equal(r.raw.source, 'pinnacle'); assert.equal(r.raw.exact, true);
  assert.equal(r.closeFair, 0.46); assert.equal(r.closeEv, Math.round((0.46 * 1.7787 - 1) * 1e4) / 100);
  assert.equal(r.appClose, 27.5);
  // the second time (anyone's leg on the same subject) comes from the store
  const r2 = (await late.grade([{ ...leg, id: 'L2', side: 'Over' }], { decimalOf: dec })).results.L2;
  assert.equal(r2.outcome, 'win');
  assert.equal(g.calls.length, 1);
  assert.equal((await store.all()).length, 1);
});

test('a leg the book never saw is found in the box scores from the bet on; a guessed time that fits only an older game says match uncertain', async () => {
  const T = Date.parse('2026-10-20T23:30:00Z');
  const events = { '20261020': [{ id: 'g1', date: '2026-10-20T23:30Z', shortName: 'MIA @ ORL', status: { type: { completed: true } } }] };
  const box = { boxscore: { players: [{ team: { displayName: 'Orlando Magic' }, statistics: [{ keys: ['minutes', 'points', 'rebounds', 'assists'], athletes: [{ athlete: { displayName: 'Paolo Banchero' }, stats: ['35', '24', '9', '5'] }] }] }] } };
  const http = { calls: 0, async get(url, { params }) { this.calls++; return { data: /scoreboard/.test(url) ? { events: events[params.dates] || [] } : box }; } };
  const scan = createBoxScan({ http, now: () => T + 5 * 86400e3 });
  const { b } = book(T + 5 * 86400e3);
  const g = grader({ 'Paolo Banchero': 24 });
  const late = createLateGrader({ store: createMemoryStore(), book: b, grader: g, scan, now: () => T + 5 * 86400e3 });
  const leg = { id: 'P1', app: 'underdog', sport: 'NBA', player: 'Paolo Banchero', market: 'Points', mkey: 'points', side: 'Under', line: 25.5, betAt: new Date(T - 2 * 3600e3).toISOString(), betAtExact: true };
  const r = (await late.grade([leg], { decimalOf: dec })).results.P1;
  assert.equal(r.outcome, 'win'); assert.equal(r.gameSource, 'box score search');
  assert.equal(g.calls[0].team, 'Orlando Magic');
  assert.equal(r.raw, null, 'no close: the board never saw the prop');
  assert.equal(r.closeEv, null);
  // a leg pasted the next day with no date typed: last night's game, marked uncertain
  const r2 = (await late.grade([{ ...leg, id: 'P2', line: 22.5, betAt: new Date(T + 14 * 3600e3).toISOString(), betAtExact: false }], { decimalOf: dec })).results.P2;
  assert.equal(r2.outcome, 'loss'); assert.equal(r2.matchUncertain, true);
});

test('a budget runs out into a queue; a leg with no league, a week on, says why', async () => {
  const T = Date.parse('2026-10-20T23:30:00Z');
  const http = { async get(url) { return { data: /scoreboard/.test(url) ? { events: [{ id: 'g', date: '2026-10-20T23:30Z', status: { type: { completed: true } } }] } : { boxscore: { players: [] } } }; } };
  const late = createLateGrader({ store: createMemoryStore(), book: book(T).b, grader: grader(), scan: createBoxScan({ http, now: () => T + 86400e3 }), now: () => T + 86400e3 });
  const leg = { id: 'Q', app: 'prizepicks', sport: 'NBA', player: 'Nobody Here', market: 'Points', mkey: 'points', side: 'Over', line: 1.5, betAt: new Date(T - 3600e3).toISOString(), betAtExact: true };
  const q = (await late.grade([leg], { decimalOf: dec, budget: { left: 1 } })).results.Q;
  assert.equal(q.reason, 'queued'); assert.equal(q.final, false);
  // a found-nothing scan under a week old leaves the leg to the slip log's answer
  const none = (await late.grade([leg], { decimalOf: dec })).results.Q;
  assert.equal(none, undefined);
  const late2 = createLateGrader({ store: createMemoryStore(), book: book(T).b, grader: grader(), scan: createBoxScan({ http, now: () => T + 9 * 86400e3 }), now: () => T + 9 * 86400e3 });
  assert.equal((await late2.grade([{ ...leg, sport: null }], { decimalOf: dec })).results.Q.reason, 'sport');
  assert.equal((await late2.grade([leg], { decimalOf: dec })).results.Q.reason, 'game');
});

// ── MY SLIPS math ──
test('break-even per leg comes from the slip\'s own table: PrizePicks 3-pick 55.0%, Pick6 at 5.5x 56.7%', () => {
  assert.equal(S.breakEven({ 3: 6 }, 3), 0.55032);
  assert.equal(S.breakEven({ 3: 5.5 }, 3), 0.56652);
  // flex: solved on the hits
  const fx = S.breakEven(S.FLEX.prizepicks[5], 5);
  assert.ok(fx > 0.5 && fx < 0.6);
  // Pick6's live table wins over the old 6x when no payout is typed
  const slip = { app: 'pick6', legs: [1, 2, 3] };
  assert.deepEqual(S.payTable(slip), { 3: 6 });
  assert.deepEqual(S.payTable(slip, { pick6: { 3: { 3: 5.5 } } }), { 3: 5.5 });
});

const NOW = Date.parse('2026-10-25T12:00:00Z');
const mkSlip = (app, n, o = {}) => S.makeSlip({ app, legs: Array.from({ length: n }, (_, i) => ({ player: `P${i}`, side: 'Over', line: 10.5, market: 'Points', sport: 'NBA' })), now: NOW, ...o });
function grades(slip, outs, extra = () => ({})) {
  const g = {};
  slip.legs.forEach((l, i) => { if (outs[i]) g[S.legKey(slip, l)] = { status: 'graded', outcome: outs[i], final: true, closeEv: 2, closeOk: true, gradeSource: 'ESPN box score', matched: { sport: 'NBA', start: START, matchTitle: `G${i}` }, ...extra(i) }; });
  return g;
}

test('legs hit against the break-even, with z, and CLV against Pinnacle apart from the consensus', () => {
  const a = mkSlip('prizepicks', 3), b = mkSlip('pick6', 3);
  const pin = i => ({ raw: { source: 'pinnacle', ev: i === 0 ? 5 : -1, ok: true, exact: true } });
  const va = S.slipView(a, grades(a, ['win', 'win', 'loss'], pin));
  const vb = S.slipView(b, grades(b, ['win', 'loss', 'win']), { pick6: { 3: { 3: 5.5 } } });
  assert.equal(va.be, 0.55032); assert.equal(vb.be, 0.56652);
  const t = S.legTotals([va, vb], 'app');
  const pp = t.find(x => x.key === 'PrizePicks');
  assert.equal(pp.hitRate, 0.6667); assert.equal(pp.be, 0.5503); assert.equal(pp.overBe, 11.63);
  assert.equal(pp.pinN, 3); assert.equal(pp.pinEv, 1); assert.equal(pp.pinBeatShare, 0.3333);
  assert.deepEqual(pp.sources, { 'ESPN box score': 3 });
  const p6 = t.find(x => x.key === 'DK Pick6');
  assert.equal(p6.pinN, 0); assert.equal(p6.be, 0.5665);
  const s = S.summary([va, vb]);
  assert.equal(s.beN, 6); assert.equal(s.be, 0.5584); assert.equal(s.pinN, 3);
  assert.ok(s.beZ > 0);
  const byApp = S.slipTotals([va, vb], 'app');
  assert.equal(byApp.find(x => x.key === 'PrizePicks').legsGraded, 3);
  assert.equal(byApp.find(x => x.key === 'DK Pick6').be, 0.5665);
});

test('a Pikkit bet keeps Pikkit\'s result and profit, and our box scores check it', () => {
  const bet = { id: 'pk-1', app: 'prizepicks', league: 'NBA', placedAt: '2026-10-20T20:00:00Z', stake: 10, profit: 50, payout: 60, odds: 6, status: 'win',
    legs: [{ player: 'A', side: 'Over', line: 10.5, market: 'Points', sport: null }, { player: 'B', side: 'Over', line: 10.5, market: 'Points', sport: null }, { player: 'C', side: 'Over', line: 10.5, market: 'Points', sport: null }] };
  const slip = S.slipFromPikkit(bet);
  assert.ok(slip.legs.every(l => l.sport === 'NBA'), 'legs take the bet\'s league');
  assert.equal(slip.profit, 50);
  let v = S.slipView(slip, {});
  assert.equal(v.by, 'pikkit'); assert.equal(v.result, 'win'); assert.equal(v.returned, 60); assert.equal(v.agree, null);
  v = S.slipView(slip, grades(slip, ['win', 'win', 'win']));
  assert.equal(v.agree, true);
  v = S.slipView(slip, grades(slip, ['win', 'loss', 'win']));
  assert.equal(v.agree, false); assert.equal(v.ours.result, 'loss');
  assert.deepEqual([S.summary([v]).checked, S.summary([v]).agreed], [1, 0]);
  // its legs go out with the bet's own time
  assert.equal(S.gradeRequest([slip])[0].betAtExact, true);
  // a pasted slip with no date is a guess; with one, its own
  assert.equal(S.gradeRequest(S.parseSlips('PrizePicks\nJosh Allen Over 245.5 Pass Yds').slips)[0].betAtExact, undefined);
  assert.equal(S.gradeRequest(S.parseSlips('PrizePicks 10/19 1:00pm\nJosh Allen Over 245.5 Pass Yds', { now: NOW }).slips)[0].betAtExact, true);
});
