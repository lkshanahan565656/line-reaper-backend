// The weekly digest routes: /api/digest lists the weeks (this week so far and
// the ones before), /api/digest/<week> one week, /digest/<week> the public
// share page; the Monday send freezes the week once and pushes it once.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lr-digest-'));
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

test('/api/digest lists this week so far first, and a week reads as rebuilt until it is published', async () => {
  const r = await fetch(`${base}/api/digest`);
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.weeks[0].partial, true);
  assert.equal(d.sendsAt, 'Monday 13:00 UTC');
  const w = await (await fetch(`${base}/api/digest/${d.weeks[0].week}`)).json();
  assert.equal(w.frozen, false);
  assert.equal(w.digest.week, d.weeks[0].week);
  assert.equal(w.share, `/digest/${d.weeks[0].week}`);
  assert.equal((await fetch(`${base}/api/digest/2026-10-20`)).status, 400, 'not a Monday');
  assert.equal((await fetch(`${base}/api/digest/2099-01-05`)).status, 404, 'not started');
});

test('the Monday send freezes the week, pushes once, and the share page shows what was sent', async () => {
  const sent = [];
  const orig = srv.push.send;
  srv.push.send = async (text, what) => { sent.push({ text, what }); return 3; };
  try {
    const mon = Date.parse('2026-10-26T13:00:00Z');
    assert.equal(await srv.publishDigest(mon - 60e3), null, 'not before 13:00 UTC');
    const out = await srv.publishDigest(mon);
    assert.equal(out.week, '2026-10-19');
    assert.equal(out.pushSent, 3);
    assert.equal(await srv.publishDigest(mon + 3600e3), null, 'the next hour does not send it again');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].what, 'Weekly record');
    assert.match(sent[0].text, /^Week of Oct 19 to 25: /);
    assert.match(sent[0].text, /\/digest\/2026-10-19$/);
    const w = await (await fetch(`${base}/api/digest/2026-10-19`)).json();
    assert.equal(w.frozen, true);
    assert.equal(w.pushed, 3);
    const list = await (await fetch(`${base}/api/digest`)).json();
    if (list.weeks.some(x => x.week === '2026-10-19')) assert.equal(list.weeks.find(x => x.week === '2026-10-19').frozen, true);
    const page = await fetch(`${base}/digest/2026-10-19`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /Week of Oct 19 to 25/);
    assert.match(html, /frozen: this is what was sent/);
    // a late send (a deploy past Monday night) freezes without buzzing anyone
    const late = await srv.publishDigest(Date.parse('2026-11-03T02:00:00Z'));
    assert.equal(late.week, '2026-10-26');
    assert.equal(late.pushSent, null);
    assert.equal(sent.length, 1);
  } finally { srv.push.send = orig; }
  assert.equal((await fetch(`${base}/digest/not-a-week`)).status, 404);
  const rd = await fetch(`${base}/digest`, { redirect: 'manual' });
  assert.equal(rd.status, 302);
  assert.match(rd.headers.get('location'), /^\/digest\/\d{4}-\d{2}-\d{2}$/);
});
