'use strict';
// Phone push (Web Push) for the installed app. Every alert that goes to
// ALERT_WEBHOOK_URL also goes to every device that turned alerts on, with the
// same text for everyone: no per-user sizing, nothing chosen per person.
//
// No Railway setting is needed. The VAPID key pair is made on first boot and
// kept in the results store (so deploys keep it); VAPID_PUBLIC_KEY and
// VAPID_PRIVATE_KEY override it, and VAPID_SUBJECT sets the contact address.
// A subscription the push service reports gone (404/410) is marked dead.

const crypto = require('crypto');
const { firstLink } = require('./webhook');

const subId = endpoint => crypto.createHash('sha256').update(String(endpoint)).digest('hex').slice(0, 32);

function validSubscription(s) {
  try {
    const u = new URL(s.endpoint);
    return u.protocol === 'https:' && s.endpoint.length < 1000 && typeof s.keys?.p256dh === 'string' && typeof s.keys?.auth === 'string' && s.keys.p256dh.length < 200 && s.keys.auth.length < 100;
  } catch { return false; }
}

// text is the same plain lines the webhook gets → { title, body, url }
function toNotification(text, what = 'Line Reaper') {
  const lines = String(text || '').split('\n').map(l => l.trim()).filter(Boolean);
  const clean = l => l.replace(/<(https?:\/\/[^\s>]+)>/g, '').replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim();
  const shown = lines.slice(0, 3).map(clean).filter(Boolean);
  let body = shown.join('\n');
  if (lines.length > 3) body += `\n+${lines.length - 3} more`;
  const link = firstLink(text);
  return { title: String(what || 'Line Reaper').slice(0, 60), body: body.slice(0, 300), url: link && /^https:\/\//.test(link) ? link : '/app' };
}

function createPush({ store, webpush = require('web-push'), env = process.env, log = console, subject } = {}) {
  const subs = new Map();   // id → doc
  let vapid = null, failed = false;
  const stats = { sent: 0, failed: 0, dropped: 0, lastError: null };

  const ready = (async () => {
    await store.init();
    for (const d of await store.all()) {
      if (d.id === 'vapid') vapid = d;
      else if (d.status === 'active' || d.status === 'dead') subs.set(d.id, d);
    }
    if (env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY) vapid = { id: 'vapid', status: 'vapid', publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY };
  })().catch(e => { log.warn?.(`Push: could not start: ${e.message}`); failed = true; });
  // made the first time a phone asks for it, so a server nobody subscribes to writes nothing
  async function ensureVapid() {
    await ready;
    if (failed) return null;
    if (!vapid) {
      const k = webpush.generateVAPIDKeys();
      vapid = { id: 'vapid', status: 'vapid', publicKey: k.publicKey, privateKey: k.privateKey };
      await store.put(vapid);
    }
    return vapid;
  }

  const contact = subject || env.VAPID_SUBJECT || (env.LEGAL_EMAIL ? `mailto:${env.LEGAL_EMAIL}` : 'https://line-reaper-backend-production.up.railway.app');
  const options = () => ({ vapidDetails: { subject: contact, publicKey: vapid.publicKey, privateKey: vapid.privateKey }, TTL: 3600, urgency: 'high' });
  const active = () => [...subs.values()].filter(s => s.status === 'active');

  async function publicKey() { return (await ensureVapid())?.publicKey || null; }

  async function subscribe(sub, { ua } = {}) {
    if (!(await ensureVapid())) { const e = new Error('Push is not available right now'); e.status = 503; throw e; }
    if (!validSubscription(sub || {})) { const e = new Error('That is not a valid push subscription'); e.status = 400; throw e; }
    if (active().length >= 5000) { const e = new Error('Push is full'); e.status = 503; throw e; }
    const doc = { id: subId(sub.endpoint), status: 'active', endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth }, at: new Date().toISOString(), ua: String(ua || '').slice(0, 120) };
    subs.set(doc.id, doc);
    await store.put(doc);
    return { ok: true, devices: active().length };
  }

  async function unsubscribe(endpoint) {
    await ready;
    const d = subs.get(subId(endpoint));
    if (!d || d.status === 'dead') return { ok: true };
    const dead = { ...d, status: 'dead', deadAt: new Date().toISOString() };
    delete dead.keys;
    subs.set(dead.id, dead);
    await store.put(dead);
    return { ok: true };
  }

  async function send(text, what) {
    await ready;
    if (!vapid || !String(text || '').trim()) return 0;
    const list = active();
    if (!list.length) return 0;
    const payload = JSON.stringify(toNotification(text, what));
    let ok = 0;
    await Promise.all(list.map(async d => {
      try {
        await webpush.sendNotification({ endpoint: d.endpoint, keys: d.keys }, payload, options());
        ok++; stats.sent++;
      } catch (e) {
        stats.failed++;
        stats.lastError = [e?.statusCode, e?.message].filter(Boolean).join(' ').slice(0, 160);
        if (e?.statusCode === 404 || e?.statusCode === 410) {
          stats.dropped++;
          const dead = { ...d, status: 'dead', deadAt: new Date().toISOString() };
          delete dead.keys;
          subs.set(d.id, dead);
          await store.put(dead).catch(() => {});
        }
      }
    }));
    return ok;
  }

  return { ready, publicKey, subscribe, unsubscribe, send, devices: () => active().length, stats: () => ({ ...stats, devices: active().length }) };
}

// The webhook plus push as one sink with the webhook's send() shape. Startup
// notices stay on the webhook: a deploy shouldn't buzz every phone.
function withPush(webhook, push) {
  return {
    ...webhook,
    enabled: true,
    hookEnabled: webhook.enabled,
    send: async (text, what) => {
      const [a] = await Promise.all([
        webhook.send(text, what),
        what === 'Startup' ? 0 : push.send(text, what).catch(() => 0),
      ]);
      return a;
    },
  };
}

module.exports = { createPush, withPush, toNotification, validSubscription, subId };
