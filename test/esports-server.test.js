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
  TAIL_TRACK_FILE: path.join(DIR, 'tail-signals.json'), TAIL_TRADERS_FILE: path.join(DIR, 'tail-traders.json'), FRESH_TRACK_FILE: path.join(DIR, 'fresh-signals.json'), ESPORTS_EDGE_TRACK_FILE: path.join(DIR, 'esports-edges.json'),
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
  assert.match(text, /Valorant · G2 Esports vs T1 \(Bo3, .* ET\): T1 to win on Kalshi at \d+(\.\d)?¢, fair 44\.5¢ \(\+\d+\.\d%\)/);
  assert.match(text, /kalshi\.com\/markets\/kxvalorantgame-/);
  assert.ok(!/Polymarket at/.test(text), 'no Polymarket edges in US mode');
  tick();
  await S.scanEsportsBoard();
  assert.equal(posts.length, 1, 'the same edge is not re-sent');
});

test('the Kalshi edge is logged for the results board, graded on the close at the start', async () => {
  await S.esportsEdgeTracker.ready();
  const open = await S.esportsEdgeTracker.list({ status: 'open' });
  const bet = open.find(b => b.book === 'kalshi' && b.side === 'T1');
  assert.ok(bet, 'the edge went into the tracker');
  assert.ok(!open.some(b => b.book === 'polymarket'), 'US mode: no Polymarket International edges');
  assert.ok(bet.evAtFlag >= 2 && bet.decimal > 3);
  // past the start: closed with CLV against the last fair
  const rows = await S.esportsEdgeTracker.list({});
  tick(7 * 3600e3);
  await S.esportsEdgeTracker.recordBoard([], new Map());
  const closed = (await S.esportsEdgeTracker.list({ status: 'closed' })).find(b => b.id === bet.id);
  assert.ok(closed && Number.isFinite(closed.clv) && closed.clv > 0);
  const res = (await get('/api/results')).body;
  assert.equal(res.sources.esportsEdges.overall.n, rows.length);
  assert.equal(res.backup.state, 'off');
  assert.equal((await get('/api/results/backup')).status, 404);
  tick(-7 * 3600e3);
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

test('/api/best: the Kalshi edge is a best play for Pro, counts only for free', async () => {
  const { status, body } = await get('/api/best', PRO);
  assert.equal(status, 200);
  const row = body.rows.find(r => r.kind === 'esportsEdge');
  assert.ok(row, 'the board edge is on the list');
  assert.equal(row.venue, 'Kalshi');
  assert.ok(row.units > 0 && row.units <= 1);
  assert.ok(!body.rows.some(r => /polymarket/i.test(r.venue)), 'US mode: no Polymarket International plays');
  const free = (await get('/api/best')).body;
  assert.equal(free.pro, false);
  assert.deepEqual(free.rows, []);
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

// ── props model (LCSLarry-calibrated) ──
// Rows from LCSLarry's PrizePicks board (2026-10-12): line, their projection,
// their probability. Given the same projection, our probability should land
// within a few points, on overs and unders alike.
const LARRY = [
  ['CS', 'MAPS 1-2 Headshots', 16.5, 14.5, 60.1], ['CS', 'MAPS 1-2 Headshots', 17.5, 19.5, 60.0], ['CS', 'MAPS 1-2 Kills', 30, 32.2, 60.0],
  ['CS', 'MAPS 1-2 Kills', 26.5, 28.7, 59.7], ['LOL', 'MAPS 1-3 Kills', 10.5, 12.6, 59.1], ['CS', 'MAPS 1-2 Kills', 32.5, 34.8, 59.1],
  ['LOL', 'MAPS 1-3 Kills', 11, 12.9, 58.8], ['LOL', 'MAPS 1-3 Kills', 15, 16.7, 58.4], ['CS', 'MAPS 1-2 Headshots', 16.5, 14.9, 58.0],
  ['CS', 'MAPS 1-2 Kills', 22.5, 21.4, 58.0], ['CS', 'MAPS 1-2 Kills', 32.5, 31.1, 58.0], ['CS', 'MAPS 1-2 Kills', 32, 30.7, 57.9],
  ['LOL', 'MAPS 1-3 Kills (Combo)', 21.5, 24, 57.8], ['CS', 'MAPS 1-2 Headshots', 12.5, 13.9, 57.8], ['VAL', 'MAPS 1-2 Kills', 29.5, 28.1, 57.7],
  ['CS', 'MAPS 1-2 Headshots', 10, 11.2, 57.7], ['CS', 'MAPS 1-2 Kills', 22.5, 24.3, 57.6], ['CS', 'MAPS 1-2 Headshots', 10, 9.1, 57.6],
];
test('props: probabilities track LCSLarry on the same projections, overs and unders alike', () => {
  let err = 0;
  for (const [sport, market, line, pred, theirs] of LARRY) {
    const r = S.calcEsportsEV(line, pred, pred > line ? 'OVER' : 'UNDER', sport, market);
    assert.ok(Math.abs(r.prob - theirs) < 3.5, `${sport} ${market} ${line} vs ${pred}: ours ${r.prob.toFixed(1)}, theirs ${theirs}`);
    err += Math.abs(r.prob - theirs);
  }
  assert.ok(err / LARRY.length < 1.5, `mean gap ${(err / LARRY.length).toFixed(2)} points`);
  // the same 2-headshot gap reads the same whichever side it falls on
  const under = S.calcEsportsEV(16.5, 14.5, 'UNDER', 'CS', 'MAPS 1-2 Headshots').prob;
  const over = S.calcEsportsEV(16.5, 18.5, 'OVER', 'CS', 'MAPS 1-2 Headshots').prob;
  assert.ok(Math.abs(under - over) < 1.5, `under ${under} vs over ${over}`);
});

test('props: Underdog esports lines get the player\'s team from the game\'s home and away sides (title reads away vs home)', () => {
  const payload = {
    games: [{ id: 7, sport_id: 'CS', title: 'Betclic vs Ninjas in Pyjamas', full_team_names_title: 'Betclic vs Ninjas in Pyjamas', home_team_id: 'h', away_team_id: 'a', scheduled_at: '2026-10-12T10:00:00Z' }],
    players: [{ id: 'p1', last_name: 'sjuush', sport_id: 'CS' }, { id: 'p2', last_name: 'stavn', sport_id: 'CS' }],
    appearances: [{ id: 'x1', player_id: 'p1', match_id: 7, team_id: 'h' }, { id: 'x2', player_id: 'p2', match_id: 7, team_id: 'a' }],
    over_under_lines: [
      { stat_value: '27.5', over_under: { appearance_stat: { appearance_id: 'x1', display_stat: 'Kills on Maps 1+2' } }, options: [] },
      { stat_value: '32', over_under: { appearance_stat: { appearance_id: 'x2', display_stat: 'Kills on Maps 1+2' } }, options: [] },
    ],
  };
  const lines = S.parseUnderdogPayload(payload);
  // the title reads away vs home
  assert.equal(lines[0].team, 'Ninjas in Pyjamas');
  assert.equal(lines[1].team, 'Betclic');
  assert.equal(lines[0].matchTitle, 'Betclic vs Ninjas in Pyjamas');
});
