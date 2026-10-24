const test = require('node:test');
const assert = require('node:assert');
const sp = require('../sportprops');
const { createSportTracker, THREE } = require('../sporttrack');
const { createMemoryStore } = require('../evtrack');
const { scoreboard, alertBooks } = require('../closeboard');
const results = require('../results');

const ev = (p, b, m) => (b === 'underdog' ? (p * m / 0.5623 - 1) * 100 : (p * m - 1) * 100);
const cell = (line, over = null, under = null) => ({ line, over, under, overOpen: true, underOpen: true });
const row = (books, mkey = 'rebounds') => ({ key: `NBA|x|${mkey}`, sport: 'NBA', player: 'X', mkey, market: 'Rebounds', startTime: new Date(Date.now() + 3600e3).toISOString(), books });
const q = (book, line, pOver) => ({ book, line, pOver });

test('three sharps: Pinnacle and two more at the app\'s own number', () => {
  const r = row({ prizepicks: cell(7.5) });
  const f = sp.threeSharpAt(r, 7.5, { sharp: [q('pinnacle', 7.5, 0.43), q('fanduel', 7.5, 0.44), q('betrivers', 8.5, 0.3)], kalshi: new Map([[7.5, 0.445]]) });
  assert.deepStrictEqual(f.sources.map(s => s.book), ['pinnacle', 'fanduel', 'kalshi'], 'BetRivers at 8.5 is another number');
  // without Pinnacle at the number: nothing, however many others agree
  assert.strictEqual(sp.threeSharpAt(r, 7.5, { sharp: [q('pinnacle', 6.5, 0.6), q('fanduel', 7.5, 0.44), q('betrivers', 7.5, 0.44)], kalshi: new Map([[7.5, 0.44]]) }), null);
  // Pinnacle and one other only
  assert.strictEqual(sp.threeSharpAt(r, 7.5, { sharp: [q('pinnacle', 7.5, 0.43), q('fanduel', 7.5, 0.44), q('draftkings', 7.5, 0.44)] }), null);
});

test('three sharps: yardage takes 2.5% of the line, counting stats none', () => {
  const y = row({ prizepicks: cell(60.5) }, 'rec_yds');
  assert.ok(sp.threeSharpAt(y, 60.5, { sharp: [q('pinnacle', 61.5, 0.45), q('fanduel', 60.5, 0.45), q('betrivers', 59.5, 0.46)] }));
  assert.strictEqual(sp.threeSharpAt(y, 60.5, { sharp: [q('pinnacle', 62.5, 0.4), q('fanduel', 60.5, 0.45), q('betrivers', 60.5, 0.46)] }), null);
  const c = row({ prizepicks: cell(4.5) }, 'receptions');
  assert.strictEqual(sp.threeSharpAt(c, 4.5, { sharp: [q('pinnacle', 5, 0.4), q('fanduel', 4.5, 0.45), q('betrivers', 4.5, 0.46)] }), null);
});

test('three sharps plays: every source past the app\'s break-even, or no play', () => {
  const r = row({ prizepicks: cell(7.5), underdog: cell(7.5, 1.0, 0.95) });
  // under 57%, 56.5%, 55.5%: all past PrizePicks' 55.03% (3-pick power)
  const sharp = [q('pinnacle', 7.5, 0.43), q('fanduel', 7.5, 0.435), q('betrivers', 7.5, 0.445)];
  const plays = sp.threeSharpPlays(r, { sharp, dfsEv: ev });
  const pp = plays.find(p => p.book === 'prizepicks');
  assert.strictEqual(pp.side, 'Under');
  assert.strictEqual(pp.fair, 0.57, 'the fair is Pinnacle\'s own price');
  assert.ok(pp.evMin < pp.ev && pp.evMin > 0);
  assert.strictEqual(pp.entry, '3-pick power');
  assert.ok(pp.entries.includes('6-pick flex') && pp.entries.includes('5-pick power') && !pp.entries.includes('2-pick power'));
  assert.strictEqual(pp.n, 3);
  // Underdog pays 0.95x on the under: 55.5% x 0.95 / 56.23% is under even
  assert.ok(!plays.some(p => p.book === 'underdog'));
  // one source short of break-even: no play at all
  assert.deepStrictEqual(sp.threeSharpPlays(r, { sharp: [q('pinnacle', 7.5, 0.43), q('fanduel', 7.5, 0.435), q('betrivers', 7.5, 0.455)], dfsEv: ev }), []);
  // esports and period stats are never priced here
  assert.deepStrictEqual(sp.threeSharpPlays({ ...r, esports: true }, { sharp, dfsEv: ev }), []);
});

