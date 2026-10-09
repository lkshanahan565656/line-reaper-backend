const test = require('node:test');
const assert = require('node:assert/strict');
const X = require('../exchanges');
const E = require('../ev');

const NOW = Date.parse('2026-10-08T12:00:00Z');
const START = '2026-10-08T23:00:00Z';
const game = (extra = {}) => ({ id: 'g1', home_team: 'Boston Celtics', away_team: 'New York Knicks', commence_time: START, bookmakers: [], ...extra });
const h2h = (key, home, away) => ({ key, markets: [{ key: 'h2h', outcomes: [{ name: 'Boston Celtics', price: home }, { name: 'New York Knicks', price: away }] }] });

const kalshiMarket = (team, yesAsk, noAsk, extra = {}) => ({
  ticker: `KXNBAGAME-26OCT08NYKBOS-${team.slice(0, 3).toUpperCase()}`, event_ticker: 'KXNBAGAME-26OCT08NYKBOS',
  title: 'New York K at Boston Winner?', yes_sub_title: team, no_sub_title: team, status: 'active',
  close_time: '2026-10-22T23:00:00Z', expected_expiration_time: '2026-10-09T02:00:00Z',
  yes_ask_dollars: yesAsk, no_ask_dollars: noAsk, yes_bid_dollars: null, no_bid_dollars: null, volume: 1000, ...extra,
});
const kalshiRows = markets => X.parseKalshiMarkets({ markets });

const polyEvent = (market = {}, extra = {}) => [{
  id: '9001', slug: 'nba-nyk-bos-2026-10-08', title: 'Knicks vs. Celtics', startDate: '2026-10-01T00:00:00Z', endDate: START,
  markets: [{
    id: '555', question: 'Knicks vs. Celtics', outcomes: '["Knicks","Celtics"]', outcomePrices: '["0.405","0.595"]',
    bestAsk: 0.41, bestBid: 0.40, active: true, closed: false, gameStartTime: '2026-10-08 23:00:00+00', sportsMarketType: 'moneyline',
    volume: '25000', ...market,
  }],
  ...extra,
}];
const book = (g, key) => g.bookmakers.find(b => b.key === key);
const priceOf = (bm, name) => bm.markets[0].outcomes.find(o => o.name === name).price;

test('kalshi fee rounds up to the cent', () => {
  assert.equal(X.kalshiFee(0.5), 0.02, '0.07 × 0.5 × 0.5 = 0.0175');
  assert.equal(X.kalshiFee(0.5, 100), 1.75, 'per order, so 100 contracts round once');
  assert.equal(X.kalshiFee(0.3), 0.02);
  assert.equal(X.kalshiFee(0.99), 0.01);
  assert.equal(X.kalshiFee(0.5, 1, 0), 0);
  assert.equal(X.kalshiFee(1), 0, 'no fee outside (0,1)');
});

test('effective american odds from ask plus fee', () => {
  assert.equal(X.effectiveAmerican(0.5), 100);
  assert.equal(X.effectiveAmerican(0.6), -150);
  assert.equal(X.effectiveAmerican(0.25), 300);
  assert.equal(X.effectiveAmerican(0.48, 0.02), 100, 'fee pushes the cost to 0.50');
  assert.equal(X.effectiveAmerican(0.58, X.kalshiFee(0.58)), -150);
  assert.equal(X.effectiveAmerican(0), null);
  assert.equal(X.effectiveAmerican(1), null);
  assert.equal(X.effectiveAmerican(0.99, 0.02), null, 'cost ≥ $1 pays nothing');
  assert.equal(X.effectiveAmerican(null), null);
});

