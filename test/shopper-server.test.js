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
