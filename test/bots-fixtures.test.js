// The Discord and Telegram bots against payloads shaped like the platforms'
// own documented examples (test/fixtures/bots), not hand-trimmed ones: every
// field a real Discord interaction or Telegram update carries, signed with a
// real Ed25519 key, plus malformed bodies a real endpoint can receive.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const D = require('../discordbot');
const tg = require('../telegrambot');

const DI = require('./fixtures/bots/discord-interactions.json');
const TU = require('./fixtures/bots/telegram-updates.json');
const clone = x => JSON.parse(JSON.stringify(x));

// ── Discord ──
function pair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return { hex: publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('hex'), privateKey };
}
const K = pair(), KEY = D.publicKeyOf(K.hex), APP = '111111111111111111';
// Discord signs timestamp + raw body; the raw bytes are what we verify
const signedRaw = (raw, k = K, ts = Math.floor(Date.now() / 1000)) => ({ signature: crypto.sign(null, Buffer.concat([Buffer.from(String(ts)), Buffer.from(raw)]), k.privateKey).toString('hex'), timestamp: String(ts), body: Buffer.from(raw) });
const signed = obj => signedRaw(JSON.stringify(obj));
function discordBot() {
  const m = new Map(), seen = [], patched = [];
  const settings = { get: async (a, g) => m.get(`${a}|${g}`) || {}, set: async (a, g, p) => { const v = { ...(m.get(`${a}|${g}`) || {}), ...p }; m.set(`${a}|${g}`, v); return v; } };
  const bot = D.createBot({ settings, log: { warn() {} }, stateOf: s => (/^[A-Z]{2}$/.test(s) ? s : null), stateName: s => (s === 'TX' ? 'Texas' : s),
    http: { patch: async (url, data) => { patched.push({ url, data }); return {}; } },
    handlers: { odds: async (o, ctx) => { seen.push({ o, ctx }); return D.message({ title: `odds ${o.game}`, description: `state ${ctx.settings.state || 'none'}` }); } } });
  return { bot, seen, patched, settings: m };
}

test('Discord: the documented PING gets PONG, with the bytes exactly as sent', async () => {
  const { bot } = discordBot();
  // pretty-printed JSON is still the signed bytes: re-serialising would break the signature
  const raw = JSON.stringify(DI.ping, null, 2);
  const r = await bot.handle({ key: KEY, appId: APP, ...signedRaw(raw) });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { type: D.REPLY.PONG });
});

test('Discord: a full guild slash command (member, channel, entitlements, context) is answered in the channel', async () => {
  const { bot, seen } = discordBot();
  const r = await bot.handle({ key: KEY, appId: APP, ...signed(DI.guildCommand) });
  assert.equal(r.status, 200);
  assert.equal(r.body.type, D.REPLY.MESSAGE);
  assert.equal(r.body.data.embeds[0].title, 'odds Lakers');
  assert.equal(seen[0].ctx.guild, '999999999999999999');
  assert.equal(seen[0].ctx.user, '555555555555555555', 'the user id comes from member.user');
  assert.deepEqual(r.body.data.allowed_mentions, { parse: [] }, 'never pings anyone');
});

test('Discord: the documented member permissions decide /settings (every bit set, as in the docs\' example)', async () => {
  const { bot } = discordBot();
  const p = BigInt(DI.guildCommand.member.permissions);
  assert.equal((p & 0x20n) === 0x20n, true, 'the fixture member can manage the server');
  const i = clone(DI.guildCommand);
  i.data = { ...i.data, name: 'settings', options: [{ name: 'state', type: 3, value: 'tx' }] };
  let r = await bot.handle({ key: KEY, appId: APP, ...signed(i) });
  assert.match(r.body.data.embeds[0].description, /State: Texas \(TX\)/);
  assert.equal(r.body.data.flags, D.EPHEMERAL);
  // the same member without the bit: refused, nothing changed
  i.member = { ...i.member, permissions: '1024' };
  i.data.options = [{ name: 'state', type: 3, value: 'CA' }];
  r = await bot.handle({ key: KEY, appId: APP, ...signed(i) });
  assert.match(r.body.data.embeds[0].description, /Only someone with Manage Server/);
});

