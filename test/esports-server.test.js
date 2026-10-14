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
const book = { thin: false };
const axios = require('axios');
axios.get = async (url, cfg = {}) => {
  const p = cfg.params || {};
  let data;
  if (url === 'https://gamma-api.polymarket.com/sports') data = [{ sport: 'val', series: '10369', tags: '1,64' }];
  else if (url === 'https://gamma-api.polymarket.com/events' && p.series_id === 10369) data = [pmEvent()];
  else if (url === 'https://gamma-api.polymarket.com/events') data = [];
  else if (url === 'https://api.elections.kalshi.com/trade-api/v2/events') data = { events: p.series_ticker === 'KXVALORANTGAME' ? [kalshiGame()] : [] };
  else if (url.startsWith('https://api.elections.kalshi.com/trade-api/v2/markets/') && url.endsWith('/orderbook')) {
    // what a YES buyer can take: 1 − each NO bid (book.thin: only $15 resting)
    const team = url.includes(`-${TAIL}-T1/`) ? 't1' : 'g2';
    data = { orderbook_fp: { yes_dollars: [], no_dollars: [[(1 - Number(fx[team].ask)).toFixed(4), book.thin ? '50' : '1000']] } };
  }
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

test('a new edge alerts once, Kalshi only in US mode, and only with size on the book', async () => {
  // T1 drops to 30¢ on Kalshi (Polymarket still has it at 44-45¢), but only $15 rests there
  Object.assign(fx, { t1: { bid: '0.2800', ask: '0.3000' }, g2: { bid: '0.6900', ask: '0.7100' } });
  book.thin = true;
  tick();
  await S.scanEsportsBoard();
  assert.equal(posts.length, 0, 'a thin book holds the alert');
  book.thin = false;
  tick(90e3);
  await S.scanEsportsBoard();
  assert.equal(posts.length, 1);
  const text = posts[0].body.content;
  assert.match(text, /Valorant · G2 Esports vs T1 \(Bo3, .* ET\): T1 to win on Kalshi at \d+(\.\d)?¢, fair 44\.5¢ \(\+\d+\.\d%\), \$300 on the book at that price/);
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
  assert.equal(bet.closeFair, bet.fairAtFlag, 'the close is read against the same other-source fair the edge was flagged on');
  // 2 minutes on, the side costs 2¢ more: that is the price a subscriber got
  Object.assign(fx, { t1: { bid: '0.3000', ask: '0.3200' }, g2: { bid: '0.6700', ask: '0.6900' } });
  tick(130e3);
  await S.scanEsportsBoard();
  await S.esportsEdgeTracker.recordBoard([], new Map());
  const later = (await S.esportsEdgeTracker.list({ status: 'open' })).find(b => b.id === bet.id);
  assert.ok(later.execPrice > 0.32 && later.execPrice < 0.34, `exec price ${later.execPrice} is the ask 2 minutes on, fee included`);
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
  assert.ok(free.rows.length <= 3, 'free users get a short preview of the same plays');
  assert.equal(free.rows.length + free.locked, free.total);
  assert.ok(free.rows.every(r => body.rows.some(p => p.id === r.id)), 'the preview is the same alert Pro sees');
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

test('props: low Dota lines are never priced steadier than a Poisson count', () => {
  const pois = (m, n) => { let c = 0, t = Math.exp(-m); for (let i = 0; i <= n; i++) { c += t; t *= m / (i + 1); } return c; };
  // 4.0 projected kills over 2.5: a known Poisson mean gives 76%, so a model
  // with projection error has to sit at or below that
  const r = S.calcEsportsEV(2.5, 4, 'OVER', 'DOTA2', 'Kills Map 1');
  assert.ok(r.varianceK >= 1.5 && r.prob <= (1 - pois(4, 2)) * 100, `${r.varianceK} ${r.prob}`);
  // and more projected kills never reads as a weaker over
  let last = 0;
  for (const pred of [5, 6, 7, 8, 9]) {
    const p = S.calcEsportsEV(4.5, pred, 'OVER', 'DOTA2', 'Kills Map 1').prob;
    assert.ok(p > last, `${pred}: ${p} after ${last}`);
    last = p;
  }
});

test('props: the per-map mean only divides by expected maps when those scenarios are used', () => {
  const ctx = { scenarios: [{ maps: 2, weight: 0.5 }, { maps: 3, weight: 0.5 }], expMaps: 2.5 };
  assert.equal(S.calcEsportsEV(40.5, 42, 'OVER', 'CS', 'MAPS 1-3 Kills', { context: ctx }).meanPerMap, 42 / 2.5);
  const bare = S.calcEsportsEV(40.5, 42, 'OVER', 'CS', 'MAPS 1-3 Kills', { context: { scenarios: [], expMaps: 2.5 } });
  assert.equal(bare.meanPerMap, 42);
  assert.deepEqual(bare.scenarios, [{ maps: 1, weight: 1 }]);
});

test('slip: hand-built legs take a percent or a fraction, and a pricing block alone', () => {
  const [a, b, c] = S.legsFromBoard([
    { player: 'A', prob: 58 },
    { player: 'B', prob: 0.58 },
    { player: 'C', pricing: { line: 20.5, side: 'OVER', meanPerMap: 11, k: 2.5, stat: 'kills', scenarios: [{ maps: 2, weight: 1 }] } },
  ]);
  assert.equal(a.prob, 0.58);
  assert.equal(b.prob, 0.58);
  assert.ok(c.prob > 0.5 && c.prob < 0.7 && c.meanPerMap === 11 && c.scenarios.length === 1);
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


// Shapes copied from bo3's live payload for donk (2026-10-12, 90-day window)
const gen = { games_count: 63, matches_count: 25, kills_sum: 1217, deaths_sum: 911, rounds_count: 1355 };
const acc = [
  { hit_group: '', kills_sum: 0 }, { hit_group: 'Chest', kills_sum: 257 }, { hit_group: 'Generic', kills_sum: 17 },
  { hit_group: 'Head', kills_sum: 786 }, { hit_group: 'LeftArm', kills_sum: 10 }, { hit_group: 'LeftLeg', kills_sum: 12 },
  { hit_group: 'RightArm', kills_sum: 40 }, { hit_group: 'Stomach', kills_sum: 98 }, { hit_group: 'RightLeg', kills_sum: 7 },
];

test('props: bo3 headshot rate comes from the Head hit group', () => {
  assert.ok(Math.abs(S.bo3HeadshotPct(acc) - 786 / 1227 * 100) < 1e-9);
  assert.ok(Math.abs(S.bo3HeadshotPct({ data: acc }) - 786 / 1227 * 100) < 1e-9);
  assert.equal(S.bo3HeadshotPct([{ hit_group: 'Head', kills_sum: 10 }]), null);
  assert.equal(S.bo3HeadshotPct(null), null);
});

test('props: bo3 maps are games, not series', () => {
  const p = S.bo3ExtractProfile('donk', { data: [gen] }, null, acc);
  assert.equal(p.mapsPlayed, 63);
  assert.ok(Math.abs(p.avgKillsPerMap - 1217 / 63) < 1e-9);
  assert.ok(Math.abs(p.roundsPerMap - 1355 / 63) < 1e-9);
  assert.ok(Math.abs(p.hsPercent - 64.06) < 0.01);
});

test('props: headshot props use the player rate, not a flat 45%', () => {
  const p = S.bo3ExtractProfile('donk', { data: [gen] }, null, acc);
  const kills = S.predictKillsFromStats(p, 'CS', 2, 'kills');
  const hs = S.predictKillsFromStats(p, 'CS', 2, 'Headshots on Maps 1+2');
  assert.ok(Math.abs(hs / kills - 786 / 1227) < 1e-9);
  assert.ok(kills > 36 && kills < 41);   // about 19.3 a map
});

test('the bare URL: browsers get the sales page, API clients the JSON status', async () => {
  const r = await fetch(base + '/', { headers: { accept: 'text/html,application/xhtml+xml,*/*;q=0.8' } });
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.ok(html.includes('by sharps') && html.includes('id="pricing"'));
  assert.doesNotMatch(html, /\{\{[A-Z_]+\}\}/, 'every template token filled');
  assert.equal((await get('/')).body.status, 'Line Reaper backend running');
});

test('sales page prices and early-access note come from env', () => {
  const { landingHtml } = S;
  const free = landingHtml({ paywall: false, env: {} });
  assert.match(free, /\$79<span>/);
  assert.match(free, /\$49 a month for the first 100 members/);
  assert.match(free, /class="early" style="display:block"/);
  assert.ok(free.includes('>Start free<') && !free.includes('>Create a free account<'), 'no accounts without AUTH_SECRET');
  const paid = landingHtml({ paywall: true, env: { PRICE_MONTHLY: '59', PRICE_INTRO: '0', AUTH_SECRET: 'x' } });
  assert.match(paid, /\$59<span>/);
  assert.match(paid, /class="intro" style="visibility:hidden"/);
  assert.match(paid, /class="early" style="display:none"/);
  assert.ok(paid.includes('>Create a free account<'));
  for (const p of [free, paid]) assert.doesNotMatch(p, /\{\{[A-Z_]+\}\}/);
});

test('props: Underdog sides it doesn\'t take are marked closed, and pulled lines are dropped', () => {
  const base = id => ({ stat_value: '30.5', over_under: { appearance_stat: { appearance_id: id, display_stat: 'Kills on Maps 1+2' } } });
  const payload = {
    games: [{ id: 7, sport_id: 'CS', title: 'A vs B', scheduled_at: '2026-10-12T10:00:00Z' }],
    players: [1, 2, 3, 4, 5].map(i => ({ id: 'p' + i, last_name: 'n' + i, sport_id: 'CS' })),
    appearances: [1, 2, 3, 4, 5].map(i => ({ id: 'x' + i, player_id: 'p' + i, match_id: 7 })),
    over_under_lines: [
      { ...base('x1'), options: [{ choice: 'higher', payout_multiplier: '1.0' }] },
      { ...base('x2'), options: [{ choice: 'higher', payout_multiplier: '1.0' }, { choice: 'lower', payout_multiplier: '1.0', status: 'suspended' }] },
      { ...base('x3'), options: [{ choice: 'higher', payout_multiplier: '0.9' }, { choice: 'lower', payout_multiplier: '1.1' }] },
      { ...base('x4'), status: 'suspended', options: [{ choice: 'higher' }, { choice: 'lower' }] },
      { ...base('x5'), options: [] },
    ],
  };
  const lines = S.parseUnderdogPayload(payload);
  assert.equal(lines.length, 4);
  assert.deepEqual(lines.map(l => [l.overOpen, l.underOpen]), [[true, false], [true, false], [true, true], [true, true]]);
  assert.equal(lines[0].underMultiplier, null);
  assert.equal(lines[2].underMultiplier, 1.1);
});

test('props: a projection on the line is a coin flip once the curve\'s skew is taken out', () => {
  // support kill lines skew hard to the under; big CS lines are symmetric
  const sup = S.lineSkew(1.5, 'LOL', 'Kills on Maps 1+2+3');
  assert.ok(sup > 8 && sup < 15, `support skew ${sup}`);
  assert.ok(Math.abs(S.lineSkew(27.5, 'CS', 'Kills on Maps 1+2')) < 0.5);
  const z = S.calcEsportsEV(1.5, 1.5, 'OVER', 'LOL', 'Kills on Maps 1+2+3');
  assert.ok(Math.abs(z.prob + sup - 50) < 1e-9);
});

test('first bloods and deaths never share a key with kills across books', () => {
  const k = S.normalizeMarket;
  assert.equal(k('MAPS 1-2 Kills'), k('Kills on Maps 1+2'));
  assert.equal(k('Kills Maps 1-2'), k('Kills on Maps 1+2'));
  assert.equal(k('MAPS 1-2 Headshots'), k('Headshots on Maps 1+2'));
  assert.notEqual(k('MAPS 1-2 First Bloods'), k('MAPS 1-2 Kills'));
  assert.notEqual(k('Deaths on Maps 1+2'), k('Kills on Maps 1+2'));
  assert.ok(k('MAPS 1-2 First Bloods').startsWith('fb|'));
});

test('Underdog sanity check is one-sided: a bad Underdog price shows its EV, a fake edge is withheld', () => {
  // 0.82x boost implies 68.6%. Our 55% there is just a bad price: negative EV, no flag
  const bad = S.udPricing(55, 0.82);
  assert.strictEqual(bad.flag, null);
  assert.ok(bad.ev < -15);
  // 1.1x implies 51.1%; a fair of 66% at that line is the kind of edge that's our error
  const fake = S.udPricing(66, 1.1);
  assert.strictEqual(fake.flag, 'price-mismatch');
  assert.strictEqual(fake.ev, null);
});

test('a lopsided Underdog boost past 1.35x is still a boost when the other side pays under 1x', () => {
  // Higher 1.48x / Lower 0.70x: the over is about a 32% shot, priced as a boost
  const boost = S.udPricing(32, 1.48, 0.7);
  assert.strictEqual(boost.regime, 'boost');
  assert.ok(Math.abs(boost.ev - ((0.32 * 1.48 / 0.5623 - 1) * 100)) < 1e-9);
  // a real decimal payout (no discount on the other side) stays decimal
  assert.strictEqual(S.udPricing(32, 2.9, 1.4).regime, 'decimal');
  assert.strictEqual(S.udPricing(32, 2.9).regime, 'decimal');
});

test('share card, robots and sitemap; the sales page carries its origin', async () => {
  const og = await fetch(base + '/og.png');
  assert.equal(og.status, 200);
  assert.match(og.headers.get('content-type'), /image\/png/);
  const robots = await (await fetch(base + '/robots.txt')).text();
  assert.match(robots, /Disallow: \/api\//);
  assert.match(robots, /Sitemap: https:\/\/127\.0\.0\.1:\d+\/sitemap\.xml/);
  const map = await (await fetch(base + '/sitemap.xml')).text();
  for (const u of ['/</loc>', '/terms</loc>', '/privacy</loc>', '/refunds</loc>']) assert.ok(map.includes(u), u);
  const page = S.landingHtml({ env: { LEGAL_EMAIL: 'help@example.com' }, origin: 'https://linereaper.example' });
  assert.ok(page.includes('content="https://linereaper.example/og.png"'));
  assert.ok(page.includes('href="mailto:help@example.com"'));
  assert.ok(S.landingHtml({ env: {} }).includes('href="/legal#contact"'));
});