test('kalshi parsing: dollar strings win over cents, non-open and unlabeled markets skipped', () => {
  const rows = X.parseKalshiMarkets({ markets: [
    { ticker: 'A', event_ticker: 'KXNBAGAME-26OCT08NYKBOS', title: 't', yes_sub_title: 'Boston', status: 'open',
      yes_ask: 99, yes_ask_dollars: '0.5600', no_ask_dollars: '0.4600', yes_bid_dollars: '0.5400', no_bid_dollars: '0.4400',
      close_time: 'c', expected_expiration_time: 'e', volume: 10 },
    { ticker: 'B', event_ticker: 'KXNBAGAME-X', title: 't', yes_sub_title: 'New York K', status: 'open',
      yes_ask: 44, no_ask: 58, yes_bid: 42, no_bid: 56, close_time: 'c' },
    { ticker: 'C', event_ticker: 'E', yes_sub_title: 'Boston', status: 'settled', yes_ask: 50 },
    { ticker: 'D', event_ticker: 'E', yes_sub_title: '', status: 'open', yes_ask: 50 },
  ] });
  assert.equal(rows.length, 2);
  assert.deepEqual(
    { ...rows[0] },
    { exchange: 'kalshi', id: 'A', eventId: 'KXNBAGAME-26OCT08NYKBOS', title: 't', league: 'nba', team: 'Boston', yesAsk: 0.56, noAsk: 0.46,
      yesBid: 0.54, noBid: 0.44, start: 'e', volume: 10, url: 'https://kalshi.com/markets/kxnbagame-26oct08nykbos' },
  );
  assert.equal(rows[1].yesAsk, 0.44);
  assert.equal(rows[1].noAsk, 0.58);
  assert.equal(rows[1].noBid, 0.56);
  assert.equal(rows[1].start, 'c', 'falls back to close_time');
  assert.deepEqual(X.parseKalshiMarkets(null), []);
});

test('polymarket parsing: JSON-string outcomes, second ask = 1 − bestBid', () => {
  const rows = X.parsePolymarketEvents(polyEvent());
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(r => [r.id, r.team, r.yesAsk]), [['555:0', 'Knicks', 0.41], ['555:1', 'Celtics', 0.6]]);
  assert.equal(rows[0].eventId, '9001');
  assert.equal(rows[0].start, '2026-10-08 23:00:00+00');
  assert.equal(rows[0].url, 'https://polymarket.com/event/nba-nyk-bos-2026-10-08');
  assert.equal(rows[0].volume, 25000);

  const mids = X.parsePolymarketEvents(polyEvent({ bestAsk: undefined, bestBid: undefined, gameStartTime: undefined }));
  assert.deepEqual(mids.map(r => r.yesAsk), [0.405, 0.595], 'no book: outcomePrices as mids');
  assert.equal(mids[0].start, '2026-10-01T00:00:00Z');

  for (const m of [{ outcomes: '["Yes","No"]' }, { closed: true }, { active: false }, { sportsMarketType: 'spreads' },
    { outcomes: '["A","B","C"]', outcomePrices: '["0.3","0.3","0.4"]' }, { outcomes: 'not json' },
    { sportsMarketType: undefined, question: 'Spread: Celtics (-5.5)' }]) {
    assert.deepEqual(X.parsePolymarketEvents(polyEvent(m)), [], JSON.stringify(m));
  }
  assert.equal(X.parsePolymarketEvents(polyEvent({ sportsMarketType: undefined })).length, 2, 'no market type: still a moneyline');

  const now = Date.parse('2026-10-09T15:00:00Z');
  assert.deepEqual(X.parsePolymarketEvents(polyEvent({ updatedAt: '2026-09-16T00:00:00Z' }), null, now), [], 'a Gamma price weeks old is no price');
  assert.equal(X.parsePolymarketEvents(polyEvent({ updatedAt: '2026-10-09T14:50:00Z' }), null, now).length, 2, 'fresh: kept');
  assert.equal(X.parsePolymarketEvents(polyEvent({ updatedAt: 'garbage' }), null, now).length, 2, 'unreadable stamp: kept');
});

