const test = require('node:test');
const assert = require('node:assert');
const sp = require('../sportprops');
const { createSportTracker } = require('../sporttrack');
const { createMemoryStore } = require('../evtrack');
const { scoreboard } = require('../closeboard');

const ev = (p, b, m) => (b === 'underdog' ? (p * m / 0.5623 - 1) * 100 : (p * m - 1) * 100);
const cell = (line, over = null, under = null) => ({ line, over, under, overOpen: true, underOpen: true });
const row = (books) => ({ key: 'CFB|x|rec_yds', sport: 'CFB', player: 'X', mkey: 'rec_yds', market: 'Receiving Yards', startTime: new Date(Date.now() + 3600e3).toISOString(), books });

test('book fair: FanDuel and BetRivers weigh the same; one book alone is single', () => {
  const r = row({ prizepicks: cell(50.5) });
  const both = sp.bookFairPlays(r, [{ book: 'fanduel', line: 50.5, pOver: 0.6 }, { book: 'betrivers', line: 50.5, pOver: 0.56 }], { dfsEv: ev });
  assert.ok(both.length);
  assert.strictEqual(both[0].n, 2);
  assert.strictEqual(both[0].bookFair, 'both');
  assert.strictEqual(sp.bookFairKind(both[0]), 'book-fair');
  // an even average of the two, not FanDuel's 2-to-1 sharp weight
  const over = both.find(p => p.side === 'Over');
  assert.ok(Math.abs(over.fair - 0.58) < 0.004, `fair ${over.fair}`);
  const one = sp.bookFairPlays(r, [{ book: 'fanduel', line: 50.5, pOver: 0.6 }], { dfsEv: ev });
  assert.strictEqual(one[0].n, 1);
  assert.strictEqual(sp.bookFairKind(one[0]), 'book-fair-single');
});

test('book fair: second-hand books and Pinnacle never enter it; nothing to price, nothing out', () => {
  const r = row({ prizepicks: cell(50.5) });
  assert.deepStrictEqual(sp.bookFairPlays(r, [{ book: 'bet365', line: 50.5, pOver: 0.7 }, { book: 'caesars', line: 50.5, pOver: 0.7 }], { dfsEv: ev }), []);
  const p = sp.bookFairPlays(r, [{ book: 'fanduel', line: 50.5, pOver: 0.6 }, { book: 'hardrock', line: 50.5, pOver: 0.9 }], { dfsEv: ev });
  assert.ok(p[0].sources.every(s => s.book === 'fanduel'));
  // the two books more than 12 points apart at our line: not one market
  assert.deepStrictEqual(sp.bookFairPlays(r, [{ book: 'fanduel', line: 50.5, pOver: 0.7 }, { book: 'betrivers', line: 50.5, pOver: 0.5 }], { dfsEv: ev }), []);
});

test('a consensus of FanDuel and BetRivers alone is not sharp-backed; with Pinnacle or Kalshi it is', () => {
  const r = row({ prizepicks: cell(50.5) });
  const books = sp.consensusPlays(r, { sharp: [{ book: 'fanduel', line: 50.5, pOver: 0.6 }, { book: 'betrivers', line: 50.5, pOver: 0.6 }], dfsEv: ev });
  assert.ok(books.length && !books.some(sp.sharpBacked));
  const pin = sp.consensusPlays(r, { sharp: [{ book: 'pinnacle', line: 50.5, pOver: 0.6 }, { book: 'fanduel', line: 50.5, pOver: 0.6 }], dfsEv: ev });
  assert.ok(pin.every(sp.sharpBacked));
  const kal = sp.consensusPlays(r, { sharp: [{ book: 'fanduel', line: 50.5, pOver: 0.6 }], kalshi: new Map([[50.5, 0.6]]), dfsEv: ev });
  assert.ok(kal.every(sp.sharpBacked));
});

test('book-fair legs keep their own kind, stay out of the headline record and the scoreboard totals', async () => {
  let t = Date.parse('2026-10-15T00:00:00Z');
  const tr = createSportTracker({ store: createMemoryStore(), now: () => t });
  const r = { ...row({ prizepicks: cell(50.5) }), startTime: '2026-10-15T02:00:00Z' };
  const [p] = sp.bookFairPlays(r, [{ book: 'fanduel', line: 50.5, pOver: 0.62 }, { book: 'betrivers', line: 50.5, pOver: 0.6 }], { dfsEv: ev });
  await tr.record({ rows: [r], flagged: [{ row: r, play: p, kind: sp.bookFairKind(p) }], fairAt: () => 0.63 });
  t += 3 * 3600e3;
  await tr.record({ rows: [r], flagged: [], fairAt: () => 0.63 });
  const s = await tr.summary();
  assert.strictEqual(s.overall.signals, 0, 'not in the headline');
  assert.strictEqual(s.byKind['book-fair'].signals, 1);
  const [leg] = await tr.list();
  assert.strictEqual(leg.entry, '3-pick power');
  const b = scoreboard({ props: [leg] });
  assert.strictEqual(b.overall.recorded, 0, 'no book total counts it');
  assert.strictEqual(b.byKind['props-book-fair'].recorded, 1);
  assert.strictEqual(b.byKind['props-book-fair'].kindLabel, "Pick'em vs FanDuel + BetRivers");
});

test('book fair: a book line too far from the app line to convert makes no price', () => {
  // FanDuel 45.5 rush yards at 50% read at a PrizePicks 57.5: ~70% under, a different number
  const r = { ...row({ prizepicks: cell(57.5), underdog: cell(46.5, 1, 1) }), mkey: 'rush_yds' };
  const plays = sp.bookFairPlays(r, [{ book: 'fanduel', line: 45.5, pOver: 0.5 }], { dfsEv: ev });
  assert.ok(!plays.some(p => p.book === 'prizepicks'), 'no fake +26%');
  assert.ok(plays.some(p => p.book === 'underdog'), 'a nearby line still prices');
  // the same line at a lopsided price is a real price, kept
  const nhl = { ...row({ underdog: cell(2.5, 1, 1) }), sport: 'NHL', mkey: 'shots_on_goal' };
  assert.ok(sp.bookFairPlays(nhl, [{ book: 'fanduel', line: 2.5, pOver: 0.39 }], { dfsEv: ev }).length);
});

test('book-fair legs keep a second close on Pinnacle when one appears before the start', async () => {
  let t = Date.parse('2026-10-15T00:00:00Z');
  const tr = createSportTracker({ store: createMemoryStore(), now: () => t });
  const r = { ...row({ prizepicks: cell(50.5) }), startTime: '2026-10-15T02:00:00Z' };
  const [p] = sp.bookFairPlays(r, [{ book: 'fanduel', line: 50.5, pOver: 0.57 }], { dfsEv: ev });
  await tr.record({ rows: [r], flagged: [{ row: r, play: p, kind: sp.bookFairKind(p) }], fairAt: () => 0.57, sharpAt: () => null });
  t += 90 * 60e3;
  await tr.record({ rows: [r], flagged: [], fairAt: () => 0.58, sharpAt: () => 0.6 });
  t += 60 * 60e3;
  await tr.record({ rows: [r], flagged: [], fairAt: () => 0.58, sharpAt: () => 0.6 });
  const [leg] = await tr.list();
  assert.strictEqual(leg.kind, 'book-fair-single');
  assert.strictEqual(leg.closeSharpOk, true);
  assert.ok(leg.closeSharpEv > leg.closeEv, 'Pinnacle closed further our way');
  const s = await tr.summary();
  assert.strictEqual(s.byKind['book-fair-single'].sharpClosed, 1);
});
