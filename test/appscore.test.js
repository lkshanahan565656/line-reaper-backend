const test = require('node:test');
const assert = require('node:assert');
const A = require('../appscore');
const { createPropCloseBook } = require('../propclose');
const { createMemoryStore } = require('../evtrack');

const entry = (o = {}) => ({ sport: 'NFL', mkey: 'rec_yds', player: 'Puka Nacua', team: 'LAR', matchTitle: 'LAR @ JAX', start: '2026-10-25T17:00:00.000Z', pin: [[60.5, 0.5]], cells: {}, ...o });

test("Pinnacle's main line is the rung nearest 50/50", () => {
  assert.deepStrictEqual(A.pinMain([[55.5, 0.62], [60.5, 0.49], [65.5, 0.38]]), [60.5, 0.49]);
  assert.strictEqual(A.pinMain([]), null);
});

test('an app at Pinnacle\'s exact number: gap 0, exact chance, PrizePicks takes the side Pinnacle favours', () => {
  const l = A.legOf(entry({ pin: [[60.5, 0.56]], cells: { prizepicks: [60.5, null, null, 1, 1] } }), 'prizepicks');
  assert.strictEqual(l.gap, 0);
  assert.strictEqual(l.exact, true);
  assert.strictEqual(l.side, 'Over');
  assert.strictEqual(l.p, 0.56);
  assert.strictEqual(l.be, 0.5503);
  assert.strictEqual(l.clears, true);
  assert.ok(Math.abs(l.dist - 0.06) < 1e-9);
});

test('an app below Pinnacle\'s number: the Over gets the better number, read along the curve (not exact)', () => {
  const l = A.legOf(entry({ pin: [[64.5, 0.5]], cells: { prizepicks: [57.5, null, null, 1, 1] } }), 'prizepicks');
  assert.strictEqual(l.gap, -7);
  assert.strictEqual(l.exact, false);
  assert.strictEqual(l.side, 'Over');
  assert.ok(l.p > 0.5, `p ${l.p}`);
});

test('Underdog: the side to take is the larger margin over its own break-even, not always the favoured side', () => {
  // Pinnacle 59% Under at 3.5; Underdog pays the Over 1.16x and the Under 0.8x
  const l = A.legOf(entry({ mkey: 'receptions', pin: [[3.5, 0.41]], cells: { underdog: [3.5, 1.16, 0.8, 1, 1] } }), 'underdog');
  assert.strictEqual(l.favSide, 'Under');
  // Over: 41% vs 56.23/1.16 = 48.5%; Under: 59% vs 56.23/0.8 = 70.3% → the Over is the smaller loss
  assert.strictEqual(l.side, 'Over');
  assert.ok(Math.abs(l.be - 0.5623 / 1.16) < 1e-4);
  assert.strictEqual(l.clears, false);
});

test('an Underdog side posted alone above 1.35x has no known break-even; a cell without multipliers neither', () => {
  const td = A.legOf(entry({ mkey: 'anytime_td', pin: [[0.5, 0.36]], cells: { underdog: [0.5, 1.4, null, 1, 0] } }), 'underdog');
  assert.strictEqual(td.be, null);
  assert.strictEqual(td.clears, false);
  assert.strictEqual(td.dist, 0.14);
  // an old close-book entry (line only): Sleeper unknown, PrizePicks known
  const old = entry({ cells: undefined, apps: { sleeper: 60.5, prizepicks: 60.5 }, pin: [[60.5, 0.57]] });
  assert.strictEqual(A.legOf(old, 'sleeper').be, null);
  assert.strictEqual(A.legOf(old, 'prizepicks').be, 0.5503);
});

test('no Pinnacle number or no app number: no leg', () => {
  assert.strictEqual(A.legOf(entry({ pin: [], cells: { prizepicks: [60.5, null, null, 1, 1] } }), 'prizepicks'), null);
  assert.strictEqual(A.legOf(entry(), 'prizepicks'), null);
});

test('legs from the close book: graded off the result at the app\'s own number, voided props left out', () => {
  const book = [
    ['a', entry({ pin: [[60.5, 0.56]], cells: { prizepicks: [60.5, null, null, 1, 1], sleeper: [61.5, 1.8, 1.8, 1, 1] } })],
    ['b', entry({ player: 'X', pin: [[40.5, 0.44]], cells: { prizepicks: [40.5, null, null, 1, 1] } })],
    ['c', entry({ player: 'Y', pin: [[30.5, 0.5]], cells: { prizepicks: [30.5, null, null, 1, 1] } })],
  ];
  const results = new Map([['a', { result: 61 }], ['b', { result: 41 }], ['c', { void: 'did not play' }]]);
  const legs = A.legsFromBook(book, results);
  assert.strictEqual(legs.length, 3);
  const pp = legs.find(l => l.key === 'a' && l.app === 'prizepicks');
  assert.strictEqual(pp.out, 'win');              // Over 60.5, 61
  const sl = legs.find(l => l.key === 'a' && l.app === 'sleeper');
  // Pinnacle's 56% Over at 60.5 still leans Over at Sleeper's 61.5 (equal 1.8x both sides): 61 loses it
  assert.strictEqual(sl.side, 'Over');
  assert.strictEqual(sl.out, 'loss');
  const b = legs.find(l => l.key === 'b');
  assert.strictEqual(b.side, 'Under');
  assert.strictEqual(b.out, 'loss');               // Under 40.5, 41
});

