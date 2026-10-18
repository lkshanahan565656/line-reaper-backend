const test = require('node:test');
const assert = require('node:assert/strict');
const { createEvTracker, closeState } = require('../evtrack');
const { createSportTracker } = require('../sporttrack');
const { createMemoryStore } = require('../evtrack');
const closeBoard = require('../closeboard');

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
