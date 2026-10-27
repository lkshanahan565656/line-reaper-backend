// A bettor's record widget and feed on a server with no live feeds: the
// widget and its API shape, the owner connecting Discord and Telegram with the
// record key, a pick logged before its start posting once with its result
// after, and a customer's Discord adding the handle on /developers. TEST DATA:
// every slip and grade is made up here; Discord and Telegram are stubbed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lr-recfeed-'));
for (const k of ['DATABASE_URL', 'ODDS_API_KEY', 'OWLS_API_KEY', 'ALERT_WEBHOOK_URL', 'PAYWALL', 'DISCORD_WEBHOOK_URLS', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_IDS']) delete process.env[k];
Object.assign(process.env, { PUBLIC_URL: 'https://linereaper.example', LR_DATA_DIR: DIR, TRACKER_FILE: path.join(DIR, 'picks.json'), USERS_FILE: path.join(DIR, 'users.json'), EV_TRACK_FILE: path.join(DIR, 'ev.json'),
  PUB_RECORDS_FILE: path.join(DIR, 'pub.json'), API_KEYS_FILE: path.join(DIR, 'api-keys.json'), OUT_FEED_FILE: path.join(DIR, 'out-feed.json'), ESPORTS_CALIBRATION: 'off' });
const axios = require('axios');
const offline = async () => { throw Object.assign(new Error('offline'), { response: { status: 503 } }); };
axios.get = offline;
axios.post = offline;
const srv = require('../server');
const cron = require('node-cron');
let server, base;
test.before(async () => { server = srv.app.listen(0); await new Promise(r => server.once('listening', r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => { server?.close(); for (const t of cron.getTasks().values()) t.stop(); fs.rmSync(DIR, { recursive: true, force: true }); setTimeout(() => process.exit(0), 50).unref(); });

const call = (u, { method = 'GET', body, key, apiKey } = {}) => fetch(base + u, { method, headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(apiKey ? { 'X-API-Key': apiKey } : {}) }, body: body ? JSON.stringify(body) : undefined });
const HOOK = `https://discord.com/api/webhooks/323456789012345678/${'q'.repeat(68)}`;
const HOOK2 = `https://discord.com/api/webhooks/423456789012345678/${'r'.repeat(68)}`;
const TG = `7654321:${'T'.repeat(35)}`;
const leg = player => ({ player, market: 'Points', side: 'Over', line: 20.5, sport: 'NBA' });
const grade = (start, outcome = null) => ({ status: outcome ? 'graded' : 'open', final: !!outcome, matched: { sport: 'NBA', player: 'X', market: 'Points', start: new Date(start).toISOString(), matchTitle: 'Fake A @ Fake B' },
  decimal: 1.7787, raw: { source: 'pinnacle', fair: 0.57, ev: 3, line: 20.5, exact: true, ok: true }, outcome, result: outcome ? 25 : null, gradeSource: outcome ? 'ESPN box score' : null });
async function gradeAll(h, start, outcome) {
  const res = {};
  for (const l of srv.pubRecords.pendingLegs(h)) res[l.id] = grade(start, outcome);
  await srv.pubRecords.applyGrades(h, res);
}

test('the record widget and its API shape', async () => {
  const pub = await (await call('/api/records', { method: 'POST', body: { handle: 'widget_one' } })).json();
  await srv.pubRecords.addSlips('widget_one', pub.token, [{ id: 'w1', app: 'underdog', legs: [leg('Fake Widget')] }]);
  let r = await fetch(`${base}/embed/record?handle=widget_one&_id=t1`);
  assert.equal(r.status, 200);
  let h = await r.text();
  assert.match(h, /@widget_one · verified record/);
  assert.match(h, /href="https:\/\/linereaper\.example\/r\/widget_one"/);
  assert.ok(!/undefined|NaN/.test(h));
  h = await (await fetch(`${base}/embed/record?handle=nobody_here`)).text();
  assert.match(h, /No published bettor record/);
  // the plain record widget is unchanged
  assert.match(await (await fetch(`${base}/embed/record`)).text(), /Line Reaper record/);
  const k = await (await call('/api/v1/keys', { method: 'POST', body: { name: 'w' } })).json();
  r = await call('/api/v1/records/widget_one', { apiKey: k.key });
  const c = await r.json();
  assert.equal(c.handle, 'widget_one');
  assert.ok(!/"units"|"stake"/.test(JSON.stringify(c)));
  assert.equal((await call('/api/v1/records/nobody_here', { apiKey: k.key })).status, 404);
  assert.equal((await call('/api/v1/records/widget_one')).status, 401);
  const dev = await (await fetch(`${base}/developers`)).text();
  assert.match(dev, /id="widget-bettor"/);
  assert.match(dev, /data-handle=/);
  assert.match(dev, /id="feed-records"/);
});

test('the owner connects Discord and Telegram; a pick logged before its start posts once, its result after', async () => {
  const pub = await (await call('/api/records', { method: 'POST', body: { handle: 'feed_owner' } })).json();
  const K = pub.token;
  assert.equal((await call('/api/records/feed_owner/feed')).status, 403, 'no key');
  let j = await (await call('/api/records/feed_owner/feed', { key: K })).json();
  assert.deepEqual([j.discord.connected, j.telegram.connected], [false, false]);
  let r = await call('/api/records/feed_owner/feed', { method: 'PUT', key: K, body: { discord: 'https://example.com/x' } });
  assert.equal(r.status, 400);
  r = await call('/api/records/feed_owner/feed', { method: 'PUT', key: K, body: { discord: HOOK } });
  assert.match((await r.json()).error, /Could not reach Discord/);
  const posts = [];
  axios.get = async url => (url === HOOK || url === HOOK2 ? { data: { name: 'picks' } } : offline());
  axios.post = async (url, data) => { posts.push({ url, data }); return { data: {} }; };
  try {
    r = await call('/api/records/feed_owner/feed', { method: 'PUT', key: K, body: { discord: HOOK } });
    j = await r.json();
    assert.equal(r.status, 200, JSON.stringify(j));
    assert.equal(j.discord.connected, true);
    assert.ok(!JSON.stringify(j).includes('qqqq'), 'the webhook token is never echoed');
    assert.match(posts[0].data.embeds[0].title, /@feed_owner's record feed connected/);
    r = await call('/api/records/feed_owner/feed', { method: 'PUT', key: K, body: { telegram: { token: TG, chat: '@fake_channel' } } });
    j = await r.json();
    assert.equal(j.telegram.connected, true, JSON.stringify(j));
    assert.ok(!JSON.stringify(j).includes('TTTT'), 'the bot token is never echoed');
    assert.match(posts[1].url, /^https:\/\/api\.telegram\.org\/bot7654321:T+\/sendPhoto$/);
    // a customer's Discord adds the handle (it needs a webhook first)
    const ck = await (await call('/api/v1/keys', { method: 'POST', body: { name: 'c' } })).json();
    r = await call('/api/v1/feed/records', { method: 'PUT', apiKey: ck.key, body: { handles: ['feed_owner'] } });
    assert.equal(r.status, 409);
    await call('/api/v1/feed/discord', { method: 'PUT', apiKey: ck.key, body: { url: HOOK2 } });
    r = await call('/api/v1/feed/records', { method: 'PUT', apiKey: ck.key, body: { handles: ['nobody_here'] } });
    assert.equal(r.status, 404);
    r = await call('/api/v1/feed/records', { method: 'PUT', apiKey: ck.key, body: { handles: '@Feed_Owner', results: false } });
    j = await r.json();
    assert.deepEqual(j.discord.records, { handles: ['feed_owner'], results: false });
    assert.equal((await (await call('/api/records/feed_owner/feed', { key: K })).json()).subscribers, 1);
    await new Promise(res => setTimeout(res, 50));
    // the first read is a baseline: nothing posts
    await srv.feedBettors({ only: 'feed_owner' });
    const before = posts.length;
    await srv.pubRecords.addSlips('feed_owner', K, [{ id: 'p1', app: 'prizepicks', legs: [leg('Fake Pick One'), leg('Fake Pick Two')] }]);
    await srv.feedBettors({ only: 'feed_owner' });
    assert.equal(posts.length, before, 'not matched to a game yet: nothing posts');
    const start = Date.now() + 3 * 3600e3;
    await gradeAll('feed_owner', start);
    await srv.feedBettors({ only: 'feed_owner' });
    const pickPosts = posts.slice(before);
    assert.equal(pickPosts.length, 3, 'one post to the owner\'s Discord, Telegram and the customer\'s Discord');
    const disc = pickPosts.find(p => p.url === `${HOOK}?wait=true`).data.embeds[0];
    assert.equal(disc.title, '@feed_owner logged a pick');
    assert.match(disc.description, /Fake Pick One Over 20\.5 Points/);
    assert.match(disc.description, /by the server, 3 h before the first game/);
    assert.equal(disc.url, 'https://linereaper.example/r/feed_owner');
    assert.equal(JSON.stringify(pickPosts.find(p => p.url === `${HOOK2}?wait=true`).data.embeds[0]), JSON.stringify(disc), 'the same words in every channel');
    await srv.feedBettors({ only: 'feed_owner' });
    assert.equal(posts.length, before + 3, 'a pick posts once');
    await gradeAll('feed_owner', start, 'win');
    await srv.feedBettors({ only: 'feed_owner' });
    const res = posts.slice(before + 3);
    assert.equal(res.length, 3);
    const rd = res.find(p => p.url === `${HOOK}?wait=true`).data.embeds[0];
    assert.match(rd.title, /a pick graded/);
    assert.match(rd.description, /WIN/);
    assert.ok(!/[+-]\d+(\.\d+)?u\b|\$\d/.test(rd.description), 'no units or money');
    // RESULTS posts skip a channel that asked for records only
    const st = await (await fetch(`${base}/api/status`)).json();
    assert.equal(st.outFeed.records.owners, 1);
    assert.equal(st.outFeed.records.subscribed, 1);
    assert.ok(!JSON.stringify(st.outFeed).includes('qqqq') && !JSON.stringify(st.outFeed).includes('TTTT'));
  } finally { axios.get = offline; axios.post = offline; }
  r = await call('/api/records/feed_owner/feed?kind=telegram', { method: 'DELETE', key: K });
  j = await r.json();
  assert.deepEqual([j.discord.connected, j.telegram.connected], [true, false]);
  // unpublish drops the owner's channels
  await call('/api/records/feed_owner', { method: 'DELETE', key: K });
  assert.equal(srv.pubRecords.feedOf('feed_owner'), null);
});
