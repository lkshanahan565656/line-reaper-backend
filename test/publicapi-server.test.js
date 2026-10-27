// The public API routes, the widgets and /developers on a server with no
// feeds: keys (made, checked, revoked, never stored), limits, ETags, CORS,
// errors as JSON, and every page answering without a live feed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lr-v1-'));
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

const mkKey = async (name = 'test', ip = '10.0.0.1') => {
  const r = await fetch(`${base}/api/v1/keys`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip }, body: JSON.stringify({ name }) });
  return { status: r.status, body: await r.json() };
};

test('/api/v1 lists the endpoints without a key; data needs one', async () => {
  const idx = await (await fetch(`${base}/api/v1`)).json();
  assert.equal(idx.version, 'v1');
  assert.ok(idx.endpoints.some(e => e.path === '/api/v1/best-prices'));
  const r = await fetch(`${base}/api/v1/leagues`);
  assert.equal(r.status, 401);
  const j = await r.json();
  assert.equal(j.error.code, 'no_key');
  assert.match(j.error.message, /\/developers/);
  const bad = await fetch(`${base}/api/v1/leagues`, { headers: { 'X-API-Key': 'lr_abcdefghijklmnopqrstuvwxyz012345' } });
  assert.equal((await bad.json()).error.code, 'bad_key');
});

test('a key works, is never stored in the clear, reports its usage and can be revoked', async () => {
  const { status, body } = await mkKey('my site', '10.0.0.2');
  assert.equal(status, 201);
  assert.match(body.key, /^lr_/);
  const h = { 'X-API-Key': body.key };
  const r = await fetch(`${base}/api/v1/leagues`, { headers: h });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('x-ratelimit-limit'), '60');
  assert.equal(r.headers.get('x-ratelimit-remaining'), '59');
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
  assert.match(r.headers.get('access-control-expose-headers'), /X-RateLimit-Remaining/);
  const etag = r.headers.get('etag');
  assert.ok(etag);
  const again = await fetch(`${base}/api/v1/leagues`, { headers: { ...h, 'If-None-Match': etag } });
  assert.ok([200, 304].includes(again.status));
  const me = await (await fetch(`${base}/api/v1/key?key=${body.key}`)).json();
  assert.equal(me.key.name, 'my site');
  assert.ok(me.usage.minute >= 2);
  await new Promise(res => setTimeout(res, 200));
  const file = fs.existsSync(path.join(DIR, 'api-keys.json')) ? fs.readFileSync(path.join(DIR, 'api-keys.json'), 'utf8') : '';
  assert.ok(!file.includes(body.key), 'the key is not written anywhere');
  const del = await fetch(`${base}/api/v1/key`, { method: 'DELETE', headers: h });
  assert.equal(del.status, 200);
  assert.equal((await fetch(`${base}/api/v1/leagues`, { headers: h })).status, 401);
});

test('ETag: an unchanged answer is a 304 with no body', async () => {
  const { body } = await mkKey('etag', '10.0.0.3');
  const h = { 'X-API-Key': body.key };
  const r1 = await fetch(`${base}/api/v1/record`, { headers: h });
  assert.equal(r1.status, 200);
  const rec = await r1.json();
  assert.equal(rec.proven, 0, 'nothing is proven on an empty record');
  const r2 = await fetch(`${base}/api/v1/record`, { headers: { ...h, 'If-None-Match': r1.headers.get('etag') } });
  assert.equal(r2.status, 304);
  assert.equal(await r2.text(), '');
});

test('bad parameters, unknown ids and unknown paths answer as JSON errors', async () => {
  const { body } = await mkKey('errors', '10.0.0.4');
  const h = { 'X-API-Key': body.key };
  const cases = [['/api/v1/best-prices?limit=0', 400], ['/api/v1/best-prices?market=parlay', 400], ['/api/v1/moves?window=2d', 400], ['/api/v1/moves/nogame', 404],
    ['/api/v1/leagues/zz9', 404], ['/api/v1/digest/2026-10-20', 400], ['/api/v1/digest/2099-01-05', 404], ['/api/v1/nope', 404]];
  for (const [u, want] of cases) {
    const r = await fetch(`${base}${u}`, { headers: h });
    assert.equal(r.status, want, u);
    assert.ok((await r.json()).error.message, u);
  }
  for (const u of ['/api/v1/best-prices', '/api/v1/moves', '/api/v1/record/flags?limit=5', '/api/v1/digest', '/api/v1/status']) {
    const r = await fetch(`${base}${u}`, { headers: h });
    assert.equal(r.status, 200, u);
  }
  const bp = await (await fetch(`${base}/api/v1/best-prices`, { headers: h })).json();
  assert.equal(bp.stale, true, 'no feed read: said, not filled in');
  assert.deepEqual(bp.rows, []);
});

test('over 60 calls a minute is a 429 with Retry-After', async () => {
  const { body } = await mkKey('busy', '10.0.0.5');
  const h = { 'X-API-Key': body.key };
  let last;
  for (let i = 0; i < 61; i++) last = await fetch(`${base}/api/v1/key`, { headers: h });
  assert.equal(last.status, 429);
  assert.ok(Number(last.headers.get('retry-after')) > 0);
  assert.equal((await last.json()).error.code, 'rate_limited');
});

test('one address makes at most 5 keys an hour', async () => {
  for (let i = 0; i < 5; i++) assert.equal((await mkKey(`k${i}`, '10.9.9.9')).status, 201);
  const sixth = await mkKey('k6', '10.9.9.9');
  assert.equal(sixth.status, 429);
});

