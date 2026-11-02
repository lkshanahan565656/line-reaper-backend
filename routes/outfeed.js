// Outbound feed: Discord and Telegram (outfeed.js)
// Moved out of server.js as it was (the route split): mount(ctx) runs where
// the section used to be, so routes keep their order. ctx carries what the
// section reads from server.js; it returns what server.js reads back.
'use strict';

module.exports = function mount(ctx) {
const {
  V1Error, apiKeys, app, bigMoves, claims, closeBoardFor, createEvStoreFromEnv, digestOrigin,
  movesFor, planOfUserId, plans, pubRecord, pubRecords, pubTables, publicApi, recordKey,
  resultsBackup, sendErr, setDiscordAlertTap, stripPolymarketLinks, v1Auth, v1Fail, v1KeyOf,
  webhookLicence
} = ctx;

const outFeed = require('../outfeed');
const outFeedOwner = outFeed.ownerDestinations(process.env);
for (const p of outFeedOwner.problems) console.warn(`Feed: ${p}`);
// sealed with FEED_SECRET, else the results backup key; every backup key this
// server can make still opens what was sealed before either changed
const outFeedSeal = (() => {
  const backupKeys = require('../backup').keysFromEnv(process.env);
  const feedKey = process.env.FEED_SECRET ? require('crypto').createHash('sha256').update(`line-reaper-feed|${process.env.FEED_SECRET}`).digest() : backupKeys[0] || null;
  return outFeed.sealer(feedKey, backupKeys);
})();
const outFeedStore = resultsBackup.wrap('outFeed', createEvStoreFromEnv(process.env, { table: 'out_feed', fileVar: 'OUT_FEED_FILE', file: 'out-feed.json' }), { appendOnly: false });
const outFeedReady = outFeedStore.init().catch(e => console.warn('Feed store:', e.message));
const outFeedState = { record: { checkedAt: null, rows: 0, posted: null, error: null }, moves: { last: null, error: null }, digest: { last: null, error: null }, ownerCheck: null, connects: new Map() };
// a customer's channel gets the feed while the key's plan includes it
// (plans.js: Pro once the paywall is on); a lapsed plan pauses it, nothing is deleted
async function feedSubscribers() {
  const out = [];
  for (const { keyId, feed, userId } of apiKeys.feeds()) {
    if (!plans.limitsOf(await planOfUserId(userId)).discordFeed) continue;
    if (feed.results === false) continue;   // a channel that asked for bettor records only
    const url = outFeedSeal.open(feed.sealed);
    if (url) out.push({ kind: 'discord', id: `key-${keyId}`, keyId, url });
  }
  return out;
}
const outFeedSender = outFeed.createFeed({ owner: outFeedOwner.dests, subscribers: feedSubscribers,
  onResult: (d, r) => {
    if (d.keyId) apiKeys.markFeed(d.keyId, r).catch(e => console.warn('Feed: status save failed:', e.message));
    else if (d.recordHandle) pubRecords.markFeed(d.recordHandle, d.kind, r).catch(e => console.warn('Record feed: status save failed:', e.message));
  } });
const feedOn = () => outFeedOwner.dests.length > 0 || apiKeys.feeds().some(x => x.feed.results !== false);
// ── the owned Discord server (DEPLOY.md, "Owned Discord server") ──
// Owner channels named alerts=… (or some alert kinds) get the tracker's alerts,
// the same text as the alert webhook and phone push, DISCORD_ALERT_DELAY_MIN
// minutes after members get them (default 30; 0 posts them as they go out).
// One post per channel per minute at most. DISCORD_INVITE_URL is the server's
// public invite: /discord redirects to it and the pages show a JOIN link.
const DISCORD_INVITE = outFeed.parseInvite(process.env.DISCORD_INVITE_URL);
if (process.env.DISCORD_INVITE_URL && !DISCORD_INVITE) console.warn('Feed: DISCORD_INVITE_URL is not a discord.gg or discord.com/invite link; no JOIN link is shown');
const DISCORD_ALERT_DELAY_MIN = (() => {
  const raw = process.env.DISCORD_ALERT_DELAY_MIN;
  const n = raw == null || String(raw).trim() === '' ? 30 : Number(raw);
  return Number.isFinite(n) ? Math.min(1440, Math.max(0, Math.round(n))) : 30;
})();
const ownerAlerts = outFeed.createAlertRelay({ owner: outFeedOwner.dests, sendTo: (d, p) => outFeedSender.sendTo(d, p), delayMs: DISCORD_ALERT_DELAY_MIN * 60e3, origin: () => digestOrigin() });
if (ownerAlerts.on) {
  setDiscordAlertTap(a => ownerAlerts.add(a));
  setInterval(() => { ownerAlerts.flush().catch(e => console.warn('Owner alerts:', e.message)); }, 60e3).unref();
}
app.get('/discord', (req, res) => {
  if (DISCORD_INVITE) return res.redirect(302, DISCORD_INVITE);
  res.status(404).set('Cache-Control', 'no-cache').type('html').send('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Line Reaper Discord</title><body style="background:#080b10;color:#e2e8f0;font:14px/1.6 system-ui,sans-serif;padding:32px 16px;max-width:560px;margin:0 auto"><h1 style="font-size:18px">The Line Reaper Discord is not open yet.</h1><p>The record, alert history and line moves are on the site in the meantime.</p><p><a style="color:#34d399" href="/app">Open the app</a> · <a style="color:#34d399" href="/alerts">Alert history</a></p></body>');
});
async function feedDoc(id) { await outFeedReady; return (await outFeedStore.all()).find(d => d.id === id) || null; }
const feedBackupOk = () => { const bk = process.env.DATABASE_URL ? 'ready' : resultsBackup.status().state; return bk === 'ready' || bk === 'off'; };
// the Monday digest, from publishDigest once the week is frozen
async function feedDigest(d) {
  if (!feedOn()) return null;
  const r = await outFeedSender.send(outFeed.digestPost(d, { origin: digestOrigin() }));
  outFeedState.digest.last = { week: d.week, at: new Date().toISOString(), ...r };
  return r;
}
// hourly: compare the strict record with the last read; a change that holds on
// two reads in a row is posted once. The first read is only a baseline.
async function feedRecordCheck() {
  if (!feedBackupOk()) { outFeedState.record.error = 'results backup not ready: waiting'; return null; }
  const rec = claims.publicRecord({ board: await closeBoardFor(webhookLicence(), 0, null) });
  const prev = await feedDoc('record-labels');
  const { state, changes } = outFeed.recordChanges(prev?.state || null, rec);
  await outFeedStore.put({ id: 'record-labels', state, at: new Date().toISOString() });
  outFeedState.record = { checkedAt: new Date().toISOString(), rows: rec.rows.length, posted: outFeedState.record.posted, error: null };
  if (!changes.length || !feedOn()) return { changes: changes.length, sent: 0 };
  const r = await outFeedSender.send(outFeed.recordPost(changes, { origin: digestOrigin() }));
  outFeedState.record.posted = { at: new Date().toISOString(), changes: changes.map(c => `${c.kindLabel} · ${c.bookName}: ${c.change}`), ...r };
  return { changes: changes.length, ...r };
}
// daily at 21:00 UTC: today's five biggest game-line price moves, once a day
async function feedMoves(now = Date.now()) {
  if (!feedOn()) return null;
  const day = new Date(now).toISOString().slice(0, 10);
  if (await feedDoc(`moves-${day}`)) return null;
  const base = movesFor({ window: 'open', kalshiOk: !!webhookLicence().kalshi });
  if (base.stale) { outFeedState.moves.error = 'odds screen stale: skipped'; return null; }
  const rows = bigMoves.rank(base.rows.filter(r => r.kind === 'game'), { type: 'price', sort: 'move' }).map(r => stripPolymarketLinks(r));
  const p = outFeed.movesPost(rows, { origin: digestOrigin(), now });
  await outFeedStore.put({ id: `moves-${day}`, at: new Date(now).toISOString(), rows: p ? Math.min(5, rows.length) : 0 });
  if (!p) { outFeedState.moves.last = { day, at: new Date(now).toISOString(), rows: 0, sent: 0 }; return null; }
  const r = await outFeedSender.send(p);
  outFeedState.moves = { last: { day, at: new Date(now).toISOString(), rows: Math.min(5, rows.length), ...r }, error: null };
  return r;
}
// When the owner's channels change (a new env var), each gets the welcome post
// once, so setting the variables in Railway shows at once whether they work.
async function feedOwnerCheck() {
  if (!outFeedOwner.dests.length) return null;
  const ids = outFeedOwner.dests.map(d => `${d.id}:${(d.topics || []).join('+')}`).sort().join(',') + (ownerAlerts.on ? `|delay${DISCORD_ALERT_DELAY_MIN}` : '');
  const hash = require('crypto').createHash('sha256').update(ids).digest('hex').slice(0, 16);
  const prev = await feedDoc('owner-check');
  if (prev?.hash === hash) { outFeedState.ownerCheck = prev.result; return prev.result; }
  const result = { at: new Date().toISOString(), channels: [] };
  for (const d of outFeedOwner.dests) {
    const p = outFeed.welcomePost({ origin: digestOrigin(), topics: d.topics || null, alertDelayMin: DISCORD_ALERT_DELAY_MIN });
    const r = await outFeedSender.sendTo(d, p);
    result.channels.push({ kind: d.kind, topics: outFeed.topicsOf(d), ok: r.ok, why: r.ok ? null : r.why });
  }
  outFeedState.ownerCheck = result;
  if (result.channels.every(c => c.ok)) await outFeedStore.put({ id: 'owner-check', hash, result });
  return result;
}
function outFeedStatus() {
  const s = outFeedSender.stats();
  return { on: feedOn(), owner: { discord: outFeedOwner.dests.filter(d => d.kind === 'discord').length, telegram: outFeedOwner.dests.filter(d => d.kind === 'telegram').length, problems: outFeedOwner.problems,
    channels: outFeedOwner.dests.map(d => ({ kind: d.kind, topics: outFeed.topicsOf(d) })), invite: !!DISCORD_INVITE, alerts: ownerAlerts.stats() },
    customers: apiKeys.feeds().length, sealed: outFeedSeal.on,
    records: { owners: pubRecords.liveHandles().filter(h => { const f = pubRecords.feedOf(h); return !!(f && ((f.discord && !f.discord.deadAt) || (f.telegram && !f.telegram.deadAt))); }).length,
      subscribed: apiKeys.feeds().filter(x => (x.feed.handles || []).length).length, lastRun: bettorFeedState.lastRun, handles: bettorFeedState.handles, last: bettorFeedState.last, error: bettorFeedState.error }, schedule: { digest: 'Monday 13:00 UTC', record: 'hourly at :30, a change posts once it holds two reads', moves: 'daily 21:00 UTC' },
    ownerCheck: outFeedState.ownerCheck, record: outFeedState.record, moves: outFeedState.moves, digest: outFeedState.digest,
    sent: s.sent, failed: s.failed, posts: s.posts, lastAt: s.lastAt, lastError: s.lastError, recent: s.recent };
}
// ── a bettor's own record feed (pubrecord.js + outfeed.js) ──
// Each published record's picks logged before their start post at log time
// (once the graders match them to a game), with the server's stamp and the
// price, and their graded results after. They go to the record owner's own
// Discord or Telegram (connected with the record key from MY SLIPS) and to
// every customer channel that added the handle on /developers. The same post
// for every channel; no stake, units, profit or sizing; nothing placed. A pick
// logged late never posts. TAKE OFF THE LIST only touches the /r index.
const bettorFeedState = { lastRun: null, handles: 0, picks: 0, results: 0, sent: 0, failed: 0, error: null, running: false, last: null };
async function bettorDests(h) {
  const out = [];
  const f = pubRecords.feedOf(h) || {};
  if (f.discord && !f.discord.deadAt) { const url = outFeedSeal.open(f.discord.sealed); if (url) out.push({ kind: 'discord', id: `rec-${h}-discord`, url, recordHandle: h }); }
  if (f.telegram && !f.telegram.deadAt) { const token = outFeedSeal.open(f.telegram.sealed); if (token) out.push({ kind: 'telegram', id: `rec-${h}-telegram`, token, chat: f.telegram.chat, recordHandle: h }); }
  // a customer's channel follows the same plan rule as its RESULTS posts (the owner's own channels are free)
  for (const { keyId, feed, userId } of apiKeys.feedsFor(h)) {
    if (!plans.limitsOf(await planOfUserId(userId)).discordFeed) continue;
    const url = outFeedSeal.open(feed.sealed);
    if (url) out.push({ kind: 'discord', id: `key-${keyId}`, keyId, url });
  }
  return out;
}
async function feedBettors({ only = null, now = Date.now() } = {}) {
  if (bettorFeedState.running || !feedBackupOk()) return bettorFeedState;
  bettorFeedState.running = true;
  let handles = 0, picks = 0, results = 0, sent = 0, failed = 0;
  try {
    await pubRecords.init();
    for (const h of only ? [only] : pubRecords.liveHandles()) {
      const dests = await bettorDests(h);
      const id = `rf|${h}`;
      const prev = await feedDoc(id);
      if (!dests.length) { if (prev?.active) await outFeedStore.put({ id, ...outFeed.idleBettorFeed(prev) }); continue; }
      handles++;
      const meta = pubRecords.get(h);
      const v = pubRecord.recordView(meta, pubRecords.slipsOf(h), { tables: pubTables(), perPage: 1e6, bets: pubRecords.betsOf(h), now });
      const plan = outFeed.planBettorFeed(prev, pubRecord.feedItems(v), { now });
      // the marks are saved before anything is sent: a crash costs a post, never a double post
      await outFeedStore.put({ id, ...plan.state });
      const o = digestOrigin();
      for (const p of [outFeed.bettorPickPost(h, plan.picks, { origin: o, now }), outFeed.bettorResultPost(h, plan.results, pubRecord.bettorCard(v), { origin: o, now })]) {
        if (!p) continue;
        const r = await outFeedSender.send(p, { to: dests });
        sent += r.sent; failed += r.failed;
      }
      picks += plan.picks.length; results += plan.results.length;
      if (plan.picks.length || plan.results.length) bettorFeedState.last = { at: new Date(now).toISOString(), handle: h, picks: plan.picks.length, results: plan.results.length, to: dests.length };
    }
    Object.assign(bettorFeedState, { lastRun: new Date(now).toISOString(), handles, picks, results, sent, failed, error: null });
  } finally { bettorFeedState.running = false; }
  return bettorFeedState;
}
// the owner's channels, as the app shows them (never a URL or a token)
function recordFeedView(f) {
  const one = (x, kind) => (!x ? { connected: false } : { connected: !x.deadAt, kind, where: kind === 'discord' ? `webhook …${String(x.hookId).slice(-4)}${x.name ? ` ("${x.name}")` : ''}` : `chat ${x.chat}`,
    addedAt: x.addedAt, lastOkAt: x.lastOkAt || null, lastError: x.lastError || null, stoppedAt: x.deadAt || null,
    stoppedWhy: x.deadAt ? `${kind === 'discord' ? 'Discord' : 'Telegram'} said the channel is gone, or 5 posts in a row failed. Connect it again to restart.` : null });
  return { discord: one(f?.discord, 'discord'), telegram: one(f?.telegram, 'telegram') };
}
const recordFeedConnects = new Map();
function recordOwner(req) {
  const h = pubRecord.cleanHandle(req.params.handle).handle;
  const r = h && pubRecords.get(h);
  if (!r || r.status !== 'live') throw Object.assign(new Error('No published record with that handle.'), { status: 404 });
  if (!pubRecords.owns(h, recordKey(req))) throw Object.assign(new Error('That key does not manage this record.'), { status: 403 });
  return h;
}
const RECORD_FEED_ABOUT = 'Each pick logged before its start posts the moment the server matches it to its game, with the server\'s time stamp and the price; its graded result posts after the game. The same words every channel gets: no stake, units, profit or sizing, and nothing is placed. A pick logged late never posts.';
app.get('/api/records/:handle/feed', async (req, res) => {
  try { await pubRecords.init(); const h = recordOwner(req); res.set('Cache-Control', 'no-store').json({ handle: h, ...recordFeedView(pubRecords.feedOf(h)), subscribers: apiKeys.feedsFor(h).length, about: RECORD_FEED_ABOUT }); }
  catch (e) { sendErr(res, e); }
});
// body: { discord: "<webhook URL>" } or { telegram: { token, chat } }
app.put('/api/records/:handle/feed', async (req, res) => {
  try {
    await pubRecords.init();
    const h = recordOwner(req);
    const t = Date.now(), seen = (recordFeedConnects.get(h) || []).filter(x => t - x < 3600e3);
    if (seen.length >= 5) throw Object.assign(new Error('At most 5 connects an hour for one record. Try again later.'), { status: 429 });
    recordFeedConnects.set(h, [...seen, t]);
    if (recordFeedConnects.size > 5000) recordFeedConnects.clear();
    const welcome = outFeed.bettorWelcomePost(h, { origin: digestOrigin() });
    let kind, feed;
    if (req.body?.telegram) {
      const d = outFeed.parseTelegram(req.body.telegram.token, req.body.telegram.chat);
      if (d.error) throw Object.assign(new Error(d.error), { status: 400 });
      const sent = await outFeedSender.sendTo({ ...d, id: 'connect' }, welcome);
      if (!sent.ok) throw Object.assign(new Error(`Telegram turned the first post away: ${sent.why}. Add the bot to the chat (as an admin in a channel) and try again.`), { status: 400 });
      kind = 'telegram';
      feed = { botId: d.botId, chat: d.chat, sealed: outFeedSeal.seal(d.token), addedAt: new Date().toISOString(), lastOkAt: new Date().toISOString(), fails: 0, deadAt: null };
    } else {
      const hook = outFeed.parseDiscord(req.body?.discord);
      if (!hook) throw Object.assign(new Error('That is not a Discord webhook URL. It starts https://discord.com/api/webhooks/ (Server Settings > Integrations > Webhooks > Copy Webhook URL).'), { status: 400 });
      let info;
      try { info = (await require('axios').get(hook.url, { timeout: 8000 })).data || {}; } catch (e) {
        const st = e?.response?.status;
        throw Object.assign(new Error(st === 401 || st === 404 ? 'Discord says that webhook does not exist (deleted, or the URL is cut short). Copy it again.' : 'Could not reach Discord to check the webhook. Try again in a minute.'), { status: 400 });
      }
      const sent = await outFeedSender.sendTo({ kind: 'discord', id: 'connect', url: hook.url }, welcome);
      if (!sent.ok) throw Object.assign(new Error(`Discord turned the first post away: ${sent.why}`), { status: 400 });
      kind = 'discord';
      feed = { hookId: hook.id, sealed: outFeedSeal.seal(hook.url), name: outFeed.clean(info.name || '').slice(0, 40) || null, addedAt: new Date().toISOString(), lastOkAt: new Date().toISOString(), fails: 0, deadAt: null };
    }
    const f = await pubRecords.setFeed(h, recordKey(req), kind, feed);
    res.set('Cache-Control', 'no-store').json({ handle: h, ...recordFeedView(f), note: `Connected. A welcome post is in the ${kind === 'discord' ? 'Discord channel' : 'Telegram chat'} now; picks post from the next one you log.`, about: RECORD_FEED_ABOUT });
  } catch (e) { sendErr(res, e); }
});
// ?kind=discord|telegram
app.delete('/api/records/:handle/feed', async (req, res) => {
  try {
    await pubRecords.init();
    const h = recordOwner(req);
    const kind = String(req.query.kind || req.body?.kind || '');
    if (!pubRecord.FEED_KINDS.includes(kind)) throw Object.assign(new Error('kind is discord or telegram'), { status: 400 });
    const f = await pubRecords.setFeed(h, recordKey(req), kind, null);
    res.set('Cache-Control', 'no-store').json({ handle: h, ...recordFeedView(f), note: `Disconnected: no more posts go to that ${kind === 'discord' ? 'webhook' : 'chat'}.` });
  } catch (e) { sendErr(res, e); }
});

// ── self-serve: a customer connects their own Discord webhook with their API key ──
const FEED_MAX = 5000;
function feedView(doc) {
  const f = doc?.feed;
  if (!f) return { connected: false };
  return { connected: !f.deadAt, webhook: `…${String(f.hookId).slice(-4)}`, name: f.name || null, addedAt: f.addedAt, lastOkAt: f.lastOkAt || null,
    records: { handles: f.handles || [], results: f.results !== false },
    lastFailAt: f.lastFailAt || null, lastError: f.lastError || null, stoppedAt: f.deadAt || null,
    stoppedWhy: f.deadAt ? 'Discord said the webhook is gone, or 5 posts in a row failed. Connect it again to restart.' : null };
}
const FEED_ABOUT = { posts: ['weekly record digest, Mondays 13:00 UTC', 'record changes on RESULTS, checked hourly', "today's biggest line moves, daily 21:00 UTC",
  `each pick logged before its start and its graded result, for up to ${publicApi.FEED_HANDLES} bettor records you add (PUT /api/v1/feed/records)`], same: 'Every channel gets the same posts. Nothing is sized or picked per person.' };
const feedPlanNote = plan => (plans.limitsOf(plan).discordFeed ? null : 'The Discord feed is a Pro feature: a connected channel gets no posts on the Free plan. See /pricing.');
app.get('/api/v1/feed', v1Auth, (req, res) => res.set('Cache-Control', 'no-store').json({ discord: feedView(req.apiKey), plan: req.apiPlan, planNote: feedPlanNote(req.apiPlan), ...FEED_ABOUT }));
app.put('/api/v1/feed/discord', v1Auth, async (req, res) => {
  try {
    if (!plans.limitsOf(req.apiPlan).discordFeed) throw new V1Error(402, 'plan_required', 'The Discord feed is a Pro feature. Make the key while signed in to a Pro account, or see /pricing.');
    const hook = outFeed.parseDiscord(req.body?.url);
    if (!hook) throw new V1Error(400, 'bad_parameter', 'That is not a Discord webhook URL. It starts https://discord.com/api/webhooks/ (Server Settings > Integrations > Webhooks > Copy Webhook URL).');
    const t = Date.now(), seen = (outFeedState.connects.get(req.apiKey.id) || []).filter(x => t - x < 3600e3);
    if (seen.length >= 5) throw new V1Error(429, 'rate_limited', 'At most 5 connects an hour per key. Try again later.');
    outFeedState.connects.set(req.apiKey.id, [...seen, t]);
    if (outFeedState.connects.size > 5000) outFeedState.connects.clear();
    const others = apiKeys.feeds().filter(x => x.keyId !== req.apiKey.id);
    if (others.some(x => x.feed.hookId === hook.id)) throw new V1Error(409, 'already_connected', 'That webhook is already connected with another key, so the channel already gets the feed.');
    if (!req.apiKey.feed && others.length >= FEED_MAX) throw new V1Error(503, 'unavailable', 'No new feeds can be connected right now.');
    // Discord answers a GET on a live webhook with its name and channel
    let info;
    try { info = (await require('axios').get(hook.url, { timeout: 8000 })).data || {}; } catch (e) {
      const st = e?.response?.status;
      throw new V1Error(400, 'bad_webhook', st === 401 || st === 404 ? 'Discord says that webhook does not exist (deleted, or the URL is cut short). Copy it again.' : 'Could not reach Discord to check the webhook. Try again in a minute.');
    }
    const sent = await outFeedSender.sendTo({ kind: 'discord', id: 'connect', url: hook.url }, outFeed.welcomePost({ origin: digestOrigin() }));
    if (!sent.ok) throw new V1Error(400, 'bad_webhook', `Discord turned the first post away: ${sent.why}`);
    const was = req.apiKey.feed;
    const feed = { hookId: hook.id, sealed: outFeedSeal.seal(hook.url), name: outFeed.clean(info.name || '').slice(0, 40) || null, addedAt: new Date().toISOString(), lastOkAt: new Date().toISOString(), fails: 0, deadAt: null,
      ...(was?.handles ? { handles: was.handles, results: was.results !== false } : {}) };
    const doc = await apiKeys.setFeed(v1KeyOf(req), feed);
    res.set('Cache-Control', 'no-store').json({ discord: feedView(doc), note: 'Connected. A welcome post with the record card is in the channel now.', ...FEED_ABOUT });
  } catch (e) { v1Fail(res, e); }
});
// the bettor records this key's Discord feed also gets. body: { handles: [..] | "a, b", results: true|false }
app.put('/api/v1/feed/records', v1Auth, async (req, res) => {
  try {
    const f = req.apiKey.feed;
    if (!f || f.deadAt) throw new V1Error(409, 'no_feed', 'Connect a Discord webhook first (PUT /api/v1/feed/discord): bettor records ride on it.');
    const raw = Array.isArray(req.body?.handles) ? req.body.handles : String(req.body?.handles ?? '').split(/[\s,]+/);
    const list = [...new Set(raw.map(x => String(x ?? '').trim()).filter(Boolean))];
    if (list.length > publicApi.FEED_HANDLES) throw new V1Error(400, 'bad_parameter', `At most ${publicApi.FEED_HANDLES} bettor records on one feed.`);
    await pubRecords.init();
    const handles = [];
    for (const x of list) {
      const c = pubRecord.cleanHandle(x);
      if (!c.handle) throw new V1Error(400, 'bad_parameter', `"${String(x).slice(0, 24)}": ${c.error}`);
      if (pubRecords.get(c.handle)?.status !== 'live') throw new V1Error(404, 'not_found', `No published record @${c.handle}.`);
      handles.push(c.handle);
    }
    const doc = await apiKeys.setFeedRecords(v1KeyOf(req), { handles, results: req.body?.results !== false });
    // each new handle starts from where its record stands now (no flood of history)
    for (const h of handles) feedBettors({ only: h }).catch(() => {});
    res.set('Cache-Control', 'no-store').json({ discord: feedView(doc), note: handles.length ? `Saved. New picks from @${handles.join(', @')} post from now on.` : 'Saved: no bettor records on this feed.', ...FEED_ABOUT });
  } catch (e) { v1Fail(res, e); }
});
app.delete('/api/v1/feed/discord', v1Auth, async (req, res) => {
  try { const doc = await apiKeys.setFeed(v1KeyOf(req), null); res.set('Cache-Control', 'no-store').json({ discord: feedView(doc), note: 'Disconnected: no more posts go to that webhook.' }); }
  catch (e) { v1Fail(res, e); }
});

return {
  outFeedSeal, outFeedStore, outFeedReady, outFeedState, DISCORD_INVITE, ownerAlerts,
  feedDoc, feedDigest, feedRecordCheck, feedMoves, feedOwnerCheck, outFeedStatus, bettorFeedState,
  feedBettors
};
};
