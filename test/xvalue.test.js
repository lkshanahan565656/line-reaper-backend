const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('../xvalue');
const { kalshiFee } = require('../exchanges');
const { createEvTracker } = require('../evtrack');

const NOW = Date.parse('2026-10-12T12:00:00Z');
const START = '2026-10-12T23:00:00Z';

const kRow = (o = {}) => ({
  exchange: 'kalshi', id: 'KXNBAGAME-26OCT12NYKBOS-BOS', eventKey: 'kalshi:KXNBAGAME-26OCT12NYKBOS', eventTitle: 'New York at Boston',
  title: 'New York at Boston Winner?', outcomeLabel: 'Boston', noLabel: 'New York', kind: 'teams', yesAsk: 0.52, noAsk: 0.5,
  startTime: START, tradable: true, league: 'nba', category: 'sports', url: 'https://kalshi.com/markets/kxnbagame-26oct12nykbos', ...o,
});
const pRow = (o = {}) => ({
  exchange: 'polymarket', id: '555', eventKey: 'polymarket:1', eventTitle: 'Knicks vs. Celtics', title: 'Knicks vs. Celtics',
  outcomeLabel: 'Celtics', noLabel: 'Knicks', kind: 'teams', yesAsk: 0.57, noAsk: 0.44, gameSlug: 'nba-nyk-bos-2026-10-12',
  startTime: START, tradable: true, liquidity: 50000, league: 'nba', category: 'sports', url: 'https://polymarket.com/event/nba-nyk-bos-2026-10-12', ...o,
});
const usRow = (o = {}) => ({
  exchange: 'polymarketus', id: 'aec-nba-nyk-bos-2026-10-12', eventKey: 'polymarketus:nba-nyk-bos-2026-10-12', eventTitle: 'Knicks vs. Celtics',
  title: 'Knicks vs. Celtics', gameSlug: 'nba-nyk-bos-2026-10-12', kind: 'teams', outcomeLabel: 'Knicks', noLabel: 'Celtics',
  yesAsk: 0.4, noAsk: 0.62, startTime: START, tradable: true, feeSchedule: { rate: 0.01, exponent: 1 }, league: 'nba', ...o,
});
const match = (k, p, same = true, by = 'teams') => ({ kalshi: k, polymarket: p, same, by });

test('Kalshi ask under the Polymarket mid by more than the fee is an edge', () => {
  // Polymarket: ask 57, bid 56 → mid 56.5. Kalshi YES Boston at 52 + fee.
  const k = kRow();
  const { edges } = V.findValue({ matches: [match(k, pRow())], kalshi: [k] }, { now: NOW });
  const e = edges.find(x => x.pick === 'Boston');
  assert.ok(e, 'Boston edge');
  const cost = 0.52 + kalshiFee(0.52, 100) / 100;
  assert.equal(e.cost, Math.round(cost * 1e4) / 1e4);
  assert.equal(e.fair, 0.565);
  assert.ok(Math.abs(e.ev - (0.565 / cost - 1)) < 1e-3);
  assert.equal(e.venue, 'kalshi');
  // NO Boston at 50 against a fair of 43.5: no edge
  assert.ok(!edges.some(x => x.pick === 'New York' && x.marketId === k.id));
});

test('the other team market of a Kalshi game is priced the other way round', () => {
  const k = kRow({ yesAsk: 0.6, noAsk: 0.42 });   // no edge on Boston
  const twin = kRow({ id: 'KXNBAGAME-26OCT12NYKBOS-NYK', outcomeLabel: 'New York', noLabel: 'Boston', yesAsk: 0.38, noAsk: 0.64 });
  const { edges } = V.findValue({ matches: [match(k, pRow())], kalshi: [k, twin] }, { now: NOW });
  const e = edges.find(x => x.marketId === twin.id && x.side === 'yes');
  assert.ok(e, 'New York YES on the twin market');
  assert.equal(e.fair, 0.435);
});

test('reversed polarity flips the fair', () => {
  const k = kRow({ yesAsk: 0.4, noAsk: 0.62, outcomeLabel: 'New York', noLabel: 'Boston' });
  const { edges } = V.findValue({ matches: [match(k, pRow(), false)], kalshi: [k] }, { now: NOW });
  assert.equal(edges.length, 1);
  assert.equal(edges[0].pick, 'New York');
  assert.equal(edges[0].fair, 0.435);
});

