'use strict';
// ─── OUTBOUND FEED: THE PUBLIC RECORD IN DISCORD AND TELEGRAM ────────────────
// The same public posts the site shows everyone, sent to chat channels:
//   • the weekly record digest (Monday 13:00 UTC, with its share card)
//   • record changes: a kind newly proven, no longer proven, newly losing to
//     the close, or reaching 50 graded on the strict RESULTS record
//   • today's biggest line moves, once a day (information, not an edge)
// Every channel gets the same words and the same image. Nothing is sized or
// picked per person, there are no per-channel settings, nothing places a bet
// (CFTC 4.14(a)(9): the same information goes to everyone). No polymarket.com
// links ever, and a post says "proven" only of what RESULTS marks proven.
//
// Where posts go:
//   DISCORD_WEBHOOK_URLS   comma list of Discord webhook URLs (the owner's servers)
//   TELEGRAM_BOT_TOKEN     a bot token from @BotFather
//   TELEGRAM_CHAT_IDS      comma list of chat ids or @channelnames the bot can post in
//   + every Discord webhook a customer connected on /developers (stored with
//     their API key, encrypted)
// With none of these set and no customer connected, nothing is sent.
//
// Images ride as links to /card/<kind>.png: Discord's embed and Telegram's
// sendPhoto fetch the PNG themselves, so nothing is uploaded from here.
//
// Pure builders (posts, requests, record changes) plus createFeed (the I/O,
// with a post function passed in so tests never touch the network).

const crypto = require('crypto');

const DISCORD_RE = /^https:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/api\/(?:v\d{1,2}\/)?webhooks\/(\d{15,22})\/([\w-]{40,120})\/?$/;
const TG_TOKEN_RE = /^\d{5,15}:[\w-]{30,60}$/;
const TG_CHAT_RE = /^(?:-?\d{3,20}|@[A-Za-z][\w]{3,31})$/;
const LIMITS = { discordDesc: 4000, discordTitle: 250, tgCaption: 1024, tgText: 4000 };
const COLORS = { digest: 0x60a5fa, record: 0x34d399, moves: 0xfbbf24, alerts: 0xf87171, welcome: 0x94a3b8 };
const FOOTER = 'Line Reaper is an information service, not a sportsbook. It takes no bets. 21+. Gambling problem? 1-800-GAMBLER.';

