'use strict';
// Phone push (Web Push) for the installed app. Every alert that goes to
// ALERT_WEBHOOK_URL also goes to every device that turned alerts on, with the
// same text for everyone: no per-user sizing, nothing chosen per person. A
// device picks which KINDS of alert it wants (Settings), never what they say.
//
// Keys: VAPID_PUBLIC_KEY + VAPID_PRIVATE_KEY (Railway variables) win. Without
// them a pair is made the first time a phone asks and kept in the push store,
// which the encrypted results backup carries across deploys (server.js wraps
// it), so a deploy keeps both the key and the phones. VAPID_SUBJECT sets the
// contact address.
//
// Delivery: up to 3 tries per device on 429 / 5xx / network errors (backoff,
// Retry-After honoured up to 30 s). 404/410 mark the device dead at once; a
// 403 key mismatch (the phone subscribed under another key) does too, and the
// app re-subscribes it on its next open. 5 failed alerts in a row also mark
// it dead. Each alert leaves one line in a 200-line delivery log: kind, title,
// counts and the push service's host and status. No endpoints, no keys.

const crypto = require('crypto');
const { firstLink } = require('./webhook');

const subId = endpoint => crypto.createHash('sha256').update(String(endpoint)).digest('hex').slice(0, 32);
const keyIdOf = publicKey => crypto.createHash('sha256').update(String(publicKey || '')).digest('hex').slice(0, 12);

// Alert kinds a device can turn on or off. `what` is the title each alert is
// sent under (server.js); anything not listed goes to 'other'.
const KINDS = [
  { key: 'ev', label: '+EV plays at proven books', titles: ['EV alerts'] },
  { key: 'sharp', label: 'Pinnacle steam and sharp leads', titles: ['Sharp alerts'] },
  { key: 'exchange', label: 'Exchange value, steam, movers, arbs, middles', titles: ['Exchange value', 'Steam', 'Line mover', 'Exchange arbs', 'Exchange middles'] },
  { key: 'tail', label: 'Sharp Tail, second chances, fresh wallets', titles: ['Tail alerts', 'Board alerts', 'Fresh wallet alerts'] },
  { key: 'esports', label: "Esports edges and pick'em board moves", titles: ['Esports edges', 'Alerts'] },
  { key: 'gas', label: 'Gas price locks', titles: ['Gas locks'] },
  { key: 'other', label: 'Anything else the tracker sends', titles: [] },
];
const KIND_KEYS = KINDS.map(k => k.key);
const TITLE_KIND = new Map(KINDS.flatMap(k => k.titles.map(t => [t, k.key])));
const kindOf = what => TITLE_KIND.get(String(what || '')) || 'other';
const cleanKinds = list => (Array.isArray(list) ? KIND_KEYS.filter(k => list.includes(k)) : KIND_KEYS.slice());

function validSubscription(s) {
  try {
    const u = new URL(s.endpoint);
    return u.protocol === 'https:' && s.endpoint.length < 1000 && typeof s.keys?.p256dh === 'string' && typeof s.keys?.auth === 'string' && s.keys.p256dh.length < 200 && s.keys.auth.length < 100;
  } catch { return false; }
}
const hostOf = endpoint => { try { return new URL(endpoint).hostname; } catch { return '?'; } };

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

// A key mismatch: the subscription was made under another VAPID key.
const keyMismatch = e => e?.statusCode === 403 || (e?.statusCode === 400 && /vapid|credential|key/i.test(String(e?.body || e?.message || '')));
const retryable = e => e?.statusCode == null || e.statusCode === 429 || e.statusCode >= 500;

