const test = require('node:test');
const assert = require('node:assert');
const pin = require('../pinprops');
const sp = require('../sportprops');
const fx = require('./fixtures/pinnacle-props.json');
const before = Date.parse('2026-10-14T00:00:00Z');

test('descriptions name the player and the stat', () => {
  assert.deepStrictEqual(pin.parseDescription('C.J. Stroud Total Pass Completions'), { player: 'C.J. Stroud', mkey: 'pass_comp' });
  assert.deepStrictEqual(pin.parseDescription('Jayson Tatum Total Pts & Rebs & Asts'), { player: 'Jayson Tatum', mkey: 'pra' });
  assert.deepStrictEqual(pin.parseDescription('Tommy Edman Total Bases'), { player: 'Tommy Edman', mkey: 'total_bases' });
  assert.strictEqual(pin.parseDescription('Team to make playoffs'), null);
});

test('power devig gives the longshot less', () => {
  const p = pin.devigPower(100 / 214, 148 / 248);   // +114 / -148
  assert.ok(p > 0.43 && p < 0.47);
  assert.ok(Math.abs(pin.devigPower(0.5238, 0.5238) - 0.5) < 1e-6);
});

test('a saved Pinnacle response parses into board-keyed quotes', () => {
  const nfl = pin.parseLeague('NFL', fx.NFL.matchups, fx.NFL.markets, before);
  assert.ok(nfl.length >= 4);
  const s = nfl.find(p => p.player === 'Dalton Schultz');
  assert.strictEqual(s.key, 'NFL|daltonschultz|receptions');
  assert.strictEqual(s.line, 3.5);
  assert.ok(s.pOver > 0.45 && s.pOver < 0.48, String(s.pOver));   // Over -100 / Under -132: the under is the favourite
  // started games are dropped
  assert.strictEqual(pin.parseLeague('NFL', fx.NFL.matchups, fx.NFL.markets, Date.parse('2030-01-01')).length, 0);
  for (const k of ['NBA', 'NHL', 'MLB']) assert.ok(pin.parseLeague(k, fx[k].matchups, fx[k].markets, before).length > 0, k);
});

test("Pinnacle's price counts as three books and makes a play on its own", () => {
  const row = { sport: 'NFL', mkey: 'receptions', books: { prizepicks: { line: 3.5, overOpen: true, underOpen: true } } };
  const ev = (p, b) => (p / 0.5622 - 1) * 100;
  const plays = sp.rowPlays(row, { pin: { line: 3.5, pOver: 0.62 }, dfsEv: ev });
  assert.strictEqual(plays[0].side, 'Over');
  assert.ok(Math.abs(plays[0].fair - 0.62) < 1e-3);
  assert.strictEqual(sp.playKind(plays[0]), 'ev');
  // a book line off Pinnacle's reads through the curve
  const off = sp.fairFor({ ...row, books: { prizepicks: { line: 4.5, overOpen: true, underOpen: true } } }, 'prizepicks', 4.5, { pin: { line: 3.5, pOver: 0.62 } });
  assert.ok(off.p < 0.5 && off.p > 0.4);
});

test('a Pinnacle quote only prices the same game', () => {
  const q = (start, line) => ({ key: 'NBA|jaysontatum|points', line, pOver: 0.51, start });
  const idx = pin.indexProps([q('2026-10-20T19:00:00Z', 26.5), q('2026-10-14T23:30:00Z', 18.5)]);
  const row = t => ({ key: 'NBA|jaysontatum|points', startTime: t });
  assert.equal(pin.quoteFor(idx, row('2026-10-14T19:30:00.000-04:00')).line, 18.5);
  assert.equal(pin.quoteFor(idx, row('2026-10-20T15:00:00.000-04:00')).line, 26.5);
  // tonight's preseason game, Pinnacle only up for opening night: no quote
  const only = pin.indexProps([q('2026-10-20T19:00:00Z', 26.5)]);
  assert.equal(pin.quoteFor(only, row('2026-10-14T19:30:00.000-04:00')), null);
  assert.equal(pin.quoteFor(only, row('')), null);
});

test('a gap too wide to be one game is never a play', () => {
  const dfsEv = (p, book) => (book === 'prizepicks' ? (p / 0.5622 - 1) * 100 : (p * 1.8 - 1) * 100);
  const row = { sport: 'NBA', mkey: 'points', player: 'Jayson Tatum', books: {
    prizepicks: { line: 17.5, over: null, under: null, overOpen: true, underOpen: true },
    sleeper: { line: 26.5, over: 1.8, under: 1.76, overOpen: true, underOpen: true } } };
  const plays = sp.rowPlays(row, { pin: { line: 26.5, pOver: 0.513 }, dfsEv });
  const top = plays[0];
  assert.equal(top.book, 'prizepicks');
  assert.ok(top.gap.probPts > 25);
  assert.equal(sp.playKind(top), null);
  assert.deepEqual(sp.researchGap(plays), []);
});
