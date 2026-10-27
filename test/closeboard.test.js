const test = require('node:test');
const assert = require('node:assert/strict');
const { createEvTracker, closeState } = require('../evtrack');
const { createSportTracker } = require('../sporttrack');
const { createMemoryStore } = require('../evtrack');
const closeBoard = require('../closeboard');
const results = require('../results');

const START = '2026-10-15T23:00:00Z';
const row = (o = {}) => ({ group: 'a@b|2026-10-15|spreads|3.5', side: 'A +3.5', book: 'betrivers', sport: 'nfl', event: 'A @ B', market: 'spreads', point: 3.5,
  price: 110, decimal: 2.1, fairProb: 50, ev: 5, source: 'sharp', start: START, ...o });

test('a close read near the start grades; a market pulled hours early closes stale and is not graded', async () => {
  let t = Date.parse('2026-10-15T12:00:00Z');
  const tr = createEvTracker({ now: () => t, freshCloseOnly: true });
  await tr.recordBoard([row(), row({ group: 'pulled', side: 'X' })]);
  // the pulled market leaves the screen; the other is priced every screen to the start
  for (t += 30 * 60e3; t < Date.parse(START); t += 30 * 60e3) await tr.recordBoard([], new Map([['a@b|2026-10-15|spreads|3.5|A +3.5', 50]]));
  t = Date.parse(START) + 1000;
  await tr.recordBoard([]);
  const bets = await tr.list({ status: 'closed' });
  const live = bets.find(b => b.group !== 'pulled'), pulled = bets.find(b => b.group === 'pulled');
  assert.equal(live.closeOk, true);
  assert.ok(live.closeAgeMin <= 30, 'seen within the last screen');
  assert.equal(pulled.closeOk, false);
  assert.equal(pulled.closeAgeMin, 11 * 60);
  assert.equal(pulled.clv, 5, 'still scored, but at the flag fair');
  const s = await tr.summary();
  assert.equal(s.overall.n, 1, 'only the fresh close is graded');
  assert.deepEqual(s.closeCheck, { ok: 1, stale: 1, unverified: 0 });
});

test('the seen time is saved every 10 minutes, so a restart keeps it', async () => {
  let t = Date.parse('2026-10-15T22:00:00Z');
  const store = createMemoryStore();
  const a = createEvTracker({ store, now: () => t, freshCloseOnly: true });
  await a.recordBoard([row()]);
  t += 15 * 60e3;
  await a.recordBoard([], new Map([['a@b|2026-10-15|spreads|3.5|A +3.5', 50]]));
  assert.equal((await store.all())[0].fairSeenAt, new Date(t).toISOString(), 'unchanged fair, 15 min on: saved');
  t += 5 * 60e3;
  await a.recordBoard([], new Map([['a@b|2026-10-15|spreads|3.5|A +3.5', 50]]));
  assert.equal((await store.all())[0].fairSeenAt, new Date(t - 5 * 60e3).toISOString(), '5 min later: not written again');
});

test('closeState: legacy closes with no seen time are unverified unless the fair changed inside the hour', () => {
  assert.equal(closeState({ status: 'open' }), null);
  assert.equal(closeState({ status: 'closed', start: START, closeAt: '2026-10-15T22:30:00Z' }), 'ok');
  assert.equal(closeState({ status: 'closed', start: START, closeAt: '2026-10-15T18:00:00Z' }), 'unverified');
  assert.equal(closeState({ status: 'closed', start: START, closeOk: false }), 'stale');
});

test('pick\'em legs record when their fair was last read and lock with closeOk', async () => {
  let t = Date.parse('2026-10-15T20:00:00Z');
  const tr = createSportTracker({ store: createMemoryStore(), now: () => t, log: { warn() {} } });
  const brow = { key: 'k1', sport: 'NFL', player: 'P One', mkey: 'rec_yds', market: 'Receiving Yards', startTime: START, books: { prizepicks: { line: 50.5, overOpen: true, underOpen: true } } };
  const play = { book: 'prizepicks', side: 'Over', line: 50.5, mult: 1, fair: 0.58, ev: 5, decimal: 1 / 0.5503 };
  await tr.record({ rows: [brow], flagged: [{ row: brow, play, kind: 'sharp' }], fairAt: () => 0.58 });
  t = Date.parse(START) - 20 * 60e3;
  await tr.record({ rows: [brow], fairAt: () => 0.6 });
  t = Date.parse(START) + 60e3;
  await tr.record({ rows: [brow], fairAt: () => null });
  const [b] = await tr.list();
  assert.equal(b.status, 'locked');
  assert.equal(b.closeAgeMin, 20);
  assert.equal(b.closeOk, true);
});