// ── destinations ──
// a Discord webhook URL → { id, url } (normalised, no query), or null
function parseDiscord(url) {
  const m = DISCORD_RE.exec(String(url || '').trim());
  if (!m) return null;
  return { id: m[1], url: `https://discord.com/api/webhooks/${m[1]}/${m[2]}` };
}
const list = v => String(v || '').split(',').map(s => s.trim()).filter(Boolean);
// the owner's channels from env → { dests, problems }
// An entry may start with the topics its channel carries, so one owned server
// gets one channel per kind of post (DEPLOY.md, "Owned Discord server"):
//   record=https://discord.com/api/webhooks/…     one topic
//   digest+moves=https://…                        several, joined with +
//   alerts=https://…                              every alert kind
//   ev+sharp=https://…                            some alert kinds (push.js KINDS)
// An entry with no prefix gets the feed posts (digest, record, moves) as before.
const FEED_TOPICS = ['digest', 'record', 'moves'];
const ALERT_TOPICS = ['ev', 'sharp', 'exchange', 'tail', 'esports', 'gas', 'other'];   // push.js KIND_KEYS
const TOPICS = new Set([...FEED_TOPICS, ...ALERT_TOPICS]);
function parseTopics(prefix) {
  const out = new Set(), bad = [];
  for (const t of String(prefix).toLowerCase().split('+').map(x => x.trim()).filter(Boolean)) {
    if (t === 'alerts') ALERT_TOPICS.forEach(k => out.add(k));
    else if (t === 'feed') FEED_TOPICS.forEach(k => out.add(k));
    else if (TOPICS.has(t)) out.add(t);
    else bad.push(t);
  }
  return { topics: [...TOPICS].filter(t => out.has(t)), bad };
}
// what a destination carries: its own topics, or the feed posts when it named none
const topicsOf = d => d.topics || FEED_TOPICS;
const wants = (d, kind) => kind === 'welcome' || topicsOf(d).includes(kind);
function ownerDestinations(env = process.env) {
  const dests = [], problems = [];
  const seen = new Set();
  for (const raw of list(env.DISCORD_WEBHOOK_URLS)) {
    const m = /^([a-z+ ]{2,80})=(https:\/\/.+)$/i.exec(raw);
    const d = parseDiscord(m ? m[2] : raw);
    if (!d) { problems.push('a DISCORD_WEBHOOK_URLS entry is not a Discord webhook URL'); continue; }
    if (seen.has(d.id)) { problems.push('the same Discord webhook is in DISCORD_WEBHOOK_URLS twice: only the first counts'); continue; }
    seen.add(d.id);
    let topics = null;
    if (m) {
      const t = parseTopics(m[1]);
      if (t.bad.length) problems.push(`DISCORD_WEBHOOK_URLS: unknown topic${t.bad.length === 1 ? '' : 's'} ${t.bad.map(x => `"${x.slice(0, 20)}"`).join(', ')} (use ${['alerts', 'feed', ...TOPICS].join(', ')})`);
      if (!t.topics.length) continue;
      topics = t.topics;
    }
    dests.push({ kind: 'discord', id: `owner-discord-${d.id}`, url: d.url, owner: true, ...(topics ? { topics } : {}) });
  }
  const token = String(env.TELEGRAM_BOT_TOKEN || '').trim();
  const chats = list(env.TELEGRAM_CHAT_IDS);
  if (token && !TG_TOKEN_RE.test(token)) problems.push('TELEGRAM_BOT_TOKEN does not look like a bot token');
  // a token with no chats is the command bot alone (telegrambot.js): no feed posts, not a problem
  else if (!token && chats.length) problems.push('TELEGRAM_CHAT_IDS is set but TELEGRAM_BOT_TOKEN is empty');
  else if (token) {
    for (const c of chats) {
      if (TG_CHAT_RE.test(c)) dests.push({ kind: 'telegram', id: `owner-telegram-${c}`, token, chat: c, owner: true });
      else problems.push(`TELEGRAM_CHAT_IDS entry "${c.slice(0, 24)}" is not a chat id or @channel`);
    }
  }
  return { dests, problems };
}

// The owned server's public invite (DISCORD_INVITE_URL): discord.gg/<code> or
// discord.com/invite/<code> → the normalised URL, or null. Pages show a JOIN
// link only when this is set, and /discord redirects to it.
const INVITE_RE = /^https:\/\/(?:www\.)?(?:discord\.gg|discord(?:app)?\.com\/invite)\/([A-Za-z0-9-]{2,32})\/?$/;
function parseInvite(url) {
  const m = INVITE_RE.exec(String(url || '').trim());
  return m ? `https://discord.gg/${m[1]}` : null;
}

// ── text safety ──
const PM_URL = /https?:\/\/(?:www\.)?polymarket\.com[^\s)>\]]*/gi;
function clean(s) {
  return String(s ?? '')
    .replace(PM_URL, '')
    .replace(/@(everyone|here)\b/gi, '@​$1')
    .replace(/[\u0000-\u0008\u000b-\u001f]/g, '')
    .trim();
}
const cut = (s, n) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);
const origin0 = o => { const s = String(o || '').replace(/\/+$/, ''); return /^https?:\/\/[^\s/]+$/.test(s) ? s : ''; };
const bucket = now => Math.floor(now / 600e3).toString(36);
const qs = o => new URLSearchParams(Object.entries(o).filter(([, v]) => v != null && v !== '')).toString();
const pc = x => (x == null || !Number.isFinite(x) ? '—' : `${x > 0 ? '+' : ''}${Number(x).toFixed(1)}%`);
const am = a => (a == null ? '—' : a > 0 ? `+${a}` : String(a));

