const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../pmus');

const usd = v => ({ value: v, currency: 'USD' });
// shapes copied from the live gateway (2026-10-10), trimmed
const moneyline = (o = {}) => ({
  slug: 'aec-nfl-cle-nyj-2026-10-11', question: 'Who will win in the upcoming football event Cleveland Browns vs New York Jets?',
  sportsMarketType: 'football_team_full_game_winner', marketType: 'moneyline', active: true, closed: false, status: 'MARKET_STATUS_OPEN',
  bestBidQuote: usd('0.4400'), bestAskQuote: usd('0.4425'),
  marketSides: [
    { description: 'Browns', price: '0.4425', long: true, quote: usd('0.4425'), team: { name: 'Cleveland Browns', abbreviation: 'cle', ordering: 'away' } },
    { description: 'Jets', price: '0.56', long: false, quote: usd('0.56'), team: { name: 'New York Jets', abbreviation: 'nyj', ordering: 'home' } },
  ], ...o,
});
const spread = (line, o = {}) => ({
  slug: `asc-nfl-cle-nyj-2026-10-11-${line < 0 ? 'neg' : 'pos'}-${String(Math.abs(line)).replace('.', 'pt')}`,
  question: `Will the Cleveland Browns cover ${line} vs the New York Jets?`, line, sportsMarketType: 'football_team_full_game_spread', marketType: 'spreads',
  active: true, closed: false, status: 'MARKET_STATUS_OPEN', bestBidQuote: usd('0.4150'), bestAskQuote: usd('0.4200'),
  marketSides: [
    { description: String(line), price: '0.4200', long: true, quote: usd('0.4200'), team: { name: 'Cleveland Browns', ordering: 'away' } },
    { description: String(-line), price: '0.585', long: false, quote: usd('0.585'), team: { name: 'New York Jets', ordering: 'home' } },
  ], ...o,
});
const total = (line, o = {}) => ({
  slug: `tsc-nfl-cle-nyj-2026-10-11-total-${String(line).replace('.', 'pt')}`, question: `Will the total be more than ${line}?`, line,
  sportsMarketType: 'football_team_full_game_total', marketType: 'totals', active: true, closed: false, status: 'MARKET_STATUS_OPEN',
  bestBidQuote: usd('0.4800'), bestAskQuote: usd('0.5000'),
  marketSides: [{ description: 'Over', price: '0.5000', long: true, quote: usd('0.5000') }, { description: 'Under', price: '0.52', long: false, quote: usd('0.52') }], ...o,
});
const firstHalf = { slug: 'atc-nfl-cle-nyj-2026-10-11-winner-1h-cle', question: 'Will Cleveland win the first half?', sportsMarketType: 'football_team_first_half_winner',
  marketSides: [{ long: true, team: { name: 'Cleveland Browns' } }, { long: false, team: { name: 'Cleveland Browns' } }] };
// one team's points: not the game's total, whatever the line
const teamTotal = total(43.5, { slug: 'ttc-nfl-cle-nyj-2026-10-11-cle-43pt5', question: 'Will the Cleveland Browns score more than 43.5 points?', sportsMarketType: 'football_team_points_full_game_total' });
const EVENT = { event: { id: 1, slug: 'nfl-cle-nyj-2026-10-11', title: 'CLE Browns vs. NY Jets', markets: [firstHalf, teamTotal, moneyline(), spread(-1.5), spread(3.5), total(41.5), total(43.5)] } };

// Polymarket International signals for the same game
const sig = o => ({ type: 'entry', eventSlug: 'nfl-cle-nyj-2026-10-11', ...o });
const ML = sig({ market: 'Browns vs. Jets', outcome: 'Jets', outcomes: ['Browns', 'Jets'], sportsMarketType: 'moneyline' });
const SPREAD = sig({ market: 'Spread: Browns (-1.5)', outcome: 'Browns', outcomes: ['Browns', 'Jets'], sportsMarketType: 'spreads', line: -1.5 });
const DOG = sig({ market: 'Spread: Browns (-3.5)', outcome: 'Jets', outcomes: ['Browns', 'Jets'] });   // the Jets +3.5
const TOTAL = sig({ market: 'Browns vs. Jets: O/U 43.5', outcome: 'Under', outcomes: ['Over', 'Under'], sportsMarketType: 'totals', line: 43.5 });