test('widgets, embed.js and /developers answer without a feed and without a key', async () => {
  for (const u of ['/embed/best-price?league=nfl&n=3&_id=abc', '/embed/line-move', '/embed/record']) {
    const r = await fetch(`${base}${u}`);
    assert.equal(r.status, 200, u);
    const html = await r.text();
    assert.match(html, /LINE REAPER|FULL RECORD/, u);
    assert.ok(!/guaranteed|risk[- ]free|sure thing/i.test(html), u);
    assert.ok(!r.headers.get('x-frame-options'), 'widgets can be framed');
  }
  assert.match(await (await fetch(`${base}/embed/best-price?league=nfl`)).text(), /have not read in the last few minutes/);
  assert.match(await (await fetch(`${base}/embed/record`)).text(), /Nothing is proven yet/);
  assert.equal((await fetch(`${base}/embed/best-price?n=9`)).status, 400);
  const js = await fetch(`${base}/embed.js`);
  assert.match(js.headers.get('content-type'), /javascript/);
  const dev = await fetch(`${base}/developers`);
  assert.equal(dev.status, 200);
  const html = await dev.text();
  assert.match(html, /Public API and widgets/);
  assert.match(html, /GET \/api\/v1\/best-prices/);
  assert.match(html, /Live example/);
});

test('Discord feed: a key connects its own webhook, gets the welcome post, checks and disconnects it', async () => {
  const HOOK = `https://discord.com/api/webhooks/223456789012345678/${'z'.repeat(68)}`;
  const { body: k } = await mkKey('feed', '10.0.9.1');
  const H = { 'X-API-Key': k.key, 'Content-Type': 'application/json' };
  // no key: refused; nothing connected yet
  assert.equal((await fetch(`${base}/api/v1/feed`)).status, 401);
  let r = await fetch(`${base}/api/v1/feed`, { headers: H });
  let j = await r.json();
  assert.equal(j.discord.connected, false);
  assert.match(j.same, /same posts/);
  // not a Discord webhook: refused before anything is fetched
  r = await fetch(`${base}/api/v1/feed/discord`, { method: 'PUT', headers: H, body: JSON.stringify({ url: 'https://example.com/hook' }) });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error.code, 'bad_parameter');
  // Discord offline: says so
  r = await fetch(`${base}/api/v1/feed/discord`, { method: 'PUT', headers: H, body: JSON.stringify({ url: HOOK }) });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error.message, /Could not reach Discord/);
  // Discord answers: connected, one welcome post with the record card
  const get0 = axios.get, post0 = axios.post;
  const posts = [];
  axios.get = async url => (url === HOOK ? { data: { name: 'line feed', channel_id: '1' } } : get0(url));
  axios.post = async (url, data) => { posts.push({ url, data }); return { data: {} }; };
  try {
    r = await fetch(`${base}/api/v1/feed/discord`, { method: 'PUT', headers: H, body: JSON.stringify({ url: HOOK }) });
    j = await r.json();
    assert.equal(r.status, 200, JSON.stringify(j));
    assert.equal(j.discord.connected, true);
    assert.equal(j.discord.webhook, '…5678');
    assert.ok(!JSON.stringify(j).includes('zzzz'), 'the webhook token is never echoed');
    assert.equal(posts.length, 1);
    assert.equal(posts[0].url, `${HOOK}?wait=true`);
    assert.match(posts[0].data.embeds[0].title, /feed connected/);
    assert.match(posts[0].data.embeds[0].image.url, /\/card\/record\.png$/);
    // a second key cannot connect the same webhook (the channel would get every post twice)
    const { body: k2 } = await mkKey('feed2', '10.0.9.2');
    r = await fetch(`${base}/api/v1/feed/discord`, { method: 'PUT', headers: { ...H, 'X-API-Key': k2.key }, body: JSON.stringify({ url: HOOK }) });
    assert.equal(r.status, 409);
    // the server's status counts it, without the URL
    const st = await (await fetch(`${base}/api/status`)).json();
    assert.equal(st.outFeed.customers, 1);
    assert.equal(st.outFeed.on, true);
    assert.ok(!JSON.stringify(st.outFeed).includes('zzzz'));
  } finally { axios.get = get0; axios.post = post0; }
  r = await fetch(`${base}/api/v1/feed/discord`, { method: 'DELETE', headers: H });
  j = await r.json();
  assert.equal(j.discord.connected, false);
  assert.equal((await (await fetch(`${base}/api/status`)).json()).outFeed.customers, 0);
  // the docs page explains it
  const html = await (await fetch(`${base}/developers`)).text();
  assert.match(html, /id="feed"/);
  assert.match(html, /Copy Webhook URL/);
  assert.match((await (await fetch(`${base}/api/v1`)).json()).feed.connect, /PUT \/api\/v1\/feed\/discord/);
});

test('the feed jobs run with nobody connected: the record check keeps a baseline, moves and owner check send nothing', async () => {
  const posts = [];
  const post0 = axios.post;
  axios.post = async (url, data) => { posts.push(url); return { data } };
  try {
    const r = await srv.feedRecordCheck();
    assert.deepEqual(r, { changes: 0, sent: 0 });
    assert.ok(srv.outFeedStatus().record.checkedAt);
    assert.equal(await srv.feedMoves(), null);
    assert.equal(await srv.feedOwnerCheck(), null);
    assert.equal(posts.length, 0);
  } finally { axios.post = post0; }
});
