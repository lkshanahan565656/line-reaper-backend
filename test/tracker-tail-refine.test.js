const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../tail');
const { closeOut, toRecord } = require('../tailtrack');
const { scoreboard } = require('../results');
const { createLoLGrader, createCsGrader, lpName, bo3TeamMatch, bo3Candidates, bo3PlayerStat } = require('../graders');

const NOW = Date.parse('2026-10-12T12:00:00Z');
const DAY = 86400e3;

// ── Sharp Tail: thin edges ──
test('sizeAt: a positive Kelly under 1% expected return is thin, and the bar rises a week at a time', () => {
  // a 93¢ favourite with 0.6¢ of edge: Kelly says 8.6% of bankroll, the return is 0.65%
  const fav = T.sizeAt({ q: 0.936, price: 0.93, grade: 'B' });
  assert.ok(fav.kelly > 0);
  assert.equal(fav.thin, true);
  assert.equal(fav.units, 0);
  // 2.4% at 41¢ sizes on a game or this week...
  assert.ok(T.sizeAt({ q: 0.42, price: 0.41, grade: 'A' }).units > 0);
  assert.ok(T.sizeAt({ q: 0.42, price: 0.41, grade: 'A', days: 7 }).units > 0);
  // ...but not tied up for 4 weeks (bar 4%) or 2 months
  assert.equal(T.sizeAt({ q: 0.42, price: 0.41, grade: 'A', days: 28 }).units, 0);
  assert.equal(T.sizeAt({ q: 0.42, price: 0.41, grade: 'A', days: 28 }).thin, true);
  // a big edge on a far market still sizes: 20% over 8 weeks clears 8%
  assert.ok(T.sizeAt({ q: 0.42, price: 0.35, grade: 'B', days: 56 }).units > 0);
  // the most worth paying clears the bar: q 0.42 at 1% → 41¢ (2.4%), 4 weeks (4%) → 40¢ (5%)
  assert.equal(T.sizeAt({ q: 0.42, price: 0.3, grade: 'A' }).maxPrice, 0.41);
  assert.equal(T.sizeAt({ q: 0.42, price: 0.3, grade: 'A', days: 28 }).maxPrice, 0.4);
  // off
  assert.ok(T.sizeAt({ q: 0.936, price: 0.93, grade: 'B', opts: { minEv: 0 } }).units > 0);
  assert.equal(T.optionsFromEnv({ TAIL_MIN_EV: '2' }).minEv, 0.02);
});

test('daysOut: games settle within hours, other markets at their end date', () => {
  const m = o => T.parseGammaMarket({ conditionId: '0x1', outcomes: '["Yes","No"]', outcomePrices: '["0.5","0.5"]', active: true, ...o });
  assert.equal(T.daysOut(m({ endDate: '2026-10-19T12:00:00Z' }), NOW), 7);
  assert.equal(T.daysOut(m({ endDate: '2026-10-19T12:00:00Z', gameStartTime: '2026-10-12 18:00:00+00' }), NOW), 0);
  assert.equal(T.daysOut(m({}), NOW), null);
  assert.equal(T.daysOut(null, NOW), null);
});

test('tradeSignal: a sharp buying a favourite with a sliver of edge on a far market gets 0u and says why', () => {
  const trader = { wallet: '0x' + '9'.repeat(40), name: 'ed', grade: 'B', edge: 0.0134, avgEntry: 0.5, categories: {} };
  const trade = T.parseTrades([{ proxyWallet: trader.wallet, side: 'BUY', asset: 'tok-yes', conditionId: '0xm9', size: 2000, price: 0.82,
    timestamp: Math.floor((NOW - 60e3) / 1000), title: 'Will the U.S. invade Iran before 2027?', slug: 'invade', eventSlug: 'invade', outcome: 'No', outcomeIndex: 1, name: 'ed', transactionHash: '0xtx9' }])[0];
  const market = T.parseGammaMarket({ conditionId: '0xm9', question: 'Will the U.S. invade Iran before 2027?', outcomes: '["Yes","No"]', outcomePrices: '["0.18","0.82"]',
    clobTokenIds: '["tok-yes2","tok-yes"]', bestBid: '0.18', bestAsk: '0.19', lastTradePrice: '0.18', endDate: '2026-12-31T12:00:00Z', active: true, closed: false });
  const s = T.tradeSignal({ trade, trader, market, now: NOW }).signal;
  assert.equal(s.days, 80);
  assert.equal(s.units, 0);
  assert.match(s.reason, /too thin for money tied up 80 days/);
});

