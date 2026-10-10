const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('../xarb');
const X = require('../exchanges');

const NOW = Date.parse('2026-10-08T12:00:00Z');
const START = '2026-10-08T23:00:00Z';

// ── sample payloads, shaped like the live APIs ──
const kMarket = (o = {}) => ({
  ticker: 'KXNBAGAME-26OCT08NYKBOS-BOS', event_ticker: 'KXNBAGAME-26OCT08NYKBOS', market_type: 'binary',
  title: 'New York K at Boston Winner?', yes_sub_title: 'Boston', no_sub_title: 'Boston', status: 'active',
  yes_ask_dollars: '0.5500', no_ask_dollars: '0.4700', yes_bid_dollars: '0.5300', no_bid_dollars: '0.4500',
  close_time: '2026-10-22T23:00:00Z', expected_expiration_time: '2026-10-09T02:00:00Z', volume: 52000, liquidity: 2500000,
  rules_primary: 'If Boston wins the New York K vs Boston professional basketball game originally scheduled for Oct 8, 2026, then the market resolves to Yes.',
  ...o,
});
const kalshiGame = (bos = {}, nyk = {}) => ({
  event_ticker: 'KXNBAGAME-26OCT08NYKBOS', series_ticker: 'KXNBAGAME', title: 'New York K at Boston', sub_title: 'NYK at BOS (Oct 8)',
  category: 'Sports', mutually_exclusive: true,
  markets: [
    kMarket(bos),
    kMarket({ ticker: 'KXNBAGAME-26OCT08NYKBOS-NYK', yes_sub_title: 'New York K', no_sub_title: 'New York K', yes_ask_dollars: '0.4700', no_ask_dollars: '0.5500', ...nyk }),
  ],
});
const pmGame = (m = {}) => ({
  id: '9001', slug: 'nba-nyk-bos-2026-10-08', title: 'Knicks vs. Celtics', startDate: '2026-10-01T00:00:00Z', endDate: START, negRisk: false,
  tags: [{ id: '1', label: 'Sports', slug: 'sports' }, { id: '745', label: 'NBA', slug: 'nba' }],
  markets: [
    {
      id: '555', question: 'Knicks vs. Celtics', conditionId: '0xabc', slug: 'nba-nyk-bos-2026-10-08', outcomes: '["Knicks","Celtics"]',
      outcomePrices: '["0.395","0.605"]', clobTokenIds: '["111","222"]', bestBid: 0.39, bestAsk: 0.4, lastTradePrice: 0.4, active: true,
      closed: false, acceptingOrders: true, gameStartTime: '2026-10-08 23:00:00+00', sportsMarketType: 'moneyline', endDate: START,
      volume: '180000', liquidity: '42000', liquidityNum: 42000, ...m,
    },
    { id: '556', question: 'Spread: Celtics (-5.5)', outcomes: '["Celtics","Knicks"]', bestBid: 0.48, bestAsk: 0.5, active: true, closed: false, sportsMarketType: 'spreads' },
    { id: '557', question: 'Knicks vs. Celtics: O/U 221.5', outcomes: '["Over","Under"]', bestBid: 0.5, bestAsk: 0.51, active: true, closed: false, sportsMarketType: 'totals' },
  ],
});

// a one-winner Kalshi event: [label, yesAsk cents, noAsk cents, extra]
const kalshiField = (eventTicker, title, category, cands, extra = {}) => ({
  event_ticker: eventTicker, series_ticker: eventTicker.split('-')[0], title, category, mutually_exclusive: true, ...extra,
  markets: cands.map(([label, yes, no, o = {}]) => ({
    ticker: `${eventTicker}-${label.replace(/[^A-Z]/gi, '').slice(0, 4).toUpperCase()}`, event_ticker: eventTicker,
    title: o.title || `${title}: ${label}`, yes_sub_title: label, status: 'active', yes_ask: yes, no_ask: no,
    yes_bid: yes == null ? null : yes - 2, no_bid: no == null ? null : no - 2,
    close_time: '2026-12-09T19:00:00Z', expected_expiration_time: '2026-12-09T19:00:00Z', liquidity: 1000000, ...o,
  })),
});
// a negRisk Polymarket event: [label, bestAsk, bestBid, extra]
const pmField = (id, slug, title, cands, extra = {}) => ({
  id, slug, title, negRisk: true, endDate: '2026-12-10T00:00:00Z', tags: [{ label: 'Politics', slug: 'politics' }], ...extra,
  markets: cands.map(([label, ask, bid, o = {}], i) => ({
    id: `${id}${i}`, question: o.question || `Will ${label} win?`, groupItemTitle: label, conditionId: `0x${id}${i}`,
    outcomes: '["Yes","No"]', outcomePrices: JSON.stringify([String(bid), String(1 - bid)]), bestAsk: ask, bestBid: bid,
    active: true, closed: false, negRisk: true, endDate: '2026-12-10T00:00:00Z', liquidity: '50000',
    description: `This market will resolve to "Yes" if ${label} wins.`, ...o,
  })),
});

const kRows = (...events) => A.parseKalshiBinaries({ events, cursor: '' });
const pRows = (...events) => A.parsePolymarketBinaries(events);
// the round-1 tests run with every venue (intl); US mode has its own tests below
const opts = (o = {}) => ({ now: NOW, region: 'intl', ...o });

// ── parsing ──
test('kalshi events: one row per open market, dollars or cents, games know both teams', () => {
  const rows = kRows(kalshiGame(), {
    event_ticker: 'KXX-1', title: 'Old', category: 'Economics', mutually_exclusive: false,
    markets: [
      { ticker: 'KXX-1-A', title: 'Will A?', yes_sub_title: 'A', status: 'open', yes_ask: '44', no_ask: 58, close_time: '2026-11-01T00:00:00Z', liquidity_dollars: '1200.50' },
      { ticker: 'KXX-1-B', title: 'Will B?', yes_sub_title: 'B', status: 'settled', result: 'no', yes_ask: 1 },
      { ticker: 'KXX-1-C', title: 'Will C?', yes_sub_title: 'C', status: 'unopened', yes_ask: 50, no_ask: 52 },
    ],
  });
  assert.equal(rows.length, 4, 'settled market dropped, unopened kept without a quote');
  const [bos, nyk, a, c] = rows;
  assert.equal(bos.exchange, 'kalshi');
  assert.equal(bos.id, 'KXNBAGAME-26OCT08NYKBOS-BOS');
  assert.equal(bos.eventKey, 'kalshi:KXNBAGAME-26OCT08NYKBOS');
  assert.equal(bos.kind, 'teams');
  assert.equal(bos.outcomeLabel, 'Boston');
  assert.equal(bos.noLabel, 'New York K');
  assert.equal(nyk.noLabel, 'Boston');
  assert.equal(bos.yesAsk, 0.55);
  assert.equal(bos.noAsk, 0.47);
  assert.equal(bos.closeTime, '2026-10-09T02:00:00Z', 'expected expiration beats the far-off close_time');
  assert.equal(bos.category, 'sports');
  assert.equal(bos.league, 'nba');
  assert.equal(bos.liquidity, 25000, 'liquidity is in cents');
  assert.equal(bos.url, 'https://kalshi.com/markets/kxnbagame-26oct08nykbos');
  assert.match(bos.rules, /^If Boston wins/);
  assert.equal(a.kind, 'yesno');
  assert.equal(a.yesAsk, 0.44, 'cents as strings');
  assert.equal(a.noAsk, 0.58);
  assert.equal(a.liquidity, 1200.5);
  assert.equal(a.category, 'econ');
  assert.equal(c.tradable, false);
  assert.equal(c.yesAsk, null);
  assert.deepEqual(A.parseKalshiBinaries(null), []);
  assert.deepEqual(A.parseKalshiBinaries({ events: [{ event_ticker: 'E' }] }), [], 'no nested markets');
});

test('kalshi: a lone game market finds its opponent in the title; a tie market marks the game', () => {
  const [lone] = kRows({ ...kalshiGame(), markets: [kMarket()] });
  assert.equal(lone.kind, 'teams');
  assert.equal(lone.noLabel, 'New York K');
  const soccer = kRows({
    event_ticker: 'KXEPLGAME-26OCT10ARSCHE', series_ticker: 'KXEPLGAME', title: 'Chelsea vs Arsenal', category: 'Sports', mutually_exclusive: true,
    markets: ['Arsenal', 'Chelsea', 'Tie'].map(t => kMarket({ ticker: `KXEPLGAME-26OCT10ARSCHE-${t.slice(0, 3).toUpperCase()}`, event_ticker: 'KXEPLGAME-26OCT10ARSCHE', yes_sub_title: t })),
  });
  assert.ok(soccer.every(r => r.hasDraw));
  assert.equal(soccer.find(r => r.outcomeLabel === 'Arsenal').noLabel, null, 'with a tie possible, NO Arsenal is not Chelsea winning');
  assert.deepEqual(soccer.map(r => r.game3.pick), [0, 1, 'draw']);
  assert.deepEqual(soccer[0].game3.teams, ['Arsenal', 'Chelsea']);
  const mvp = kRows({ event_ticker: 'KXNBAMVP-26', series_ticker: 'KXNBAMVP', title: 'NBA MVP 2025-26', category: 'Sports', mutually_exclusive: true,
    markets: ['Nikola Jokic', 'Shai Gilgeous-Alexander'].map((n, i) => kMarket({ ticker: `KXNBAMVP-26-${i}`, event_ticker: 'KXNBAMVP-26', title: `Will ${n} win MVP?`, yes_sub_title: n })) });
  assert.ok(mvp.every(r => r.kind === 'yesno'), 'two names left in an MVP race is not a game');
  const [decided] = kRows({ ...kalshiGame(), markets: [kMarket({ ticker: 'X1', status: 'finalized', result: 'yes' }), kMarket({ ticker: 'X2', yes_sub_title: 'New York K' })] });
  assert.equal(decided.eventDecided, true);
});

test('polymarket: second outcome / NO ask is 1 − bestBid, never the mid', () => {
  const [game, ...rest] = pRows(pmGame());
  // the spread and total are lines: YES is the side that must win by more than the line, and Over
  assert.deepEqual(rest.map(r => [r.kind, r.line, r.lineTeam ?? null, r.outcomeLabel, r.noLabel, r.yesAsk, r.noAsk, r.gameSlug]), [
    ['spread', 5.5, 'Celtics', 'Celtics', 'Knicks', 0.5, 0.52, 'nba-nyk-bos-2026-10-08'],
    ['total', 221.5, null, 'Over', 'Under', 0.51, 0.5, 'nba-nyk-bos-2026-10-08'],
  ]);
  assert.equal(game.exchange, 'polymarket');
  assert.equal(game.id, '555');
  assert.equal(game.eventKey, 'polymarket:9001');
  assert.equal(game.kind, 'teams');
  assert.equal(game.outcomeLabel, 'Knicks');
  assert.equal(game.noLabel, 'Celtics');
  assert.equal(game.yesAsk, 0.4);
  assert.equal(game.noAsk, 0.61, '1 − 0.39');
  assert.equal(game.league, 'nba');
  assert.equal(game.category, 'sports');
  assert.equal(game.startTime, '2026-10-08 23:00:00+00');
  assert.equal(game.liquidity, 42000);
  assert.equal(game.url, 'https://polymarket.com/event/nba-nyk-bos-2026-10-08');

  const yn = (m, ev = {}) => pRows({ id: '77', slug: 'fed-dec', title: 'Fed in December', tags: [{ label: 'Economy' }], ...ev,
    markets: [{ id: '770', question: 'Fed cut in December?', outcomes: '["Yes","No"]', bestAsk: '0.38', bestBid: '0.36', active: true, closed: false, endDate: '2026-12-10T00:00:00Z', ...m }] });
  const [r] = yn({});
  assert.deepEqual([r.kind, r.yesAsk, r.noAsk, r.outcomeLabel, r.category], ['yesno', 0.38, 0.64, 'Yes', 'econ'], 'numbers as strings');
  const [flip] = yn({ outcomes: '["No","Yes"]', bestAsk: 0.7, bestBid: 0.68 });
  assert.deepEqual([flip.yesAsk, flip.noAsk], [0.32, 0.7], 'NO listed first: YES is the second outcome');
  assert.equal(yn({ bestBid: undefined })[0].noAsk, null, 'no bid: no NO ask (mids are not tradable)');
  assert.equal(yn({ bestBid: 0 })[0].noAsk, null);
  assert.equal(yn({ bestAsk: 1 })[0].yesAsk, null);
  assert.equal(yn({ acceptingOrders: false })[0].tradable, false);
  assert.deepEqual(yn({ closed: true }), []);
  assert.deepEqual(yn({ outcomes: 'not json' }), []);
  const now = Date.parse('2026-10-09T15:00:00Z');
  const ev = { id: '77', slug: 'fed-dec', title: 'Fed in December', markets: [{ id: '770', question: 'Fed cut in December?', outcomes: '["Yes","No"]', bestAsk: 0.38, bestBid: 0.36, active: true, endDate: '2026-12-10T00:00:00Z' }] };
  const at = updatedAt => A.parsePolymarketBinaries([{ ...ev, markets: [{ ...ev.markets[0], updatedAt }] }], { now })[0].tradable;
  assert.equal(at('2026-09-16T00:00:00Z'), false, 'Gamma price weeks old: no arb legs from it');
  assert.equal(at('2026-10-09T14:30:00Z'), true);
  assert.deepEqual(A.parsePolymarketBinaries({ data: [] }), []);
  assert.deepEqual(A.parsePolymarketBinaries(undefined), []);
});

test('categories come from the exchange label first, then tags', () => {
  assert.equal(A.normalizeCategory('Elections'), 'politics');
  assert.equal(A.normalizeCategory('Financials'), 'econ');
  assert.equal(A.normalizeCategory('Crypto'), 'crypto');
  assert.equal(A.normalizeCategory('Entertainment'), 'culture');
  assert.equal(A.normalizeCategory('Climate and Weather'), 'other');
  assert.equal(A.normalizeCategory(undefined, [{ label: 'Politics' }, { label: 'Economy' }]), 'politics');
  assert.equal(A.normalizeCategory(null, { slug: 'nfl' }), 'sports');
  assert.equal(A.normalizeCategory(), 'other');
});