test('three sharps close: Pinnacle\'s own price at the number, never a curve', () => {
  const r = row({ prizepicks: cell(7.5) });
  assert.strictEqual(sp.threeSharpClose(r, 7.5, [q('pinnacle', 7.5, 0.41), q('fanduel', 7.5, 0.3)]), 0.41);
  assert.strictEqual(sp.threeSharpClose(r, 7.5, [q('pinnacle', 8.5, 0.3)]), null, 'Pinnacle moved its number: no close');
});

test('three sharps record: own id and kind, out of the headline, own scoreboard row, never alerted', async () => {
  const store = createMemoryStore();
  let t = Date.parse('2026-10-24T18:00:00Z');
  const tr = createSportTracker({ store, now: () => t, log: { warn() {} } });
  const r = { ...row({ prizepicks: cell(7.5) }), startTime: '2026-10-24T23:00:00Z' };
  const sharp = [q('pinnacle', 7.5, 0.43), q('fanduel', 7.5, 0.435), q('betrivers', 7.5, 0.445)];
  const [p] = sp.threeSharpPlays(r, { sharp, dfsEv: ev });
  const fair = { v: 0.43 };
  const fairAt = (rw, b, line, kind) => (kind === 'sharp3' ? sp.threeSharpClose(rw, line, [q('pinnacle', 7.5, fair.v)]) : 0.5);
  await tr.record({ rows: [r], flagged: [{ row: r, play: p, kind: 'sharp3' }, { row: r, play: { ...p, evMin: undefined }, kind: 'sharp' }], fairAt, updated: {} });
  const all = await store.all();
  assert.strictEqual(all.length, 2, 'the same leg sits in both records');
  const b = all.find(x => x.kind === 'sharp3');
  assert.ok(b.id.endsWith('|sharp3'));
  assert.strictEqual(b.evMin, p.evMin);
  assert.deepStrictEqual(b.entries, p.entries);
  // Pinnacle's price at the number moves to 40% over (60% under) by the start
  fair.v = 0.40; t = Date.parse('2026-10-24T22:30:00Z');
  await tr.record({ rows: [r], flagged: [], fairAt, updated: {} });
  t = Date.parse('2026-10-24T23:01:00Z');
  await tr.record({ rows: [r], flagged: [], fairAt, updated: {} });
  const locked = (await store.all()).find(x => x.kind === 'sharp3');
  assert.strictEqual(locked.closeFair, 0.6);
  assert.ok(locked.closeOk);
  const sum = await tr.summary();
  assert.strictEqual(sum.overall.signals, 1, 'only the consensus leg counts in the headline');
  assert.strictEqual(sum.byKind.sharp3.signals, 1);
  assert.ok(THREE.has('p6-sharp3'));
  const board = scoreboard({ props: await store.all() });
  const row3 = board.rows.find(x => x.kind === 'props-sharp3');
  assert.strictEqual(row3.kindLabel, "Pick'em vs three sharps (Pinnacle + 2)");
  assert.notStrictEqual(row3.mark, 'proven');
  assert.strictEqual(alertBooks(board).size, 0);
  // not pooled into the sports props verdict
  const res = results.scoreboard({ sportsProps: await store.all() });
  assert.ok(!(res.plays || []).some(x => /three/i.test(x.play || '')));
});
