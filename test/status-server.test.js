// /status and /api/uptime on the real server: every venue gets a row, with no
// read yet a feed is down (never up), and /status is in robots and the sitemap.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lr-status-'));
for (const k of ['DATABASE_URL', 'ODDS_API_KEY', 'OWLS_API_KEY', 'ALERT_WEBHOOK_URL', 'PUBLIC_URL']) delete process.env[k];
Object.assign(process.env, { LR_DATA_DIR: DIR, TRACKER_FILE: path.join(DIR, 'picks.json'), USERS_FILE: path.join(DIR, 'users.json'), EV_TRACK_FILE: path.join(DIR, 'ev.json'),
  SPORT_PROPS_FILE: path.join(DIR, 'sport-props.json'), DIGEST_FILE: path.join(DIR, 'digest.json'), ESPORTS_CALIBRATION: 'off' });
const axios = require('axios');
axios.get = async () => { throw Object.assign(new Error('offline'), { response: { status: 503 } }); };
axios.post = axios.get;
const srv = require('../server');
const cron = require('node-cron');
let server, base;
test.before(async () => { server = srv.app.listen(0); await new Promise(r => server.once('listening', r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => { server?.close(); for (const t of cron.getTasks().values()) t.stop(); fs.rmSync(DIR, { recursive: true, force: true }); setTimeout(() => process.exit(0), 50).unref(); });

test('/api/uptime lists every venue we read, none up while offline', async () => {
  const r = await fetch(`${base}/api/uptime`);
  assert.equal(r.status, 200);
  const v = await r.json();
  assert.equal(v.version, require('../package.json').version);
  const keys = v.feeds.map(f => f.key);
  for (const k of ['pinnacle', 'kalshi', 'polymarketUs', 'fanduel', 'betrivers', 'prizepicks', 'underdog', 'sleeper', 'pick6', 'gemini', 'grader', 'backup']) assert.ok(keys.includes(k), k);
  assert.ok(v.feeds.every(f => f.state !== 'up'), 'offline: nothing has read');
  assert.ok(v.feeds.every(f => ['down', 'off', 'stale'].includes(f.state)));
  assert.equal(v.site.uptime24h, null);
});

test('/status renders the page, and a sample feeds the history', async () => {
  srv.statusBoard.sample();
  const html = await (await fetch(`${base}/status`)).text();
  assert.match(html, /<title>Status \| Line Reaper<\/title>/);
  assert.match(html, /Polymarket US/);
  assert.match(html, /PrizePicks/);
  const v = await (await fetch(`${base}/api/uptime`)).json();
  assert.equal(v.site.samples, 1);
  assert.match(await (await fetch(`${base}/robots.txt`)).text(), /Allow: \/status/);
  assert.match(await (await fetch(`${base}/sitemap.xml`)).text(), /\/status<\/loc>/);
});
