'use strict';
// Where alerts go. ALERT_WEBHOOK_URL is one of these (or several, comma-separated,
// each getting every alert):
//
//   ntfy, free phone push with no account:  https://ntfy.sh/<a-topic-only-you-know>
//     (install the ntfy app, subscribe to the same topic; a self-hosted ntfy.* host works too)
//   Telegram bot:                            https://api.telegram.org/bot<token>/sendMessage?chat_id=<id>
//   Slack incoming webhook:                  https://hooks.slack.com/services/…
//   Discord, or anything Discord-compatible: https://discord.com/api/webhooks/…
//
// Each gets plain lines of text in its own format. A push from ntfy opens the
// first link in the alert (the Kalshi market, say) when tapped.

const LIMITS = { discord: 1900, slack: 3000, ntfy: 3800, telegram: 4000 };

function webhookKind(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  const host = u.hostname.toLowerCase();
  if (host === 'ntfy.sh' || /(^|\.)ntfy\./.test(host)) return 'ntfy';
  if (host === 'api.telegram.org') return 'telegram';
  if (host === 'hooks.slack.com') return 'slack';
  return 'discord';
}

const firstLink = text => /<(https?:\/\/[^\s>]+)>|(https?:\/\/[^\s<>]+)/.exec(text || '')?.slice(1).find(Boolean) || null;
// HTTP headers are ASCII only
const ascii = s => String(s || '').replace(/[^\x20-\x7e]/g, '').trim();

// → { url, data, headers } for one post of `text`
function webhookRequest(url, text, { title = 'Line Reaper' } = {}) {
  const kind = webhookKind(url);
  if (!kind) return null;
  let body = String(text || '');
  // <url> stops Discord's link previews (and is Slack's link syntax); elsewhere it's clutter
  if (kind === 'ntfy' || kind === 'telegram') body = body.replace(/<(https?:\/\/[^\s>]+)>/g, '$1');
  body = body.slice(0, LIMITS[kind]);
  if (kind === 'ntfy') {
    const link = firstLink(body);
    return { url, data: body, headers: { 'Content-Type': 'text/plain; charset=utf-8', Title: ascii(title) || 'Line Reaper', ...(link ? { Click: link } : {}) } };
  }
  if (kind === 'telegram') {
    const u = new URL(url);
    const chatId = u.searchParams.get('chat_id');
    u.search = '';
    return { url: u.toString(), data: { chat_id: chatId, text: body, disable_web_page_preview: true }, headers: {} };
  }
  if (kind === 'slack') return { url, data: { text: body }, headers: {} };
  return { url, data: { username: title, content: body }, headers: {} };
}

const parseUrls = v => String(v || '').split(',').map(s => s.trim()).filter(s => webhookKind(s));

// send(text, what) posts to every configured hook; a failure is logged, never thrown.
function createWebhook({ urls = process.env.ALERT_WEBHOOK_URL, post, title = 'Line Reaper', timeout = 10000, log = console } = {}) {
  const list = Array.isArray(urls) ? urls.filter(s => webhookKind(s)) : parseUrls(urls);
  const doPost = post || ((url, data, opts) => require('axios').post(url, data, opts));
  const stats = { sent: 0, failed: 0, lastError: null, lastAt: null };
  async function send(text, what = 'Alerts') {
    if (!list.length || !String(text || '').trim()) return 0;
    let ok = 0;
    await Promise.all(list.map(async url => {
      const r = webhookRequest(url, text, { title });
      try {
        await doPost(r.url, r.data, { timeout, headers: r.headers });
        ok++; stats.sent++; stats.lastAt = new Date().toISOString();
      } catch (e) {
        stats.failed++;
        stats.lastError = [`${webhookKind(url)}:`, e?.response?.status, e?.message || String(e)].filter(Boolean).join(' ');
        log.warn?.(`${what}: webhook (${webhookKind(url)}) failed: ${e?.message || e}`);
      }
    }));
    return ok;
  }
  return { enabled: list.length > 0, kinds: list.map(webhookKind), send, stats: () => ({ ...stats }) };
}

module.exports = { webhookKind, webhookRequest, createWebhook, firstLink };
