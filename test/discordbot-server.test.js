// The Discord interactions endpoints on a booted server (axios offline):
// signed sample payloads in, the same public numbers as the API out. The
// owner's app from env; a customer's app connected with an API key.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

function pair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return { hex: publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('hex'), privateKey };
}
const OWNER = pair(), CUSTOMER = pair();
const OWNER_APP = '111111111111111111', CUSTOMER_APP = '222222222222222222';
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lr-bot-'));
for (const k of ['DATABASE_URL', 'ODDS_API_KEY', 'OWLS_API_KEY', 'ALERT_WEBHOOK_URL', 'PAYWALL', 'PUBLIC_URL', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_IDS']) delete process.env[k];
Object.assign(process.env, { LR_DATA_DIR: DIR, TRACKER_FILE: path.join(DIR, 'picks.json'), USERS_FILE: path.join(DIR, 'users.json'), EV_TRACK_FILE: path.join(DIR, 'ev.json'), API_KEYS_FILE: path.join(DIR, 'api-keys.json'),
  OUT_FEED_FILE: path.join(DIR, 'out-feed.json'), ESPORTS_CALIBRATION: 'off',
  DISCORD_APP_ID: OWNER_APP, DISCORD_PUBLIC_KEY: OWNER.hex, DISCORD_BOT_TOKEN: `MTExMTExMTExMTExMTExMTEx.Gab12C.${'y'.repeat(38)}` });
const axios = require('axios');
const puts = [];
axios.get = async () => { throw Object.assign(new Error('offline'), { response: { status: 503 } }); };
axios.post = axios.get;
axios.patch = axios.get;
axios.put = async (url, data, opts) => {
  puts.push({ url, auth: opts?.headers?.Authorization });
  if (/applications\/222222222222222222\/commands$/.test(url) && /good/.test(opts?.headers?.Authorization || '')) return { data };
  throw Object.assign(new Error('nope'), { response: { status: 401 } });
};
const srv = require('../server');
const cron = require('node-cron');
let server, base;
test.before(async () => { server = srv.app.listen(0); await new Promise(r => server.once('listening', r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => { server?.close(); for (const t of cron.getTasks().values()) t.stop(); fs.rmSync(DIR, { recursive: true, force: true }); setTimeout(() => process.exit(0), 50).unref(); });

async function interact(k, obj, p = '/discord/interactions', { sig = null } = {}) {
  const body = JSON.stringify(obj), ts = String(Math.floor(Date.now() / 1000));
  const signature = sig ?? crypto.sign(null, Buffer.from(ts + body), k.privateKey).toString('hex');
  const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Signature-Ed25519': signature, 'X-Signature-Timestamp': ts }, body });
  return { status: r.status, body: await r.json() };
}
const cmd = (name, options = [], extra = {}) => ({ type: 2, id: '1', application_id: OWNER_APP, token: 'itok', guild_id: '999999999999999999', member: { user: { id: '5' }, permissions: '0' }, data: { name, options }, ...extra });
const opt = (name, value) => ({ name, value, type: 3 });

test('a bad or missing signature is refused; a signed PING gets PONG', async () => {
  assert.equal((await interact(OWNER, { type: 1 }, '/discord/interactions', { sig: '' })).status, 401);
  assert.equal((await interact(CUSTOMER, { type: 1 })).status, 401, 'signed with another key');
  const r = await interact(OWNER, { type: 1 });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { type: 1 });
});

test('an empty board: /odds and /props find nothing and make nothing up', async () => {
  const o = await interact(OWNER, cmd('odds', [opt('game', 'hawks')]));
  assert.equal(o.body.type, 4);
  assert.equal(o.body.data.flags, 64);
  assert.match(o.body.data.embeds[0].description, /Nothing on the board/);
  const p = await interact(OWNER, cmd('props', [opt('player', 'mahomes')]));
  assert.match(p.body.data.embeds[0].description, /No props on the board/);
});

test('/odds: a team finds its game, and /settings state:TX keeps the best price to Texas venues', async () => {
  const start = new Date(Date.now() + 5 * 3600e3).toISOString();
  srv.freeBooksState.games = { nfl: [{ id: 'pin-b1', sport_key: 'nfl', commence_time: start, home_team: 'Home Hawks', away_team: 'Away Owls', bookmakers: [
    { key: 'pinnacle', markets: [{ key: 'h2h', outcomes: [{ name: 'Home Hawks', price: -150 }, { name: 'Away Owls', price: 135 }] }] },
    { key: 'gemini', markets: [{ key: 'h2h', outcomes: [{ name: 'Home Hawks', price: -138 }, { name: 'Away Owls', price: 140 }] }] },
    { key: 'fanduel', markets: [{ key: 'h2h', outcomes: [{ name: 'Home Hawks', price: -130 }, { name: 'Away Owls', price: 150 }] }] },
  ] }] };
  srv.freeBooksState.gamesAt = new Date().toISOString();
  let r = await interact(OWNER, cmd('odds', [opt('game', 'owls')]));
  let e = r.body.data.embeds[0];
  assert.equal(e.title, 'Away Owls @ Home Hawks', JSON.stringify(r.body));
  assert.match(e.fields[0].value, /Away Owls: best \*\*FanDuel \+150\*\* · Pinnacle fair/, 'no state: the best at any venue');
  assert.deepEqual(r.body.data.allowed_mentions, { parse: [] });
  assert.ok(r.body.data.components[0].components.every(b => b.style === 5 && b.url.startsWith('https://')), 'link buttons only');
  assert.match(r.body.data.components[0].components[0].url, /\/lines\/game\/pin-b1\?market=ml/);
  // a member without Manage Server can read the settings but not change them
  r = await interact(OWNER, cmd('settings', [opt('state', 'TX')]));
  assert.match(r.body.data.embeds[0].description, /Only someone with Manage Server/);
  r = await interact(OWNER, cmd('settings', [opt('state', 'tx'), opt('odds', 'decimal')], { member: { user: { id: '5' }, permissions: '32' } }));
  assert.match(r.body.data.embeds[0].description, /State: Texas \(TX\)/);
  assert.match(r.body.data.embeds[0].description, /Odds format: decimal/);
  r = await interact(OWNER, cmd('odds', [opt('game', 'owls')]));
  e = r.body.data.embeds[0];
  assert.match(e.fields[0].value, /Away Owls: best \*\*Gemini 2\.40\*\*/, `Texas: FanDuel is not legal there, in decimal: ${e.fields[0].value}`);
  assert.doesNotMatch(e.fields[0].value, /FanDuel/);
  assert.match(e.description, /Texas resident/);
  // another server keeps its own settings
  r = await interact(OWNER, cmd('odds', [opt('game', 'owls')], { guild_id: '888888888888888888' }));
  assert.match(r.body.data.embeds[0].fields[0].value, /FanDuel \+150/);
  r = await interact(OWNER, cmd('settings', [opt('state', 'ZZ')], { member: { user: { id: '5' }, permissions: '8' } }));
  assert.match(r.body.data.embeds[0].description, /not a US state code/);
});

test('/moves, /lines and /record answer from the same bodies as the API', async () => {
  const mv = await interact(OWNER, cmd('moves', [opt('type', 'price')]));
  assert.equal(mv.status, 200);
  assert.ok(mv.body.data.embeds[0].description.length > 0);
  const bad = await interact(OWNER, cmd('moves', [opt('league', 'n f l')]));
  assert.match(bad.body.data.embeds[0].description, /league is not valid/);
  const ln = await interact(OWNER, cmd('lines', [opt('market', 'zzzz')]));
  assert.match(ln.body.data.embeds[0].description, /No market in the line history matches "zzzz"/);
  const rec = await interact(OWNER, cmd('record'));
  const d = rec.body.data.embeds[0].description;
  assert.match(d, /Nothing is proven yet|Proven on the strict rule/);
  assert.doesNotMatch(d, /guaranteed|risk[- ]free/i);
  assert.match(rec.body.data.embeds[0].image.url, /\/card\/record\.png/);
  const who = await interact(OWNER, cmd('record', [opt('handle', '@nobody_here')]));
  assert.match(who.body.data.embeds[0].description, /No public record with the handle @nobody\\_here/);
});

test('a customer\'s own app: connect with a key (token used once), answer at its own URL, spend the key\'s limits', async () => {
  const k = await fetch(`${base}/api/v1/keys`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '10.9.0.7' }, body: JSON.stringify({ name: 'bot' }) }).then(r => r.json());
  const h = { 'X-API-Key': k.key, 'Content-Type': 'application/json' };
  const put = body => fetch(`${base}/api/v1/bot/discord`, { method: 'PUT', headers: h, body: JSON.stringify(body) }).then(async r => ({ status: r.status, body: await r.json() }));
  assert.equal((await interact(CUSTOMER, { type: 1 }, `/discord/interactions/${CUSTOMER_APP}`)).status, 404, 'not connected yet');
  assert.match((await put({ appId: 'x', publicKey: CUSTOMER.hex, botToken: 'a' })).body.error.message, /Application ID/);
  const badTok = await put({ appId: CUSTOMER_APP, publicKey: CUSTOMER.hex, botToken: `MjIyMjIyMjIyMjIyMjIyMjIy.Gab12C.${'b'.repeat(38)}` });
  assert.equal(badTok.status, 400);
  assert.match(badTok.body.error.message, /turned the bot token away/);
  const own = await put({ appId: OWNER_APP, publicKey: CUSTOMER.hex, botToken: `MjIyMjIyMjIyMjIyMjIyMjIy.Gab12C.${'b'.repeat(38)}` });
  assert.equal(own.status, 409);
  const ok = await put({ appId: CUSTOMER_APP, publicKey: CUSTOMER.hex, botToken: `MjIyMjIyMjIyMjIyMjIyMjIy.Gab12C.good${'g'.repeat(34)}` });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.discord.connected, true);
  assert.match(ok.body.discord.endpoint, new RegExp(`/discord/interactions/${CUSTOMER_APP}$`));
  assert.match(ok.body.discord.install, /scope=applications\.commands/);
  assert.ok(puts.some(p => p.url.endsWith(`/applications/${CUSTOMER_APP}/commands`)));
  await new Promise(r => setTimeout(r, 300));
  const files = fs.readdirSync(DIR, { recursive: true }).map(f => path.join(DIR, String(f))).filter(f => fs.statSync(f).isFile());
  assert.ok(files.every(f => !/Gab12C/.test(fs.readFileSync(f, 'utf8'))), 'the bot token is never stored');
  // its interactions: signed with ITS key, refused with the owner's
  assert.equal((await interact(OWNER, { type: 1 }, `/discord/interactions/${CUSTOMER_APP}`)).status, 401);
  assert.deepEqual((await interact(CUSTOMER, { type: 1 }, `/discord/interactions/${CUSTOMER_APP}`)).body, { type: 1 });
  const before = (await fetch(`${base}/api/v1/key`, { headers: h }).then(r => r.json())).usage;
  const o = await interact(CUSTOMER, cmd('odds', [opt('game', 'owls')], { application_id: CUSTOMER_APP }), `/discord/interactions/${CUSTOMER_APP}`);
  assert.equal(o.body.data.embeds[0].title, 'Away Owls @ Home Hawks');
  const after = (await fetch(`${base}/api/v1/key`, { headers: h }).then(r => r.json())).usage;
  assert.ok(JSON.stringify(after) !== JSON.stringify(before), 'the command counted on the key');
  const st = await fetch(`${base}/api/v1/bot`, { headers: h }).then(r => r.json());
  assert.equal(st.discord.connected, true);
  assert.equal(st.commands.length, 6);
  const del = await fetch(`${base}/api/v1/bot/discord`, { method: 'DELETE', headers: h }).then(r => r.json());
  assert.equal(del.discord.connected, false);
  assert.equal((await interact(CUSTOMER, { type: 1 }, `/discord/interactions/${CUSTOMER_APP}`)).status, 404);
});

test('without TELEGRAM_BOT_TOKEN the Telegram webhook is off and nothing is sent', async () => {
  const r = await fetch(`${base}/telegram/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ update_id: 1, message: { message_id: 1, chat: { id: 1, type: 'private' }, text: '/odds owls' } }) });
  assert.equal(r.status, 404);
  const s = await fetch(`${base}/api/status`).then(x => x.json());
  assert.equal(s.telegramBot.on, false);
  assert.equal(s.telegramBot.owner.webhook, null);
});

test('/api/status shows the bot without any secret', async () => {
  const s = await fetch(`${base}/api/status`).then(r => r.json());
  assert.equal(s.discordBot.on, true);
  assert.equal(s.discordBot.owner.appId, OWNER_APP);
  assert.ok(s.discordBot.interactions >= 5);
  assert.doesNotMatch(JSON.stringify(s.discordBot), /Gab12C|yyyy/);
});
