const test = require('node:test');
const assert = require('node:assert');
const sp = require('../sportprops');
const { createSportTracker, COMBO } = require('../sporttrack');
const { createMemoryStore } = require('../evtrack');
const { scoreboard, alertBooks } = require('../closeboard');
const results = require('../results');

// Sleeper: p x its own multiplier
const ev = (p, b, m) => (p * m - 1) * 100;
const cell = (line, over = null, under = null) => ({ line, over, under, overOpen: true, underOpen: true });
const row = (books, mkey = 'pts_rebs') => ({ key: `NBA|x|${mkey}`, sport: 'NBA', player: 'X', mkey, market: 'Points + Rebounds', startTime: new Date(Date.now() + 3600e3).toISOString(), books });
const q = (book, line, pOver) => ({ book, line, pOver });

test('composed price: Pinnacle\'s parts add up as means on their curves', () => {
  const r = row({ sleeper: cell(30.5, 1.8, 1.8) });
  const parts = { points: [q('pinnacle', 21.5, 0.5)], rebounds: [q('pinnacle', 8.5, 0.5), q('pinnacle', 6.5, 0.8)] };
  const c = sp.composedAt(r, 30.5, parts);
  // the main (nearest even) line of each part
  assert.deepStrictEqual(c.parts.map(x => x.line), [21.5, 8.5]);
  const m = sp.meanFor('points', 'NBA', 21.5, 0.5) + sp.meanFor('rebounds', 'NBA', 8.5, 0.5);
  assert.ok(Math.abs(c.mean - m) < 0.01);
  assert.ok(Math.abs(c.p - 0.5) < 0.06, 'two medians add to about the combo\'s median');
  assert.ok(sp.composedAt(r, 33.5, parts).p < c.p);
  // a part Pinnacle doesn't post: nothing
  assert.strictEqual(sp.composedAt(r, 30.5, { points: parts.points, rebounds: [] }), null);
  assert.strictEqual(sp.composedAt({ ...r, mkey: 'points' }, 30.5, parts), null);
});

test('combo sources: books at the exact number, Pinnacle direct or its parts, one book needed', () => {
  const r = row({ sleeper: cell(30.5, 1.8, 1.8) });
  const parts = { points: [q('pinnacle', 21.5, 0.45)], rebounds: [q('pinnacle', 8.5, 0.45)] };
  const f = sp.comboAt(r, 30.5, { sharp: [q('fanduel', 30.5, 0.42), q('betrivers', 31.5, 0.3)], parts });
  assert.deepStrictEqual(f.sources.map(s => s.book), ['fanduel', 'pinnacle-parts'], 'BetRivers at 31.5 is another number');
  assert.strictEqual(f.books, 1);
  // Pinnacle's own combo at the number replaces its parts
  const g = sp.comboAt(r, 30.5, { sharp: [q('fanduel', 30.5, 0.42), q('pinnacle', 30.5, 0.43)], parts });
  assert.deepStrictEqual(g.sources.map(s => s.book), ['fanduel', 'pinnacle']);
  // Pinnacle's parts alone: no book read direct, no price
  assert.strictEqual(sp.comboAt(r, 30.5, { sharp: [], parts }), null);
  // books too far apart: two different markets, no price
  assert.strictEqual(sp.comboAt(r, 30.5, { sharp: [q('fanduel', 30.5, 0.30), q('betrivers', 30.5, 0.45)] }), null);
  // both books, no Pinnacle: fine
  assert.strictEqual(sp.comboAt(r, 30.5, { sharp: [q('fanduel', 30.5, 0.42), q('betrivers', 30.5, 0.44)] }).n, 2);
  // one book alone: nothing
  assert.strictEqual(sp.comboAt(r, 30.5, { sharp: [q('fanduel', 30.5, 0.42)] }), null);
});