// ── posts: { kind, title, text, link, image } ──
// the weekly digest (digest.js build output) and its card
function digestPost(d, { origin = '', now = Date.now() } = {}) {
  const o = origin0(origin);
  const s = d.summary || {};
  const changed = (d.rows || []).filter(r => r.change).slice(0, 8).map(r => `• ${r.kindLabel} · ${r.bookName}: ${r.change}`);
  const lines = [
    `${(s.graded ?? 0).toLocaleString('en-US')} game${s.graded === 1 ? '' : 's'} graded against Pinnacle's close across ${s.kinds ?? 0} kind${s.kinds === 1 ? '' : 's'} and venue${s.kinds === 1 ? '' : 's'}.`,
    s.proven?.length ? `Proven at the week's end: ${s.proven.map(p => `${p.kindLabel} · ${p.bookName} (${p.graded} graded, CLV ${pc(p.clv)})`).join('; ')}.` : 'Proven at the week\'s end: nothing yet.',
    ...(changed.length ? ['Changes this week:', ...changed] : ['No kind changed its label this week.']),
    'Proven means 50 graded at one venue with a CLV t of 2 or more against Pinnacle\'s close. A profit is shown only where RESULTS shows one.',
  ];
  return { kind: 'digest', title: `Weekly record: week of ${d.name}`, text: lines.join('\n'),
    link: o ? `${o}/digest/${d.week}` : null, image: o ? `${o}/card/digest.png?${qs({ week: d.week, v: bucket(now) })}` : null };
}

// Record changes between two reads of claims.publicRecord. A label change is
// posted once it holds on two reads in a row (hourly), so a kind sitting on the
// bar does not flap. state: { rows: { key: { label, graded, target, pending } } }
const recKey = r => `${r.kind}|${r.book}`;
const CLAIMABLE = new Set(['proven', 'building', 'too early', 'losing to the close']);
function changeOf(before, after) {
  const b = before?.label || 'not graded yet', a = after.label;
  if (a === 'proven' && b !== 'proven') return 'newly proven';
  if (b === 'proven' && a !== 'proven') return 'no longer proven';
  if (a === 'losing to the close' && b !== 'losing to the close' && b !== 'not graded yet') return 'newly losing to the close';
  const t = after.target || 50;
  if ((before?.graded || 0) < t && after.graded >= t && CLAIMABLE.has(a)) return 'reached 50 graded';
  return null;
}
function recordChanges(state, rec) {
  const prev = state?.rows || null;
  const next = {};
  const changes = [];
  for (const r of rec?.rows || []) {
    const k = recKey(r);
    const p = prev?.[k];
    const cur = { label: r.label, graded: r.graded || 0, target: r.target || 50 };
    if (!prev || !p) { next[k] = { ...cur, pending: null }; continue; }   // first sight: baseline, never a post
    const ch = changeOf(p, cur);
    if (!ch) { next[k] = { ...cur, pending: null }; continue; }
    // the label (or the 50 mark) moved: wait for a second read that agrees
    if (p.pending && p.pending.change === ch && p.pending.label === cur.label) {
      changes.push({ change: ch, kind: r.kind, kindLabel: r.kindLabel || r.kind, book: r.book, bookName: r.bookName || r.book, label: r.label,
        graded: r.graded, clv: r.clv ?? null, clvT: r.clvT ?? null, profitShown: !!r.profitShown, units: r.profitShown ? r.units : null });
      next[k] = { ...cur, pending: null };
    } else next[k] = { ...p, pending: { change: ch, label: cur.label } };
  }
  return { state: { rows: next, at: rec?.at || null }, changes, baseline: !prev };
}
function recordPost(changes, { origin = '', now = Date.now() } = {}) {
  const o = origin0(origin);
  const order = { 'newly proven': 0, 'no longer proven': 1, 'newly losing to the close': 2, 'reached 50 graded': 3 };
  const lines = [...changes].sort((a, b) => order[a.change] - order[b.change]).slice(0, 12).map(c =>
    `• ${c.kindLabel} · ${c.bookName}: ${c.change.toUpperCase()}. ${c.graded} graded, CLV ${pc(c.clv)}${c.clvT != null ? ` (t ${Number(c.clvT).toFixed(1)})` : ''} vs Pinnacle's close${c.label === 'proven' ? (c.profitShown && c.units != null ? `, ${c.units > 0 ? '+' : ''}${c.units}u` : ', profit not shown') : `; now ${c.label}`}.`);
  if (changes.length > 12) lines.push(`…and ${changes.length - 12} more on RESULTS.`);
  lines.push('Proven means 50 graded at one venue with a CLV t of 2 or more against Pinnacle\'s close. Everything else is research.');
  const anyProven = changes.some(c => c.change === 'newly proven');
  return { kind: 'record', title: anyProven ? 'Record change: a kind is newly proven' : 'Record change on RESULTS', text: lines.join('\n'),
    link: o ? `${o}/results` : null, image: o ? `${o}/card/record.png?${qs({ v: bucket(now) })}` : null };
}

