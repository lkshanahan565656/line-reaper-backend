// Boots server.js with axios stubbed: the esports match board's scan, the
// exchange prices it hands the props model, its alerts, and what
// /api/esports/matches shows each viewer (Pro, free, US mode, licences).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lr-esports-server-'));
const ADMIN_TOKEN = 'test-admin-token';
const WEBHOOK = 'https://discord.example/api/webhooks/1/test';
for (const k of ['DATABASE_URL', 'TAIL_WEBHOOK', 'ODDS_API_KEY', 'OWLS_API_KEY', 'POLYMARKET_DISPLAY_OK', 'KALSHI_DISPLAY_OK', 'ESPORTS_EDGE_MIN', 'ESPORTS_ALERT_MIN']) delete process.env[k];
for (const k of Object.keys(process.env)) if (/^TAIL_/.test(k)) delete process.env[k];
Object.assign(process.env, {
  PAYWALL: 'on', AUTH_SECRET: 'test-secret', TRACKER_ADMIN_TOKEN: ADMIN_TOKEN, ALERT_WEBHOOK_URL: WEBHOOK, UPSTREAM_GAP_MS: '0',
  TRACKER_FILE: path.join(DIR, 'picks.json'), USERS_FILE: path.join(DIR, 'users.json'), EV_TRACK_FILE: path.join(DIR, 'ev.json'),
  TAIL_TRACK_FILE: path.join(DIR, 'tail-signals.json'), TAIL_TRADERS_FILE: path.join(DIR, 'tail-traders.json'), FRESH_TRACK_FILE: path.join(DIR, 'fresh-signals.json'),
  POLYMARKET_DISPLAY_OK: 'on', KALSHI_DISPLAY_OK: 'on',
});

// identical GETs within 5 s share one response: each rescan moves the clock on
const realNow = Date.now;
let skew = 0;
Date.now = () => realNow() + skew;
const tick = (ms = 10e3) => { skew += ms; };
const START = new Date(Date.now() + 6 * 3600e3);
// Kalshi tickers carry the start in US Eastern time
const et = new Date(START.toLocaleString('en-US', { timeZone: 'America/New_York' }));
const MON = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'][et.getMonth()];
const pad = n => String(n).padStart(2, '0');
const TAIL = `${String(et.getFullYear()).slice(2)}${MON}${pad(et.getDate())}${pad(et.getHours())}${pad(et.getMinutes())}G2T1`;

const fx = { t1: { bid: '0.4300', ask: '0.4500' }, g2: { bid: '0.5500', ask: '0.5700' } };
const pmEvent = () => ({
  slug: 'val-g21-t1', title: 'Valorant: G2 Esports vs T1 (BO3) - VCT Champions Playoffs', startTime: START.toISOString(), volume: 5000,
  markets: [{
    sportsMarketType: 'moneyline', outcomes: '["G2 Esports", "T1"]', bestBid: 0.55, bestAsk: 0.56, active: true, closed: false, acceptingOrders: true,
    conditionId: '0xg2t1', clobTokenIds: '["1", "2"]', feeType: 'sports_fees_v3',
  }],
});
const kalshiGame = () => ({
  event_ticker: `KXVALORANTGAME-${TAIL}`, title: 'G2 Esports vs. T1',
  markets: [
    { ticker: `KXVALORANTGAME-${TAIL}-G2`, yes_sub_title: 'G2 Esports', yes_bid_dollars: fx.g2.bid, yes_ask_dollars: fx.g2.ask, status: 'active', volume_fp: '900' },
    { ticker: `KXVALORANTGAME-${TAIL}-T1`, yes_sub_title: 'T1', yes_bid_dollars: fx.t1.bid, yes_ask_dollars: fx.t1.ask, status: 'active', volume_fp: '700' },
  ],
});
const posts = [];
const axios = require('axios');
axios.get = async (url, cfg = {}) => {
  const p = cfg.params || {};
  let data;
  if (url === 'https://gamma-api.polymarket.com/sports') data = [{ sport: 'val', series: '10369', tags: '1,64' }];
  else if (url === 'https://gamma-api.polymarket.com/events' && p.series_id === 10369) data = [pmEvent()];
  else if (url === 'https://gamma-api.polymarket.com/events') data = [];
  else if (url === 'https://api.elections.kalshi.com/trade-api/v2/events') data = { events: p.series_ticker === 'KXVALORANTGAME' ? [kalshiGame()] : [] };
  else if (url.startsWith('https://api.bo3.gg/')) data = { results: [] };
  else throw Object.assign(new Error(`offline: ${url}`), { code: 'ENOTFOUND' });
  return { status: 200, headers: {}, data: JSON.parse(JSON.stringify(data)) };
};
axios.post = async (url, body) => { posts.push({ url, body }); return { status: 204, data: '' }; };

