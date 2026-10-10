const test = require('node:test');
const assert = require('node:assert/strict');
const B = require('../esboard');
const { buildElo } = require('../context');

const NOW = Date.parse('2026-10-11T08:00:00Z');
const START = '2026-10-11T12:00:00Z';

// ── payloads shaped like the live APIs (2026-10-10) ──
const pmMarket = (o = {}) => ({
  question: 'Valorant: G2 Esports vs T1 (BO3) - VCT Champions Playoffs', sportsMarketType: 'moneyline', groupItemTitle: 'Match Winner',
  outcomes: '["G2 Esports", "T1"]', outcomePrices: '["0.555", "0.445"]', bestBid: 0.55, bestAsk: 0.56, liquidity: '59118.31',
  gameStartTime: '2026-10-11 12:00:00+00', active: true, closed: false, acceptingOrders: true, conditionId: '0xmatch',
  clobTokenIds: '["111", "222"]', feeType: 'sports_fees_v3', ...o,
});
const pmEvent = (markets, o = {}) => ({
  slug: 'val-g21-t1-2026-10-11', title: 'Valorant: G2 Esports vs T1 (BO3) - VCT Champions Playoffs', startTime: START,
  endDate: '2026-10-11T18:00:00Z', volume: 4073.7, markets, ...o,
});
const kMarket = (o = {}) => ({
  ticker: 'KXVALORANTGAME-26OCT110800G2T1-G2', yes_sub_title: 'G2 Esports', yes_bid_dollars: '0.5500', yes_ask_dollars: '0.5700',
  status: 'active', volume_fp: '1000.00', ...o,
});
const kGame = (g2 = {}, t1 = {}) => ({
  event_ticker: 'KXVALORANTGAME-26OCT110800G2T1', title: 'G2 Esports vs. T1', mutually_exclusive: true,
  markets: [kMarket(g2), kMarket({ ticker: 'KXVALORANTGAME-26OCT110800G2T1-T1', yes_sub_title: 'T1', yes_bid_dollars: '0.4300', yes_ask_dollars: '0.4500', ...t1 })],
});

test('names: accents, word joiners and filler words', () => {
  assert.equal(B.cleanName('⁠Movistar KOI Fénix'), 'Movistar KOI Fenix');
  assert.ok(B.sameTeam('Team Spirit', 'Spirit'));
  assert.ok(B.sameTeam('G2 Esports', 'G2'));
  assert.ok(!B.sameTeam('T1', 'T1 Academy'), 'an academy roster is another team');
  assert.ok(!B.sameTeam('MOUZ', 'MOUZ NXT'));
  assert.equal(B.orient(['G2 Esports', 'T1'], ['T1', 'G2']), 'flipped');
  assert.equal(B.orient(['G2 Esports', 'T1'], ['G2', 'Fnatic']), null);
});

test('Polymarket event → match, map, total and handicap markets in team order', () => {
  const ev = pmEvent([
    pmMarket(),
    pmMarket({ question: 'Valorant: G2 Esports vs T1 - Map 1 Winner', sportsMarketType: 'child_moneyline', groupItemTitle: 'Map 1 Winner', outcomes: '["T1", "G2 Esports"]', bestBid: 0.44, bestAsk: 0.45, conditionId: '0xmap1' }),
    pmMarket({ question: 'Games Total: O/U 2.5', sportsMarketType: 'totals', groupItemTitle: 'O/U 2.5 Games', outcomes: '["Over", "Under"]', bestBid: 0.42, bestAsk: 0.5 }),
    pmMarket({ question: 'Map Handicap: T1 (-1.5) vs G2 Esports (+1.5)', sportsMarketType: 'map_handicap', groupItemTitle: 'Map Handicap: T1 (-1.5) vs G2 Esports (+1.5)', outcomes: '["T1", "G2 Esports"]', bestBid: 0.2, bestAsk: 0.24 }),
    pmMarket({ question: 'Map 1 Total Rounds: Over/Under 21.5', sportsMarketType: 'round_over_under_game_1', outcomes: '["Over", "Under"]' }),
    pmMarket({ sportsMarketType: 'child_moneyline', groupItemTitle: 'Map 2 Winner', closed: true }),
  ]);
  const m = B.parsePolymarketEvent(ev, 'VAL');
  assert.deepEqual(m.teams, ['G2 Esports', 'T1']);
  assert.equal(m.bestOf, 3);
  assert.equal(m.tournament, 'VCT Champions Playoffs');
  assert.equal(m.start, Date.parse(START));
  assert.deepEqual(m.markets.map(x => x.key), ['match', 'map:1', 'total:2.5', 'spread:1:1.5']);
  const match = m.markets[0];
  // second outcome's ask is 1 − bestBid; sports markets carry a taker fee
  assert.equal(match.quotes[0].ask, 0.56);
  assert.equal(match.quotes[1].ask, 0.45);
  assert.equal(match.quotes[1].bid, 0.44);
  assert.ok(match.quotes[0].fee > 0);
  // map 1 listed T1 first: flipped into G2, T1 order
  const map1 = m.markets[1];
  assert.deepEqual(map1.outcomes, ['G2 Esports', 'T1']);
  assert.equal(map1.quotes[0].ask, 0.56);    // G2 = 1 − T1's bid 0.44
  assert.equal(map1.quotes[1].ask, 0.45);
  const spread = m.markets[3];
  assert.equal(spread.team, 1);
  assert.equal(spread.line, -1.5);
  assert.deepEqual(spread.outcomes, ['T1 -1.5', 'G2 Esports +1.5']);
});