// today's biggest game-line price moves (bigmoves rows, ranked), top n
function movesPost(rows, { origin = '', now = Date.now(), n = 5 } = {}) {
  const o = origin0(origin);
  const top = (rows || []).filter(r => r.kind === 'game' && r.type === 'price').slice(0, n);
  if (!top.length) return null;
  const lines = top.map(r => {
    const moved = (r.followers || []).filter(f => f.status === 'moved').length, old = (r.followers || []).filter(f => f.status === 'old').length;
    return `• ${r.leagueLabel || String(r.league || '').toUpperCase()} · ${r.event} · ${r.side}: ${r.venueName} ${am(r.from)} → ${am(r.to)} (${r.move} pts of win chance). ${moved} venue${moved === 1 ? '' : 's'} followed, ${old} still at the old price.`;
  });
  lines.push('A move is information, not an edge: venues still at the old number have graded as no edge against the close. Check the price at the venue before you bet.');
  const t = top[0];
  return { kind: 'moves', title: 'Biggest line moves today', text: lines.join('\n'),
    link: o ? `${o}/app?start=odds` : null,
    image: o && t.gameId ? `${o}/card/move.png?${qs({ game: t.gameId, market: t.market, side: t.side, v: bucket(now) })}` : null };
}

const TOPIC_LINES = {
  digest: '• the weekly record digest, Mondays 13:00 UTC',
  record: '• record changes on RESULTS (newly proven, no longer proven, losing to the close, reached 50 graded), checked hourly',
  moves: '• today\'s biggest line moves, daily at 21:00 UTC',
};
const ALERT_LABELS = { ev: '+EV plays at proven books', sharp: 'Pinnacle steam and sharp leads', exchange: 'exchange value, steam, movers, arbs and middles',
  tail: 'Sharp Tail, second chances and fresh wallets', esports: 'esports edges and pick\'em board moves', gas: 'gas price locks', other: 'anything else the tracker sends' };
