// The line history routes: a game the odds screen dropped 6 hours after its
// start is still charted, listed and downloadable from the 30-day archive,
// on the site and in /api/v1, and the docs and pricing pages say so.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lr-lines-'));
for (const k of ['DATABASE_URL', 'ODDS_API_KEY', 'OWLS_API_KEY', 'ALERT_WEBHOOK_URL', 'PUBLIC_URL', 'PAYWALL']) delete process.env[k];
Object.assign(process.env, { LR_DATA_DIR: DIR, TRACKER_FILE: path.join(DIR, 'picks.json'), USERS_FILE: path.join(DIR, 'users.json'), EV_TRACK_FILE: path.join(DIR, 'ev.json'),
  SPORT_PROPS_FILE: path.join(DIR, 'sport-props.json'), ESPORTS_CALIBRATION: 'off' });
const axios = require('axios');
axios.get = async () => { throw Object.assign(new Error('offline'), { response: { status: 503 } }); };
axios.post = axios.get;
const srv = require('../server');
const cron = require('node-cron');
let server, base;
test.before(async () => { server = srv.app.listen(0); await new Promise(r => server.once('listening', r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => { server?.close(); for (const t of cron.getTasks().values()) t.stop(); fs.rmSync(DIR, { recursive: true, force: true }); setTimeout(() => process.exit(0), 50).unref(); });

const NOW = Date.now();
const START = new Date(NOW - 8 * 3600e3).toISOString();
// TEST DATA: a made-up game read 30 times before its start, then dropped
test.before(() => {
  const screen = i => ({ games: [{ id: 'pin-e2e-1', start: START, league: 'nfl', leagueLabel: 'NFL', home: 'Test Home', away: 'Test Away', markets: [
    { key: 'ml', point: null, sides: [{ name: 'Test Home', label: 'Test Home', fair: 0.55, venues: [{ venue: 'pinnacle', american: -125 - i }, { venue: 'kalshi', american: -120 - i }] }] },
    { key: 'spread', point: -2.5, sides: [{ name: 'Test Home', label: 'Test Home -2.5', fair: 0.5, venues: [{ venue: 'pinnacle', american: -110 }] }] }] }] });
  const t0 = Date.parse(START) - 30 * 10 * 60e3;
  for (let i = 0; i < 30; i++) srv.oddsHistory.observe(screen(i), t0 + i * 10 * 60e3);
  srv.oddsHistory.prune(NOW);
});

test('a dropped game lands in the archive and the app chart still reads it', async () => {
  assert.equal(srv.oddsHistory.forGame('pin-e2e-1').length, 0);
  assert.equal(srv.lineArchive.gameSeries('pin-e2e-1').length, 2);
  const d = await (await fetch(`${base}/api/odds-screen/history/pin-e2e-1`)).json();
  assert.equal(d.series.length, 2);
  assert.equal(d.page, '/lines/game/pin-e2e-1');
  const st = await (await fetch(`${base}/api/status`)).json();
  assert.equal(st.lineArchive.keepDays, 30);
  assert.equal(st.lineArchive.markets.game, 2);
});

test('/lines lists it and /lines/game/{id} charts it', async () => {
  const idx = await fetch(`${base}/lines?q=test`);
  assert.equal(idx.status, 200);
  const ih = await idx.text();
  assert.match(ih, /Test Away @ Test Home · Moneyline/);
  assert.match(ih, /closed/);
  const r = await fetch(`${base}/lines/game/pin-e2e-1?market=ml&odds=decimal`);
  assert.equal(r.status, 200);
  const h = await r.text();
  assert.match(h, /<svg/);
  assert.match(h, /Saved since/);
  assert.match(h, /Kalshi <em>TX: yes<\/em>/);
  assert.doesNotMatch(h, />(undefined|NaN|null)</);
  // by default only markets a venue open in Texas priced: the spread was read at Pinnacle alone
  assert.doesNotMatch(ih, /Test Away @ Test Home · Spread/);
  assert.match(ih, /1 market priced only elsewhere is left out/);
  assert.match(ih, /href="\/lines\?q=test&amp;venues=all">Show every venue/);
  const all = await (await fetch(`${base}/lines?q=test&venues=all`)).text();
  assert.match(all, /Test Away @ Test Home · Spread/);
  assert.match(all, /Showing markets at every venue we read, TX or not/);
  assert.match(all, /name="venues" value="all"/, 'the search form keeps the toggle');
  assert.match(all, /lr_lines_venues/, 'the toggle is saved in this browser');
  const none = await fetch(`${base}/lines/game/nope`);
  assert.equal(none.status, 404, "an id with no saved prices is a 404");
  assert.match(await none.text(), /No saved prices for this market/);
  const j = await (await fetch(`${base}/api/lines?kind=game`)).json();
  assert.ok(j.rows.some(x => x.key === 'pin-e2e-1' && x.market === 'ml'));
});

test('the downloads: CSV one row per read and venue, JSON by side', async () => {
  const c = await fetch(`${base}/api/lines/game/pin-e2e-1?market=ml&format=csv`);
  assert.equal(c.status, 200);
  assert.match(c.headers.get('content-type'), /text\/csv/);
  assert.match(c.headers.get('content-disposition'), /line-history-pin-e2e-1\.csv/);
  const lines = (await c.text()).trim().split('\n');
  assert.equal(lines[0], 'time_utc,event,league,market,side,line,venue,american,decimal,implied_prob,fair_prob');
  assert.ok(lines.length > 10);
  assert.ok(lines.slice(1).every(l => /,(pinnacle|kalshi),-1\d\d,/.test(l)));
  const j = await (await fetch(`${base}/api/lines/game/pin-e2e-1`)).json();
  assert.equal(j.series.length, 2);
  assert.equal(j.event, 'Test Away @ Test Home');
  assert.equal((await fetch(`${base}/api/lines/game/nope`)).status, 404);
});

test('/api/v1/lines with a key, JSON and CSV; listed on /developers and /pricing', async () => {
  const k = await (await fetch(`${base}/api/v1/keys`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '10.9.0.1' }, body: JSON.stringify({ name: 'lines' }) })).json();
  assert.ok(k.key);
  const H = { 'X-API-Key': k.key };
  const l = await (await fetch(`${base}/api/v1/lines?kind=game`, { headers: H })).json();
  assert.equal(l.keepDays, 30);
  const m = l.markets.find(x => x.key === 'pin-e2e-1' && x.market === 'ml');
  assert.equal(m.history, '/api/v1/lines/game/pin-e2e-1?market=ml');
  const g = await (await fetch(`${base}${m.history}`, { headers: H })).json();
  assert.equal(g.series.length, 1);
  assert.ok(g.series[0].points.length > 0);
  const csv = await fetch(`${base}${m.history}&format=csv`, { headers: H });
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.equal((await fetch(`${base}/api/v1/lines/game/nope`, { headers: H })).status, 404);
  assert.equal((await fetch(`${base}/api/v1/lines/game/pin-e2e-1?format=xml`, { headers: H })).status, 400);
  assert.equal((await fetch(`${base}/api/v1/lines`)).status, 401);
  // the moves history falls back to the archive too
  assert.equal((await fetch(`${base}/api/v1/moves/pin-e2e-1`, { headers: H })).status, 200);
  const dev = await (await fetch(`${base}/developers`)).text();
  assert.match(dev, /\/api\/v1\/lines\/game\/\{gameId\}/);
  assert.match(dev, /id="lines"/);
  const pr = await (await fetch(`${base}/pricing`)).text();
  assert.match(pr, /Line history/);
  const v1 = await (await fetch(`${base}/api/v1`)).json();
  assert.ok(v1.endpoints.some(e => e.path === '/api/v1/lines'));
});