test('scoreboard: by book and kind, graded toward 50, ungraded rows say not graded yet', () => {
  const ev = [
    ...Array.from({ length: 25 }, (_, i) => ({ id: `e${i}`, status: 'closed', book: 'betrivers', source: 'sharp', event: `G${i}`, start: START, closeOk: true, clv: 2 + (i % 3), execClv: 1.5 + (i % 3), flaggedAt: START, sport: 'nfl', market: 'spreads' })),
    { id: 's1', status: 'closed', book: 'draftkings', source: 'sharp', start: START, closeOk: false, clv: 9, flaggedAt: START },
    { id: 'o1', status: 'open', book: 'draftkings', source: 'sharp', start: START, flaggedAt: START },
  ];
  const props = [{ id: 'p1', status: 'graded', kind: 'sharp', book: 'prizepicks', signalBook: 'PP', start: START, closeOk: true, closeEv: -3, execOk: true, outcome: 'loss', profit: -1, signalAt: START },
    { id: 'p2', status: 'open', kind: 'gap-odd', book: 'prizepicks', signalBook: 'PP', start: START, signalAt: START }];
  const b = closeBoard.scoreboard({ ev, props });
  assert.equal(b.byBook.betrivers.graded, 25);
  assert.equal(b.byBook.betrivers.toTarget, 0.5);
  assert.equal(b.byBook.betrivers.beatPct, 100);
  assert.equal(b.byBook.betrivers.mark, 'promising', 'a t of 2, but under 50 graded games: not proven yet');
  // nine lines on one game are one play
  const same = closeBoard.scoreboard({ ev: Array.from({ length: 9 }, (_, i) => ({ id: `x${i}`, status: 'closed', book: 'betrivers', source: 'sharp', event: 'One game', start: START, closeOk: true, clv: 4, flaggedAt: START })) });
  assert.equal(same.byBook.betrivers.graded, 1);
  assert.equal(same.byBook.betrivers.gradedLines, 9);
  // a close on our own curve is shown, never marked, never in the book's total
  const model = closeBoard.scoreboard({ alt: [{ id: 'm', status: 'closed', book: 'fanduel', source: 'alt-model', event: 'G', start: START, closeOk: true, clv: 6, flaggedAt: START }] });
  assert.equal(model.byKind['alt-model'].mark, 'no sharp close');
  assert.equal(model.byBook.fanduel, undefined);
  assert.equal(b.byBook.draftkings.graded, 0);
  assert.equal(b.byBook.draftkings.staleClose, 1);
  assert.equal(b.byBook.draftkings.open, 1);
  assert.equal(b.byBook.draftkings.mark, 'not graded yet');
  assert.equal(b.byBook.draftkings.relayed, true);
  assert.equal(b.byKind['props-sharp'].losses, 1);
  assert.equal(b.byKind['props-gap-odd'], undefined, 'research rows are not plays');
  assert.equal(b.rows.find(r => r.kind === 'ev' && r.book === 'betrivers').bookName, 'BetRivers');
});

test('proven: one kind on one book we read ourselves; pooled totals and copied books stop at promising (10-16)', () => {
  const ev = (n, book, o = {}) => Array.from({ length: n }, (_, i) => ({ id: `${book}${i}${o.source || ''}`, status: 'closed', book, source: 'sharp', event: `G${i}`, start: START,
    closeOk: true, clv: 2 + (i % 3), execClv: 1.5 + (i % 3), flaggedAt: START, sport: 'nhl', market: 'shots_on_goal', ...o }));
  const b = closeBoard.scoreboard({ ev: [...ev(55, 'betrivers'), ...ev(60, 'hardrock')] });
  assert.equal(b.rows.find(r => r.kind === 'ev' && r.book === 'betrivers').mark, 'proven');
  assert.equal(b.byBook.betrivers.mark, 'proven', 'through its own main lines');
  assert.equal(b.rows.find(r => r.kind === 'ev' && r.book === 'hardrock').mark, 'promising', 'a copied price');
  assert.equal(b.byBook.hardrock.mark, 'promising');
  assert.equal(b.overall.mark, 'promising', 'the pool is never proof');
  assert.equal(b.byKind.ev.mark, 'promising', 'a kind pools its books');
  // 30 main lines and 30 alt lines on one book: 60 games, but no one kind has 50
  const mixed = closeBoard.scoreboard({ ev: ev(30, 'betrivers'), alt: ev(30, 'betrivers', { source: 'alt', event: undefined, group: 'x' }).map((x, i) => ({ ...x, group: `A${i}` })) });
  assert.equal(mixed.byBook.betrivers.graded, 60);
  assert.equal(mixed.byBook.betrivers.mark, 'promising');
});

