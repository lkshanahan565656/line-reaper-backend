const test = require('node:test');
const assert = require('node:assert');
const AS = require('../appshop');

const cell = (line, over = null, under = null, o = {}) => ({ line, over, under, overOpen: o.overOpen !== false, underOpen: o.underOpen !== false });
const FUTURE = new Date(Date.now() + 6 * 3600e3).toISOString();

test('softest number per side: lowest line for the Over, highest for the Under, gap to the nearest other app', () => {
  const s = AS.softest({ prizepicks: cell(47.5), underdog: cell(49.5, 1, 1), sleeper: cell(48.5, 1.78, 1.78) });
  const over = s.find(x => x.side === 'Over'), under = s.find(x => x.side === 'Under');
  assert.strictEqual(over.app, 'prizepicks');
  assert.strictEqual(over.line, 47.5);
  assert.strictEqual(over.gap, 1);
  assert.deepStrictEqual(over.nearest, { app: 'sleeper', line: 48.5 });
  assert.strictEqual(under.app, 'underdog');
  assert.strictEqual(under.line, 49.5);
  assert.strictEqual(under.gap, 1);
});

test('all apps at one number is no shop; a closed side does not count', () => {
  assert.deepStrictEqual(AS.softest({ prizepicks: cell(20.5), underdog: cell(20.5, 1, 1) }), []);
  const s = AS.softest({ prizepicks: cell(20.5), underdog: cell(22.5, 1, 1, { underOpen: false }) });
  // the Under: only PrizePicks has it open, so one app, nothing to shop
  assert.deepStrictEqual(s.map(x => x.side), ['Over']);
});

test('a tie at the softest number goes to the lowest break-even (PrizePicks 55.03% before Underdog 56.23%)', () => {
  const s = AS.softest({ underdog: cell(47.5, 1, 1), prizepicks: cell(47.5), sleeper: cell(49.5, 1.78, 1.78) });
  const over = s.find(x => x.side === 'Over');
  assert.strictEqual(over.app, 'prizepicks');
  assert.deepStrictEqual(over.tied.sort(), ['prizepicks', 'underdog']);
  assert.strictEqual(over.be, 0.5503);
  // P1 takes PrizePicks, P3 the same leg; P2 nothing (no Pick6 here)
  const books = { underdog: cell(47.5, 1, 1), prizepicks: cell(47.5), sleeper: cell(49.5, 1.78, 1.78) };
  assert.strictEqual(AS.kindLeg('shop-pp', over, books).app, 'prizepicks');
  assert.strictEqual(AS.kindLeg('shop-any', over, books).app, 'prizepicks');
  assert.strictEqual(AS.kindLeg('shop-p6', over, books), null);
});

test('judged kinds need a full line of gap', () => {
  const books = { prizepicks: cell(5.5), underdog: cell(6, 1, 1) };
  const over = AS.softest(books).find(x => x.side === 'Over');
  assert.strictEqual(over.gap, 0.5);
  assert.strictEqual(AS.kindLeg('shop-pp', over, books), null);
  assert.strictEqual(AS.kindLeg('shop-pp', over, books, { minGap: 0.5 }).app, 'prizepicks');
});

test('break-evens at each app\'s real payout', () => {
  assert.strictEqual(+AS.breakEven('prizepicks', 'Over', cell(10.5)).toFixed(4), 0.5503);
  assert.strictEqual(+AS.breakEven('sleeper', 'Under', cell(10.5, 1.9, 1.8)).toFixed(4), +(1 / 1.8).toFixed(4));
  assert.strictEqual(+AS.breakEven('underdog', 'Over', cell(10.5, 1.06, 0.9)).toFixed(4), +(0.5623 / 1.06).toFixed(4));
  assert.strictEqual(AS.breakEven('underdog', 'Over', cell(10.5, 1, 1, { overOpen: false })), null);
});

test('middles: Over low, Under high, expected units from the curve, only above zero', () => {
  const books = { prizepicks: cell(0.5), underdog: cell(4.5, 1, 1) };
  // rec_yds with a mean near 2.5: a 0.5 Over and a 4.5 Under both likely
  const curve = AS.curveFor('rec_yds', 'NFL', { lines: [0.5, 4.5] });
  assert.ok(curve && curve.source === 'apps');
  const m = AS.middles(books, curve);
  assert.strictEqual(m.length, 1);
  assert.strictEqual(m[0].over.app, 'prizepicks');
  assert.strictEqual(m[0].under.app, 'underdog');
  assert.strictEqual(m[0].width, 4);
  const exp = m[0].over.p / m[0].over.be + m[0].under.p / m[0].under.be - 2;
  assert.ok(Math.abs(m[0].expUnits - exp) < 1e-3);
  assert.ok(m[0].expUnits > 0);
  // a 1-yard window on a 60-yard stat is worth less than zero: not listed
  const wide = AS.middles({ prizepicks: cell(59.5), underdog: cell(60.5, 1, 1) }, AS.curveFor('rec_yds', 'NFL', { lines: [59.5, 60.5] }));
  assert.deepStrictEqual(wide, []);
});