// ── Sharp Tail record: CLV at kick-off ──
const sig = (o = {}) => ({ type: 'entry', id: 'x1', wallet: '0xw', grade: 'B', conditionId: '0xm', asset: 'tok', outcome: 'A', outcomeIndex: 0, currentPrice: 0.5, units: 1, ...o });
const mkt = (o = {}) => ({ closed: false, active: true, gameStartTime: '2026-10-12T15:00:00Z', endDate: '2026-10-12T15:00:00Z', prices: [0.55, 0.45], outcomes: ['A', 'B'], ...o });

test('closeOut: a game\'s CLV is in at kick-off, before it resolves; not before, and not for a bid still waiting', () => {
  const rec = toRecord(sig(), NOW);
  rec.closePrice = 0.55;
  assert.equal(closeOut(rec, mkt(), Date.parse('2026-10-12T14:59:00Z')), false, 'not started');
  assert.equal(closeOut(rec, mkt(), Date.parse('2026-10-12T15:01:00Z')), true);
  assert.equal(rec.clv, 0.1);
  assert.equal(rec.status, 'open');
  assert.equal(closeOut(rec, mkt(), Date.parse('2026-10-12T16:00:00Z')), false, 'once');
  // an election: only when the price jumps to the outcome
  const far = toRecord(sig({ id: 'x2' }), NOW);
  far.closePrice = 0.6;
  assert.equal(closeOut(far, mkt({ gameStartTime: null }), NOW + 5 * DAY), false);
  far.closeFrozen = true;
  assert.equal(closeOut(far, mkt({ gameStartTime: null }), NOW + 5 * DAY), true);
  // a resting bid that hasn't filled has no bet to measure
  const bid = toRecord(sig({ id: 'x3', units: 0, limit: { price: 0.48, units: 0.5, fee: 0 } }), NOW);
  bid.closePrice = 0.55;
  assert.equal(closeOut(bid, mkt(), Date.parse('2026-10-12T15:01:00Z')), false);
});

test('results: open tails with their close in count toward CLV, not ROI, and still show as open', () => {
  const at = new Date(NOW).toISOString();
  const rows = [
    ...Array.from({ length: 8 }, (_, i) => ({ id: `o${i}`, status: 'open', recordedAt: at, grade: 'B', category: 'sports', units: 1, clv: 0.04 + i / 1000 })),
    { id: 'w', status: 'open', recordedAt: at, grade: 'B', category: 'sports', units: 1, clv: null },
    { id: 'b', status: 'open', recordedAt: at, grade: 'B', category: 'sports', units: 1, clv: 0.2, order: 'limit', filled: false },
  ];
  const { sources } = scoreboard({ tail: rows });
  assert.equal(sources.tail.open, 10);
  assert.equal(sources.tail.overall.clvN, 8);
  assert.equal(sources.tail.overall.graded, 0);
  assert.equal(sources.tail.overall.verdict, 'promising');
});

// ── pick tracker graders ──
test('LoL: one Cargo query per kickoff serves every player on it', async () => {
  let calls = 0;
  const http = { get: async () => { calls++; return { data: { cargoquery: [
    { title: { Link: 'Angel (Xiang Tao)', Kills: '3', Assists: '9', MatchId: 'M1', GameN: '1', DateTime: '2026-10-12 06:10:00' } },
    { title: { Link: 'Angel (Xiang Tao)', Kills: '5', Assists: '4', MatchId: 'M1', GameN: '2', DateTime: '2026-10-12 07:00:00' } },
    { title: { Link: 'Kellin', Kills: '0', Assists: '12', MatchId: 'M1', GameN: '1', DateTime: '2026-10-12 06:10:00' } },
    { title: { Link: 'Kellin', Kills: '1', Assists: '8', MatchId: 'M1', GameN: '2', DateTime: '2026-10-12 07:00:00' } },
  ] } }; } };
  const grade = createLoLGrader(http, { now: () => NOW });
  const startTime = '2026-10-12T06:00:00.000Z';
  assert.deepEqual((await grade({ player: 'Angel', stat: 'kills', startTime })).maps, { 1: 3, 2: 5 });
  assert.deepEqual((await grade({ player: 'kellin', stat: 'assists', startTime })).maps, { 1: 12, 2: 8 });
  assert.equal(await grade({ player: 'Nobody', stat: 'kills', startTime }), null);
  assert.equal(calls, 1);
  assert.equal(lpName('Faker'), 'faker');
});

