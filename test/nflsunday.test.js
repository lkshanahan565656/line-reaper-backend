const test = require('node:test');
const assert = require('node:assert');
const NS = require('../nflsunday');
const week = require('../scripts/nflsunday-week');

const START = Date.parse('2026-10-25T17:00:00Z');
const H = 3600e3;

test('app lines become one entry per player stat, NFL only', () => {
  const e = NS.appEntries([
    { book: 'prizepicks', sport: 'NFL', player: 'Patrick Mahomes', team: 'KC', market: 'Pass Yards', line: 265.5, startTime: '2026-10-25T17:00:00Z', opponent: 'LV' },
    { book: 'prizepicks', sport: 'NBA', player: 'LeBron James', market: 'Points', line: 24.5 },
    { book: 'underdog', sport: 'NFL', player: 'Travis Kelce', market: 'Receiving Yards', line: 52.5, overMultiplier: 1.03, underMultiplier: 0.88 },
  ]);
  assert.strictEqual(e.size, 2);
  const pm = e.get('patrickmahomes|pass_yds');
  assert.deepStrictEqual(pm.v, [265.5, null, null, 1, 1]);
  assert.strictEqual(pm.m.tm, 'KC');
  assert.deepStrictEqual(e.get('traviskelce|rec_yds').v, [52.5, 1.03, 0.88, 1, 1]);
});

test('the change log writes only changes, and a dropped line once', () => {
  const out = [];
  const log = NS.createChangeLog(o => out.push(o));
  const m = new Map([['a|pass_yds', { v: [250.5, null, null, 1, 1], m: { p: 'A' } }]]);
  log.observe('prizepicks', m, 1);
  log.observe('prizepicks', m, 2);
  log.observe('prizepicks', new Map([['a|pass_yds', { v: [255.5, null, null, 1, 1], m: { p: 'A' } }]]), 3);
  log.observe('prizepicks', new Map(), 4);
  assert.deepStrictEqual(out.map(o => [o.t, o.gone ? 'gone' : o.v[0], !!o.m]), [[1, 250.5, true], [3, 255.5, false], [4, 'gone', false]]);
});

test('a book ladder prices only its exact number, raw prices kept', () => {
  const q = NS.bookAt([[249.5, -115, -105], [252.5, 100, -120]], 249.5);
  assert.strictEqual(q.exact, true);
  assert.ok(q.pOver > 0.5 && q.pOver < 0.54);
  assert.strictEqual(q.over, -115);
  const off = NS.bookAt([[252.5, -110, -110]], 245.5);
  assert.deepStrictEqual([off.exact, off.line, off.diff], [false, 252.5, 7]);
});

test('break-evens per app: PP 3-pick power, Pick6 scaled, Underdog and Sleeper by multiplier', () => {
  assert.strictEqual(+NS.breakEven('prizepicks', 'Over', [1]).toFixed(4), 0.5503);
  assert.strictEqual(+NS.breakEven('pick6', 'Under', [1, 1, 0.9]).toFixed(4), 0.6114);
  assert.strictEqual(+NS.breakEven('underdog', 'Over', [1, 1, 1]).toFixed(4), 0.5623);
  assert.strictEqual(+NS.breakEven('underdog', 'Over', [1, 1.8, 1.9]).toFixed(4), 0.5556);   // decimal prices
  assert.strictEqual(+NS.breakEven('sleeper', 'Under', [1, 1.8, 1.9]).toFixed(4), 0.5263);
});

function board() {
  const recs = [];
  const m = (p, tm) => ({ p, tm, st: '2026-10-25T17:00:00.000Z', mt: 'LV', mk: '', mkey: '' });
  // PrizePicks: QB 250.5 opens, moves to 255.5 at bet time; receiver 60.5
  recs.push({ t: START - 20 * H, s: 'prizepicks', k: 'qb|pass_yds', v: [250.5, null, null, 1, 1], m: { ...m('QB One', 'KC'), mkey: 'pass_yds' } });
  recs.push({ t: START - 2 * H, s: 'prizepicks', k: 'qb|pass_yds', v: [255.5, null, null, 1, 1] });
  recs.push({ t: START - 20 * H, s: 'prizepicks', k: 'wr|rec_yds', v: [60.5, null, null, 1, 1], m: { ...m('WR One', 'KC'), mkey: 'rec_yds' } });
  recs.push({ t: START + H, s: 'prizepicks', k: 'qb|pass_yds', gone: 1 });
  // Pinnacle hangs 255.5 with the Over favoured, then moves its price
  recs.push({ t: START - 3 * H, s: 'pinnacle', k: 'qb|pass_yds', v: [[255.5, -160, 130]], m: { p: 'QB One', st: '2026-10-25T17:00:00.000Z', mkey: 'pass_yds' } });
  recs.push({ t: START - 10 * 60e3, s: 'pinnacle', k: 'qb|pass_yds', v: [[255.5, -185, 150]] });
  recs.push({ t: START - 3 * H, s: 'pinnacle', k: 'wr|rec_yds', v: [[64.5, -110, -110]], m: { p: 'WR One', st: '2026-10-25T17:00:00.000Z', mkey: 'rec_yds' } });
  return recs;
}

