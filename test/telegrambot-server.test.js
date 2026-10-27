// The Telegram webhook on a booted server (axios offline, Telegram faked):
// sample Telegram updates in, sendMessage bodies with the same public numbers
// as the Discord bot and the API out. The owner's bot from TELEGRAM_BOT_TOKEN;
// a customer's bot connected with an API key.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const OWNER_TOKEN = `111111111:${'O'.repeat(35)}`, CUSTOMER_TOKEN = `222222222:${'C'.repeat(35)}`, BAD_TOKEN = `333333333:${'B'.repeat(35)}`;
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lr-tg-'));
for (const k of ['DATABASE_URL', 'ODDS_API_KEY', 'OWLS_API_KEY', 'ALERT_WEBHOOK_URL', 'PAYWALL', 'PUBLIC_URL', 'TELEGRAM_CHAT_IDS', 'DISCORD_APP_ID', 'DISCORD_PUBLIC_KEY', 'DISCORD_BOT_TOKEN']) delete process.env[k];
Object.assign(process.env, { LR_DATA_DIR: DIR, TRACKER_FILE: path.join(DIR, 'picks.json'), USERS_FILE: path.join(DIR, 'users.json'), EV_TRACK_FILE: path.join(DIR, 'ev.json'), API_KEYS_FILE: path.join(DIR, 'api-keys.json'),
  OUT_FEED_FILE: path.join(DIR, 'out-feed.json'), ESPORTS_CALIBRATION: 'off', TELEGRAM_BOT_TOKEN: OWNER_TOKEN, FEED_SECRET: 'test-feed-secret' });
