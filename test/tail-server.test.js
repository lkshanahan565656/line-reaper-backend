// Boots server.js with axios stubbed (no network, Polymarket's data API in its
// v2 shapes): the Sharp Tail crons' work, every /api/tail, /api/whales and
// /api/xarbs endpoint, the free-user masking, US mode, the data-licence gates,
// where-to-tail routing, the live stream events and the webhook posts.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lr-tail-server-'));
const ADMIN_TOKEN = 'test-admin-token';
const WEBHOOK = 'https://discord.example/api/webhooks/1/test';
for (const k of ['DATABASE_URL', 'TAIL_WEBHOOK', 'ODDS_API_KEY', 'OWLS_API_KEY', 'WHALE_MIN_USD', 'XARB_MIN_PCT', 'XARB_ALERT_MIN', 'POLYMARKET_DISPLAY_OK', 'KALSHI_DISPLAY_OK']) delete process.env[k];
for (const k of Object.keys(process.env)) if (/^TAIL_/.test(k)) delete process.env[k];
Object.assign(process.env, {
  PAYWALL: 'on', AUTH_SECRET: 'test-secret', TRACKER_ADMIN_TOKEN: ADMIN_TOKEN, ALERT_WEBHOOK_URL: WEBHOOK, UPSTREAM_GAP_MS: '0',
  TRACKER_FILE: path.join(DIR, 'picks.json'), USERS_FILE: path.join(DIR, 'users.json'), EV_TRACK_FILE: path.join(DIR, 'ev.json'),
  TAIL_TRACK_FILE: path.join(DIR, 'tail-signals.json'), TAIL_TRADERS_FILE: path.join(DIR, 'tail-traders.json'), FRESH_TRACK_FILE: path.join(DIR, 'fresh-signals.json'),
  // the round-1 tests below run with both data licences granted; the gates have their own tests
  POLYMARKET_DISPLAY_OK: 'on', KALSHI_DISPLAY_OK: 'on',
});
// TAIL_REGION is unset: US mode, the default

// A clock the test can move forward: everything in the server reads Date.now.
const realNow = Date.now;
let skew = 0;
Date.now = () => realNow() + skew;
const tick = ms => { skew += ms; };
const DAY = 86400e3;
const iso = ms => new Date(ms).toISOString();
const sec = ms => Math.floor(ms / 1000);

// ── fake upstream ──
const W1 = '0x1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b';   // the A-grade politics wallet
const W9 = '0x9999999999999999999999999999999999999999';   // an unknown whale
const COND = '0xc0ffee0000000000000000000000000000000000000000000000000000000001';
const COND2 = '0xc0ffee0000000000000000000000000000000000000000000000000000000002';   // a second market W1 bets
const TEXAS = { asset: '7124001', cond: COND2, title: 'Will Jones win the Texas Senate election?', slug: 'texas-senate-jones', eventSlug: 'texas-senate-2026' };
const fx = { closed: [], trades: [], history: {}, markets: [], kalshiEvents: [], kalshiTrades: [], pmEvents: [] };
const calls = [], posts = [];

// v2 wraps every list: { data, pagination }
const page = data => ({ data, pagination: { limit: 500, offset: 0, has_more: false, next_cursor: null } });

// 120 settled politics bets at 50¢, 80 won, each its own race: ROI 33%, z 3.65.
// v2 /positions rows: some winners still unclaimed (REDEEMABLE), some losers
// never claimed (REDEEMABLE_LOST: the hidden losers that must count).
function eliteHistory(wallet, now) {
  return Array.from({ length: 120 }, (_, i) => {
    const won = i % 3 !== 0, end = now - (i % 100) * DAY - 3600e3, cond = `0xcond${i}`;
    return {
      proxy_wallet: wallet, token_id: `${cond}-yes`, condition_id: cond, current_size: 0, avg_price: '0.5', total_size: 2000,
      entry_cost_usdc: 1000, entry_fees_usdc: 0, total_cost_usdc: 1000, current_price: won ? 1 : 0, current_value: 0,
      realized_pnl: won ? 1000 : -1000, unrealized_pnl: 0, total_pnl: won ? 1000 : -1000, percent_pnl: won ? 100 : -100,
      status: won ? (i % 2 ? 'CLOSED' : 'REDEEMABLE') : (i % 2 ? 'CLOSED' : 'REDEEMABLE_LOST'), redeemable: !(i % 2), mergeable: false,
      negative_risk: false, archived: false, title: `Will candidate ${i} win the ${['Ohio', 'Texas', 'Iowa', 'Maine'][i % 4]} Senate election?`,
      slug: `senate-race-${i}-m${i}`, icon: '', event_id: `ev${i}`, event_slug: `senate-race-${i}`, outcome: 'Yes', outcome_index: 0,
      opposite_outcome: 'No', opposite_token_id: `${cond}-no`, end_date: iso(end), last_event_at: iso(end), first_entry_at: iso(end - 3 * DAY),
      name: 'ElectionEdge', profile_image: '', verified: false,
    };
  });
}
// Each settled market's price history: 56¢ for its last day, then the outcome
// gets out (97¢+ / 3¢-), so the closing line is 56¢ against a 50¢ entry: +12% CLV.
function priceHistory(tokenId) {
  const pos = fx.closed.find(r => r.token_id === tokenId);
  if (!pos) return { data: [] };
  const end = Date.parse(pos.end_date), won = pos.current_price === 1;
  return page([{ t: sec(end - 2 * DAY), p: 0.52 }, { t: sec(end - DAY), p: 0.56 }, { t: sec(end - 3600e3), p: won ? 0.99 : 0.01 }]);
}
function trade({ wallet = W1, side = 'BUY', size, price, tx, agoMs = 60e3, name = 'ElectionEdge', asset = '7123001', cond = COND,
  title = 'Will Smith win the Ohio Senate election?', slug = 'ohio-senate-smith', eventSlug = 'ohio-senate-2026', outcome = 'Yes', outcomeIndex = 0 }) {
  return {
    proxy_wallet: wallet, side, token_id: asset, condition_id: cond, size: String(size), price: String(price),
    timestamp: sec(Date.now() - agoMs), title, slug, icon: '', event_slug: eventSlug, outcome, outcome_index: outcomeIndex,
    name, pseudonym: 'Brisk-Owl', bio: '', profile_image: '', profile_image_optimized: '', transaction_hash: tx,
  };
}
function gammaMarket({ closed = false, prices = ['0.405', '0.595'], bestAsk = '0.41', bestBid = '0.40', id = '501234', cond = COND, asset = '7123001',
  question = 'Will Smith win the Ohio Senate election?', slug = 'ohio-senate-smith', eventSlug = 'ohio-senate-2026' } = {}) {
  return {
    id, question, conditionId: cond, slug,
    endDate: iso(Date.now() + 30 * DAY), outcomes: '["Yes","No"]', outcomePrices: JSON.stringify(prices), clobTokenIds: JSON.stringify([asset, `${asset}9`]),
    bestBid, bestAsk, lastTradePrice: '0.41', volume: '250000', liquidity: '40000', active: !closed, closed,
    umaResolutionStatus: closed ? 'resolved' : null, events: [{ id: `e${id}`, slug: eventSlug, title: question, category: 'Politics' }],
  };
}
const texasMarket = (o = {}) => gammaMarket({ id: '501777', cond: COND2, asset: TEXAS.asset, question: TEXAS.title, slug: TEXAS.slug, eventSlug: TEXAS.eventSlug, ...o });
// a one-winner Kalshi event whose YES asks add up to less than $1
function kalshiEvent(ticker, title, asks) {
  return {
    event_ticker: ticker, series_ticker: ticker.split('-')[0], title, sub_title: '', category: 'Politics', mutually_exclusive: true,
    markets: asks.map(([who, ask], i) => ({
      ticker: `${ticker}-${who.slice(0, 3).toUpperCase()}${i}`, event_ticker: ticker, title, yes_sub_title: who, status: 'active',
      yes_ask_dollars: ask, yes_bid_dollars: (Number(ask) - 0.02).toFixed(4), no_ask_dollars: (1 - Number(ask) + 0.02).toFixed(4), no_bid_dollars: (1 - Number(ask)).toFixed(4),
      close_time: iso(Date.now() + 60 * DAY), expected_expiration_time: iso(Date.now() + 61 * DAY), volume: 120000, liquidity_dollars: '8000.00',
      rules_primary: `If ${who} is the nominee, the market resolves to Yes.`,
    })),
  };
}

const ROUTES = {
  'https://data-api.polymarket.com/v2/leaderboard': p => page(p.category === 'overall' && p.time_period === 'all'
    ? [{ rank: 1, user_id: W1, user_name: 'ElectionEdge', volume: 1200000, pnl: 40000, profile_image: '', x_username: '', verified: false }] : []),
  'https://data-api.polymarket.com/v2/positions': p => page(p.user === W1 ? fx.closed.filter(r => r.status === p.status) : []),
  'https://data-api.polymarket.com/v2/trades': p => page(p.user ? fx.history[p.user] || [] : fx.trades),
  'https://data-api.polymarket.com/v2/prices-history': p => priceHistory(p.token_id),
  // like Gamma: a closed market only when asked for closed ones, an open one only when not
  'https://gamma-api.polymarket.com/markets': p => fx.markets.filter(m => m.conditionId === p.condition_ids && (m.closed === true || m.closed === 'true') === !!p.closed),
  'https://gamma-api.polymarket.com/events': () => fx.pmEvents,
  'https://api.elections.kalshi.com/trade-api/v2/events': () => ({ events: fx.kalshiEvents, cursor: '' }),
  'https://api.elections.kalshi.com/trade-api/v2/markets/trades': () => ({ trades: fx.kalshiTrades, cursor: '' }),
  // Polymarket US: one NBA game (only when a test sets it)
  'https://gateway.polymarket.us/v1/events/slug/nba-nyk-bos-2026-10-10': () => { if (!fx.pmus) throw Object.assign(new Error('Request failed with status code 404'), { response: { status: 404 } }); return fx.pmus.event; },
  'https://gateway.polymarket.us/v1/markets/aec-nba-nyk-bos-2026-10-10/book': () => fx.pmus.book,
};
const axios = require('axios');
axios.get = async (url, cfg = {}) => {
  calls.push({ url, params: cfg.params || {} });
  const route = ROUTES[url];
  if (!route) throw Object.assign(new Error(`offline: ${url}`), { code: 'ENOTFOUND' });
  return { status: 200, headers: {}, data: JSON.parse(JSON.stringify(route(cfg.params || {}))) };
};
axios.post = async (url, body) => { posts.push({ url, body }); return { status: 204, data: '' }; };

const S = require('../server');
const tail = require('../tail');
const cron = require('node-cron');
for (const t of cron.getTasks().values()) t.stop();   // the test drives the jobs itself