test('a leg carries its open, bet-time and close numbers, priced at the app number', () => {
  const { series, meta } = NS.replay([...board(), ...board()]);   // a log read twice counts once
  assert.strictEqual(series.prizepicks.get('qb|pass_yds').length, 3);
  const legs = NS.buildLegs(series, meta);
  const qb = legs.find(l => l.key === 'qb|pass_yds');
  assert.strictEqual(qb.open.line, 250.5);
  assert.strictEqual(qb.bet.v[0], 255.5);
  assert.strictEqual(qb.moves, 1);
  assert.strictEqual(qb.bet.books.pinnacle.exact, true);
  assert.strictEqual(qb.close.books.pinnacle.over, -185);   // Pinnacle's last read before kickoff, raw
  const [over] = NS.sides(qb);
  assert.ok(over.fair.pinnacle > 0.55 && over.closeFair.pinnacle > over.fair.pinnacle);
  const wr = legs.find(l => l.key === 'wr|rec_yds');
  assert.strictEqual(wr.bet.books.pinnacle.exact, false);
  assert.strictEqual(NS.betterNumber(wr, NS.sides(wr)[0]), 4);   // app 60.5 Over vs Pinnacle 64.5
});

test('the summary grades every kind against break-even, with the pre-registered slices', () => {
  const { series, meta } = NS.replay(board());
  const legs = NS.buildLegs(series, meta);
  const results = new Map([['prizepicks|qb|pass_yds', { result: 280 }], ['prizepicks|wr|rec_yds', { result: 71 }]]);
  const rep = NS.summarize(legs, results);
  assert.strictEqual(rep.legs, 2);
  const all = rep.byKind['prizepicks|all'];
  assert.deepStrictEqual([all.n, all.w, all.l], [4, 2, 2]);
  assert.strictEqual(all.be, 0.5503);
  const pin = rep.byKind['prizepicks|pin-backed'];
  assert.deepStrictEqual([pin.n, pin.w], [1, 1]);
  assert.ok(pin.clv > 0 && pin.units > 0.8);
  assert.deepStrictEqual([rep.byKind['prizepicks|pp-qb-pass-over'].n, rep.byKind['prizepicks|pp-qb-pass-over'].w], [1, 1]);
  assert.deepStrictEqual([rep.stack.pairs, rep.stack.both, rep.stack.games], [1, 1, 1]);
  assert.strictEqual(rep.byKind['prizepicks|better-number-than-pin'].n, 1);
  assert.match(NS.reportText(rep), /PP QB pass Over \+ own receiver Over: 1 of 1 pairs/);
});

test('ungraded and void legs stay out of the record', () => {
  const { series, meta } = NS.replay(board());
  const legs = NS.buildLegs(series, meta);
  const rep = NS.summarize(legs, new Map([['prizepicks|qb|pass_yds', { void: true }]]));
  assert.deepStrictEqual([rep.voided.legs, rep.pending.legs], [1, 1]);
  assert.deepStrictEqual(rep.byKind, {});
});

test('the week a run belongs to is its NFL Sunday', () => {
  assert.strictEqual(week(Date.parse('2026-10-24T18:00:00Z')), '20261025');   // Saturday
  assert.strictEqual(week(Date.parse('2026-10-25T23:00:00Z')), '20261025');   // Sunday
  assert.strictEqual(week(Date.parse('2026-10-27T02:00:00Z')), '20261025');   // Monday night ET
  assert.strictEqual(week(Date.parse('2026-10-29T12:00:00Z')), '20261101');   // Thursday
});