test('Kalshi events: game, map, total maps and spread', () => {
  const g = B.parseKalshiEvent(kGame(), 'match');
  assert.deepEqual(g.teams, ['G2 Esports', 'T1']);
  assert.equal(g.tail, '26OCT110800G2T1');
  assert.equal(g.start, Date.parse(START));   // 8:00 AM EDT
  assert.equal(g.markets[0].quotes[0].ask, 0.57);
  assert.ok(Math.abs(g.markets[0].quotes[0].fee - 0.0172) < 1e-9, 'Kalshi fee: 7% × p(1−p), rounded up per 100 contracts');
  const map = B.parseKalshiEvent({ ...kGame(), event_ticker: 'KXVALORANTMAP-26OCT110800G2T1-2', title: 'G2 Esports vs. T1: Map 2' }, 'map');
  assert.equal(map.markets[0].key, 'map:2');
  const total = B.parseKalshiEvent({
    event_ticker: 'KXVALORANTTOTALMAPS-26OCT110800G2T1', title: 'G2 Esports vs. T1: Total Maps',
    markets: [kMarket({ ticker: 'X-3', yes_sub_title: 'Over 2.5 maps', yes_bid_dollars: '0.4400', yes_ask_dollars: '0.4600' })],
  }, 'total');
  assert.equal(total.markets[0].key, 'total:2.5');
  assert.equal(total.markets[0].quotes[1].ask, 0.56, 'Under = buy NO at 1 − YES bid');
  const spread = B.parseKalshiEvent({
    event_ticker: 'KXVALORANTSPREAD-26OCT110800G2T1', title: 'G2 Esports vs. T1: Spread',
    markets: [kMarket({ ticker: 'X-T12', yes_sub_title: 'T1 wins by over 1.5 maps', yes_bid_dollars: '0.1800', yes_ask_dollars: '0.2000' })],
  }, 'spread');
  assert.equal(spread.markets[0].key, 'spread:1:1.5');
  assert.equal(B.parseKalshiEvent({ ...kGame(), markets: [kMarket()] }, 'match'), null, 'a game needs both teams');
});

test('bo3.gg book odds: match and total maps, suspended prices skipped', () => {
  const b = B.parseBo3Match({
    status: 'upcoming', bo_type: 3, start_date: '2026-10-11T12:00:00.000+00:00',
    bet_updates: { team_1: { name: 'G2', coeff: 1.65, active: true }, team_2: { name: 'T1', coeff: 2.3, active: true },
      additional_markets: [{ bet_type: 'total_maps_over_2_5', coeff: 2.1, active: true }, { bet_type: 'total_maps_under_2_5', coeff: 1.7, active: true }, { bet_type: 'score_2_0', coeff: 3 }] },
  });
  assert.deepEqual(b.markets.map(x => x.key), ['match', 'total:2.5']);
  assert.equal(B.parseBo3Match({ status: 'upcoming', bet_updates: { team_1: { name: 'A', coeff: 1.5, active: false }, team_2: { name: 'B', coeff: 2.5 } } }), null);
  assert.equal(B.parseBo3Match({ status: 'finished', bet_updates: { team_1: { name: 'A', coeff: 1.5 }, team_2: { name: 'B', coeff: 2.5 } } }), null);
});