const axios = require('axios');
const tgCalls = [];
let member = 'member';
axios.get = async () => { throw Object.assign(new Error('offline'), { response: { status: 503 } }); };
axios.put = axios.get;
axios.patch = axios.get;
axios.post = async (url, data) => {
  const m = /^https:\/\/api\.telegram\.org\/bot(\d+):[\w-]+\/(\w+)$/.exec(url);
  if (!m) throw Object.assign(new Error('offline'), { response: { status: 503 } });
  const [, id, method] = m;
  tgCalls.push({ id, method, data, url });
  if (id === '333333333') throw Object.assign(new Error('Unauthorized'), { response: { status: 401, data: { ok: false, error_code: 401, description: 'Unauthorized' } } });
  if (method === 'getMe') return { data: { ok: true, result: { id: Number(id), is_bot: true, username: id === '111111111' ? 'LineReaperOwnerBot' : 'CustomerOddsBot' } } };
  if (method === 'getChatMember') return { data: { ok: true, result: { status: member } } };
  if (method === 'getWebhookInfo') return { data: { ok: true, result: { url: '' } } };
  return { data: { ok: true, result: true } };
};
const srv = require('../server');
const tg = require('../telegrambot');
const cron = require('node-cron');
let server, base;
test.before(async () => { server = srv.app.listen(0); await new Promise(r => server.once('listening', r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => { server?.close(); for (const t of cron.getTasks().values()) t.stop(); fs.rmSync(DIR, { recursive: true, force: true }); setTimeout(() => process.exit(0), 50).unref(); });

let n = 1000;
async function update(text, { token = OWNER_TOKEN, p = '/telegram/webhook', chat = { id: -100777, type: 'supergroup', title: 'Picks' }, secret = null, extra = {} } = {}) {
  const before = tgCalls.length;
  const body = { update_id: ++n, message: { message_id: n, date: Math.floor(Date.now() / 1000), chat, from: { id: 42, is_bot: false, first_name: 'L' }, text, ...extra } };
  const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': secret ?? tg.secretOf(token) }, body: JSON.stringify(body) });
  const out = { status: r.status, body: await r.json() };
  // the reply goes out after Telegram has its 200
  for (let i = 0; i < 100 && !tgCalls.slice(before).some(c => c.method === 'sendMessage'); i++) await new Promise(res => setTimeout(res, 20));
  out.sent = tgCalls.slice(before).filter(c => c.method === 'sendMessage').map(c => c.data);
  out.calls = tgCalls.slice(before);
  return out;
}

test('the owner\'s webhook: wrong secret refused, chatter ignored, the menu and webhook set on connect', async () => {
  assert.equal((await update('/odds owls', { secret: 'nope' })).status, 401);
  assert.equal((await update('/odds owls', { token: CUSTOMER_TOKEN })).status, 401, 'a secret from another token');
  const chatter = await update('good morning');
  assert.equal(chatter.status, 200);
  assert.equal(chatter.sent.length, 0);
  const c = await srv.tgConnectOwner();
  assert.equal(c.ok, true, JSON.stringify(c));
  const wh = tgCalls.find(x => x.method === 'setWebhook' && x.id === '111111111').data;
  assert.equal(wh.url, 'https://line-reaper-backend-production.up.railway.app/telegram/webhook');
  assert.equal(wh.secret_token, tg.secretOf(OWNER_TOKEN));
  assert.ok(tgCalls.some(x => x.method === 'setMyCommands'));
  // a second boot with the same URL and menu sets nothing again
  const sets = tgCalls.filter(x => x.method === 'setWebhook').length;
  tgCalls.push({ id: 'x', method: 'marker' });
  axios.post = (orig => async (url, data) => (url.endsWith('/getWebhookInfo') ? { data: { ok: true, result: { url: wh.url } } } : orig(url, data)))(axios.post);
  await srv.tgConnectOwner();
  assert.equal(tgCalls.filter(x => x.method === 'setWebhook').length, sets);
});

test('/odds in a group: the same best prices as the Discord bot, then /settings TX by an admin keeps Texas venues', async () => {
  const start = new Date(Date.now() + 5 * 3600e3).toISOString();
  srv.freeBooksState.games = { nfl: [{ id: 'pin-t1', sport_key: 'nfl', commence_time: start, home_team: 'Home Hawks', away_team: 'Away Owls', bookmakers: [
    { key: 'pinnacle', markets: [{ key: 'h2h', outcomes: [{ name: 'Home Hawks', price: -150 }, { name: 'Away Owls', price: 135 }] }] },
    { key: 'gemini', markets: [{ key: 'h2h', outcomes: [{ name: 'Home Hawks', price: -138 }, { name: 'Away Owls', price: 140 }] }] },
    { key: 'fanduel', markets: [{ key: 'h2h', outcomes: [{ name: 'Home Hawks', price: -130 }, { name: 'Away Owls', price: 150 }] }] },
  ] }] };
  srv.freeBooksState.gamesAt = new Date().toISOString();
  let r = await update('/odds@LineReaperOwnerBot owls');
  assert.equal(r.status, 200);
  assert.equal(r.sent.length, 1);
  let m = r.sent[0];
  assert.equal(m.chat_id, -100777);
  assert.equal(m.parse_mode, 'HTML');
  assert.match(m.text, /^<b><a href="https:\/\/[^"]+\/lines\/game\/pin-t1\?market=ml">Away Owls @ Home Hawks<\/a><\/b>/);
  assert.match(m.text, /Away Owls: best <b>FanDuel \+150<\/b> · Pinnacle fair/);
  assert.match(m.text, /a group admin can set the state with \/settings/);
  assert.match(m.text, /Information only: Line Reaper takes no bets/);
  assert.doesNotMatch(m.text, /\*\*|<t:/, 'no Discord markdown left');
  assert.ok(m.reply_markup.inline_keyboard.flat().every(b => b.url.startsWith('https://')), 'URL buttons only');
  // a command for another bot in the group is not ours
  assert.equal((await update('/odds@SomeOtherBot owls')).sent.length, 0);
  // a member can read the settings, not change them
  r = await update('/settings TX');
  assert.match(r.sent[0].text, /Only a group admin/);
  member = 'administrator';
  r = await update('/settings tx decimal');
  assert.match(r.sent[0].text, /State: Texas \(TX\)/);
  assert.match(r.sent[0].text, /Odds format: decimal/);
  member = 'member';
  r = await update('/odds owls');
  m = r.sent[0];
  assert.match(m.text, /Away Owls: best <b>Gemini 2\.40<\/b>/, m.text);
  assert.doesNotMatch(m.text, /FanDuel/);
  assert.match(m.text, /Texas resident/);
  // a private chat has its own settings
  r = await update('/odds owls', { chat: { id: 4242, type: 'private' } });
  assert.match(r.sent[0].text, /FanDuel \+150/);
});

test('/moves, /lines, /record and /help answer from the same bodies as the API', async () => {
  const mv = await update('/moves price');
  assert.equal(mv.sent.length, 1);
  assert.ok(mv.sent[0].text.length > 0);
  const ln = await update('/lines zzzz');
  assert.match(ln.sent[0].text, /No market in the line history matches "zzzz"/);
  const rec = await update('/record');
  assert.match(rec.sent[0].text, /Nothing is proven yet|Proven on the strict rule/);
  assert.doesNotMatch(rec.sent[0].text, /guaranteed|risk[- ]free/i);
  assert.match(rec.sent[0].link_preview_options.url, /\/card\/record\.png/);
  const who = await update('/record @nobody_here');
  assert.match(who.sent[0].text, /No public record with the handle @nobody_here/);
  const help = await update('/help');
  assert.match(help.sent[0].text, /This chat's id: <code>-100777<\/code>/);
  const need = await update('/props');
  assert.match(need.sent[0].text, /\/props needs a player/);
});

test('a customer\'s own bot: connect with a key (token sealed), answer at its own URL, spend the key\'s limits, disconnect', async () => {
  const k = await fetch(`${base}/api/v1/keys`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '10.9.0.8' }, body: JSON.stringify({ name: 'tg' }) }).then(r => r.json());
  const h = { 'X-API-Key': k.key, 'Content-Type': 'application/json' };
  const put = body => fetch(`${base}/api/v1/bot/telegram`, { method: 'PUT', headers: h, body: JSON.stringify(body) }).then(async r => ({ status: r.status, body: await r.json() }));
  const p = '/telegram/webhook/222222222';
  assert.equal((await update('/odds owls', { token: CUSTOMER_TOKEN, p })).status, 404, 'not connected yet');
  assert.match((await put({ botToken: 'nope' })).body.error.message, /BotFather/);
  const bad = await put({ botToken: BAD_TOKEN });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error.message, /turned the token away/);
  assert.equal((await put({ botToken: OWNER_TOKEN })).status, 409, 'the site\'s own bot');
  const ok = await put({ botToken: CUSTOMER_TOKEN });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.telegram.connected, true);
  assert.equal(ok.body.telegram.username, 'CustomerOddsBot');
  assert.equal(ok.body.telegram.addToGroup, 'https://t.me/CustomerOddsBot?startgroup=start');
  const wh = tgCalls.filter(x => x.method === 'setWebhook' && x.id === '222222222').at(-1).data;
  assert.match(wh.url, /\/telegram\/webhook\/222222222$/);
  await new Promise(r => setTimeout(r, 300));
  const files = fs.readdirSync(DIR, { recursive: true }).map(f => path.join(DIR, String(f))).filter(f => fs.statSync(f).isFile());
  assert.ok(files.every(f => !fs.readFileSync(f, 'utf8').includes('CCCCCCCCCC')), 'the token is stored sealed, never plain');
  assert.equal((await update('/odds owls', { token: OWNER_TOKEN, p })).status, 401, 'the owner\'s secret on the customer\'s URL');
  const before = (await fetch(`${base}/api/v1/key`, { headers: h }).then(r => r.json())).usage;
  const o = await update('/odds owls', { token: CUSTOMER_TOKEN, p, chat: { id: 9, type: 'private' } });
  assert.equal(o.status, 200);
  assert.match(o.sent[0].text, /Away Owls @ Home Hawks/);
  assert.ok(o.calls.every(c => c.id === '222222222'), 'answered with the customer\'s bot');
  const after = (await fetch(`${base}/api/v1/key`, { headers: h }).then(r => r.json())).usage;
  assert.ok(JSON.stringify(after) !== JSON.stringify(before), 'the command counted on the key');
  const st = await fetch(`${base}/api/v1/bot`, { headers: h }).then(r => r.json());
  assert.equal(st.telegram.connected, true);
  assert.equal(st.discord.connected, false);
  assert.doesNotMatch(JSON.stringify(st), /CCCCCCCCCC|sealed/);
  const del = await fetch(`${base}/api/v1/bot/telegram`, { method: 'DELETE', headers: h }).then(r => r.json());
  assert.equal(del.telegram.connected, false);
  assert.ok(tgCalls.some(x => x.method === 'deleteWebhook' && x.id === '222222222'));
  assert.equal((await update('/odds owls', { token: CUSTOMER_TOKEN, p })).status, 404);
});

test('/api/status shows the Telegram bot without any secret, and the feed has no problem with a token alone', async () => {
  const s = await fetch(`${base}/api/status`).then(r => r.json());
  assert.equal(s.telegramBot.on, true);
  assert.equal(s.telegramBot.owner.botId, '111111111');
  assert.equal(s.telegramBot.owner.username, 'LineReaperOwnerBot');
  assert.equal(s.telegramBot.owner.webhook.ok, true);
  assert.ok(s.telegramBot.commandsAnswered >= 8);
  assert.doesNotMatch(JSON.stringify(s), /OOOOOOOOOO|CCCCCCCCCC/);
  assert.deepEqual(s.outFeed.owner.problems, []);
});