// An alt line's close is Kalshi's midpoint or a sportsbook's own number at
// that rung, never Pinnacle's two-way price there: on 10-18 FanDuel's alt lines
// read proven at 75 games (+2.6% CLV) while losing 24.6 units on 102 lines.
test('alt lines stop at promising, and a book is never proven through them', () => {
  const alt = Array.from({ length: 60 }, (_, i) => ({ id: `a${i}`, status: 'closed', book: 'fanduel', source: 'alt', group: `alt|G${i}`, event: `G${i}`, start: START,
    closeOk: true, clv: 2 + (i % 3), execClv: 1.5 + (i % 3), flaggedAt: START, sport: 'nhl', market: 'assists' }));
  const b = closeBoard.scoreboard({ alt });
  const row = b.rows.find(r => r.kind === 'alt' && r.book === 'fanduel');
  assert.equal(row.graded, 60);
  assert.equal(row.mark, 'promising');
  assert.equal(b.byBook.fanduel.mark, 'promising');
});

// The webhook reaches other people, so it posts only what the scoreboard
// marks proven: one kind on one book read direct (10-18: the old gate counted
// raw lines per book, so Action Network's copies of Hard Rock, DraftKings,
// bet365, theScore and Fanatics were posting alongside BetRivers).
test('alert books: a proven main-lines row on a book read direct, never a copy, a lead or a pick\'em app short of proven', () => {
  const board = { rows: [
    { kind: 'ev', book: 'betrivers', relayed: false, mark: 'proven', avgExecClv: 2.4 },
    { kind: 'ev', book: 'hardrock', relayed: true, mark: 'promising', avgExecClv: 3.4 },
    { kind: 'ev', book: 'fanduel', relayed: false, mark: 'promising', avgExecClv: 0.5 },
    { kind: 'alt', book: 'fanduel', relayed: false, mark: 'proven', avgExecClv: 1.9 },
    { kind: 'ev', book: 'caesars', relayed: true, mark: 'proven', avgExecClv: 2 },
    { kind: 'ev', book: 'bet365', relayed: false, mark: 'proven', avgExecClv: 0.4 },
    { kind: 'props-ev', book: 'prizepicks', relayed: false, mark: 'promising', avgExecClv: 1.2 },
    { kind: 'props-ev', book: 'sleeper', relayed: false, mark: 'proven', avgExecClv: 1.5 },
  ] };
  const a = closeBoard.alertBooks(board, { minExecClv: 1 });
  assert.deepEqual([...a].sort(), ['betrivers', 'sleeper']);
  assert.ok(!a.has('fanduel'), 'an alt-lines proof does not open main-line alerts');
  assert.ok(!a.has('caesars'), 'a copied price never alerts, whatever its mark');
  assert.ok(!a.has('bet365'), 'proven but under the two-minute bar');
  assert.deepEqual([...closeBoard.alertBooks({ rows: [] })], []);
});

test('alert books from real records: BetRivers with 50 graded games alerts, a copied book with more does not', () => {
  const evs = [];
  for (let i = 0; i < 60; i++) {
    const base = { status: 'closed', closeOk: true, start: `2026-10-${String(10 + (i % 9)).padStart(2, '0')}T23:00:00Z`, flaggedAt: '2026-10-10T12:00:00Z', source: 'sharp' };
    evs.push({ ...base, book: 'betrivers', event: `G${i}`, clv: 3 + (i % 3), execClv: 2 + (i % 2), execPrice: 0.5 });
    evs.push({ ...base, book: 'hardrock', event: `G${i}`, clv: 4 + (i % 3), execClv: 3 + (i % 2), execPrice: 0.5 });
    if (i < 30) evs.push({ ...base, book: 'fanduel', event: `G${i}`, clv: 3 + (i % 3), execClv: 2, execPrice: 0.5 });
  }
  const board = closeBoard.scoreboard({ ev: evs });
  const a = closeBoard.alertBooks(board, { minExecClv: 1 });
  assert.deepEqual([...a], ['betrivers']);
});