function board({ pmBid = 0.55, pmAsk = 0.56, kG2 = {}, kT1 = {}, book = null, elo = {}, moves = null, now = NOW } = {}) {
  const pm = [B.parsePolymarketEvent(pmEvent([pmMarket({ bestBid: pmBid, bestAsk: pmAsk })]), 'VAL')];
  const kalshi = [{ ...B.parseKalshiEvent(kGame(kG2, kT1), 'match'), game: 'VAL' }];
  const bk = book ? [{ ...B.parseBo3Match(book), game: 'VAL' }] : [];
  return B.buildBoard(B.mergeSources({ pm, kalshi, book: bk }), { elo, moves, now });
}

test('sources pair into one match with a no-vig fair price', () => {
  const [m] = board();
  assert.equal(m.links.kalshi, 'https://kalshi.com/markets/kxvaloranttgame-26oct110800g2t1'.replace('kxvaloranttgame', 'kxvalorantgame'));
  assert.equal(m.links.polymarket, 'https://polymarket.com/event/val-g21-t1-2026-10-11');
  const mk = m.markets[0];
  assert.deepEqual(mk.sources.sort(), ['kalshi', 'polymarket']);
  // Kalshi 0.56 / 0.44 → 0.56; Polymarket 0.555 → fair = mean
  const k = 0.56 / (0.56 + 0.44);
  assert.ok(Math.abs(mk.outcomes[0].fair - (k + 0.555) / 2) < 1e-3);
  assert.ok(!m.live);
});

test('an edge needs another source below the price, a real bid, and the start ahead', () => {
  // Kalshi offers T1 at 30¢ while Polymarket has T1 at 44-45¢
  let [m] = board({ kT1: { yes_bid_dollars: '0.2800', yes_ask_dollars: '0.3000' }, kG2: { yes_bid_dollars: '0.6900', yes_ask_dollars: '0.7100' } });
  const t1 = m.markets[0].outcomes[1].quotes.kalshi;
  assert.ok(t1.edge, 'flagged');
  assert.ok(Math.abs(t1.ref - 0.445) < 1e-3, 'fair from Polymarket only, not Kalshi itself');
  assert.ok(m.edges.some(e => e.venue === 'kalshi' && e.outcome === 'T1'));
  // and G2 at 56¢ on Polymarket against Kalshi's 70¢: the same gap from the other side
  assert.ok(m.edges.some(e => e.venue === 'polymarket' && e.outcome === 'G2 Esports'));
  // no bid behind it: not an edge
  [m] = board({ kT1: { yes_bid_dollars: null, yes_ask_dollars: '0.3000' } });
  assert.ok(!m.markets[0].outcomes[1].quotes.kalshi.edge);
  // started: never flagged
  [m] = board({ kT1: { yes_bid_dollars: '0.2800', yes_ask_dollars: '0.3000' }, kG2: { yes_bid_dollars: '0.6900', yes_ask_dollars: '0.7100' }, now: Date.parse(START) + 60e3 });
  assert.equal(m.edges.length, 0);
  assert.ok(m.live);
});

test('longshots and two references that disagree are not flagged', () => {
  // T1 at 6¢ on Kalshi vs 9¢ fair: +50%, but a 6¢ price is noise
  let [m] = board({ pmBid: 0.9, pmAsk: 0.92, kT1: { yes_bid_dollars: '0.0500', yes_ask_dollars: '0.0600' }, kG2: { yes_bid_dollars: '0.9300', yes_ask_dollars: '0.9500' } });
  assert.equal(m.edges.length, 0);
  // Polymarket and the book disagree by 20¢: no consensus to call an edge against
  [m] = board({
    kT1: { yes_bid_dollars: '0.2800', yes_ask_dollars: '0.3000' }, kG2: { yes_bid_dollars: '0.6900', yes_ask_dollars: '0.7100' },
    book: { status: 'upcoming', bet_updates: { team_1: { name: 'G2', coeff: 1.25, active: true }, team_2: { name: 'T1', coeff: 4.5, active: true } } },
  });
  assert.equal(m.markets[0].outcomes[1].quotes.kalshi.edge, undefined);
});

