const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../esstale');
const { normalCdf } = require('../dist');

const T0 = Date.parse('2026-10-15T03:00:00Z');
const START = '2026-10-15T09:00:00Z';
const min = m => T0 + m * 60e3;
// a CS kill line on a normal curve, sd 6: a one-kill move is about 6.6 points at the line
const probAt = (m, x) => 1 - normalCdf(x, m, 6);
const meta = { sport: 'CS', player: 'NiKo', market: 'Kills on Maps 1+2', event: 'Falcons vs NiP', start: START, probAt };
const q = (app, line, mean, cell = null) => ({ key: 'k1', app, line, mean, cell, meta });
const price = (app, fair) => ({ ev: (fair / 0.5503 - 1) * 100, decimal: 1 / 0.5503, entry: '3-pick power' });

test('a leader move leaves the unmoved app stale, priced on the leader\'s new mean', () => {
  const s = E.createEsStale();
  s.observe('underdog', [q('underdog', 30.5, 30.5)], min(0));
  s.observe('prizepicks', [q('prizepicks', 30.5, 30.5)], min(0));
  s.observe('sleeper', [q('sleeper', 30.5, 30.5, { over: 1.78, under: 1.78 })], min(0));
  // Underdog goes to 31.5: the over at 30.5 was 50%, now about 57%
  s.observe('underdog', [q('underdog', 31.5, 31.5)], min(2));
  // not until Underdog's next read shows the same line
  assert.equal(s.rows(min(2.5), { priceApp: price }).length, 0);
  s.observe('underdog', [q('underdog', 31.5, 31.5)], min(2.5));
  const rows = s.rows(min(3), { priceApp: price });
  assert.deepEqual(rows.map(r => r.app).sort(), ['prizepicks', 'sleeper']);
  const pp = rows.find(r => r.app === 'prizepicks');
  assert.equal(pp.side, 'Over'); assert.equal(pp.line, 30.5); assert.equal(pp.leader, 'underdog');
  assert.equal(pp.leadPre, 30.5); assert.equal(pp.leadPost, 31.5);
  assert.ok(pp.fairProb > 56 && pp.fairProb < 58, `fair ${pp.fairProb}`);
  assert.equal(pp.preFair, 50);
  assert.equal(pp.mins, 1);
  assert.equal(pp.fairPrice < 0, true);
  // Sleeper bends its payout most of the way: followed, off the list
  s.observe('sleeper', [q('sleeper', 30.5, 31.2, { over: 1.66, under: 1.92 })], min(3.5));
  assert.deepEqual(s.rows(min(4), { priceApp: price }).map(r => r.app), ['prizepicks']);
  s.step(min(70));
  assert.equal(s.rows(min(70), { priceApp: price }).length, 0);
  const lag = s.lagSummary(min(70)).lag;
  const sl = lag.find(c => c.leader === 'underdog' && c.app === 'sleeper');
  assert.equal(sl.followed, 1); assert.equal(sl.medianMin, 1.5); assert.equal(sl.sameWayPct, 100);
  assert.equal(lag.find(c => c.app === 'prizepicks').none, 1);
});

test('small payout drift is not a move; an app already there is ahead, not stale', () => {
  const s = E.createEsStale();
  s.observe('sleeper', [q('sleeper', 27.5, 27.5)], min(0));
  s.observe('prizepicks', [q('prizepicks', 28, 28)], min(0));
  s.observe('underdog', [q('underdog', 27.5, 27.5)], min(0));
  s.observe('sleeper', [q('sleeper', 27.5, 27.6)], min(1));           // under a point
  assert.equal(s.rows(min(2), { priceApp: price }).length, 0);
  s.observe('underdog', [q('underdog', 28.5, 28.5)], min(3));         // PrizePicks already at 28
  s.observe('underdog', [q('underdog', 28.5, 28.5)], min(3.5));
  const rows = s.rows(min(4), { priceApp: price });
  assert.deepEqual(rows.map(r => r.app), ['sleeper']);
  s.step(min(70));
  assert.equal(s.lagSummary(min(70)).lag.find(c => c.app === 'prizepicks').ahead, 1);
});