// ── matching ──
test('title keys: numbers, dates and directions must agree; words are compared by Jaccard', () => {
  const sim = A.titleSimilarity;
  assert.ok(sim('Will Gavin Newsom win the 2028 Democratic presidential nomination?', 'Will Gavin Newsom win the 2028 Democratic nomination for president?') >= 0.6);
  assert.equal(sim('Bitcoin above $100,000 on December 31?', 'Will Bitcoin be above 100k on Dec 31, 2026?'), 1, '$100,000 = 100k, December = Dec; one side has no year');
  assert.equal(sim('Will US inflation be above 3% in 2026?', 'Will U.S. inflation be above 3.0% in 2026?'), 1);
  assert.equal(sim('Will US inflation be above 3% in 2026?', 'Will US inflation be above 4% in 2026?'), null, 'number differs');
  assert.equal(sim('Will US inflation be above 3% in 2026?', 'Will US inflation be below 3% in 2026?'), null, 'direction differs');
  assert.equal(sim('Will US inflation be above 3% in 2026?', 'Will US inflation be at least 3% in 2026?'), null, '> is not ≥');
  assert.equal(sim('Will the government shut down by October 1?', 'Will the government shut down by November 1?'), null, 'month differs');
  assert.equal(sim('Will Trump win in 2028?', 'Will Trump win in 2032?'), null, 'year differs');
  assert.equal(sim('Will the Fed cut rates?', 'Will the Fed not cut rates?'), null);
  assert.equal(sim('Will the Fed cut rates in December?', 'Fed rate decision in December?'), null, '"cut" is a direction the other lacks');
  const k = A.titleKey('Fed cuts rates by 25+ bps in May 2026');
  assert.deepEqual([...k.nums], ['25']);
  assert.deepEqual([...k.years], ['2026']);
  assert.deepEqual([...k.months], ['may']);
  assert.deepEqual([...k.polarity].sort(), ['down', 'gte']);
  assert.deepEqual([...A.titleKey('Trump may sign the bill').months], [], '"may" as a verb is not a month');
});

const politics = () => {
  const ks = kRows(kalshiField('KXPRESNOMD-28', 'Democratic nominee for the 2028 presidential election', 'Elections', [
    ['Gavin Newsom', 30, 72], ['Alexandria Ocasio-Cortez', 12, 89], ['Pete Buttigieg', 10, 91], ['Josh Shapiro', 9, 92], ['Other', 40, 61],
  ].map(([n, y, no]) => [n, y, no, {
    title: n === 'Other' ? 'Will someone else win the 2028 Democratic presidential nomination?' : `Will ${n} win the 2028 Democratic presidential nomination?`,
    close_time: '2028-08-27T14:00:00Z', expected_expiration_time: '2028-08-27T14:00:00Z',
    rules_primary: `If ${n} is the Democratic nominee for the 2028 presidential election, then the market resolves to Yes.`,
  }])));
  const ps = pRows(pmField('30829', 'democratic-presidential-nominee-2028', 'Democratic Presidential Nominee 2028', [
    ['Gavin Newsom', 0.37, 0.36], ['Alexandria Ocasio-Cortez', 0.13, 0.12], ['Pete Buttigieg', 0.09, 0.08], ['Josh Shapiro', 0.08, 0.07], ['Other', 0.42, 0.4],
  ].map(([n, a, b]) => [n, a, b, {
    question: n === 'Other' ? 'Will another candidate win the 2028 Democratic nomination?' : `Will ${n} win the 2028 Democratic nomination for president?`,
    endDate: '2028-08-28T00:00:00Z',
  }]), { endDate: '2028-08-28T00:00:00Z' }));
  return { ks, ps };
};

test('politics: the same candidate matches across exchanges, no one else does', () => {
  const { ks, ps } = politics();
  const m = A.matchMarkets(ks, ps, opts()).filter(x => x.by === 'title');
  const pairs = m.map(x => [x.kalshi.outcomeLabel, x.polymarket.outcomeLabel]);
  for (const n of ['Gavin Newsom', 'Alexandria Ocasio-Cortez', 'Pete Buttigieg', 'Josh Shapiro']) assert.ok(pairs.some(([a, b]) => a === n && b === n), n);
  assert.ok(pairs.every(([a, b]) => a === b), JSON.stringify(pairs));
  assert.ok(m.every(x => x.same && x.similarity >= 0.6));

  const arbs = A.findCrossArbs(ks, ps, opts());
  assert.equal(arbs.length, 1);
  const [a] = arbs;
  assert.equal(a.type, 'cross');
  assert.equal(a.category, 'politics');
  assert.deepEqual(a.legs.map(l => [l.venue, l.side, l.pick, l.price]), [['kalshi', 'yes', 'Gavin Newsom', 0.3], ['polymarket', 'no', 'NO Gavin Newsom', 0.64]]);
  assert.deepEqual(a.warnings, [A.RULES_WARNING], 'non-sports matches carry the rules warning');
  assert.equal(a.match.by, 'title');
  assert.match(a.legs[0].rules, /Gavin Newsom is the Democratic nominee/);
  // 0.30 + 0.64 + Kalshi fee 0.07 × 0.3 × 0.7 ≈ 0.0147 per contract
  assert.ok(Math.abs(a.totalCost - 0.9547) < 0.0005, String(a.totalCost));
  assert.ok(a.profitPct > 4.5 && a.profitPct < 4.9, String(a.profitPct));
});

test('near misses do not match: a different number, month, direction or close date', () => {
  const kal = (title, close) => kRows({
    event_ticker: `KX-${title.length}`, title, category: 'Economics', mutually_exclusive: false,
    markets: [{ ticker: `KX-${title.length}-Y`, title, yes_sub_title: '', status: 'active', yes_ask: 20, no_ask: 30, close_time: close, expected_expiration_time: close }],
  });
  const pm = (question, end) => pRows({
    id: `p${question.length}`, slug: 's', title: question, tags: [{ label: 'Economy' }],
    markets: [{ id: `m${question.length}`, question, outcomes: '["Yes","No"]', bestAsk: 0.2, bestBid: 0.7, active: true, closed: false, endDate: end }],
  });
  const D = '2026-12-31T23:00:00Z';
  const cases = [
    ['Will US inflation be above 3% in 2026?', D, 'Will US inflation be above 4% in 2026?', D],
    ['Will US inflation be above 3% in 2026?', D, 'Will US inflation be below 3% in 2026?', D],
    ['Will the government shut down by October 1?', '2026-10-01T04:00:00Z', 'Will the government shut down by November 1?', '2026-10-01T04:00:00Z'],
    ['Will US inflation be above 3% in 2026?', D, 'Will US inflation be above 3% in 2026?', '2027-01-10T00:00:00Z'],
  ];
  for (const [kt, kc, pt, pc] of cases) {
    const ks = kal(kt, kc), ps = pm(pt, pc);
    assert.deepEqual(A.matchMarkets(ks, ps, opts()), [], `${kt} / ${pt} (${pc})`);
    // YES 0.20 + NO 0.30 would be a huge "arb" if these were wrongly matched
    assert.deepEqual(A.findArbs({ kalshi: ks, polymarket: ps }, opts()), []);
  }
  // control: the same question, worded a little differently, does match
  const ks = kal('Will US inflation be above 3% in 2026?', D), ps = pm('Will U.S. inflation be above 3.0% in 2026?', '2027-01-01T05:00:00Z');
  assert.equal(A.matchMarkets(ks, ps, opts()).length, 1);
});

test('sports: Kalshi vs Polymarket game arb, teams matched by name across labels', () => {
  const ks = kRows(kalshiGame()), ps = pRows(pmGame());
  const m = A.matchMarkets(ks, ps, opts());
  assert.equal(m.length, 2, 'both Kalshi team markets pair with the one Polymarket market');
  assert.deepEqual(m.map(x => [x.kalshi.outcomeLabel, x.same, x.by]), [['Boston', false, 'teams'], ['New York K', true, 'teams']]);

  const arbs = A.findCrossArbs(ks, ps, opts());
  assert.equal(arbs.length, 1, 'one game, best direction kept');
  const [a] = arbs;
  assert.deepEqual(a.legs.map(l => [l.venue, l.side, l.pick, l.price]), [['kalshi', 'yes', 'Boston', 0.55], ['polymarket', 'yes', 'Knicks', 0.4]]);
  assert.equal(a.category, 'sports');
  assert.equal(a.title, 'New York K at Boston');
  assert.deepEqual(a.warnings, [], 'team matches need no rules warning');
  // $100: 103 contracts each. 0.55 × 103 + fee ceil(0.07 × 103 × 0.55 × 0.45) = 56.65 + 1.79; 0.40 × 103 = 41.20
  assert.equal(a.stakes.contracts, 103);
  assert.deepEqual(a.stakes.legs.map(l => [l.stake, l.fee]), [[58.44, 1.79], [41.2, 0]]);
  assert.equal(a.stakes.cost, 99.64);
  assert.equal(a.stakes.payout, 103);
  assert.equal(a.profitPct, 3.37);
  assert.equal(a.maxContracts, null, 'total book liquidity is not size at the ask: no size claimed');
  assert.equal(a.maxStake, null);
  assert.equal(a.exhaustive, true, 'YES + NO of one question always covers it');
});

test('sports matching needs the same teams, the same league and a game within 4h', () => {
  const ps = pRows(pmGame());
  const nextWeek = kRows(kalshiGame({ expected_expiration_time: '2026-10-16T02:00:00Z' }, { expected_expiration_time: '2026-10-16T02:00:00Z' }));
  assert.deepEqual(A.matchMarkets(nextWeek, ps, opts()), []);
  // Kalshi expects to settle ~3h after the start: 02:00 → a 23:00 tip-off. 6h off is another game.
  const late = kRows(kalshiGame({ expected_expiration_time: '2026-10-09T08:00:00Z' }, { expected_expiration_time: '2026-10-09T08:00:00Z' }));
  assert.deepEqual(A.matchMarkets(late, ps, opts()), [], 'a start 6h away is not this game');
  const hockey = kRows({
    ...kalshiGame(), event_ticker: 'KXNHLGAME-26OCT08NYRBOS', series_ticker: 'KXNHLGAME',
    markets: [kMarket({ ticker: 'KXNHLGAME-26OCT08NYRBOS-BOS', event_ticker: 'KXNHLGAME-26OCT08NYRBOS' }),
      kMarket({ ticker: 'KXNHLGAME-26OCT08NYRBOS-NYR', event_ticker: 'KXNHLGAME-26OCT08NYRBOS', yes_sub_title: 'New York R' })],
  });
  assert.deepEqual(A.matchMarkets(hockey, ps, opts()), [], 'Bruins–Rangers is not Celtics–Knicks');
  const otherGame = pRows(pmGame({ outcomes: '["Lakers","Celtics"]' }));
  assert.deepEqual(A.matchMarkets(kRows(kalshiGame()), otherGame, opts()), []);
  // a tie is possible: NO on a team is not the other team winning
  const tie = kRows({ ...kalshiGame(), markets: [...kalshiGame().markets, kMarket({ ticker: 'T', yes_sub_title: 'Tie' })] });
  assert.equal(A.matchMarkets(tie, ps, opts()).filter(x => x.by === 'teams').length, 0);
  // Odds API games can bridge names the built-in list doesn't know
  const k = kRows({ ...kalshiGame(), event_ticker: 'KXWNBAGAME-1', series_ticker: 'KXWNBAGAME',
    markets: [kMarket({ ticker: 'W1', yes_sub_title: 'Las Vegas' }), kMarket({ ticker: 'W2', yes_sub_title: 'Seattle' })] });
  const p = pRows({ ...pmGame({ outcomes: '["Storm","Aces"]' }), slug: 'wnba-sea-lv-2026-10-08', tags: [] });
  assert.deepEqual(A.matchMarkets(k, p, opts()), [], 'unknown teams, no games: no match');
  const games = [{ sport_key: 'basketball_wnba', home_team: 'Las Vegas Aces', away_team: 'Seattle Storm', commence_time: START }];
  assert.equal(A.matchMarkets(k, p, opts({ games })).length, 2);
});

test('doubleheaders: each Kalshi game pairs with its own Polymarket game, never the other one', () => {
  const kMlb = (g, exp, nyy, bos) => ({
    event_ticker: `KXMLBGAME-26OCT08NYYBOS${g}`, series_ticker: 'KXMLBGAME', title: `New York Y at Boston${g ? ` (Game ${g.slice(1)})` : ''}`, category: 'Sports', mutually_exclusive: true,
    markets: [['NYY', 'New York Y', nyy], ['BOS', 'Boston', bos]].map(([code, label, [yes, no]]) => ({
      ticker: `KXMLBGAME-26OCT08NYYBOS${g}-${code}`, event_ticker: `KXMLBGAME-26OCT08NYYBOS${g}`, title: 'New York Y at Boston Winner?',
      yes_sub_title: label, status: 'active', yes_ask_dollars: yes, no_ask_dollars: no, expected_expiration_time: exp, close_time: '2026-10-22T23:00:00Z',
    })),
  });
  const pMlb = (id, slug, start, ask, bid) => ({
    id, slug, title: 'Yankees vs. Red Sox', tags: [{ label: 'MLB', slug: 'mlb' }],
    markets: [{ id: `${id}0`, question: 'Yankees vs. Red Sox', outcomes: '["Yankees","Red Sox"]', bestAsk: ask, bestBid: bid, active: true, closed: false,
      gameStartTime: start, sportsMarketType: 'moneyline', endDate: start, slug }],
  });
  // game 1 17:05Z (Kalshi expects 20:05), game 2 23:10Z (expects 02:10)
  const ks = kRows(kMlb('G1', '2026-10-08T20:05:00Z', ['0.5600', '0.4500'], ['0.4500', '0.5600']), kMlb('G2', '2026-10-09T02:10:00Z', ['0.4000', '0.6100'], ['0.6100', '0.4000']));
  assert.deepEqual(ks.map(r => r.gameNo), [1, 1, 2, 2], 'G1 / G2 from the ticker');
  const ps = pRows(pMlb('g1', 'mlb-nyy-bos-2026-10-08', '2026-10-08T17:05:00Z', 0.56, 0.55), pMlb('g2', 'mlb-nyy-bos-2026-10-08-game-2', '2026-10-08T23:10:00Z', 0.42, 0.41));
  assert.deepEqual(ps.map(r => r.gameNo), [null, 2], '-game-2 in the slug');
  const pairs = A.matchMarkets(ks, ps, opts()).map(m => `${m.kalshi.eventKey}→${m.polymarket.id}`);
  assert.deepEqual([...new Set(pairs)], ['kalshi:KXMLBGAME-26OCT08NYYBOSG1→g10', 'kalshi:KXMLBGAME-26OCT08NYYBOSG2→g20']);
  // the reviewer's fake: Kalshi G1 NO Boston @0.45 + Polymarket game 2 Yankees @0.42 is two different games
  assert.ok(!A.findCrossArbs(ks, ps, opts()).some(a => a.legs.some(l => l.marketId === 'g20') && a.legs.some(l => String(l.marketId).includes('G1'))));

  // no game numbers anywhere: the nearest start still keeps them apart
  const strip = rows => rows.map(r => ({ ...r, gameNo: null }));
  assert.deepEqual([...new Set(A.matchMarkets(strip(ks), strip(ps), opts()).map(m => `${m.kalshi.eventKey}→${m.polymarket.id}`))], pairs.filter((x, i) => pairs.indexOf(x) === i));
  // a game-2 market inside the window of Kalshi's game 1 is still not game 1
  const wrongNo = pRows(pMlb('x2', 'mlb-nyy-bos-2026-10-08-game-2', '2026-10-08T18:00:00Z', 0.42, 0.41));
  assert.deepEqual(A.matchMarkets(ks.slice(0, 2), wrongNo, opts()), []);
  // two Polymarket games equally near: ambiguous, no match
  const twins = pRows(pMlb('t1', 'mlb-nyy-bos-a', '2026-10-08T16:05:00Z', 0.5, 0.49), pMlb('t2', 'mlb-nyy-bos-b', '2026-10-08T18:05:00Z', 0.5, 0.49));
  assert.deepEqual(A.matchMarkets(strip(ks.slice(0, 2)), twins, opts()), []);
});