test('Discord: a DM command (user, no member, no guild) answers without a server and never crashes /settings', async () => {
  const { bot } = discordBot();
  const r = await bot.handle({ key: KEY, appId: APP, ...signed(DI.dmCommand) });
  assert.equal(r.status, 200);
  assert.match(r.body.data.embeds[0].description, /Settings belong to a server/);
  const odds = clone(DI.dmCommand);
  odds.data = { id: '1', name: 'odds', type: 1, options: [{ name: 'game', type: 3, value: 'Celtics' }] };
  const { bot: b2, seen } = discordBot();
  const r2 = await b2.handle({ key: KEY, appId: APP, ...signed(odds) });
  assert.equal(r2.body.data.embeds[0].title, 'odds Celtics');
  assert.equal(seen[0].ctx.guild, null);
  assert.equal(seen[0].ctx.user, '555555555555555555', 'the user id comes from user in a DM');
});

test('Discord: an autocomplete interaction (type 4) gets a plain reply, not a crash', async () => {
  const { bot } = discordBot();
  const r = await bot.handle({ key: KEY, appId: APP, ...signed(DI.autocomplete) });
  assert.equal(r.status, 200);
  assert.match(r.body.data.embeds[0].description, /slash commands only/);
});

test('Discord: the signature covers the exact bytes, header timestamp and key', async () => {
  const { bot } = discordBot();
  const s = signed(DI.guildCommand);
  // one changed byte in the body
  const tampered = Buffer.from(s.body.toString().replace('Lakers', 'Lakerz'));
  assert.equal((await bot.handle({ key: KEY, appId: APP, ...s, body: tampered })).status, 401);
  // a replayed body under a new timestamp
  assert.equal((await bot.handle({ key: KEY, appId: APP, ...s, timestamp: String(Number(s.timestamp) + 1) })).status, 401);
  // signed by a different application's key
  assert.equal((await bot.handle({ key: KEY, appId: APP, ...signedRaw(JSON.stringify(DI.ping), pair()) })).status, 401);
  // missing headers, as from a bare POST
  assert.equal((await bot.handle({ key: KEY, appId: APP, signature: undefined, timestamp: undefined, body: Buffer.alloc(0) })).status, 401);
  assert.equal(bot.stats().badSignature, 4);
});

test('Discord: malformed but correctly signed bodies get a 400 or a plain reply, never a throw', async () => {
  const { bot } = discordBot();
  for (const raw of ['not json', '', 'null', '[]', '"text"', '42']) {
    const r = await bot.handle({ key: KEY, appId: APP, ...signedRaw(raw) });
    assert.equal(r.status, 400, `body ${JSON.stringify(raw)}`);
  }
  const odd = [
    { type: 2 },                                                     // no data at all
    { type: 2, data: null },
    { type: 2, data: { name: 'odds', options: 'Lakers' } },          // options not an array
    { type: 2, data: { name: 'odds', options: 7 } },
    { type: 2, data: { name: 'odds', options: [null, 5, { value: 'x' }] } },
    { type: 2, data: { name: 42 } },
    { type: 99 },
  ];
  for (const i of odd) {
    const r = await bot.handle({ key: KEY, appId: APP, ...signed(i) });
    assert.equal(r.status, 200, JSON.stringify(i));
    assert.ok([D.REPLY.MESSAGE, D.REPLY.DEFERRED].includes(r.body.type), JSON.stringify(i));
    if (r.followup) await r.followup;
  }
});

// ── Telegram ──
const TOKEN = `123456789:${'A'.repeat(35)}`;
const BOT = { token: TOKEN, botId: '123456789', secret: tg.secretOf(TOKEN), username: 'LineReaperTestBot' };
function telegramBot({ member = 'member' } = {}) {
  const calls = [], seen = [];
  const http = { post: async (url, data) => {
    const method = url.split('/').pop();
    calls.push({ method, data });
    if (method === 'getChatMember') return { data: { ok: true, result: { status: member } } };
    return { data: { ok: true, result: { message_id: 1 } } };
  } };
  const docs = new Map();
  const settings = { get: async (a, c) => docs.get(`${a}|${c}`) || {}, set: async (a, c, p) => { const d = { ...(docs.get(`${a}|${c}`) || {}), ...p }; docs.set(`${a}|${c}`, d); return d; } };
  const handlers = {
    odds: async (o, ctx) => { seen.push({ name: 'odds', o, ctx }); return D.message({ title: `odds ${o.game}` }); },
    moves: async (o, ctx) => { seen.push({ name: 'moves', o, ctx }); return D.message({ title: `moves ${o.league || ''} ${o.type || ''}`.trim() }); },
  };
  const bot = tg.createTelegramBot({ handlers, settings, http, log: { warn() {} }, stateOf: s => (s === 'TX' ? 'TX' : null), stateName: () => 'Texas' });
  const send = update => bot.handle({ bot: BOT, secretHeader: BOT.secret, update, ctx: { origin: 'https://lr.test' } });
  return { bot, calls, seen, send, sent: () => calls.filter(c => c.method === 'sendMessage').map(c => c.data) };
}

