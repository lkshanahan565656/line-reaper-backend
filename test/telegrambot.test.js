// telegrambot.js on its own: reading commands, writing the Discord bot's
// answers as Telegram HTML, the webhook secret, and the handler with a fake
// HTTP client (sample Telegram updates in, sendMessage bodies out).
const test = require('node:test');
const assert = require('node:assert/strict');
const tg = require('../telegrambot');
const discord = require('../discordbot');

const TOKEN = `123456789:${'A'.repeat(35)}`;

test('owner config: dormant without the token, a malformed one is named, never echoed', () => {
  assert.deepEqual(tg.ownerConfig({}), { on: false, token: null, botId: null, secret: null, problems: [] });
  const bad = tg.ownerConfig({ TELEGRAM_BOT_TOKEN: 'nope' });
  assert.equal(bad.on, false);
  assert.match(bad.problems[0], /does not look like a bot token/);
  const ok = tg.ownerConfig({ TELEGRAM_BOT_TOKEN: ` ${TOKEN} ` });
  assert.equal(ok.on, true);
  assert.equal(ok.botId, '123456789');
  assert.match(ok.secret, /^[A-Za-z0-9_-]{48}$/, 'Telegram allows A-Z a-z 0-9 _ - only');
  assert.equal(ok.secret, tg.secretOf(TOKEN), 'the same secret every boot');
  assert.notEqual(tg.secretOf(`${TOKEN}x`), ok.secret);
  assert.ok(!ok.secret.includes('AAAA'));
  assert.equal(tg.sameSecret(ok.secret, ok.secret), true);
  assert.equal(tg.sameSecret('', ''), false);
  assert.equal(tg.sameSecret(ok.secret, ok.secret.slice(1)), false);
});

test('commands: @botname, other bots, arguments and the Discord options they map to', () => {
  assert.deepEqual(tg.parseCommand('/odds Lakers  Celtics'), { name: 'odds', args: 'Lakers Celtics' });
  assert.deepEqual(tg.parseCommand('/Odds@LineReaperBot lakers', 'linereaperbot'), { name: 'odds', args: 'lakers' });
  assert.equal(tg.parseCommand('/odds@OtherBot lakers', 'LineReaperBot'), null, 'meant for another bot');
  assert.equal(tg.parseCommand('hello /odds'), null);
  assert.equal(tg.parseCommand(''), null);
  assert.deepEqual(tg.optsOf('odds', 'Lakers'), { game: 'Lakers' });
  assert.deepEqual(tg.optsOf('props', 'Mahomes'), { player: 'Mahomes' });
  assert.deepEqual(tg.optsOf('lines', 'Mahomes Pass Yards'), { market: 'Mahomes Pass Yards' });
  assert.deepEqual(tg.optsOf('record', ''), {});
  assert.deepEqual(tg.optsOf('record', '@logan extra'), { handle: '@logan' });
  assert.deepEqual(tg.optsOf('moves', 'NBA line 3h'), { league: 'nba', type: 'line', window: '3h' });
  assert.deepEqual(tg.optsOf('moves', ''), {});
  assert.deepEqual(tg.optsOf('settings', 'tx decimal'), { state: 'TX', odds: 'decimal' });
  assert.deepEqual(tg.optsOf('settings', 'state:ALL odds:american'), { state: 'ALL', odds: 'american' });
  assert.deepEqual(tg.optsOf('settings', ''), {});
  assert.equal(tg.COMMANDS.length, 7);
  for (const c of tg.COMMANDS) { assert.match(c.command, /^[a-z]{1,32}$/); assert.ok(c.description.length <= 256); }
});

test('Discord markdown becomes Telegram HTML: bold, links, escapes, time stamps, nothing raw', () => {
  const now = Date.parse('2026-10-27T12:00:00Z');
  const u = Math.floor(now / 1000) + 3 * 3600;
  const h = tg.mdToHtml(`**Away <Owls>** & co \\*not bold\\* starts <t:${u}:R> · [Lakers \\_x](https://lr.test/lines?q=a&b=c) [pm](https://polymarket.com/x)`, now);
  assert.match(h, /^<b>Away &lt;Owls&gt;<\/b> &amp; co \*not bold\* starts in 3 h/);
  assert.match(h, /<a href="https:\/\/lr\.test\/lines\?q=a&amp;b=c">Lakers _x<\/a>/);
  assert.doesNotMatch(h, /polymarket\.com/);
  assert.equal(tg.relTime(Math.floor(now / 1000) - 1800, now), '30 min ago');
  assert.match(tg.relTime(Math.floor(now / 1000) + 5 * 86400, now), /^Nov 1 12:00 UTC$/);
});