test('parse: full-game markets only, long side first, the book of the long side', () => {
  const ev = P.parseEvent(EVENT);
  assert.equal(ev.league, 'nfl');
  assert.deepEqual(ev.markets.map(m => [m.kind, m.line]), [['moneyline', null], ['spread', -1.5], ['spread', 3.5], ['total', 41.5], ['total', 43.5]], 'the first-half and team-points markets are left out');
  const m = ev.markets[0];
  assert.deepEqual([m.long.team, m.short.team, m.bid, m.ask, m.open, m.feeRate], ['Cleveland Browns', 'New York Jets', 0.44, 0.4425, true, P.FEE_RATE]);
  assert.equal(P.parseMarket(moneyline({ feeCoefficient: 0.05 })).feeRate, 0.05, "the market's own fee rate");
  assert.equal(P.fee(0.5, 0.05), 0.0125);
  assert.ok(m.long.aliases.includes('Browns') && m.long.aliases.includes('cle'));
  assert.equal(P.parseMarket(moneyline({ closed: true })).open, false);
  assert.equal(P.parseMarket(moneyline({ status: 'MARKET_STATUS_RESOLVED' })).open, false);
  assert.equal(P.parseMarket(moneyline({ marketSides: [] })), null, 'no teams: nothing to match');
  assert.deepEqual(P.parseBook({ marketData: { bids: [{ px: usd('0.4375'), qty: '5' }, { px: usd('0.4400'), qty: '1168279.94' }], offers: [{ px: usd('0.4425'), qty: '1209642.73' }], state: 'MARKET_STATE_OPEN' } }),
    { bid: 0.44, ask: 0.4425, bidSize: 1168279.94, askSize: 1209642.73, open: true });
  assert.equal(P.parseBook({ marketData: { bids: [], offers: [], state: 'MARKET_STATE_HALTED' } }).open, false);
  assert.equal(P.parseBook({ nope: 1 }), null);
});

test('betOf: what the Polymarket bet was', () => {
  assert.deepEqual(P.betOf(ML), { kind: 'moneyline', team: 'Jets', teams: ['Browns', 'Jets'] });
  assert.deepEqual(P.betOf(SPREAD), { kind: 'spread', team: 'Browns', line: -1.5, teams: ['Browns', 'Jets'] });
  assert.deepEqual(P.betOf(DOG), { kind: 'spread', team: 'Jets', line: 3.5, teams: ['Browns', 'Jets'] }, 'the other side of Browns -3.5 is Jets +3.5');
  assert.deepEqual(P.betOf(TOTAL), { kind: 'total', over: false, line: 43.5 });
  assert.equal(P.betOf(sig({ market: 'Will Arsenal win on 2026-10-11?', outcome: 'Yes', outcomes: ['Yes', 'No'] })), null, 'a soccer yes/no');
  assert.equal(P.betOf(sig({ market: 'Browns vs. Jets: 1H Moneyline', outcome: 'Browns', outcomes: ['Browns', 'Jets'], sportsMarketType: 'first_half_moneyline' })), null);
  assert.equal(P.betOf(sig({ market: 'Will the Fed cut?', outcome: 'Yes', outcomes: ['Yes', 'No'] })), null);
});

test('matchBet: the same team, the same line, from whichever team is long', () => {
  const ev = P.parseEvent(EVENT);
  const m = P.matchBet(ev, P.betOf(ML));
  assert.deepEqual([m.market.kind, m.side], ['moneyline', 'short'], 'the Jets are the short side');
  assert.equal(P.buyPrice(m.market, m.side), 0.56, '1 − the 44¢ bid');
  const sp = P.matchBet(ev, P.betOf(SPREAD));
  assert.deepEqual([sp.market.line, sp.side], [-1.5, 'long']);
  assert.equal(P.buyPrice(sp.market, sp.side), 0.42);
  const dog = P.matchBet(ev, P.betOf(DOG));
  assert.equal(dog, null, 'Jets +3.5 is the short side of Browns -3.5, which is not listed (Browns +3.5 is)');
  const jetsMinus = P.matchBet(ev, { kind: 'spread', team: 'Jets', line: -3.5, teams: ['Browns', 'Jets'] });
  assert.deepEqual([jetsMinus.market.line, jetsMinus.side], [3.5, 'short'], 'Jets -3.5 = the short side of Browns +3.5');
  assert.equal(P.pickOf(jetsMinus.market, jetsMinus.side), 'New York Jets -3.5');
  const tot = P.matchBet(ev, P.betOf(TOTAL));
  assert.deepEqual([tot.market.line, tot.side, P.pickOf(tot.market, tot.side), P.buyPrice(tot.market, tot.side)], [43.5, 'short', 'Under 43.5', 0.52]);
  assert.equal(P.matchBet(ev, { kind: 'total', over: true, line: 44.5 }), null, 'no line like it');
  // names that don't pair with both teams don't match
  assert.equal(P.matchBet(ev, { kind: 'moneyline', team: 'Bills', teams: ['Bills', 'Jets'] }), null);
  // a closed market is skipped
  const closed = P.parseEvent({ event: { slug: 'nfl-cle-nyj-2026-10-11', markets: [moneyline({ closed: true })] } });
  assert.equal(P.matchBet(closed, P.betOf(ML)), null);
});

