'use strict';
// ─── TELEGRAM BOT COMMANDS: THE SAME PUBLIC NUMBERS, ASKED FOR IN A CHAT ─────
// /odds, /props, /moves, /record, /lines, /settings and /help answer in a
// Telegram group or a private chat with the same public numbers as the site,
// the API and the Discord bot (discordbot.js). The answers are built by the
// Discord bot's handlers and message builders, then written out for Telegram
// here, so the two bots can never say different things. Nothing is sized or
// picked per person, nothing places a bet, and "proven" is said only of what
// RESULTS marks proven (with a profit only where RESULTS shows one).
//
// It runs on Telegram's webhook (Telegram POSTs each update to the server with
// a secret header) inside the Express server: no long polling, no extra
// process.
//   - The owner's bot: TELEGRAM_BOT_TOKEN (the same variable the outbound
//     feed uses). On boot the server points the bot's webhook at
//     <site>/telegram/webhook and sets its command menu, only when either
//     changed. Without the variable the endpoint answers 404 and nothing is
//     sent to Telegram.
//   - A customer's own bot, connected on /developers#bot with their API key:
//     <site>/telegram/webhook/<bot id>, each command counted against their
//     key's plan limits like an API call. Their token is kept sealed (it is
//     needed to send the answers).
//
// Pure builders (parse, render) plus createTelegramBot (the I/O, with the
// HTTP client passed in so tests never touch the network).

const crypto = require('crypto');
const { clean } = require('./outfeed');

const API = 'https://api.telegram.org';
const TOKEN_RE = /^(\d{5,15}):[\w-]{30,60}$/;
const BOT_ID_RE = /^\d{5,15}$/;
const MAX_TEXT = 4096;
const ODDS_FMTS = ['american', 'decimal', 'fractional', 'probability'];

// the menu Telegram shows when someone types "/" (setMyCommands)
const COMMANDS = [
  { command: 'odds', description: 'A game\'s best price at each venue, beside Pinnacle. /odds Lakers' },
  { command: 'props', description: 'A player\'s props on each app, beside Pinnacle. /props Mahomes' },
  { command: 'moves', description: 'Today\'s biggest moves. /moves nba line 3h' },
  { command: 'record', description: 'The public record on RESULTS, or /record @handle' },
  { command: 'lines', description: 'Line history with a chart and CSV. /lines Lakers' },
  { command: 'settings', description: 'This chat\'s state and odds format. /settings TX decimal' },
  { command: 'help', description: 'What each command does' },
];
const commandsHash = () => crypto.createHash('sha256').update(JSON.stringify(COMMANDS)).digest('hex').slice(0, 16);

// ── the bot and its webhook secret ──
const botIdOf = token => { const m = TOKEN_RE.exec(String(token || '').trim()); return m ? m[1] : null; };
// Telegram sends this back in X-Telegram-Bot-Api-Secret-Token on every update.
// It comes from the token, so only someone holding the token can make it, and
// it is the same on every boot (setWebhook stays idempotent).
const secretOf = token => crypto.createHmac('sha256', 'line-reaper-telegram-webhook').update(String(token || '')).digest('hex').slice(0, 48);
function sameSecret(a, b) {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y);
}

// the owner's bot from env → { on, token, botId, secret, problems }
function ownerConfig(env = process.env) {
  const token = String(env.TELEGRAM_BOT_TOKEN || '').trim();
  if (!token) return { on: false, token: null, botId: null, secret: null, problems: [] };
  const botId = botIdOf(token);
  if (!botId) return { on: false, token: null, botId: null, secret: null, problems: ['TELEGRAM_BOT_TOKEN does not look like a bot token (BotFather sends it as 123456789:AA…)'] };
  return { on: true, token, botId, secret: secretOf(token), problems: [] };
}