test('the scorecard: per app and per stat, shares and the judged bar at 50 graded', () => {
  const legs = [];
  for (let i = 0; i < 60; i++) {
    const e = entry({ player: `P${i}`, pin: [[60.5, 0.6]], cells: { prizepicks: [i % 2 ? 60.5 : 59.5, null, null, 1, 1] } });
    const l = A.legOf(e, 'prizepicks');
    l.out = i < 45 ? 'win' : 'loss';
    legs.push(l);
  }
  const card = A.scorecard(legs, { minCell: 5 });
  assert.strictEqual(card.legs, 60);
  assert.strictEqual(card.graded, 60);
  const pp = card.apps[0];
  assert.strictEqual(pp.app, 'prizepicks');
  assert.strictEqual(pp.exact, 50);
  assert.strictEqual(pp.off, 50);
  assert.strictEqual(pp.low, 50);
  assert.strictEqual(pp.high, 0);
  assert.strictEqual(pp.clears, 100);
  assert.strictEqual(pp.judged.n, 60);
  assert.strictEqual(pp.judged.w, 45);
  assert.strictEqual(pp.judged.bar, 'passes, needs the raw re-check');
  assert.strictEqual(card.cells[0].mkey, 'rec_yds');
  const small = A.scorecard(legs.slice(0, 10));
  assert.strictEqual(small.apps[0].judged.bar, '10 of 50 graded');
  assert.match(A.reportText(card), /PrizePicks/);
});

test('the recorder\'s legs: Pinnacle\'s raw close de-vigged, the app\'s close or bet-time number', () => {
  const b = { app: 'prizepicks', key: 'k', sport: 'NFL', mkey: 'pass_yds', bet: { v: [229.5, null, null, 1, 1] }, close: { v: [233.5, null, null, 1, 1], books: { pinnacle: { exact: false, line: 229.5, over: -125, under: 103 } } }, graded: { result: 250 } };
  const [c] = A.legsFromBoard([b]);
  assert.strictEqual(c.gap, 4);
  assert.strictEqual(c.out, c.side === 'Over' ? 'win' : 'loss');
  const [bt] = A.legsFromBoard([b], { at: 'bet' });
  assert.strictEqual(bt.gap, 0);
  assert.strictEqual(bt.side, 'Over');
  assert.strictEqual(bt.out, 'win');
  assert.deepStrictEqual(A.legsFromBoard([{ ...b, close: { v: [1], books: {} } }]), []);
});

test('results: one grade per prop after 3 hours, saved; a stat with no source voids without asking', async () => {
  let t = Date.parse('2026-10-25T19:00:00Z');
  const store = createMemoryStore();
  const asked = [];
  const grader = { canGrade: p => p.mkey !== 'fantasy_score', grade: async p => { asked.push(p.player); return { result: 70, outcome: 'win' }; } };
  const R = A.createResults({ store, grader, now: () => t });
  const book = [['a', entry()], ['b', entry({ player: 'Z', mkey: 'fantasy_score' })], ['c', entry({ player: 'Later', start: '2026-10-25T20:25:00.000Z' })]];
  await R.run(book);
  assert.deepStrictEqual(asked, []);            // 2 hours in: nothing yet
  t += 3600e3;
  const r = await R.run(book);
  assert.deepStrictEqual(asked, ['Puka Nacua']);
  assert.strictEqual(r.graded, 1);
  assert.strictEqual(r.voided, 1);
  assert.strictEqual(R.get('a').result, 70);
  assert.strictEqual(R.get('b').status, 'void');
  await R.run(book);
  assert.strictEqual(asked.length, 1);          // settled once
  const again = A.createResults({ store, grader, now: () => t });
  await again.ready();
  assert.strictEqual(again.get('a').result, 70);  // reloaded from the store
});

test('the close book keeps each app\'s whole cell and lists its closed props', async () => {
  let t = Date.parse('2026-10-25T16:30:00Z');
  const book = createPropCloseBook({ store: createMemoryStore(), now: () => t, log: { warn() {} } });
  const row = { sport: 'NFL', player: 'Puka Nacua', mkey: 'rec_yds', market: 'Receiving Yards', startTime: '2026-10-25T17:00:00.000Z',
    books: { underdog: { line: 60.5, over: 1.03, under: 0.88, overOpen: true, underOpen: true }, prizepicks: { line: 59.5 } } };
  await book.observe([row], () => ({ pin: [{ line: 60.5, pOver: 0.52 }], kal: new Map() }));
  t = Date.parse('2026-10-25T17:02:00Z');
  await book.observe([], () => null);
  const list = book.entries({ sports: ['NFL'] });
  assert.strictEqual(list.length, 1);
  assert.deepStrictEqual(list[0][1].cells.underdog, [60.5, 1.03, 0.88, 1, 1]);
  assert.deepStrictEqual(list[0][1].cells.prizepicks, [59.5, null, null, 1, 1]);
  assert.strictEqual(book.entries({ sports: ['NBA'] }).length, 0);
  const legs = A.legsFromBook(list);
  assert.strictEqual(legs.length, 2);
});