// topics: what this channel carries (an owner channel); none = a customer's feed
function welcomePost({ origin = '', topics = null, alertDelayMin = 0 } = {}) {
  const o = origin0(origin);
  const t = topics || FEED_TOPICS;
  const alerts = ALERT_TOPICS.filter(k => t.includes(k));
  const lines = ['This channel now gets the same public posts as everyone else:', ...FEED_TOPICS.filter(k => t.includes(k)).map(k => TOPIC_LINES[k])];
  if (alerts.length) {
    lines.push(`• alerts: ${alerts.length === ALERT_TOPICS.length ? 'every kind the tracker sends' : alerts.map(k => ALERT_LABELS[k]).join('; ')}, ${alertDelayMin > 0 ? `${alertDelayMin} minutes after members get them, so prices have likely moved` : 'as they go out'}`);
  }
  lines.push(topics ? 'No picks sized for you and no bets placed. Every alert is graded against the close at /alerts.' : 'No picks sized for you and no bets placed. To stop, delete the webhook in Discord or disconnect it on the developers page.');
  return { kind: 'welcome', title: topics ? 'Line Reaper channel connected' : 'Line Reaper feed connected', text: lines.join('\n'),
    link: o ? (topics ? `${o}/alerts` : `${o}/developers#feed`) : null, image: o ? `${o}/card/record.png` : null };
}

// ── alerts in the owner's channels ──
// The tracker's alerts (the same text the alert webhook and phone push send)
// posted to the owner channels that carry their kind, `delayMs` after they
// went out, grouped into one post per channel per minute so a burst stays
// inside Discord's 30 posts a minute per webhook. Everyone in the channel
// reads the same post; nothing is sized or picked per person.
// items: [{ at, kind, title, text }]
function alertPost(items, { origin = '', delayMs = 0, now = Date.now() } = {}) {
  const o = origin0(origin);
  if (!items?.length) return null;
  const hhmm = t => new Date(t).toISOString().slice(11, 16);
  const head = delayMs > 0 ? `Sent to members ${Math.round(delayMs / 60e3)} min before this post. Prices have likely moved: check the venue before you bet.` : null;
  const body = items.map(i => `**${clean(i.title || 'Alert')} · ${hhmm(i.at)} UTC**\n${clean(i.text)}`).join('\n\n');
  const kinds = [...new Set(items.map(i => i.kind))];
  return { kind: 'alerts', title: kinds.length === 1 && ALERT_LABELS[kinds[0]] ? `Alerts: ${ALERT_LABELS[kinds[0]]}` : 'Alerts',
    text: [head, body, 'Every alert is graded against the close at /alerts.'].filter(Boolean).join('\n\n'),
    link: o ? `${o}/alerts` : null, image: null, at: now };
}
// split items into posts that fit one embed
function alertPosts(items, opts = {}) {
  const posts = [];
  let cur = [], len = 0;
  for (const it of items) {
    const n = String(it.text || '').length + 60;
    if (cur.length && len + n > LIMITS.discordDesc - 400) { posts.push(alertPost(cur, opts)); cur = []; len = 0; }
    cur.push(it); len += n;
  }
  if (cur.length) posts.push(alertPost(cur, opts));
  return posts;
}
// add({ text, title, kind }) queues an alert; flush() posts what is due.
// The queue lives in memory, so a restart drops alerts still waiting (they
// stay graded at /alerts); max caps it, oldest dropped first.
function createAlertRelay({ owner = [], sendTo, delayMs = 30 * 60e3, origin = '', now = () => Date.now(), max = 400, log = console } = {}) {
  const dests = owner.filter(d => d.kind === 'discord' && ALERT_TOPICS.some(k => topicsOf(d).includes(k)));
  const queue = [];
  const stats = { queued: 0, posted: 0, posts: 0, failed: 0, dropped: 0, skipped: 0, lastAt: null, lastError: null };
  let busy = false;
  function add({ text, title, kind } = {}) {
    if (!dests.length || !String(text || '').trim() || title === 'Startup') return false;
    const k = ALERT_TOPICS.includes(kind) ? kind : 'other';
    if (!dests.some(d => topicsOf(d).includes(k))) { stats.skipped++; return false; }
    queue.push({ at: now(), due: now() + delayMs, kind: k, title: String(title || 'Alerts'), text: String(text) });
    stats.queued++;
    while (queue.length > max) { queue.shift(); stats.dropped++; }
    return true;
  }
  async function flush() {
    if (busy || !queue.length) return { posts: 0 };
    busy = true;
    try {
      const t = now();
      const due = [];
      while (queue.length && queue[0].due <= t) due.push(queue.shift());
      if (!due.length) return { posts: 0 };
      let posts = 0;
      for (const d of dests) {
        const mine = due.filter(i => topicsOf(d).includes(i.kind));
        for (const p of alertPosts(mine, { origin: typeof origin === 'function' ? origin() : origin, delayMs, now: t })) {
          const r = await sendTo(d, p);
          if (r.ok) { posts++; stats.posts++; } else { stats.failed++; stats.lastError = r.why || 'failed'; log.warn?.(`Owner alerts: ${stats.lastError}`); }
        }
      }
      stats.posted += due.length;
      stats.lastAt = new Date(t).toISOString();
      return { posts };
    } finally { busy = false; }
  }
  return { add, flush, on: dests.length > 0, channels: dests.length,
    stats: () => ({ ...stats, pending: queue.length, delayMin: Math.round(delayMs / 60e3), channels: dests.length }) };
}

