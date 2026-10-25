const test = require('node:test');
const assert = require('node:assert/strict');
const { autoSlips, bookLeg, priceOnBooks } = require('../slipbuild');
const { PICK6_PAYOUTS } = require('../slip');

const NOW = Date.parse('2026-10-15T06:00:00Z');
// three CS picks in three matches, each with a Pick6 cell on the number a Pinnacle-based model priced
const mk = (player, team, gameId) => ({ player, team, sport: 'CS', market: 'MAPS 1-2 Kills', displayMarket: 'MAPS 1-2 Kills', matchTitle: `${team} vs X${gameId}`, gameId,
  startTime: '2026-10-15T14:00:00Z', side: 'OVER', pricing: { line: 30.5, books: {}, lines: { books: {}, marketOk: true } } });
const picks = [mk('NiKo', 'Falcons', 1), mk('ZywOo', 'Vitality', 2), mk('s1mple', 'Faze', 3)];
const cell = (o = {}) => ({ line: 30.5, over: 1, under: 1, overOpen: true, underOpen: true, ev: { side: 'Over', ev: 8.9, fair: 60, twin: 'prizepicks', share: true, clears: true, ...o } });
const cells = new Map(picks.map(p => [p, cell()]));

test('with Pick6 off the builder has the three books and the same output', () => {
  const off = autoSlips(picks, { now: NOW });
  assert.deepEqual(Object.keys(off.books), ['PP', 'UD', 'SL']);
  assert.deepEqual(Object.keys(off.pool), ['PP', 'UD', 'SL']);
  assert.equal(off.slips.some(s => s.book === 'P6'), false);
  assert.deepEqual(Object.keys(priceOnBooks(picks, [])), ['PP', 'UD', 'SL']);
  // an empty map (Pick6 on, nothing priced) is the same as off
  assert.deepEqual(Object.keys(autoSlips(picks, { now: NOW, pick6: new Map() }).books), ['PP', 'UD', 'SL']);
});

test('a Pick6 card is built from Pick6\'s own lines and table, one leg a match', () => {
  const on = autoSlips(picks, { now: NOW, pick6: cells });
  const sizes = on.books.P6;
  assert.ok(sizes.length >= 2);
  const best = on.slips.find(s => s.book === 'P6');
  assert.equal(best.bookName, 'DK Pick6');
  assert.equal(best.status, 'plus');
  assert.equal(new Set(best.picks.map(l => l.gameId)).size, best.picks.length, 'one leg a match');
  // a 2-pick at 60% a leg and the 3x table: 0.36 x 3 - 1 = +8%
  const two = sizes.find(s => s.legs === 2);
  assert.equal(two.ev, 8);
  assert.equal(two.paysAll, 3);
  assert.deepEqual(two.payTable, PICK6_PAYOUTS[2]);
  assert.equal(two.picks[0].line, 30.5);
  assert.equal(two.picks[0].fair, 'share');
  // a 5-pick table pays a 4-of-5 too; the sweep scales with the picks' multipliers
  const five = Array.from({ length: 5 }, (_, i) => mk(`P${i}`, `T${i}`, 10 + i));
  const c5 = new Map(five.map(p => [p, cell({ fair: 70, ev: 20 })]));
  c5.get(five[0]).under = 0.9; c5.get(five[0]).over = 0.9;
  const s5 = autoSlips(five, { now: NOW, pick6: c5 }).books.P6.find(s => s.legs === 5);
  assert.deepEqual(s5.payTable, { 5: 10.8, 4: 1 }, '12x x 0.9, the near miss as posted');
  assert.equal(s5.paysAll, 10.8);
  // the table the last read showed replaces slip.js'
  const live = autoSlips(picks, { now: NOW, pick6: cells, pick6Table: { 2: { 2: 3.5 }, 3: { 3: 6 } } }).books.P6.find(s => s.legs === 2);
  assert.equal(live.paysAll, 3.5);
});

test('a Pick6 leg that no Pinnacle-based price clears is no leg for an auto slip, and a slip keeps its side', () => {
  const weak = new Map(picks.map(p => [p, cell({ clears: false })]));
  assert.equal(autoSlips(picks, { now: NOW, pick6: weak }).books.P6?.length ?? 0, 0);
  assert.equal(bookLeg(picks[0], 'P6', { pick6: weak }).side, 'OVER', 'a person can still price it');
  assert.equal(bookLeg(picks[0], 'P6', { pick6: weak, side: 'UNDER' }), null);
  assert.equal(bookLeg(picks[0], 'P6', { pick6: new Map() }), null);
});
