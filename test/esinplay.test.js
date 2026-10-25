const test = require('node:test');
const assert = require('node:assert/strict');
const I = require('../esinplay');

const NOW = Date.parse('2026-10-24T22:30:00Z');
const near = (a, b, tol = 1e-3) => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b}`);

test('round maps: CS2 MR12 + MR3 overtime, Valorant win by two', () => {
  near(I.mapWinGivenQ('CS2', 0.5), 0.5);
  near(I.mapWinGivenQ('CS2', 0.5, 12, 12), 0.5);
  near(I.mapWinGivenQ('CS2', 0.5, 15, 12), 1 - 0.5 ** 4);     // 3:0 in overtime: needs 1 of the next 4
  near(I.mapWinGivenQ('CS2', 0.5, 16, 12), 1);
  near(I.mapWinGivenQ('CS2', 0.6, 15, 15), I.csOtBlock(0.6));  // a fresh overtime block
  near(I.mapWinGivenQ('VAL', 0.5, 13, 12), 0.75);
  near(I.mapWinGivenQ('VAL', 0.5, 14, 12), 1);
  assert.ok(I.mapWinGivenQ('CS2', 0.55) > 0.69 && I.mapWinGivenQ('CS2', 0.55) < 0.72);
});

test('round rate from a map price, and the Beta update on rounds played', () => {
  const q0 = I.roundRateFor('CS2', 0.7, 35);
  near(I.mapWin('CS2', q0, 0, 0, 35), 0.7, 2e-3);
  // trailing 3:8 hurts more when the rounds also say the team is weaker
  assert.ok(I.mapWin('CS2', q0, 3, 8, 35) < I.mapWinGivenQ('CS2', q0, 3, 8));
});

test('series: maps won, the live map and Beta-correlated future maps', () => {
  const m0 = I.mapRateFor(0.75, 3);
  near(I.seriesWin(m0, 0, 0, 3), 0.75, 2e-3);
  near(I.seriesWin(m0, 1, 0, 3, 1), 1);
  near(I.seriesWin(m0, 0, 1, 3, 0), 0);
  assert.ok(I.seriesWin(m0, 0, 1, 3) < 0.5 && I.seriesWin(m0, 1, 1, 3) > 0.6);
  near(I.mapRateFor(0.6, 1), 0.6);
});

test('edge: fair minus the all-in cost (fee included) at real size', () => {
  const f = I.edgeOf(0.70, { yesAsk: 0.62, yesAskSize: 50, noAsk: 0.40, noAskSize: 50 });
  assert.equal(f.length, 1);
  assert.equal(f[0].side, 'yes');
  assert.ok(f[0].cost > 0.62 && f[0].cost < 0.64);
  assert.ok(f[0].edge >= 0.06 && f[0].edge <= 0.08);
  assert.equal(I.edgeOf(0.70, { yesAsk: 0.62, yesAskSize: 5, noAsk: 0.40, noAskSize: 5 }).length, 0, 'too little size');
  assert.equal(I.edgeOf(0.99, { yesAsk: 0.97, yesAskSize: 500 }).length, 0, 'over 95c is left alone');
  assert.equal(I.edgeOf(0.30, { yesAsk: 0.62, yesAskSize: 50, noAsk: 0.40, noAskSize: 50 })[0].side, 'no');
});

test('tickers: game, map number and the start in Eastern time', () => {
  const t = I.parseTicker('KXCS2MAP-26OCT241200YAWGRE-2');
  assert.deepEqual([t.game, t.kind, t.base, t.map], ['CS2', 'map', '26OCT241200YAWGRE', 2]);
  assert.equal(new Date(t.start).toISOString(), '2026-10-24T16:00:00.000Z');
  assert.equal(I.parseTicker('KXDOTA2GAME-26OCT231400HULIC').game, 'DOTA');
  assert.equal(I.parseTicker('KXVALORANTMAP-26OCT241700SKNSRGC-3').game, 'VAL');
  assert.equal(I.parseTicker('KXNFLGAME-26OCT25DALWAS'), null);
});

const mk = (ticker, team, bid, ask, bs = 100, as = 100) => ({ ticker, yes_sub_title: team, status: 'active', yes_bid_dollars: String(bid), yes_ask_dollars: String(ask), yes_bid_size_fp: String(bs), yes_ask_size_fp: String(as) });
const events = [
  { event_ticker: 'KXCS2GAME-26OCT241800AAABBB', title: 'Alpha vs. Bravo', markets: [mk('KXCS2GAME-26OCT241800AAABBB-AAA', 'Alpha', 0.58, 0.60), mk('KXCS2GAME-26OCT241800AAABBB-BBB', 'Bravo', 0.40, 0.42)] },
  { event_ticker: 'KXCS2MAP-26OCT241800AAABBB-1', markets: [mk('KXCS2MAP-26OCT241800AAABBB-1-AAA', 'Alpha', 0.40, 0.42), mk('KXCS2MAP-26OCT241800AAABBB-1-BBB', 'Bravo', 0.58, 0.60)] },
  { event_ticker: 'KXCS2MAP-26OCT291800CCCDDD-1', markets: [mk('X', 'Charlie', 0.5, 0.52)] },   // days away
];

test('Kalshi events group into one series with its match and map markets', () => {
  const s = I.groupKalshi(events, { now: NOW });
  assert.equal(s.length, 1);
  assert.deepEqual(s[0].teams, ['Alpha', 'Bravo']);
  assert.ok(s[0].match && s[0].maps[1]);
  // team mid from both books: Alpha 0.41 own, 1 − 0.59 from Bravo's
  near(I.teamMid(s[0].maps[1].books[0], s[0].maps[1].books[1]), 0.41);
});

test('bo3 live match → round score from the live game, series from finished maps', () => {
  const m = { slug: 'alpha-vs-bravo-24-10-2026', bo_type: 3 };
  const games = [{ id: 1, number: 1, status: 'finished', winner_clan_name: 'Bravo' }, { id: 2, number: 2, status: 'current', begin_at: '2026-10-24T22:00:00Z' }];
  const rounds = [{ winner_clan_name: 'Alpha' }, { winner_clan_name: 'Alpha' }, { winner_clan_name: 'Bravo' }];
  const st = I.csState(m, games, rounds, NOW);
  assert.deepEqual(st.teams, ['alpha', 'bravo']);
  assert.deepEqual(st.series, [0, 1]);
  assert.deepEqual(st.score, [2, 1]);
  assert.equal(st.map, 2);
  assert.deepEqual(I.alignTeams(['Bravo', 'Alpha'], st.teams), [1, 0]);
  const fl = I.flipState(st);
  assert.deepEqual([fl.score, fl.series], [[1, 2], [1, 0]]);
});

test('LoL frame → gold/towers/dragons diffs from team A, the side read from metadata', () => {
  const ev = { match: { strategy: { count: 3 }, teams: [] } };
  const det = { teams: [{ id: 'a', name: 'T1', code: 'T1', result: { gameWins: 1 } }, { id: 'b', name: 'Dplus KIA', code: 'DK', result: { gameWins: 0 } }], games: [{ number: 2, id: 'g2', state: 'inProgress' }] };
  const side = (gold, kills, towers, drakes) => ({ totalGold: gold, totalKills: kills, towers, inhibitors: 0, barons: 0, dragons: drakes });
  const frame = { rfc460Timestamp: '2026-10-24T22:20:00Z', gameState: 'in_game', blueTeam: side(30000, 5, 2, ['ocean']), redTeam: side(33000, 8, 3, ['infernal', 'cloud']) };
  const st = I.lolState(ev, det, frame, { blueTeamMetadata: { esportsTeamId: 'b' }, redTeamMetadata: { esportsTeamId: 'a' } }, Date.parse('2026-10-24T22:00:00Z'));
  assert.equal(st.minute, 20);
  assert.deepEqual(st.series, [1, 0]);
  assert.equal(st.map, 2);
  assert.deepEqual(st.x, { gd: 3, kd: 3, td: 1, id: 0, bd: 0, dd: 1 });   // T1 is red here
});

test('evaluate: needs a pre-map anchor and a fresh feed; flags the cheaper way to back a team', () => {
  const [sr] = I.groupKalshi(events, { now: NOW });
  const st = { game: 'CS2', teams: ['Alpha', 'Bravo'], series: [0, 0], bo: 3, map: 1, score: [9, 3], at: NOW - 5e3, finished: false };
  assert.equal(I.evaluate(sr, st, {}, { now: NOW }).flags.length, 0, 'no anchor, no flag');
  assert.equal(I.evaluate(sr, { ...st, at: NOW - 5 * 60e3 }, { [`${sr.key}:map1`]: 0.45 }, { now: NOW }).stale, true);
  const ev = I.evaluate(sr, st, { [`${sr.key}:map1`]: 0.45, [`${sr.key}:match`]: 0.59 }, { now: NOW });
  assert.ok(ev.pMap > 0.7, `pMap ${ev.pMap}`);
  const mapFlag = ev.flags.find(f => f.kind === 'map');
  assert.equal(mapFlag.backs, 'Alpha');
  assert.ok(mapFlag.edge >= 0.03);
  assert.ok(ev.pMatch > 0.59);
  assert.equal(ev.flags.filter(f => f.kind === 'map' && f.backs === 'Alpha').length, 1, 'one flag per team and market');
});

test('tracker: logs once per market side per 3 minutes, marks the mid, grades from Kalshi; first flag per map counts', async () => {
  let t = NOW;
  const http = { get: async () => ({ data: { market: { result: 'yes' } } }) };
  const tr = I.createInplayTracker({ http, now: () => t });
  const f = { ticker: 'KXCS2MAP-26OCT241800AAABBB-1-AAA', side: 'yes', series: 'CS2:26OCT241800AAABBB', kind: 'map', map: 1, backs: 'Alpha', game: 'CS2', fair: 0.75, ask: 0.42, cost: 0.4363, edge: 0.31, size: 100, mid: 0.41 };
  assert.equal((await tr.record([f])).length, 1);
  t += 60e3;
  assert.equal((await tr.record([f])).length, 0, 'within 3 minutes');
  const books = new Map([[f.ticker, { yesBid: 0.50, yesAsk: 0.52 }]]);
  await tr.mark(books);
  t += 4 * 60e3;
  assert.equal((await tr.record([f])).length, 1);
  await tr.mark(books);
  const rows = await tr.list();
  assert.equal(rows[0].marks.s15, 0.51);
  assert.equal(rows[0].marks.m1, 0.51);
  assert.deepEqual(rows.map(r => r.first), [true, false]);
  t += 20 * 60e3;
  assert.equal(await tr.grade(), 2);
  const s = I.summarize(await tr.list());
  assert.equal(s.counted.graded, 1);
  assert.equal(s.all.graded, 2);
  assert.equal(s.counted.wins, 1);
  assert.equal(s.verdict, 'not enough graded');
  assert.ok(s.counted.gapClosed1m > 0);
});

test('midAt: the latest mid at or before a time, inside the window', () => {
  const h = [[100, 0.4], [200, 0.45], [300, 0.5]];
  assert.equal(I.midAt(h, 250, 1000), 0.45);
  assert.equal(I.midAt(h, 50, 1000), null);
  assert.equal(I.midAt(h, 5000, 1000), null);
});