// ── requests: a post → [{ url, data }] for one destination ──
function discordRequest(dest, post) {
  const embed = { title: cut(clean(post.title), LIMITS.discordTitle), description: cut(clean(post.text), LIMITS.discordDesc), color: COLORS[post.kind] ?? COLORS.welcome, footer: { text: FOOTER } };
  if (post.link) embed.url = post.link;
  if (post.image) embed.image = { url: post.image };
  return [{ url: `${dest.url}?wait=true`, data: { username: 'Line Reaper', embeds: [embed], allowed_mentions: { parse: [] } } }];
}
function telegramRequests(dest, post) {
  const base = `https://api.telegram.org/bot${dest.token}`;
  const body = [clean(post.title).toUpperCase(), '', clean(post.text), post.link ? `\n${post.link}` : '', `\n${FOOTER}`].join('\n').trim();
  if (post.image) {
    if (body.length <= LIMITS.tgCaption) return [{ url: `${base}/sendPhoto`, data: { chat_id: dest.chat, photo: post.image, caption: body } }];
    return [{ url: `${base}/sendPhoto`, data: { chat_id: dest.chat, photo: post.image, caption: cut(clean(post.title), 200), disable_notification: true } },
      { url: `${base}/sendMessage`, data: { chat_id: dest.chat, text: cut(body, LIMITS.tgText), disable_web_page_preview: true } }];
  }
  return [{ url: `${base}/sendMessage`, data: { chat_id: dest.chat, text: cut(body, LIMITS.tgText), disable_web_page_preview: true } }];
}
const requestsFor = (dest, post) => (dest.kind === 'telegram' ? telegramRequests(dest, post) : discordRequest(dest, post));
// a log line never carries a token or webhook URL
const scrub = s => String(s || '').replace(/bot\d+:[\w-]+/g, 'bot…').replace(/webhooks\/\d+\/[\w-]+/g, 'webhooks/…').slice(0, 200);

