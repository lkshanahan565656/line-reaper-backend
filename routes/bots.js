// Discord slash commands and Telegram bot commands (discordbot.js, telegrambot.js)
// Moved out of server.js as it was (the route split): mount(ctx) runs where
// the section used to be, so routes keep their order. ctx carries what the
// section reads from server.js; it returns what server.js reads back.
'use strict';

module.exports = function mount(ctx) {
const {
  PAYWALL, V1Error, apiKeys, apiLimiter, app, digestOrigin, feedDoc, freeBooksState, lineHist,
  lineIndexBody, lineQuery, oddsFmt, oddsHistory, oddsScreen, oddsScreenFor, outFeedReady,
  outFeedSeal, outFeedStore, planOfUserId, plans, propsBoard, propsBoardAt, propsBoardRows,
  pubRecord, pubView, publicApi, searchLib, siteOrigin, v1, v1Auth, v1Fail, v1FullTier, v1KeyOf,
  v1Limits, v1Safe, venues, webhookLicence
} = ctx;

const discordBot = require('../discordbot');
const botOwner = discordBot.ownerConfig(process.env);
for (const p of botOwner.problems) console.warn(`Discord bot: ${p}`);
const botSettings = discordBot.createSettings({ store: outFeedStore });
// the owner's app: 30 commands a minute and 3,000 a day per server (or per person in a DM)
const botGuildLimiter = publicApi.createLimiter({ perMinute: 30, perDay: 3000 });
const botState = { commands: null, connects: new Map(), used: new Map() };
const botOwnerPlan = () => (PAYWALL ? 'free' : 'pro');
const botFmt = ctx => a => oddsFmt.fromAm(a, oddsFmt.fmtOf(ctx.settings?.odds));
const botScreenMemo = new Map();
function botScreen(state) {
  const lic = webhookLicence();
  const key = `${state || ''}|${lic.kalshi ? 1 : 0}|${lic.polymarket ? 1 : 0}|${freeBooksState.gamesAt || ''}|${v1FullTier() ? 1 : 0}`;
  const hit = botScreenMemo.get(key);
  if (hit && Date.now() - hit.at < 30e3) return hit.v;
  const s = oddsScreenFor({ state, kalshiOk: !!lic.kalshi });
  const screen = v1Safe(v1FullTier() ? s : { ...oddsScreen.stripPro(s), updated: s.updated, stale: s.stale });
  if (!lic.polymarket) for (const g of screen.games) for (const m of g.markets) for (const sd of m.sides) sd.venues = sd.venues.filter(v => !String(v.venue).startsWith('polymarket'));
  const v = { screen, entries: searchLib.build({ screen }) };
  if (botScreenMemo.size > 60) botScreenMemo.clear();
  botScreenMemo.set(key, { at: Date.now(), v });
  return v;
}
let botPropsMemo = { at: 0, entries: [] };
function botPropEntries(rows) {
  if (botPropsMemo.at !== propsBoardAt() || botPropsMemo.rows !== rows) botPropsMemo = { at: propsBoardAt(), rows, entries: searchLib.build({ propRows: rows }) };
  return botPropsMemo.entries;
}
const botTry = fn => async (opts, ctx) => {
  try { return await fn(opts, ctx); } catch (e) {
    if (e instanceof V1Error) return discordBot.message({ title: 'Not found', description: e.message, color: 0x94a3b8 }, { ephemeral: true });
    throw e;
  }
};
const botHandlers = {
  odds: botTry((opts, ctx) => {
    const state = venues.stateOf(ctx.settings.state) || null;
    const { screen, entries } = botScreen(state);
    const hits = searchLib.query(entries, opts.game, { kinds: ['game'], limit: 4, perKind: 4 });
    const games = hits.map(h => screen.games.find(g => `g:${g.id}` === h.id)).filter(Boolean);
    return discordBot.oddsMessage({ q: searchLib.cleanQ(opts.game), games, more: games.slice(1), stale: !!screen.stale && games.length > 0, linesAt: screen.updated, withFair: v1FullTier(),
      state, stateName: state ? venues.stateInfo(state).name : null, origin: ctx.origin, fmt: botFmt(ctx), hasHistory: id => oddsHistory.forGame(id).length > 0, ...(ctx.setter ? { setter: ctx.setter } : {}) });
  }),
  props: botTry((opts, ctx) => {
    const rows = propsBoardRows().rows || [];
    const hits = searchLib.query(botPropEntries(rows), opts.player, { kinds: ['player'], limit: 4, perKind: 4 });
    const p = hits[0] || null;
    const lic = webhookLicence();
    const mine = p ? rows.filter(r => `p:${r.sport || ''}|${searchLib.norm(r.player)}` === p.id) : [];
    const shown = v1Safe(mine.map(r => (v1FullTier() && (lic.kalshi || r.esports) ? r : propsBoard.redactRow(r))));
    return discordBot.propsMessage({ q: searchLib.cleanQ(opts.player), player: p, rows: shown, more: hits.slice(1), withFair: v1FullTier(), origin: ctx.origin,
      updatedAt: propsBoardAt() ? new Date(propsBoardAt()).toISOString() : null });
  }),
  moves: botTry((opts, ctx) => {
    const type = opts.type === 'line' ? 'line' : 'price';
    const body = v1Safe(v1.moves({ window: opts.window, type, league: opts.league ? String(opts.league).toLowerCase() : null, limit: 6 }));
    return discordBot.movesMessage({ rows: body.rows, type, window: body.window, league: body.league, stale: body.stale, at: body.at, origin: ctx.origin, fmt: botFmt(ctx) });
  }),
  record: botTry(async (opts, ctx) => {
    if (opts.handle) {
      const h = String(opts.handle).replace(/^@/, '').trim().toLowerCase();
      const v = await pubView(h, 1);
      const row = v && v.status === 'live' ? pubRecord.indexRow(v) : null;
      return discordBot.bettorMessage({ handle: h, row, status: v?.status || null, origin: ctx.origin });
    }
    return discordBot.recordMessage({ card: v1Safe(publicApi.recordCard(await v1.record({}))), origin: ctx.origin });
  }),
  lines: botTry((opts, ctx) => {
    const days = PAYWALL ? plans.limitsOf(ctx.plan || 'free').historyDays : lineHist.KEEP_DAYS;
    const q = searchLib.cleanQ(opts.market);
    return discordBot.linesMessage({ q, body: v1Safe(lineIndexBody(lineQuery({ q }), { days, limit: 8 })), origin: ctx.origin });
  }),
};
const botLimitMsg = text => discordBot.message({ title: 'Over the limit', description: text, color: 0xf87171 }, { ephemeral: true });
async function botLimit(ctx) {
  if (ctx.keyDoc) {
    // a customer's app: each command is one API call on their key's plan
    const plan = await planOfUserId(ctx.keyDoc.userId);
    ctx.plan = plan;
    const lim = apiLimiter.take(ctx.keyDoc.id, v1Limits(plan));
    if (!lim.ok) return botLimitMsg(lim.over === 'day' ? `This bot has used its ${lim.dayLimit} calls for today (UTC). It answers again tomorrow.` : `This bot is over ${lim.limit} calls this minute. Try again in ${lim.retryAfter} s.`);
    const tg = ctx.kind === 'telegram', usedKey = `${tg ? 'tg' : 'dc'}|${ctx.keyDoc.id}`;
    const last = botState.used.get(usedKey) || 0;
    if (Date.now() - last > 600e3) { botState.used.set(usedKey, Date.now()); (tg ? apiKeys.markTgBot : apiKeys.markBot)(ctx.keyDoc.id, { lastUseAt: new Date().toISOString() }).catch(() => {}); }
    return null;
  }
  ctx.plan = botOwnerPlan();
  const lim = botGuildLimiter.take(ctx.guild ? `${ctx.app}|${ctx.guild}` : `dm|${ctx.user}`);
  if (!lim.ok) return botLimitMsg(lim.over === 'day' ? `This ${ctx.kind === 'telegram' ? 'chat' : 'server'} has asked a lot today. The bot answers again tomorrow (UTC).` : `Lots of commands this minute here. Try again in ${lim.retryAfter} s.`);
  return null;
}
const botHandler = discordBot.createBot({ handlers: botHandlers, settings: botSettings, stateOf: s => venues.stateOf(s), stateName: s => venues.stateInfo(s)?.name || s });
async function discordInteraction(req, res) {
  try {
    let key, appId, keyDoc = null;
    if (req.params.appId) {
      await apiKeys.init().catch(() => {});
      keyDoc = apiKeys.botFor(req.params.appId);
      if (!keyDoc) return res.status(404).set('Cache-Control', 'no-store').json({ error: 'No Line Reaper bot is connected for that application. Connect it at /developers#bot.' });
      key = discordBot.publicKeyOf(keyDoc.bot.publicKey); appId = keyDoc.bot.appId;
    } else {
      if (!botOwner.on) return res.status(404).set('Cache-Control', 'no-store').json({ error: 'The Discord bot is off on this server.' });
      key = botOwner.key; appId = botOwner.appId;
    }
    const out = await botHandler.handle({ key, appId, signature: req.get('x-signature-ed25519'), timestamp: req.get('x-signature-timestamp'),
      body: Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0), limit: botLimit, ctx: { origin: siteOrigin(req), keyDoc } });
    res.status(out.status).set('Cache-Control', 'no-store').json(out.body);
  } catch (e) {
    console.warn('Discord bot:', e.message);
    res.status(500).set('Cache-Control', 'no-store').json({ error: 'server error' });
  }
}
// the owner's commands are registered once per command list (and again when it changes)
async function botRegisterOwner() {
  if (!botOwner.on) return null;
  await outFeedReady;
  const hash = `${discordBot.commandsHash()}|${botOwner.appId}`;
  const prev = await feedDoc('bot-commands');
  if (prev?.hash === hash && prev.ok) { botState.commands = prev; return prev; }
  const r = await botHandler.register(botOwner.appId, botOwner.token);
  botState.commands = { hash, at: new Date().toISOString(), ok: r.ok, count: r.count ?? null, why: r.why || null };
  if (r.ok) await outFeedStore.put({ id: 'bot-commands', ...botState.commands });
  return botState.commands;
}
if (require.main === module) setTimeout(() => botRegisterOwner().catch(e => { botState.commands = { ok: false, why: e.message }; }), 20e3).unref?.();
function botStatus() {
  const s = botHandler.stats();
  return { on: botOwner.on, owner: { appId: botOwner.appId, endpoint: '/discord/interactions', problems: botOwner.problems, commands: botState.commands ? { ok: botState.commands.ok, at: botState.commands.at || null, count: botState.commands.count ?? null, why: botState.commands.why || null } : null },
    customers: apiKeys.bots().length, commands: discordBot.COMMANDS.map(c => `/${c.name}`), limits: { owner: '30 a minute, 3,000 a day per server', customer: "the key's plan API limits" },
    interactions: s.interactions, pings: s.pings, byCommand: s.byCommand, deferred: s.deferred, limited: s.limited, badSignature: s.badSignature, errors: s.errors, followupErrors: s.followupErrors, lastAt: s.lastAt, lastError: s.lastError };
}
// ── self-serve: a customer connects their own Discord app with their API key ──
function botView(doc, origin) {
  const b = doc?.bot;
  if (!b) return { connected: false };
  return { connected: true, appId: b.appId, addedAt: b.addedAt, lastUseAt: b.lastUseAt || null, commands: b.commands ?? null,
    endpoint: `${origin}/discord/interactions/${b.appId}`, install: discordBot.installUrl(b.appId) };
}
const BOT_ABOUT = { commands: discordBot.COMMANDS.map(c => ({ name: `/${c.name}`, about: c.description })), same: 'Everyone who asks the same thing gets the same answer. Nothing is sized or picked per person, and nothing places a bet.',
  limits: "Each command is one API call on this key's plan." };
