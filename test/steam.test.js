const test = require('node:test');
const assert = require('node:assert/strict');
const { createSteamWatch, moveText } = require('../steam');
const V = require('../xvalue');
const { kalshiFee } = require('../exchanges');
const B = require('../bestplays');
const R = require('../results');

const T0 = Date.parse('2026-10-13T12:00:00Z');
const MIN = 60e3;
const q = (fair, cost, spread = 0.01) => new Map([['k|1|yes', { fair, cost, spread }]]);

test('a Polymarket jump the venue hasn\'t followed is steam', () => {
  const w = createSteamWatch();
  w.observe(q(0.48, 0.495), T0);
  w.observe(q(0.49, 0.495), T0 + 2 * MIN);
  const s = w.steamOf('k|1|yes', 0.53, 0.5, T0 + 6 * MIN);
  assert.ok(s, 'steaming');
  assert.equal(s.from, 0.48);
  assert.equal(s.to, 0.53);
  assert.equal(s.move, 0.05);
  assert.equal(s.sinceMs, 6 * MIN);
  assert.equal(moveText(s, 'Kalshi'), 'Polymarket moved 48¢ → 53¢ in 6 min, Kalshi moved +0.5¢');
  assert.equal(w.candidates(q(0.53, 0.5), T0 + 6 * MIN).length, 1);
});

test('a small move, a venue that followed, an old low or a wide book is not steam', () => {
  const w = createSteamWatch();
  w.observe(q(0.48, 0.495), T0);
  assert.equal(w.steamOf('k|1|yes', 0.5, 0.495, T0 + MIN), null, '2¢ is under the 3¢ move');
  assert.equal(w.steamOf('k|1|yes', 0.53, 0.52, T0 + MIN), null, 'the venue moved 2.5¢ of 5¢');
  assert.equal(w.steamOf('k|1|yes', 0.53, 0.495, T0 + 25 * MIN), null, 'the low is outside the window');
  const wide = createSteamWatch();
  wide.observe(q(0.4, 0.495, 0.06), T0);
  assert.equal(wide.steamOf('k|1|yes', 0.53, 0.495, T0 + MIN), null, 'a wide book never enters the history');
  // the current scan's own quote is never its own low
  const same = createSteamWatch();
  same.observe(q(0.48, 0.495), T0);
  assert.equal(same.steamOf('k|1|yes', 0.48, 0.495, T0), null);
});

const START = '2026-10-13T23:00:00Z';
const kRow = (o = {}) => ({
  exchange: 'kalshi', id: 'KXNBAGAME-26OCT13NYKBOS-BOS', eventKey: 'kalshi:KXNBAGAME-26OCT13NYKBOS', eventTitle: 'New York at Boston',
  title: 'New York at Boston Winner?', outcomeLabel: 'Boston', noLabel: 'New York', kind: 'teams', yesAsk: 0.52, noAsk: 0.5,
  startTime: START, tradable: true, league: 'nba', category: 'sports', ...o,
});
const pRow = (yesAsk, noAsk) => ({
  exchange: 'polymarket', id: '555', eventKey: 'polymarket:1', eventTitle: 'Knicks vs. Celtics', title: 'Knicks vs. Celtics',
  outcomeLabel: 'Celtics', noLabel: 'Knicks', kind: 'teams', yesAsk, noAsk, gameSlug: 'nba-nyk-bos-2026-10-13',
  startTime: START, tradable: true, liquidity: 50000, league: 'nba', category: 'sports', tokenIds: ['t1', 't2'],
});

test('xvalue: a steaming side is a bet from the steam minimum, tagged and tracked as steam', () => {
  const k = kRow({ yesAsk: 0.51 });
  const cost = 0.51 + kalshiFee(0.51, 100) / 100;
  const input = p => ({ matches: [{ kalshi: k, polymarket: p, same: true, by: 'teams' }], kalshi: [k] });
  // Boston's fair goes 50.5 → 53.5, Kalshi still sells 51: about +1.4%, under the 2% gap minimum
  const w = createSteamWatch();
  const before = V.screen(input(pRow(0.51, 0.5)), { now: T0 });
  assert.ok(before.quotes.has(`kalshi|${k.id}|yes`), 'every paired side is quoted');
  w.observe(before.quotes, T0);
  const plain = V.findValue(input(pRow(0.54, 0.47)), { now: T0 + 5 * MIN });
  assert.ok(!plain.edges.some(e => e.side === 'yes'), 'no edge without steam');
  const { edges } = V.findValue(input(pRow(0.54, 0.47)), { now: T0 + 5 * MIN, steam: w, steamMinEv: 0.01 });
  const e = edges.find(x => x.side === 'yes');
  assert.ok(e && e.steam, 'steam edge');
  assert.ok(Math.abs(e.ev - (0.535 / cost - 1)) < 1e-3);
  assert.equal(e.steam.from, 0.505);
  assert.equal(V.trackRows([e])[0].source, 'steam');
  assert.match(V.describe(e), /^STEAM: Polymarket moved 50.5¢ → 53.5¢ in 5 min, Kalshi hasn't moved\./);
  // Best Plays says why
  const { rows } = B.bestPlays({ value: [e] }, { now: T0 + 5 * MIN });
  assert.equal(rows.length, 1);
  assert.match(rows[0].why[0], /^Steam: Polymarket moved/);
  assert.match(rows[0].label, /NBA steam/);
});

test('results cut exchange value into steam and price gaps', () => {
  const mk = (source, clv, i) => ({ id: `b${i}`, status: 'closed', source, clv, sport: 'nba', book: 'kalshi', market: 'moneyline', flaggedAt: '2026-10-13T00:00:00Z' });
  const list = [...[1, 2, 3].map(i => mk('steam', 3, i)), ...[4, 5, 6].map(i => mk('xvalue', -4, i))];
  const { plays } = R.scoreboard({ exchangeValue: list });
  const steam = plays.find(p => p.source === 'exchangeValue' && p.play === 'steam');
  const gap = plays.find(p => p.source === 'exchangeValue' && p.play === 'price gap');
  assert.ok(steam && gap);
  assert.ok(steam.avgClv > 0 && gap.avgClv < 0);
});

test('book reads: steam first, then the stalest, never-read before read', () => {
  const now = T0;
  const cache = new Map([['a', { at: now - 60e3 }], ['b', { at: now - 180e3 }]]);
  assert.deepEqual(V.planReads({ urgent: ['s'], rest: ['a', 'b', 'c', 's'], cache, now, max: 3 }), ['s', 'c', 'b']);
  assert.deepEqual(V.planReads({ urgent: [], rest: ['a', 'b'], cache, now, max: 5 }), ['b', 'a']);
});

test('the same outcome on both Kalshi team markets is one bet, the cheaper one', () => {
  const e = (id, ev) => ({ id, venue: 'kalshi', refId: '9', fair: 0.425, start: 'x', ev });
  const out = V.dedupeEdges([e('A|yes', 0.045), e('B|no', 0.02), { ...e('C|yes', 0.03), fair: 0.575 }]);
  assert.deepEqual(out.map(x => x.id), ['A|yes', 'C|yes']);
});