test('a crossed market across venues is an arb, after fees', () => {
  // G2 on Polymarket at 50¢, T1 on Kalshi at 39¢ (+fees) → under $1
  const [m] = board({ pmBid: 0.49, pmAsk: 0.5 });
  assert.equal(m.arbs.length, 1);
  assert.deepEqual(m.arbs[0].legs.map(l => l.venue), ['polymarket', 'kalshi']);
  assert.ok(m.arbs[0].profitPct > 0);
  const [n] = board();
  assert.equal(n.arbs.length, 0);
});

test('decided and empty markets are dropped', () => {
  const pm = [B.parsePolymarketEvent(pmEvent([
    pmMarket(),
    pmMarket({ sportsMarketType: 'child_moneyline', groupItemTitle: 'Map 1 Winner', bestBid: 0.999, bestAsk: null }),
    pmMarket({ sportsMarketType: 'totals', groupItemTitle: 'O/U 2.5 Games', outcomes: '["Over", "Under"]', bestBid: null, bestAsk: null }),
  ]), 'VAL')];
  const [m] = B.buildBoard(B.mergeSources({ pm }), { now: NOW });
  assert.deepEqual(m.markets.map(x => x.key), ['match']);
});

test('series model from a map probability', () => {
  // Bo3 at p = 0.6: series 0.648, a map 3 2·0.6·0.4 = 0.48, a 2-0 0.36
  const tot = B.modelFor({ kind: 'total', line: 2.5 }, 0.6, 3);
  assert.ok(Math.abs(tot[0] - 0.48) < 1e-9);
  const sp = B.modelFor({ kind: 'spread', team: 0, line: -1.5 }, 0.6, 3);
  assert.ok(Math.abs(sp[0] - 0.36) < 1e-9);
  assert.ok(Math.abs(B.modelFor({ kind: 'match' }, 0.6, 3)[0] - 0.648) < 1e-9);
  // Bo5 over 4.5 maps = 2-2 after four = 6 p²(1−p)²
  assert.ok(Math.abs(B.modelFor({ kind: 'total', line: 4.5 }, 0.5, 5)[0] - 6 * 0.0625) < 1e-9);
  assert.equal(B.modelFor({ kind: 'total', line: 2.5 }, null, 3), null);
});

test('ratings add a model price when both teams have enough games', () => {
  const games = [];
  for (let i = 0; i < 12; i++) games.push({ a: 'G2 Esports', b: 'Fnatic', aWon: true, t: i }, { a: 'T1', b: 'Fnatic', aWon: i % 2 === 0, t: i });
  const elo = { VAL: buildElo(games) };
  const [m] = board({ elo });
  assert.ok(m.rating && m.rating.mapProb > 0.5);
  assert.ok(m.markets[0].outcomes[0].model > 0.5);
  const [n] = board({ elo: { VAL: buildElo(games.slice(0, 4)) } });
  assert.equal(n.rating, null, 'too few games');
});

test('line moves: open, last hour and since open', () => {
  const moves = B.createMoveTracker();
  board({ moves, now: NOW });
  const [m] = board({ moves, pmBid: 0.6, pmAsk: 0.61, now: NOW + 2 * 3600e3 });
  assert.ok(m.move);
  assert.ok(m.move.sinceOpen > 0.02);
  assert.equal(m.move.h1, m.move.sinceOpen);
});

test('scan: pulls every source through the given http and merges', async () => {
  const calls = [];
  const http = {
    async get(url, cfg = {}) {
      calls.push(url);
      if (url.endsWith('/sports')) return { data: [{ sport: 'val', series: '10369', tags: '1,64,100639' }] };
      if (url.endsWith('/events') && url.includes('gamma')) return { data: cfg.params.series_id === 10369 ? [pmEvent([pmMarket()])] : [] };
      if (url.includes('kalshi')) return { data: { events: cfg.params.series_ticker === 'KXVALORANTGAME' ? [kGame()] : [] } };
      if (url.includes('bo3')) return { data: { results: [] } };
      throw new Error('unexpected ' + url);
    },
  };
  const b = B.createEsportsBoard({ http, now: () => NOW, log: {} });
  const st = await b.scan();
  assert.equal(st.counts.matches, 1);
  assert.equal(st.counts.both, 1);
  // a series with nothing open is skipped on the next scan
  const before = calls.filter(u => u.includes('kalshi')).length;
  await b.scan();
  const after = calls.filter(u => u.includes('kalshi')).length - before;
  assert.equal(after, 1, 'only the series that listed something');
});