test('title matching: a different person, team, party or word order is not the same question', () => {
  const kal = (title, label = '', close = '2026-11-04T04:00:00Z', yes = 8, no = 92) => ({
    event_ticker: `KX-${title.length}-${label.length}`, title, category: 'Elections', mutually_exclusive: false,
    markets: [{ ticker: `KX-${title.length}-${label.length}-M`, title, yes_sub_title: label, status: 'active', yes_ask: yes, no_ask: no, close_time: close, expected_expiration_time: close }],
  });
  const pm = (question, group, end = '2026-11-04T05:00:00Z', ask = 0.02, bid = 0.01) => ({
    id: `p${question.length}${group || ''}`, slug: 's', title: question, tags: [{ label: 'Politics' }],
    markets: [{ id: `m${question.length}${group || ''}`, question, groupItemTitle: group, outcomes: '["Yes","No"]', bestAsk: ask, bestBid: bid, active: true, closed: false, endDate: end }],
  });
  const pairs = [
    [kal('Will the New York Yankees win the 2026 World Series?'), pm('Will the New York Mets win the 2026 World Series?')],
    [kal('Will the Los Angeles Rams win Super Bowl LXI?'), pm('Will the Los Angeles Chargers win Super Bowl LXI?')],
    [kal('Will Donald Trump Jr. win the 2028 Republican presidential nomination?'), pm('Will Donald Trump win the 2028 Republican presidential nomination?')],
    [kal('Who will win the 2028 Democratic presidential nomination?', 'Josh Shapiro'), pm('Will Josh Stein win the 2028 Democratic presidential nomination?', 'Josh Stein')],
    [kal('Which party will win the House?', 'Democratic'), pm('Which party will win the House?', 'Republican')],
    [kal('Will the Celtics win the 2026 NBA Finals?'), pm('Will the Lakers win the 2026 NBA Finals?')],
    [kal('Will Casey DeSantis win the 2028 Republican nomination?'), pm('Will Ron DeSantis win the 2028 Republican nomination?')],
    [kal('Will Israel strike Iran in October?'), pm('Will Iran strike Israel in October?')],
  ];
  for (const [k, p] of pairs) {
    const ks = kRows(k), ps = pRows(p);
    const prop = r => (r.outcomeLabel && r.outcomeLabel !== 'Yes' && !r.title.includes(r.outcomeLabel) ? `${r.title} ${r.outcomeLabel}` : r.title);
    assert.ok(A.titleSimilarity(prop(ks[0]), prop(ps[0])) >= 0.6, `${ks[0].title}: Jaccard alone would pair it`);
    assert.deepEqual(A.matchMarkets(ks, ps, opts()), [], `${ks[0].title} ${ks[0].outcomeLabel} / ${ps[0].title} ${ps[0].outcomeLabel}`);
    // NO 0.92 + YES 0.02 would be a fat fake arb
    assert.deepEqual(A.findArbs({ kalshi: ks, polymarket: ps }, opts()), []);
  }

  // the same question written two ways still matches
  const same = [
    [kal('Will J.D. Vance win the 2028 Republican presidential nomination?'), pm('Will JD Vance win the 2028 Republican presidential nomination?')],
    [kal('Which party will win the House?', 'Democratic'), pm('Which party will win the House?', 'Democrats')],
    [kal('Will bitcoin be above $150,000 on December 31?'), pm('Will Bitcoin be above $150k on Dec 31?', undefined, '2026-11-04T05:00:00Z')],
  ];
  for (const [k, p] of same) assert.equal(A.matchMarkets(kRows(k), pRows(p), opts()).length, 1, kRows(k)[0].title);
});

test('title matching is one-to-one: each market keeps only its unique best match', () => {
  const close = '2026-12-31T23:00:00Z';
  const ks = kRows({ event_ticker: 'KXBTC150', title: 'Bitcoin', category: 'Crypto', mutually_exclusive: false,
    markets: [{ ticker: 'KXBTC150-26', title: 'Will Bitcoin hit $150k in 2026?', yes_sub_title: '', status: 'active', yes_ask: 30, no_ask: 72, close_time: close, expected_expiration_time: close }] });
  const pm = (id, question) => ({ id, slug: id, title: question, tags: [{ label: 'Crypto' }],
    markets: [{ id: `${id}m`, question, outcomes: '["Yes","No"]', bestAsk: 0.3, bestBid: 0.29, active: true, closed: false, endDate: close }] });
  const ps = pRows(pm('exact', 'Will Bitcoin hit $150k in 2026?'), pm('looser', 'Will Bitcoin hit $150k by the end of 2026?'));
  assert.ok(A.titleSimilarity(ks[0].title, ps[1].title) >= 0.6, 'both pass the threshold');
  assert.deepEqual(A.matchMarkets(ks, ps, opts()).map(m => m.polymarket.id), ['exactm']);
  // two equally good candidates: can't tell which, so neither
  const dup = pRows(pm('a', 'Will Bitcoin hit $150k in 2026?'), pm('b', 'Will Bitcoin hit $150k in 2026?'));
  assert.deepEqual(A.matchMarkets(ks, dup, opts()), []);
});

test('the Kalshi fee turns a thin 1% gap into a loss', () => {
  // 0.58 + 0.41 = 0.99 before fees; Kalshi's 0.07 × 0.58 × 0.42 ≈ 1.7¢ a contract eats it
  const ks = kRows(kalshiGame({ yes_ask_dollars: '0.5800', no_ask_dollars: '0.4400' }, { yes_ask_dollars: '0.4400', no_ask_dollars: '0.5800' }));
  const ps = pRows(pmGame({ bestAsk: 0.41, bestBid: 0.4 }));
  const free = A.findCrossArbs(ks, ps, opts({ kalshiFeeRate: 0 }));
  assert.equal(free.length, 1);
  assert.equal(free[0].profitPct, 1.01, 'no fee: 101 contracts for $99.99');
  assert.equal(A.stakeArb(free[0], 1000).profit, 10.1, 'restaking uses the fee rates the arb was found with');
  assert.ok(A.stakeArb(free[0], 1000, { kalshiFeeRate: 0.07 }).profit < 0);
  assert.deepEqual(A.findCrossArbs(ks, ps, opts()), [], 'with the fee: no arb at all');
  assert.deepEqual(A.findArbs({ kalshi: ks, polymarket: ps }, opts({ minPct: 0 })), []);
  // a Polymarket fee rate counts too
  assert.deepEqual(A.findCrossArbs(ks, ps, opts({ kalshiFeeRate: 0, polymarketFeeRate: 0.03 })), []);
});

// ── underrounds ──
test('kalshi underround: YES on every outcome of a mutually exclusive event, net of fees', () => {
  const cands = [['Cut 25bps', 30, 72], ['Hold', 30, 72], ['Cut >25bps', 10, 92], ['Hike', 23, 79]];
  const ev = kalshiField('KXFEDDECISION-26DEC', 'Fed decision in Dec 2026?', 'Economics', cands);
  const [a] = A.findUnderrounds(kRows(ev), opts());
  assert.ok(a);
  assert.equal(a.type, 'multi');
  assert.equal(a.exchange, 'kalshi');
  assert.equal(a.outcomes, 4);
  assert.equal(a.category, 'econ');
  assert.deepEqual(a.legs.map(l => [l.side, l.pick, l.price]), [['yes', 'Cut 25bps', 0.3], ['yes', 'Hold', 0.3], ['yes', 'Cut >25bps', 0.1], ['yes', 'Hike', 0.23]]);
  assert.equal(a.exhaustive, false, 'no catch-all outcome: mutually exclusive, not proven exhaustive');
  assert.deepEqual(a.warnings, [A.NOT_EXHAUSTIVE_WARNING]);
  // $100 → 102 of each: 94.86 + fees 1.50 + 1.50 + 0.65 + 1.27 = 99.78
  assert.equal(a.stakes.contracts, 102);
  assert.equal(a.stakes.cost, 99.78);
  assert.equal(a.profitPct, 2.22);

  // one outcome with no ask: the set isn't complete, no arb
  const noQuote = kalshiField('KXFEDDECISION-26DEC', 'Fed decision in Dec 2026?', 'Economics', [...cands.slice(0, 3), ['Hike', 0, 100]]);
  assert.deepEqual(A.findUnderrounds(kRows(noQuote), opts()), []);
  const paused = kalshiField('KXFEDDECISION-26DEC', 'Fed decision in Dec 2026?', 'Economics', [...cands.slice(0, 3), ['Hike', 23, 79, { status: 'paused' }]]);
  assert.deepEqual(A.findUnderrounds(kRows(paused), opts()), []);
  // not mutually exclusive: buying every YES guarantees nothing
  const loose = kalshiField('KXFEDDECISION-26DEC', 'Fed decision in Dec 2026?', 'Economics', cands, { mutually_exclusive: false });
  assert.deepEqual(A.findUnderrounds(kRows(loose), opts()), []);
  // a market already settled NO drops out of the set; one settled YES means it's over
  const settledNo = kalshiField('KXFEDDECISION-26DEC', 'Fed decision in Dec 2026?', 'Economics', [...cands, ['Emergency', 5, 96, { status: 'settled', result: 'no' }]]);
  assert.equal(A.findUnderrounds(kRows(settledNo), opts()).length, 1);
  const settledYes = kalshiField('KXFEDDECISION-26DEC', 'Fed decision in Dec 2026?', 'Economics', [...cands, ['Emergency', 5, 96, { status: 'settled', result: 'yes' }]]);
  assert.deepEqual(A.findUnderrounds(kRows(settledYes), opts()), []);
});

test('polymarket underround: YES on every candidate of a negRisk event', () => {
  const cands = [['One Battle After Another', 0.2, 0.19], ['Hamnet', 0.25, 0.24], ['Sinners', 0.25, 0.24], ['Marty Supreme', 0.27, 0.26]];
  const ev = pmField('4401', 'oscars-2027-best-picture-winner', 'Oscars 2027: Best Picture Winner', [
    ...cands, ['Wicked: For Good', 0.01, 0.001, { closed: true, outcomePrices: '["0","1"]' }],
  ], { tags: [{ label: 'Culture' }, { label: 'Awards' }] });
  const [a] = A.findUnderrounds(pRows(ev), opts());
  assert.ok(a, 'the closed (resolved NO) market is not an outcome any more');
  assert.equal(a.exchange, 'polymarket');
  assert.equal(a.outcomes, 4);
  assert.equal(a.category, 'culture');
  // Σ 0.97, no fee: 103 × 0.97 = 99.91 for $103
  assert.equal(a.stakes.contracts, 103);
  assert.equal(a.stakes.cost, 99.91);
  assert.equal(a.profitPct, 3.09);
  assert.equal(A.findUnderrounds(pRows(ev), opts({ polymarketFeeRate: 0.05 })).length, 0, '5% fee kills a 3% edge');

  const missing = pmField('4401', 'oscars', 'Oscars', [...cands.slice(0, 3), ['Marty Supreme', null, 0.26]]);
  assert.deepEqual(A.findUnderrounds(pRows(missing), opts()), [], 'every outcome needs an ask');
  const notNeg = pmField('4401', 'oscars', 'Oscars', cands, { negRisk: false });
  notNeg.markets.forEach(m => { m.negRisk = false; });
  assert.deepEqual(A.findUnderrounds(pRows(notNeg), opts()), []);
  const won = pmField('4401', 'oscars', 'Oscars', [...cands, ['Wicked: For Good', 0.01, 0.001, { closed: true, outcomePrices: '["1","0"]' }]]);
  assert.deepEqual(A.findUnderrounds(pRows(won), opts()), [], 'an outcome already resolved YES: event is over');
});

