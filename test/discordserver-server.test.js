// The owned Discord server: each owner channel gets only the topics it names
// (record=, alerts=, ...), alerts reach the alert channel with the same text
// the webhook and phone push send, /discord goes to the invite, and the pages
// show a JOIN link only when the invite is set.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lr-discordsrv-'));
const HOOK = id => `https://discord.com/api/webhooks/${id}/${'k'.repeat(68)}`;
for (const k of ['DATABASE_URL', 'ODDS_API_KEY', 'OWLS_API_KEY', 'ALERT_WEBHOOK_URL', 'PUBLIC_URL', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_IDS']) delete process.env[k];
Object.assign(process.env, { LR_DATA_DIR: DIR, TRACKER_FILE: path.join(DIR, 'picks.json'), USERS_FILE: path.join(DIR, 'users.json'), EV_TRACK_FILE: path.join(DIR, 'ev.json'),
  SPORT_PROPS_FILE: path.join(DIR, 'sport-props.json'), OUT_FEED_FILE: path.join(DIR, 'out-feed.json'), PUSH_FILE: path.join(DIR, 'push.json'), ALERT_LOG_FILE: path.join(DIR, 'alert-log.json'), ESPORTS_CALIBRATION: 'off',
  DISCORD_WEBHOOK_URLS: `record+digest=${HOOK('111111111111111111')},moves=${HOOK('222222222222222222')},alerts=${HOOK('333333333333333333')},tail=${HOOK('444444444444444444')}`,
  DISCORD_INVITE_URL: 'https://discord.com/invite/lineReaper', DISCORD_ALERT_DELAY_MIN: '0' });
const axios = require('axios');
const posts = [];
axios.get = async () => { throw Object.assign(new Error('offline'), { response: { status: 503 } }); };
axios.post = async (url, data) => {
  if (/discord\.com\/api\/webhooks/.test(url)) { posts.push({ url, data }); return { status: 200, data: {} }; }
  throw Object.assign(new Error('offline'), { response: { status: 503 } });
};
const srv = require('../server');
const cron = require('node-cron');
let server, base;
test.before(async () => { server = srv.app.listen(0); await new Promise(r => server.once('listening', r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => { server?.close(); for (const t of cron.getTasks().values()) t.stop(); fs.rmSync(DIR, { recursive: true, force: true }); setTimeout(() => process.exit(0), 50).unref(); });

const hookOf = p => /webhooks\/(\d+)\//.exec(p.url)[1].slice(0, 1);

test('/discord goes to the invite, and status says which channel carries what', async () => {
  const r = await fetch(`${base}/discord`, { redirect: 'manual' });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), 'https://discord.gg/lineReaper');
  const s = await (await fetch(`${base}/api/status`)).json();
  assert.equal(s.community.discord, 'https://discord.gg/lineReaper');
  const o = srv.outFeedStatus().owner;
  assert.deepEqual(o.channels.map(c => c.topics), [['digest', 'record'], ['moves'], ['ev', 'sharp', 'exchange', 'tail', 'esports', 'gas', 'other'], ['tail']]);
  assert.equal(o.invite, true);
  assert.equal(o.alerts.delayMin, 0);
  assert.equal(o.alerts.channels, 2);
  assert.deepEqual(o.problems, []);
  const st = JSON.stringify(s);
  assert.ok(!/webhooks\/\d+/.test(st) && !st.includes('k'.repeat(68)), 'status never shows a webhook URL');
});

test('the sales page links the Discord and the install steps', async () => {
  const html = await (await fetch(`${base}/`, { headers: { Accept: 'text/html' } })).text();
  assert.match(html, /<a class="btn" href="\/discord">Join the Discord<\/a>/);
  assert.match(html, /<a href="\/discord">Discord<\/a>/);
  assert.match(html, /href="\/app\?start=install"/);
  assert.ok(!html.includes('{{DISCORD'), 'every placeholder is filled');
});

test('each channel gets its welcome post naming only what it carries', async () => {
  posts.length = 0;
  const r = await srv.feedOwnerCheck();
  assert.equal(r.channels.length, 4);
  assert.ok(r.channels.every(c => c.ok));
  const by = Object.fromEntries(posts.map(p => [hookOf(p), p.data.embeds[0].description]));
  assert.match(by[1], /weekly record digest/); assert.match(by[1], /record changes/); assert.doesNotMatch(by[1], /line moves|alerts:/);
  assert.match(by[2], /biggest line moves/); assert.doesNotMatch(by[2], /digest/);
  assert.match(by[3], /alerts: every kind the tracker sends, as they go out/);
  assert.match(by[4], /alerts: Sharp Tail, second chances and fresh wallets/);
});

test('an alert reaches the channels that carry its kind, with the same text, and nothing else', async () => {
  posts.length = 0;
  await srv.webhook.send('Pinnacle moved NYJ +3 to +1.5 <https://example.com/x>', 'Sharp alerts');
  await srv.webhook.send('Big account bought YES 62c on CHI', 'Tail alerts');
  await srv.webhook.send('Line Reaper is live.', 'Startup');
  await srv.ownerAlerts.flush();
  const to = posts.map(hookOf).sort();
  assert.deepEqual(to, ['3', '4'], 'the all-alerts channel once (both grouped), the tail channel once; never the feed channels');
  const all = posts.find(p => hookOf(p) === '3').data;
  assert.match(all.embeds[0].description, /Pinnacle moved NYJ \+3 to \+1\.5/);
  assert.match(all.embeds[0].description, /Big account bought YES 62c on CHI/);
  assert.doesNotMatch(all.embeds[0].description, /Line Reaper is live/);
  assert.deepEqual(all.allowed_mentions, { parse: [] });
  const tail = posts.find(p => hookOf(p) === '4').data;
  assert.doesNotMatch(tail.embeds[0].description, /Pinnacle/);
  const st = srv.ownerAlerts.stats();
  assert.equal(st.pending, 0);
  assert.equal(st.posted, 2);
});