test('combo plays: every source past Sleeper\'s break-even at its own multiplier', () => {
  const r = row({ sleeper: cell(30.5, 2.0, 1.78) });
  // under 58%, 57%: Sleeper's 1.78 under needs 56.2%
  const sharp = [q('fanduel', 30.5, 0.42), q('betrivers', 30.5, 0.43)];
  const plays = sp.comboPlays(r, { sharp, dfsEv: ev });
  assert.strictEqual(plays.length, 1);
  const p = plays[0];
  assert.strictEqual(p.side, 'Under');
  assert.strictEqual(p.fair, 0.575);
  assert.ok(p.evMin > 0 && p.evMin < p.ev);
  // one book short of break-even (55.5% under): no play
  assert.deepStrictEqual(sp.comboPlays(r, { sharp: [q('fanduel', 30.5, 0.42), q('betrivers', 30.5, 0.445)], dfsEv: ev }), []);
  // not a combo stat, or esports: never priced here
  assert.deepStrictEqual(sp.comboPlays({ ...r, mkey: 'points' }, { sharp, dfsEv: ev }), []);
  assert.deepStrictEqual(sp.comboPlays({ ...r, esports: true }, { sharp, dfsEv: ev }), []);
  // PrizePicks' fixed table prices a combo too (3-pick power, 55.03%)
  const pp = sp.comboPlays(row({ prizepicks: cell(30.5) }), { sharp, dfsEv: ev });
  assert.strictEqual(pp[0].entry, '3-pick power');
});

test('combo close keeps every source; record: own id, out of the headline, never alerted', async () => {
  const store = createMemoryStore();
  let t = Date.parse('2026-10-24T18:00:00Z');
  const tr = createSportTracker({ store, now: () => t, log: { warn() {} } });
  const r = { ...row({ sleeper: cell(30.5, 2.0, 1.78) }), startTime: '2026-10-24T23:00:00Z' };
  const mk = { fd: 0.42, br: 0.43 };
  const sharpNow = () => [q('fanduel', 30.5, mk.fd), q('betrivers', 30.5, mk.br)];
  const [p] = sp.comboPlays(r, { sharp: sharpNow(), dfsEv: ev });
  const fairAt = (rw, b, line, kind) => (kind === 'combo' ? sp.comboClose(rw, line, { sharp: sharpNow() })?.p ?? null : 0.5);
  const sourcesAt = (rw, line) => sp.comboClose(rw, line, { sharp: sharpNow() })?.sources ?? null;
  await tr.record({ rows: [r], flagged: [{ row: r, play: p, kind: 'combo' }, { row: r, play: p, kind: 'book-fair' }], fairAt, sourcesAt, updated: {} });
  const b = (await store.all()).find(x => x.kind === 'combo');
  assert.ok(b.id.endsWith('|combo'));
  assert.strictEqual(b.evMin, p.evMin);
  assert.strictEqual(b.comboBooks, 2);
  // the books move to 40% / 41% over by the start
  mk.fd = 0.40; mk.br = 0.41; t = Date.parse('2026-10-24T22:30:00Z');
  await tr.record({ rows: [r], flagged: [], fairAt, sourcesAt, updated: {} });
  t = Date.parse('2026-10-24T23:01:00Z');
  await tr.record({ rows: [r], flagged: [], fairAt, sourcesAt, updated: {} });
  const L = (await store.all()).find(x => x.kind === 'combo');
  assert.strictEqual(L.closeFair, 0.595);
  assert.deepStrictEqual(L.closeSources, { fanduel: 0.6, betrivers: 0.59 });
  assert.strictEqual(L.closeSourceEv.betrivers, +((0.59 * 1.78 - 1) * 100).toFixed(2));
  assert.strictEqual(L.closeEvMin, L.closeSourceEv.betrivers);
  const sum = await tr.summary();
  assert.ok(!sum.overall.signals, 'combo legs never count in the headline');
  assert.strictEqual(sum.byKind.combo.signals, 1);
  assert.ok(COMBO.has('p6-combo'));
  const board = scoreboard({ props: await store.all() });
  const cr = board.rows.find(x => x.kind === 'props-combo');
  assert.strictEqual(cr.kindLabel, "Pick'em combos vs the books + Pinnacle's parts");
  assert.notStrictEqual(cr.mark, 'proven');
  assert.strictEqual(alertBooks(board).size, 0);
  const res = results.scoreboard({ sportsProps: await store.all() });
  assert.ok(!(res.plays || []).some(x => /combo/i.test(x.play || '')));
});

test('a Pick6 leg pays at the 3-pick entry of the table Pick6 shows now', () => {
  const { legDecimal } = require('../sporttrack');
  sp.setPick6Payouts({ 3: { 3: 6 } });
  assert.ok(Math.abs(legDecimal('pick6', 1) - 1.8171) < 0.001);
  sp.setPick6Payouts({ 2: { 2: 3 }, 3: { 3: 5.5 } });
  assert.ok(Math.abs(legDecimal('pick6', 0.9) - 0.9 * 5.5 ** (1 / 3)) < 0.002);
  sp.setPick6Payouts(null);
});
