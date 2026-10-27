// /api/search and /api/v1/search on a booted server (axios offline): it reads
// the odds screen the server holds, keeps to the picked state's venues, and
// answers an empty board with nothing rather than anything made up.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lr-search-'));
for (const k of ['DATABASE_URL', 'ODDS_API_KEY', 'OWLS_API_KEY', 'ALERT_WEBHOOK_URL', 'PAYWALL', 'PUBLIC_URL']) delete process.env[k];
Object.assign(process.env, { LR_DATA_DIR: DIR, TRACKER_FILE: path.join(DIR, 'picks.json'), USERS_FILE: path.join(DIR, 'users.json'), EV_TRACK_FILE: path.join(DIR, 'ev.json'), API_KEYS_FILE: path.join(DIR, 'api-keys.json'), ESPORTS_CALIBRATION: 'off' });
const axios = require('axios');
axios.get = async () => { throw Object.assign(new Error('offline'), { response: { status: 503 } }); };
axios.post = axios.get;
const srv = require('../server');
const cron = require('node-cron');
let server, base;
test.before(async () => { server = srv.app.listen(0); await new Promise(r => server.once('listening', r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => { server?.close(); for (const t of cron.getTasks().values()) t.stop(); fs.rmSync(DIR, { recursive: true, force: true }); setTimeout(() => process.exit(0), 50).unref(); });
const get = async (p, h = {}) => { const r = await fetch(base + p, { headers: h }); return { status: r.status, body: await r.json() }; };

test('an empty board: nothing found, nothing made up, and it says what it holds', async () => {
  const { status, body } = await get('/api/search?q=hawks&state=TX');
  assert.equal(status, 200);
  assert.deepEqual(body.hits, []);
  assert.equal(body.state, 'TX');
  assert.equal(body.holds.game, 0);
  assert.match(body.note, /no fair or EV/);
});

test('a team finds its game, best price only at a venue legal in the state picked', async () => {
  const start = new Date(Date.now() + 5 * 3600e3).toISOString();
  srv.freeBooksState.games = { nfl: [{ id: 'pin-s1', sport_key: 'nfl', commence_time: start, home_team: 'Home Hawks', away_team: 'Away Owls', bookmakers: [
    { key: 'pinnacle', markets: [{ key: 'h2h', outcomes: [{ name: 'Home Hawks', price: -150 }, { name: 'Away Owls', price: 135 }] }] },
    { key: 'gemini', markets: [{ key: 'h2h', outcomes: [{ name: 'Home Hawks', price: -138 }, { name: 'Away Owls', price: 140 }] }] },
    { key: 'fanduel', markets: [{ key: 'h2h', outcomes: [{ name: 'Home Hawks', price: -130 }, { name: 'Away Owls', price: 150 }] }] },
  ] }] };
  srv.freeBooksState.gamesAt = new Date().toISOString();
  // a new read of the board builds afresh: the empty build above is not reused
  const tx = (await get('/api/search?q=hawks&state=TX')).body;
  assert.ok(tx.hits.length >= 1, JSON.stringify(tx));
  const g = tx.hits.find(h => h.kind === 'game');
  assert.equal(g.title, 'Away Owls @ Home Hawks');
  assert.equal(g.go.tab, 'odds');
  // Texas: FanDuel is not legal there, so Gemini is the best price on both sides
  assert.ok(g.prices.every(p => p.venue === 'gemini'), JSON.stringify(g.prices));
  const all = (await get('/api/search?q=owls')).body.hits.find(h => h.kind === 'game');
  assert.equal(all.prices.find(p => p.label === 'Away Owls').venue, 'fanduel', 'with no state, the best at any venue');
  assert.ok(!JSON.stringify(all).match(/"(fair|ev)":/), 'no fair or EV in a search hit');
  const lg = (await get('/api/search?q=nfl')).body.hits.find(h => h.kind === 'league');
  assert.equal(lg.page, '/nfl');
  assert.equal(lg.counts.games, 1);
});

test('/api/v1/search needs a key, wants two letters, and returns the same hits', async () => {
  assert.equal((await get('/api/v1/search?q=owls')).status, 401);
  const k = await fetch(`${base}/api/v1/keys`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '10.9.0.1' }, body: JSON.stringify({ name: 'search' }) }).then(r => r.json());
  const h = { 'X-API-Key': k.key };
  const short = await get('/api/v1/search?q=o', h);
  assert.equal(short.status, 400);
  const ok = await get('/api/v1/search?q=owls&kind=game', h);
  assert.equal(ok.status, 200);
  assert.ok(ok.body.hits.length >= 1 && ok.body.hits.every(x => x.kind === 'game'));
  const idx = (await get('/api/v1')).body;
  assert.ok(idx.endpoints.some(e => e.path === '/api/v1/search'));
});

test('/api/v1 search, leaderboard and alerts: a misspelt filter is a 400 that says so, not everything', async () => {
  const k = await fetch(`${base}/api/v1/keys`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '10.9.0.2' }, body: JSON.stringify({ name: 'params' }) }).then(r => r.json());
  const h = { 'X-API-Key': k.key };
  for (const [u, re] of [['/api/v1/search?q=owls&kind=games', /kind is one or more of game/], ['/api/v1/search?q=owls&state=ZZ', /state is a two-letter/],
    ['/api/v1/leaderboard?window=week', /window is one of 7d, 30d, all/], ['/api/v1/leaderboard?state=ZZ', /state is a two-letter/], ['/api/v1/leaderboard?venues=all', /venues is mine/],
    ['/api/v1/alerts?kind=evs', /kind is one of ev/], ['/api/v1/alerts?days=x', /days must be a number/], ['/api/v1/alerts?before=yesterday', /before is an ISO time/], ['/api/v1/alerts?limit=0', /limit must be/]]) {
    const r = await get(u, h);
    assert.equal(r.status, 400, `${u} answered ${r.status}`);
    assert.equal(r.body.error.code, 'bad_parameter', u);
    assert.match(r.body.error.message, re, u);
  }
  for (const u of ['/api/v1/search?q=owls&kind=game,player&state=tx', '/api/v1/leaderboard?window=7d&state=CA&venues=mine&league=nba', '/api/v1/alerts?kind=ev&days=7&limit=5']) {
    assert.equal((await get(u, h)).status, 200, u);
  }
  assert.equal((await get('/api/v1/search?q=o', h)).body.error.code, 'bad_parameter');
});
