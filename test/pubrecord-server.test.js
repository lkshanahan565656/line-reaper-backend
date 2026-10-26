// Public bettor records on a server with no feeds: publish, add slips, the
// page, its downloads and card, and unpublish. TEST DATA: the slips are made
// up here; with no feeds nothing grades, so every slip stays "matching".
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lr-pubrec-'));
for (const k of ['DATABASE_URL', 'ODDS_API_KEY', 'OWLS_API_KEY', 'ALERT_WEBHOOK_URL', 'PAYWALL']) delete process.env[k];
Object.assign(process.env, { PUBLIC_URL: 'https://linereaper.example', LR_DATA_DIR: DIR, TRACKER_FILE: path.join(DIR, 'picks.json'), USERS_FILE: path.join(DIR, 'users.json'), EV_TRACK_FILE: path.join(DIR, 'ev.json'),
  PUB_RECORDS_FILE: path.join(DIR, 'pub.json'), ESPORTS_CALIBRATION: 'off' });
const axios = require('axios');
axios.get = async () => { throw Object.assign(new Error('offline'), { response: { status: 503 } }); };
axios.post = axios.get;
const srv = require('../server');
const cron = require('node-cron');
let server, base;
test.before(async () => { server = srv.app.listen(0); await new Promise(r => server.once('listening', r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => { server?.close(); for (const t of cron.getTasks().values()) t.stop(); fs.rmSync(DIR, { recursive: true, force: true }); setTimeout(() => process.exit(0), 50).unref(); });

const post = (u, body, key, method = 'POST') => fetch(base + u, { method, headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) }, body: body ? JSON.stringify(body) : undefined });

test('publish, add slips, read the page, download, card, unpublish', async () => {
  assert.equal((await post('/api/records', { handle: 'x' })).status, 400);
  const r = await post('/api/records', { handle: 'Test_Bettor' });
  assert.equal(r.status, 201);
  const pub = await r.json();
  assert.equal(pub.handle, 'test_bettor');
  assert.equal(pub.url, 'https://linereaper.example/r/test_bettor');
  assert.match(pub.token, /^lrr_/);
  assert.equal((await post('/api/records', { handle: 'test_bettor' })).status, 409);

  const slips = [{ id: 's1', app: 'prizepicks', placedAt: new Date().toISOString(), stake: 20, payout: 120, legs: [{ player: 'Made Up One', market: 'Points', side: 'Over', line: 20.5, sport: 'NBA' }, { player: 'Made Up Two', market: 'Rebounds', side: 'Under', line: 8.5, sport: 'NBA' }] }];
  assert.equal((await post('/api/records/test_bettor/slips', { slips })).status, 403, 'no key');
  const add = await (await post('/api/records/test_bettor/slips', { slips }, pub.token)).json();
  assert.equal(add.added, 1);
  const chk = await (await post('/api/records/test_bettor/check', null, pub.token)).json();
  assert.deepEqual([chk.owner, chk.slips], [true, 1]);

  const v = await (await fetch(`${base}/api/records/test_bettor`)).json();
  assert.equal(v.counts.slips, 1);
  assert.equal(v.slips[0].counted, false);
  assert.ok(!JSON.stringify(v).includes('"stake"'), 'no stake in the public record');

  const page = await fetch(`${base}/r/test_bettor`);
  assert.equal(page.status, 200);
  const h = await page.text();
  assert.match(h, /@test_bettor/);
  assert.match(h, /og:image" content="https:\/\/linereaper\.example\/card\/record-test_bettor\.png\?v=/);
  assert.match(h, /Made Up One/);
  assert.ok(!/undefined|NaN|guaranteed/i.test(h));

  const csv = await fetch(`${base}/api/records/test_bettor/slips.csv`);
  assert.match(csv.headers.get('content-disposition'), /attachment; filename="line-reaper-record-test_bettor-/);
  assert.equal((await csv.text()).trim().split('\n').length, 3);
  const json = await (await fetch(`${base}/api/records/test_bettor/slips.json`)).json();
  assert.equal(json.slips.length, 1);

  const card = await fetch(`${base}/card/record-test_bettor.png`);
  assert.equal(card.status, 200);
  assert.match(card.headers.get('content-type'), /image\/png/);
  assert.equal((await fetch(`${base}/card/record-nobody_here.png`)).status, 404);
  assert.equal((await fetch(`${base}/r/nobody_here`)).status, 404);

  const ops = await (await fetch(`${base}/api/ops`)).json();
  assert.equal(ops.pubRecords.live, 1);

  assert.equal((await post('/api/records/test_bettor', null, null, 'DELETE')).status, 403);
  assert.equal((await post('/api/records/test_bettor', null, pub.token, 'DELETE')).status, 200);
  const gone = await (await fetch(`${base}/r/test_bettor`)).text();
  assert.match(gone, /unpublished/);
  assert.ok(!/Made Up One/.test(gone));
});