test('team matching: nicknames, cities, abbreviations', () => {
  const yes = [
    ['Boston', 'Boston Celtics'], ['Celtics', 'Boston Celtics'], ['BOS', 'Boston Celtics'], ['Boston Celtics', 'Boston Celtics'],
    ['LA Lakers', 'Los Angeles Lakers'], ['Los Angeles L', 'Los Angeles Lakers'], ['Los Angeles C', 'Los Angeles Clippers'],
    ['NY Knicks', 'New York Knicks'], ['New York K', 'New York Knicks'], ['NYK', 'New York Knicks'], ['LAL', 'Los Angeles Lakers'],
    ['LAC', 'Los Angeles Clippers'], ['GSW', 'Golden State Warriors'], ['Golden State', 'Golden State Warriors'],
    ['Red Sox', 'Boston Red Sox'], ['Blue Jays', 'Toronto Blue Jays'], ['Jays', 'Toronto Blue Jays'], ['Maple Leafs', 'Toronto Maple Leafs'],
    ['Trail Blazers', 'Portland Trail Blazers'], ['Blazers', 'Portland Trail Blazers'], ['Sixers', 'Philadelphia 76ers'],
    ['Golden Knights', 'Vegas Golden Knights'], ['St. Louis', 'St. Louis Cardinals'], ['KC', 'Kansas City Chiefs'],
    ['Chicago WS', 'Chicago White Sox'], ['NYJ', 'New York Jets'], ['SF', 'San Francisco 49ers'], ['Montréal', 'Montreal Canadiens'],
    ['OKC', 'Oklahoma City Thunder'],
  ];
  for (const [label, full] of yes) assert.equal(X.teamMatches(label, full), true, `${label} ~ ${full}`);
  const no = [
    ['Los Angeles', 'Los Angeles Lakers'], ['LA', 'Los Angeles Clippers'], ['New York', 'New York Knicks'], ['NY', 'New York Jets'],
    ['Los Angeles L', 'Los Angeles Clippers'], ['LA Lakers', 'Los Angeles Clippers'], ['NYK', 'Boston Celtics'],
    ['Sox', 'Boston Red Sox'], ['Boston', 'New York Knicks'], ['LA Kings', 'Sacramento Kings'], ['', 'Boston Celtics'],
  ];
  for (const [label, full] of no) assert.equal(X.teamMatches(label, full), false, `${label} !~ ${full}`);
});

test('attachExchanges builds h2h books that the screener scores against Pinnacle', () => {
  const rows = [...kalshiRows([kalshiMarket('Boston', '0.7000', '0.3200'), kalshiMarket('New York K', '0.3000', '0.7200')]),
    ...X.parsePolymarketEvents(polyEvent())];
  const input = [game({ bookmakers: [h2h('pinnacle', -150, 130)] })];
  const out = X.attachExchanges(input, rows, { now: NOW });

  assert.equal(input[0].bookmakers.length, 1, 'input not mutated');
  const k = book(out[0], 'kalshi'), p = book(out[0], 'polymarket');
  assert.equal(k.title, 'Kalshi');
  assert.equal(k.markets[0].key, 'h2h');
  assert.equal(priceOf(k, 'Boston Celtics'), X.effectiveAmerican(0.7, 0.02));
  assert.equal(priceOf(k, 'New York Knicks'), X.effectiveAmerican(0.3, 0.02));
  assert.equal(k.markets[0].outcomes[0].link, 'https://kalshi.com/markets/kxnbagame-26oct08nykbos');
  assert.equal(priceOf(p, 'Boston Celtics'), -150);
  assert.equal(priceOf(p, 'New York Knicks'), 144);
  assert.equal(p.markets[0].outcomes[1].link, 'https://polymarket.com/event/nba-nyk-bos-2026-10-08');

  const evRows = E.screen({ now: NOW, feeds: [{ sport: 'nba', games: out }] });
  const hit = evRows.find(r => r.book === 'kalshi' && r.side === 'New York Knicks');
  assert.ok(hit, 'Kalshi Knicks scored');
  assert.equal(hit.source, 'sharp');
  assert.deepEqual(hit.sharpBooks, ['pinnacle']);
  assert.ok(hit.ev > 20, `Knicks at $0.32 all-in vs ~42% fair is a big edge (got ${hit.ev})`);
  const fav = evRows.find(r => r.book === 'kalshi' && r.side === 'Boston Celtics');
  assert.equal(fav, undefined, 'the other side is -EV and filtered by minEv 0');
});