test('a wide or thin Polymarket book, a started game, a title match or a huge gap is no edge', () => {
  const k = kRow();
  const none = (m, o = {}) => assert.equal(V.findValue({ matches: [m], kalshi: [k] }, { now: NOW, ...o }).edges.length, 0);
  none(match(k, pRow({ yesAsk: 0.6, noAsk: 0.44 })));              // 4¢ spread
  none(match(k, pRow({ liquidity: 500 })));
  none(match(k, pRow()), { now: Date.parse(START) - 30e3 });
  none(match(k, pRow(), true, 'title'));
  none(match(kRow({ yesAsk: 0.4 }), pRow()));                       // 40¢ vs 56.5¢: two different questions
});

test('Polymarket US pairs with Polymarket by slug and pays its own fee', () => {
  const us = usRow();
  const { edges } = V.findValue({ usRows: [us], polymarket: [pRow()] }, { now: NOW, venues: ['polymarketus'] });
  const e = edges.find(x => x.pick === 'Knicks');
  assert.ok(e);
  assert.equal(e.venue, 'polymarketus');
  assert.equal(e.fair, 0.435);
  assert.ok(e.cost > 0.4 && e.cost < 0.41);
  // a total pairs by line
  const pairs = V.pairUs([usRow({ kind: 'total', line: 220.5, outcomeLabel: 'Over', noLabel: 'Under' })],
    [pRow({ kind: 'total', line: 220.5, outcomeLabel: 'Over', noLabel: 'Under' }), pRow({ kind: 'total', line: 221.5 })]);
  assert.equal(pairs.length, 1);
});

test('venues limits which side can be bet', () => {
  const k = kRow();
  assert.equal(V.findValue({ matches: [match(k, pRow())], kalshi: [k] }, { now: NOW, venues: ['polymarketus'] }).edges.length, 0);
});

test('edges grade on CLV against the Polymarket close', async () => {
  let t = NOW;
  const tracker = createEvTracker({ minEv: 0, now: () => t });
  const k = kRow();
  const first = V.findValue({ matches: [match(k, pRow())], kalshi: [k] }, { now: t });
  await tracker.recordBoard(V.trackRows(first.edges), first.fairs);
  // the edge closes on Kalshi (ask moves up) and Polymarket keeps going: mid 60
  t += 3600e3;
  const k2 = kRow({ yesAsk: 0.61 });
  const later = V.findValue({ matches: [match(k2, pRow({ yesAsk: 0.605, noAsk: 0.405 }))], kalshi: [k2] }, { now: t });
  assert.equal(later.edges.length, 0);
  await tracker.recordBoard(V.trackRows(later.edges), later.fairs);
  t = Date.parse(START) + 60e3;
  await tracker.recordBoard([], new Map());
  const [b] = await tracker.list({ status: 'closed' });
  assert.equal(b.closeFair, 60);
  assert.ok(b.clv > 10, `CLV ${b.clv}`);
});

