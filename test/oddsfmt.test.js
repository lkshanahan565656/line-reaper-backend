// Odds format (public/index.html, LROddsFmt): CUSTOMIZE > Odds format turns
// every price into the viewer's format at the last step. The block is pure,
// so it runs here on its own and is checked against oddsschema.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const schema = require('../oddsschema');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const block = html.match(/^\/\/ LR_ODDSFMT_BEGIN\n([\s\S]*?)^\/\/ LR_ODDSFMT_END$/m)[1];
const F = vm.runInNewContext(`${block}\nLROddsFmt`, {});

test('the four main formats and the three more match oddsschema.js', () => {
  assert.deepEqual([...F.FORMATS], schema.FORMATS);
  assert.deepEqual([...F.MAIN], ['american', 'decimal', 'fractional', 'probability']);
  for (const d of [1.01, 1.5, 1.909090909, 1.95, 2, 2.1, 2.5, 3.75, 11, 101]) {
    for (const f of ['american', 'fractional', 'probability']) assert.equal(F.fromDec(d, f), schema.formatOdds(d, f), `${d} ${f}`);
    for (const f of ['decimal', 'hongkong', 'indonesian', 'malay']) assert.equal(Number(F.fromDec(d, f)), Math.round(Number(schema.formatOdds(d, f)) * 100) / 100, `${d} ${f}`);
  }
});

test('American odds keep the venue number in American and convert otherwise', () => {
  assert.equal(F.fromAm(-110), '-110');
  assert.equal(F.fromAm(150), '+150');
  assert.equal(F.fromAm(-110, 'decimal'), '1.91');
  assert.equal(F.fromAm(-110, 'fractional'), '10/11');
  assert.equal(F.fromAm(-110, 'probability'), '52.4%');
  assert.equal(F.fromAm(150, 'decimal'), '2.50');
  assert.equal(F.fromAm(150, 'fractional'), '3/2');
  assert.equal(F.fromAm(100, 'decimal'), '2.00');
  assert.equal(F.fromAm(-200, 'probability'), '66.7%');
  // round trip: American -> decimal -> American is the same number
  for (const a of [-1000, -250, -115, -101, 100, 101, 120, 333, 2500]) assert.equal(F.fromDec(F.decOfAm(a), 'american'), a > 0 ? `+${a}` : `${a}`);
});

test('no price is a dash, never a made-up number', () => {
  for (const f of F.FORMATS) {
    assert.equal(F.fromDec(null, f), '—');
    assert.equal(F.fromDec(1, f), '—');
    assert.equal(F.fromDec(NaN, f), '—');
    assert.equal(F.fromAm(null, f), '—');
    assert.equal(F.fromAm('', f), '—');
    assert.equal(F.fromProb(0, f), '—');
    assert.equal(F.fromProb(1, f), '—');
  }
  // a number that is not American odds is shown as it came
  assert.equal(F.fromAm(50, 'decimal'), '+50');
  assert.equal(F.fromProb(0.5, 'american'), '+100');
  assert.equal(F.fromProb(0.8, 'decimal'), '1.25');
  assert.equal(F.valid('decimal'), true);
  assert.equal(F.valid('cents'), false);
});

test('the setting lives on this device and never in a share link', () => {
  assert.match(html, /localStorage\.getItem\('lr_odds_fmt'\)/);
  const share = html.match(/^\/\/ LR_SHARE_BEGIN\n([\s\S]*?)^\/\/ LR_SHARE_END$/m)[1];
  assert.doesNotMatch(share, /fmt|odds_?format/i);
  // CUSTOMIZE has the picker, the shopper's ODDS picker sets the same setting, EXPORT names it
  assert.match(html, /id="layOddsFmt"[^>]*onchange="oddsFmtSet\(this\.value\)"/);
  assert.match(html, /<select onchange="oddsFmtSet\(this\.value\)"/);
  assert.match(html, /'odds_format'/);
  // the old per-screen American formatters all go through the setting
  for (const re of [/const osAm = oA;/, /const fmtAm = a => \(a == null \? '—' : oA\(a\)\);/, /const mvAm = a => \(a == null \? '—' : oA\(a\)\);/, /const tlAm = d => \(d \? oD\(d\) : '—'\);/, /function shpOdds\(d\) \{ return d > 1 \? oD\(d\) : '—'; \}/]) assert.match(html, re);
});