test('underrounds: only a visibly complete outcome set is exhaustive; the rest are listed, flagged, never "risk-free"', () => {
  // 12 names, asks sum to 0.85: the missing 15% is "someone else", not free money
  const names = ['Pietro Parolin', 'Luis Antonio Tagle', 'Matteo Zuppi', 'Peter Erdo', 'Pierbattista Pizzaballa', 'Robert Sarah',
    'Fridolin Ambongo', 'Jean-Marc Aveline', 'Mario Grech', 'Anders Arborelius', 'Juan Jose Omella', 'Wim Eijk'];
  const asks = [16, 14, 10, 8, 7, 6, 6, 5, 4, 3, 3, 3];
  const pope = cands => kalshiField('KXNEXTPOPE-35', 'Who will be the next Pope?', 'World', cands);
  const field = names.map((n, i) => [n, asks[i], 100 - asks[i] + 2]);
  const [open] = A.findUnderrounds(kRows(pope(field)), opts());
  assert.ok(open, 'still listed');
  assert.ok(open.profitPct > 10);
  assert.equal(open.exhaustive, false);
  assert.deepEqual(open.warnings, [A.NOT_EXHAUSTIVE_WARNING]);
  // a catch-all market closes the set (and here kills the arb)
  assert.deepEqual(A.findUnderrounds(kRows(pope([...field, ['Someone else', 15, 87]])), opts()), []);
  const [covered] = A.findUnderrounds(kRows(pope([...field.slice(0, 11), ['Someone else', 3, 99]])), opts());
  assert.equal(covered.exhaustive, true);
  assert.deepEqual(covered.warnings, [A.COVER_WARNING]);

  // range buckets open at both ends cover every number
  const temps = kalshiField('KXHIGHNY-26OCT08', 'Highest temperature in NYC on Oct 8, 2026?', 'Climate and Weather',
    [['65° or below', 15, 87], ['66° to 67°', 20, 82], ['68° to 69°', 20, 82], ['70° or above', 20, 82]]);
  assert.equal(A.findUnderrounds(kRows(temps), opts())[0].exhaustive, true);
  const closedTop = kalshiField('KXHIGHNY-26OCT08', 'Highest temperature in NYC on Oct 8, 2026?', 'Climate and Weather',
    [['66° to 67°', 25, 77], ['68° to 69°', 25, 77], ['70° or above', 25, 77]]);
  assert.equal(A.findUnderrounds(kRows(closedTop), opts())[0].exhaustive, false, 'nothing below 66°');

  // a basketball game can't tie; football without a tie market could
  const nba = kalshiGame({ yes_ask_dollars: '0.5000' }, { yes_ask_dollars: '0.4500' });
  assert.equal(A.findUnderrounds(kRows(nba), opts())[0].exhaustive, true);
  const nfl = { ...nba, event_ticker: 'KXNFLGAME-26OCT11KCBUF', series_ticker: 'KXNFLGAME', markets: nba.markets.map(m => ({ ...m, ticker: m.ticker.replace('NBA', 'NFL'), event_ticker: 'KXNFLGAME-26OCT11KCBUF' })) };
  assert.equal(A.findUnderrounds(kRows(nfl), opts())[0].exhaustive, false);
  // Polymarket: a negRisk field with an "Other" market
  const pmOpen = pmField('77', 'next-pope', 'Next Pope', [['Parolin', 0.4, 0.39], ['Tagle', 0.4, 0.39]]);
  assert.equal(A.findUnderrounds(pRows(pmOpen), opts())[0].exhaustive, false);
  const pmOther = pmField('77', 'next-pope', 'Next Pope', [['Parolin', 0.4, 0.39], ['Tagle', 0.4, 0.39], ['Other', 0.15, 0.14]]);
  assert.equal(A.findUnderrounds(pRows(pmOther), opts())[0].exhaustive, true);
});

// ── exchange vs sportsbook ──
const bookH2h = (key, celtics, knicks, extra = {}) => ({ key, title: key, markets: [{ key: 'h2h', outcomes: [{ name: 'Boston Celtics', price: celtics }, { name: 'New York Knicks', price: knicks }] }], ...extra });
const oddsGame = (books, extra = {}) => ({ id: 'g1', sport_key: 'basketball_nba', home_team: 'Boston Celtics', away_team: 'New York Knicks', commence_time: START, bookmakers: books, ...extra });

test('exchange vs sportsbook: the attached Kalshi price against the best book on the other side', () => {
  const kalshiRows = X.parseKalshiMarkets({ markets: kalshiGame().markets });
  const games = X.attachExchanges([oddsGame([bookH2h('draftkings', -200, 170), bookH2h('fanduel', -190, 160), bookH2h('pinnacle', -165, 150)])], kalshiRows, { now: NOW });
  const k = games[0].bookmakers.find(b => b.key === 'kalshi');
  assert.ok(k, 'attachExchanges added the Kalshi book');

  const arbs = A.findBookArbs(games, opts());
  assert.equal(arbs.length, 1);
  const [a] = arbs;
  assert.equal(a.type, 'book');
  assert.equal(a.title, 'New York Knicks @ Boston Celtics');
  assert.deepEqual(a.legs.map(l => [l.venue, l.pick, l.american]), [['kalshi', 'Boston Celtics', -133], ['draftkings', 'New York Knicks', 170]]);
  assert.equal(a.legs[0].url, 'https://kalshi.com/markets/kxnbagame-26oct08nykbos');
  // Kalshi 0.55 + 2¢ fee → −133 (1.7519); DraftKings +170 (2.70): 1/1.7519 + 1/2.7 = 0.9412
  assert.equal(a.totalCost, 0.9412);
  assert.equal(a.profitPct, 6.25);

  // no arb when the best book isn't long enough, when the game started, or for 3-way markets
  // +130 is 2.30: 0.5708 + 0.4348 > 1
  assert.deepEqual(A.findBookArbs(X.attachExchanges([oddsGame([bookH2h('fanduel', -190, 130)])], kalshiRows, { now: NOW }), opts()), []);
  assert.deepEqual(A.findBookArbs(games, opts({ now: Date.parse(START) + 1 })), []);
  const threeWay = oddsGame([{ key: 'kalshi', markets: [{ key: 'h2h', outcomes: [{ name: 'A', price: 300 }, { name: 'B', price: 300 }, { name: 'Draw', price: 300 }] }] },
    { key: 'bet365', markets: [{ key: 'h2h', outcomes: [{ name: 'A', price: 300 }, { name: 'B', price: 300 }, { name: 'Draw', price: 300 }] }] }]);
  assert.deepEqual(A.findBookArbs([threeWay], opts()), []);
  // exchange vs exchange is the cross-exchange scan's job
  assert.deepEqual(A.findBookArbs([oddsGame([bookH2h('kalshi', -133, 104), bookH2h('polymarket', -150, 170)])], opts()), []);
});

test('exchange vs sportsbook: a Polymarket book priced off a mid (no real ask) is not an arb', () => {
  const books = [bookH2h('draftkings', -140, 120)];
  const strict = ev => pRows(ev);
  const attach = ev => X.attachExchanges([oddsGame(books)], X.parsePolymarketEvents([ev], 'nba'), { now: NOW });
  // a real book: Knicks 0.40 ask (+150) against DraftKings Celtics -140
  const live = pmGame();
  const ok = A.findArbs({ polymarket: strict(live), games: attach(live) }, opts()).filter(a => a.type === 'book');
  assert.equal(ok.length, 1);
  assert.equal(ok[0].legs[0].venue, 'polymarket');
  // empty ask side: exchanges.js falls back to the 0.395 mid, which can't be bought
  const thin = pmGame({ bestAsk: undefined });
  const games = attach(thin);
  assert.ok(games[0].bookmakers.some(b => b.key === 'polymarket'), 'the +EV board still shows the mid-priced book');
  assert.deepEqual(A.findArbs({ polymarket: strict(thin), games }, opts()).filter(a => a.type === 'book'), []);
  // not in this scan at all: can't be checked, so not used
  assert.deepEqual(A.findArbs({ polymarket: [], games: attach(live) }, opts()).filter(a => a.type === 'book' && a.legs[0].venue === 'polymarket'), []);
});

// ── stakes ──
test('stakes split so every outcome pays the same', () => {
  // contract arb: the same number of contracts on every leg
  const [a] = A.findCrossArbs(kRows(kalshiGame()), pRows(pmGame()), opts());
  const s = A.stakeArb(a, 1000, opts());
  assert.equal(s.legs[0].contracts, s.legs[1].contracts);
  assert.equal(s.payout, s.contracts);
  assert.ok(s.cost <= 1000 && s.cost > 990, String(s.cost));
  for (const l of s.legs) assert.equal(l.stake, Math.round((l.price * s.contracts + l.fee) * 100) / 100);
  assert.equal(s.profit, Math.round((s.payout - s.cost) * 100) / 100);
  assert.equal(A.stakeArb(a, 0), null);

  // a market's displayed liquidity is its whole book, not depth at the ask: it caps nothing
  const thin = A.findCrossArbs(kRows(kalshiGame()), pRows(pmGame({ liquidity: '20', liquidityNum: 20 })), opts())[0];
  assert.equal(thin.maxContracts, null);
  assert.equal(thin.maxStake, null);
  assert.equal(A.stakeArb(thin, 1000, opts()).capped, false);
  assert.equal(thin.legs[1].liquidity, 20, 'still shown on the leg');

  // sportsbook arb: stakes ∝ 1/decimal, payouts equal to the cent
  const games = X.attachExchanges([oddsGame([bookH2h('draftkings', -200, 170)])], X.parseKalshiMarkets({ markets: kalshiGame().markets }), { now: NOW });
  const [b] = A.findBookArbs(games, opts());
  const bs = A.stakeArb(b, 500);
  assert.ok(Math.abs(bs.legs[0].payout - bs.legs[1].payout) <= 0.02, JSON.stringify(bs.legs));
  assert.ok(Math.abs(bs.cost - 500) <= 0.01);
  assert.ok(bs.legs[0].stake > bs.legs[1].stake, 'more on the favourite');
  assert.ok(bs.profitPct > 6 && bs.profitPct < 6.5);
});

test('stakes: each leg as a % of the total, the same split whatever the amount', () => {
  const [a] = A.findCrossArbs(kRows(kalshiGame()), pRows(pmGame()), opts());
  const pcts = a.stakes.legs.map(l => l.pct);
  assert.deepEqual(pcts, [58.7, 41.3], '58.44 and 41.20 of 99.64');
  assert.ok(Math.abs(pcts[0] + pcts[1] - 100) < 0.2);
  const big = A.stakeArb(a, 5000, opts());
  assert.ok(big.legs.every((l, i) => Math.abs(l.pct - pcts[i]) <= 0.15), 'about the same split at $5,000 (whole contracts)');
  const games = X.attachExchanges([oddsGame([bookH2h('draftkings', -200, 170)])], X.parseKalshiMarkets({ markets: kalshiGame().markets }), { now: NOW });
  const [b] = A.findBookArbs(games, opts());
  // 1/1.7519 : 1/2.70 of 0.9412
  assert.deepEqual(b.stakes.legs.map(l => l.pct), [60.6, 39.4]);
  assert.deepEqual(A.stakeArb(b, 12345).legs.map(l => l.pct), [60.6, 39.4], 'a book split is exact at any size');
});

// ── Polymarket taker fees ──
test('polymarket fee schedule: parsed from Gamma, shares × rate × p(1 − p), sports 5%, others free', () => {
  const sched = { rate: 0.05, exponent: 1, takerOnly: true, rebateRate: 0.2 };
  assert.deepEqual(A.polymarketFeeSchedule({ feeType: 'sports_fees_v2', feeSchedule: sched }), { rate: 0.05, exponent: 1, type: 'sports_fees_v2' });
  assert.deepEqual(A.polymarketFeeSchedule({ feeSchedule: JSON.stringify({ rate: '0.04', exponent: '2' }) }), { rate: 0.04, exponent: 2, type: null }, 'a JSON string, numbers as strings');
  assert.deepEqual(A.polymarketFeeSchedule({ feeType: 'sports_fees_v2' }), { rate: 0.05, exponent: 1, type: 'sports_fees_v2' }, 'a sports market without its schedule is not taken as free');
  assert.equal(A.polymarketFeeSchedule({}), null, 'no schedule (geopolitics, world events): no fee');
  assert.equal(A.polymarketFeeSchedule({ feeSchedule: { rate: 0 } }), null);
  assert.equal(A.polymarketFeeSchedule({ feeSchedule: 'not json' }), null);
  // 1,000 shares at 40¢: 1000 × 0.05 × 0.4 × 0.6 = $12
  assert.ok(Math.abs(A.polymarketFee(0.4, 1000, { rate: 0.05, exponent: 1 }) - 12) < 1e-9);
  assert.ok(Math.abs(A.polymarketFee(0.4, 1000, { rate: 0.05, exponent: 2 }) - 1000 * 0.05 * 0.24 ** 2) < 1e-9, 'exponent e: (p(1 − p))^e');
  assert.equal(A.polymarketFee(0.4, 1000, null), 0);
  assert.equal(A.polymarketFee(1, 1000, { rate: 0.05, exponent: 1 }), 0);

  const [row] = pRows(pmGame({ feeType: 'sports_fees_v2', feeSchedule: sched }));
  assert.deepEqual(row.feeSchedule, { rate: 0.05, exponent: 1, type: 'sports_fees_v2' });
  assert.equal(row.yesIndex, 0);
  assert.deepEqual(row.tokenIds, ['111', '222']);
  assert.equal(pRows(pmGame())[0].feeSchedule, null);
});