test('describe reads like an alert', () => {
  const k = kRow();
  const [e] = V.findValue({ matches: [match(k, pRow())], kalshi: [k] }, { now: NOW }).edges;
  assert.match(V.describe(e), /^NBA · New York at Boston .*Boston on Kalshi at 52¢ .*Polymarket 56\.5¢ \(\+/);
});

test('Best Plays lists exchange value with ¼ Kelly units, capped until proven', () => {
  const { bestPlays } = require('../bestplays');
  const k = kRow();
  const { edges } = V.findValue({ matches: [match(k, pRow())], kalshi: [k] }, { now: NOW });
  const out = bestPlays({ value: edges }, { now: NOW });
  const r = out.rows.find(x => x.kind === 'exchangeValue');
  assert.ok(r);
  assert.equal(r.venue, 'Kalshi');
  assert.equal(r.bet, 'Boston');
  assert.ok(r.units > 0 && r.units <= 1);
  assert.equal(out.counts.exchangeValue, 1);
});

test('Best Plays leaves out arbs of more than 4 bets', () => {
  const { bestPlays } = require('../bestplays');
  const leg = i => ({ venue: 'kalshi', pick: `P${i}`, price: 0.05, url: null });
  const arb = n => ({ id: `a${n}`, type: n > 2 ? 'multi' : 'cross', title: `${n} legs`, profitPct: 3, totalCost: 0.97, legs: Array.from({ length: n }, (_, i) => leg(i)) });
  const out = bestPlays({ arbs: [arb(2), arb(4), arb(16)] }, { now: NOW });
  assert.deepEqual(out.rows.filter(r => r.kind === 'arb').map(r => r.title).sort(), ['2 legs', '4 legs']);
});

test('the price screen gets each side\'s fair and the cheaper price\'s EV', () => {
  const row = { id: 'aec-nba-nyk-bos-2026-10-12', venue: 'polymarketus', kind: 'moneyline', sides: [
    { pick: 'Knicks', kalshi: 0.42, other: 0.41 }, { pick: 'Celtics', kalshi: 0.6, other: null },
  ] };
  const [r] = V.screenFairs([row], { usRows: [usRow()], polymarket: [pRow()] });
  assert.equal(r.sides[0].fair, 0.435);                      // Knicks: 1 − Celtics mid 56.5
  assert.equal(r.sides[1].fair, 0.565);
  assert.equal(r.sides[0].ev, Math.round((0.435 / 0.41 - 1) * 1e4) / 1e4);
  assert.equal(r.sides[1].ev, Math.round((0.565 / 0.6 - 1) * 1e4) / 1e4);
  assert.equal(r.maxEv, r.sides[0].ev);
  // a wide or unpaired ref leaves the row without a fair
  const [w] = V.screenFairs([row], { usRows: [usRow()], polymarket: [pRow({ yesAsk: 0.62, noAsk: 0.44 })] });
  assert.equal(w.maxEv, null);
  assert.equal(w.sides[0].fair, undefined);
});

test('Kalshi prices a Polymarket US side Polymarket has no tight book on', () => {
  // Kalshi Boston 52/49 → bid 51, mid 51.5; Knicks (NO Boston) fair 48.5. PM US Knicks ask 44.
  const k = kRow({ yesAsk: 0.52, noAsk: 0.49 });
  const us = usRow({ yesAsk: 0.44, noAsk: 0.58 });
  const wide = pRow({ yesAsk: 0.62, noAsk: 0.44 });            // a 6¢ Polymarket book: no ref
  const usMatches = [match(k, us, false)];
  const { edges, kalshiPriced } = V.findValue({ usRows: [us], polymarket: [wide], usMatches }, { now: NOW, venues: ['polymarketus'] });
  const e = edges.find(x => x.pick === 'Knicks');
  assert.ok(e);
  assert.equal(kalshiPriced, 1);
  assert.equal(e.fair, 0.485);
  assert.equal(e.refName, 'Kalshi');
  assert.equal(e.ref.venue, 'kalshi');
  assert.equal(e.refToken, null);                               // nothing to read on Polymarket
  assert.equal(V.trackRows([e])[0].source, 'kalshiref');
  assert.match(V.describe(e), /Kalshi 48\.5¢/);
  // a tight Polymarket book wins: Kalshi isn't used
  const tight = V.findValue({ usRows: [us], polymarket: [pRow()], usMatches }, { now: NOW, venues: ['polymarketus'] });
  assert.equal(tight.kalshiPriced, 0);
  assert.ok(tight.edges.every(x => x.ref.venue === 'polymarket'));
  // a wide Kalshi market prices nothing
  const kw = kRow({ yesAsk: 0.55, noAsk: 0.49 });
  assert.equal(V.findValue({ usRows: [us], polymarket: [wide], usMatches: [match(kw, us, false)] }, { now: NOW, venues: ['polymarketus'] }).kalshiPriced, 0);
  // the PRICES screen takes Kalshi's mid too, marked
  const row = { id: us.id, sides: [{ pick: 'Knicks', kalshi: 0.5, other: 0.45 }, { pick: 'Celtics', kalshi: 0.53, other: 0.59 }] };
  const [r] = V.screenFairs([row], { usRows: [us], polymarket: [wide], usMatches });
  assert.equal(r.fairBy, 'kalshi');
  assert.equal(r.sides[0].fair, 0.485);
});