// Stale lines are priced at the venue's own number, which Pinnacle has
// usually just left: the close there is our curve. 10-19: BetRivers' stale
// lines read proven at 65 games (+4.2% CLV) while 104 lines lost 16.9 units.
test('stale lines stop at promising and say why', () => {
  const stale = Array.from({ length: 60 }, (_, i) => ({ id: `s${i}`, status: 'closed', book: 'betrivers', source: 'stale-single', group: `stale-single|G${i}|1`, event: `G${i}`, start: START,
    closeOk: true, clv: 3 + (i % 3), execClv: 3 + (i % 3), flaggedAt: START, sport: 'nfl', market: 'rec_yds' }));
  const b = closeBoard.scoreboard({ stale });
  const row = b.rows.find(r => r.kind === 'stale-single' && r.book === 'betrivers');
  assert.equal(row.graded, 60);
  assert.equal(row.mark, 'promising');
  assert.match(row.note, /curve/);
  assert.equal(b.byBook.betrivers.mark, 'promising', 'never a book\'s proof');
  assert.deepEqual([...closeBoard.alertBooks(b)], []);
});

// 10-24: PrizePicks' stale legs re-checked from box scores. Where Pinnacle sat
// elsewhere (our curve) they lost 5.8 units against +6.0 the close expected;
// at Pinnacle's own number they held. A stale leg keeps Pinnacle's raw number to the start and
// scores on Pinnacle's own price only when it sat on the app's line.
test('stale legs keep Pinnacle\'s own number to the start; only exact ones score on its price', async () => {
  let t = Date.parse('2026-10-15T20:00:00Z');
  const tr = createSportTracker({ store: createMemoryStore(), now: () => t, log: { warn() {} } });
  const mk = (player, line) => ({ key: `NFL|${player}|rec_yds`, sport: 'NFL', player, mkey: 'rec_yds', market: 'Receiving Yards', startTime: START, books: { prizepicks: { line, overOpen: true, underOpen: true } } });
  const a = mk('A One', 50.5), b = mk('B Two', 60.5), c = mk('C Three', 40.5);
  const play = (line, pinX) => ({ book: 'prizepicks', side: 'Under', line, mult: 1, fair: 0.58, ev: 5, decimal: 1 / 0.5503, signalAt: t,
    stale: { pinPost: `o${pinX} 42.0%`, pinX } });
  // a: Pinnacle on 50.5 at the flag and the close; b: Pinnacle on 61.5 (our curve); c: on 40.5, then moves to 41.5
  const pins = { 'A One': { x: 50.5, p: 0.43 }, 'B Two': { x: 61.5, p: 0.45 }, 'C Three': { x: 40.5, p: 0.42 } };
  const pinAt = r => pins[r.player];
  await tr.record({ rows: [a, b, c], flagged: [{ row: a, play: play(50.5, 50.5), kind: 'stale-single' }, { row: b, play: play(60.5, 61.5), kind: 'stale-single' }, { row: c, play: play(40.5, 40.5), kind: 'stale' }], fairAt: () => 0.42, pinAt });
  t = Date.parse(START) - 20 * 60e3;
  pins['C Three'] = { x: 41.5, p: 0.5 };
  await tr.record({ rows: [a, b, c], fairAt: () => 0.42, pinAt });
  t = Date.parse(START) + 1000;
  await tr.record({ rows: [a, b, c], fairAt: () => 0.42, pinAt });
  const legs = await tr.list({});
  const A = legs.find(x => x.player === 'A One'), B = legs.find(x => x.player === 'B Two'), C = legs.find(x => x.player === 'C Three');
  assert.equal(A.signalPinLine, 50.5);
  assert.equal(A.pinExact, true);
  assert.equal(A.closePinFair, 0.57);
  assert.equal(A.closePinEv, Math.round((0.57 / 0.5503 - 1) * 1e4) / 100);
  assert.equal(B.pinExact, false, 'Pinnacle never on the app\'s number');
  assert.equal(B.closePinEv, null);
  assert.equal(C.pinExact, false, 'Pinnacle left the number before the close');
  assert.equal(C.closePinLine, 41.5);
  assert.equal((await tr.list({ kind: 'stale' })).length, 1, 'list narrows by kind');
  // the board: exact legs score on their own row, not in the book's total twice
  const graded = legs.map(x => ({ ...x, status: 'graded', outcome: 'win', profit: x.signalDecimal - 1 }));
  const board = closeBoard.scoreboard({ props: graded });
  const ex = board.rows.find(r => r.kind === 'props-stale-exact');
  assert.equal(ex.graded, 1);
  assert.equal(ex.avgClv, A.closePinEv);
  assert.equal(ex.note, undefined, 'not capped');
  assert.match(board.rows.find(r => r.kind === 'props-stale-single').note, /own row/);
  assert.equal(board.byBook.prizepicks.graded, 3, 'each leg once in the book\'s total');
});