function createPush({ store, webpush = require('web-push'), env = process.env, log = console, subject, sleep = ms => new Promise(r => setTimeout(r, ms)),
  now = () => Date.now(), tries = 3, backoffMs = 1000, concurrency = 50, logSize = 200, testGapMs = 30e3 } = {}) {
  const subs = new Map();   // id → doc
  let vapid = null, vapidSource = 'none', failed = false;
  const stats = { sent: 0, failed: 0, dropped: 0, retried: 0, alerts: 0, lastError: null, lastAt: null };
  const deliveries = [];    // newest first
  const tests = new Map();  // nonce → { id, at, status, ackAt }
  const lastTest = new Map(); // device id → ms

  const ready = (async () => {
    await store.init();
    let stored = null;
    for (const d of await store.all()) {
      if (d.id === 'vapid') stored = d;
      else if (d.status === 'active' || d.status === 'dead') subs.set(d.id, d);
    }
    if (env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY) {
      vapid = { id: 'vapid', status: 'vapid', publicKey: env.VAPID_PUBLIC_KEY.trim(), privateKey: env.VAPID_PRIVATE_KEY.trim() };
      vapidSource = 'env';
    } else if (stored) { vapid = stored; vapidSource = 'stored'; }
  })().catch(e => { log.warn?.(`Push: could not start: ${e.message}`); failed = true; });

  // made the first time a phone asks for it, so a server nobody subscribes to writes nothing
  async function ensureVapid() {
    await ready;
    if (failed) return null;
    if (!vapid) {
      const k = webpush.generateVAPIDKeys();
      vapid = { id: 'vapid', status: 'vapid', publicKey: k.publicKey, privateKey: k.privateKey, at: new Date(now()).toISOString() };
      vapidSource = 'stored';
      await store.put(vapid);
    }
    return vapid;
  }

  const contact = subject || env.VAPID_SUBJECT || (env.LEGAL_EMAIL ? `mailto:${env.LEGAL_EMAIL}` : 'https://line-reaper-backend-production.up.railway.app');
  const options = () => ({ vapidDetails: { subject: contact, publicKey: vapid.publicKey, privateKey: vapid.privateKey }, TTL: 3600, urgency: 'high', timeout: 15000 });
  const keyId = () => (vapid ? keyIdOf(vapid.publicKey) : null);
  // a device subscribed under an older key can't be reached with this one
  const onKey = d => !d.vk || d.vk === keyId();
  const active = () => [...subs.values()].filter(s => s.status === 'active' && onKey(s));

  async function save(doc) { subs.set(doc.id, doc); await store.put(doc).catch(e => log.warn?.(`Push: save failed: ${e.message}`)); }
  async function markDead(d, reason) {
    const dead = { ...d, status: 'dead', deadAt: new Date(now()).toISOString(), reason };
    delete dead.keys;
    await save(dead);
  }

  async function publicKey() { return (await ensureVapid())?.publicKey || null; }

  async function subscribe(sub, { ua, kinds, uid } = {}) {
    if (!(await ensureVapid())) { const e = new Error('Push is not available right now'); e.status = 503; throw e; }
    if (!validSubscription(sub || {})) { const e = new Error('That is not a valid push subscription'); e.status = 400; throw e; }
    const id = subId(sub.endpoint), prev = subs.get(id);
    if (!(prev && prev.status === 'active') && active().length >= 5000) { const e = new Error('Push is full'); e.status = 503; throw e; }
    const doc = {
      id, status: 'active', endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
      at: prev?.status === 'active' ? prev.at : new Date(now()).toISOString(), seenAt: new Date(now()).toISOString(),
      ua: String(ua || '').slice(0, 120), vk: keyId(),
      // a re-subscribe keeps the device's choices unless it sends new ones
      kinds: kinds !== undefined ? cleanKinds(kinds) : prev?.kinds ? cleanKinds(prev.kinds) : KIND_KEYS.slice(), fails: 0,
      // the signed-in account the device belongs to, so the account's devices share alert choices
      uid: uid || prev?.uid || null,
    };
    await save(doc);
    return { ok: true, devices: active().length, kinds: doc.kinds };
  }

  // the device's own state, found by its endpoint (only the device knows it)
  async function device(endpoint) {
    await ready;
    const d = subs.get(subId(endpoint));
    if (!d || d.status !== 'active') return { active: false, kinds: [] };
    return { active: onKey(d), staleKey: !onKey(d), kinds: cleanKinds(d.kinds), at: d.at, lastOkAt: d.lastOkAt || null, lastFailAt: d.lastFailAt || null };
  }

  async function setKinds(endpoint, kinds) {
    await ready;
    const d = subs.get(subId(endpoint));
    if (!d || d.status !== 'active') { const e = new Error('This device is not signed up for alerts'); e.status = 404; throw e; }
    await save({ ...d, kinds: cleanKinds(kinds) });
    return { ok: true, kinds: cleanKinds(kinds) };
  }

  // ── devices that follow an account (signed in when they turned alerts on,
  // or opened the app signed in since). Alerts stay the same for everyone;
  // the account only shares which KINDS its devices get.
  const deviceLabel = ua => {
    const u = String(ua || '');
    const os = /iphone|ipad|ipod/i.test(u) ? 'iPhone' : /android/i.test(u) ? 'Android' : /mac os x|macintosh/i.test(u) ? 'Mac' : /windows/i.test(u) ? 'Windows' : /linux/i.test(u) ? 'Linux' : 'Device';
    const br = /edg\//i.test(u) ? 'Edge' : /crios|chrome\//i.test(u) ? 'Chrome' : /fxios|firefox\//i.test(u) ? 'Firefox' : /safari\//i.test(u) ? 'Safari' : '';
    return br ? `${os} · ${br}` : os;
  };
  async function link(endpoint, uid) {
    await ready;
    const d = subs.get(subId(endpoint));
    if (!uid || !d || d.status !== 'active' || d.uid === uid) return { linked: !!(d && d.uid && d.uid === uid) };
    await save({ ...d, uid });
    return { linked: true };
  }
  // no endpoints or keys: a label, when it signed up, its choices, whether it is this one
  async function accountDevices(uid, endpoint) {
    await ready;
    if (!uid) return [];
    const mine = endpoint ? subId(endpoint) : null;
    return [...subs.values()].filter(d => d.uid === uid && d.status === 'active' && onKey(d))
      .map(d => ({ label: deviceLabel(d.ua), at: d.at, lastOkAt: d.lastOkAt || null, kinds: cleanKinds(d.kinds), thisDevice: d.id === mine }));
  }
  async function setKindsForUser(uid, kinds) {
    await ready;
    if (!uid) return 0;
    let n = 0;
    for (const d of [...subs.values()]) if (d.uid === uid && d.status === 'active') { await save({ ...d, kinds: cleanKinds(kinds) }); n++; }
    return n;
  }
  async function unlinkUser(uid) {
    await ready;
    if (!uid) return 0;
    let n = 0;
    for (const d of [...subs.values()]) if (d.uid === uid) { const x = { ...d }; delete x.uid; await save(x); n++; }
    return n;
  }

  async function unsubscribe(endpoint) {
    await ready;
    const d = subs.get(subId(endpoint));
    if (!d || d.status === 'dead') return { ok: true };
    await markDead(d, 'turned off');
    return { ok: true };
  }

  // one device, with retries → { ok, status, tries, error? }
  async function deliver(d, payload) {
    let last = null;
    for (let i = 0; i < tries; i++) {
      try {
        const r = await webpush.sendNotification({ endpoint: d.endpoint, keys: d.keys }, payload, options());
        return { ok: true, status: r?.statusCode ?? 201, tries: i + 1 };
      } catch (e) {
        last = e;
        if (!retryable(e) || i === tries - 1) break;
        stats.retried++;
        const ra = parseFloat(e?.headers?.['retry-after']);
        await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 30e3) : backoffMs * 3 ** i);
      }
    }
    return { ok: false, status: last?.statusCode ?? null, tries, error: String(last?.message || 'failed').replace(/https?:\/\/\S+/g, '').slice(0, 120), mismatch: keyMismatch(last) };
  }

  async function settle(d, r) {
    const at = new Date(now()).toISOString();
    if (r.ok) { stats.sent++; if (d.fails || !d.lastOkAt || now() - Date.parse(d.lastOkAt) > 3600e3) await save({ ...d, fails: 0, lastOkAt: at }); else subs.set(d.id, { ...d, lastOkAt: at }); return 'ok'; }
    stats.failed++;
    stats.lastError = [r.status, r.error].filter(v => v != null).join(' ').slice(0, 160);
    if (r.status === 404 || r.status === 410) { stats.dropped++; await markDead(d, `gone (${r.status})`); return 'dropped'; }
    if (r.mismatch) { stats.dropped++; await markDead(d, 'subscribed under another key'); return 'dropped'; }
    const fails = (d.fails || 0) + 1;
    if (fails >= 5) { stats.dropped++; await markDead(d, `${fails} failures in a row`); return 'dropped'; }
    await save({ ...d, fails, lastFailAt: at });
    return 'failed';
  }

  async function pool(list, fn) {
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, async () => { while (i < list.length) { const d = list[i++]; await fn(d); } }));
  }

  function record(entry) {
    deliveries.unshift(entry);
    if (deliveries.length > logSize) deliveries.length = logSize;
  }

  async function send(text, what) {
    await ready;
    if (!vapid || !String(text || '').trim()) return 0;
    const kind = kindOf(what);
    const all = active();
    const list = all.filter(d => cleanKinds(d.kinds).includes(kind));
    if (!all.length) return 0;
    const t0 = now();
    const payload = JSON.stringify({ ...toNotification(text, what), kind });
    const out = { ok: 0, failed: 0, dropped: 0, retried: 0 }, errors = new Map();
    await pool(list, async d => {
      const r = await deliver(d, payload);
      if (r.tries > 1) out.retried += r.tries - 1;
      const s = await settle(d, r);
      if (s === 'ok') out.ok++; else out[s]++;
      if (!r.ok) { const k = `${hostOf(d.endpoint)} ${r.status ?? 'network'}`; errors.set(k, (errors.get(k) || 0) + 1); }
    });
    stats.alerts++; stats.lastAt = new Date(t0).toISOString();
    record({ at: stats.lastAt, kind, title: String(what || '').slice(0, 60), devices: all.length, wanted: list.length, sent: out.ok, failed: out.failed, dropped: out.dropped, retried: out.retried, ms: now() - t0, errors: [...errors].map(([k, n]) => `${k} x${n}`).slice(0, 5) });
    return out.ok;
  }

  // "Send me a test": to the one device that asks, with a nonce the service
  // worker sends back once the notification is on screen (ack).
  async function test(endpoint) {
    await ready;
    const d = subs.get(subId(endpoint));
    if (!vapid || !d || d.status !== 'active' || !onKey(d)) { const e = new Error('This device is not signed up for alerts. Turn push alerts on first.'); e.status = 404; throw e; }
    const last = lastTest.get(d.id) || 0;
    if (now() - last < testGapMs) { const e = new Error('One test every 30 seconds'); e.status = 429; throw e; }
    lastTest.set(d.id, now());
    const nonce = crypto.randomBytes(9).toString('base64url');
    const at = new Date(now());
    const hhmm = at.toISOString().slice(11, 16);
    const payload = JSON.stringify({ title: 'Line Reaper test', body: `Test alert sent ${hhmm} UTC. If you can read this, push alerts reach this device.`, url: '/app', kind: 'test', nonce });
    const r = await deliver(d, payload);
    const s = await settle(d, r);
    tests.set(nonce, { id: d.id, at: at.toISOString(), accepted: r.ok, status: r.status, ackAt: null });
    for (const [n, t] of tests) if (now() - Date.parse(t.at) > 3600e3) tests.delete(n);
    record({ at: at.toISOString(), kind: 'test', title: 'Test (one device)', devices: 1, wanted: 1, sent: r.ok ? 1 : 0, failed: s === 'failed' ? 1 : 0, dropped: s === 'dropped' ? 1 : 0, retried: r.tries - 1, ms: now() - at.getTime(), errors: r.ok ? [] : [`${hostOf(d.endpoint)} ${r.status ?? 'network'}`] });
    if (!r.ok) {
      const e = new Error(s === 'dropped' ? 'The push service says this device is no longer signed up. Turn push alerts off and on again.' : `The push service refused the test (${r.status ?? 'no answer'}). Try again in a minute.`);
      e.status = 502; throw e;
    }
    return { ok: true, nonce, accepted: true, status: r.status };
  }
  function ack(nonce) {
    const t = tests.get(String(nonce || ''));
    if (!t) return { ok: false };
    if (!t.ackAt) t.ackAt = new Date(now()).toISOString();
    return { ok: true };
  }
  const testStatus = nonce => { const t = tests.get(String(nonce || '')); return t ? { accepted: t.accepted, status: t.status, shown: !!t.ackAt, ackAt: t.ackAt, at: t.at } : null; };

  // What is set up and what isn't, with no secrets.
  async function selfTest({ persistent = null } = {}) {
    await ready;
    let signs = null;
    if (vapid && webpush.getVapidHeaders) {
      try { webpush.getVapidHeaders('https://fcm.googleapis.com', contact, vapid.publicKey, vapid.privateKey, 'aes128gcm'); signs = true; }
      catch (e) { signs = false; }
    }
    const act = active();
    const byKind = Object.fromEntries(KIND_KEYS.map(k => [k, act.filter(d => cleanKinds(d.kinds).includes(k)).length]));
    const byHost = {};
    for (const d of act) { const h = hostOf(d.endpoint); byHost[h] = (byHost[h] || 0) + 1; }
    const checks = [
      { check: 'store', ok: !failed, note: failed ? 'the push store did not load' : 'loaded' },
      { check: 'keys', ok: signs !== false, note: !vapid ? 'made when the first phone turns alerts on' : signs === false ? 'the key pair does not sign' : vapidSource === 'env' ? 'from VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY' : 'made by the server and kept in the backed-up push store' },
      { check: 'kept across deploys', ok: vapidSource === 'env' || persistent !== false, note: persistent === false ? 'no Postgres and no results backup: a deploy drops every phone' : 'yes' },
      { check: 'devices', ok: act.length > 0, note: `${act.length} signed up` },
    ];
    return {
      ok: checks.every(c => c.ok || c.check === 'devices'), checks, keySource: vapidSource, keyId: keyId(), subject: /^mailto:/.test(contact) ? 'mailto (set)' : contact,
      devices: act.length, staleKeyDevices: [...subs.values()].filter(s => s.status === 'active' && !onKey(s)).length,
      dead: [...subs.values()].filter(s => s.status === 'dead').length, byKind, byHost, stats: { ...stats }, lastDelivery: deliveries[0] || null,
    };
  }

  return {
    ready, publicKey, subscribe, unsubscribe, setKinds, device, link, accountDevices, setKindsForUser, unlinkUser, send, test, ack, testStatus, selfTest,
    log: (n = 50) => deliveries.slice(0, Math.max(1, Math.min(logSize, n))),
    devices: () => active().length, stats: () => ({ ...stats, devices: active().length, keySource: vapidSource }),
  };
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

module.exports = { createPush, withPush, toNotification, validSubscription, subId, keyIdOf, KINDS, KIND_KEYS, kindOf };