test('polymarket fee in arbs: each Polymarket leg pays its market\'s taker fee', () => {
  // free: Kalshi Boston 0.55 + Polymarket Knicks 0.40, +3.37% (see above)
  const sports = { feeType: 'sports_fees_v2', feeSchedule: { rate: 0.05, exponent: 1, takerOnly: true } };
  const [a] = A.findCrossArbs(kRows(kalshiGame()), pRows(pmGame(sports)), opts());
  assert.ok(a, 'still an arb after the fee');
  const pm = a.stakes.legs.find(l => l.venue === 'polymarket');
  // 102 contracts: 0.55 × 102 + 1.77 Kalshi fee = 57.87; 0.40 × 102 = 40.80 + 102 × 0.05 × 0.24 = 1.224 fee
  assert.equal(a.stakes.contracts, 102);
  assert.equal(pm.fee, 1.22);
  assert.equal(pm.stake, 42.02);
  assert.equal(a.stakes.cost, 99.89);
  assert.equal(a.profitPct, 2.11, 'down from 3.37% with no fee');
  assert.deepEqual(a.legs[1].feeSchedule, { rate: 0.05, exponent: 1, type: 'sports_fees_v2' }, 'the leg carries its schedule so a restake charges it too');
  assert.equal(A.stakeArb(a, 1000).legs[1].fee, Math.round(A.stakeArb(a, 1000).contracts * 0.05 * 0.24 * 100) / 100);
  // a thinner gap: 0.57 + 0.41 = 0.98 is an arb with no Polymarket fee and a loss with it
  const ks = kRows(kalshiGame({ yes_ask_dollars: '0.5700' }));
  assert.equal(A.findCrossArbs(ks, pRows(pmGame({ bestAsk: 0.41, bestBid: 0.4 })), opts({ kalshiFeeRate: 0 })).length, 1);
  assert.deepEqual(A.findCrossArbs(ks, pRows(pmGame({ bestAsk: 0.41, bestBid: 0.4, ...sports })), opts({ kalshiFeeRate: 0 })).filter(x => x.legs[0].side === 'yes'), []);

  // underround: every leg pays 0.05 × p(1 − p) a share. Σ asks 0.97 (+3.09% free) plus
  // 0.05 × (0.16 + 0.1875 + 0.1875 + 0.1971) = 3.7¢ of fees a set is a loss
  const cands = [['A', 0.2, 0.19], ['B', 0.25, 0.24], ['C', 0.25, 0.24], ['D', 0.27, 0.26]];
  const cup = extra => pRows(pmField('4402', 'cup', 'Cup winner', cands.map(c => [...c, extra]), { tags: [{ label: 'Sports' }] }));
  assert.equal(A.findUnderrounds(cup({}), opts())[0].profitPct, 3.09);
  assert.deepEqual(A.findUnderrounds(cup(sports), opts({ minPct: 0 })), [], 'the sports fee eats the 3%');
  // a lighter schedule leaves some: rate 0.01 → 0.73¢ a set
  const [u] = A.findUnderrounds(cup({ feeSchedule: { rate: 0.01, exponent: 1 } }), opts());
  const perSet = 0.97 + 0.01 * (0.2 * 0.8 + 0.25 * 0.75 * 2 + 0.27 * 0.73);
  assert.ok(Math.abs(u.totalCost - perSet) < 0.001, `${u.totalCost} vs ${perSet}`);
  assert.ok(u.profitPct > 2.2 && u.profitPct < 2.4, String(u.profitPct));
});

// ── US mode ──
test('US mode: only Kalshi and US sportsbook legs; Kalshi-vs-Polymarket and Polymarket-only arbs hidden', () => {
  const { ks, ps } = politics();
  const kalshi = [...ks, ...kRows(kalshiGame(), kalshiField('KXFEDDECISION-26DEC', 'Fed decision in Dec 2026?', 'Economics', [['Cut 25bps', 30, 72], ['Hold', 30, 72], ['Cut >25bps', 10, 92], ['Hike', 23, 79]]))];
  const oscars = pmField('4401', 'oscars', 'Oscars 2027: Best Picture Winner', [['A', 0.2, 0.19], ['B', 0.25, 0.24], ['C', 0.25, 0.24], ['D', 0.27, 0.26]], { tags: [{ label: 'Culture' }] });
  const polymarket = [...ps, ...pRows(pmGame(), oscars)];
  const kalshiBooks = X.parseKalshiMarkets({ markets: kalshiGame().markets });
  const games = X.attachExchanges([oddsGame([bookH2h('draftkings', -200, 170), bookH2h('pinnacle', -200, 180), bookH2h('bovada', -200, 175)])], kalshiBooks, { now: NOW });
  const pmBook = X.attachExchanges([oddsGame([bookH2h('draftkings', -140, 120)])], X.parsePolymarketEvents([pmGame()], 'nba'), { now: NOW });

  const intl = A.findArbs({ kalshi, polymarket, games: [...games, ...pmBook] }, opts());
  assert.deepEqual([...new Set(intl.map(a => a.type))].sort(), ['book', 'cross', 'multi']);
  assert.ok(intl.some(a => a.legs.some(l => l.venue === 'polymarket')));
  assert.ok(intl.some(a => a.type === 'book' && a.legs[1].venue === 'pinnacle'), 'intl: the best book anywhere');

  const us = A.findArbs({ kalshi, polymarket, games: [...games, ...pmBook] }, opts({ region: 'us' }));
  assert.ok(us.length >= 2);
  assert.ok(us.every(a => a.legs.every(l => l.venue !== 'polymarket')), 'never a Polymarket leg');
  assert.ok(!us.some(a => a.type === 'cross'), 'no Kalshi vs Polymarket');
  assert.ok(!us.some(a => a.exchange === 'polymarket'), 'no Polymarket underround');
  assert.ok(us.some(a => a.type === 'multi' && a.exchange === 'kalshi'), 'a Kalshi underround stays');
  const book = us.find(a => a.type === 'book');
  assert.deepEqual(book.legs.map(l => [l.venue, l.american]), [['kalshi', -133], ['draftkings', 170]], 'offshore books (Pinnacle, Bovada) are skipped, DraftKings is used');
  assert.ok(us.every(A.usPlaceable));
  assert.equal(JSON.stringify(us).includes('polymarket.com'), false, 'nothing links to polymarket.com');
  // the default region is US
  assert.deepEqual(A.findArbs({ kalshi, polymarket, games }, { now: NOW }).map(a => a.id), A.findArbs({ kalshi, polymarket, games }, opts({ region: 'us' })).map(a => a.id));

  assert.equal(A.isUsVenue('kalshi'), true);
  assert.equal(A.isUsVenue('novig'), true);
  assert.equal(A.isUsVenue('prophetx'), true);
  assert.equal(A.isUsVenue('fanduel'), true);
  for (const k of ['polymarket', 'pinnacle', 'betfair_ex_uk', 'bovada', 'betonlineag', '']) assert.equal(A.isUsVenue(k), false, k);
  assert.equal(A.usPlaceable({ legs: [] }), false);
  assert.equal(A.regionFromEnv({}), 'us');
  assert.equal(A.regionFromEnv({ TAIL_REGION: 'INTL' }), 'intl');
  assert.equal(A.regionFromEnv({ TAIL_REGION: 'eu' }), 'us', 'anything but intl is US mode');
});

// ── where to tail ──
const celticsBuy = (o = {}) => ({ type: 'entry', conditionId: '0xABC', asset: '222', outcome: 'Celtics', outcomeIndex: 1, market: 'Knicks vs. Celtics',
  currentPrice: 0.61, url: 'https://polymarket.com/event/nba-nyk-bos-2026-10-08', ...o });
function sportsIndex({ books = [bookH2h('draftkings', -200, 170), bookH2h('fanduel', -190, 160), bookH2h('pinnacle', -165, 150)], pm = {}, k = [] } = {}) {
  const kalshi = kRows(kalshiGame(...k)), polymarket = pRows(pmGame(pm));
  const games = X.attachExchanges([oddsGame(books)], X.parseKalshiMarkets({ markets: kalshiGame(...k).markets }), { now: NOW });
  return A.venueIndex({ kalshi, polymarket, matches: A.matchMarkets(kalshi, polymarket, opts()), games }, opts());
}

test('where to tail: a Polymarket team bet → the same team on Kalshi (YES, or NO on the opponent) and at US sportsbooks', () => {
  const idx = sportsIndex();
  assert.equal(idx.size, 1);
  const us = A.venueQuotes(celticsBuy(), idx, opts({ region: 'us' }));
  const kalshiFee = Math.ceil(0.07 * 100 * 0.55 * 0.45 * 100 - 1e-9) / 100 / 100;   // per contract on a 100-lot
  assert.deepEqual(us.filter(q => q.key === 'kalshi').map(q => [q.marketId, q.side, q.pick, q.price, q.fee]), [
    ['KXNBAGAME-26OCT08NYKBOS-BOS', 'yes', 'Boston', 0.55, kalshiFee],
    ['KXNBAGAME-26OCT08NYKBOS-NYK', 'no', 'Boston', 0.55, kalshiFee],
  ], 'Celtics win = Boston YES = New York K NO');
  const books = us.filter(q => q.book);
  assert.deepEqual(books.map(q => [q.key, q.american, q.pick]), [['draftkings', -200, 'Boston Celtics'], ['fanduel', -190, 'Boston Celtics']], 'no Pinnacle in US mode; the attached exchange books are not sportsbooks');
  assert.ok(Math.abs(books[1].price - 190 / 290) < 1e-6, 'implied price 1/decimal');
  assert.equal(books[1].fee, 0);
  assert.ok(!us.some(q => q.key === 'polymarket'), 'never Polymarket in US mode');
  assert.ok(us.every(q => !String(q.url || '').includes('polymarket.com')));
  assert.equal(us[0].url, 'https://kalshi.com/markets/kxnbagame-26oct08nykbos');

  // the other side: Knicks → New York K YES / Boston NO at 0.47, books' Knicks price
  const knicks = A.venueQuotes(celticsBuy({ outcome: 'Knicks', outcomeIndex: 0, currentPrice: 0.4, asset: '111' }), idx, opts({ region: 'us' }));
  assert.deepEqual(knicks.filter(q => q.key === 'kalshi').map(q => [q.side, q.pick, q.price]), [['no', 'New York K', 0.47], ['yes', 'New York K', 0.47]]);
  assert.deepEqual(knicks.filter(q => q.book).map(q => [q.key, q.american]), [['draftkings', 170], ['fanduel', 160]]);
  // matched by token when the conditionId is missing, by outcome label when the index is
  assert.equal(A.venueQuotes(celticsBuy({ conditionId: null }), idx, opts()).filter(q => q.key === 'kalshi').length, 2);
  assert.deepEqual(A.venueQuotes(celticsBuy({ outcomeIndex: null }), idx, opts()).filter(q => q.key === 'kalshi').map(q => q.side), ['yes', 'no']);

  // intl: every book, and Polymarket itself at its ask with its fee
  const intl = A.venueQuotes(celticsBuy(), sportsIndex({ pm: { feeType: 'sports_fees_v2', feeSchedule: { rate: 0.05, exponent: 1 } } }), opts());
  assert.ok(intl.some(q => q.key === 'pinnacle'));
  const pm = intl.find(q => q.key === 'polymarket');
  assert.equal(pm.price, 0.61);
  assert.ok(Math.abs(pm.fee - 0.05 * 0.61 * 0.39) < 1e-6);
  assert.ok(Math.abs(pm.cost - (0.61 + 0.05 * 0.61 * 0.39)) < 1e-6);
  // the signal's own fee (from the market's Gamma schedule) wins over a scan row without one
  const own = A.venueQuotes(celticsBuy({ fee: 0.0119 }), idx, opts()).find(q => q.key === 'polymarket');
  assert.deepEqual([own.price, own.fee], [0.61, 0.0119]);

  // nothing matched: no quotes (the server shows "watch only")
  assert.deepEqual(A.venueQuotes(celticsBuy({ conditionId: '0xnope', asset: 'x' }), idx, opts({ region: 'us' })), []);
  assert.deepEqual(A.venueQuotes(celticsBuy(), A.venueIndex({}, opts()), opts({ region: 'us' })), []);
  assert.deepEqual(A.venueQuotes(null, idx, opts()), []);
  // a game that already started, or a Kalshi market that stopped trading, is not a venue
  assert.deepEqual(A.venueQuotes(celticsBuy(), idx, opts({ region: 'us', now: Date.parse(START) + 60e3 })).filter(q => q.book), []);
  const paused = sportsIndex({ k: [{ status: 'paused' }, { status: 'paused' }] });
  assert.deepEqual(A.venueQuotes(celticsBuy(), paused, opts({ region: 'us' })).filter(q => q.key === 'kalshi'), []);
  // a three-way line (soccer with a draw) is not the same bet as a two-way moneyline
  const threeWay = sportsIndex({ books: [{ key: 'draftkings', title: 'DraftKings', markets: [{ key: 'h2h', outcomes: [{ name: 'Boston Celtics', price: -200 }, { name: 'New York Knicks', price: 170 }, { name: 'Draw', price: 900 }] }] }] });
  assert.deepEqual(A.venueQuotes(celticsBuy(), threeWay, opts({ region: 'us' })).filter(q => q.book), []);
});

test('where to tail: a title-matched market maps YES to YES and NO to NO', () => {
  const { ks, ps } = politics();
  const idx = A.venueIndex({ kalshi: ks, polymarket: ps }, opts());
  const newsom = ps.find(r => r.outcomeLabel === 'Gavin Newsom');
  const yes = A.venueQuotes({ type: 'entry', conditionId: newsom.conditionId, outcome: 'Yes', outcomeIndex: 0 }, idx, opts({ region: 'us' }));
  assert.equal(yes.length, 1);
  assert.deepEqual([yes[0].key, yes[0].side, yes[0].pick, yes[0].price, yes[0].match], ['kalshi', 'yes', 'Gavin Newsom', 0.3, 'title']);
  assert.equal(yes[0].warning, A.RULES_WARNING, 'a title match carries the rules warning');
  const no = A.venueQuotes({ type: 'entry', conditionId: newsom.conditionId, outcome: 'No', outcomeIndex: 1 }, idx, opts({ region: 'us' }));
  assert.deepEqual(no.map(q => [q.side, q.pick, q.price]), [['no', 'NO Gavin Newsom', 0.72]]);
  assert.equal(A.venueQuotes({ conditionId: newsom.conditionId, outcome: 'No' }, idx, opts({ region: 'us' }))[0].side, 'no', 'label when no index');
  // a candidate Kalshi doesn't list (the "Other" market) has nothing to match
  const other = ps.find(r => r.outcomeLabel === 'Other');
  assert.deepEqual(A.venueQuotes({ conditionId: other.conditionId, outcome: 'Yes', outcomeIndex: 0 }, idx, opts({ region: 'us' })), []);
});

test('pickVenue: most units, then the cheaper all-in cost, then the lower price', () => {
  const q = (key, units, price, fee = 0) => ({ key, units, price, fee, cost: price + fee });
  assert.equal(A.pickVenue([q('kalshi', 1.2, 0.55, 0.0174), q('draftkings', 1.5, 0.6667), q('fanduel', 1.5, 0.6552)]).key, 'fanduel', 'tie on units: lower price');
  assert.equal(A.pickVenue([q('kalshi', 2, 0.55, 0.0174), q('fanduel', 1.5, 0.5)]).key, 'kalshi', 'more units wins');
  assert.equal(A.pickVenue([q('a', 1, 0.5, 0.02), q('b', 1, 0.51, 0)]).key, 'b', 'all-in 0.51 beats 0.52');
  assert.equal(A.pickVenue([q('a', 0, 0.7), q('b', 0, 0.65)]).key, 'b', 'all 0u: the cheapest');
  assert.equal(A.pickVenue([]), null);
  assert.equal(A.pickVenue(null), null);
});