test('render: a Discord answer as one Telegram message with the card as preview and URL buttons', () => {
  const now = Date.parse('2026-10-27T12:00:00Z');
  const msg = discord.recordMessage({ card: { proven: [{ venueName: 'BetRivers', kindLabel: 'main lines', graded: 373, clvPct: 2.8, profitShown: false, texas: false }], notProven: 4, building: 3, losing: 1 }, origin: 'https://lr.test', now });
  const r = tg.render(msg, { now });
  assert.equal(r.parse_mode, 'HTML');
  assert.match(r.text, /^<b><a href="https:\/\/lr\.test\/results">The public record \(RESULTS\)<\/a><\/b>/);
  assert.match(r.text, /BetRivers main lines: 373 graded, CLV \+2\.8% vs Pinnacle's close, profit not shown \(not a Texas venue\)/);
  assert.match(r.text, /<i>Information only: Line Reaper takes no bets/);
  assert.match(r.link_preview_options.url, /^https:\/\/lr\.test\/card\/record\.png\?v=/);
  assert.deepEqual(r.reply_markup.inline_keyboard[0].map(b => b.text), ['FULL RECORD', 'ALERT HISTORY']);
  assert.ok(r.text.length <= 4096);
  // fields, a long answer cut at the limit, and no image means no preview
  const big = discord.message({ title: 'T', description: 'd', fields: Array.from({ length: 12 }, (_, i) => ({ name: `F${i}`, value: 'x'.repeat(900) })) }, { now });
  const rb = tg.render(big, { now });
  assert.ok(rb.text.length <= 4096, String(rb.text.length));
  assert.match(rb.text, /…more on the site\./);
  assert.deepEqual(rb.link_preview_options, { is_disabled: true });
  assert.equal(rb.reply_markup, undefined, 'no buttons that do nothing');
});

function harness({ handlers = {}, member = 'member' } = {}) {
  const calls = [];
  const http = { post: async (url, data) => {
    const method = url.split('/').pop();
    calls.push({ url, method, data });
    if (method === 'getChatMember') return { data: { ok: true, result: { status: member } } };
    if (method === 'getMe') return { data: { ok: true, result: { id: 123456789, username: 'LineReaperTestBot' } } };
    return { data: { ok: true, result: true } };
  } };
  const docs = new Map();
  const settings = { get: async (a, c) => docs.get(`${a}|${c}`) || {}, set: async (a, c, p) => { const d = { ...(docs.get(`${a}|${c}`) || {}), ...p }; docs.set(`${a}|${c}`, d); return d; } };
  const bot = tg.createTelegramBot({ handlers, settings, http, log: { warn() {} }, stateOf: s => (s === 'TX' ? 'TX' : null), stateName: () => 'Texas' });
  const B = { token: TOKEN, botId: '123456789', secret: tg.secretOf(TOKEN), username: 'LineReaperTestBot' };
  let n = 100;
  const send = (text, chat = { id: -1001, type: 'supergroup' }, extra = {}) => bot.handle({ bot: B, secretHeader: B.secret, update: { update_id: ++n, message: { message_id: n, chat, from: { id: 7 }, text, ...extra } }, ctx: { origin: 'https://lr.test' } });
  return { bot, B, calls, send, sent: () => calls.filter(c => c.method === 'sendMessage').map(c => c.data) };
}

test('handler: secret checked, duplicates and chatter ignored, commands answered with sendMessage', async () => {
  const seen = [];
  const h = harness({ handlers: { odds: (opts, ctx) => { seen.push({ opts, ctx }); return discord.message({ title: 'No game found', description: `Nothing matches "${opts.game}".` }); } } });
  assert.equal(h.bot.handle({ bot: h.B, secretHeader: 'wrong', update: {} }).status, 401);
  assert.equal(h.bot.handle({ bot: h.B, secretHeader: undefined, update: {} }).status, 401);
  const hello = h.send('hello there');
  assert.equal(hello.status, 200);
  assert.equal(hello.work, undefined);
  const r = h.send('/odds@LineReaperTestBot Owls');
  assert.deepEqual(r.body, { ok: true });
  const body = await r.work;
  assert.equal(body.chat_id, -1001);
  assert.match(body.text, /Nothing matches "Owls"/);
  assert.equal(body.reply_parameters.allow_sending_without_reply, true);
  assert.equal(seen[0].ctx.app, 'tg:123456789');
  assert.equal(seen[0].ctx.chat, '-1001');
  assert.equal(h.calls.at(-1).url, `https://api.telegram.org/bot${TOKEN}/sendMessage`);
  // Telegram redelivers an update it thinks was lost: answered once
  const again = h.bot.handle({ bot: h.B, secretHeader: h.B.secret, update: { update_id: 101, message: { message_id: 1, chat: { id: 1, type: 'private' }, text: '/odds x' } } });
  assert.equal(again.work, undefined);
  assert.equal(h.bot.stats().duplicate, 1);
  // a missing argument says what to send, and asks the handler nothing
  const u = await h.send('/odds').work;
  assert.match(u.text, /\/odds needs a game/);
  assert.equal(seen.length, 1);
  const help = await h.send('/help').work;
  assert.match(help.text, /\/props: /);
  assert.match(help.text, /This chat's id: <code>-1001<\/code>/);
  assert.equal(h.send('/unknown').work, undefined);
});

test('handler: /settings reads for anyone, changes for an admin only, private chats are their own admin', async () => {
  const h = harness();
  let b = await h.send('/settings').work;
  assert.match(b.text, /State: None/);
  b = await h.send('/settings TX').work;
  assert.match(b.text, /Only a group admin/);
  assert.ok(h.calls.some(c => c.method === 'getChatMember' && c.data.user_id === 7));
  const admin = harness({ member: 'administrator' });
  b = await admin.send('/settings TX decimal').work;
  assert.match(b.text, /State: Texas \(TX\)/);
  assert.match(b.text, /Odds format: decimal/);
  assert.match(b.text, /Saved for everyone in this chat/);
  b = await admin.send('/settings ZZ').work;
  assert.match(b.text, /not a US state code/);
  b = await h.send('/settings TX', { id: 55, type: 'private' }).work;
  assert.match(b.text, /Saved/);
  b = await h.send('/settings ALL', { id: -1001, type: 'supergroup' }, { sender_chat: { id: -1001 } }).work;
  assert.match(b.text, /Saved/, 'an anonymous admin posts as the group');
});

test('handler: a limit answers once a minute per chat, an error never leaks, a failed send is counted', async () => {
  let t = 1e12;
  const calls = [];
  const http = { post: async (url, data) => { calls.push(data); if (data.chat_id === 'dead') throw Object.assign(new Error(`fail bot${TOKEN}`), { response: { status: 403, data: { description: 'Forbidden: bot was kicked' } } }); return { data: { ok: true } }; } };
  const bot = tg.createTelegramBot({ handlers: { odds: () => { throw new Error(`boom ${TOKEN}`); } }, http, log: { warn() {} }, now: () => t });
  const B = { token: TOKEN, botId: '1', secret: tg.secretOf(TOKEN) };
  let n = 0;
  const up = (text, chat = 5) => ({ update_id: ++n, message: { message_id: n, chat: { id: chat, type: 'private' }, text } });
  const limit = async () => discord.message({ title: 'Over the limit', description: 'Too many.' });
  assert.match((await bot.handle({ bot: B, secretHeader: B.secret, update: up('/odds a b'), limit }).work).text, /Too many/);
  assert.equal(await bot.handle({ bot: B, secretHeader: B.secret, update: up('/odds a b'), limit }).work, null, 'silent the second time');
  t += 61e3;
  assert.match((await bot.handle({ bot: B, secretHeader: B.secret, update: up('/odds a b'), limit }).work).text, /Too many/);
  const e = await bot.handle({ bot: B, secretHeader: B.secret, update: up('/odds ab') }).work;
  assert.match(e.text, /Something went wrong/);
  assert.equal(await bot.handle({ bot: B, secretHeader: B.secret, update: up('/odds ab', 'dead') }).work, null);
  const s = bot.stats();
  assert.equal(s.limited, 3);
  assert.equal(s.errors, 2, 'both chats hit the broken handler');
  assert.equal(s.sendErrors, 1);
  assert.doesNotMatch(JSON.stringify(s), /AAAAAAAA/, 'the token never reaches the stats');
});

test('connect: getMe, setWebhook with the secret and only messages, then the command menu', async () => {
  const h = harness();
  const r = await h.bot.connect(TOKEN, 'https://lr.test/telegram/webhook');
  assert.deepEqual(r, { ok: true, username: 'LineReaperTestBot', botId: '123456789' });
  const wh = h.calls.find(c => c.method === 'setWebhook').data;
  assert.equal(wh.url, 'https://lr.test/telegram/webhook');
  assert.equal(wh.secret_token, tg.secretOf(TOKEN));
  assert.deepEqual(wh.allowed_updates, ['message']);
  assert.equal(h.calls.find(c => c.method === 'setMyCommands').data.commands.length, 7);
  const bad = tg.createTelegramBot({ http: { post: async () => { throw Object.assign(new Error('x'), { response: { status: 401 } }); } } });
  assert.match((await bad.connect(TOKEN, 'https://lr.test/x')).why, /turned the token away/);
});
