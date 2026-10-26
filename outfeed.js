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
const COLORS = { digest: 0x60a5fa, record: 0x34d399, moves: 0xfbbf24, welcome: 0x94a3b8 };
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
function ownerDestinations(env = process.env) {
  const dests = [], problems = [];
  for (const u of list(env.DISCORD_WEBHOOK_URLS)) {
    const d = parseDiscord(u);
    if (d) dests.push({ kind: 'discord', id: `owner-discord-${d.id}`, url: d.url, owner: true });
    else problems.push('a DISCORD_WEBHOOK_URLS entry is not a Discord webhook URL');
  }
  const token = String(env.TELEGRAM_BOT_TOKEN || '').trim();
  const chats = list(env.TELEGRAM_CHAT_IDS);
  if (token && !TG_TOKEN_RE.test(token)) problems.push('TELEGRAM_BOT_TOKEN does not look like a bot token');
  else if (token && !chats.length) problems.push('TELEGRAM_BOT_TOKEN is set but TELEGRAM_CHAT_IDS is empty');
  else if (!token && chats.length) problems.push('TELEGRAM_CHAT_IDS is set but TELEGRAM_BOT_TOKEN is empty');
  else if (token) {
    for (const c of chats) {
      if (TG_CHAT_RE.test(c)) dests.push({ kind: 'telegram', id: `owner-telegram-${c}`, token, chat: c, owner: true });
      else problems.push(`TELEGRAM_CHAT_IDS entry "${c.slice(0, 24)}" is not a chat id or @channel`);
    }
  }
  return { dests, problems };
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

function welcomePost({ origin = '' } = {}) {
  const o = origin0(origin);
  return { kind: 'welcome', title: 'Line Reaper feed connected',
    text: ['This channel now gets the same public posts as everyone else:', '• the weekly record digest, Mondays 13:00 UTC', '• record changes on RESULTS (newly proven, no longer proven, losing to the close, reached 50 graded), checked hourly', '• today\'s biggest line moves, daily at 21:00 UTC',
      'No picks sized for you and no bets placed. To stop, delete the webhook in Discord or disconnect it on the developers page.'].join('\n'),
    link: o ? `${o}/developers#feed` : null, image: o ? `${o}/card/record.png` : null };
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
function sealer(key) {
  if (!key) return { seal: s => ({ plain: s }), open: x => x?.plain ?? null, on: false };
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
      try {
        const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(x.iv, 'base64'));
        d.setAuthTag(Buffer.from(x.tag, 'base64'));
        return Buffer.concat([d.update(Buffer.from(x.data, 'base64')), d.final()]).toString('utf8');
      } catch { return null; }
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
    const dests = [...owner, ...subscribers()];
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

module.exports = { parseDiscord, ownerDestinations, digestPost, recordChanges, recordPost, movesPost, welcomePost, changeOf,
  discordRequest, telegramRequests, requestsFor, createFeed, sealer, clean, scrub, FOOTER, DISCORD_RE };
