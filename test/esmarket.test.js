const test = require('node:test');
const assert = require('node:assert');
const { bookOverShare, impliedMean, consensus, modelWeights, blend } = require('../esmarket');
const { normalCdf } = require('../dist');

// a plain normal curve with sd 4: P(over L | mean m), line at the median
const curve = (line, m) => 1 - normalCdf(line, m, 4);

test('book quotes: vig comes out, PrizePicks is the median', () => {
  assert.deepStrictEqual(bookOverShare({ book: 'PP', line: 25 }), { pOver: 0.5, weight: 1 });
  const ud = bookOverShare({ book: 'UD', line: 25, over: 0.87, under: 1.09 });
  assert.ok(ud.pOver > 0.55 && ud.pOver < 0.56, ud.pOver);   // UD pays less on the side it expects
  assert.strictEqual(ud.weight, 1.5);
  assert.strictEqual(bookOverShare({ book: 'UD', line: 25, over: 1, under: 1 }).weight, 1);
  const sl = bookOverShare({ book: 'SL', line: 25, over: 1.64, under: 1.95 });
  assert.ok(Math.abs(sl.pOver - 0.543) < 0.002, sl.pOver);
  // one-sided Underdog: the shut side is the one it expects
  const one = bookOverShare({ book: 'UD', line: 3.5, over: 1.1, under: null, overOpen: true, underOpen: false });
  assert.ok(one.pOver < 0.47, one.pOver);
  assert.strictEqual(bookOverShare({ book: 'SL', line: 10, over: 1.8, under: null, underOpen: false }), null);
});

test('implied mean inverts the curve', () => {
  assert.ok(Math.abs(impliedMean(25, 0.5, curve) - 25) < 0.02);
  const m = impliedMean(25, 0.6, curve);
  assert.ok(Math.abs(curve(25, m) - 0.6) < 0.002);
  assert.ok(m > 25);
});

test('consensus weights the books and leaves out a stray line', () => {
  const c = consensus([
    { book: 'PP', line: 25 },
    { book: 'UD', line: 25.5, over: 1, under: 1 },
    { book: 'SL', line: 25.5, over: 2.06, under: 1.56 },     // Sleeper leans under
  ], curve);
  assert.ok(c.mean > 24.5 && c.mean < 25.5, c.mean);
  assert.strictEqual(c.quotes.filter(q => q.dropped).length, 0);
  const stray = consensus([{ book: 'PP', line: 25 }, { book: 'UD', line: 25.5, over: 1, under: 1 }, { book: 'SL', line: 40.5, over: 1.78, under: 1.78 }], curve);
  assert.strictEqual(stray.quotes.find(q => q.book === 'SL').dropped, true);
  assert.ok(stray.mean < 26);
  assert.strictEqual(consensus([], curve), null);
});

test('model weight is earned from the record, never negative', () => {
  const row = (sport, stat, line, raw, result) => ({ status: 'graded', sport, stat, signalLine: line, rawPred: raw, result });
  const rows = [];
  // CS kills: the model's lean ran backwards
  for (let i = 0; i < 30; i++) rows.push(row('CS', 'kills', 27.5, i % 2 ? 30 : 25, i % 2 ? 22 : 33));
  // LoL kills: the model's lean showed up in full
  for (let i = 0; i < 200; i++) rows.push(row('LOL', 'kills', 10.5, i % 2 ? 12.5 : 8.5, i % 2 ? 12.5 : 8.5));
  const w = modelWeights(rows);
  assert.strictEqual(w.weight('CS', 'kills'), 0);
  assert.ok(w.weight('LOL', 'kills') > 0.4, w.weight('LOL', 'kills'));
  assert.strictEqual(w.weight('VAL', 'kills'), 0.15);   // unseen: the prior
});

test('blend nudges the market by the weight', () => {
  assert.strictEqual(blend(25, 30, 0.2), 26);
  assert.strictEqual(blend(25, null, 0.2), 25);
  assert.strictEqual(blend(null, 30, 0.2), null);
});

test('line bias: shrunk toward 0, capped, and moves the consensus', () => {
  const { lineBias } = require('../esmarket');
  const rows = [];
  for (let i = 0; i < 40; i++) rows.push({ status: 'graded', sport: 'CS', stat: 'headshots', signalBook: 'UD', signalLine: 10, result: 8.4 });
  const b = lineBias(rows);
  assert.ok(Math.abs(b.bias('CS', 'headshots', 'UD') + 0.08) < 1e-9);   // −16% over 40 picks, prior 40
  assert.strictEqual(b.bias('CS', 'headshots', 'PP'), 0);
  const big = lineBias(rows.concat(rows).concat(rows).map(r => ({ ...r, result: 0 })));
  assert.strictEqual(big.bias('CS', 'headshots', 'UD'), -0.1);   // capped at 10%
  const c = consensus([{ book: 'UD', line: 12.5, over: 1, under: 1, bias: -0.08 }], curve);
  assert.ok(Math.abs(c.mean - 11.5) < 0.02, c.mean);
});
