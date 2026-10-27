// The alert history routes: an alert sent through the site's webhook lands in
// the log and shows on /api/alerts/history, /alerts, the share card and the
// public API's endpoint list; status says when storing began.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lr-alertlog-'));
for (const k of ['DATABASE_URL', 'ODDS_API_KEY', 'OWLS_API_KEY', 'ALERT_WEBHOOK_URL', 'PUBLIC_URL', 'PAYWALL']) delete process.env[k];
Object.assign(process.env, { LR_DATA_DIR: DIR, TRACKER_FILE: path.join(DIR, 'picks.json'), USERS_FILE: path.join(DIR, 'users.json'), EV_TRACK_FILE: path.join(DIR, 'ev.json'),
  SPORT_PROPS_FILE: path.join(DIR, 'sport-props.json'), ALERT_LOG_FILE: path.join(DIR, 'alert-log.json'), ESPORTS_CALIBRATION: 'off' });
const axios = require('axios');
axios.get = async () => { throw Object.assign(new Error('offline'), { response: { status: 503 } }); };
axios.post = axios.get;
const srv = require('../server');
const cron = require('node-cron');
let server, base;
test.before(async () => { server = srv.app.listen(0); await new Promise(r => server.once('listening', r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => { server?.close(); for (const t of cron.getTasks().values()) t.stop(); fs.rmSync(DIR, { recursive: true, force: true }); setTimeout(() => process.exit(0), 50).unref(); });

test('an alert sent through the site is kept, listed with its bet, and the pages show it', async () => {
  const start = new Date(Date.now() + 6 * 3600e3).toISOString();
  const row = { group: 'nba|test|h2h', side: 'Celtics', book: 'betrivers', decimal: 2.1, price: 110, ev: 6, sport: 'nba', event: 'Lakers @ Celtics', market: 'h2h', start };
  await srv.webhook.send('New edge +6.0%: Celtics +110 at BetRivers <https://example.com/x>', 'EV alerts', { items: [require('../alertlog').evItem(row)] });
  await srv.webhook.send('Arb 2.1%: both sides', 'Exchange arbs');
  const r = await fetch(`${base}/api/alerts/history`);
  assert.equal(r.status, 200);
  const v = await r.json();
  assert.equal(v.summary.alerts, 2);
  assert.match(v.note, /Alerts are kept from /);
  const ev = v.alerts.find(a => a.title === 'EV alerts');
  assert.equal(ev.masked, false, 'with the paywall off everyone sees the alert');
  assert.deepEqual(ev.lines, ['New edge +6.0%: Celtics +110 at BetRivers'], 'links are not kept');
  assert.equal(ev.items[0].state, 'open');
  assert.equal(ev.items[0].priceAmerican, 110);
  assert.match(v.alerts.find(a => a.title === 'Exchange arbs').why, /no close to beat/);
  assert.equal((await (await fetch(`${base}/api/alerts/history?kind=ev`)).json()).alerts.length, 1);

  const page = await fetch(`${base}/alerts`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Every alert we sent, graded/);
  assert.match(html, /Lakers @ Celtics/);

  const card = await fetch(`${base}/card/alerts.svg`);
  assert.equal(card.status, 200);
  assert.match(await card.text(), /ALERT HISTORY/);
  assert.equal((await fetch(`${base}/share/alerts`)).status, 200);

  const api = await (await fetch(`${base}/api/v1`)).json();
  assert.ok(api.endpoints.some(e => e.path === '/api/v1/alerts'));
  const st = await (await fetch(`${base}/api/status`)).json();
  assert.ok(st.alertLog.startedAt);
  assert.equal(st.alertLog.recorded, 2);
});