const bo3Game = (id, number, a = 'Vitality', b = 'NAVI') => ({ id, number, status: 'finished',
  winner_team_clan: { clan_name: a, team: { name: a, slug: a.toLowerCase(), acronym: 'VIT' } }, loser_team_clan: { clan_name: b, team: { name: b, slug: b.toLowerCase() } } });
const bo3Row = (nick, kills, headshots) => ({ kills, headshots, assists: 4, death: 15, steam_profile: { nickname: nick, player: { nickname: nick, slug: nick.toLowerCase() } } });

test('bo3 helpers: team names either way round, candidates near kickoff with the team first, stats by nickname', () => {
  const m1 = { id: 1, slug: 'vit-navi', status: 'finished', start_date: '2026-10-12T15:00:00.000+00:00', games: [bo3Game(11, 1)] };
  const m2 = { id: 2, slug: 'other', status: 'finished', start_date: '2026-10-12T14:00:00.000+00:00', games: [bo3Game(21, 1, 'MOUZ', 'G2')] };
  const m3 = { id: 3, slug: 'old', status: 'finished', start_date: '2026-10-11T15:00:00.000+00:00', games: [bo3Game(31, 1)] };
  assert.ok(bo3TeamMatch(m1, 'Team Vitality'));
  assert.ok(bo3TeamMatch(m1, 'VIT'));
  assert.ok(!bo3TeamMatch(m2, 'Vitality'));
  const c = bo3Candidates([m2, m1, m3], { team: 'Vitality', startTime: '2026-10-12T14:30:00Z' });
  assert.deepEqual(c.map(x => x.m.id), [1, 2]);
  assert.equal(bo3PlayerStat([bo3Row('ZywOo', 24, 9)], 'zywoo', 'kills'), 24);
  assert.equal(bo3PlayerStat([bo3Row('ZywOo', 24, 9)], 'ZywOo', 'headshots'), 9);
  assert.equal(bo3PlayerStat([bo3Row('ZywOo', 24, 9)], 'flameZ', 'kills'), undefined);
});

test('CS grader: maps from bo3, complete only when every map has stats; the match list is fetched once', async () => {
  const match = { id: 7, slug: 'vit-navi', status: 'finished', start_date: '2026-10-12T15:00:00.000+00:00', games: [bo3Game(72, 2), bo3Game(71, 1), bo3Game(73, 3)] };
  const stats = { 71: [bo3Row('ZywOo', 20, 8)], 72: [bo3Row('ZywOo', 17, 6)], 73: [] };
  let listCalls = 0;
  const http = { get: async (url) => {
    if (url.endsWith('/matches')) { listCalls++; return { data: { results: [match] } }; }
    const id = Number(url.match(/games\/(\d+)\//)[1]);
    return { data: stats[id] };
  } };
  const grade = createCsGrader(http, { now: () => NOW, pause: 0, emptyTtlMs: 0 });
  const pick = { player: 'ZywOo', team: 'Vitality', stat: 'kills', startTime: '2026-10-12T15:00:00Z' };
  assert.deepEqual(await grade(pick), { maps: { 1: 20, 2: 17 }, complete: false, matchId: 'vit-navi' });
  stats[73] = [bo3Row('ZywOo', 22, 11)];
  assert.deepEqual(await grade({ ...pick, stat: 'headshots' }), { maps: { 1: 8, 2: 6, 3: 11 }, complete: true, matchId: 'vit-navi' });
  assert.equal(await grade({ ...pick, player: 'flameZ' }), null);
  assert.equal(listCalls, 1);
});