// ── filters and the full scan ──
test('minimum profit: XARB_MIN_PCT, default 0.5%', () => {
  // Σ 0.997: 100 contracts for $99.70, +0.30%
  const ev = pmField('5501', 'thin', 'Thin', [['A', 0.497, 0.49], ['B', 0.5, 0.49]]);
  const rows = pRows(ev);
  assert.equal(A.findUnderrounds(rows, opts())[0].profitPct, 0.3);
  assert.deepEqual(A.findArbs({ polymarket: rows }, opts()), [], 'below the default 0.5%');
  assert.equal(A.findArbs({ polymarket: rows }, opts({ minPct: 0.25 })).length, 1);
  assert.deepEqual(A.optsFromEnv({ XARB_MIN_PCT: '0.25', POLYMARKET_FEE_RATE: '0.01' }), { minPct: 0.25, polymarketFeeRate: 0.01, kalshiFeeRate: undefined, region: 'us' });
  assert.equal(A.findArbs({ polymarket: rows }, opts(A.optsFromEnv({ XARB_MIN_PCT: '0.25', TAIL_REGION: 'intl' }))).length, 1);
  assert.equal(A.findArbs({ polymarket: rows }, opts(A.optsFromEnv({ TAIL_REGION: 'intl' }))).length, 0, 'unset env keeps the default');
  assert.equal(A.findArbs({ polymarket: rows }, opts(A.optsFromEnv({ XARB_MIN_PCT: '0.25' }))).length, 0, 'US mode (the default): a Polymarket-only arb is hidden');
});

test('findArbs: all three kinds, best first, markets past their close skipped', () => {
  const { ks, ps } = politics();
  const kalshi = [...ks, ...kRows(kalshiGame(), kalshiField('KXFEDDECISION-26DEC', 'Fed decision in Dec 2026?', 'Economics', [['Cut 25bps', 30, 72], ['Hold', 30, 72], ['Cut >25bps', 10, 92], ['Hike', 23, 79]]))];
  const polymarket = [...ps, ...pRows(pmGame())];
  const games = X.attachExchanges([oddsGame([bookH2h('draftkings', -200, 170)])], X.parseKalshiMarkets({ markets: kalshiGame().markets }), { now: NOW });
  const arbs = A.findArbs({ kalshi, polymarket, games }, opts());
  assert.deepEqual(arbs.map(a => a.type).sort(), ['book', 'cross', 'cross', 'multi']);
  for (let i = 1; i < arbs.length; i++) assert.ok(arbs[i - 1].profitPct >= arbs[i].profitPct);
  assert.ok(arbs.every(a => a.id && a.at === new Date(NOW).toISOString() && a.stakes && a.stakes.bankroll === 100));
  assert.equal(new Set(arbs.map(a => a.id)).size, arbs.length, 'ids are unique');
  // ids are stable from scan to scan
  assert.deepEqual(A.findArbs({ kalshi, polymarket, games }, opts()).map(a => a.id), arbs.map(a => a.id));

  const late = A.findArbs({ kalshi, polymarket }, opts({ now: Date.parse('2026-10-09T03:00:00Z') }));
  assert.ok(!late.some(a => a.title === 'New York K at Boston'), 'game market past its expected close');
});

test('fetchers page through both exchanges; a failed page keeps what came before', async () => {
  const calls = [];
  const kalshiPages = { '': { events: [kalshiGame()], cursor: 'c2' }, c2: { events: [kalshiField('KXFEDDECISION-26DEC', 'Fed decision in Dec 2026?', 'Economics', [['Hold', 60, 42]])], cursor: '' } };
  const pmPages = [[pmGame(), pmField('1', 'a', 'A', [['X', 0.5, 0.4]])], [pmField('2', 'b', 'B', [['Y', 0.5, 0.4]])]];
  const http = {
    async get(url, o) {
      calls.push({ url, ...o });
      if (url === A.KALSHI_EVENTS_URL) return { data: kalshiPages[o.params.cursor || ''] };
      if (o.params.offset >= 2 * o.params.limit) throw new Error('should have stopped');
      return { data: pmPages[o.params.offset / o.params.limit] };
    },
  };
  const k = await A.fetchKalshiEvents(http);
  assert.equal(k.events.length, 2);
  assert.equal(k.pages, 2);
  assert.deepEqual(calls[0], { url: 'https://api.elections.kalshi.com/trade-api/v2/events', params: { status: 'open', with_nested_markets: true, limit: 200 }, timeout: 15000 });
  assert.equal(calls[1].params.cursor, 'c2');

  calls.length = 0;
  const p = await A.fetchPolymarketEvents(http, { limit: 2 });
  assert.equal(p.events.length, 3);
  assert.deepEqual(calls.map(c => c.params), [
    { active: true, closed: false, order: 'volume24hr', ascending: false, limit: 2, offset: 0 },
    { active: true, closed: false, order: 'volume24hr', ascending: false, limit: 2, offset: 2 },
  ], 'busiest first, so a page cap drops the quiet events');
  assert.equal(p.truncated, false);
  assert.equal(k.truncated, false);
  assert.equal(calls[0].url, 'https://gamma-api.polymarket.com/events');

  const flaky = { calls: 0, async get(url, o) { if (this.calls++) throw new Error('429'); return { data: url.includes('kalshi') ? { events: [kalshiGame()], cursor: 'next' } : pmPages[0] }; } };
  const fk = await A.fetchKalshiEvents(flaky);
  assert.equal(fk.events.length, 1);
  assert.deepEqual(fk.errors, [{ exchange: 'kalshi', key: 'events page 2', message: '429' }]);
  flaky.calls = 0;
  const fp = await A.fetchPolymarketEvents(flaky, { limit: 2 });
  assert.equal(fp.events.length, 2);
  assert.equal(fp.errors[0].exchange, 'polymarket');

  const capped = await A.fetchKalshiEvents({ async get() { return { data: { events: [kalshiGame()], cursor: 'forever' } }; } }, { maxPages: 3 });
  assert.equal(capped.pages, 3, 'maxPages stops an endless cursor');
  assert.equal(capped.truncated, true, 'and says the list was cut short');
  const pmCapped = await A.fetchPolymarketEvents({ async get() { return { data: pmPages[0] }; } }, { limit: 2, maxPages: 2 });
  assert.equal(pmCapped.truncated, true);

  // onPage: each page parsed as it lands, raw events not kept
  const seen = [];
  const streamed = await A.fetchKalshiEvents(http, { onPage: page => seen.push(page.length) });
  assert.deepEqual(seen, [1, 1]);
  assert.deepEqual(streamed.events, []);
  assert.equal(streamed.count, 2);
});

test('scanExchanges: fetch, parse and find in one call', async () => {
  const http = {
    async get(url) {
      if (url === A.KALSHI_EVENTS_URL) return { data: { events: [kalshiGame()], cursor: null } };
      return { data: [pmGame()] };
    },
  };
  const r = await A.scanExchanges(http, opts());
  assert.equal(r.arbs.length, 1);
  assert.equal(r.arbs[0].type, 'cross');
  assert.deepEqual(r.counts, { kalshiEvents: 1, polymarketEvents: 1, kalshiMarkets: 2, polymarketMarkets: 3, arbs: 1, kalshiTruncated: false, polymarketTruncated: false });
  assert.deepEqual(r.errors, []);
  assert.equal(r.updated, new Date(NOW).toISOString());

  const down = await A.scanExchanges({ async get() { throw new Error('ECONNREFUSED'); } }, opts());
  assert.deepEqual(down.arbs, []);
  assert.equal(down.errors.length, 2);
});

// ── US venues beyond the built-in leagues: soccer, tennis, esports ──
const kEvent = (eventTicker, title, labels, o = {}) => ({
  event_ticker: eventTicker, series_ticker: eventTicker.split('-')[0], title, category: 'Sports', mutually_exclusive: true,
  markets: labels.map(([label, yes, no, m = {}]) => ({
    ticker: `${eventTicker}-${label.replace(/[^A-Z]/gi, '').slice(0, 3).toUpperCase()}`, event_ticker: eventTicker, title: `${label} wins`,
    yes_sub_title: label, no_sub_title: label, status: 'active', yes_ask_dollars: yes, no_ask_dollars: no,
    close_time: '2026-10-11T18:30:00Z', expected_expiration_time: o.exp || '2026-10-09T21:30:00Z', ...m,
  })),
});
const dortmundBremen = (o = {}) => kEvent('KXBUNDESLIGAGAME-26OCT09BVBSVW', 'Dortmund vs Bremen',
  [['Dortmund', '0.7300', '0.2800'], ['Bremen', '0.1100', '0.9000'], ['Tie', '0.1700', '0.8400']], o);
// Polymarket's soccer event: one YES/NO market per team and one for the draw
const pmSoccer = ({ id = '1083681', slug = 'bun-dor-wer-2026-10-09', home = 'BV Borussia 09 Dortmund', away = 'SV Werder Bremen', start = '2026-10-09 18:30:00+00' } = {}) => ({
  id, slug, title: `${home} vs. ${away}`, negRisk: true, endDate: '2026-10-09T18:30:00Z',
  tags: [{ label: 'Sports', slug: 'sports' }, { label: 'Soccer', slug: 'soccer' }, { label: 'Bundesliga', slug: 'bundesliga' }],
  markets: [
    [`Will ${home} win on 2026-10-09?`, home, 0.74, 0.72, 'h'],
    [`Will ${home} vs. ${away} end in a draw?`, `Draw (${home} vs. ${away})`, 0.17, 0.16, 'd'],
    [`Will ${away} win on 2026-10-09?`, away, 0.12, 0.11, 'a'],
  ].map(([question, groupItemTitle, ask, bid, k]) => ({
    id: `${id}${k}`, question, groupItemTitle, conditionId: `0x${id}${k}`, slug: `${slug}-${k}`, outcomes: '["Yes","No"]',
    clobTokenIds: `["${id}${k}y","${id}${k}n"]`, bestAsk: ask, bestBid: bid, active: true, closed: false, negRisk: true,
    sportsMarketType: 'moneyline', gameStartTime: start, endDate: '2026-10-09T18:30:00Z',
  })),
});

test('college games: Kalshi "Ohio St." pairs with Polymarket "Ohio State", and never with Ohio', () => {
  const ks = kRows(kEvent('KXNCAAFGAME-26OCT10MDOSU', 'Maryland vs Ohio St.', [['Maryland', '0.1500', '0.8600'], ['Ohio St.', '0.8600', '0.1500']],
    { exp: '2026-10-10T22:30:00Z' }));
  const pm = (title, outcomes) => pRows({ ...pmGame({ question: title, outcomes, conditionId: '0xcfb', slug: 'cfb-md-ohiost-2026-10-10',
    gameStartTime: '2026-10-10 19:30:00+00', endDate: '2026-10-10T19:30:00Z' }), id: '9100', slug: 'cfb-md-ohiost-2026-10-10', title,
    tags: [{ label: 'Sports', slug: 'sports' }, { label: 'College Football', slug: 'cfb' }], endDate: '2026-10-10T19:30:00Z' });
  const m = A.matchMarkets(ks, pm('Maryland vs. Ohio State', '["Maryland","Ohio State"]'), opts()).filter(x => x.by === 'teams');
  assert.deepEqual(m.map(x => [x.kalshi.outcomeLabel, x.same]), [['Maryland', true], ['Ohio St.', false]]);
  assert.deepEqual(A.matchMarkets(ks, pm('Maryland vs. Ohio', '["Maryland","Ohio"]'), opts()).filter(x => x.by === 'teams'), [], 'Ohio is another school');
});

test('kalshi tickers: the date (and a start time, when there is one) in US Eastern time', () => {
  assert.deepEqual(A.kalshiTickerTime('KXLOLGAME-26OCT091200KOIATLN'), { day: Date.parse('2026-10-09T04:00:00Z'), start: Date.parse('2026-10-09T16:00:00Z') });
  assert.deepEqual(A.kalshiTickerTime('KXATPMATCH-26OCT05BELMUL'), { day: Date.parse('2026-10-05T04:00:00Z'), start: null });
  assert.deepEqual(A.kalshiTickerTime('KXBUNDESLIGAGAME-26OCT09BVBSVW').start, null, 'team codes are not a time');
  assert.equal(A.kalshiTickerTime('KXCS2GAME-26DEC201430FALSPI').start, Date.parse('2026-12-20T19:30:00Z'), 'EST in winter');
  assert.equal(A.kalshiTickerTime('KXHOFGAME-26OCT101899HOF').start, null, '18:99 is not a time');
  assert.equal(A.kalshiTickerTime('KXFED-26DEC'), null);
  assert.equal(A.kalshiTickerTime(null), null);
  const [row] = kRows(kEvent('KXLOLGAME-26OCT091200KOIATLN', 'Movistar KOI Fénix vs. TLN Pirates', [['Movistar KOI Fénix', '0.55', '0.46'], ['TLN Pirates', '0.49', '0.52']]));
  assert.equal(row.startTime, '2026-10-09T16:00:00.000Z');
  assert.equal(row.kind, 'teams');
});

