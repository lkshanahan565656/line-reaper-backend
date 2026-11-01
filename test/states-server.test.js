// My state on a booted server (axios offline): /api/states and one state,
// the public API's ?state and /api/v1/states, a league page with ?state, and
// the picker in the app and on the sales page.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lr-states-'));
for (const k of ['DATABASE_URL', 'ODDS_API_KEY', 'OWLS_API_KEY', 'ALERT_WEBHOOK_URL', 'PUBLIC_URL', 'PAYWALL', 'DISCORD_WEBHOOK_URLS', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_IDS']) delete process.env[k];
Object.assign(process.env, { LR_DATA_DIR: DIR, TRACKER_FILE: path.join(DIR, 'picks.json'), USERS_FILE: path.join(DIR, 'users.json'), EV_TRACK_FILE: path.join(DIR, 'ev.json'),
  SPORT_PROPS_FILE: path.join(DIR, 'sport-props.json'), DIGEST_FILE: path.join(DIR, 'digest.json'), API_KEYS_FILE: path.join(DIR, 'api-keys.json'), OUT_FEED_FILE: path.join(DIR, 'out-feed.json'), ESPORTS_CALIBRATION: 'off' });
const axios = require('axios');
axios.get = async () => { throw Object.assign(new Error('offline'), { response: { status: 503 } }); };
axios.post = axios.get;
const srv = require('../server');
const cron = require('node-cron');
let server, base;
test.before(async () => { server = srv.app.listen(0); await new Promise(r => server.once('listening', r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => { server?.close(); for (const t of cron.getTasks().values()) t.stop(); fs.rmSync(DIR, { recursive: true, force: true }); setTimeout(() => process.exit(0), 50).unref(); });
const json = async p => { const r = await fetch(base + p); return { status: r.status, body: await r.json() }; };

test('/api/states lists every state; one state says legal, not sure and not legal with sources', async () => {
  const all = await json('/api/states');
  assert.equal(all.status, 200);
  assert.equal(all.body.states.length, 51);
  const tx = await json('/api/states/tx');
  assert.equal(tx.body.state, 'TX');
  assert.ok(tx.body.venues.some(v => v.key === 'kalshi' && v.source?.dated));
  assert.ok(tx.body.notLegal.some(v => v.key === 'fanduel'));
  assert.match(tx.body.check, /check with the venue/);
  assert.equal((await json('/api/states/ZZ')).status, 404);
  const t = await json('/api/states/table');
  assert.equal(t.body.status.polymarket.NY, 'no');
});

test('a league page takes ?state: New Jersey keeps FanDuel, Texas drops it', async () => {
  const start = new Date(Date.now() + 5 * 3600e3).toISOString();
  srv.freeBooksState.games = { nfl: [{ id: 'pin-st1', sport_key: 'nfl', commence_time: start, home_team: 'Home Hawks', away_team: 'Away Owls', bookmakers: [
    { key: 'pinnacle', markets: [{ key: 'h2h', outcomes: [{ name: 'Home Hawks', price: -150 }, { name: 'Away Owls', price: 135 }] }] },
    { key: 'gemini', markets: [{ key: 'h2h', outcomes: [{ name: 'Home Hawks', price: -138 }, { name: 'Away Owls', price: 140 }] }] },
    { key: 'fanduel', markets: [{ key: 'h2h', outcomes: [{ name: 'Home Hawks', price: -130 }, { name: 'Away Owls', price: 150 }] }] },
  ] }] };
  srv.freeBooksState.gamesAt = new Date().toISOString();
  srv.shopState.key = null; srv.shopState.builtAt = null;
  const nj = await fetch(base + '/nfl?state=NJ').then(x => x.text());
  assert.match(nj, /New Jersey venues on this board:[^<]*FanDuel/);
  assert.match(nj, /<option value="NJ" selected>New Jersey<\/option>/);
  assert.match(nj, /rel="canonical" href="[^"]*\/nfl"|canonical/);
  const tx = await fetch(base + '/nfl').then(x => x.text());
  assert.match(tx, /Texas venues on this board/);
  assert.doesNotMatch(tx, /Texas venues on this board:[^<]*FanDuel/);
});

test('the public API filters by ?state, refuses a bad code, and lists the states', async () => {
  const k = await fetch(`${base}/api/v1/keys`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '10.9.9.9' }, body: JSON.stringify({ name: 'states' }) }).then(r => r.json());
  const get = async p => { const r = await fetch(base + p, { headers: { 'X-API-Key': k.key } }); return { status: r.status, body: await r.json() }; };
  const bad = await get('/api/v1/best-prices?state=ZZ');
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, 'bad_parameter');
  const ok = await get('/api/v1/best-prices?state=tx');
  assert.equal(ok.status, 200);
  assert.equal(ok.body.state, 'TX');
  assert.match(ok.body.stateNote, /check with the venue/);
  assert.ok(ok.body.rows.every(r => !['fanduel', 'betrivers', 'pinnacle'].includes(r.venue)));
  const rec = await get('/api/v1/record?state=NJ');
  assert.equal(rec.body.stateName, 'New Jersey');
  const sts = await get('/api/v1/states');
  assert.equal(sts.body.states.length, 51);
  assert.equal((await get('/api/v1/states/OH')).body.name, 'Ohio');
  assert.equal((await get('/api/v1/states/QQ')).status, 400);
  const idx = await (await fetch(`${base}/api/v1`)).json();
  assert.ok(idx.endpoints.find(e => e.path === '/api/v1/best-prices').params.state);
  assert.ok(idx.endpoints.some(e => e.path === '/api/v1/states/{state}'));
});

test('the app has CUSTOMIZE > My state on Texas by default, and the sales page a state lookup', () => {
  const html = require('./app-source').both;
  assert.match(html, /id="layState"/);
  assert.match(html, /let lrState = 'TX';/);
  for (const pg of ['odds', 'props', 'esports', 'results', 'best', 'ev']) assert.match(html, new RegExp(`id="page-${pg}">\\n(  <div id="pkTray" style="display:none"></div>\\n)?  <div data-state-bar></div>`), pg);
  const land = fs.readFileSync(path.join(__dirname, '..', 'public', 'landing.html'), 'utf8');
  assert.match(land, /WORKS IN TEXAS/);
  assert.match(land, /id="stLook"/);
  assert.match(land, /fetch\('\/api\/states'\)/);
});
