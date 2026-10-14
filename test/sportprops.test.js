const test = require('node:test');
const assert = require('node:assert');
const sp = require('../sportprops');
const { createSportTracker, legDecimal } = require('../sporttrack');
const { createMemoryStore } = require('../evtrack');

const ev = (p, b, m) => (b === 'prizepicks' ? (p / 0.5622 - 1) * 100 : b === 'underdog' ? (p * m / 0.5623 - 1) * 100 : (p * m - 1) * 100);
const cell = (line, over = null, under = null) => ({ line, over, under, overOpen: true, underOpen: true });
const row = (books, extra = {}) => ({ key: 'NFL|x|rec_yds', sport: 'NFL', player: 'X', mkey: 'rec_yds', market: 'Receiving Yards', startTime: new Date(Date.now() + 3600e3).toISOString(), books, ...extra });

test('a book reads as its median, payouts tilting it', () => {
  assert.strictEqual(sp.bookPOver('prizepicks', cell(50.5)), 0.5);
  assert.strictEqual(sp.bookPOver('underdog', cell(50.5, 1, 1)), 0.5);
  assert.ok(sp.bookPOver('underdog', cell(50.5, 0.9, 1.1)) > 0.5);   // the over pays less: it's likelier
  assert.ok(Math.abs(sp.bookPOver('sleeper', cell(50.5, 1.6, 2.2)) - 0.579) < 0.001);
  assert.strictEqual(sp.bookPOver('sleeper', { ...cell(50.5, 1.8, 1.9), underOpen: false }), null);
});

test('curve and inverse agree, and the curve falls with the line', () => {
  for (const [m, l] of [['rec_yds', 54.5], ['receptions', 4.5], ['points', 22.5], ['strikeouts', 5.5]]) {
    const mean = sp.meanFor(m, 'NFL', l, 0.6);
    assert.ok(Math.abs(sp.pOver(m, 'NFL', mean, l) - 0.6) < 1e-4, m);
    assert.ok(sp.pOver(m, 'NFL', mean, l + 2) < 0.6);
  }
});

test('the odd book out is the soft side, priced on the others', () => {
  const plays = sp.rowPlays(row({ prizepicks: cell(54.5), underdog: cell(48.5, 1, 1), sleeper: cell(54.5, 1.85, 1.85) }), { dfsEv: ev });
  const best = plays[0];
  assert.strictEqual(best.book, 'underdog');
  assert.strictEqual(best.side, 'Over');
  assert.ok(best.fair > 0.58 && best.ev > 2);
  assert.ok(best.gap.probPts >= 8);
  assert.deepStrictEqual(best.gap.vs.map(v => v.book).sort(), ['prizepicks', 'sleeper']);
  assert.strictEqual(sp.playKind(best), 'gap');
  // books that agree have no gap, and with no Kalshi there's no play
  const flat = sp.rowPlays(row({ prizepicks: cell(54.5), underdog: cell(54.5, 1, 1) }), { dfsEv: ev });
  assert.ok(flat.every(p => !p.gap && sp.playKind(p) == null));
  // two books apart: either could be the soft one, so neither is a play
  const two = sp.rowPlays(row({ prizepicks: cell(54.5), underdog: cell(48.5, 1, 1) }), { dfsEv: ev });
  assert.ok(two.length && two.every(p => sp.playKind(p) == null));
});

test("Kalshi's own price at a line counts as two books", () => {
  const r = row({ prizepicks: cell(54.5) });
  const f = sp.fairFor(r, 'prizepicks', 54.5, { kalshi: new Map([[54.5, 0.62]]) });
  assert.ok(Math.abs(f.p - 0.62) < 1e-3);
  const plays = sp.rowPlays(r, { kalshi: new Map([[54.5, 0.62]]), dfsEv: ev });
  assert.strictEqual(plays[0].side, 'Over');
  assert.strictEqual(sp.playKind(plays[0]), 'ev');
});

test('the record checks the line two minutes on, freezes the close and grades', async () => {
  let t = Date.parse('2026-10-14T12:00:00Z');
  const start = new Date(t + 3600e3).toISOString();
  const grades = { calls: 0 };
  const grader = { grade: async () => { grades.calls++; return { result: 61, outcome: 'win', eventId: '1' }; } };
  const tr = createSportTracker({ store: createMemoryStore(), grader, now: () => t });
  const r = row({ prizepicks: cell(54.5), sleeper: cell(54.5, 1.85, 1.85), underdog: cell(48.5, 1, 1) }, { startTime: start });
  const play = sp.rowPlays(r, { dfsEv: ev })[0];
  await tr.record({ rows: [r], flagged: [{ row: r, play, kind: 'gap' }], updated: { underdog: new Date(t).toISOString() } });
  t += 60e3;   // a read inside two minutes doesn't count
  await tr.record({ rows: [r], updated: { underdog: new Date(t).toISOString() } });
  let [b] = await tr.list();
  assert.strictEqual(b.execOk, undefined);
  t += 90e3;   // Underdog fixed its number: gone before anyone could take it... no, still there
  await tr.record({ rows: [r], updated: { underdog: new Date(t).toISOString() } });
  [b] = await tr.list();
  assert.strictEqual(b.execOk, true);
  const moved = row({ prizepicks: cell(54.5), sleeper: cell(54.5, 1.85, 1.85), underdog: cell(53.5, 1, 1) }, { startTime: start });
  t += 60e3;
  await tr.record({ rows: [moved], fairAt: (rw, book, line) => sp.fairFor(rw, book, line).p, updated: { underdog: new Date(t).toISOString() } });
  t = Date.parse(start) + 60e3;
  await tr.record({ rows: [moved] });
  [b] = await tr.list();
  assert.strictEqual(b.status, 'locked');
  assert.strictEqual(b.gapOutcome, 'caught');
  assert.ok(b.closeEv > 0);
  t += 4 * 3600e3;
  assert.deepStrictEqual(await tr.grade(), { graded: 1, voided: 0 });
  [b] = await tr.list();
  assert.strictEqual(b.outcome, 'win');
  assert.strictEqual(b.profit, +(legDecimal('underdog', 1) - 1).toFixed(4));
  const s = await tr.summary();
  assert.strictEqual(s.overall.graded, 1);
  assert.strictEqual(s.overall.execGraded, 1);
  assert.strictEqual(s.byKind.gap.wins, 1);
});