test('opposite moves, pulled lines and a leader moving back', () => {
  const s = E.createEsStale();
  for (const a of ['underdog', 'prizepicks', 'sleeper']) s.observe(a, [q(a, 30.5, 30.5)], min(0));
  s.observe('underdog', [q('underdog', 31.5, 31.5)], min(1));
  s.observe('underdog', [q('underdog', 31.5, 31.5)], min(1.5));
  s.observe('sleeper', [q('sleeper', 30.5, 29.8)], min(2));           // the other way
  s.observe('prizepicks', [], min(3));                                 // taken down
  assert.equal(s.rows(min(4), { priceApp: price }).length, 0);
  const lag = s.lagSummary(min(4)).lag;
  assert.equal(lag.find(c => c.app === 'sleeper').opposite, 1);
  assert.equal(lag.find(c => c.app === 'prizepicks').pulled, 1);

  const s2 = E.createEsStale();
  for (const a of ['underdog', 'prizepicks']) s2.observe(a, [q(a, 30.5, 30.5)], min(0));
  s2.observe('underdog', [q('underdog', 31.5, 31.5)], min(1));
  s2.observe('underdog', [q('underdog', 31.5, 31.5)], min(1.5));
  assert.equal(s2.rows(min(2), { priceApp: price }).length, 1);
  s2.observe('underdog', [q('underdog', 30.5, 30.5)], min(3));        // back where it was
  assert.equal(s2.rows(min(4), { priceApp: price }).length, 0);
});

test('rows stop at the match start; pickQuotes maps the board\'s market quotes', () => {
  const s = E.createEsStale();
  for (const a of ['underdog', 'prizepicks']) s.observe(a, [q(a, 30.5, 30.5)], min(0));
  s.observe('underdog', [q('underdog', 31.5, 31.5)], min(1));
  s.observe('underdog', [q('underdog', 31.5, 31.5)], min(1.5));
  assert.equal(s.rows(min(2), { priceApp: price }).length, 1);
  assert.equal(s.rows(Date.parse(START) + 1, { priceApp: price }).length, 0);
  const p = { sport: 'CS', player: 'NiKo', market: 'Kills on Maps 1+2', startTime: START, gameId: 7,
    marketQuotes: [{ book: 'PP', line: 30.5, pOver: 0.5, mean: 30.4 }, { book: 'UD', line: 31.5, pOver: 0.48, mean: 31.2 }, { book: 'XX', line: 1, mean: 1 }] };
  const qs = E.pickQuotes(p, { probAt: (pk, m, x) => probAt(m, x), cellOf: (pk, b) => ({ b }) });
  assert.deepEqual(qs.map(x => [x.app, x.line, x.cell.b]), [['prizepicks', 30.5, 'PP'], ['underdog', 31.5, 'UD']]);
  assert.equal(qs[0].key, 'CS|niko|Kills on Maps 1+2|7');
  assert.ok(Math.abs(qs[0].meta.probAt(30.5, 30.5) - 0.5) < 1e-9);
});

test('an app swapping between two listings is not moving: the subject goes quiet', () => {
  // one player in two same-day Bo1s under one key: Underdog's feed shows 14.5, 15.5, 14.5 ...
  const s = E.createEsStale();
  for (const a of ['underdog', 'prizepicks']) s.observe(a, [q(a, 14.5, 14.5)], min(0));
  s.observe('underdog', [q('underdog', 15.5, 15.5)], min(0.5));
  s.observe('underdog', [q('underdog', 14.5, 14.5)], min(1));      // back: never confirmed, and now unstable
  s.observe('underdog', [q('underdog', 15.5, 15.5)], min(1.5));
  s.observe('underdog', [q('underdog', 15.5, 15.5)], min(2));
  assert.equal(s.rows(min(3), { priceApp: price }).length, 0);
  assert.equal(s.state().unstable, 1);
  s.step(min(90));
  assert.equal(s.lagSummary(min(90)).lag.length, 0);
});
