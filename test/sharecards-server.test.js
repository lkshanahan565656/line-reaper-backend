// Share cards on a server with no feeds: every card answers as a PNG (with
// its empty state), the share pages and /results carry Open Graph and Twitter
// tags pointing at the card, and /app and the digest weeks get the card image.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lr-cards-'));
for (const k of ['DATABASE_URL', 'ODDS_API_KEY', 'OWLS_API_KEY', 'ALERT_WEBHOOK_URL', 'PAYWALL']) delete process.env[k];
Object.assign(process.env, { PUBLIC_URL: 'https://linereaper.example', LR_DATA_DIR: DIR, TRACKER_FILE: path.join(DIR, 'picks.json'), USERS_FILE: path.join(DIR, 'users.json'), EV_TRACK_FILE: path.join(DIR, 'ev.json'),
  SPORT_PROPS_FILE: path.join(DIR, 'sport-props.json'), DIGEST_FILE: path.join(DIR, 'digest.json'), API_KEYS_FILE: path.join(DIR, 'api-keys.json'), ESPORTS_CALIBRATION: 'off' });
const axios = require('axios');
axios.get = async () => { throw Object.assign(new Error('offline'), { response: { status: 503 } }); };
axios.post = axios.get;
const srv = require('../server');
const cron = require('node-cron');
let server, base;
test.before(async () => { server = srv.app.listen(0); await new Promise(r => server.once('listening', r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => { server?.close(); for (const t of cron.getTasks().values()) t.stop(); fs.rmSync(DIR, { recursive: true, force: true }); setTimeout(() => process.exit(0), 50).unref(); });

const png = async u => {
  const r = await fetch(base + u);
  const b = Buffer.from(await r.arrayBuffer());
  return { status: r.status, type: r.headers.get('content-type'), b, r };
};

test('every card kind answers as a 1200x630 PNG, even with no feeds', async () => {
  for (const u of ['/card/record.png', '/card/price.png', '/card/price.png?id=nope', '/card/move.png?game=nope', '/card/move.png', '/card/league.png?league=nfl', '/card/league.png?league=dota2', '/card/digest.png?week=2026-10-19']) {
    const { status, type, b } = await png(u);
    assert.equal(status, 200, u);
    assert.match(type, /image\/png/, u);
    assert.equal(b.subarray(1, 4).toString(), 'PNG', u);
    assert.equal(b.readUInt32BE(16), 1200, u);
  }
  const svg = await fetch(`${base}/card/record.svg`);
  assert.match(svg.headers.get('content-type'), /svg/);
  assert.match(await svg.text(), /Nothing is proven yet/);
});

test('a download asks the browser to save the image; unknown kinds and leagues are 404', async () => {
  const d = await fetch(`${base}/card/record.png?download=1`);
  assert.match(d.headers.get('content-disposition'), /attachment; filename="line-reaper-record-/);
  assert.equal((await fetch(`${base}/card/nope.png`)).status, 404);
  assert.equal((await fetch(`${base}/card/record.gif`)).status, 404);
  assert.equal((await fetch(`${base}/card/league.png?league=xfl`)).status, 404);
  assert.equal((await fetch(`${base}/card/digest.png?week=2026-10-20`)).status, 404, 'a week is the date of its Monday');
});

test('share pages and /results unfurl with the card', async () => {
  for (const [u, kind] of [['/results', 'record'], ['/share/record', 'record'], ['/share/league?league=nfl', 'league'], ['/share/price?id=x', 'price'], ['/share/move?game=x&market=ml&side=Home', 'move'], ['/share/digest?week=2026-10-19', 'digest']]) {
    const r = await fetch(base + u);
    assert.equal(r.status, 200, u);
    const h = await r.text();
    assert.match(h, new RegExp(`<meta property="og:image" content="https://linereaper\\.example/card/${kind}\\.png\\?`), u);
    assert.match(h, /<meta name="twitter:card" content="summary_large_image">/, u);
    assert.match(h, /twitter:image/, u);
    assert.ok(!/undefined|NaN|guaranteed/i.test(h), `${u} has broken text or a claim`);
  }
  const res = await (await fetch(`${base}/results`)).text();
  assert.match(res, /href="\/app\?start=results"/);
  assert.match(res, /Nothing is proven yet/);
  const lg = await (await fetch(`${base}/share/league?league=nfl`)).text();
  assert.match(lg, /href="\/nfl"/);
  assert.match(lg, /og:image" content="https:\/\/linereaper\.example\/card\/league\.png\?league=nfl&amp;v=/);
  const to = await (await fetch(`${base}/share/record?to=${encodeURIComponent('#lr&t=results')}`)).text();
  assert.match(to, /href="\/app#lr&amp;t=results"/);
  const evil = await (await fetch(`${base}/share/record?to=${encodeURIComponent('javascript:alert(1)')}`)).text();
  assert.ok(!evil.includes('javascript:'));
});

test('/app and digest weeks carry the card image; their own titles stay', async () => {
  const app = await (await fetch(`${base}/app`)).text();
  if (!/App not bundled/.test(app)) {
    assert.match(app, /og:image" content="https:\/\/linereaper\.example\/card\/record\.png\?v=/);
    assert.match(app, /twitter:card/);
  }
  const wk = await (await fetch(`${base}/digest/2026-10-19`)).text();
  assert.match(wk, /og:image" content="https:\/\/linereaper\.example\/card\/digest\.png\?week=2026-10-19&amp;v=/);
  assert.match(wk, /og:title" content="Line Reaper record: week of Oct 19 to 25"/);
  assert.equal((wk.match(/og:image"/g) || []).length, 1, 'the logo image tag is replaced, not doubled');
  assert.ok(!/\/og\.png/.test(wk));
});