const S = require('../server');
const cron = require('node-cron');
for (const t of cron.getTasks().values()) t.stop();

let srv, base;
test.before(async () => { await new Promise(r => { srv = S.app.listen(0, '127.0.0.1', r); }); base = `http://127.0.0.1:${srv.address().port}`; });
test.after(() => { Date.now = realNow; srv?.closeAllConnections?.(); srv?.close(); for (const t of cron.getTasks().values()) t.stop(); fs.rmSync(DIR, { recursive: true, force: true }); });
const PRO = { 'x-admin-token': ADMIN_TOKEN };
const get = async (p, headers = {}) => { const r = await fetch(base + p, { headers }); return { status: r.status, body: await r.json() }; };

test('scan: one match from both exchanges, its price handed to the props model', async () => {
  await S.scanEsportsBoard();
  const st = S.esportsBoard.state;
  assert.equal(st.counts.matches, 1);
  assert.equal(st.counts.both, 1);
  const row = S.oddsBook.list().find(r => r.source === 'exchanges');
  assert.ok(row, 'the exchange price went into the match-odds book');
  assert.equal(row.sport, 'VAL');
  assert.ok(row.pSeriesA > 0.5 && row.pSeriesA < 0.6);
  assert.equal(posts.length, 0, 'the first scan only primes');
});

test('a new edge alerts once, Kalshi only in US mode', async () => {
  // T1 drops to 30¢ on Kalshi (Polymarket still has it at 44-45¢)
  Object.assign(fx, { t1: { bid: '0.2800', ask: '0.3000' }, g2: { bid: '0.6900', ask: '0.7100' } });
  tick();
  await S.scanEsportsBoard();
  assert.equal(posts.length, 1);
  const text = posts[0].body.content;
  assert.match(text, /🎮 Valorant · G2 Esports vs T1 \(Bo3, .* ET\): T1 to win on Kalshi at \d+(\.\d)?¢, fair 44\.5¢ \(\+\d+\.\d%\)/);
  assert.match(text, /kalshi\.com\/markets\/kxvalorantgame-/);
  assert.ok(!/Polymarket at/.test(text), 'no Polymarket edges in US mode');
  tick();
  await S.scanEsportsBoard();
  assert.equal(posts.length, 1, 'the same edge is not re-sent');
});

test('/api/esports/matches: Pro sees Kalshi edges and Polymarket as a reference', async () => {
  const { status, body } = await get('/api/esports/matches', PRO);
  assert.equal(status, 200);
  assert.equal(body.region, 'us');
  const [m] = body.matches;
  assert.deepEqual(m.edges.map(e => e.venue), ['kalshi']);
  assert.equal(m.links.polymarket, undefined, 'no polymarket.com links in US mode');
  assert.ok(m.links.kalshi);
  const t1 = m.markets[0].outcomes[1];
  assert.ok(t1.quotes.kalshi.edge);
  assert.ok(t1.quotes.polymarket && t1.quotes.polymarket.edge === undefined, 'shown, never flagged');
  assert.equal(m.locked, false);
  assert.ok(body.games.CS2);
  // filters
  assert.equal((await get('/api/esports/matches?game=CS2', PRO)).body.count, 0);
  assert.equal((await get('/api/esports/matches?edges=1', PRO)).body.count, 1);
});

test('/api/esports/matches: free viewers see prices, not the edges', async () => {
  const { body } = await get('/api/esports/matches');
  const [m] = body.matches;
  assert.equal(body.pro, false);
  assert.deepEqual(m.edges, []);
  assert.equal(m.locked, true);
  const q = m.markets[0].outcomes[1].quotes.kalshi;
  assert.equal(q.ev, null);
  assert.equal(q.edge, undefined);
  assert.ok(q.ask > 0, 'the price itself is public');
});

test('/api/esports/matches: a venue without display permission is withheld', async () => {
  process.env.KALSHI_DISPLAY_OK = 'off';
  try {
    const { body } = await get('/api/esports/matches');
    const [m] = body.matches;
    assert.equal(m.links.kalshi, undefined);
    assert.ok(m.markets.every(mk => mk.outcomes.every(oc => !oc.quotes.kalshi)));
    // the admin still sees everything
    assert.ok((await get('/api/esports/matches', PRO)).body.matches[0].links.kalshi);
  } finally { process.env.KALSHI_DISPLAY_OK = 'on'; }
});

test('status reports the board', async () => {
  const { body } = await get('/api/status');
  assert.equal(body.esportsBoard.counts.matches, 1);
});
