const test = require('node:test');
const assert = require('node:assert/strict');
const kp = require('../kprops');
const ev = require('../ev');
const { bestPlays } = require('../bestplays');

const NOW = Date.parse('2026-10-12T17:00:00Z');
const rung = (n, bid, ask, extra = {}) => ({
  ticker: `KXMLBKS-26OCT121700LADMIL-MILLHENDERSON43-${n}`, title: `Logan Henderson: ${n}+ strikeouts?`,
  floor_strike: n - 0.5, strike_type: 'greater', yes_bid_dollars: String(bid), yes_ask_dollars: String(ask),
  expected_expiration_time: '2026-10-13T00:00:00Z', ...extra,
});
// copied from Kalshi's KXMLBKS ladder on 2026-10-12
const event = {
  event_ticker: 'KXMLBKS-26OCT121700LADMIL', title: 'Los Angeles D vs Milwaukee: Strikeouts',
  markets: [rung(3, 0.90, 0.93), rung(4, 0.79, 0.82), rung(5, 0.63, 0.64), rung(6, 0.45, 0.46), rung(7, 0.20, 0.40)],
};
const ud = (line, over = 1, under = 1, extra = {}) => ({ book: 'underdog', sport: 'MLB', player: 'Logan Henderson', market: 'Strikeouts', line,
  startTime: '2026-10-12T21:05:00Z', overMultiplier: over, underMultiplier: under, ...extra });

test('kprops: rung titles give player and stat', () => {
  assert.deepEqual(kp.parseRung('Amon-Ra St. Brown: 50+ receiving yards'), { player: 'Amon-Ra St. Brown', stat: 'receiving yards' });
  assert.deepEqual(kp.parseRung('Logan Henderson: 6+ strikeouts?'), { player: 'Logan Henderson', stat: 'strikeouts' });
  assert.equal(kp.parseRung('Who wins?'), null);
});

test('kprops: ladders keep tight rungs at the mid, drop wide and expired ones', () => {
  const lads = kp.laddersFromEvent(event, kp.DEFAULTS, NOW);
  const l = lads.get('loganhenderson|strikeouts');
  assert.deepEqual(l.rungs.map(r => r.strike), [2.5, 3.5, 4.5, 5.5]);   // the 20/40 rung is too wide
  assert.ok(Math.abs(l.rungs[3].p - 0.455) < 1e-9);
  const old = kp.laddersFromEvent(event, kp.DEFAULTS, Date.parse('2026-10-14T00:00:00Z'));
  assert.equal(old.size, 0);
});

test('kprops: probability on a rung, between close rungs, never across a wide gap', () => {
  const rungs = [{ strike: 39.5, p: 0.855 }, { strike: 49.5, p: 0.75 }, { strike: 59.5, p: 0.645 }];
  assert.deepEqual(kp.probAt(rungs, 49.5), { p: 0.75, interpolated: false });
  const mid = kp.probAt(rungs, 54.5);
  assert.ok(mid.interpolated && Math.abs(mid.p - 0.6975) < 1e-9);
  assert.equal(kp.probAt([{ strike: 2.5, p: 0.9 }, { strike: 5.5, p: 0.45 }], 4.5), null);
  assert.equal(kp.probAt(rungs, 70.5), null);
});

test('kprops: Underdog lines price through the EV screener against the ladder', () => {
  const lines = [ud(5.5, 1, 1), ud(4.5, 1, 1, { player: 'Somebody Else' }), ud(5, 1, 1)];
  const { games, counts } = kp.buildGames([{ ev: event, league: 'MLB' }], lines, kp.DEFAULTS, NOW);
  assert.equal(counts.matched, 1);   // whole-number line and unknown player skipped
  assert.equal(games[0].sport_key, 'MLB');
  assert.equal(games[0].away_team, 'Los Angeles D');
  const rows = ev.screen({ feeds: [{ sport: null, games }], dfsLines: lines, now: NOW, minEv: -100,
    dfsEv: (p, book, mult) => (p * mult / 0.5623 - 1) * 100 });
  const under = rows.find(r => r.dfs && r.side === 'Under');
  assert.ok(Math.abs(under.fairProb - 54.5) < 0.6);
  assert.deepEqual(under.sharpBooks, ['kalshi_props']);
});