test('Telegram: a documented group command (@botname, entities) is answered in that chat as a reply', async () => {
  const h = telegramBot();
  const r = h.send(TU.groupCommand);
  assert.deepEqual(r.body, { ok: true });
  const body = await r.work;
  assert.equal(body.chat_id, -1001234567890);
  assert.equal(body.reply_parameters.message_id, 4101);
  assert.equal(h.seen[0].o.game, 'Lakers');
  assert.equal(h.seen[0].ctx.user, '42424242');
  assert.equal(body.parse_mode, 'HTML');
});

test('Telegram: /start in a private chat gets the help text', async () => {
  const h = telegramBot();
  const body = await h.send(TU.privateStart).work;
  assert.equal(body.chat_id, 42424242);
  assert.match(body.text, /\/odds/);
});

test('Telegram: a forum topic command answers in the same topic', async () => {
  const h = telegramBot();
  const body = await h.send(TU.topicCommand).work;
  assert.equal(body.message_thread_id, 4000);
  assert.equal(h.seen[0].o.league, 'nfl');
  assert.equal(h.seen[0].o.type, 'line');
});

test('Telegram: an anonymous group admin (posting as the group) may change /settings', async () => {
  const h = telegramBot({ member: 'member' });
  const body = await h.send(TU.anonymousAdminSettings).work;
  assert.match(body.text, /Texas/);
  assert.ok(!h.calls.some(c => c.method === 'getChatMember'), 'no member lookup for GroupAnonymousBot');
});

test('Telegram: updates the bot must not answer are acknowledged and ignored', async () => {
  const h = telegramBot();
  for (const k of ['otherBotCommand', 'photoWithCaption', 'editedMessage', 'channelPost', 'myChatMember', 'callbackQuery']) {
    const r = h.send(TU[k]);
    assert.equal(r.status, 200, k);
    assert.deepEqual(r.body, { ok: true }, k);
    assert.equal(r.work, undefined, `${k} must not send anything`);
  }
  assert.equal(h.sent().length, 0);
  assert.equal(h.bot.stats().ignored, 6);
});

test('Telegram: the secret header is checked before anything else, and a redelivered update is answered once', async () => {
  const h = telegramBot();
  assert.equal(h.bot.handle({ bot: BOT, secretHeader: 'x'.repeat(BOT.secret.length), update: TU.groupCommand }).status, 401);
  assert.equal(h.bot.handle({ bot: BOT, secretHeader: undefined, update: TU.groupCommand }).status, 401);
  assert.equal(h.seen.length, 0);
  await h.send(TU.groupCommand).work;
  assert.equal(h.send(clone(TU.groupCommand)).work, undefined, 'same update_id');
  assert.equal(h.sent().length, 1);
});

test('Telegram: malformed updates are acknowledged and ignored, never a throw', async () => {
  const h = telegramBot();
  const bad = [
    null, undefined, [], 'text', 42, {},
    { update_id: 'abc' },
    { update_id: 900000100, message: null },
    { update_id: 900000101, message: { message_id: 1, chat: { id: -1 }, text: 42 } },
    { update_id: 900000102, message: { message_id: 1, text: '/odds Lakers' } },          // no chat
    { update_id: 900000103, message: { message_id: 1, chat: {}, text: '/odds Lakers' } }, // chat without an id
    { update_id: 900000104, message: { message_id: 1, chat: { id: -1 }, text: '/' } },
    { update_id: 900000105, message: { message_id: 1, chat: { id: -1 }, text: `/odds ${'x'.repeat(5000)}` } },
  ];
  for (const u of bad) {
    let r;
    assert.doesNotThrow(() => { r = h.send(u); }, JSON.stringify(u)?.slice(0, 60));
    assert.equal(r.status, 200);
    if (r.work) await r.work;
  }
  // the over-long one is answered with its argument cut, everything else ignored
  assert.equal(h.seen.length, 1);
  assert.ok(h.seen[0].o.game.length <= 80);
});