// ── sealing a customer's webhook URL at rest ──
// older: keys earlier versions sealed with (FEED_SECRET set later, or a new
// results backup key). They only open; new seals use `key`, so changing the
// key never disconnects anyone already connected.
function sealer(key, older = []) {
  if (!key) return { seal: s => ({ plain: s }), open: x => x?.plain ?? null, on: false };
  const openWith = [key, ...(older || []).filter(k => k && !k.equals(key))];
  return {
    on: true,
    seal(s) {
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', key, iv);
      const data = Buffer.concat([c.update(String(s), 'utf8'), c.final()]);
      return { iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') };
    },
    open(x) {
      if (!x) return null;
      if (x.plain) return x.plain;
      for (const k of openWith) {
        try {
          const d = crypto.createDecipheriv('aes-256-gcm', k, Buffer.from(x.iv, 'base64'));
          d.setAuthTag(Buffer.from(x.tag, 'base64'));
          return Buffer.concat([d.update(Buffer.from(x.data, 'base64')), d.final()]).toString('utf8');
        } catch { /* the next key */ }
      }
      return null;
    },
  };
}

// ── the sender ──
// owner: [dest] from env; subscribers(): [{ kind:'discord', id, url, keyId }];
// onResult(dest, { ok, dead, why }) lets the key store keep a customer's status.
function createFeed({ owner = [], subscribers = () => [], post, onResult = () => {}, log = console, now = () => Date.now(), wait = ms => new Promise(r => setTimeout(r, ms)), concurrency = 4, timeout = 10000 } = {}) {
  const doPost = post || ((url, data, opts) => require('axios').post(url, data, opts));
  const stats = { posts: 0, sent: 0, failed: 0, lastAt: null, lastError: null };
  const recent = [];
  async function one(dest, p) {
    for (const r of requestsFor(dest, p)) {
      let tries = 0;
      for (;;) {
        tries++;
        try { await doPost(r.url, r.data, { timeout, headers: { 'Content-Type': 'application/json' } }); break; } catch (e) {
          const st = e?.response?.status;
          const after = Number(e?.response?.data?.retry_after ?? e?.response?.data?.parameters?.retry_after ?? e?.response?.headers?.['retry-after']);
          if (st === 429 && tries < 3) { await wait(Math.min(15e3, Math.max(0.5, Number.isFinite(after) ? after : 2) * 1000)); continue; }
          if ((st == null || st >= 500) && tries < 2) { await wait(2000); continue; }
          // 401/403/404: the webhook was deleted or the bot removed from the chat
          const dead = st === 401 || st === 403 || st === 404;
          throw Object.assign(new Error(scrub(`${dest.kind} ${st || 'network'}: ${e?.response?.data?.message || e?.response?.data?.description || e?.message || e}`)), { dead });
        }
      }
    }
  }
  async function send(p) {
    // an owner channel gets only the topics it carries; a customer's feed gets the feed posts
    const dests = [...owner.filter(d => wants(d, p?.kind)), ...(await subscribers())];
    if (!p || !dests.length) return { sent: 0, failed: 0, to: 0 };
    stats.posts++;
    let sent = 0, failed = 0;
    const queue = [...dests];
    await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      for (let d = queue.shift(); d; d = queue.shift()) {
        try { await one(d, p); sent++; stats.sent++; onResult(d, { ok: true }); } catch (e) {
          failed++; stats.failed++; stats.lastError = e.message;
          onResult(d, { ok: false, dead: !!e.dead, why: e.message });
          log.warn?.(`Feed (${p.kind}): ${e.message}`);
        }
      }
    }));
    stats.lastAt = new Date(now()).toISOString();
    recent.unshift({ at: stats.lastAt, kind: p.kind, title: cut(clean(p.title), 80), to: dests.length, owner: owner.length, sent, failed });
    recent.length = Math.min(recent.length, 50);
    return { sent, failed, to: dests.length };
  }
  // one destination only (the welcome post when a customer connects)
  async function sendTo(dest, p) {
    try { await one(dest, p); return { ok: true }; } catch (e) { return { ok: false, dead: !!e.dead, why: e.message }; }
  }
  return { send, sendTo, stats: () => ({ ...stats, recent: recent.slice(0, 20) }), ownerCount: owner.length };
}

module.exports = { parseDiscord, parseInvite, ownerDestinations, parseTopics, topicsOf, FEED_TOPICS, ALERT_TOPICS, alertPost, alertPosts, createAlertRelay, digestPost, recordChanges, recordPost, movesPost, welcomePost, changeOf,
  discordRequest, telegramRequests, requestsFor, createFeed, sealer, clean, scrub, FOOTER, DISCORD_RE };
