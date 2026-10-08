// Boots server.js with axios stubbed (no network): the Sharp Tail crons'
// work, every /api/tail, /api/whales and /api/xarbs endpoint, the free-user
// masking, the live stream events and the webhook posts.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lr-tail-server-'));
const ADMIN_TOKEN = 'test-admin-token';
const WEBHOOK = 'https://discord.example/api/webhooks/1/test';
Object.assign(process.env, {
  PAYWALL: 'on', AUTH_SECRET: 'test-secret', TRACKER_ADMIN_TOKEN: ADMIN_TOKEN, ALERT_WEBHOOK_URL: WEBHOOK, UPSTREAM_GAP_MS: '0',
  TRACKER_FILE: path.join(DIR, 'picks.json'), USERS_FILE: path.join(DIR, 'users.json'), EV_TRACK_FILE: path.join(DIR, 'ev.json'),
  TAIL_TRACK_FILE: path.join(DIR, 'tail-signals.json'), TAIL_TRADERS_FILE: path.join(DIR, 'tail-traders.json'),
});
for (const k of ['DATABASE_URL', 'TAIL_WEBHOOK', 'ODDS_API_KEY', 'OWLS_API_KEY', 'WHALE_MIN_USD', 'XARB_MIN_PCT', 'XARB_ALERT_MIN']) delete process.env[k];
for (const k of Object.keys(process.env)) if (/^TAIL_(?!TRACK_FILE|TRADERS_FILE)/.test(k)) delete process.env[k];

// A clock the test can move forward: everything in the server reads Date.now.
const realNow = Date.now;
let skew = 0;
Date.now = () => realNow() + skew;
const tick = ms => { skew += ms; };
const DAY = 86400e3;
const iso = ms => new Date(ms).toISOString();

// ── fake upstream ──
const W1 = '0x1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b';   // the A-grade politics wallet
const W9 = '0x9999999999999999999999999999999999999999';   // an unknown whale
const COND = '0xc0ffee0000000000000000000000000000000000000000000000000000000001';
const COND2 = '0xc0ffee0000000000000000000000000000000000000000000000000000000002';   // a second market W1 bets
const TEXAS = { asset: '7124001', cond: COND2, title: 'Will Jones win the Texas Senate election?', slug: 'texas-senate-jones', eventSlug: 'texas-senate-2026' };
const fx = { closed: [], trades: [], markets: [], kalshiEvents: [], kalshiTrades: [] };
const calls = [], posts = [];

