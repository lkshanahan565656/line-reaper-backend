// /api/shopper and /api/providers on a booted server (axios offline), fed a
// merged free-books game: the route builds quotes from memory, filters by
// query, and reports each provider's health.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lr-shopper-'));
for (const k of ['DATABASE_URL', 'ODDS_API_KEY', 'OWLS_API_KEY', 'ALERT_WEBHOOK_URL', 'PAYWALL']) delete process.env[k];
Object.assign(process.env, { TRACKER_FILE: path.join(DIR, 'picks.json'), USERS_FILE: path.join(DIR, 'users.json'), EV_TRACK_FILE: path.join(DIR, 'ev.json'), ESPORTS_CALIBRATION: 'off' });
const axios = require('axios');
axios.get = async () => { throw Object.assign(new Error('offline'), { response: { status: 503 } }); };
axios.post = axios.get;
const srv = require('../server');
const cron = require('node-cron');
let server, base;
test.before(async () => { server = srv.app.listen(0); await new Promise(r => server.once('listening', r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => { server?.close(); for (const t of cron.getTasks().values()) t.stop(); fs.rmSync(DIR, { recursive: true, force: true }); setTimeout(() => process.exit(0), 50).unref(); });
const get = async p => { const r = await fetch(base + p); return { status: r.status, body: await r.json() }; };

test('the shopper lines up every venue on one row and filters by query', async () => {
  const start = new Date(Date.now() + 5 * 3600e3).toISOString();
  srv.freeBooksState.games = { nfl: [{ id: 'pin-9', sport_key: 'nfl', commence_time: start, home_team: 'Home Hawks', away_team: 'Away Owls', bookmakers: [
    { key: 'pinnacle', markets: [{ key: 'h2h', outcomes: [{ name: 'Home Hawks', price: -150 }, { name: 'Away Owls', price: 135 }] },
      { key: 'totals', outcomes: [{ name: 'Over', price: -110, point: 44.5 }, { name: 'Under', price: -100, point: 44.5 }] }] },
    { key: 'gemini', markets: [{ key: 'h2h', outcomes: [{ name: 'Home Hawks', price: -138 }, { name: 'Away Owls', price: 140 }] }] },
    { key: 'fanduel', markets: [{ key: 'totals', outcomes: [{ name: 'Over', price: -105, point: 44.5 }, { name: 'Under', price: -115, point: 44.5 }] }] },
  ] }] };
  srv.freeBooksState.gamesAt = new Date().toISOString();
  const { status, body } = await get('/api/shopper');
  assert.equal(status, 200);
  assert.equal(body.counts.markets, 2);
  const ml = body.markets.find(m => m.marketType === 'moneyline');
  assert.equal(ml.sides.find(s => s.side === 'away').best.provider, 'gemini');
  assert.ok(ml.sides[0].fair > 0);
  assert.ok(body.opportunities.some(o => o.provider === 'gemini'), 'Gemini +140 against a +135 Pinnacle is above the fair');
  assert.ok(body.providers.find(p => p.id === 'pinnacle').quotes > 0);
  // Texas: FanDuel can't be best
  const tx = await get('/api/shopper?state=TX');
  const tot = tx.body.markets.find(m => m.marketType === 'total');
  assert.ok(!tot || tot.sides.every(s => !s.best || s.best.provider !== 'fanduel'));
  const onlyTotals = await get('/api/shopper?markets=total');
  assert.ok(onlyTotals.body.markets.every(m => m.marketType === 'total'));
  const hi = await get('/api/shopper?minEv=50');
  assert.equal(hi.body.opportunities.length, 0);
  const pv = await get('/api/providers');
  assert.ok(pv.body.providers.some(p => p.id === 'kalshi'));
  assert.ok(pv.body.providers.every(p => ['ok', 'down', 'degraded', 'stale', 'off', 'empty'].includes(p.status)));
});

test('prop line history, learn pages and feature flags are served', async () => {
  const h = await get('/api/shopper/history?key=nope');
  assert.equal(h.status, 200);
  assert.deepEqual(h.body.series, []);
  assert.match(h.body.note, /No saved prices/);
  const f = await get('/api/features');
  assert.equal(f.body.oddsApi, false, 'no ODDS_API_KEY in tests');
  for (const p of ['/learn', '/learn/expected-value', '/learn/pickem-math']) {
    const r = await fetch(base + p);
    assert.equal(r.status, 200, p);
    assert.match(await r.text(), /<h1>/);
  }
  const red = await fetch(base + '/learn/clv', { redirect: 'manual' });
  assert.equal(red.status, 301);
  assert.equal(red.headers.get('location'), '/learn/closing-line-value');
  assert.equal((await fetch(base + '/learn/not-a-guide')).status, 404);
  const map = await (await fetch(base + '/sitemap.xml')).text();
  assert.match(map, /\/learn\/how-the-record-works/);
  const st = await get('/api/status');
  assert.ok(st.body.propHistory && st.body.propHistory.series === 0);
});

test('prop history notes each prop market after a quote build and serves it as two sides', async () => {
  const S = require('../oddsschema');
  const start = new Date(Date.now() + 4 * 3600e3).toISOString(), at = new Date().toISOString();
  const q = (prov, side, d) => S.makeQuote({ providerId: prov, eventId: 'pin-77', sport: 'basketball', league: 'nba', home: 'H', away: 'A', marketType: 'player_prop', marketName: 'points',
    player: 'Jay Doe', side, selectionName: `Jay Doe ${side} 24.5`, line: 24.5, decimal: d, startUtc: start, updatedAt: at });
  srv.shopState.free = { quotes: [q('pinnacle', 'over', 1.95), q('pinnacle', 'under', 1.87), q('fanduel', 'over', 2.0), q('fanduel', 'under', 1.8)], stats: {} };
  srv.shopState.kalshi = { quotes: [], stats: {} };
  srv.shopState.builtAt = at;
  srv.propHistoryState.at = 0;
  await srv.observePropHistory();
  assert.equal(srv.propHistory.size(), 1);
  const key = srv.propHistory.dump()[0].id;
  const { body } = await get(`/api/shopper/history?key=${encodeURIComponent(key)}`);
  assert.equal(body.series.length, 2);
  assert.equal(body.series[0].label, 'Over 24.5');
  assert.equal(body.series[0].pts[0][3].fanduel, 100);
  assert.equal(body.series[0].pts[0][2] == null, !body.pro, 'the fair is Pro only');
  if (body.pro) assert.ok(Math.abs(body.series[0].pts[0][2] + body.series[1].pts[0][2] - 1) < 1e-3);
});

test('exchange prices carry their book size, minSize filters on it, and the shopper reads books within budget', async () => {
  const start = new Date(Date.now() + 6 * 3600e3).toISOString();
  srv.freeBooksState.games = { nfl: [{ id: 'pin-31', sport_key: 'nfl', commence_time: start, home_team: 'Size Home', away_team: 'Size Away', bookmakers: [
    { key: 'pinnacle', markets: [{ key: 'h2h', outcomes: [{ name: 'Size Home', price: -110 }, { name: 'Size Away', price: -110 }] }] },
    { key: 'gemini', markets: [{ key: 'h2h', outcomes: [{ name: 'Size Home', price: 110, ref: { venue: 'gemini', id: 'GEMI-SZ', buy: 'yes' } },
      { name: 'Size Away', price: -140, ref: { venue: 'gemini', id: 'GEMI-SZ', buy: 'no' } }] }] },
  ] }] };
  srv.freeBooksState.gamesAt = new Date().toISOString();
  Object.assign(srv.shopState, { key: null, builtAt: null, views: new Map() });
  srv.shopDepth.put('gemini|GEMI-SZ|yes', { asks: [[0.47, 100], [0.6, 2000]], fee: { rate: 0.07, roundCent: true } });
  const { body } = await get('/api/shopper?q=size');
  const home = body.markets[0].sides.find(s => s.side === 'home');
  const g = home.prices.find(c => c.provider === 'gemini');
  assert.equal(g.size.tiers[50].full, true);
  assert.equal(g.size.tiers[1000].full, true);
  assert.ok(home.prices.length && body.markets[0].sides.find(s => s.side === 'away').prices.find(c => c.provider === 'gemini').size.unread);
  const big = await get('/api/shopper?q=size&minSize=1000');
  assert.equal(big.body.minSize, 1000);
  const gh = big.body.markets[0].sides.find(s => s.side === 'home').prices.find(c => c.provider === 'gemini');
  assert.equal(gh.sizedAt, 1000);
  assert.ok(gh.effective < gh.listed);
  const st = await get('/api/status');
  assert.equal(st.body.shopDepth.on, true);
  assert.ok(st.body.shopDepth.books >= 1);
  // the shopper's own read pass: axios is offline in tests, so the away side's read fails, is counted as an error, and stays unread
  await srv.readShopDepth();
  assert.ok(srv.shopDepth.state.errors.some(e => /gemini/.test(e)));
  assert.equal(srv.shopDepth.get('gemini|GEMI-SZ|no'), null);
});