test('attachExchanges: kalshi falls back to the other side\'s NO, fees are configurable', () => {
  const rows = kalshiRows([kalshiMarket('Boston', '0.7000', '0.3200')]);
  const [g] = X.attachExchanges([game()], rows, { now: NOW });
  const k = book(g, 'kalshi');
  assert.ok(k, 'paired through the event title');
  assert.equal(priceOf(k, 'New York Knicks'), X.effectiveAmerican(0.32, 0.02));

  const [g0] = X.attachExchanges([game()], kalshiRows([kalshiMarket('Boston', '0.7000', '0.3200'), kalshiMarket('New York K', '0.3000', null)]), { now: NOW, kalshiFeeRate: 0 });
  assert.equal(priceOf(book(g0, 'kalshi'), 'New York Knicks'), X.effectiveAmerican(0.3));

  const [gp] = X.attachExchanges([game()], X.parsePolymarketEvents(polyEvent()), { now: NOW, polymarketFeeRate: 0.02 });
  assert.equal(priceOf(book(gp, 'polymarket'), 'Boston Celtics'), X.effectiveAmerican(0.6, 0.012));

  const [g2] = X.attachExchanges([game()], kalshiRows([kalshiMarket('Boston', '0.7000', null)]), { now: NOW });
  assert.equal(book(g2, 'kalshi'), undefined, 'one side unpriced: no book');
});

test('attachExchanges skips started games, far-off times and other matchups', () => {
  const rows = [...kalshiRows([kalshiMarket('Boston', '0.7000', '0.3200'), kalshiMarket('New York K', '0.3000', '0.7200')]),
    ...X.parsePolymarketEvents(polyEvent())];
  const started = X.attachExchanges([game({ commence_time: '2026-10-08T11:00:00Z' })], rows, { now: NOW });
  assert.equal(started[0].bookmakers.length, 0);

  const nextWeek = X.attachExchanges([game({ commence_time: '2026-10-15T23:00:00Z' })], rows, { now: NOW });
  assert.equal(nextWeek[0].bookmakers.length, 0, 'same teams, a week later: different game');

  const other = X.attachExchanges([game({ home_team: 'Los Angeles Lakers', away_team: 'Golden State Warriors' })], rows, { now: NOW });
  assert.equal(other[0].bookmakers.length, 0);

  // two LA teams labelled only by city cannot be told apart
  const la = kalshiRows([kalshiMarket('Los Angeles', '0.5000', '0.5200', { event_ticker: 'LA' }), kalshiMarket('Los Angeles', '0.5000', '0.5200', { event_ticker: 'LA', ticker: 'LA2' })]);
  const [laGame] = X.attachExchanges([game({ home_team: 'Los Angeles Lakers', away_team: 'Los Angeles Clippers' })], la, { now: NOW });
  assert.equal(laGame.bookmakers.length, 0);

  const [noTime] = X.attachExchanges([game({ commence_time: undefined })], rows.map(r => ({ ...r, start: null })), { now: NOW });
  assert.equal(noTime.bookmakers.length, 2, 'missing times skip the time check');
});

test('toMarketsList is compact', () => {
  const list = X.toMarketsList(X.parsePolymarketEvents(polyEvent()));
  assert.deepEqual(list[0], { exchange: 'polymarket', title: 'Knicks vs. Celtics', team: 'Knicks', yesAsk: 0.41, start: '2026-10-08 23:00:00+00', url: 'https://polymarket.com/event/nba-nyk-bos-2026-10-08' });
});

test('fetch wrappers: one failing request does not sink the rest', async () => {
  const calls = [];
  const http = {
    async get(url, opts) {
      calls.push({ url, ...opts });
      const p = opts.params;
      if (p.series_ticker === 'KXNFLGAME' || p.tag_slug === 'nfl') throw new Error('503');
      if (url.includes('kalshi')) return { data: { markets: p.series_ticker === 'KXNBAGAME' ? [kalshiMarket('Boston', '0.7000', '0.3200')] : [] } };
      return { data: p.tag_slug === 'nba' ? polyEvent() : [] };
    },
  };
  const k = await X.fetchKalshi(http, { seriesTickers: ['KXNBAGAME', 'KXNFLGAME'] });
  assert.equal(k.rows.length, 1);
  assert.deepEqual(k.errors, [{ exchange: 'kalshi', key: 'KXNFLGAME', message: '503' }]);
  assert.deepEqual(calls[0], { url: 'https://api.elections.kalshi.com/trade-api/v2/markets', params: { status: 'open', series_ticker: 'KXNBAGAME', limit: 200 }, timeout: 10000 });

  calls.length = 0;
  const p = await X.fetchPolymarket(http);
  assert.equal(calls.length, 4, 'default tags');
  assert.deepEqual(calls[0].params, { tag_slug: 'nba', closed: false, limit: 100 });
  assert.equal(calls[0].url, 'https://gamma-api.polymarket.com/events');
  assert.equal(p.rows.length, 2);
  assert.deepEqual(p.errors, [{ exchange: 'polymarket', key: 'nfl', message: '503' }]);

  calls.length = 0;
  await X.fetchKalshi(http);
  assert.deepEqual(calls.map(c => c.params.series_ticker), ['KXNBAGAME', 'KXNFLGAME', 'KXMLBGAME', 'KXNHLGAME', 'KXNCAAFGAME']);
});

