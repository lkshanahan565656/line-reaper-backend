const test = require('node:test');
const assert = require('node:assert');
const sp = require('../sportprops');
const { createSportTracker } = require('../sporttrack');
const { createMemoryStore } = require('../evtrack');
const { scoreboard } = require('../closeboard');
const results = require('../results');

const ev = (p, b, m) => (b === 'underdog' ? (p * m / 0.5623 - 1) * 100 : (p * m - 1) * 100);
const cell = (line, over = null, under = null) => ({ line, over, under, overOpen: true, underOpen: true });
const row = books => ({ key: 'NHL|x|shots_on_goal', sport: 'NHL', player: 'X', mkey: 'shots_on_goal', market: 'Shots On Goal', startTime: new Date(Date.now() + 3600e3).toISOString(), books });
const q = (book, line, pOver) => ({ book, line, pOver });

test('book consensus: three books at the same number, the rest ignored', () => {
  const quotes = [q('fanduel', 2.5, 0.40), q('draftkings', 2.5, 0.42), q('caesars', 2.5, 0.41), q('betmgm', 3.5, 0.2), q('pinnacle', 2.5, 0.5), q('matchbook', 2.5, 0.5)];
  const f = sp.bookConsensusAt(quotes, 2.5);
  assert.strictEqual(f.n, 3);
  assert.ok(Math.abs(f.p - 0.41) < 1e-9);
  assert.deepStrictEqual(f.sources.map(x => x.book), ['fanduel', 'draftkings', 'caesars']);
  // a book at another number is never read along a curve: two left, no price
  assert.strictEqual(sp.bookConsensusAt([q('fanduel', 2.5, 0.4), q('draftkings', 2.5, 0.42), q('caesars', 1.5, 0.7)], 2.5), null);
});

test('book consensus: a copied price far off the median is dropped, and three must remain', () => {
  // Hard Rock's copied NHL shots sat 4 to 6 points off every other book (10-16)
  const f = sp.bookConsensusAt([q('fanduel', 1.5, 0.52), q('draftkings', 1.5, 0.52), q('caesars', 1.5, 0.51), q('hardrock', 1.5, 0.45)], 1.5);
  assert.strictEqual(f.n, 3);
  assert.deepStrictEqual(f.dropped, ['hardrock']);
  assert.strictEqual(sp.bookConsensusAt([q('fanduel', 1.5, 0.52), q('draftkings', 1.5, 0.52), q('hardrock', 1.5, 0.40)], 1.5), null);
});

test('book consensus plays: each app at its own line, both sides, PrizePicks at its entry', () => {
  const r = row({ prizepicks: cell(2.5), underdog: cell(1.5, 1.05, 0.85) });
  const quotes = [q('fanduel', 2.5, 0.38), q('draftkings', 2.5, 0.37), q('betrivers', 2.5, 0.39), q('fanduel', 1.5, 0.7)];
  const plays = sp.bookConsensusPlays(r, quotes, { dfsEv: ev });
  assert.ok(plays.every(p => p.book === 'prizepicks'), 'Underdog\'s 1.5 has one book only');
  const under = plays.find(p => p.side === 'Under');
  assert.strictEqual(under.fair, 0.62);
  assert.strictEqual(under.n, 3);
  assert.strictEqual(under.bookFair, 'consensus');
  assert.ok(under.ev > 2, 'a 62% leg clears the 3-pick power break-even');
  assert.ok(under.mean > 1.5 && under.mean < 3);
  assert.deepStrictEqual(sp.bookConsensusPlays({ ...r, mkey: '4q|rec_yds' }, quotes, { dfsEv: ev }), [], 'no quarter lines');
});

test('book-consensus legs: their own record and id, out of the headline, results and book totals', async () => {
  let t = Date.parse('2026-10-15T00:00:00Z');
  const tr = createSportTracker({ store: createMemoryStore(), now: () => t });
  const r = { ...row({ prizepicks: cell(2.5) }), startTime: '2026-10-15T02:00:00Z' };
  const [p] = sp.bookConsensusPlays(r, [q('fanduel', 2.5, 0.38), q('draftkings', 2.5, 0.37), q('betrivers', 2.5, 0.39)], { dfsEv: ev });
  // the same leg flagged as a book-fair play too: two rows
  await tr.record({ rows: [r], flagged: [{ row: r, play: p, kind: 'book-consensus' }, { row: r, play: { ...p, n: 2 }, kind: 'book-fair' }], fairAt: () => 0.36 });
  t += 1.5 * 3600e3;
  await tr.record({ rows: [r], flagged: [], fairAt: () => 0.36 });
  t += 1.5 * 3600e3;
  await tr.record({ rows: [r], flagged: [], fairAt: () => 0.36 });
  const s = await tr.summary();
  assert.strictEqual(s.overall.signals, 0, 'not in the headline');
  assert.strictEqual(s.byKind['book-consensus'].signals, 1);
  assert.strictEqual(s.byKind['book-fair'].signals, 1);
  const legs = await tr.list();
  const leg = legs.find(x => x.kind === 'book-consensus');
  assert.match(leg.id, /\|book-consensus$/);
  assert.strictEqual(leg.closeOk, true);
  const b = scoreboard({ props: legs });
  assert.strictEqual(b.overall.recorded, 0, 'no book total counts it');
  assert.strictEqual(b.byKind['props-book-consensus'].kindLabel, "Pick'em vs 3+ books' consensus");
  assert.strictEqual(b.byKind['props-book-consensus'].graded, 1);
  assert.strictEqual(results.scoreboard({ sportsProps: [{ ...leg, status: 'graded', outcome: 'win', profit: 0.78 }] }).sources.sportsProps.overall.n, 0);
});

test('grader: a leg with no box score yet waits before it is tried again, so fresh legs get graded', async () => {
  let t = Date.parse('2026-10-18T00:00:00Z');
  const store = createMemoryStore();
  const calls = [];
  const grader = { canGrade: () => true, grade: async b => { calls.push(b.player); return b.player.startsWith('stuck') ? null : { outcome: 'win', result: 1 }; } };
  const leg = (player, start) => ({ id: player, status: 'locked', kind: 'sharp', player, start, signalAt: start, signalDecimal: 1.78 });
  for (let i = 0; i < 3; i++) await store.put(leg(`stuck${i}`, '2026-10-17T17:00:00Z'));
  await store.put(leg('fresh', '2026-10-17T20:00:00Z'));
  const tr = createSportTracker({ store, grader, now: () => t });
  await tr.ready();
  // a budget of 2: the stuck legs take it on the first run
  await tr.grade({ max: 2 });
  assert.deepStrictEqual(calls, ['stuck0', 'stuck1']);
  t += 10 * 60e3;
  calls.length = 0;
  await tr.grade({ max: 2 });
  assert.deepStrictEqual(calls, ['stuck2', 'fresh'], 'the ones just tried wait their turn');
  t += 31 * 60e3;
  calls.length = 0;
  await tr.grade({ max: 2 });
  assert.deepStrictEqual(calls, ['stuck0', 'stuck1']);
});