test('kprops: a line in a game after the ladder settles is not matched', () => {
  const { counts } = kp.buildGames([{ ev: event, league: 'MLB' }], [ud(5.5, 1, 1, { startTime: '2026-10-14T21:05:00Z' })], kp.DEFAULTS, NOW);
  assert.equal(counts.matched, 0);
});

test('best plays: +EV pick\'em sports props come in as 1u rows', () => {
  const start = new Date(NOW + 3600e3).toISOString();
  const props = [
    { dfs: true, group: 'g|strikeouts|loganhenderson|5.5', side: 'Under', book: 'underdog', sport: 'MLB', player: 'Logan Henderson', point: 5.5, market: 'strikeouts', ev: 4.2, fairProb: 58.6, start, sharpBooks: ['kalshi_props'] },
    { dfs: true, group: 'g2', side: 'Over', book: 'underdog', sport: 'MLB', player: 'X', point: 1.5, market: 'hits', ev: 1, fairProb: 57, start, sharpBooks: ['kalshi_props'] },
  ];
  const out = bestPlays({ props }, { now: NOW });
  assert.equal(out.counts.sportsProp, 1);
  const r = out.rows[0];
  assert.equal(r.bet, 'Less than 5.5 strikeouts');
  assert.equal(r.venue, 'Underdog');
  assert.equal(r.units, 1);
  assert.match(r.why[0], /Kalshi prices it at 58.6%/);
});

test('kprops: Kalshi wordings meet Underdog names (TDs, rush + rec, attempts, completions, hits allowed)', () => {
  const td = (name, n, bid, ask, stat) => ({ ticker: `KXNFLTD-X-${name}-${n}`, title: `${name}: ${n}+ ${stat}`, floor_strike: n - 0.5,
    strike_type: 'greater', yes_bid_dollars: String(bid), yes_ask_dollars: String(ask), expected_expiration_time: '2026-10-13T03:15:00Z' });
  const evt = { event_ticker: 'KXNFLTD-26OCT12', title: 'Los Angeles R vs Detroit: Touchdowns', markets: [
    td('Davante Adams', 1, 0.41, 0.43, 'touchdowns'), td('Kyren Williams', 60, 0.55, 0.57, 'rushing and receiving yards combined'),
    td('Kyren Williams', 15, 0.48, 0.50, 'rushing attempts'), td('Matthew Stafford', 21, 0.52, 0.54, 'passing completions')] };
  const line = (player, market, l) => ({ book: 'underdog', sport: 'NFL', player, market, line: l, startTime: '2026-10-13T00:15:00Z', overMultiplier: 1, underMultiplier: 1 });
  const { games, counts } = kp.buildGames([{ ev: evt, league: 'NFL' }], [
    line('Davante Adams', 'Anytime TD', 0.5), line('Kyren Williams', 'Rush + Rec Yards', 59.5),
    line('Kyren Williams', 'Rush Attempts', 14.5), line('Matthew Stafford', 'Completions', 20.5)], kp.DEFAULTS, NOW);
  assert.equal(counts.matched, 4);
  assert.deepEqual(games[0].books[0].props.map(p => p.market).sort(), ['anytime_td', 'pass_comp', 'rush_att', 'rush_rec_yds']);
});

test('kprops: series are fetched with a pause, and a 429 waits and tries once more', async () => {
  let n = 0;
  const http = { get: async (url, { params }) => {
    n++;
    if (params.series_ticker === 'A' && n === 1) { const e = new Error('429'); e.response = { status: 429 }; throw e; }
    if (params.series_ticker === 'B') { const e = new Error('429'); e.response = { status: 429 }; throw e; }
    return { data: { events: [{ event_ticker: params.series_ticker }] } };
  } };
  const out = await kp.fetchEvents(http, { NFL: ['A', 'B', 'C'] }, { pause: 0, retryAfter: 0 });
  assert.deepEqual(out.events.map(e => e.ev.event_ticker), ['A', 'C']);
  assert.deepEqual(out.errors, ['B: 429']);
  assert.equal(n, 5);
});