// ── reading a command ──
// "/odds@LineReaperBot Lakers Celtics" → { name: 'odds', args: 'Lakers Celtics' },
// or null when it is not a command, or is a command for another bot
function parseCommand(text, username = null) {
  const m = /^\/([A-Za-z0-9_]{1,32})(?:@([A-Za-z0-9_]{3,40}))?(?:\s+([\s\S]*))?$/.exec(String(text || '').trim());
  if (!m) return null;
  if (m[2] && username && m[2].toLowerCase() !== String(username).toLowerCase()) return null;
  return { name: m[1].toLowerCase(), args: (m[3] || '').replace(/\s+/g, ' ').trim().slice(0, 80) };
}
// a command's words → the same options the Discord command takes
function optsOf(name, args) {
  const words = args ? args.split(' ') : [];
  if (name === 'odds') return { game: args };
  if (name === 'props') return { player: args };
  if (name === 'lines') return { market: args };
  if (name === 'record') return args ? { handle: words[0] } : {};
  if (name === 'moves') {
    const o = {};
    for (const w of words.map(x => x.toLowerCase())) {
      if (w === 'line' || w === 'lines') o.type = 'line';
      else if (w === 'price' || w === 'prices') o.type = 'price';
      else if (w === '1h' || w === '3h' || w === 'open') o.window = w;
      else if (!o.league && /^[a-z0-9_]{2,20}$/.test(w)) o.league = w;
    }
    return o;
  }
  if (name === 'settings') {
    const o = {};
    for (const w of words) {
      const l = w.toLowerCase().replace(/^(state|odds)[:=]/, '');
      if (!l || l === 'state' || l === 'odds') continue;
      if (ODDS_FMTS.includes(l)) o.odds = l;
      else if (o.state == null) o.state = l.toUpperCase();
    }
    return o;
  }
  return {};
}
const NEEDS = { odds: ['game', 'a team or game, like /odds Lakers'], props: ['player', 'a player, like /props Mahomes'], lines: ['market', 'a team, player or stat, like /lines Mahomes Pass Yards'] };

