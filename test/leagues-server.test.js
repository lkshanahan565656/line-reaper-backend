// League pages on a booted server (axios offline): /nfl reads the free-books
// board, /esports/lol the esports board, /leagues lists them, and the sitemap
// and robots carry every path.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lr-leagues-'));
for (const k of ['DATABASE_URL', 'ODDS_API_KEY', 'OWLS_API_KEY', 'ALERT_WEBHOOK_URL', 'PAYWALL', 'PUBLIC_URL']) delete process.env[k];
Object.assign(process.env, { TRACKER_FILE: path.join(DIR, 'picks.json'), USERS_FILE: path.join(DIR, 'users.json'), EV_TRACK_FILE: path.join(DIR, 'ev.json'), ESPORTS_CALIBRATION: 'off' });
const axios = require('axios');
axios.get = async () => { throw Object.assign(new Error('offline'), { response: { status: 503 } }); };
axios.post = axios.get;
const srv = require('../server');
const L = require('../leagues');
const cron = require('node-cron');
let server, base;
test.before(async () => { server = srv.app.listen(0); await new Promise(r => server.once('listening', r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => { server?.close(); for (const t of cron.getTasks().values()) t.stop(); fs.rmSync(DIR, { recursive: true, force: true }); setTimeout(() => process.exit(0), 50).unref(); });
const page = async p => { const r = await fetch(base + p); return { status: r.status, type: r.headers.get('content-type'), cache: r.headers.get('cache-control'), text: await r.text() }; };

test('an NFL page shows a Texas exchange above Pinnacle\'s fair and drops sportsbooks Texas cannot use', async () => {
  const start = new Date(Date.now() + 5 * 3600e3).toISOString();
  srv.freeBooksState.games = { nfl: [{ id: 'pin-lg1', sport_key: 'nfl', commence_time: start, home_team: 'Home Hawks', away_team: 'Away Owls', bookmakers: [
    { key: 'pinnacle', markets: [{ key: 'h2h', outcomes: [{ name: 'Home Hawks', price: -150 }, { name: 'Away Owls', price: 135 }] }] },
    { key: 'gemini', markets: [{ key: 'h2h', outcomes: [{ name: 'Home Hawks', price: -138 }, { name: 'Away Owls', price: 140 }] }] },
    { key: 'fanduel', markets: [{ key: 'h2h', outcomes: [{ name: 'Home Hawks', price: -130 }, { name: 'Away Owls', price: 150 }] }] },
  ] }] };
  srv.freeBooksState.gamesAt = new Date().toISOString();
  srv.shopState.key = null; srv.shopState.builtAt = null;
  // first in this file: the page memo holds a page 60 s
  const r = await fetch(base + '/nfl').then(x => x.text());
  assert.match(r, /games, 48 h/);
  assert.match(r, /Texas venues on this board: Gemini/);
  assert.doesNotMatch(r, /Texas venues on this board:[^<]*FanDuel/);
  assert.match(r, /Away Owls[\s\S]*Gemini[\s\S]*research/, 'Gemini +140 over a +135 fair is listed, labelled research');
  assert.doesNotMatch(r, /<td>FanDuel<\/td>/, 'FanDuel is not a Texas venue');
});

test('every league page and the index render with no broken numbers, even with an empty board', async () => {
  for (const p of ['/leagues', ...L.ORDER.map(k => L.LEAGUES[k].path)]) {
    const r = await page(p);
    assert.equal(r.status, 200, p);
    assert.match(r.type, /html/);
    assert.match(r.cache, /max-age=60/);
    assert.match(r.text, /<h1>/);
    assert.match(r.text, new RegExp(`<link rel="canonical" href="https?://127\\.0\\.0\\.1:\\d+${p.replace(/\//g, '\\/')}">`));
    assert.ok(!/NaN|undefined|Infinity|>null</.test(r.text), `${p}: a number did not compute`);
    assert.match(r.text, /Nothing is proven yet|could not be read/, `${p}: nothing is proven on an empty record`);
  }
  assert.equal((await page('/esports/nope')).status, 404);
});

test('the sitemap, robots and the sales page footer carry the league pages', async () => {
  const map = await page('/sitemap.xml');
  for (const k of L.ORDER) assert.ok(map.text.includes(`${L.LEAGUES[k].path}</loc>`), `sitemap has ${k}`);
  assert.match(map.text, /\/leagues<\/loc>/);
  const robots = await page('/robots.txt');
  assert.match(robots.text, /Allow: \/nfl\n/);
  assert.match(robots.text, /Allow: \/esports\/dota2\n/);
  assert.match(robots.text, /Disallow: \/api\//);
  const landing = fs.readFileSync(path.join(__dirname, '..', 'public', 'landing.html'), 'utf8');
  assert.match(landing, /href="\/leagues"/);
  for (const k of ['nfl', 'nba', 'soccer']) assert.ok(landing.includes(`href="${L.LEAGUES[k].path}"`), `the sales page footer links ${k}`);
});