test('team names: club letters, numbers and initials aside, the same club or player', () => {
  const yes = [['Dortmund', 'BV Borussia 09 Dortmund'], ['Bremen', 'SV Werder Bremen'], ['C. Alcaraz', 'Carlos Alcaraz'], ['Alcaraz', 'Carlos Alcaraz'],
    ['Man Utd', 'Manchester United'], ['Bayern Munich', 'FC Bayern München'], ['Mainz', 'Mainz 05'], ['Spirit', 'Team Spirit'], ['Movistar KOI Fénix', 'Movistar KOI Fenix']];
  for (const [a, b] of yes) assert.ok(A.nameMatch(a, b), `${a} = ${b}`);
  const no = [['Sebastian Baez', 'Sebastian Korda'], ['Manchester United', 'Manchester City'], ['New York Rangers', 'New York Islanders'],
    ['Real Madrid', 'Real Sociedad'], ['Chicago White Sox', 'Boston Red Sox'], ['Team Liquid', 'Team Spirit'], ['FC', 'FC Porto'], ['', 'Arsenal']];
  for (const [a, b] of no) assert.ok(!A.nameMatch(a, b), `${a} ≠ ${b}`);
  // Kalshi's schools: a last "St." is State, a first one Saint; State is part of the name
  const schools = [['Ohio St.', 'Ohio State'], ['San Jose St.', 'San José State'], ['NC St.', 'NC State'], ['Mississippi St.', 'Mississippi State'],
    ["Hawai'i", 'Hawaii'], ['St. Thomas', 'Saint Thomas'], ["St. John's", "Saint John's"], ['St. Louis Cardinals', 'Saint Louis Cardinals']];
  for (const [a, b] of schools) assert.ok(A.nameMatch(a, b), `${a} = ${b}`);
  const notSchools = [['Ohio', 'Ohio St.'], ['Iowa St.', 'Iowa'], ['Washington St.', 'Washington'], ['Tennessee', 'Tennessee St.'], ['Kansas St.', 'Kansas']];
  for (const [a, b] of notSchools) assert.ok(!A.nameMatch(a, b), `${a} ≠ ${b}`);
  // digits are team names, lines are not
  const g2 = kRows(kEvent('KXLOLGAME-26OCT101100G2VIT', 'G2 Esports vs. Team Vitality', [['G2 Esports', '0.6', '0.41'], ['Team Vitality', '0.41', '0.6']]));
  assert.ok(g2.every(r => r.kind === 'teams'));
  const total = kRows(kEvent('KXEPLGAME-26OCT10ARSCHE', 'Arsenal vs Chelsea', [['Over 2.5', '0.5', '0.5'], ['Under 2.5', '0.5', '0.5']]));
  assert.ok(total.every(r => r.kind === 'yesno'));
});

test('soccer: Kalshi team and tie markets pair with Polymarket win and draw markets, outcome by outcome', () => {
  const ks = kRows(dortmundBremen()), ps = pRows(pmSoccer());
  assert.deepEqual(ps.map(r => r.game3.pick), [0, 'draw', 1]);
  const m = A.matchMarkets(ks, ps, opts());
  assert.deepEqual(m.map(x => [x.kalshi.outcomeLabel, x.polymarket.outcomeLabel, x.same, x.by]), [
    ['Dortmund', 'BV Borussia 09 Dortmund', true, 'teams3'],
    ['Bremen', 'SV Werder Bremen', true, 'teams3'],
    ['Tie', 'Draw (BV Borussia 09 Dortmund vs. SV Werder Bremen)', true, 'teams3'],
  ]);
  // home and away the other way round: still team to team
  const flipped = A.matchMarkets(ks, pRows(pmSoccer({ home: 'SV Werder Bremen', away: 'BV Borussia 09 Dortmund' })), opts());
  assert.deepEqual(flipped.map(x => [x.kalshi.outcomeLabel, x.polymarket.outcomeLabel]),
    [['Dortmund', 'BV Borussia 09 Dortmund'], ['Bremen', 'SV Werder Bremen'], ['Tie', 'Draw (SV Werder Bremen vs. BV Borussia 09 Dortmund)']]);
  // another fixture, or the same two clubs a week later, is not this game
  assert.deepEqual(A.matchMarkets(ks, pRows(pmSoccer({ away: 'FC Bayern München' })), opts()), []);
  assert.deepEqual(A.matchMarkets(ks, pRows(pmSoccer({ start: '2026-10-16 18:30:00+00' })), opts()), []);
  // the title matcher leaves these to the game matcher
  assert.ok(!m.some(x => x.by === 'title'));

  // where to tail: NO on "Dortmund win" is NO on Dortmund at Kalshi, not YES on Bremen
  const idx = A.venueIndex({ kalshi: ks, polymarket: ps }, opts());
  const sig = (k, outcome, outcomeIndex) => ({ type: 'entry', conditionId: `0x1083681${k}`, asset: `1083681${k}${outcome === 'Yes' ? 'y' : 'n'}`, outcome, outcomeIndex });
  const q = s => A.venueQuotes(s, idx, opts({ region: 'us' })).map(v => [v.key, v.marketId, v.side, v.pick, v.price]);
  assert.deepEqual(q(sig('h', 'No', 1)), [['kalshi', 'KXBUNDESLIGAGAME-26OCT09BVBSVW-DOR', 'no', 'NO Dortmund', 0.28]]);
  assert.deepEqual(q(sig('d', 'Yes', 0)), [['kalshi', 'KXBUNDESLIGAGAME-26OCT09BVBSVW-TIE', 'yes', 'Tie', 0.17]]);
  assert.deepEqual(q(sig('a', 'Yes', 0)), [['kalshi', 'KXBUNDESLIGAGAME-26OCT09BVBSVW-BRE', 'yes', 'Bremen', 0.11]]);
  // and the pair is a cross-exchange arb candidate like any other match (intl)
  assert.ok(A.findCrossArbs(ks, ps, opts()).every(a => a.title === 'Dortmund vs Bremen'));
});

test('tennis and esports: players and teams by name, on the ticker date when Kalshi expects to settle a day out', () => {
  // Kalshi expects Bellucci–Muller (Oct 5) to settle at 05:00 the next morning
  const ks = kRows(kEvent('KXATPMATCH-26OCT05BELMUL', 'Bellucci vs Muller', [['Mattia Bellucci', '0.6700', '0.3400'], ['Alexandre Muller', '0.3400', '0.6700']], { exp: '2026-10-06T05:00:00Z' }));
  const pTennis = start => pRows({ id: 't1', slug: 'atp-bellucci-muller-2026-10-05', title: 'Shanghai Rolex Masters: Mattia Bellucci vs Alexandre Muller',
    markets: [{ id: 't10', question: 'Shanghai Rolex Masters: Mattia Bellucci vs Alexandre Muller', outcomes: '["Alexandre Muller","Mattia Bellucci"]',
      bestAsk: 0.35, bestBid: 0.34, active: true, closed: false, sportsMarketType: 'moneyline', gameStartTime: start, endDate: start, conditionId: '0xt10' }] });
  const m = A.matchMarkets(ks, pTennis('2026-10-05 10:00:00+00'), opts());
  assert.deepEqual(m.map(x => [x.kalshi.outcomeLabel, x.same]), [['Mattia Bellucci', false], ['Alexandre Muller', true]]);
  assert.deepEqual(A.matchMarkets(ks, pTennis('2026-10-08 10:00:00+00'), opts()), [], 'three days later is another match');

  // a series winner on Kalshi pairs with Polymarket's match winner, never a map winner
  const lol = kRows(kEvent('KXLOLGAME-26OCT091200KOIATLN', 'Movistar KOI Fénix vs. TLN Pirates', [['Movistar KOI Fénix', '0.5500', '0.4600'], ['TLN Pirates', '0.4900', '0.5200']], { exp: '2026-10-09T20:00:00Z' }));
  const market = (id, question, smt) => ({ id, question, outcomes: '["Movistar KOI Fénix","TLN Pirates"]', bestAsk: 0.56, bestBid: 0.54, active: true, closed: false,
    sportsMarketType: smt, gameStartTime: '2026-10-09 16:00:00+00', endDate: '2026-10-09T16:00:00Z', conditionId: `0x${id}` });
  const pLol = pRows({ id: 'l1', slug: 'lol-koi-tln-2026-10-09', title: 'LoL: Movistar KOI Fénix vs TLN Pirates (BO5) - EMEA Masters Playoffs',
    markets: [market('l1g1', 'LoL: Movistar KOI Fénix vs TLN Pirates - Game 1 Winner', 'child_moneyline'), market('l1m', 'LoL: Movistar KOI Fénix vs TLN Pirates (BO5) - EMEA Masters Playoffs', 'moneyline')] });
  assert.deepEqual([...new Set(A.matchMarkets(lol, pLol, opts()).map(x => x.polymarket.id))], ['l1m']);
});

test('kalshi game sweep: every GAME/MATCH series, least recently read first, quiet ones still checked', async () => {
  const reads = [];
  const events = {
    KXBUNDESLIGAGAME: [dortmundBremen()],
    KXATPMATCH: [kEvent('KXATPMATCH-26OCT05BELMUL', 'Bellucci vs Muller', [['Mattia Bellucci', '0.67', '0.34'], ['Alexandre Muller', '0.34', '0.67']])],
  };
  let failLol = false, t = NOW;
  const http = {
    async get(url, o) {
      if (url === A.KALSHI_SERIES_URL) return { data: { series: ['KXBUNDESLIGAGAME', 'KXATPMATCH', 'KXLOLGAME', 'KXNBAMVP', 'KXBUNDESLIGAGAME', 'KXBUNDESLIGATOTAL', 'KXFEDTOTAL'].map(ticker => ({ ticker })) } };
      const s = o.params.series_ticker;
      reads.push(s);
      if (s === 'KXLOLGAME' && failLol) throw new Error('429');
      return { data: { events: events[s] || [], cursor: '' } };
    },
  };
  const sweep = A.createKalshiGameSweep({ http, perScan: 3, quietSlots: 1, seeds: ['KXNBAGAME'], now: () => t });
  const first = await sweep.step();
  assert.equal(sweep.stats().series, 5, 'GAME/MATCH series and their TOTAL siblings, plus the built-in ones, once each; MVP races and a TOTAL with no game are not');
  assert.equal(reads.length, 3);
  assert.equal(new Set(first.map(r => r.eventKey)).size, reads.filter(s => events[s]).length);
  t += 60e3;
  reads.length = 0;
  const second = await sweep.step();
  assert.equal(reads.length, 3);
  assert.equal(sweep.stats().withGames, 2);
  assert.equal(second.length, 5, 'both games: 3 Bundesliga rows and 2 tennis rows');
  // series with games are re-read first; one slot still goes to a quiet series
  t += 60e3;
  reads.length = 0;
  await sweep.step();
  assert.equal(reads.filter(s => events[s]).length, 2);
  assert.equal(reads.filter(s => !events[s]).length, 1);
  // a failed read keeps a series' last rows until they are 30 min old
  events.KXLOLGAME = [kEvent('KXLOLGAME-26OCT091200KOIATLN', 'Movistar KOI Fénix vs. TLN Pirates', [['Movistar KOI Fénix', '0.55', '0.46'], ['TLN Pirates', '0.49', '0.52']])];
  for (let i = 0; i < 3; i++) { t += 60e3; await sweep.step(); }
  assert.ok((await sweep.step()).some(r => r.id.startsWith('KXLOLGAME')));
  failLol = true;
  t += 60e3;
  assert.ok((await sweep.step()).some(r => r.id.startsWith('KXLOLGAME')), 'kept through a failed read');
  t += 31 * 60e3;
  assert.ok(!(await sweep.step()).some(r => r.id.startsWith('KXLOLGAME')), 'dropped once stale');
  assert.match(sweep.stats().lastError, /KXLOLGAME: 429/);

  // no series list: the built-in one
  const offline = A.createKalshiGameSweep({ http: { async get(url) { if (url === A.KALSHI_SERIES_URL) throw new Error('down'); return { data: { events: [] } }; } }, now: () => NOW });
  await offline.step();
  assert.equal(offline.stats().series, A.SEED_GAME_SERIES.length);
  assert.equal(offline.stats().listed, 'built-in');
});

test('polymarket events: 100 a page (Gamma\'s cap), so the scan reads past the first 100', async () => {
  const offsets = [];
  const http = { async get(url, o) { offsets.push([o.params.offset, o.params.limit]); const n = o.params.offset < 200 ? 100 : 37; return { data: Array.from({ length: n }, (_, i) => pmField(`${o.params.offset + i}`, 's', 'T', [['X', 0.5, 0.4]])) }; } };
  const r = await A.fetchPolymarketEvents(http);
  assert.deepEqual(offsets, [[0, 100], [100, 100], [200, 100]]);
  assert.equal(r.count, 237);
  assert.equal(r.truncated, false);
});

// ── a paired game's totals and spreads ──
const kLines = (series, title, rows, o = {}) => ({
  event_ticker: `${series}-${o.tail || '26OCT09BVBSVW'}`, series_ticker: series, title, category: 'Sports', mutually_exclusive: false,
  markets: rows.map(([code, label, strike, yes, no]) => ({
    ticker: `${series}-${o.tail || '26OCT09BVBSVW'}-${code}`, event_ticker: `${series}-${o.tail || '26OCT09BVBSVW'}`, title: `${label}?`,
    yes_sub_title: label, no_sub_title: label, floor_strike: strike, strike_type: 'greater', status: 'active',
    yes_ask_dollars: yes, no_ask_dollars: no, close_time: '2026-10-11T18:30:00Z', expected_expiration_time: o.exp || '2026-10-09T22:30:00Z',
  })),
});
const dortmundTotals = () => kLines('KXBUNDESLIGATOTAL', 'Dortmund vs Bremen: Total Goals',
  [['2', 'Over 1.5 goals scored', 1.5, '0.8800', '0.1400'], ['3', 'Over 2.5 goals scored', 2.5, '0.7000', '0.3100'], ['4', 'Over 3.5 goals scored', 3.5, '0.4900', '0.5200']]);
const dortmundSpreads = () => kLines('KXBUNDESLIGASPREAD', 'Dortmund vs Bremen: Spread',
  [['BVB2', 'Dortmund wins by more than 1.5 goals', 1.5, '0.5000', '0.5100'], ['SVW2', 'Bremen wins by more than 1.5 goals', 1.5, '0.0400', '0.9700']]);