test('no curve for a stat without a fitted spread (fantasy score)', () => {
  assert.strictEqual(AS.curveFor('fantasy_points', 'NFL', { lines: [10.5, 14.5] }), null);
  assert.ok(AS.curveFor('fantasy_points', 'NFL', { lines: [10.5, 14.5], anyStat: true }));
});

test('middle outcome: both legs win strictly inside the window', () => {
  const m = { over: { line: 0.5, be: 0.5503 }, under: { line: 4.5, be: 0.5623 } };
  assert.strictEqual(AS.middleOutcome(m, 3).result, 'both');
  assert.strictEqual(AS.middleOutcome(m, 0).result, 'one');
  assert.strictEqual(AS.middleOutcome(m, 9).result, 'one');
  assert.ok(Math.abs(AS.middleOutcome(m, 3).units - (1 / 0.5503 - 1 + 1 / 0.5623 - 1)) < 1e-3);
});

test('shopRows: sorted by gap, sharp fair and EV on the softest leg, record legs per kind', () => {
  const rows = [
    { key: 'NFL|a|rec_yds', sport: 'NFL', player: 'A', mkey: 'rec_yds', market: 'Receiving Yards', startTime: FUTURE, books: { prizepicks: cell(47.5), underdog: cell(49.5, 1, 1) } },
    { key: 'NFL|b|rush_yds', sport: 'NFL', player: 'B', mkey: 'rush_yds', market: 'Rushing Yards', startTime: FUTURE, books: { prizepicks: cell(60.5), sleeper: cell(66.5, 1.78, 1.78) } },
    { key: 'NFL|c|rush_yds', sport: 'NFL', player: 'C', mkey: 'rush_yds', market: 'Rushing Yards', startTime: FUTURE, books: { prizepicks: cell(60.5), sleeper: cell(60.5, 1.78, 1.78) } },
    { key: 'LOL|d|kills', sport: 'LOL', esports: true, player: 'D', mkey: 'kills', startTime: FUTURE, books: { prizepicks: cell(3.5), underdog: cell(5.5, 1, 1) } },
    { key: 'NFL|e|rec_yds', sport: 'NFL', player: 'E', mkey: 'rec_yds', startTime: new Date(Date.now() - 60e3).toISOString(), books: { prizepicks: cell(10.5), underdog: cell(20.5, 1, 1) } },
  ];
  const sharpAt = (row, line) => (row.player === 'A' ? { p: 0.52 - (line - 47.5) * 0.01, source: 'sharp' } : null);
  const evOf = (p, app) => (app === 'prizepicks' ? (p / 0.5503 - 1) * 100 : (p / 0.5623 - 1) * 100);
  const out = AS.shopRows(rows, { sharpAt, evOf });
  assert.deepStrictEqual(out.map(r => r.player), ['B', 'A']);   // C agrees, D esports, E started
  const a = out[1], over = a.sides.find(s => s.side === 'Over');
  assert.strictEqual(over.app, 'prizepicks');
  assert.strictEqual(over.fair, 52);
  assert.ok(Math.abs(over.ev - (0.52 / 0.5503 - 1) * 100) < 0.01);
  const legs = AS.recordLegs(out);
  assert.ok(legs.every(l => AS.RECORD_KINDS.includes(l.kind)));
  assert.strictEqual(legs.filter(l => l.kind === 'shop-any').length, 4);
  const pp = legs.find(l => l.kind === 'shop-any' && l.play.book === 'prizepicks' && l.rowKey === 'NFL|a|rec_yds');
  assert.strictEqual(pp.play.decimal, +(1 / 0.5503).toFixed(4));
  // free tier: numbers and the gap stay, the fair, EV and middles go
  const red = AS.redactShop(a);
  assert.strictEqual(red.sides[0].fair, null);
  assert.strictEqual(red.sides[0].ev, null);
  assert.strictEqual(red.gap, a.gap);
});

test('recordSummary: P1 counts shop-pp and the shop-any legs on PrizePicks; middles pair up', () => {
  const leg = (kind, book, outcome, o = {}) => ({ kind, book, outcome, status: 'graded', signalDecimal: 1 / 0.5503, signalSide: 'Over', signalLine: 1.5, sport: 'NFL', player: 'X', mkey: 'receptions', start: '2026-10-25T17:00:00Z', signalAt: '2026-10-25T16:00:00Z', ...o });
  const legs = [leg('shop-pp', 'prizepicks', 'win'), leg('shop-any', 'prizepicks', 'loss'), leg('shop-any', 'underdog', 'win', { signalDecimal: 1 / 0.5623 }),
    leg('shop-mid', 'prizepicks', 'win', { gapVs: [{ book: 'UD', line: 4.5 }] }), leg('shop-mid', 'underdog', 'win', { signalSide: 'Under', signalLine: 4.5, signalDecimal: 1 / 0.5623, gapVs: [{ book: 'PP', line: 1.5 }] })];
  const s = AS.recordSummary(legs);
  assert.strictEqual(s.P1.n, 2);
  assert.strictEqual(s.P3.n, 2);
  assert.strictEqual(s.P1.bar, '2 of 50 graded');
  assert.strictEqual(s.middles.n, 1);
  assert.strictEqual(s.middles.both, 1);
});