let srv, base;
test.before(async () => {
  await new Promise(r => { srv = S.app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${srv.address().port}`;
  await S.tailEngine.ready();
  await S.tailTracker.ready();
});
test.after(() => {
  srv?.closeAllConnections?.();
  srv?.close();
  for (const t of cron.getTasks().values()) t.stop();
  Date.now = realNow;
  fs.rmSync(DIR, { recursive: true, force: true });
});

const PRO = { 'x-admin-token': ADMIN_TOKEN };
const get = async (p, headers = {}) => {
  const r = await fetch(base + p, { headers });
  return { status: r.status, body: await r.json() };
};
const post = async (p, body, headers = {}) => {
  const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};
const hasNoIdentity = (body, ...secrets) => { const text = JSON.stringify(body); for (const s of secrets) assert.ok(!text.includes(s), `leaks ${s}`); };
const noPolymarketLinks = (body, what) => assert.ok(!/https?:\/\/(www\.)?polymarket\.com/.test(JSON.stringify(body)), `${what} links to polymarket.com`);

test('settings: the active thresholds, the region and the licence gates, public', async () => {
  const { status, body } = await get('/api/tail/settings');
  assert.equal(status, 200);
  assert.equal(body.tail.minTrade, 500);
  assert.equal(body.tail.grades.A.minZ, 3);
  assert.equal(body.tail.grades.B.minN, 50);
  assert.equal(body.whales.minUsd, 5000);
  assert.equal(body.xarb.minPct, 0.5);
  assert.equal(body.xarb.alertMinPct, 1);
  assert.equal(body.freeDelayMinutes, 30);
  assert.equal(body.region, 'us', 'US mode is the default');
  assert.deepEqual(body.licence, { paywall: true, polymarketDisplayOk: true, kalshiDisplayOk: true, polymarket: 'shown', kalshi: 'shown', viewer: { polymarket: true, kalshi: true }, note: null });
});

test('candidates from the v2 leaderboard, then a scoring batch grades the wallet A, closing-line value included', async () => {
  fx.closed = eliteHistory(W1, Date.now());
  const r = await S.runTailJob('candidates', () => S.tailEngine.refreshCandidates());
  assert.equal(r.total, 1);
  assert.equal(calls.filter(c => c.url.endsWith('/v2/leaderboard')).length, tail.LEADERBOARD_CATEGORIES.length * tail.LEADERBOARD_PERIODS.length, 'categories × periods');
  const b = await S.runTailJob('score', () => S.tailEngine.scoreBatch());
  assert.deepEqual(b.wallets, [W1]);
  const tr = S.tailEngine.trader(W1);
  assert.equal(tr.grade, 'A', JSON.stringify(tr.reasons || tr.whyNotA));
  assert.equal(tr.categories.politics.grade, 'A');
  // every settled status was read, newest first (CLOSED would otherwise keep only the biggest winners)
  const pos = calls.filter(c => c.url.endsWith('/v2/positions'));
  for (const status of ['CLOSED', 'REDEEMABLE', 'REDEEMABLE_LOST']) assert.ok(pos.some(c => c.params.status === status && c.params.sort_by === 'TIMESTAMP'), status);
  assert.ok(pos.every(c => (c.params.status === 'CLOSED' || c.params.status === 'OPEN') !== (c.params.include_archived === true)), 'archived only on the unclaimed lists (CLOSED with it is a 400)');
  assert.ok(calls.some(c => c.url.endsWith('/v2/prices-history')), 'closing lines measured');
  assert.ok(!calls.some(c => /data-api\.polymarket\.com\/(?!v2\/)/.test(c.url)), 'v1 is retired: every data-API call is v2');
  // scores survive a restart
  const saved = JSON.parse(fs.readFileSync(process.env.TAIL_TRADERS_FILE, 'utf8'));
  assert.equal(saved[0].wallet, W1);
});

test('traders: Pro sees wallets; free sees the leaderboard with wallets masked', async () => {
  const pro = await get('/api/tail/traders?grade=graded', PRO);
  assert.equal(pro.status, 200);
  assert.equal(pro.body.pro, true);
  assert.equal(pro.body.traders.length, 1);
  assert.equal(pro.body.traders[0].wallet, W1);
  assert.equal(pro.body.traders[0].name, 'ElectionEdge');
  assert.equal(pro.body.state.graded.A, 1);
  assert.equal(pro.body.withheld, undefined);
  noPolymarketLinks(pro.body, 'traders');
  assert.equal((await get('/api/tail/traders?category=sports', PRO)).body.traders.length, 0, 'no sports record');
  assert.equal((await get('/api/tail/traders?category=politics&grade=A', PRO)).body.traders.length, 1);

  const free = await get('/api/tail/traders');
  assert.equal(free.body.pro, false);
  const t = free.body.traders[0];
  assert.equal(t.grade, 'A');
  assert.ok(t.roi > 0.3 && t.z > 3, 'the grading evidence stays');
  assert.equal(t.locked, true);
  assert.match(t.wallet, /^0x1a••••$/);
  assert.equal(t.name, null);
  assert.equal(t.url, null);
  assert.equal(t.pnl, undefined);
  assert.equal(t.risked, undefined);
  assert.equal(t.categories.politics.pnl, undefined);
  // edge = pnl / (risked + prior) × regression, so with roi it gives back risked and pnl
  assert.equal(t.edge, undefined);
  assert.equal(t.categories.politics.edge, undefined);
  assert.equal(t.openPnl, undefined);
  assert.equal(t.selectedAt, undefined);
  assert.equal(t.roi, Math.round(pro.body.traders[0].roi * 100) / 100, 'roi to the percent');
  const m = S.maskTrader({ wallet: W1, roi: 0.333333, edge: 0.142857, reasons: ['only $45,123 risked (need $50,000)'],
    whyNotA: ['only $45,123 risked (need $50,000)', 'z-score 2.1: profit could be luck'], categories: { sports: { edge: 0.1, roi: 0.0251, whyNotA: ['only $9,001 risked (need $50,000)'] } } });
  assert.deepEqual(m.reasons, ['not enough risked (need $50,000)'], 'the bar is public, the total is not');
  assert.deepEqual(m.whyNotA, ['not enough risked (need $50,000)', 'z-score 2.1: profit could be luck']);
  assert.deepEqual(m.categories.sports, { roi: 0.03, whyNotA: ['not enough risked (need $50,000)'] });
  assert.equal(m.roi, 0.33);
  assert.notEqual(t.id, W1);
  hasNoIdentity(free.body, W1, W1.slice(2, 14), 'ElectionEdge');
});

test('trader detail is Pro only', async () => {
  assert.equal((await get(`/api/tail/trader/${W1}`)).status, 401);
  const r = await get(`/api/tail/trader/${W1.toUpperCase().replace('0X', '0x')}`, PRO);
  assert.equal(r.status, 200);
  assert.equal(r.body.trader.grade, 'A');
  assert.equal((await get('/api/tail/trader/0xdeadbeef', PRO)).status, 404);
});

test('exchange arb scan: the first scan primes, Pro sees legs and the % split, free sees count and profit % only', async () => {
  fx.kalshiEvents = [kalshiEvent('KXFEDCHAIR-26', 'Who will Trump nominate as Fed Chair?', [['Kevin Warsh', '0.2800'], ['Kevin Hassett', '0.2800'], ['Christopher Waller', '0.2900'], ['Someone else', '0.0400']])];
  const fresh = await S.runTailJob('xarb', S.scanXarbs);
  assert.deepEqual(fresh, [], 'a restart is not news');
  assert.equal(S.xarbState.arbs.length, 1);
  assert.equal(posts.length, 0);

  const pro = await get('/api/xarbs', PRO);
  assert.equal(pro.body.count, 1);
  assert.equal(pro.body.region, 'us');
  const a = pro.body.arbs[0];
  assert.equal(a.type, 'multi');
  assert.equal(a.legs.length, 4);
  assert.ok(a.profitPct > 1, `profit ${a.profitPct}%`);
  assert.equal(a.exhaustive, true, '"Someone else" covers every other name');
  assert.equal(a.maxStake, null, 'no executable size claimed');
  assert.ok(a.warnings.length, 'carries the coverage warning');
  // the same split for everyone: each leg's % of the total
  const pcts = a.stakes.legs.map(l => l.pct);
  assert.ok(pcts.every(x => x > 0));
  assert.ok(Math.abs(pcts.reduce((x, y) => x + y, 0) - 100) < 0.3, String(pcts));
  assert.equal(a.stakes.bankroll, 100, 'the $100 reference');
  // no re-split from anyone's bankroll
  const big = await get('/api/xarbs?bankroll=1000', PRO);
  assert.deepEqual(big.body.arbs[0].stakes, a.stakes, '?bankroll= is ignored');
  assert.equal(big.body.bankroll, undefined);
  assert.equal((await get('/api/xarbs?minPct=50', PRO)).body.count, 0);

  const free = await get('/api/xarbs');
  assert.equal(free.body.count, 1);
  assert.deepEqual(free.body.arbs, [{ profitPct: a.profitPct, locked: true }]);
  assert.equal(free.body.counts, undefined);
});

test('a fresh trade by the A-grade wallet becomes a sized signal; whales see it too, from one shared v2 read', async () => {
  fx.markets = [gammaMarket()];
  fx.trades = [
    trade({ size: 15000, price: 0.40, tx: '0xtx1' }),                                  // $6,000 by W1
    trade({ wallet: W9, size: 20000, price: 0.5, tx: '0xtx9', name: 'Quiet-Fox' }),   // $10,000 by nobody we know
  ];
  fx.kalshiTrades = [{ trade_id: 'k-1', ticker: 'KXFEDCHAIR-26-KEV0', count: 20000, yes_price_dollars: '0.3000', no_price_dollars: '0.7000', taker_side: 'yes', created_time: iso(Date.now() - 30e3) }];
  const before = S.upstream.stats();
  const [whalesOut, signals] = await Promise.all([S.runTailJob('whales', S.pollWhales), S.runTailJob('signals', S.pollTail)]);
  const after = S.upstream.stats();
  const reads = calls.filter(c => c.url === 'https://data-api.polymarket.com/v2/trades' && !c.params.user);
  assert.equal(reads.length, 1, 'the trades page was read once');
  assert.deepEqual({ ...reads[0].params }, { limit: 500, taker_only: true, filter_type: 'CASH', filter_amount: 500 });
  assert.ok(after.shared > before.shared);

  assert.equal(signals.length, 1);
  const s = signals[0];
  assert.equal(s.type, 'entry');
  assert.equal(s.grade, 'A');
  assert.equal(s.wallet, W1);
  assert.equal(s.category, 'politics');
  assert.equal(s.currentPrice, 0.41);
  assert.equal(s.units, 2, 'quarter Kelly hits the 2u cap for A');
  assert.equal(s.theirNotional, 6000);
  assert.ok(s.q > 0.41 && s.q < 1, 'q: our probability of the outcome bought');
  // no Kalshi market asks this, and it isn't a game: nowhere a US person can tail it
  assert.equal(s.venue, null);
  assert.deepEqual(s.venues, []);

  assert.equal(whalesOut.length, 3);
  const graded = whalesOut.find(e => e.wallet === W1);
  assert.equal(graded.tag, 'graded whale');
  assert.equal(graded.grade, 'A');
  assert.equal(whalesOut.find(e => e.wallet === W9).tag, 'unknown whale');
  const k = whalesOut.find(e => e.exchange === 'kalshi');
  assert.equal(k.notional, 6000);
  assert.match(k.title, /Fed Chair/, 'titled from the arb scan');

  // the A-grade signal went to the webhook, with the venue line and no polymarket.com link
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, WEBHOOK);
  assert.match(posts[0].body.content, /A-grade ElectionEdge bought Yes on "Will Smith win the Ohio Senate election\?" at 40¢ \(\$6,000\) · No US venue found yet: watch only$/);
  assert.doesNotMatch(posts[0].body.content, /polymarket\.com/);
});

test('signals: Pro live; free only 30+ minutes late, wallets masked; no polymarket.com links in US mode', async () => {
  const pro = await get('/api/tail/signals', PRO);
  assert.equal(pro.body.signals.length, 1);
  assert.equal(pro.body.signals[0].wallet, W1);
  assert.equal(pro.body.locked, 0);
  assert.equal(pro.body.region, 'us');
  assert.equal(pro.body.signals[0].url, null, 'the market title and the US venue instead');
  assert.equal(pro.body.signals[0].market, 'Will Smith win the Ohio Senate election?');
  noPolymarketLinks(pro.body, 'signals');

  const free = await get('/api/tail/signals');
  assert.equal(free.body.pro, false);
  assert.deepEqual(free.body.signals, []);
  assert.equal(free.body.locked, 1);
  assert.equal(free.body.delayMinutes, 30);

  tick(31 * 60e3);
  const later = await get('/api/tail/signals');
  assert.equal(later.body.locked, 0);
  assert.equal(later.body.signals.length, 1);
  const s = later.body.signals[0];
  assert.equal(s.units, 2);
  assert.equal(s.locked, true);
  assert.equal(s.name, null);
  assert.match(s.wallet, /^0x1a••••$/);
  hasNoIdentity(later.body, W1, 'ElectionEdge', '0xtx1', COND, '7123001');
  // Polymarket lists every trade with its wallet: no exact size, time or id to look it up by
  assert.equal(s.theirNotional, null);
  assert.equal(s.sizeRange, '$5k–$10k');
  assert.equal(s.theirSize, undefined);
  assert.equal(s.conditionId, undefined);
  assert.equal(Date.parse(s.at) % (15 * 60e3), 0);
  assert.equal(s.edge, undefined, 'edge with roi gives back the dollar totals');
  assert.equal(s.q, undefined, 'and so does q');
  assert.equal(s.prob, undefined);
  assert.equal(pro.body.signals[0].theirNotional, 6000, 'Pro keeps it all');
  assert.equal((await get('/api/tail/signals?type=exit', PRO)).body.signals.length, 0);
});

test('whales: Pro sees wallets and grades; free gets them masked; Kalshi block trades and the newer fields', async () => {
  // a 30,000-contract block: the taker SOLD YES at 30¢ (taker_book_side ask), so it's NO money at 70¢
  fx.kalshiTrades = [{ trade_id: 'k-blk', ticker: 'KXFEDCHAIR-26-KEV0', count_fp: '30000.00', yes_price_dollars: '0.3000', no_price_dollars: '0.7000',
    taker_outcome_side: 'yes', taker_book_side: 'ask', is_block_trade: true, created_time: iso(Date.now() - 20e3) }];
  fx.trades = [trade({ wallet: W9, size: 30000, price: 0.5, tx: '0xtx10', name: 'Quiet-Fox', agoMs: 20e3 })];
  tick(6e3);   // past the shared-response window
  await S.runTailJob('whales', S.pollWhales);
  const pro = await get('/api/whales', PRO);
  assert.ok(pro.body.events.length >= 5);
  assert.ok(pro.body.events.some(e => e.wallet === W1 && e.grade === 'A'));
  assert.ok(pro.body.flow.length >= 1);
  assert.equal(pro.body.minUsd, 5000);
  const kalshi = (await get('/api/whales?exchange=kalshi', PRO)).body.events;
  assert.equal(kalshi.length, 2);
  const blk = kalshi.find(e => e.block);
  assert.ok(blk, 'the block trade is flagged');
  assert.equal(blk.side, 'no');
  assert.equal(blk.notional, 21000);
  assert.equal(blk.contracts, 30000, 'count_fp');
  assert.equal(blk.tag, 'block trade');
  assert.ok((await get('/api/whales?graded=1', PRO)).body.events.every(e => e.graded));
  noPolymarketLinks(pro.body, 'whales');

  const free = await get('/api/whales');
  hasNoIdentity(free.body, W1, W9, 'ElectionEdge', 'Quiet-Fox', '0xtx1');
  const old = free.body.events.find(e => e.exchange === 'polymarket' && e.grade === 'A');
  assert.ok(old, 'a graded whale over 30 minutes old keeps its grade');
  assert.match(old.wallet, /^0x1a••••$/);
  const fresh = free.body.events.find(e => e.exchange === 'polymarket' && Date.now() - Date.parse(e.at) < 30 * 60e3);
  assert.equal(fresh.gradeLocked, true);
  assert.equal(fresh.tag, 'whale');
  // graded (or maybe-graded) prints lose what finds the trade on Polymarket's market activity list
  for (const e of [old, fresh]) {
    assert.equal(e.conditionId, null);
    assert.equal(e.asset, null);
    assert.equal(e.contracts, null);
    assert.equal(Date.parse(e.at) % (15 * 60e3), 0);
  }
  assert.equal(old.notional, 6000);
  // the graded count would say which locked prints are graded
  assert.equal(free.body.state.lastHour.graded, undefined);
  assert.equal(free.body.state.errors, undefined);
  assert.equal(typeof pro.body.state.lastHour.graded, 'number');
});

test('live stream carries tail, whale and xarb events; new arbs of 1%+ hit the webhook', async () => {
  // no scan since the clock jumped 31 minutes: an arb missing that long is news again
  const back = await S.runTailJob('xarb', S.scanXarbs);
  assert.deepEqual(back.map(a => a.type), ['multi']);
  assert.match(posts.at(-1).body.content, /Fed Chair/);
  const ac = new AbortController();
  const res = await fetch(`${base}/api/ev/stream`, { headers: PRO, signal: ac.signal });
  assert.equal(res.status, 200);
  const events = [];
  const reader = res.body.getReader(), dec = new TextDecoder();
  let buf = '';
  const pump = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
          const type = /^event: (.+)$/m.exec(chunk)?.[1], data = /^data: (.*)$/m.exec(chunk)?.[1];
          if (type) events.push({ type, data: data ? JSON.parse(data) : null });
        }
      }
    } catch { /* aborted */ }
  })();
  const waitFor = async type => {
    for (let t0 = realNow(); realNow() - t0 < 3000;) {
      const e = events.find(x => x.type === type);
      if (e) return e;
      await new Promise(r => setTimeout(r, 10));
    }
    throw new Error(`no ${type} event; got ${events.map(e => e.type)}`);
  };
  try {
  await waitFor('hello');
  assert.equal(S.liveListeners.size, 1);

  tick(6e3);
  posts.length = 0;
  fx.markets = [gammaMarket(), texasMarket()];
  fx.trades = [
    trade({ size: 5000, price: 0.40, tx: '0xtx2', agoMs: 10e3, ...TEXAS }),   // a new market: a new 2u tail
    trade({ size: 5000, price: 0.40, tx: '0xtx3', agoMs: 8e3 }),              // more of the Ohio bet already tailed at 2u
  ];
  fx.kalshiTrades = [{ trade_id: 'k-2', ticker: 'KXFEDCHAIR-26-KEV1', count: 25000, yes_price_dollars: '0.3000', no_price_dollars: '0.7000', taker_side: 'no', created_time: iso(Date.now() - 5e3) }];
  fx.kalshiEvents.push(kalshiEvent('KXNEXTPOPE-26', 'Who will be the next Pope?', [['Pietro Parolin', '0.4000'], ['Luis Tagle', '0.4500'], ['Someone else', '0.0500']]));
  // no catch-all: the 15% left over is "anyone else", so this is listed but never alerted
  fx.kalshiEvents.push(kalshiEvent('KXNEXTUKPM-26', 'Who will be the next UK Prime Minister?', [['Wes Streeting', '0.4000'], ['Angela Rayner', '0.4000']]));
  await Promise.all([S.runTailJob('whales', S.pollWhales), S.runTailJob('signals', S.pollTail)]);
  await S.runTailJob('xarb', S.scanXarbs);

  const t = await waitFor('tail');
  assert.ok(t.data.every(s => s.wallet === W1));
  const tx2 = t.data.find(s => s.id === `0xtx2:${TEXAS.asset}:${W1}`), tx3 = t.data.find(s => s.id === '0xtx3:7123001:' + W1);
  assert.equal(tx2.units, 2);
  assert.equal(tx2.url, null, 'no polymarket.com link on the stream in US mode');
  assert.ok('venue' in tx2, 'routed before it went out');
  assert.equal(tx3.topUp, true, 'same wallet, same outcome: a top-up, not a fresh 2u');
  assert.equal(tx3.parentId, '0xtx1:7123001:' + W1);
  assert.equal(tx3.units, 0);
  assert.match(tx3.reason, /already tailed at 2u/);
  const w = await waitFor('whale');
  assert.equal(w.data[0].exchange, 'kalshi');
  assert.equal(w.data[0].side, 'no');
  assert.equal(w.data[0].notional, 17500);
  const x = await waitFor('xarb');
  assert.deepEqual(x.data.map(a => a.title).sort(), ['Who will be the next Pope?', 'Who will be the next UK Prime Minister?'], 'only the new arbs');
  assert.equal(x.data.find(a => /UK/.test(a.title)).exhaustive, false);
  } finally { ac.abort(); await pump; }

  const text = posts.map(p => p.body.content).join('\n');
  assert.equal((text.match(/A-grade ElectionEdge bought Yes/g) || []).length, 1, 'the new market is pinged, the 0u top-up is not');
  assert.match(text, /bought Yes on "Will Jones win the Texas Senate election\?"/);
  assert.match(text, /♻️ Arb \+\d+(\.\d+)?%: Who will be the next Pope\? · Kalshi Pietro Parolin 40¢ \+ Kalshi Luis Tagle 45¢ \+ Kalshi Someone else 5¢/);
  assert.doesNotMatch(text, /Fed Chair/, 'the arb already seen is not posted again');
  assert.doesNotMatch(text, /UK Prime Minister/, 'a set not proven exhaustive is never alerted');
  await new Promise(r => setTimeout(r, 20));
  assert.equal(S.liveListeners.size, 0, 'listener removed on disconnect');
});

test('track record: logged at the follower price, graded when the market resolves; free sees settled only', async () => {
  const open = await get('/api/tail/record', PRO);
  assert.equal(open.body.open, 2);
  assert.equal(open.body.signals.length, 2);
  assert.ok(open.body.signals.every(r => r.status === 'open' && r.entry === 0.41));
  const freeOpen = await get('/api/tail/record');
  assert.equal(freeOpen.body.open, 2);
  assert.deepEqual(freeOpen.body.signals, []);

  fx.markets = [gammaMarket({ closed: true, prices: ['1', '0'], bestAsk: null, bestBid: null }), texasMarket({ closed: true, prices: ['1', '0'], bestAsk: null, bestBid: null })];
  tick(6e3);
  const r = await S.runTailJob('record', () => S.tailTracker.check());
  assert.equal(r.settled, 2);
  const done = await get('/api/tail/record');
  assert.equal(done.body.overall.wins, 2);
  assert.equal(done.body.overall.losses, 0);
  assert.equal(done.body.overall.units, Math.round(2 * 2 * (1 / 0.41 - 1) * 100) / 100, 'two 2u wins at 41¢');
  assert.equal(done.body.overall.roi, Math.round((1 / 0.41 - 1) * 1e4) / 1e4);
  assert.equal(done.body.byGrade.A.n, 2);
  assert.equal(done.body.signals.length, 2);
  assert.ok(done.body.signals.every(s => s.result === 'win' && s.locked));
  hasNoIdentity(done.body, W1, 'ElectionEdge', '0xtx1', '0xtx2', COND, COND2, TEXAS.asset);
  noPolymarketLinks(done.body, 'record');
  // no trade fingerprint for free: a price to the cent, a quarter-hour time, a size range
  for (const r of done.body.signals) {
    assert.equal(r.theirPrice, 0.4);
    assert.equal(Date.parse(r.at) % (15 * 60e3), 0);
    assert.equal(Date.parse(r.recordedAt) % (15 * 60e3), 0);
    assert.equal(r.edge, undefined);
    assert.equal(r.theirSize, undefined);
  }
  assert.equal((await get('/api/tail/record?grade=B', PRO)).body.signals.length, 0);
});

test('status reports tail, whales, exchange arbs, the region, the licence gates and the upstream queue', async () => {
  const { body } = await get('/api/status');
  assert.equal(body.version, '3.40.0');
  assert.equal(body.tail.scored, 1);
  assert.equal(body.tail.graded.A, 1);
  assert.ok(body.tail.jobs.signals.lastRun);
  assert.equal(body.tail.jobs.signals.failed, false);
  assert.equal(body.tail.record.open, 0);
  assert.ok(body.tail.routing.routed >= 2);
  assert.ok(body.whales.events >= 6);
  assert.equal(body.xarb.arbs, 3);
  assert.equal(body.xarb.counts.kalshiEvents, 3);
  assert.equal(body.region, 'us');
  assert.equal(body.licence.paywall, true);
  assert.equal(body.licence.polymarket, 'shown');
  assert.equal(body.licence.kalshi, 'shown');
  // free: counts and times, nothing that names a wallet or dates a locked signal
  assert.equal(body.tail.errors, undefined);
  assert.equal(body.tail.lastSignalAt, undefined);
  assert.equal(body.tail.jobs.signals.error, undefined);
  assert.equal(body.whales.lastHour.graded, undefined);
  assert.equal(body.whales.errors, undefined);
  const pro = (await get('/api/status', PRO)).body;
  assert.ok(Array.isArray(pro.tail.errors));
  assert.ok(pro.tail.lastSignalAt);
  assert.equal(typeof pro.whales.lastHour.graded, 'number');
  assert.ok(body.upstream.byHost['data-api.polymarket.com'] > 0);
  assert.equal(body.live.webhook, true);
  assert.equal(require('../package.json').version, '3.40.0');
  assert.equal((await get('/')).body.version, '3.40.0');
});

test('US mode: Polymarket-only arbs are hidden (its rows still feed routing); a new Kalshi arb is news', async () => {
  const pmEvent = (id, title, names) => ({
    id, slug: `pm-${id}`, title, negRisk: true, endDate: iso(Date.now() + 60 * DAY), tags: [{ label: 'Politics' }],
    markets: names.map(([n, ask], i) => ({ id: `${id}${i}`, question: `Will ${n} win?`, groupItemTitle: n, outcomes: '["Yes","No"]', conditionId: `0xpm${id}${i}`,
      clobTokenIds: JSON.stringify([`${id}${i}1`, `${id}${i}2`]), bestAsk: ask, bestBid: ask - 0.01, active: true, closed: false, negRisk: true, endDate: iso(Date.now() + 60 * DAY) })),
  });
  // a Polymarket underround: an arb in intl mode, nothing a US person can place
  fx.pmEvents = [pmEvent('881', 'Next Mayor of Springfield', [['Alice Moe', 0.4], ['Bart Barney', 0.4], ['Other', 0.1]])];
  tick(6e3);
  posts.length = 0;
  const first = await S.runTailJob('xarb', S.scanXarbs);
  assert.deepEqual(first, []);
  assert.ok(!S.xarbState.arbs.some(a => a.title === 'Next Mayor of Springfield'), 'not listed in US mode');
  assert.ok(S.xarbState.arbs.every(a => a.legs.every(l => l.venue !== 'polymarket')), 'no Polymarket leg anywhere');
  assert.equal(S.xarbState.primed.polymarket, true);
  assert.equal(S.xarbState.venues.size, 3, 'its markets are indexed for routing signals');
  assert.equal(posts.length, 0);
  const listed = await get('/api/xarbs', PRO);
  assert.ok(listed.body.arbs.every(a => a.legs.every(l => l.venue === 'kalshi')));
  noPolymarketLinks(listed.body, 'arbs');

  fx.kalshiEvents.push(kalshiEvent('KXNEXTGOV-26', 'Next Governor of Shelbyville?', [['Carl Lenny', '0.4500'], ['Someone else', '0.4500']]));
  tick(6e3);
  const next = await S.runTailJob('xarb', S.scanXarbs);
  assert.deepEqual(next.map(a => a.title), ['Next Governor of Shelbyville?'], 'a new Kalshi one is');
  assert.match(posts.map(p => p.body.content).join('\n'), /Shelbyville/);
  fx.kalshiEvents.pop();
});

// ── where to tail ──
const NBA_COND = '0xnba0000000000000000000000000000000000000000000000000000000000c1';
const nba = () => {
  const start = Date.now() + 2 * DAY;
  const kalshiMarket = (ticker, label, yes, no) => ({
    ticker, event_ticker: 'KXNBAGAME-26OCT10NYKBOS', title: 'New York K at Boston Winner?', yes_sub_title: label, status: 'active',
    yes_ask_dollars: yes, no_ask_dollars: no, yes_bid_dollars: (Number(yes) - 0.02).toFixed(4), no_bid_dollars: (Number(no) - 0.02).toFixed(4),
    close_time: iso(start + 14 * DAY), expected_expiration_time: iso(start + 3 * 3600e3), volume: 52000, liquidity_dollars: '25000.00',
    rules_primary: 'If Boston wins the New York K vs Boston professional basketball game, then the market resolves to Yes.',
  });
  const market = {
    id: '555', question: 'Knicks vs. Celtics', conditionId: NBA_COND, slug: 'nba-nyk-bos-2026-10-10', outcomes: '["Knicks","Celtics"]',
    outcomePrices: '["0.395","0.605"]', clobTokenIds: '["8801","8802"]', bestBid: 0.39, bestAsk: 0.4, lastTradePrice: 0.4, active: true, closed: false,
    acceptingOrders: true, gameStartTime: iso(start), sportsMarketType: 'moneyline', endDate: iso(start + 3 * 3600e3), volume: '180000', liquidity: '42000',
    feeType: 'sports_fees_v2', feeSchedule: { rate: 0.05, exponent: 1, takerOnly: true, rebateRate: 0.25 },
    events: [{ id: '9001', slug: 'nba-nyk-bos-2026-10-10', title: 'Knicks vs. Celtics', category: 'Sports' }],
  };
  return {
    start,
    kalshi: {
      event_ticker: 'KXNBAGAME-26OCT10NYKBOS', series_ticker: 'KXNBAGAME', title: 'New York K at Boston', category: 'Sports', mutually_exclusive: true,
      // Celtics: Boston YES 63¢ = New York K NO 63¢
      markets: [kalshiMarket('KXNBAGAME-26OCT10NYKBOS-BOS', 'Boston', '0.6300', '0.3900'), kalshiMarket('KXNBAGAME-26OCT10NYKBOS-NYK', 'New York K', '0.3900', '0.6300')],
    },
    pmEvent: { id: '9001', slug: 'nba-nyk-bos-2026-10-10', title: 'Knicks vs. Celtics', negRisk: false, endDate: market.endDate,
      tags: [{ label: 'Sports', slug: 'sports' }, { label: 'NBA', slug: 'nba' }], markets: [market] },
    market,
    game: celtics => ({
      id: 'g-nba-1', sport_key: 'basketball_nba', commence_time: iso(start), home_team: 'Boston Celtics', away_team: 'New York Knicks',
      bookmakers: [
        { key: 'draftkings', title: 'DraftKings', markets: [{ key: 'h2h', outcomes: [{ name: 'Boston Celtics', price: celtics }, { name: 'New York Knicks', price: 145 }] }] },
        // better, but offshore: never a venue in US mode
        { key: 'pinnacle', title: 'Pinnacle', markets: [{ key: 'h2h', outcomes: [{ name: 'Boston Celtics', price: -120 }, { name: 'New York Knicks', price: 110 }] }] },
      ],
    }),
  };
};
const kalshiFee63 = Math.ceil(0.07 * 100 * 0.63 * 0.37 * 100 - 1e-9) / 100 / 100;   // per contract, 100-lot

test('where to tail: a sports signal goes to the venue with the most units (a US sportsbook here), Kalshi listed too', async () => {
  const g = nba();
  fx.kalshiEvents.push(g.kalshi);
  fx.pmEvents = [g.pmEvent];
  fx.markets = [g.market];
  S.cache.odds.basketball_nba = { data: [g.game(-170)], updated: iso(Date.now()) };
  tick(6e3);
  await S.runTailJob('xarb', S.scanXarbs);
  const idx = S.xarbState.venues;
  assert.equal(idx.byCondition.get(NBA_COND.toLowerCase()).matches.length, 2, 'both Kalshi team markets match the Polymarket game');

  posts.length = 0;
  fx.trades = [trade({ size: 10000, price: 0.6, tx: '0xtxnba', asset: '8802', cond: NBA_COND, title: 'Knicks vs. Celtics', slug: 'nba-nyk-bos-2026-10-10',
    eventSlug: 'nba-nyk-bos-2026-10-10', outcome: 'Celtics', outcomeIndex: 1, agoMs: 5e3 })];
  const [s] = await S.runTailJob('signals', S.pollTail);
  assert.ok(s, 'a signal');
  assert.equal(s.category, 'sports');
  assert.ok(s.units > 0, 'sized at Polymarket too');

  // every quote: Kalshi Boston YES and New York K NO (63¢ + fee), DraftKings -170; no Pinnacle, no Polymarket
  assert.deepEqual(s.venues.map(v => v.key).sort(), ['draftkings', 'kalshi', 'kalshi']);
  const k = s.venues.find(v => v.key === 'kalshi');
  assert.equal(k.price, 0.63);
  assert.ok(Math.abs(k.fee - kalshiFee63) < 1e-9, `fee ${k.fee}`);
  assert.equal(k.url, 'https://kalshi.com/markets/kxnbagame-26oct10nykbos');
  const dk = s.venues.find(v => v.key === 'draftkings');
  assert.equal(dk.american, -170);
  assert.ok(Math.abs(dk.price - 170 / 270) < 1e-6, 'implied 1/decimal, no fee');
  assert.equal(dk.fee, 0);
  // each sized with tail.sizeAt at its own price and fee, from the signal's q
  for (const v of s.venues) {
    const z = tail.sizeAt({ q: s.q, price: v.price, feePerContract: v.fee, grade: s.grade, consensus: s.consensus, opts: S.tailEngine.settings() });
    assert.equal(v.units, z.units, v.key);
    assert.equal(v.maxPrice, z.maxPrice, v.key);
  }
  assert.ok(dk.units >= k.units && dk.units > 0);
  assert.equal(s.venue.key, 'draftkings', 'more units (or as many, cheaper)');
  assert.equal(s.venue.name, 'DraftKings');

  // the webhook leads with the same line; no polymarket.com
  const text = posts.map(p => p.body.content).join('\n');
  assert.ok(text.includes(S.venueLine(s)), `${text} has ${S.venueLine(s)}`);
  assert.match(S.venueLine(s), /^Tail at DraftKings: Boston Celtics -170 · \d+(\.\d+)?u · don't pay above \d+¢ \(-\d+\)$/);
  assert.doesNotMatch(text, /polymarket\.com/);

  // the app's API: the same venue, no polymarket.com
  const api = (await get('/api/tail/signals', PRO)).body.signals.find(x => x.id === s.id);
  assert.equal(api.venue.key, 'draftkings');
  assert.equal(api.venues.length, 3);
  noPolymarketLinks(api, 'a routed signal');
});

test('where to tail: Kalshi when the books are worse; nothing matched is "watch only"', async () => {
  const g = nba();
  // the book moves to -250 (71.4¢): Kalshi's 63¢ + 1.6¢ fee now gives more
  S.cache.odds.basketball_nba = { data: [g.game(-250)], updated: iso(Date.now()) };
  tick(6e3);
  await S.runTailJob('xarb', S.scanXarbs);
  const [s] = S.tailEngine.signals({ limit: 50 }).filter(x => x.conditionId === NBA_COND);
  const routed = S.routeSignal({ ...s, topUp: false, venue: undefined, venues: undefined });
  assert.equal(routed.venue.key, 'kalshi');
  assert.equal(routed.venue.price, 0.63);
  assert.ok(routed.venue.units > routed.venues.find(v => v.key === 'draftkings').units);
  assert.match(S.venueLine(routed), /^Tail at Kalshi: (YES Boston|NO New York K) 63¢ · \d+(\.\d+)?u · don't pay above \d+¢$/);
  assert.equal(routed.venue.url, 'https://kalshi.com/markets/kxnbagame-26oct10nykbos');
  // a top-up adds only what the venue's size is above the units already signalled
  const top = S.routeSignal({ ...s, id: 'top', topUp: true, parentId: s.id, priorUnits: 0.5, venue: undefined, venues: undefined });
  assert.equal(top.venue.key, 'kalshi');
  assert.equal(top.venue.units, Math.max(0, Math.round((routed.venue.units - 0.5) * 100) / 100));
  const full = S.routeSignal({ ...s, id: 'full', topUp: true, parentId: s.id, priorUnits: 9, venue: undefined, venues: undefined });
  assert.ok(full.venues.every(v => v.units === 0), 'already at size everywhere: nothing more');

  // a market neither Kalshi nor a book lists
  const lone = S.routeSignal({ ...s, id: 'lone', conditionId: '0xnothing', asset: 'nothing', venue: undefined, venues: undefined });
  assert.equal(lone.venue, null);
  assert.deepEqual(lone.venues, []);
  assert.equal(S.venueLine(lone), 'No US venue found yet: watch only');
  // in-play and near-certain bets aren't tails at any venue, nor pinged, A grade or not
  for (const blocked of ['in-play', 'near-certain', 'split']) {
    const b = S.routeSignal({ ...s, id: `b-${blocked}`, topUp: false, blocked, venue: undefined, venues: undefined });
    assert.ok(b.venues.length > 0 && b.venues.every(v => v.units === 0), blocked);
    assert.equal(S.tailPings({ ...b, grade: 'A' }), false, `${blocked}: no ping`);
    assert.equal(S.tailPings({ ...b, blocked: null, grade: 'A' }), true);
  }
  // no venue goes past the room left on the game
  const room = S.routeSignal({ ...s, id: 'room', topUp: false, eventRoom: 0.25, venue: undefined, venues: undefined });
  assert.ok(routed.venue.units > 0.25 && room.venues.every(v => v.units <= 0.25) && room.venue.units === 0.25);
  const none = S.routeSignal({ ...s, id: 'none', topUp: false, eventRoom: 0, venue: undefined, venues: undefined });
  assert.ok(none.venues.every(v => v.units === 0), 'the game is full');
  // exits aren't routed
  assert.equal(S.routeSignal({ type: 'exit', id: 'x' }).venue, undefined);
  // put the -170 book back for the gate tests
  S.cache.odds.basketball_nba = { data: [g.game(-170)], updated: iso(Date.now()) };
});

// ── data licences ──
let payingToken = null;
async function payingUser() {
  if (!payingToken) {
    const r = await post('/api/auth/signup', { email: 'subscriber@example.com', password: 'correct horse battery' });
    assert.equal(r.status, 201);
    assert.equal((await post('/api/admin/comp', { email: 'subscriber@example.com', comp: true }, PRO)).status, 200);
    payingToken = r.body.token;
  }
  return { authorization: `Bearer ${payingToken}` };
}
const grantBoth = () => { process.env.POLYMARKET_DISPLAY_OK = 'on'; process.env.KALSHI_DISPLAY_OK = 'on'; };

test('licence gates, PAYWALL on and both flags off: the admin sees everything, paying and free users get the note', async () => {
  const PAYING = await payingUser();
  assert.equal((await get('/api/tail/traders', PAYING)).body.pro, true, 'a paying (comped) account');
  process.env.POLYMARKET_DISPLAY_OK = 'off';
  process.env.KALSHI_DISPLAY_OK = '';
  try {
    // admin: everything
    assert.equal((await get('/api/tail/traders', PRO)).body.traders.length, 1);
    const adminSignals = (await get('/api/tail/signals', PRO)).body.signals;
    assert.ok(adminSignals.length >= 3);
    assert.ok(adminSignals.find(x => x.conditionId === NBA_COND).venues.some(v => v.key === 'kalshi'));
    const adminWhales = (await get('/api/whales', PRO)).body.events;
    assert.ok(adminWhales.some(e => e.exchange === 'kalshi') && adminWhales.some(e => e.exchange === 'polymarket'));
    assert.ok((await get('/api/xarbs', PRO)).body.count >= 3);
    assert.ok((await get('/api/tail/record', PRO)).body.signals.length >= 2);
    assert.equal((await get('/api/tail/settings', PRO)).body.licence.viewer.kalshi, true);

    for (const [who, h] of [['paying', PAYING], ['free', {}]]) {
      const tr = (await get('/api/tail/traders', h)).body;
      assert.deepEqual(tr.traders, [], `${who}: no Polymarket wallets`);
      assert.deepEqual(tr.withheld, ['polymarket']);
      assert.equal(tr.note, 'waiting on data permission');
      const sg = (await get('/api/tail/signals', h)).body;
      assert.deepEqual(sg.signals, [], `${who}: no signals`);
      assert.equal(sg.locked, 0, 'not even a count of live ones');
      assert.deepEqual(sg.withheld, ['polymarket']);
      const wh = (await get('/api/whales', h)).body;
      assert.deepEqual(wh.events, [], `${who}: no whale prints from either source`);
      assert.deepEqual(wh.flow, []);
      assert.deepEqual(wh.withheld, ['kalshi', 'polymarket']);
      const xa = (await get('/api/xarbs', h)).body;
      assert.equal(xa.count, 0, `${who}: every US arb has a Kalshi leg`);
      assert.deepEqual(xa.arbs, []);
      assert.deepEqual(xa.withheld, ['kalshi']);
      const rec = (await get('/api/tail/record', h)).body;
      assert.deepEqual(rec.signals, [], `${who}: no record rows`);
      assert.equal(rec.overall.wins, 2, 'the totals stay');
      assert.deepEqual((await get('/api/exchanges', h)).body.withheld, ['kalshi', 'polymarket']);
    }
    assert.equal((await get(`/api/tail/trader/${W1}`, PAYING)).status, 403);
    assert.equal((await get(`/api/tail/trader/${W1}`, PRO)).status, 200);
    const st = (await get('/api/tail/settings', PAYING)).body.licence;
    assert.deepEqual(st, { paywall: true, polymarketDisplayOk: false, kalshiDisplayOk: false, polymarket: 'admin only', kalshi: 'admin only', viewer: { polymarket: false, kalshi: false }, note: 'waiting on data permission' });
    assert.equal((await get('/api/status')).body.licence.polymarket, 'admin only');

    // Polymarket allowed, Kalshi not: signals show, routed away from Kalshi; Kalshi whales and arbs stay hidden
    process.env.POLYMARKET_DISPLAY_OK = 'on';
    const sg = (await get('/api/tail/signals', PAYING)).body;
    const nbaSig = sg.signals.find(x => x.conditionId === NBA_COND);
    assert.ok(nbaSig);
    assert.ok(nbaSig.venues.length > 0 && nbaSig.venues.every(v => v.key !== 'kalshi'), 'no Kalshi prices');
    assert.equal(nbaSig.venue.key, 'draftkings', 'the best venue that is left');
    assert.match(nbaSig.venueNote, /Kalshi prices: waiting on data permission/);
    const wh = (await get('/api/whales', PAYING)).body;
    assert.ok(wh.events.length > 0 && wh.events.every(e => e.exchange === 'polymarket'));
    assert.deepEqual(wh.withheld, ['kalshi']);
    assert.equal((await get('/api/xarbs', PAYING)).body.count, 0);
    assert.equal((await get('/api/tail/traders', PAYING)).body.traders.length, 1);

    // both on: the paying user sees it all
    process.env.KALSHI_DISPLAY_OK = 'yes';
    assert.ok((await get('/api/xarbs', PAYING)).body.count >= 3);
    assert.equal((await get('/api/whales', PAYING)).body.withheld, undefined);
    assert.ok((await get('/api/tail/signals', PAYING)).body.signals.find(x => x.conditionId === NBA_COND).venues.some(v => v.key === 'kalshi'));
  } finally { grantBoth(); }
});

test('licence gates on the live stream and the webhook: a paying listener gets only what its licences allow', async () => {
  const PAYING = await payingUser();
  process.env.POLYMARKET_DISPLAY_OK = 'off';
  process.env.KALSHI_DISPLAY_OK = 'off';
  const ac = new AbortController();
  try {
    const res = await fetch(`${base}/api/ev/stream?token=${encodeURIComponent(PAYING.authorization.slice(7))}`, { signal: ac.signal });
    assert.equal(res.status, 200);
    const reader = res.body.getReader(), dec = new TextDecoder();
    const got = [];
    const pump = (async () => { try { for (;;) { const { value, done } = await reader.read(); if (done) return; got.push(dec.decode(value, { stream: true })); } } catch { /* aborted */ } })();
    for (let t0 = realNow(); !got.join('').includes('event: hello') && realNow() - t0 < 3000;) await new Promise(r => setTimeout(r, 10));
    const sig = S.tailEngine.signals({ limit: 5 })[0];
    S.liveListeners.forEach(fn => fn('tail', [sig]));
    S.liveListeners.forEach(fn => fn('whale', [{ exchange: 'kalshi', id: 'k', notional: 9000, at: iso(Date.now()) }]));
    S.liveListeners.forEach(fn => fn('xarb', S.xarbState.arbs.slice(0, 1)));
    // +EV board rows: a Kalshi book is withheld, a sportsbook isn't
    S.evListeners.forEach(fn => fn([{ book: 'kalshi', ev: 5, event: 'A @ B' }, { book: 'draftkings', ev: 4, event: 'A @ B' }, { book: 'polymarket', ev: 6, event: 'A @ B' }]));
    await new Promise(r => setTimeout(r, 50));
    ac.abort();
    await pump;
    const text = got.join('');
    assert.doesNotMatch(text, /event: (tail|whale|xarb)/, 'nothing from either source');
    const ev = JSON.parse(/event: ev\ndata: (.*)\n/.exec(text)[1]);
    assert.deepEqual(ev.map(r => r.book), ['draftkings'], 'no Kalshi book, and never a Polymarket book in US mode');
  } finally {
    ac.abort();
    grantBoth();
  }
  // the webhook follows the public licences: nothing of a withheld source is posted
  process.env.POLYMARKET_DISPLAY_OK = 'off';
  try {
    posts.length = 0;
    fx.trades = [trade({ size: 15000, price: 0.40, tx: '0xtxgate', agoMs: 5e3, asset: '7125001', cond: '0xgate', title: 'Will Lee win the Iowa Senate election?', slug: 'iowa-senate-lee', eventSlug: 'iowa-senate-2026' })];
    fx.markets = [gammaMarket({ cond: '0xgate', asset: '7125001', id: '501999', question: 'Will Lee win the Iowa Senate election?', slug: 'iowa-senate-lee', eventSlug: 'iowa-senate-2026' })];
    tick(6e3);
    const out = await S.runTailJob('signals', S.pollTail);
    assert.equal(out.length, 1, 'the signal still fires (the admin sees it)');
    assert.deepEqual(posts, [], 'but no Polymarket wallet goes to the webhook');
  } finally { grantBoth(); }

  // licenceFor: PAYWALL off shows everything whatever the flags; the admin always sees everything
  process.env.POLYMARKET_DISPLAY_OK = 'off';
  process.env.KALSHI_DISPLAY_OK = 'off';
  try {
    assert.deepEqual(S.licenceFor({ paywall: false, admin: false }), { polymarket: true, kalshi: true });
    assert.deepEqual(S.licenceFor({ paywall: true, admin: true }), { polymarket: true, kalshi: true });
    assert.deepEqual(S.licenceFor({ paywall: true, admin: false }), { polymarket: false, kalshi: false });
    process.env.KALSHI_DISPLAY_OK = '1';
    assert.deepEqual(S.licenceFor({ paywall: true, admin: false }), { polymarket: false, kalshi: true });
  } finally { grantBoth(); }
});

test('licence gates with PAYWALL off (the owner on his own): everything shows to anyone, flags off or not', () => {
  // a second server process: PAYWALL is read once at startup
  const root = path.join(__dirname, '..');
  const script = `
    const axios = require('axios');
    axios.get = async url => { throw new Error('offline: ' + url); };
    axios.post = async () => ({ status: 204 });
    const S = require(${JSON.stringify(path.join(root, 'server.js'))});
    const whales = require(${JSON.stringify(path.join(root, 'whales.js'))});
    for (const t of require('node-cron').getTasks().values()) t.stop();
    S.whaleWatcher.ingestKalshi(whales.parseKalshiTrades({ trades: [{ trade_id: 'k1', ticker: 'KXFED-26DEC-H0', count_fp: '20000.00', yes_price_dollars: '0.4000', no_price_dollars: '0.6000', taker_side: 'yes', created_time: new Date(Date.now() - 5000).toISOString() }] }));
    S.xarbState.arbs = [{ id: 'multi:kalshi:a+b', type: 'multi', title: 'Fed', profitPct: 2, legs: [{ venue: 'kalshi', pick: 'A', price: 0.4 }, { venue: 'kalshi', pick: 'B', price: 0.5 }], stakes: { bankroll: 100, legs: [] } }];
    const srv = S.app.listen(0, '127.0.0.1', async () => {
      const u = 'http://127.0.0.1:' + srv.address().port;
      const j = async p => (await fetch(u + p)).json();
      const out = { settings: await j('/api/tail/settings'), whales: await j('/api/whales'), xarbs: await j('/api/xarbs'), traders: await j('/api/tail/traders'), status: await j('/api/status') };
      process.stdout.write('\\n@@' + JSON.stringify(out) + '\\n');
      process.exit(0);
    });`;
  const env = { ...process.env, PAYWALL: 'off', POLYMARKET_DISPLAY_OK: 'off', KALSHI_DISPLAY_OK: 'off', TRACKER_FILE: path.join(DIR, 'b-picks.json'), USERS_FILE: path.join(DIR, 'b-users.json'),
    EV_TRACK_FILE: path.join(DIR, 'b-ev.json'), TAIL_TRACK_FILE: path.join(DIR, 'b-tail.json'), TAIL_TRADERS_FILE: path.join(DIR, 'b-traders.json'), ALERT_WEBHOOK_URL: '' };
  const raw = execFileSync(process.execPath, ['-e', script], { env, cwd: root, timeout: 30000, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
  const out = JSON.parse(raw.split('\n').find(l => l.startsWith('@@')).slice(2));
  assert.deepEqual(out.settings.licence, { paywall: false, polymarketDisplayOk: false, kalshiDisplayOk: false, polymarket: 'shown', kalshi: 'shown', viewer: { polymarket: true, kalshi: true }, note: null });
  assert.equal(out.whales.pro, true, 'no paywall: everyone gets everything');
  assert.equal(out.whales.events.length, 1);
  assert.equal(out.whales.events[0].exchange, 'kalshi');
  assert.equal(out.whales.withheld, undefined);
  assert.equal(out.xarbs.count, 1);
  assert.equal(out.xarbs.arbs[0].legs.length, 2, 'the legs, not just the count');
  assert.equal(out.traders.withheld, undefined);
  assert.equal(out.status.licence.paywall, false);
});

test('polite http: one request per gap per host, identical GETs share a response, failures are not kept', async () => {
  let t = 1000;
  const slept = [], hits = [];
  let fail = false;
  const http = S.createPoliteHttp(async (url, cfg) => {
    hits.push(url);
    if (fail) throw new Error('boom');
    return { data: { url, params: cfg.params } };
  }, { gapMs: 1000, shareMs: 5000, now: () => t, sleep: async ms => { slept.push(ms); } });
  const [a1, a2, b1, a3] = await Promise.all([
    http.get('https://a.example/x', { params: { p: 1, q: 2 } }),
    http.get('https://a.example/y'),
    http.get('https://b.example/z'),
    http.get('https://a.example/x', { params: { q: 2, p: 1 } }),   // same request, keys in another order
  ]);
  assert.deepEqual(slept, [1000], 'the second request to a.example waits one gap; b.example does not');
  assert.equal(a1, a3, 'shared');
  assert.equal(a2.data.url, 'https://a.example/y');
  assert.equal(b1.data.url, 'https://b.example/z');
  assert.equal(hits.length, 3);
  assert.deepEqual(http.stats().byHost, { 'a.example': 2, 'b.example': 1 });
  assert.equal(http.stats().shared, 1);

  t += 6000;   // past the share window and the queue
  await http.get('https://a.example/x', { params: { p: 1, q: 2 } });
  assert.equal(hits.length, 4, 'an old response is not reused');
  assert.deepEqual(slept, [1000]);

  fail = true;
  t += 6000;
  await assert.rejects(http.get('https://c.example/'), /boom/);
  fail = false;
  t += 1000;
  assert.equal((await http.get('https://c.example/')).data.url, 'https://c.example/');
  assert.equal(http.stats().failed, 1);

  // a gap per host: Polymarket's data API a quarter second, anyone else a second
  const slept2 = [];
  const fast = S.createPoliteHttp(async url => ({ data: url }), {
    gapMs: host => (host === 'data-api.polymarket.com' ? 250 : 1000), now: () => t, sleep: async ms => { slept2.push(ms); },
  });
  await Promise.all([1, 2, 3].map(i => fast.get(`https://data-api.polymarket.com/v2/trades?n=${i}`)).concat([1, 2].map(i => fast.get(`https://x.example/${i}`))));
  assert.deepEqual(slept2.sort((a, b) => a - b), [250, 500, 1000]);
  assert.deepEqual(fast.stats().gapMs, { 'data-api.polymarket.com': 250, 'x.example': 1000 });
  // a 429: the host's queue backs off (Retry-After, else 2s) and the request goes once more at its end
  const slept3 = [], tries = {};
  const busy = S.createPoliteHttp(async url => {
    tries[url] = (tries[url] || 0) + 1;
    if (url.endsWith('/ra') && tries[url] === 1) throw Object.assign(new Error('429'), { response: { status: 429, headers: { 'retry-after': '5' } } });
    if (url.endsWith('/slow') || (url.endsWith('/once') && tries[url] === 1)) throw Object.assign(new Error('429'), { response: { status: 429, headers: {} } });
    return { data: url };
  }, { gapMs: 250, now: () => t, sleep: async ms => { slept3.push(ms); } });
  assert.equal((await busy.get('https://api.elections.kalshi.com/once')).data, 'https://api.elections.kalshi.com/once');
  assert.deepEqual(slept3, [2000]);
  t += 3000;
  assert.equal((await busy.get('https://api.elections.kalshi.com/ra')).data, 'https://api.elections.kalshi.com/ra');
  assert.deepEqual(slept3, [2000, 5000], 'Retry-After: 5');
  t += 6000;
  await assert.rejects(busy.get('https://api.elections.kalshi.com/slow'), /429/, 'one more try, not a loop');
  assert.equal(tries['https://api.elections.kalshi.com/slow'], 2);
  assert.deepEqual([busy.stats().retried429, busy.stats().failed], [3, 1]);

  // 429s in a row double the pause, and a request already queued waits it out too
  const slept4 = [];
  const shared = S.createPoliteHttp(async url => {
    if (url.endsWith('/x')) throw Object.assign(new Error('429'), { response: { status: 429, headers: {} } });
    return { data: url };
  }, { gapMs: 250, now: () => t, sleep: async ms => { slept4.push(ms); } });
  await assert.rejects(shared.get('https://api.elections.kalshi.com/x'), /429/);
  assert.equal((await shared.get('https://api.elections.kalshi.com/y')).data, 'https://api.elections.kalshi.com/y');
  assert.deepEqual(slept4, [2000, 2250, 4000], '2s, then queued behind it, then the doubled 4s pause');
});

test('US mode strips polymarket.com links however deep, and nothing else', () => {
  const x = S.stripPolymarketLinks({ url: 'https://polymarket.com/event/a', a: [{ link: 'https://www.polymarket.com/profile/0x1' }], k: 'https://kalshi.com/markets/x',
    api: 'https://data-api.polymarket.com/v2/trades', text: 'see https://polymarket.com', n: 3, nil: null });
  assert.deepEqual(x, { url: null, a: [{ link: null }], k: 'https://kalshi.com/markets/x', api: 'https://data-api.polymarket.com/v2/trades', text: 'see https://polymarket.com', n: 3, nil: null });
  assert.equal(S.TAIL_REGION, 'us');
});

test('the bundled app: SHARP TAIL tab, venue line, no bankroll or dollar sizing, the footer, and its scripts parse', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.match(html, /showTab\('tail',this\)">🐋 SHARP TAIL</);
  assert.match(html, /id="page-tail"/);
  for (const v of ['signals', 'board', 'traders', 'whales', 'arbs', 'record']) assert.ok(html.includes(`['${v}', `), v);
  assert.match(html, /\/api\/tail\/board\?limit=100/);
  assert.match(html, /addEventListener\(type, m => \{ try \{ tailOnLive\(type/);
  assert.match(html, /localStorage\.setItem\('lr_tail'/);
  // the same sizing for everyone: no bankroll input, no units turned into dollars, no ?bankroll= re-split
  const tab = html.slice(html.indexOf('<div class="page" id="page-tail">'), html.indexOf('<!-- ESPORTS PAGE -->'));
  assert.ok(tab.length > 500);
  assert.doesNotMatch(tab, /tailBankroll|tailArbStake|BANKROLL \$/);
  assert.doesNotMatch(html, /tailDollarsOfUnits|tailState\.bankroll|tailState\.arbStake|\/api\/xarbs\?bankroll|'\?bankroll='/);
  assert.match(tab, /Information only, not a sportsbook\. Same alert for everyone\. 21\+\. Gambling problem\? Call 1-800-GAMBLER\./);
  // where to tail, and the US-mode link rule
  assert.match(html, /Tail at \$\{v\.name\}\$\{v\.buy \? `: \$\{v\.buy\}` : ''\} \$\{tailVenuePrice\(v\)\} · \$\{v\.units\}u · don't pay above \$\{max\}/);
  assert.match(html, /No US venue found yet: watch only/);
  assert.match(html, /tailUS\(\) && TAIL_PM_LINK\.test\(u\)/);
  assert.match(html, /x\.locked \|\| tailUS\(\) \|\|/, 'no Polymarket profile links in US mode');
  assert.match(html, /waiting on data permission/);
  // desktop alerts for live sized entries, their own switch
  assert.match(html, /onclick="tailToggleNotify\(\)"/);
  assert.match(html, /if \(tailNotifyOn\(\)\) for \(const s of sized\.slice\(0, 3\)\)/);
  const blocks = [...html.matchAll(/<script(\b[^>]*)>([\s\S]*?)<\/script>/g)].filter(m => !/src=/.test(m[1]));
  assert.ok(blocks.length >= 1);
  for (const [, , code] of blocks) assert.doesNotThrow(() => new Function(code));
});

test('the live feed: a trade the socket pushes is a signal at once, logged and broadcast like a polled one', async () => {
  const LIVE = '0xc0ffee0000000000000000000000000000000000000000000000000000000077';
  fx.markets = [gammaMarket({ id: '507777', cond: LIVE, asset: '7777001' })];
  const pushed = () => tail.parseTrades([trade({ size: 15000, price: 0.4, tx: '0xlive', agoMs: 3e3, asset: '7777001', cond: LIVE })]);
  const heard = [];
  const fn = (type, data) => { if (type === 'tail') heard.push(...data); };
  S.liveListeners.add(fn);
  try {
    const out = await S.streamTail(pushed());
    assert.deepEqual(out.map(s => [s.wallet, s.via, s.type]), [[W1, 'stream', 'entry']]);
    assert.ok(out[0].lagMs >= 3e3 && out[0].lagMs < 30e3, String(out[0].lagMs));
    assert.deepEqual(heard.map(s => s.id), [out[0].id], 'broadcast');
    assert.ok((await S.tailTracker.list()).some(r => r.id === out[0].id), 'in the track record');
    assert.deepEqual(await S.streamTail(pushed()), [], 'the same trade again: once');
  } finally { S.liveListeners.delete(fn); }
  const { body } = await get('/api/status');
  assert.equal(body.tail.stream.running, false, 'the socket only opens when the server is started for real');
  assert.equal(body.tail.stream.connects, 0);
  assert.ok(body.tail.lastStreamAt);
});

test('the Sharp Board: Pro sees the wallets on each side, free the top rows with wallets masked', async () => {
  const pro = (await get('/api/tail/board', PRO)).body;
  const row = pro.rows.find(r => r.title === 'Will Smith win the Ohio Senate election?' && r.lead.list.some(w => w.wallet === W1) && r.lead.cost >= 6000);
  assert.ok(row, 'the A wallet\'s live $6,000 buy is a position on the board');
  assert.equal(row.lead.outcome, 'Yes');
  assert.equal(row.lead.A, 1);
  assert.ok(Array.isArray(row.venues));
  assert.equal(pro.pro, true);
  assert.equal(pro.locked, 0);
  const free = (await get('/api/tail/board')).body;
  assert.ok(free.rows.length <= 3);
  assert.equal(free.locked, Math.max(0, pro.rows.length - 3));
  for (const r of free.rows) {
    assert.equal(r.locked, true);
    assert.equal(r.conditionId, null);
    for (const w of r.lead.list) { assert.match(w.wallet, /^0x1a••••$/); assert.equal(w.cost, null); }
  }
  assert.deepEqual((await get('/api/tail/board?category=crypto', PRO)).body.rows, []);
  assert.ok((await get('/api/tail/board?category=sports', PRO)).body.rows.every(r => r.category === 'sports'));
  // the traders list doesn't carry every graded wallet's whole book
  const tr = (await get('/api/tail/traders', PRO)).body.traders.find(t => t.wallet === W1);
  assert.equal(tr.holdings, undefined);
});

test('the webhook: a sized B entry pings too; an unsized one does not', async () => {
  const base = S.tailEngine.signals({ type: 'entry' })[0];
  assert.ok(base);
  const real = S.tailEngine.ingest;
  let next = [];
  S.tailEngine.ingest = async () => next;
  try {
    posts.length = 0;
    next = [{ ...base, id: 'b-sized', grade: 'B', units: 0.8, target: 0.8, parentId: null, topUp: false, isConsensus: false, venue: null, venues: [] }];
    await S.streamTail([]);
    assert.equal(posts.length, 1);
    assert.match(posts[0].body.content, /B-grade/);
    posts.length = 0;
    next = [{ ...base, id: 'b-zero', grade: 'B', units: 0, target: 0, parentId: null, topUp: false, isConsensus: false, venue: null, venues: [] }];
    await S.streamTail([]);
    assert.equal(posts.length, 0, '0u: on the feed, not pinged');
  } finally { S.tailEngine.ingest = real; }
});

test('second chances on the live board: priced from the book, broadcast and pinged once', async () => {
  const realBook = S.tailEngine.book;
  let ask = 0.99;
  S.tailEngine.book = async () => ({ ask });
  const heard = [];
  const fn = (type, data) => { if (type === 'board') heard.push(...data); };
  S.liveListeners.add(fn);
  try {
    assert.deepEqual(await S.watchBoard(), [], 'nothing is under its entry at 99¢');
    const board = (await get('/api/tail/board', PRO)).body.rows;
    assert.ok(board.length && board.every(r => r.lead.price === 0.99 && r.lead.priceSource === 'book'), 'the board shows the book price too');
    posts.length = 0;
    ask = 0.39;
    const out = await S.watchBoard();
    const live = out.find(a => a.title === 'Will Smith win the Ohio Senate election?' && a.avgEntry === 0.4);
    assert.ok(live, 'W1 holds Yes at 40¢; it is 39¢ now');
    assert.equal(live.price, 0.39);
    assert.ok(Array.isArray(live.venues));
    assert.ok(heard.some(a => a.id === live.id), 'broadcast');
    assert.ok(posts.some(p => /🎯 Second chance: 1 sharp \(1A\) hold Yes on "Will Smith win the Ohio Senate election\?" at 40¢ avg; it's 39¢ now/.test(p.body.content)));
    assert.deepEqual(await S.watchBoard(), [], 'still under: no repeat');
  } finally { S.tailEngine.book = realBook; S.liveListeners.delete(fn); }
});

test('fresh wallets: a new wallet\'s whale buy is tagged, logged at 1u in its own record and pinged once', async () => {
  const W8 = '0x8888888888888888888888888888888888888888';
  const buy = trade({ wallet: W8, size: 30000, price: 0.2, tx: '0xtx80', name: 'New-Deer', agoMs: 15e3, asset: TEXAS.asset, cond: TEXAS.cond,
    title: TEXAS.title, slug: TEXAS.slug, eventSlug: TEXAS.eventSlug });
  fx.history = { [W8]: [buy] };
  fx.trades = [buy];
  fx.markets = [texasMarket()];
  fx.kalshiTrades = [];
  posts.length = 0;
  tick(6e3);
  await S.runTailJob('whales', S.pollWhales);

  const pro = await get('/api/whales?fresh=1', PRO);
  assert.equal(pro.body.events.length, 1);
  const [e] = pro.body.events;
  assert.equal(e.wallet, W8);
  assert.equal(e.tag, 'fresh wallet');
  assert.deepEqual({ markets: e.fresh.markets, trades: e.fresh.trades, ageDays: e.fresh.ageDays }, { markets: 1, trades: 1, ageDays: 0 });
  assert.ok(calls.some(c => c.url.endsWith('/v2/trades') && c.params.user === W8 && c.params.taker_only === false), 'its history was read');
  assert.ok((await get('/api/whales?fresh=0', PRO)).body.events.every(x => !x.fresh));
  assert.equal(pro.body.state.lastHour.fresh, 1);

  // its own record: 1u at what a follower could pay (Gamma's 41¢ ask here), not in Sharp Tail's
  const rec = await get('/api/tail/record?book=fresh&status=open', PRO);
  assert.equal(rec.body.book, 'fresh');
  assert.equal(rec.body.open, 1);
  const [r] = rec.body.signals;
  assert.deepEqual([r.id, r.grade, r.units, r.entry, r.theirPrice, r.category], ['fresh:' + e.id, 'fresh', 1, 0.41, 0.2, 'politics']);
  assert.ok(!(await get('/api/tail/record?status=open', PRO)).body.signals.some(x => x.id.startsWith('fresh:')));
  const ping = posts.find(p => /🆕 Fresh wallet/.test(p.body.content));
  assert.ok(ping, 'pinged');
  assert.match(ping.body.content, /🆕 Fresh wallet \(first trade today, 1 market\) bought Yes on "Will Jones win the Texas Senate election\?" at 20¢ \(\$6,000\) · No US venue found yet: watch only/);
  assert.ok(!/polymarket\.com/.test(ping.body.content), 'US mode');

  // the next poll re-reads it: no second ping, no second record
  posts.length = 0;
  tick(31e3);
  await S.runTailJob('whales', S.pollWhales);
  assert.equal(posts.filter(p => /Fresh wallet/.test(p.body.content)).length, 0);
  assert.equal((await get('/api/tail/record?book=fresh&status=open', PRO)).body.open, 1);

  // free: the tag waits 30 minutes like a grade; the radar's totals are public
  const free = await get('/api/whales');
  const masked = free.body.events.find(x => x.exchange === 'polymarket' && x.title === TEXAS.title);
  assert.equal(masked.fresh, null);
  assert.equal(masked.tag, 'whale');
  hasNoIdentity(free.body, W8, 'New-Deer');
  assert.equal((await get('/api/whales?fresh=1')).body.events.some(x => x.fresh), false, 'the filter is Pro only');
  assert.equal(free.body.freshRecord.open, 1);

  // settled: graded like any tail
  fx.markets = [texasMarket({ closed: true, prices: ['1', '0'], bestAsk: null, bestBid: null })];
  tick(11 * 60e3);
  await S.freshTracker.check();
  const done = await get('/api/tail/record?book=fresh');
  assert.equal(done.body.overall.wins, 1);
  assert.ok(done.body.overall.units > 1.4, `1u at 41¢ wins about 1.44u (${done.body.overall.units})`);
});

test('fresh wallets: not followable when the game has started, the price is near-certain or the market is closed', async () => {
  const base = { id: 'polymarket|0xfx', exchange: 'polymarket', wallet: '0x77', side: 'BUY', outcome: 'Yes', outcomeIndex: 0, price: 0.3, notional: 9000,
    at: iso(Date.now() - 10e3), title: TEXAS.title, conditionId: COND2, asset: TEXAS.asset, fresh: { markets: 1, trades: 1, ageDays: 0.5 } };
  // each market read past the shared-response window
  const read = async (markets, e) => { fx.markets = markets; tick(6e3); return S.freshSignal({ ...base, at: iso(Date.now() - 10e3), ...e }); };
  assert.equal(await read([texasMarket({ closed: true, prices: ['1', '0'] })]), null, 'closed');
  assert.equal(await read([texasMarket()], { price: 0.96 }), null, 'near-certain');
  assert.equal(await read([{ ...texasMarket(), gameStartTime: iso(Date.now() + 6e3 - 3600e3) }]), null, 'bought after the start');
  const ok = await read([texasMarket()]);
  assert.equal(ok.units, 1);
  assert.match(S.describeFresh({ ...base, fresh: { markets: 2, ageDays: 3.5 } }), /first trade 3\.5 days ago, 2 markets/);
});

test('the webhook: an exit pings only when we tailed it and most of it went, naming where followers bet', async () => {
  const entry = S.tailEngine.signals({ type: 'entry' })[0];
  assert.ok(entry);
  // the entry was sent to Kalshi: that's where followers sell
  const routed = S.routeSignal({ ...entry, id: 'exit-test-entry', venue: undefined, venues: undefined }, {
    index: { byCondition: new Map(), byToken: new Map(), games: [] } });
  assert.equal(routed.venue, null, 'no venue in an empty index');
  const real = S.tailEngine.ingest;
  let next = [];
  S.tailEngine.ingest = async () => next;
  const exit = o => ({ ...entry, id: `exit-${o.tag}`, type: 'exit', units: undefined, venue: undefined, venues: undefined, parentId: null, blocked: null,
    theirPrice: 0.62, theirNotional: 4000, boughtAt: 0.41, ...o });
  try {
    posts.length = 0;
    next = [exit({ tag: 'untailed', soldShare: 1, full: true, tailed: null })];
    await S.streamTail([]);
    assert.equal(posts.length, 0, 'nobody followed it: on the feed, not pinged');
    next = [exit({ tag: 'trim', soldShare: 0.2, full: false, tailed: { id: 'exit-test-entry', units: 1.2 } })];
    await S.streamTail([]);
    assert.equal(posts.length, 0, 'a trim');
    next = [exit({ tag: 'out', soldShare: 0.8, full: true, tailed: { id: 'exit-test-entry', units: 1.2 } })];
    await S.streamTail([]);
    assert.equal(posts.length, 1);
    assert.match(posts[0].body.content, /^🚪 Exit: A-grade ElectionEdge sold 80% of Yes on ".+" at 62¢ \(\$4,000\), bought at 41¢ · we tailed it 1\.2u$/);
  } finally { S.tailEngine.ingest = real; }

  // free users get the exit coarsened
  const m = S.maskSignal(exit({ tag: 'mask', soldShare: 0.8182, full: true, boughtAt: 0.4137, tailed: { id: 'exit-test-entry', units: 1.2 } }));
  assert.deepEqual([m.soldShare, m.boughtAt, m.tailed.units], [0.8, 0.41, 1.2]);
  assert.match(m.tailed.id, /^x[0-9a-f]{12}$/);
});

test('where to tail: Polymarket US, the same game market, when it gives the most units', async () => {
  const usd = v => ({ value: v, currency: 'USD' });
  fx.pmus = {
    event: { event: { slug: 'nba-nyk-bos-2026-10-10', title: 'Knicks vs. Celtics', markets: [{
      slug: 'aec-nba-nyk-bos-2026-10-10', question: 'Who will win Knicks vs Celtics?', sportsMarketType: 'basketball_team_full_game_winner', active: true, closed: false,
      status: 'MARKET_STATUS_OPEN', bestBidQuote: usd('0.5300'), bestAskQuote: usd('0.5400'),
      marketSides: [{ description: 'Celtics', long: true, team: { name: 'Boston Celtics', abbreviation: 'bos', ordering: 'home' } },
        { description: 'Knicks', long: false, team: { name: 'New York Knicks', abbreviation: 'nyk', ordering: 'away' } }] }] } },
    book: { marketData: { bids: [{ px: usd('0.5400'), qty: '5000' }], offers: [{ px: usd('0.5500'), qty: '4000' }], state: 'MARKET_STATE_OPEN' } },
  };
  const base = S.tailEngine.signals({ type: 'entry' }).find(x => x.category === 'sports') || S.tailEngine.signals({ type: 'entry' })[0];
  const s = { ...base, id: 'pmus-test', eventSlug: 'nba-nyk-bos-2026-10-10', market: 'Knicks vs. Celtics', outcome: 'Celtics', outcomeIndex: 1,
    outcomes: ['Knicks', 'Celtics'], sportsMarketType: 'moneyline', conditionId: '0xnone', asset: 'none', blocked: null, priorUnits: 0, eventRoom: undefined,
    venue: undefined, venues: undefined, q: 0.66 };
  tick(6e3);
  const units = await S.routeTail(s);
  const us = s.venues.find(v => v.key === 'polymarketus');
  assert.ok(us, 'quoted');
  assert.deepEqual([us.name, us.price, us.buy, us.url], ['Polymarket US', 0.55, 'Boston Celtics', 'https://polymarket.us/sports/nba/nba-nyk-bos-2026-10-10']);
  assert.ok(Math.abs(us.fee - 0.0695 * 0.55 * 0.45) < 1e-6);
  const z = tail.sizeAt({ q: s.q, price: us.price, feePerContract: us.fee, grade: s.grade, consensus: s.consensus, opts: S.tailEngine.settings() });
  assert.equal(us.units, z.units, 'sized at its own price and fee');
  assert.equal(s.venue.key, 'polymarketus');
  assert.equal(units, s.venue.units);
  assert.match(S.venueLine(s), /^Tail at Polymarket US: Boston Celtics 55¢ · \d+(\.\d+)?u · don't pay above \d+¢$/);
  noPolymarketLinks(s.venues, 'a Polymarket US venue');

  // a blocked buy isn't looked up; POLYMARKET_US=off would skip it all
  const before = calls.filter(c => c.url.includes('gateway.polymarket.us')).length;
  await S.routeTail({ ...s, id: 'pmus-blocked', blocked: 'in-play', venue: undefined, venues: undefined });
  assert.equal(calls.filter(c => c.url.includes('gateway.polymarket.us')).length, before);
  const st = (await get('/api/status', PRO)).body.tail;
  assert.ok(st.polymarketUs.quoted >= 1);
  assert.ok(st.routing.byVenue.polymarketus >= 1);
  fx.pmus = null;
});