const H = 'BV Borussia 09 Dortmund', W2 = 'SV Werder Bremen';
const pmMore = () => ({
  id: '1083682', slug: 'bun-dor-wer-2026-10-09-more-markets', title: `${H} vs. ${W2} - More Markets`, negRisk: false,
  markets: [
    [`Spread: ${H} (-1.5)`, [H, W2], 'spreads', -1.5, 0.52, 0.5, 's1'],
    [`Spread: ${W2} (-1.5)`, [W2, H], 'spreads', -1.5, 0.05, 0.04, 's2'],
    [`${H} vs. ${W2}: O/U 2.5`, ['Over', 'Under'], 'totals', 2.5, 0.71, 0.69, 't2'],
    [`${H} vs. ${W2}: O/U 3.5`, ['Over', 'Under'], 'totals', 3.5, 0.5, 0.48, 't3'],
    [`${H} vs. ${W2}: ${H} O/U 1.5`, ['Over', 'Under'], 'totals', 1.5, 0.6, 0.58, 'tt'],
    [`${H} vs. ${W2}: O/U 3`, ['Over', 'Under'], 'totals', 3, 0.4, 0.38, 'tw'],
  ].map(([question, outs, type, line, ask, bid, k]) => ({
    id: `1083682${k}`, question, conditionId: `0x1083682${k}`, outcomes: JSON.stringify(outs), clobTokenIds: `["1083682${k}a","1083682${k}b"]`,
    sportsMarketType: type, line, bestAsk: ask, bestBid: bid, active: true, closed: false, gameStartTime: '2026-10-09 18:30:00+00', endDate: '2026-10-09T18:30:00Z',
  })),
});

test('lines: Kalshi totals and spreads carry the game\'s key; Polymarket\'s carry its slug; team totals and whole lines are left out', () => {
  const ks = kRows(dortmundBremen(), dortmundTotals(), dortmundSpreads());
  assert.ok(ks.every(r => r.gameKey === 'KXBUNDESLIGA|26OCT09BVBSVW'), 'one game across GAME, TOTAL and SPREAD');
  assert.deepEqual(ks.filter(r => r.kind === 'total').map(r => r.line), [1.5, 2.5, 3.5]);
  assert.deepEqual(ks.filter(r => r.kind === 'spread').map(r => [r.lineTeam, r.line]), [['Dortmund', 1.5], ['Bremen', 1.5]]);
  const ps = pRows(pmSoccer(), pmMore());
  assert.ok(ps.every(r => r.gameSlug === 'bun-dor-wer-2026-10-09'), 'the more-markets event is the same game');
  const lines = ps.filter(r => r.line != null);
  assert.deepEqual(lines.map(r => [r.kind, r.line, r.lineTeam ?? null, r.outcomeLabel]), [
    ['spread', 1.5, H, H], ['spread', 1.5, W2, W2], ['total', 2.5, null, 'Over'], ['total', 3.5, null, 'Over'],
  ], 'a team total and a whole line (it can push) are not game lines');
  // a "+" line: the other side is the one that must win by more
  const [plus] = pRows({ id: 'p', slug: 'x-y-z-2026-10-09', title: 'A vs. B', markets: [{ id: 'p1', question: 'Spread: A (+1.5)', outcomes: '["A","B"]', sportsMarketType: 'spreads', bestAsk: 0.6, bestBid: 0.58, active: true, closed: false }] });
  assert.deepEqual([plus.lineTeam, plus.outcomeLabel, plus.noLabel, plus.yesAsk, plus.noAsk], ['B', 'B', 'A', 0.42, 0.6]);
});

test('lines: a paired game\'s totals and spreads pair line by line, and tail to the same Kalshi side', () => {
  const ks = kRows(dortmundBremen(), dortmundTotals(), dortmundSpreads()), ps = pRows(pmSoccer(), pmMore());
  const m = A.matchMarkets(ks, ps, opts()).filter(x => x.by === 'line');
  assert.deepEqual(m.map(x => [x.kalshi.outcomeLabel, x.polymarket.title]), [
    ['Over 2.5 goals scored', `${H} vs. ${W2}: O/U 2.5`],
    ['Over 3.5 goals scored', `${H} vs. ${W2}: O/U 3.5`],
    ['Dortmund wins by more than 1.5 goals', `Spread: ${H} (-1.5)`],
    ['Bremen wins by more than 1.5 goals', `Spread: ${W2} (-1.5)`],
  ]);
  // no paired game, no lines
  assert.deepEqual(A.matchMarkets(kRows(dortmundTotals(), dortmundSpreads()), ps, opts()).filter(x => x.by === 'line'), []);
  // another game's lines don't ride on this pairing
  const other = kLines('KXBUNDESLIGATOTAL', 'Augsburg vs Bayern: Total Goals', [['3', 'Over 2.5 goals scored', 2.5, '0.6', '0.41']], { tail: '26OCT10FCABMU' });
  assert.ok(!A.matchMarkets(kRows(dortmundBremen(), other), ps, opts()).some(x => x.by === 'line'));

  const idx = A.venueIndex({ kalshi: ks, polymarket: ps }, opts());
  const q = s => A.venueQuotes(s, idx, opts({ region: 'us' })).map(v => [v.marketId, v.side, v.price]);
  // Under 2.5 is NO on Kalshi's Over 2.5, and the quote says so
  assert.deepEqual(q({ type: 'entry', conditionId: '0x1083682t2', outcome: 'Under', outcomeIndex: 1 }), [['KXBUNDESLIGATOTAL-26OCT09BVBSVW-3', 'no', 0.31]]);
  assert.equal(A.venueQuotes({ type: 'entry', conditionId: '0x1083682t2', outcome: 'Under', outcomeIndex: 1 }, idx, opts({ region: 'us' }))[0].buy, 'NO Over 2.5 goals scored');
  // Bremen +1.5 (the other side of Dortmund -1.5) is NO on "Dortmund wins by more than 1.5"
  assert.deepEqual(q({ type: 'entry', conditionId: '0x1083682s1', outcome: W2, outcomeIndex: 1 }), [['KXBUNDESLIGASPREAD-26OCT09BVBSVW-BVB2', 'no', 0.51]]);
  assert.deepEqual(q({ type: 'entry', conditionId: '0x1083682s2', outcome: W2, outcomeIndex: 0 }), [['KXBUNDESLIGASPREAD-26OCT09BVBSVW-SVW2', 'yes', 0.04]]);
});

test('lines: US games pair spreads and totals in the same event, the team found through the game pairing', () => {
  const nbaLines = [
    kLines('KXNBASPREAD', 'New York K at Boston: Spread', [['BOS5', 'Boston wins by more than 5.5 points', 5.5, '0.4800', '0.5400']], { tail: '26OCT08NYKBOS', exp: '2026-10-09T02:00:00Z' }),
    kLines('KXNBATOTAL', 'New York K at Boston: Total Points', [['221', 'Over 221.5 points scored', 221.5, '0.5200', '0.5000']], { tail: '26OCT08NYKBOS', exp: '2026-10-09T02:00:00Z' }),
  ];
  const ks = kRows(kalshiGame(), ...nbaLines), ps = pRows(pmGame());
  const m = A.matchMarkets(ks, ps, opts()).filter(x => x.by === 'line');
  assert.deepEqual(m.map(x => [x.kalshi.id, x.polymarket.id]), [['KXNBASPREAD-26OCT08NYKBOS-BOS5', '556'], ['KXNBATOTAL-26OCT08NYKBOS-221', '557']]);
});

// Polymarket US's league lists (pmus.arbRowsOf), shaped like the live gateway
const PMUS = require('../pmus');
const usd = v => ({ value: v, currency: 'USD' });
const usMarket = (slug, type, sides, bid, ask, o = {}) => ({ slug, question: slug, sportsMarketType: type, active: true, closed: false,
  status: 'MARKET_STATUS_OPEN', bestBidQuote: usd(bid), bestAskQuote: usd(ask), feeCoefficient: 0.0695, marketSides: sides, ...o });
const usTeam = (name, long) => ({ long, description: name, team: { name } });
const usNba = ({ bid = '0.5200', ask = '0.6000' } = {}) => PMUS.arbRowsOf({
  id: 7, slug: 'nba-nyk-bos-2026-10-08', title: 'NY Knicks vs. BOS Celtics', startTime: START, endDate: '2026-10-09T02:00:00Z', active: true, closed: false,
  teams: [{ name: 'New York Knicks' }, { name: 'Boston Celtics' }],
  markets: [
    usMarket('aec-nba-nyk-bos-2026-10-08', 'basketball_team_full_game_winner', [usTeam('New York Knicks', true), usTeam('Boston Celtics', false)], bid, ask),
    usMarket('tsc-nba-nyk-bos-2026-10-08-221pt5', 'basketball_team_full_game_total', [{ long: true, description: 'Over' }, { long: false, description: 'Under' }],
      '0.4400', '0.4500', { line: 221.5 }),
  ],
}, { league: 'nba' });
const usSoccer = (prices = [['0.7700', '0.7800'], ['0.1500', '0.1600'], ['0.0900', '0.1000']]) => PMUS.arbRowsOf({
  id: 8, slug: 'bun-dor-wer-2026-10-09', title: 'Dortmund vs. Bremen', startTime: '2026-10-09T18:30:00Z', active: true, closed: false,
  teams: [{ name: H }, { name: W2 }],
  markets: [[H, 'h'], [null, 'd'], [W2, 'a']].map(([team, k], i) => usMarket(`bun-dor-wer-2026-10-09-${k}`, 'soccer_team_full_time_winner',
    [{ long: true, description: team || 'Draw', ...(team ? { team: { name: team } } : {}) }, { long: false, description: 'No' }], ...prices[i])),
}, { league: 'bun' });

test('Polymarket US: its listed games pair with Kalshi\'s like Polymarket\'s do; both US venues; capped by the book\'s depth', () => {
  const kalshi = kRows(kalshiGame(), kLines('KXNBATOTAL', 'New York K at Boston: Total Points', [['221', 'Over 221.5 points scored', 221.5, '0.5200', '0.5000']],
    { tail: '26OCT08NYKBOS', exp: '2026-10-09T02:00:00Z' }));
  const us = usNba();
  const matches = A.matchMarkets(kalshi, us, opts());
  assert.deepEqual(matches.map(m => [m.by, m.kalshi.id, m.polymarket.id]), [
    ['teams', 'KXNBAGAME-26OCT08NYKBOS-BOS', 'aec-nba-nyk-bos-2026-10-08'], ['teams', 'KXNBAGAME-26OCT08NYKBOS-NYK', 'aec-nba-nyk-bos-2026-10-08'],
    ['line', 'KXNBATOTAL-26OCT08NYKBOS-221', 'tsc-nba-nyk-bos-2026-10-08-221pt5']]);
  const arbs = A.findUsArbs(kalshi, us, opts({ region: 'us', matches }));
  assert.equal(arbs.length, 2, 'the game once (its best direction) and the total');
  const game = arbs.find(a => a.legs[1].marketId === 'aec-nba-nyk-bos-2026-10-08');
  assert.deepEqual(game.legs.map(l => [l.venue, l.side, l.pick, l.price]), [['kalshi', 'no', 'New York K', 0.47], ['polymarketus', 'no', 'Boston Celtics', 0.48]],
    'NO on Boston at Kalshi is the Knicks; the Celtics sell into the Knicks\' 52¢ bid');
  // 0.47 + 0.48, plus Kalshi's fee and 0.0695 × 0.48 × 0.52 on Polymarket US
  assert.ok(game.profitPct > 1 && game.profitPct < 2, String(game.profitPct));
  assert.ok(Math.abs(game.stakes.legs[1].fee - Math.round(game.stakes.contracts * 0.0695 * 0.48 * 0.52 * 100) / 100) <= 0.01);
  const total = arbs.find(a => a !== game);
  assert.deepEqual(total.legs.map(l => [l.venue, l.side, l.price]), [['kalshi', 'no', 0.5], ['polymarketus', 'yes', 0.45]], 'Under at Kalshi, Over here');
  assert.ok(arbs.every(a => A.usPlaceable(a) && a.maxContracts === null && /postponed or canceled/.test(a.warnings.join(' '))));

  // on the live book 40 contracts sit at the Knicks' bid: no more than that
  const live = [PMUS.repriceRow(us[0], { bid: 0.52, ask: 0.6, bidSize: 40, askSize: 10, open: true }), us[1]];
  const relink = rows => matches.map(m => ({ ...m, polymarket: rows.find(r => r.id === m.polymarket.id) }));
  const deep = A.findUsArbs(kalshi, live, opts({ region: 'us', matches: relink(live) })).find(a => a.legs[1].marketId === us[0].id);
  assert.deepEqual([deep.legs[1].depth, deep.maxContracts, deep.stakes.contracts, deep.stakes.capped], [40, 40, 40, true]);
  const thin = [PMUS.repriceRow(us[0], { bid: 0.52, ask: 0.6, bidSize: 0.5, open: true }), us[1]];
  assert.equal(A.findUsArbs(kalshi, thin, opts({ matches: relink(thin) })).length, 1, 'not one whole contract: only the total is left');
  // a gap the fees eat
  const close = usNba({ bid: '0.5000' });
  assert.equal(A.findUsArbs(kalshi, close, opts({ matches: A.matchMarkets(kalshi, close, opts()) })).length, 1);
});

test('Polymarket US soccer: its three result markets pair with Kalshi\'s team and tie markets, and are an underround on their own', () => {
  const kalshi = kRows(dortmundBremen()), us = usSoccer();
  const matches = A.matchMarkets(kalshi, us, opts());
  assert.deepEqual(matches.map(m => [m.by, m.kalshi.outcomeLabel, m.polymarket.outcomeLabel]),
    [['teams3', 'Dortmund', H], ['teams3', 'Bremen', W2], ['teams3', 'Tie', 'Draw']]);
  const found = A.findUsArbs(kalshi, us, opts({ region: 'us', matches }));
  assert.equal(found.length, 1);
  const [a] = found;
  assert.deepEqual(a.legs.map(l => [l.venue, l.side, l.price]), [['kalshi', 'yes', 0.73], ['polymarketus', 'no', 0.23]], 'Dortmund at Kalshi, not Dortmund here');
  // 44¢ + 24¢ + 22¢ for every result, 0.0695 × p × (1 − p) on each
  const cheap = usSoccer([['0.4300', '0.4400'], ['0.2300', '0.2400'], ['0.2100', '0.2200']]);
  const [u] = A.findUsArbs([], cheap, opts({ region: 'us' }));
  const cost = 0.9 + 0.0695 * (0.44 * 0.56 + 0.24 * 0.76 + 0.22 * 0.78);
  assert.deepEqual([u.type, u.exchange, u.outcomes, u.exhaustive], ['multi', 'polymarketus', 3, true]);
  assert.ok(Math.abs(u.profitPct - ((1 - cost) / cost) * 100) < 0.05, String(u.profitPct));
  assert.equal(A.findUsArbs([], cheap.slice(0, 2), opts()).length, 0, 'a set missing an outcome is not complete');
});