test('pinLineOf: the row\'s number, else the label', () => {
  const { pinLineOf } = require('../sporttrack');
  assert.equal(pinLineOf({ pinX: 14.5 }), 14.5);
  assert.equal(pinLineOf({ pinPost: 'o24.5 55.3%' }), 24.5);
  assert.equal(pinLineOf({ pinNow: 'o-3 50%' }), -3);
  assert.equal(pinLineOf(null), null);
  const { pinClose } = require('../sporttrack');
  const start = Date.parse(START);
  const legacy = { signalLine: 14.5, signalDecimal: 1.8172, stale: { pinPost: 'o14.5 40%' }, closePinLine: 14.5, closePinFair: 0.6, closePinAt: new Date(start - 5 * 60e3).toISOString() };
  assert.equal(pinClose(legacy, start).pinExact, true, 'a leg logged before the field reads its label');
  assert.equal(pinClose({ ...legacy, closePinAt: new Date(start - 90 * 60e3).toISOString() }, start).pinExact, false, 'a Pinnacle read 90 min before the start is no close');
});

// A kind whose graded results sit far under what its close expected isn't
// proven, whatever its CLV: the close is in doubt.
test('results far under the close hold a kind at promising', () => {
  const leg = (i, win) => ({ id: `p${i}`, status: 'graded', kind: 'ev', book: 'prizepicks', signalBook: 'PP', sport: 'NFL', player: `P${i}`, mkey: 'rec_yds', start: START,
    closeOk: true, closeEv: 4, closeFair: 0.57, signalDecimal: 1.8247, execOk: true, outcome: win ? 'win' : 'loss', profit: win ? 0.8247 : -1, signalAt: START });
  const losing = closeBoard.scoreboard({ props: Array.from({ length: 60 }, (_, i) => leg(i, i % 3 === 0)) });   // 20 of 60 won, 34 expected
  const r = losing.rows.find(x => x.kind === 'props-ev');
  assert.equal(r.mark, 'promising');
  assert.match(r.note, /close is in doubt/);
  assert.ok(r.resultsZ < -1.5);
  const fine = closeBoard.scoreboard({ props: Array.from({ length: 60 }, (_, i) => leg(i, i % 7 < 4)) });   // about 57% won
  assert.equal(fine.rows.find(x => x.kind === 'props-ev').mark, 'proven');
});

test('resultsShortfall: needs 30 lines and 1.5 sd under', () => {
  const l = n => Array.from({ length: n }, (_, i) => ({ win: i % 3 === 0, p: 0.55, d: 1.9 }));
  assert.equal(results.resultsShortfall(l(20)).short, false, 'too few');
  const s = results.resultsShortfall(l(60));
  assert.equal(s.short, true); assert.ok(s.z < -1.5);
  assert.equal(results.resultsShortfall([]).n, 0);
});