// ── writing a Discord-shaped answer as Telegram HTML ──
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const attr = s => esc(s).replace(/"/g, '&quot;');
// Discord's <t:unix:R> stamp in words ("in 3 h", "25 min ago", or a UTC date)
function relTime(unix, now = Date.now()) {
  const d = unix * 1000 - now, a = Math.abs(d);
  if (a < 60e3) return d >= 0 ? 'in under a minute' : 'just now';
  if (a < 36 * 3600e3) {
    const s = a < 3600e3 ? `${Math.round(a / 60e3)} min` : `${Math.round(a / 3600e3 * 10) / 10} h`;
    return d >= 0 ? `in ${s}` : `${s} ago`;
  }
  const t = new Date(unix * 1000);
  return `${t.toLocaleString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })} ${t.toISOString().slice(11, 16)} UTC`;
}
const MD_ESC = { '*': '', _: '', '`': '', '~': '', '|': '', '>': '', '\\': '' };
const MD_BACK = Object.fromEntries(Object.entries(MD_ESC).map(([c, p]) => [p, esc(c)]));
// the Discord markdown the builders write (**bold**, [label](url), \* escapes,
// <t:…:R> stamps) → Telegram HTML. Everything else is escaped as plain text.
function mdToHtml(s, now = Date.now()) {
  let t = clean(s).replace(/<t:(\d{9,12}):[tTdDfFR]>/g, (m, u) => relTime(Number(u), now));
  t = t.replace(/\\([*_`~|>\\])/g, (m, c) => MD_ESC[c]);
  const links = [];
  t = t.replace(/\[([^\]\n]{1,200})\]\((https:\/\/[^\s)]{1,500})\)/g, (m, label, url) => { links.push({ label, url }); return `${links.length - 1}`; });
  t = esc(t).replace(/\*\*([^*\n]+?)\*\*/g, '<b>$1</b>');
  t = t.replace(/(\d+)/g, (m, n) => { const l = links[Number(n)]; return /polymarket\.com/i.test(l.url) ? esc(l.label) : `<a href="${attr(l.url)}">${esc(l.label)}</a>`; });
  return t.replace(/[-]/g, c => MD_BACK[c]);
}
// a discordbot.message() → a sendMessage body (without chat_id). The share
// card rides as the link preview (Telegram fetches the PNG itself), the link
// buttons become URL buttons, and nothing can ping anyone.
function render(data, { now = Date.now() } = {}) {
  const e = (data?.embeds || [])[0] || {};
  const title = e.title ? (e.url && /^https:\/\//.test(e.url) ? `<b><a href="${attr(e.url)}">${esc(clean(e.title))}</a></b>` : `<b>${esc(clean(e.title))}</b>`) : '';
  const blocks = [title, e.description ? mdToHtml(e.description, now) : ''].filter(Boolean);
  const footer = e.footer?.text ? `<i>${esc(clean(e.footer.text))}</i>` : '';
  const room = MAX_TEXT - footer.length - 80;
  let used = blocks.join('\n\n').length, cutShort = false;
  for (const f of e.fields || []) {
    const b = `<b>${mdToHtml(f.name, now)}</b>\n${mdToHtml(f.value, now)}`;
    if (used + b.length + 2 > room) { cutShort = true; break; }
    blocks.push(b); used += b.length + 2;
  }
  if (cutShort) blocks.push('…more on the site.');
  if (footer) blocks.push(footer);
  let text = blocks.join('\n\n');
  if (text.length > MAX_TEXT) text = `${esc(clean(e.title || 'Line Reaper'))}\n\nThat answer is too long for one message. Open it on the site.`;
  const out = { text, parse_mode: 'HTML' };
  const img = e.image?.url && /^https:\/\//.test(e.image.url) ? e.image.url : null;
  out.link_preview_options = img ? { url: img, prefer_large_media: true, show_above_text: false } : { is_disabled: true };
  const buttons = [];
  for (const row of data?.components || []) for (const b of row.components || []) if (b?.url && /^https:\/\//.test(b.url) && !/polymarket\.com/i.test(b.url)) buttons.push({ text: String(b.label || 'OPEN').slice(0, 60), url: b.url });
  if (buttons.length) {
    const rows = [];
    for (let i = 0; i < buttons.length && i < 6; i += 2) rows.push(buttons.slice(i, i + 2));
    out.reply_markup = { inline_keyboard: rows };
  }
  return out;
}
// a short note in the same shape (help, usage, limits)
const plain = (title, lines) => ({ text: [`<b>${esc(title)}</b>`, ...lines].join('\n'), parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
function helpText({ chatId = null, origin = '' } = {}) {
  const lines = ['', ...COMMANDS.filter(c => c.command !== 'help').map(c => `/${c.command}: ${esc(c.description)}`), '',
    'Everyone who asks the same thing gets the same answer. Nothing is sized or picked per person, and Line Reaper takes no bets.'];
  if (chatId != null) lines.push('', `This chat's id: <code>${esc(chatId)}</code> (for the record feed, TELEGRAM_CHAT_IDS).`);
  if (origin) lines.push('', `${esc(origin)}/app`);
  return plain('Line Reaper commands', lines);
}

// ── the handler ──
// handlers: the Discord bot's { odds(opts, ctx), props, moves, record, lines }
// → a discordbot.message (or a promise). settings: { get(app, chat), set(app, chat, patch) }.
// settingsMessage(view, { changed, problem }) → a discordbot.message for /settings.
// http: an axios-like client. limit(ctx, name) → null to go on, or a message.
// /settings in Telegram words. current: { state, stateName, odds }
function settingsMessage({ current = {}, changed = false, problem = null } = {}) {
  if (problem) return plain('Settings not changed', [esc(problem)]);
  const st = current.state ? `${esc(current.stateName || current.state)} (${esc(current.state)}): best prices only at venues a resident can use, by our state table.` : 'None: best prices at every US venue we read.';
  return plain('Line Reaper settings for this chat', [`State: ${st}`, `Odds format: ${esc(current.odds || 'american')}.`, '',
    changed ? 'Saved for everyone in this chat.' : 'Change them with /settings TX decimal (or /settings ALL). In a group only an admin can. The same for everyone here.']);
}

function createTelegramBot({ handlers = {}, settings = null, http = null, log = console, now = () => Date.now(), stateOf = s => s, stateName = s => s, timeout = 10000 } = {}) {
  const stats = { updates: 0, commands: 0, ignored: 0, badSecret: 0, duplicate: 0, errors: 0, sendErrors: 0, limited: 0, byCommand: {}, lastAt: null, lastError: null };
  const client = http || require('axios');
  const seen = new Map();
  const limitNoted = new Map();
  const scrub = s => String(s || '').replace(/bot\d+:[\w-]+/g, 'bot…').slice(0, 160);
  async function call(token, method, data) {
    const r = await client.post(`${API}/bot${token}/${method}`, data, { timeout, headers: { 'Content-Type': 'application/json' } });
    if (r?.data && r.data.ok === false) throw Object.assign(new Error(r.data.description || 'not ok'), { response: { status: r.data.error_code, data: r.data } });
    return r?.data?.result;
  }
  async function canManage(token, msg) {
    const chat = msg.chat || {};
    if (chat.type === 'private') return true;
    if (msg.sender_chat && msg.sender_chat.id === chat.id) return true; // an anonymous admin posts as the group
    if (!msg.from?.id) return false;
    try { const m = await call(token, 'getChatMember', { chat_id: chat.id, user_id: msg.from.id }); return m?.status === 'creator' || m?.status === 'administrator'; } catch { return false; }
  }
  async function settingsCmd(token, msg, opts, ctx) {
    const view = c => ({ state: c.state || null, stateName: c.state ? stateName(c.state) : null, odds: c.odds || 'american' });
    const cur = await settings.get(ctx.app, ctx.chat);
    if (opts.state == null && opts.odds == null) return settingsMessage({ current: view(cur) });
    if (!(await canManage(token, msg))) return settingsMessage({ problem: 'Only a group admin can change this chat\'s settings.' });
    const patch = {};
    if (opts.state != null) {
      const s = String(opts.state).trim().toUpperCase();
      if (s === 'ALL' || s === 'NONE') patch.state = null;
      else { const st = stateOf(s); if (!st) return settingsMessage({ problem: `"${clean(opts.state)}" is not a US state code. Use two letters, like TX, or ALL.` }); patch.state = st; }
    }
    if (opts.odds != null) patch.odds = opts.odds;
    return settingsMessage({ current: view(await settings.set(ctx.app, ctx.chat, patch)), changed: true });
  }
  async function answer(token, msg, cmd, ctx) {
    if (cmd.name === 'help' || cmd.name === 'start') return helpText({ chatId: ctx.chat, origin: ctx.origin });
    const opts = optsOf(cmd.name, cmd.args);
    if (cmd.name === 'settings') return settingsCmd(token, msg, opts, ctx);
    const need = NEEDS[cmd.name];
    if (need && String(opts[need[0]] || '').length < 2) return plain(`/${cmd.name} needs ${need[0] === 'game' ? 'a game' : need[0] === 'player' ? 'a player' : 'a market'}`, [`Send ${esc(need[1])}.`]);
    return render(await handlers[cmd.name](opts, ctx), { now: now() });
  }
  // → { status, body, work }: Express answers Telegram at once (200), and the
  // reply goes out with sendMessage when ready (work, awaited by tests).
  // bot: { token, botId, secret, username }
  function handle({ bot, secretHeader, update, limit = null, ctx: extra = {} }) {
    if (!bot?.token || !sameSecret(secretHeader, bot.secret)) { stats.badSecret++; return { status: 401, body: { error: 'bad secret' } }; }
    stats.updates++;
    const id = Number(update?.update_id);
    const seenKey = `${bot.botId}|${id}`;
    if (Number.isFinite(id)) {
      if (seen.has(seenKey)) { stats.duplicate++; return { status: 200, body: { ok: true } }; }
      seen.set(seenKey, now());
      if (seen.size > 2000) for (const k of [...seen.keys()].slice(0, 1000)) seen.delete(k);
    }
    const msg = update?.message;
    const cmd = msg && typeof msg.text === 'string' && msg.chat?.id != null ? parseCommand(msg.text, bot.username) : null;
    if (!cmd || !(cmd.name in handlers || ['settings', 'help', 'start'].includes(cmd.name))) { stats.ignored++; return { status: 200, body: { ok: true } }; }
    stats.commands++;
    stats.byCommand[cmd.name] = (stats.byCommand[cmd.name] || 0) + 1;
    stats.lastAt = new Date(now()).toISOString();
    const chat = String(msg.chat.id);
    const work = (async () => {
      const app = `tg:${bot.botId}`;
      const cur = settings ? await settings.get(app, chat).catch(() => ({})) : {};
      const ctx = { ...extra, app, chat, guild: chat, user: String(msg.from?.id || ''), settings: cur || {} };
      let reply;
      const stop = limit ? await limit(ctx, cmd.name) : null;
      if (stop) {
        stats.limited++;
        // one "over the limit" note a minute per chat, then silence
        const k = `${app}|${chat}`;
        if (now() - (limitNoted.get(k) || 0) < 60e3) return null;
        limitNoted.set(k, now());
        if (limitNoted.size > 5000) limitNoted.clear();
        reply = render(stop, { now: now() });
      } else {
        reply = await answer(bot.token, msg, cmd, ctx).catch(e => {
          stats.errors++; stats.lastError = scrub(e?.message || e);
          log.warn?.(`Telegram bot (${cmd.name}): ${stats.lastError}`);
          return plain('Something went wrong', ['That could not be answered just now. Try again in a minute.']);
        });
      }
      const body = { chat_id: msg.chat.id, ...reply, reply_parameters: { message_id: msg.message_id, allow_sending_without_reply: true } };
      if (msg.message_thread_id && msg.is_topic_message) body.message_thread_id = msg.message_thread_id;
      try { await call(bot.token, 'sendMessage', body); return body; } catch (e) {
        stats.sendErrors++; stats.lastError = scrub(`${e?.response?.status || ''} ${e?.response?.data?.description || e?.message || e}`.trim());
        log.warn?.(`Telegram bot send: ${stats.lastError}`);
        return null;
      }
    })();
    return { status: 200, body: { ok: true }, work };
  }
  // point the bot at our webhook and set its command menu
  // → { ok, username, why }
  async function connect(token, url) {
    const why = e => {
      const st = e?.response?.status;
      return st === 401 || st === 404 ? 'Telegram turned the token away. In @BotFather send /mybots, pick the bot, API Token, and copy it again.'
        : st === 429 ? 'Telegram is rate limiting. Try again in a minute.'
          : st === 400 ? `Telegram refused the webhook: ${scrub(e?.response?.data?.description || 'bad request')}` : 'Could not reach Telegram. Try again in a minute.';
    };
    let me;
    try { me = await call(token, 'getMe', {}); } catch (e) { return { ok: false, why: why(e) }; }
    try {
      await call(token, 'setWebhook', { url, secret_token: secretOf(token), allowed_updates: ['message'], drop_pending_updates: false, max_connections: 20 });
      await call(token, 'setMyCommands', { commands: COMMANDS });
    } catch (e) { return { ok: false, username: me?.username || null, why: why(e) }; }
    return { ok: true, username: me?.username || null, botId: String(me?.id || botIdOf(token) || '') };
  }
  // stop Telegram sending updates (a customer disconnecting)
  async function disconnect(token) {
    try { await call(token, 'deleteWebhook', { drop_pending_updates: true }); return { ok: true }; } catch (e) { return { ok: false, why: scrub(e?.message) }; }
  }
  return { handle, connect, disconnect, stats: () => ({ ...stats, byCommand: { ...stats.byCommand } }) };
}

module.exports = { API, COMMANDS, TOKEN_RE, BOT_ID_RE, commandsHash, botIdOf, secretOf, sameSecret, ownerConfig, parseCommand, optsOf, relTime, mdToHtml, render, helpText, settingsMessage, createTelegramBot };