test('college names: "Iowa State" is not "Iowa", "Utah State" is "Utah State Aggies"', () => {
  const m = (a, b) => moneyline({ marketSides: [
    { long: true, description: a.split(' ').pop(), team: { name: a, ordering: 'away' } }, { long: false, description: b.split(' ').pop(), team: { name: b, ordering: 'home' } }] });
  const ev = P.parseEvent({ event: { slug: 'cfb-washst-utahst-2026-10-09', markets: [m('Washington State Cougars', 'Utah State Aggies')] } });
  const hit = P.matchBet(ev, { kind: 'moneyline', team: 'Utah State', teams: ['Washington State', 'Utah State'] });
  assert.equal(hit?.side, 'short');
  const iowa = P.parseEvent({ event: { slug: 'cfb-iowa-isu', markets: [m('Iowa Hawkeyes', 'Iowa State Cyclones')] } });
  assert.equal(P.matchBet(iowa, { kind: 'moneyline', team: 'Iowa State', teams: ['Iowa', 'Iowa State'] })?.side, 'short');
  assert.equal(P.matchBet(iowa, { kind: 'moneyline', team: 'Iowa', teams: ['Iowa', 'Iowa State'] })?.side, 'long');
});

function fakeHttp(routes) {
  const calls = [];
  return {
    calls,
    async get(url, cfg = {}) {
      calls.push(url);
      for (const [k, v] of Object.entries(routes)) if (url.endsWith(k)) {
        const out = typeof v === 'function' ? v() : v;
        if (out instanceof Error) throw out;
        return { data: JSON.parse(JSON.stringify(out)) };
      }
      throw Object.assign(new Error('Request failed with status code 404'), { response: { status: 404 } });
    },
  };
}

test('quoteFor: the live book prices it; events are cached a minute, books 10 s; unlisted games are remembered', async () => {
  let t = Date.parse('2026-10-10T12:00:00Z');
  let book = { marketData: { bids: [{ px: usd('0.4500'), qty: '900' }], offers: [{ px: usd('0.4550'), qty: '700' }], state: 'MARKET_STATE_OPEN' } };
  const http = fakeHttp({ '/v1/events/slug/nfl-cle-nyj-2026-10-11': EVENT, '/v1/markets/aec-nfl-cle-nyj-2026-10-11/book': () => book });
  const us = P.createPolymarketUs({ http, now: () => t, log: {} });
  const q = await us.quoteFor(ML);
  assert.deepEqual({ key: q.key, name: q.name, price: q.price, side: q.side, buy: q.buy, depth: q.depth, url: q.url },
    { key: 'polymarketus', name: 'Polymarket US', price: 0.55, side: 'short', buy: 'New York Jets', depth: 900, url: 'https://polymarket.us/sports/nfl/nfl-cle-nyj-2026-10-11' });
  assert.equal(q.fee, Math.round(0.0695 * 0.55 * 0.45 * 1e6) / 1e6);
  assert.equal(q.cost, Math.round((0.55 + q.fee) * 1e6) / 1e6);
  assert.equal(http.calls.length, 2);

  t += 5e3;
  await us.quoteFor(ML);
  assert.equal(http.calls.length, 2, 'both cached');
  t += 6e3;
  book = { marketData: { bids: [], offers: [], state: 'MARKET_STATE_HALTED' } };
  assert.equal(await us.quoteFor(ML), null, 'a halted book: no quote');
  assert.equal(http.calls.length, 3, 'the book again, not the event');

  // no live book: the event's snapshot
  book = new Error('timeout');
  t += 11e3;
  assert.equal((await us.quoteFor(SPREAD)).price, 0.42);

  const none = sig({ eventSlug: 'nfl-buf-mia-2026-10-11', market: 'Bills vs. Dolphins', outcome: 'Bills', outcomes: ['Bills', 'Dolphins'], sportsMarketType: 'moneyline' });
  assert.equal(await us.quoteFor(none), null);
  const n = http.calls.length;
  assert.equal(await us.quoteFor(none), null);
  assert.equal(http.calls.length, n, 'a 404 is remembered');
  assert.equal(await us.quoteFor(sig({ market: 'Will the Fed cut?', outcome: 'Yes' })), null);
  assert.equal(http.calls.length, n, 'not a game bet: no request');
  const st = us.state();
  assert.ok(st.lookups >= 5 && st.matched >= 3 && st.quoted >= 2);
  assert.equal(P.enabledFromEnv({ POLYMARKET_US: 'off' }), false);
  assert.equal(P.enabledFromEnv({}), true);
  assert.equal(P.usSlugOf({ eventSlug: 'epl-ars-che-2026-10-11-more-markets' }), 'epl-ars-che-2026-10-11');
});