// 120 resolved politics bets at 50¢, 80 won, each its own race: ROI 33%, z 3.65
function eliteHistory(wallet, now) {
  return Array.from({ length: 120 }, (_, i) => {
    const won = i % 3 !== 0, at = now - (i % 100) * DAY - 3600e3, cond = `0xcond${i}`;
    return {
      proxyWallet: wallet, asset: `${cond}-yes`, conditionId: cond, avgPrice: '0.5', totalBought: 2000,
      realizedPnl: won ? 1000 : -1000, curPrice: won ? 1 : 0, title: `Will candidate ${i} win the ${['Ohio', 'Texas', 'Iowa', 'Maine'][i % 4]} Senate election?`,
      slug: `senate-race-${i}-m${i}`, eventSlug: `senate-race-${i}`, outcome: 'Yes', outcomeIndex: 0,
      endDate: iso(at), timestamp: Math.floor(at / 1000),
    };
  });
}
function trade({ wallet = W1, side = 'BUY', size, price, tx, agoMs = 60e3, name = 'ElectionEdge', asset = '7123001', cond = COND,
  title = 'Will Smith win the Ohio Senate election?', slug = 'ohio-senate-smith', eventSlug = 'ohio-senate-2026' }) {
  return {
    proxyWallet: wallet, side, asset, conditionId: cond, size: String(size), price: String(price),
    timestamp: Math.floor((Date.now() - agoMs) / 1000), title, slug,
    eventSlug, outcome: 'Yes', outcomeIndex: 0, name, pseudonym: 'Brisk-Owl', transactionHash: tx,
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
  'https://data-api.polymarket.com/v1/leaderboard': p => (p.category === 'OVERALL' && p.timePeriod === 'ALL'
    ? [{ rank: '1', proxyWallet: W1, userName: 'ElectionEdge', vol: 1200000, pnl: 40000, verifiedBadge: false }] : []),
  'https://data-api.polymarket.com/closed-positions': p => (p.user === W1 && !p.offset ? fx.closed : []),
  'https://data-api.polymarket.com/positions': () => [],
  'https://data-api.polymarket.com/trades': p => (p.user ? [] : fx.trades),
  'https://gamma-api.polymarket.com/markets': p => fx.markets.filter(m => m.conditionId === p.condition_ids),
  'https://gamma-api.polymarket.com/events': () => [],
  'https://api.elections.kalshi.com/trade-api/v2/events': () => ({ events: fx.kalshiEvents, cursor: '' }),
  'https://api.elections.kalshi.com/trade-api/v2/markets/trades': () => ({ trades: fx.kalshiTrades, cursor: '' }),
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
const hasNoIdentity = (body, ...secrets) => { const text = JSON.stringify(body); for (const s of secrets) assert.ok(!text.includes(s), `leaks ${s}`); };

test('settings: the active thresholds, public', async () => {
  const { status, body } = await get('/api/tail/settings');
  assert.equal(status, 200);
  assert.equal(body.tail.minTrade, 500);
  assert.equal(body.tail.grades.A.minZ, 3);
  assert.equal(body.tail.grades.B.minN, 50);
  assert.equal(body.whales.minUsd, 5000);
  assert.equal(body.xarb.minPct, 0.5);
  assert.equal(body.xarb.alertMinPct, 1);
  assert.equal(body.freeDelayMinutes, 30);
});

test('candidates from the leaderboard, then a scoring batch grades the wallet A', async () => {
  fx.closed = eliteHistory(W1, Date.now());
  const r = await S.runTailJob('candidates', () => S.tailEngine.refreshCandidates());
  assert.equal(r.total, 1);
  assert.equal(calls.filter(c => c.url.endsWith('/v1/leaderboard')).length, 32, '8 categories × 4 periods');
  const b = await S.runTailJob('score', () => S.tailEngine.scoreBatch());
  assert.deepEqual(b.wallets, [W1]);
  const tr = S.tailEngine.trader(W1);
  assert.equal(tr.grade, 'A');
  assert.equal(tr.categories.politics.grade, 'A');
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

test('exchange arb scan: the first scan primes, Pro sees legs and stakes, free sees count and profit % only', async () => {
  fx.kalshiEvents = [kalshiEvent('KXFEDCHAIR-26', 'Who will Trump nominate as Fed Chair?', [['Kevin Warsh', '0.2800'], ['Kevin Hassett', '0.2800'], ['Christopher Waller', '0.2900'], ['Someone else', '0.0400']])];
  const fresh = await S.runTailJob('xarb', S.scanXarbs);
  assert.deepEqual(fresh, [], 'a restart is not news');
  assert.equal(S.xarbState.arbs.length, 1);
  assert.equal(posts.length, 0);

  const pro = await get('/api/xarbs', PRO);
  assert.equal(pro.body.count, 1);
  const a = pro.body.arbs[0];
  assert.equal(a.type, 'multi');
  assert.equal(a.legs.length, 4);
  assert.ok(a.profitPct > 1, `profit ${a.profitPct}%`);
  assert.equal(a.exhaustive, true, '"Someone else" covers every other name');
  assert.equal(a.maxStake, null, 'no executable size claimed');
  assert.equal(a.stakes.bankroll, 100);
  assert.ok(a.warnings.length, 'carries the coverage warning');
  const big = await get('/api/xarbs?bankroll=1000', PRO);
  assert.equal(big.body.arbs[0].stakes.bankroll, 1000);
  assert.ok(big.body.arbs[0].stakes.contracts > a.stakes.contracts * 9);
  assert.equal((await get('/api/xarbs?minPct=50', PRO)).body.count, 0);

  const free = await get('/api/xarbs');
  assert.equal(free.body.count, 1);
  assert.deepEqual(free.body.arbs, [{ profitPct: a.profitPct, locked: true }]);
  assert.equal(free.body.counts, undefined);
});

test('a fresh trade by the A-grade wallet becomes a sized signal; whales see it too, from one shared read', async () => {
  fx.markets = [gammaMarket()];
  fx.trades = [
    trade({ size: 15000, price: 0.40, tx: '0xtx1' }),                                  // $6,000 by W1
    trade({ wallet: W9, size: 20000, price: 0.5, tx: '0xtx9', name: 'Quiet-Fox' }),   // $10,000 by nobody we know
  ];
  fx.kalshiTrades = [{ trade_id: 'k-1', ticker: 'KXFEDCHAIR-26-KEV0', count: 20000, yes_price_dollars: '0.3000', no_price_dollars: '0.7000', taker_side: 'yes', created_time: iso(Date.now() - 30e3) }];
  const before = S.upstream.stats();
  const [whalesOut, signals] = await Promise.all([S.runTailJob('whales', S.pollWhales), S.runTailJob('signals', S.pollTail)]);
  const after = S.upstream.stats();
  assert.equal(calls.filter(c => c.url === 'https://data-api.polymarket.com/trades' && !c.params.user).length, 1, 'the trades page was read once');
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
  assert.equal(s.url, 'https://polymarket.com/event/ohio-senate-2026');

  assert.equal(whalesOut.length, 3);
  const graded = whalesOut.find(e => e.wallet === W1);
  assert.equal(graded.tag, 'graded whale');
  assert.equal(graded.grade, 'A');
  assert.equal(whalesOut.find(e => e.wallet === W9).tag, 'unknown whale');
  const k = whalesOut.find(e => e.exchange === 'kalshi');
  assert.equal(k.notional, 6000);
  assert.match(k.title, /Fed Chair/, 'titled from the arb scan');

  // the A-grade signal went to the webhook
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, WEBHOOK);
  assert.match(posts[0].body.content, /A-grade ElectionEdge bought Yes on "Will Smith win the Ohio Senate election\?" at 40¢ \(\$6,000\) · tail 2u at 41¢/);
  assert.match(posts[0].body.content, /<https:\/\/polymarket\.com\/event\/ohio-senate-2026>/);
});

test('signals: Pro live; free only 30+ minutes late, wallets masked', async () => {
  const pro = await get('/api/tail/signals', PRO);
  assert.equal(pro.body.signals.length, 1);
  assert.equal(pro.body.signals[0].wallet, W1);
  assert.equal(pro.body.locked, 0);

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
  assert.equal(pro.body.signals[0].theirNotional, 6000, 'Pro keeps it all');
  assert.equal((await get('/api/tail/signals?type=exit', PRO)).body.signals.length, 0);
});

test('whales: Pro sees wallets and grades; free gets them masked, grades only once 30 minutes old', async () => {
  fx.kalshiTrades = [];
  fx.trades = [trade({ wallet: W9, size: 30000, price: 0.5, tx: '0xtx10', name: 'Quiet-Fox', agoMs: 20e3 })];
  tick(6e3);   // past the shared-response window
  await S.runTailJob('whales', S.pollWhales);
  const pro = await get('/api/whales', PRO);
  assert.ok(pro.body.events.length >= 4);
  assert.ok(pro.body.events.some(e => e.wallet === W1 && e.grade === 'A'));
  assert.ok(pro.body.flow.length >= 1);
  assert.equal(pro.body.minUsd, 5000);
  assert.equal((await get('/api/whales?exchange=kalshi', PRO)).body.events.length, 1);
  assert.ok((await get('/api/whales?graded=1', PRO)).body.events.every(e => e.graded));

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

test('status reports tail, whales, exchange arbs and the upstream queue', async () => {
  const { body } = await get('/api/status');
  assert.equal(body.version, '3.20.0');
  assert.equal(body.tail.scored, 1);
  assert.equal(body.tail.graded.A, 1);
  assert.ok(body.tail.jobs.signals.lastRun);
  assert.equal(body.tail.jobs.signals.failed, false);
  assert.equal(body.tail.record.open, 0);
  assert.ok(body.whales.events >= 5);
  assert.equal(body.xarb.arbs, 3);
  assert.equal(body.xarb.counts.kalshiEvents, 3);
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
  assert.equal(require('../package.json').version, '3.20.0');
  assert.equal((await get('/')).body.version, '3.20.0');
});

test('exchange arbs: an exchange down at startup primes on its first good scan; its standing arbs are not news', async () => {
  const route = ROUTES['https://gamma-api.polymarket.com/events'];
  const pmEvent = (id, title, names) => ({
    id, slug: `pm-${id}`, title, negRisk: true, endDate: iso(Date.now() + 60 * DAY), tags: [{ label: 'Politics' }],
    markets: names.map(([n, ask], i) => ({ id: `${id}${i}`, question: `Will ${n} win?`, groupItemTitle: n, outcomes: '["Yes","No"]',
      bestAsk: ask, bestBid: ask - 0.01, active: true, closed: false, negRisk: true, endDate: iso(Date.now() + 60 * DAY) })),
  });
  const standing = pmEvent('881', 'Next Mayor of Springfield', [['Alice Moe', 0.4], ['Bart Barney', 0.4], ['Other', 0.1]]);
  ROUTES['https://gamma-api.polymarket.com/events'] = () => [standing];
  tick(6e3);
  posts.length = 0;
  try {
    const first = await S.runTailJob('xarb', S.scanXarbs);
    assert.ok(S.xarbState.arbs.some(a => a.title === 'Next Mayor of Springfield'), 'listed');
    assert.deepEqual(first, [], "Polymarket's first scan with data: what's standing is not news");
    assert.equal(posts.length, 0);
    const added = pmEvent('882', 'Next Governor of Shelbyville', [['Carl Lenny', 0.45], ['Field', 0.45]]);
    ROUTES['https://gamma-api.polymarket.com/events'] = () => [standing, added];
    tick(6e3);
    const next = await S.runTailJob('xarb', S.scanXarbs);
    assert.deepEqual(next.map(a => a.title), ['Next Governor of Shelbyville'], 'a new one after that is');
    assert.match(posts.map(p => p.body.content).join('\n'), /Shelbyville/);
  } finally { ROUTES['https://gamma-api.polymarket.com/events'] = route; }
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
});

test('the bundled app has the SHARP TAIL tab and its scripts parse', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.match(html, /showTab\('tail',this\)">🐋 SHARP TAIL</);
  assert.match(html, /id="page-tail"/);
  for (const v of ['signals', 'traders', 'whales', 'arbs', 'record']) assert.ok(html.includes(`['${v}', `), v);
  assert.match(html, /addEventListener\(type, m => \{ try \{ tailOnLive\(type/);
  assert.match(html, /localStorage\.setItem\('lr_tail'/);
  const blocks = [...html.matchAll(/<script(\b[^>]*)>([\s\S]*?)<\/script>/g)].filter(m => !/src=/.test(m[1]));
  assert.ok(blocks.length >= 1);
  for (const [, , code] of blocks) assert.doesNotThrow(() => new Function(code));
});
