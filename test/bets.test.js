const test = require('node:test');
const assert = require('node:assert/strict');
const B = require('../bets');
const { sportKey, outcomeFor } = require('../tracker');

const NOW = Date.parse('2026-10-12T18:00:00Z');
const near = (a, b, eps = 1e-6, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg || ''} ${a} vs ${b}`);
const mk = (o, opts = {}) => { const b = B.make({ pick: 'X', stake: 100, odds: '+100', ...o }, { now: NOW, ...opts }); assert.ok(!b.error, b.error); return b; };

test('make reads every odds format and refuses what it cannot price', () => {
  near(mk({ odds: '-110' }).odds, 1.9091, 1e-4);
  near(mk({ odds: '2.5' }).odds, 2.5);
  const c = mk({ odds: '57c' });
  near(c.odds, 1.7544, 1e-4); assert.equal(c.cents, true);
  assert.equal(mk({ odds: '+150' }).cents, false);
  assert.match(B.make({ pick: 'X', stake: 10, odds: 'abc' }).error, /odds/);
  assert.match(B.make({ pick: 'X', stake: 0, odds: '+100' }).error, /stake/);
  assert.match(B.make({ pick: ' ', stake: 10, odds: '+100' }).error, /bet on/);
  const b = mk({ result: 'win' });
  assert.equal(b.settledBy, 'manual'); assert.ok(b.settledAt);
  assert.equal(mk({ tool: 'Hack' }).tool, 'Manual');
});

test('profit for each result, at the bettor\'s own price', () => {
  const b = mk({ odds: '+150', stake: 40 });
  assert.equal(B.toWin(b), 60);
  assert.equal(B.profit(b), null, 'open');
  assert.equal(B.profit(B.settle(b, 'win')), 60);
  assert.equal(B.profit(B.settle(b, 'loss')), -40);
  assert.equal(B.profit(B.settle(b, 'push')), 0);
  assert.equal(B.profit(B.settle(b, 'void')), 0);
  assert.equal(B.profit(B.settle(b, 'half_win')), 30);
  assert.equal(B.profit(B.settle(b, 'half_loss')), -20);
  assert.equal(B.profit(B.settle(b, 'cashout', { cashout: 55 })), 15);
  const back = B.settle(B.settle(b, 'win'), 'open');
  assert.equal(back.settledAt, null); assert.equal(back.settledBy, null);
});

test('CLV is your decimal price over the close, and crosses ±100 correctly', () => {
  near(B.clv(mk({ odds: '+105', closeOdds: '-110' })), 2.05 / (1 + 100 / 110) - 1, 1e-4);
  assert.equal(B.clv(mk({})), null);
  assert.ok(B.clv(mk({ odds: '-120', closeOdds: '-110' })) < 0);
});

test('stats: record, ROI over money at risk, units, CLV, open exposure, drawdown, streak', () => {
  const t = h => NOW - h * 3600e3;
  const list = [
    mk({ odds: '+100', stake: 100, result: 'win', settledAt: t(5), unitUsd: 50, closeOdds: '-110' }),
    mk({ odds: '+100', stake: 100, result: 'loss', settledAt: t(4), unitUsd: 50 }),
    mk({ odds: '+100', stake: 100, result: 'loss', settledAt: t(3), unitUsd: 50 }),
    mk({ odds: '+100', stake: 100, result: 'push', settledAt: t(2), unitUsd: 50 }),
    mk({ odds: '+200', stake: 50, result: 'win', settledAt: t(1), unitUsd: 25 }),
    mk({ odds: '-110', stake: 110, unitUsd: 50 }),
  ];
  const s = B.stats(list);
  assert.equal(s.record, '2-2-1');
  assert.equal(s.profit, 100 - 100 - 100 + 0 + 100);
  assert.equal(s.risked, 350, 'the push gave its stake back');
  near(s.roi, 0 / 350);
  assert.equal(s.units, 2 - 2 - 2 + 0 + 4);
  assert.equal(s.winRate, 0.5);
  assert.equal(s.open, 1); assert.equal(s.openStake, 110); assert.equal(s.openToWin, 100);
  assert.equal(s.drawdown, 200);
  assert.equal(s.streak, 'W1');
  assert.equal(s.clvN, 1); assert.equal(s.beatClose, 1);
  // units fall back to the current unit when a bet has none, and say unknown with neither
  assert.equal(B.stats([mk({ result: 'win' })], { unitUsd: 20 }).units, 5);
  assert.equal(B.stats([mk({ result: 'win' })]).units, null);
  assert.equal(B.stats([]).roi, null);
});

test('curve, breakdown and filter', () => {
  const a = mk({ result: 'win', settledAt: NOW - 2e3, tool: 'Sharp Tail', book: 'Kalshi', placedAt: '2026-10-01T00:00:00Z' });
  const b = mk({ result: 'loss', settledAt: NOW - 1e3, tool: 'Sharp Tail', book: 'Polymarket', placedAt: '2026-09-15T00:00:00Z' });
  const c = mk({ tool: 'Manual', book: 'Kalshi', event: 'Fnatic vs G2', placedAt: '2026-10-12T00:00:00Z' });
  assert.deepEqual(B.curve([c, b, a]).map(p => p.pnl), [100, 0]);
  const byTool = B.breakdown([a, b, c], 'tool');
  assert.deepEqual(byTool.map(r => [r.key, r.bets, r.profit]), [['Sharp Tail', 2, 0], ['Manual', 1, 0]]);
  assert.deepEqual(B.breakdown([a, b, c], 'month').map(r => r.key), ['2026-10', '2026-09']);
  assert.equal(B.filter([a, b, c], { status: 'open' }).length, 1);
  assert.equal(B.filter([a, b, c], { status: 'settled', book: 'Kalshi' }).length, 1);
  assert.equal(B.filter([a, b, c], { days: 7, now: NOW }).length, 1);
  assert.equal(B.filter([a, b, c], { q: 'fnatic' })[0], c);
});

test('a Best Plays row prefills at the user\'s unit, with a tracker reference', () => {
  const tail = B.fromPlay({ id: 'tail:sig1', kind: 'tail', label: 'Sharp Tail', title: 'Will X win?', category: 'politics', bet: 'Yes', venue: 'Kalshi', price: 0.4, units: 1.5, track: { kind: 'tail', id: 'sig1' } }, { unitUsd: 20 });
  near(tail.odds, 2.5); assert.equal(tail.cents, true); assert.equal(tail.stake, 30);
  assert.equal(tail.tool, 'Sharp Tail'); assert.equal(tail.sport, 'Politics'); assert.deepEqual(tail.track, { kind: 'tail', id: 'sig1' });
  const book = B.fromPlay({ id: 'x', kind: 'tail', bet: 'Yes', american: -120, units: 1 }, {});
  near(book.odds, 1 + 100 / 120, 1e-4); assert.equal(book.stake, null, 'no unit set: the user types it');
  const prop = B.fromPlay({ kind: 'esportsProp', label: 'CS prop', title: 'm0NESY', bet: 'More than 38.5 Kills', venue: 'Underdog', units: 1 }, { unitUsd: 10 });
  assert.equal(prop.odds, null); assert.equal(prop.sport, 'CS'); assert.equal(prop.tool, 'Esports prop');
  assert.equal(B.fromPlay({ kind: 'arb', label: 'Exchange arb', category: 'sports', price: 0.95 }).tool, 'Arb');
});

test('tracked bets settle from the trackers, at the bettor\'s own line', () => {
  const tail = [
    { id: 'sig1', status: 'settled', result: 'win', closePrice: 0.5, clv: 0.25, topUps: ['sig1b'] },
    { id: 'sig2', status: 'open', result: null, closePrice: 0.6, clv: 0.1 },
    { id: 'sig3', status: 'settled', result: 'unfilled' },
  ];
  const picks = [{ sport: 'CS', player: 'm0NESY', market: 'Kills (Maps 1-2)', startTime: '2026-10-12T15:00:00Z', status: 'graded', result: 40, stat: 'kills' },
    { sport: 'LOL', player: 'Faker', market: 'Kills', startTime: '2026-10-12T15:00:00Z', status: 'void' }];
  const prop = (id, line, side, player = 'M0NESY') => ({ id, track: { kind: 'prop', sport: 'CS2', player, market: 'Kills (Maps 1-2)', line, side, startsAt: '2026-10-12T15:30:00Z' } });
  const out = B.matchTracked([
    { id: 'a', track: { kind: 'tail', id: 'sig1' } }, { id: 'a2', track: { kind: 'tail', id: 'sig1b' } },
    { id: 'b', track: { kind: 'tail', id: 'sig2' } }, { id: 'c', track: { kind: 'tail', id: 'sig3' } },
    prop('p1', 38.5, 'OVER'), prop('p2', 40, 'UNDER'), prop('p3', 41.5, 'More'), prop('p4', 38.5, 'OVER', 'someone'),
    { id: 'v', track: { kind: 'prop', sport: 'LoL', player: 'Faker', market: 'Kills', line: 3.5, side: 'OVER', startsAt: '2026-10-12T15:00:00Z' } },
    { id: 'n' }, { id: 'bad', track: 'x' },
  ], { tail, picks, sportKey, outcomeFor });
  assert.equal(out.a.result, 'win'); assert.equal(out.a.closeOdds, 2);
  assert.equal(out.a2.result, 'win', 'a top-up settles with its first bet');
  assert.equal(out.b.result, undefined); assert.equal(out.b.closeOdds, 1.6667, 'the close is in before the result');
  assert.equal(out.c, undefined, 'an unfilled bid says nothing about the outcome');
  assert.equal(out.p1.result, 'win'); assert.equal(out.p2.result, 'push'); assert.equal(out.p3.result, 'loss');
  assert.equal(out.p4, undefined); assert.equal(out.v.result, 'void');
  assert.deepEqual(Object.keys(out).sort(), ['a', 'a2', 'b', 'p1', 'p2', 'p3', 'v']);

  // applying: open bets settle as auto; a bet the user settled by hand keeps its result
  const mine = [mk({ id: 'a', track: { kind: 'tail', id: 'sig1' } }), mk({ id: 'b' }), mk({ id: 'p1', result: 'loss' })];
  const { list, changed } = B.applyTracked(mine, out, { now: NOW });
  assert.equal(changed, 2);
  assert.equal(list[0].result, 'win'); assert.equal(list[0].settledBy, 'auto'); assert.equal(list[0].closeOdds, 2);
  assert.equal(list[1].result, 'open'); assert.equal(list[1].closeOdds, 1.6667);
  assert.equal(list[2].result, 'loss'); assert.equal(list[2].settledBy, 'manual');
  assert.equal(B.applyTracked(list, out, { now: NOW }).changed, 0, 'idempotent');
});

test('the old BET LOG migrates', () => {
  const old = [
    { id: 1760000000000, pick: 'Lakers ML', odds: 150, stake: 25, sport: 'NBA', book: 'FanDuel', myOdds: 150, closeOdds: -110, result: 'win', date: '10/9/2025' },
    { id: 1760000000001, pick: '3-leg UNDERDOG: a / b / c', odds: 500, stake: 10, sport: 'Esports', book: 'Underdog', result: 'pending', date: '10/9/2025' },
    { id: 3, pick: 'broken', odds: 'x', stake: 5 },
  ];
  const m = B.migrate(old);
  assert.equal(m.length, 2);
  near(m[0].odds, 2.5); near(m[0].closeOdds, 1.9091, 1e-4); assert.equal(m[0].result, 'win');
  assert.equal(m[0].placedAt, new Date(1760000000000).toISOString());
  assert.equal(m[1].result, 'open'); assert.equal(m[1].tool, 'Esports slip');
  assert.deepEqual(B.migrate(m), m, 'new bets pass through');
});

test('CSV: export round-trips, formulas are defused, other trackers\' exports import', () => {
  const list = [mk({ event: 'A, "quoted"', pick: '=HYPERLINK("x")', odds: '-110', result: 'win', unitUsd: 10, notes: 'line1\nline2' }),
    mk({ pick: 'Open bet', odds: '+250', book: 'Kalshi', tool: 'Sharp Tail' })];
  const csv = B.toCSV(list);
  assert.ok(csv.startsWith('Date,Event,Pick,'));
  assert.ok(csv.includes(`"'=HYPERLINK(""x"")"`));
  assert.ok(csv.includes(',-110,'), 'odds stay numbers');
  const back = B.fromCSV(csv, { now: NOW });
  assert.deepEqual(back.skipped, []);
  assert.equal(back.bets.length, 2);
  const w = back.bets.find(b => b.result === 'win');
  assert.equal(w.pick, '=HYPERLINK("x")'); assert.equal(w.event, 'A, "quoted"'); assert.equal(w.notes, 'line1\nline2');
  near(w.odds, 1.9091, 1e-4);
  assert.equal(B.merge(list, back.bets).added, 0, 'same ids are not added twice');

  const other = 'Date Placed,Sportsbook,Bet Name,American Odds,Risk Amount,Status,Profit\n2026-10-01,DraftKings,Chiefs -3,-110,110,Won,100\n2026-10-02,FanDuel,Over 47.5,+105,50,,−\n2026-10-03,FanDuel,Bills ML,+120,50,,-50\n2026-10-04,FanDuel,Thing,+120,50,weird,\n';
  const r = B.fromCSV(other, { now: NOW });
  assert.equal(r.bets.length, 3);
  assert.deepEqual(r.bets.map(b => b.result), ['win', 'open', 'loss']);
  assert.equal(r.bets[0].book, 'DraftKings'); assert.equal(r.bets[0].stake, 110);
  assert.equal(r.skipped.length, 1); assert.equal(r.skipped[0].line, 5);
  assert.equal(B.fromCSV('only,a,header').bets.length, 0);
});