app.get('/api/v1/bot', v1Auth, (req, res) => res.set('Cache-Control', 'no-store').json({ discord: botView(req.apiKey, siteOrigin(req)), telegram: tgView(req.apiKey), plan: req.apiPlan, limits: v1Limits(req.apiPlan), ...BOT_ABOUT }));
app.put('/api/v1/bot/discord', v1Auth, async (req, res) => {
  try {
    const appId = String(req.body?.appId || '').trim(), publicKey = String(req.body?.publicKey || '').trim().toLowerCase(), token = String(req.body?.botToken || '').trim();
    if (!discordBot.APP_ID_RE.test(appId)) throw new V1Error(400, 'bad_parameter', 'appId is the Application ID: the long number under General Information in the Discord Developer Portal.');
    if (!discordBot.publicKeyOf(publicKey)) throw new V1Error(400, 'bad_parameter', 'publicKey is the Public Key under General Information: 64 letters and digits.');
    if (!discordBot.TOKEN_RE.test(token)) throw new V1Error(400, 'bad_parameter', 'botToken is the token from Bot > Reset Token. It is used once to add the commands and never kept.');
    const t = Date.now(), seen = (botState.connects.get(req.apiKey.id) || []).filter(x => t - x < 3600e3);
    if (seen.length >= 5) throw new V1Error(429, 'rate_limited', 'At most 5 connects an hour per key. Try again later.');
    botState.connects.set(req.apiKey.id, [...seen, t]);
    if (botState.connects.size > 5000) botState.connects.clear();
    if (botOwner.appId && appId === botOwner.appId) throw new V1Error(409, 'already_connected', 'That is this site\'s own bot application.');
    const other = apiKeys.botFor(appId);
    if (other && other.id !== req.apiKey.id) throw new V1Error(409, 'already_connected', 'That application is already connected with another key.');
    const reg = await botHandler.register(appId, token);
    if (!reg.ok) throw new V1Error(400, 'bad_bot', reg.why);
    const doc = await apiKeys.setBot(v1KeyOf(req), { appId, publicKey, addedAt: new Date().toISOString(), commands: reg.count, lastUseAt: null });
    const view = botView(doc, siteOrigin(req));
    res.set('Cache-Control', 'no-store').json({ discord: view, note: `Commands added. Last two steps in Discord: paste ${view.endpoint} as the Interactions Endpoint URL (General Information, then Save Changes), then open the install link and pick your server. The bot token was used once and not kept.`, ...BOT_ABOUT });
  } catch (e) { v1Fail(res, e); }
});
app.delete('/api/v1/bot/discord', v1Auth, async (req, res) => {
  try { const doc = await apiKeys.setBot(v1KeyOf(req), null); res.set('Cache-Control', 'no-store').json({ discord: botView(doc, siteOrigin(req)), note: 'Disconnected: commands sent to that application now fail. Clear the Interactions Endpoint URL in Discord too.' }); }
  catch (e) { v1Fail(res, e); }
});
// ─── TELEGRAM BOT COMMANDS (telegrambot.js) ──────────────────────────────────
// /odds /props /moves /record /lines /settings /help in a Telegram group or
// private chat, answered by the Discord bot's handlers above (the same public
// numbers, written out for Telegram). Telegram's webhook, no polling, no extra
// process. The owner's bot is TELEGRAM_BOT_TOKEN (the feed's variable): on
// boot its webhook is pointed at /telegram/webhook and its command menu set,
// only when either changed; without the variable the endpoint answers 404. A
// customer's own bot, connected on /developers#bot, answers at
// /telegram/webhook/<bot id> and spends its key's API limits.
const telegramBot = require('../telegrambot');
const tgOwner = telegramBot.ownerConfig(process.env);
for (const p of tgOwner.problems) console.warn(`Telegram bot: ${p}`);
const tgState = { owner: null, username: null };
const tgHandler = telegramBot.createTelegramBot({ handlers: botHandlers, settings: botSettings, stateOf: s => venues.stateOf(s), stateName: s => venues.stateInfo(s)?.name || s });
const tgOwnerUrl = () => `${digestOrigin()}/telegram/webhook`;
app.post(['/telegram/webhook', '/telegram/webhook/:botId'], async (req, res) => {
  try {
    let bot, keyDoc = null;
    if (req.params.botId) {
      await apiKeys.init().catch(() => {});
      keyDoc = telegramBot.BOT_ID_RE.test(req.params.botId) ? apiKeys.tgBotFor(req.params.botId) : null;
      const token = keyDoc ? outFeedSeal.open(keyDoc.tgBot.sealed) : null;
      if (!token) return res.status(404).set('Cache-Control', 'no-store').json({ error: 'No Line Reaper bot is connected for that Telegram bot. Connect it at /developers#bot.' });
      bot = { token, botId: keyDoc.tgBot.botId, secret: telegramBot.secretOf(token), username: keyDoc.tgBot.username || null };
    } else {
      if (!tgOwner.on) return res.status(404).set('Cache-Control', 'no-store').json({ error: 'The Telegram bot is off on this server.' });
      bot = { token: tgOwner.token, botId: tgOwner.botId, secret: tgOwner.secret, username: tgState.username };
    }
    const out = tgHandler.handle({ bot, secretHeader: req.get('x-telegram-bot-api-secret-token'), update: req.body || {}, limit: botLimit,
      ctx: { origin: siteOrigin(req), keyDoc, kind: 'telegram', setter: 'a group admin' } });
    res.status(out.status).set('Cache-Control', 'no-store').json(out.body);
    if (out.work) await out.work.catch(() => {});
  } catch (e) {
    console.warn('Telegram bot:', e.message);
    if (!res.headersSent) res.status(500).set('Cache-Control', 'no-store').json({ error: 'server error' });
  }
});
// the owner's webhook and menu: set once per URL and command list (and again
// when Telegram reports a different webhook, e.g. after a manual change)
async function tgConnectOwner() {
  if (!tgOwner.on) return null;
  await outFeedReady;
  const url = tgOwnerUrl();
  const hash = `${telegramBot.commandsHash()}|${url}|${tgOwner.botId}`;
  const prev = await feedDoc('tg-webhook');
  if (prev?.hash === hash && prev.ok) {
    const info = await require('axios').post(`${telegramBot.API}/bot${tgOwner.token}/getWebhookInfo`, {}, { timeout: 10000 }).then(r => r?.data?.result).catch(() => null);
    if (!info || info.url === url) { tgState.owner = prev; tgState.username = prev.username || null; return prev; }
  }
  const r = await tgHandler.connect(tgOwner.token, url);
  tgState.owner = { hash, at: new Date().toISOString(), ok: r.ok, username: r.username || null, why: r.why || null };
  if (r.username) tgState.username = r.username;
  if (r.ok) await outFeedStore.put({ id: 'tg-webhook', ...tgState.owner });
  return tgState.owner;
}
if (require.main === module) setTimeout(() => tgConnectOwner().catch(e => { tgState.owner = { ok: false, why: e.message }; }), 25e3).unref?.();
function tgStatus() {
  const s = tgHandler.stats();
  return { on: tgOwner.on, owner: { botId: tgOwner.botId, username: tgState.username, endpoint: '/telegram/webhook', problems: tgOwner.problems,
    webhook: tgState.owner ? { ok: tgState.owner.ok, at: tgState.owner.at || null, why: tgState.owner.why || null } : null },
  customers: apiKeys.tgBots().length, commands: telegramBot.COMMANDS.map(c => `/${c.command}`), limits: { owner: '30 a minute, 3,000 a day per chat', customer: "the key's plan API limits" },
  updates: s.updates, commandsAnswered: s.commands, byCommand: s.byCommand, ignored: s.ignored, duplicate: s.duplicate, limited: s.limited, badSecret: s.badSecret, errors: s.errors, sendErrors: s.sendErrors, lastAt: s.lastAt, lastError: s.lastError };
}
// ── self-serve: a customer connects their own Telegram bot with their API key ──
function tgView(doc) {
  const b = doc?.tgBot;
  if (!b) return { connected: false };
  return { connected: true, botId: b.botId, username: b.username || null, addedAt: b.addedAt, lastUseAt: b.lastUseAt || null, open: b.username ? `https://t.me/${b.username}` : null,
    addToGroup: b.username ? `https://t.me/${b.username}?startgroup=start` : null };
}
app.put('/api/v1/bot/telegram', v1Auth, async (req, res) => {
  try {
    const token = String(req.body?.botToken || '').trim();
    const botId = telegramBot.botIdOf(token);
    if (!botId) throw new V1Error(400, 'bad_parameter', 'botToken is the token @BotFather sends after /newbot, like 123456789:AA… (in @BotFather: /mybots, your bot, API Token).');
    const t = Date.now(), cKey = `tg|${req.apiKey.id}`, seen = (botState.connects.get(cKey) || []).filter(x => t - x < 3600e3);
    if (seen.length >= 5) throw new V1Error(429, 'rate_limited', 'At most 5 connects an hour per key. Try again later.');
    botState.connects.set(cKey, [...seen, t]);
    if (tgOwner.botId && botId === tgOwner.botId) throw new V1Error(409, 'already_connected', 'That is this site\'s own Telegram bot.');
    const other = apiKeys.tgBotFor(botId);
    if (other && other.id !== req.apiKey.id) throw new V1Error(409, 'already_connected', 'That Telegram bot is already connected with another key.');
    const r = await tgHandler.connect(token, `${siteOrigin(req)}/telegram/webhook/${botId}`);
    if (!r.ok) throw new V1Error(400, 'bad_bot', r.why);
    const doc = await apiKeys.setTgBot(v1KeyOf(req), { botId, username: r.username || null, sealed: outFeedSeal.seal(token), addedAt: new Date().toISOString(), lastUseAt: null });
    const view = tgView(doc);
    res.set('Cache-Control', 'no-store').json({ telegram: view, note: `Connected${view.username ? ` as @${view.username}` : ''}. Add the bot to a group (or open a chat with it) and send /odds Lakers. The token is kept sealed on the server, only to send the answers.`, ...BOT_ABOUT, commands: telegramBot.COMMANDS.map(c => ({ name: `/${c.command}`, about: c.description })) });
  } catch (e) { v1Fail(res, e); }
});
app.delete('/api/v1/bot/telegram', v1Auth, async (req, res) => {
  try {
    const token = req.apiKey?.tgBot ? outFeedSeal.open(req.apiKey.tgBot.sealed) : null;
    if (token) await tgHandler.disconnect(token);
    const doc = await apiKeys.setTgBot(v1KeyOf(req), null);
    res.set('Cache-Control', 'no-store').json({ telegram: tgView(doc), note: 'Disconnected: Telegram no longer sends that bot\'s messages here, and the token is gone from the server.' });
  } catch (e) { v1Fail(res, e); }
});

return {
  discordBot, discordInteraction, botStatus, tgConnectOwner, tgStatus
};
};
