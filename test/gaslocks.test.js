const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../gaslocks');
const R = require('../results');

const NOW = Date.parse('2026-10-14T21:00:00Z');
const mkt = (o = {}) => ({
  ticker: 'KXAAAGASDCA-26OCT15-4.6500', event_ticker: 'KXAAAGASDCA-26OCT15', floor_strike: 4.65, title: 'Will average gas prices be above $4.6500?',
  close_time: '2026-10-15T03:59:00Z', expected_expiration_time: '2026-10-15T14:00:00Z',
  yes_ask_dollars: '0.9600', yes_bid_dollars: '0.9400', no_ask_dollars: '0.0600', no_bid_dollars: '0.0400', ...o,
});

test('candidate: the favourite asked 90-98c, 12 to 19 hours before expiry', () => {
  const c = G.candidate(mkt(), { now: NOW });
  assert.equal(c.side, 'yes');
  assert.equal(c.state, 'CA');
  assert.equal(c.day, '26OCT15');
  assert.equal(c.price, 0.96);
  assert.equal(c.hoursLeft, 17);
  // fee on a 100-contract order: ceil(0.07 * 100 * .96 * .04 * 100) / 100 = $0.27 → 0.27¢ a contract
  assert.equal(c.cost, 0.9627);
  assert.match(c.pick, /CA gas above \$4\.650/);
  // the NO side when it's the favourite
  const n = G.candidate(mkt({ yes_ask_dollars: '0.0500', yes_bid_dollars: '0.0300', no_ask_dollars: '0.9700', no_bid_dollars: '0.9500' }), { now: NOW });
  assert.equal(n.side, 'no');
  assert.equal(n.price, 0.97);
  // 99c and 89c are out, and so is a market outside the window or about to close
  assert.equal(G.candidate(mkt({ yes_ask_dollars: '0.9900' }), { now: NOW }), null);
  assert.equal(G.candidate(mkt({ yes_ask_dollars: '0.8900' }), { now: NOW }), null);
  assert.equal(G.candidate(mkt(), { now: Date.parse('2026-10-14T12:00:00Z') }), null, '26 hours out');
  assert.equal(G.candidate(mkt({ close_time: '2026-10-14T21:05:00Z' }), { now: NOW }), null, 'closing in 5 minutes');
});

test('midOf: our side of the listing mid', () => {
  assert.equal(G.midOf(mkt(), 'yes'), 0.95);
  assert.equal(G.midOf(mkt(), 'no'), 0.05);
  assert.equal(G.midOf(mkt({ yes_bid_dollars: '0' }), 'yes'), null);
});

function fakeHttp({ markets = {}, books = {}, settled = {} } = {}) {
  const calls = [];
  return {
    calls,
    async get(url, { params } = {}) {
      calls.push(url);
      if (/\/orderbook$/.test(url)) return { data: books[decodeURIComponent(url.split('/').slice(-2)[0])] || {} };
      if (/\/markets$/.test(url)) return { data: { markets: markets[params.series_ticker] || [] } };
      const t = decodeURIComponent(url.split('/').pop());
      return { data: { market: settled[t] || {} } };
    },
  };
}

test('scan: needs $100 resting at the ask; logged plays skip the book read', async () => {
  const a = mkt(), b = mkt({ ticker: 'KXAAAGASDCA-26OCT15-4.6400', floor_strike: 4.64, yes_ask_dollars: '0.9700', yes_bid_dollars: '0.9600' });
  const http = fakeHttp({
    markets: { KXAAAGASDCA: [a, b] },
    books: {
      // YES asks are NO bids at 1 - q: $192 resting at 96c on a, $9.70 at 97c on b
      [a.ticker]: { orderbook_fp: { no_dollars: [['0.04', '200']] } },
      [b.ticker]: { orderbook_fp: { no_dollars: [['0.03', '10']] } },
    },
  });
  const out = await G.scan(http, { now: NOW, states: ['CA'] });
  assert.deepEqual(out.plays.map(p => p.ticker), [a.ticker]);
  assert.equal(out.plays[0].depth.usd, 192);
  assert.equal(out.counts.candidates, 2);
  const again = await G.scan(http, { now: NOW, states: ['CA'], skip: new Set([`${a.ticker}:yes`]) });
  assert.equal(again.plays.find(p => p.ticker === a.ticker).logged, true);
  assert.equal(again.counts.books, 1, 'only the unlogged one is read');
});

test('tracker: logs once, marks the close, grades from the result', async () => {
  let t = NOW;
  const a = mkt();
  const http = fakeHttp({ settled: { [a.ticker]: { result: 'yes' } } });
  const tr = G.createGasTracker({ http, now: () => t, log: { warn() {} } });
  const play = { ...G.candidate(a, { now: NOW }), depth: { usd: 192, contracts: 200 } };
  assert.equal((await tr.record([play])).length, 1);
  assert.equal((await tr.record([play])).length, 0, 'once only');
  // the last mark before trading stops is the close; one after it is ignored
  t = Date.parse('2026-10-15T03:00:00Z');
  await tr.mark([mkt({ yes_ask_dollars: '0.9900', yes_bid_dollars: '0.9700' })]);
  t = Date.parse('2026-10-15T04:30:00Z');
  await tr.mark([mkt({ yes_ask_dollars: '0.5000', yes_bid_dollars: '0.4000' })]);
  assert.equal(await tr.grade(), 0, 'not before expiry + 1h');
  t = Date.parse('2026-10-15T15:01:00Z');
  assert.equal(await tr.grade(), 1);
  const [r] = await tr.list();
  assert.equal(r.outcome, 'win');
  assert.equal(r.profit, Math.round((1 / 0.9627 - 1) * 1e4) / 1e4);
  assert.equal(r.clv, Math.round((0.98 / 0.96 - 1) * 1e4) / 1e4);
  const s = await tr.summary();
  assert.deepEqual([s.graded, s.wins, s.losses, s.open], [1, 1, 0, 0]);
  // and Results scores it as its own source
  const board = R.scoreboard({ gasLocks: await tr.list() });
  assert.equal(board.sources.gasLocks.overall.graded, 1);
  assert.equal(board.sources.gasLocks.overall.wins, 1);
});

test('tracker: a loss costs the whole stake', async () => {
  let t = NOW;
  const a = mkt();
  const tr = G.createGasTracker({ http: fakeHttp({ settled: { [a.ticker]: { result: 'no' } } }), now: () => t, log: { warn() {} } });
  await tr.record([{ ...G.candidate(a, { now: NOW }), depth: { usd: 192 } }]);
  t = Date.parse('2026-10-15T16:00:00Z');
  await tr.grade();
  const [r] = await tr.list();
  assert.equal(r.outcome, 'loss');
  assert.equal(r.profit, -1);
});

test('describe: one alert line', () => {
  const line = G.describe({ pick: 'CA gas above $4.650', day: '26OCT15', price: 0.96, depthUsd: 1920 });
  assert.equal(line, 'CA gas above $4.650 (26OCT15) · 96¢ · $1,920 at the ask');
});