// ─── the public record's download (closeboard.flags / flagsCsv) ─────────────
test('flags: one line per closed flag with the price shown, the size behind it, the close, the CLV and the result; open flags stay out', () => {
  const ev = [
    { id: 'e1', status: 'closed', flaggedAt: '2026-10-20T15:00:00Z', start: '2026-10-20T23:00:00Z', sport: 'nfl', event: 'A @ B', market: 'spreads', side: 'A +3.5', book: 'betrivers', price: 110, decimal: 2.1,
      closeFair: 50, clv: 5, execClv: 4, closeOk: true, outcome: 'win', profit: 1.1, source: 'sharp' },
    { id: 'e2', status: 'closed', flaggedAt: '2026-10-21T15:00:00Z', start: '2026-10-21T23:00:00Z', sport: 'nfl', event: 'C @ D', market: 'h2h', side: 'D', book: 'polymarketus', decimal: 1.8,
      depthUsd: 412.5, execSizedUsd: 100, pinClose: 57, pinClv: 2.6, execPinClv: 1.9, pinCloseOk: true, closeFair: 56, clv: 0.8, closeOk: true, outcome: 'loss', profit: -1, source: 'sharp' },
    { id: 'e3', status: 'open', flaggedAt: '2026-10-25T15:00:00Z', start: '2026-10-26T23:00:00Z', event: 'E @ F', side: 'E', book: 'betrivers', decimal: 2, source: 'sharp' },
  ];
  const props = [{ id: 'p1', status: 'graded', kind: 'ev', sport: 'NBA', player: 'P One', market: 'Points', mkey: 'pts', signalAt: '2026-10-22T18:00:00Z', start: '2026-10-22T23:30:00Z',
    book: 'prizepicks', signalBook: 'PP', signalSide: 'Over', signalLine: 24.5, signalDecimal: 1.8, closeFair: 0.58, closeEv: 4.4, closeOk: true, outcome: 'win', profit: 0.8 }];
  const rows = closeBoard.flags({ ev, props });
  assert.deepEqual(rows.map(r => r.id), ['p1', 'e2', 'e1'], 'newest first, the open flag left out');
  const [p1, e2, e1] = rows;
  assert.equal(e1.priceAmerican, 110);
  assert.equal(e1.priceDecimal, 2.1);
  assert.equal(e1.clvPct, 5);
  assert.equal(e1.clv2minPct, 4);
  assert.equal(e1.result, 'win');
  assert.equal(e1.units, 1.1);
  assert.equal(e1.fillUsd, null, 'a sportsbook posts no size');
  assert.equal(e2.closeOn, "Pinnacle's own close");
  assert.equal(e2.closeProb, 0.57);
  assert.equal(e2.clvPct, 2.6, 'an exchange a Texan trades is graded on Pinnacle\'s own close');
  assert.equal(e2.fillUsd, 412.5);
  assert.equal(e2.priceAmerican, -125);
  assert.equal(p1.pick, 'P One Over 24.5 Points');
  assert.equal(p1.kind, 'props-ev');
  assert.equal(p1.closeProb, 0.58);
  assert.equal(closeBoard.flags({ ev, props }, { kind: 'ev', book: 'betrivers' }).length, 1);
  const csv = closeBoard.flagsCsv(rows).split('\r\n');
  assert.equal(csv[0], closeBoard.FLAG_COLUMNS.join(','));
  assert.equal(csv.length, 5, 'header, three flags and the closing line break');
});

test('flagsCsv quotes commas and quotes, and keeps a cell from running as a spreadsheet formula', () => {
  const csv = closeBoard.flagsCsv([{ event: 'A, "B" @ C', pick: '=HYPERLINK("x")', units: -1, priceAmerican: -125 }]).split('\r\n')[1];
  assert.ok(csv.includes('"A, ""B"" @ C"'));
  assert.ok(csv.includes(`"'=HYPERLINK(""x"")"`));
  assert.ok(csv.includes(',-125,') && csv.includes(',-1,'), 'negative numbers stay numbers');
});

test('the scoreboard rows carry the CLV t and units the Results page shows', () => {
  const ev = Array.from({ length: 4 }, (_, i) => ({ id: `x${i}`, status: 'closed', flaggedAt: `2026-10-2${i}T15:00:00Z`, start: `2026-10-2${i}T23:00:00Z`, event: `G${i}`, side: 'A', book: 'betrivers',
    decimal: 2, closeFair: 52, clv: 2 + i, closeOk: true, outcome: i % 2 ? 'win' : 'loss', profit: i % 2 ? 1 : -1, source: 'sharp' }));
  const row = closeBoard.scoreboard({ ev }).rows.find(r => r.kind === 'ev');
  assert.equal(row.graded, 4);
  assert.ok(row.clvT > 2);
  assert.equal(row.units, 0);
  assert.equal(row.wins, 2);
});