test('rows carry their league: kalshi from the ticker, polymarket from the tag', () => {
  assert.equal(X.kalshiLeague('KXNHLGAME-26OCT08TORBOS'), 'nhl');
  assert.equal(X.kalshiLeague('KXNCAAFGAME-X'), 'ncaaf');
  assert.equal(X.kalshiLeague('KXWNBAGAME-X'), 'wnba');
  assert.equal(X.kalshiLeague('WEIRD', 'KXMLBGAME'), 'mlb', 'falls back to the fetched series');
  assert.equal(X.kalshiLeague('WEIRD'), null);
  assert.equal(X.parseKalshiMarkets({ markets: [kalshiMarket('Boston', '0.5', '0.5', { ticker: 'Z', event_ticker: 'Z' })] }, 'KXNFLGAME')[0].league, 'nfl');
  assert.equal(X.parsePolymarketEvents(polyEvent(), 'NHL')[0].league, 'nhl');
  assert.equal(X.parsePolymarketEvents(polyEvent())[0].league, null);
});

test('an NHL Kalshi market in the same cities never attaches to the NBA game', () => {
  const nhl = (team, yes, no) => kalshiMarket(team, yes, no, {
    ticker: `KXNHLGAME-26OCT08TORBOS-${team.slice(0, 3).toUpperCase()}`, event_ticker: 'KXNHLGAME-26OCT08TORBOS',
    title: 'Toronto at Boston Winner?',
  });
  const rows = kalshiRows([nhl('Boston', '0.3000', '0.7200'), nhl('Toronto', '0.7000', '0.3200')]);
  assert.equal(rows[0].league, 'nhl');
  const nbaGame = game({ home_team: 'Boston Celtics', away_team: 'Toronto Raptors' });
  const [g] = X.attachExchanges([nbaGame], rows, { now: NOW, league: 'nba' });
  assert.equal(book(g, 'kalshi'), undefined);
  // the same rows do attach to the NHL game
  const [h] = X.attachExchanges([game({ home_team: 'Boston Bruins', away_team: 'Toronto Maple Leafs' })], rows, { now: NOW, league: 'nhl' });
  assert.ok(book(h, 'kalshi'));
  // polymarket rows fetched under another tag are skipped too
  const pm = X.parsePolymarketEvents(polyEvent(), 'nhl');
  assert.equal(book(X.attachExchanges([game()], pm, { now: NOW, league: 'nba' })[0], 'polymarket'), undefined);
  assert.ok(book(X.attachExchanges([game()], X.parsePolymarketEvents(polyEvent(), 'nba'), { now: NOW, league: 'nba' })[0], 'polymarket'));
});

test('several matching events: the closest start time wins', () => {
  const far = kalshiRows([
    kalshiMarket('Boston', '0.6000', '0.4200', { event_ticker: 'KXNBAGAME-FAR', expected_expiration_time: '2026-10-08T14:00:00Z' }),
    kalshiMarket('New York K', '0.4000', '0.6200', { event_ticker: 'KXNBAGAME-FAR', ticker: 'F2', expected_expiration_time: '2026-10-08T14:00:00Z' }),
  ]);
  const near = kalshiRows([
    kalshiMarket('Boston', '0.7000', '0.3200', { expected_expiration_time: '2026-10-08T23:30:00Z' }),
    kalshiMarket('New York K', '0.3000', '0.7200', { expected_expiration_time: '2026-10-08T23:30:00Z' }),
  ]);
  const [g] = X.attachExchanges([game()], [...far, ...near], { now: NOW });
  const ks = g.bookmakers.filter(b => b.key === 'kalshi');
  assert.equal(ks.length, 1);
  assert.equal(priceOf(ks[0], 'Boston Celtics'), X.effectiveAmerican(0.7, 0.02));
});
