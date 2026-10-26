'use strict';
// Line Reaper service worker: push alerts, and the app when the network fails.
//
// Network first, always: a page that can reach the server gets the live answer
// and nothing here changes it. Only when a request fails (no network, or the
// server answers 5xx, as it does for a few minutes while Railway swaps a
// deploy) does the worker answer from the last copy it saved, marked with the
// headers below so the app can say how old it is. It never answers a request
// that worked with a saved copy.
//
//   x-lr-cached: 1        this came from the device, not the server
//   x-lr-read-at: <ms>    when the server sent it
//
// What it saves: the app's own files (the shell) and the last good answer of
// each market-data GET under /api/. Never: anything per person (accounts,
// billing, push, ops), live streams, requests that carry a token in the URL,
// and anything but a 200 JSON answer.
//
// The server writes its version into this file, so every deploy is a new
// worker: the browser installs it on the next load, it takes over at once and
// drops the old version's saved copies.
const VERSION = '__LR_VERSION__';
const SHELL = `lr-shell-${VERSION}`;
const API = `lr-api-${VERSION}`;
const SHELL_FILES = ['/app', '/calc.js', '/fees.js', '/glossary.js', '/slips.js', '/bets.js', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/apple-touch-icon.png'];
const SHELL_PATHS = new Set(SHELL_FILES);
const API_MAX = 160;              // saved answers kept, oldest dropped first
const API_MAX_BYTES = 6e6;        // a bigger answer is not saved
const PRIVATE = /^\/api\/(auth|me|push|billing|ops|account|sync|user|admin)(\/|$)|\/stream$/;

// the same request with a cache-buster is the same answer
function keyOf(url) {
  const u = new URL(url);
  for (const k of ['t', '_', 'ts', 'nocache']) u.searchParams.delete(k);
  u.searchParams.sort();
  return u.origin + u.pathname + (u.search || '');
}

function cacheableApi(req, url) {
  if (req.method !== 'GET' || url.origin !== self.location.origin || !url.pathname.startsWith('/api/')) return false;
  if (PRIVATE.test(url.pathname) || url.searchParams.has('token')) return false;
  if ((req.headers.get('accept') || '').includes('text/event-stream')) return false;
  return true;
}

// a copy of a response with extra headers (the body is read once, here)
async function stamp(res, extra, maxBytes = Infinity) {
  const h = new Headers(res.headers);
  for (const [k, v] of Object.entries(extra)) h.set(k, v);
  const body = await res.blob();
  if (body.size > maxBytes) return null;
  return new Response(body, { status: res.status, statusText: res.statusText, headers: h });
}

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    // the shell, best effort: a file that fails now is saved on its next good load
    const c = await caches.open(SHELL);
    await Promise.all(SHELL_FILES.map(async p => {
      try { const r = await fetch(p, { cache: 'no-cache' }); if (r.ok) await c.put(p, r); } catch { /* next load */ }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (/^lr-(shell|api)-/.test(k) && k !== SHELL && k !== API) await caches.delete(k);
    await self.clients.claim();
  })());
});

async function shellFirstNetwork(req, key) {
  const c = await caches.open(SHELL);
  try {
    const r = await fetch(req);
    if (r.ok && r.type === 'basic') { await c.put(key, r.clone()); return r; }
    if (r.status < 500) return r;
    const old = await c.match(key);
    return old || r;
  } catch (err) {
    const old = await c.match(key);
    if (old) return old;
    throw err;
  }
}

async function apiNetworkFirst(req) {
  const key = keyOf(req.url);
  const c = await caches.open(API);
  let res = null, err = null;
  try { res = await fetch(req); } catch (e) { err = e; }
  if (res && res.status < 500) {
    const len = Number(res.headers.get('content-length') || 0);
    if (res.status === 200 && /json/.test(res.headers.get('content-type') || '') && len <= API_MAX_BYTES) {
      try {
        const copy = await stamp(res.clone(), { 'x-lr-read-at': String(Date.now()) }, API_MAX_BYTES);
        if (copy) await c.put(key, copy);
        const keys = await c.keys();
        for (let i = 0; i < keys.length - API_MAX; i++) await c.delete(keys[i]);
      } catch { /* full storage: the live answer still goes through */ }
    }
    return res;
  }
  const old = await c.match(key);
  if (old) return stamp(old, { 'x-lr-cached': '1' });
  if (res) return res;
  throw err;
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (req.mode === 'navigate' && (url.pathname === '/app' || url.pathname === '/app/')) return e.respondWith(shellFirstNetwork(req, '/app'));
  if (SHELL_PATHS.has(url.pathname) && !url.search) return e.respondWith(shellFirstNetwork(req, url.pathname));
  if (cacheableApi(req, url)) return e.respondWith(apiNetworkFirst(req));
});

// the app asks: drop every saved answer (log out, or "clear saved data")
self.addEventListener('message', e => {
  if (e.data && e.data.type === 'lr-clear-api') {
    e.waitUntil((async () => { for (const k of await caches.keys()) if (/^lr-api-/.test(k)) await caches.delete(k); })());
  }
});

self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil((async () => {
    await self.registration.showNotification(d.title || 'Line Reaper', {
      body: d.body || '',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      tag: d.nonce ? `test-${d.nonce}` : (d.title || 'line-reaper'),
      renotify: true,
      data: { url: d.url || '/app' },
    });
    // a test from Settings: tell the server it is on screen, so the app can say so
    if (d.nonce) {
      try { await fetch('/api/push/ack', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nonce: d.nonce }) }); } catch { /* the app then says "sent, not confirmed" */ }
    }
  })());
});

// The browser rotated this device's subscription: sign the new one up, keeping its choices.
self.addEventListener('pushsubscriptionchange', e => {
  e.waitUntil((async () => {
    try {
      const k = await (await fetch('/api/push/key')).json();
      if (!k.key) return;
      const p = '='.repeat((4 - k.key.length % 4) % 4), raw = atob((k.key + p).replace(/-/g, '+').replace(/_/g, '/'));
      const sub = e.newSubscription || await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: Uint8Array.from(raw, c => c.charCodeAt(0)) });
      if (e.oldSubscription) await fetch('/api/push/unsubscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint: e.oldSubscription.endpoint }) });
      await fetch('/api/push/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscription: sub.toJSON() }) });
    } catch { /* the app re-syncs on its next open */ }
  })());
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/app';
  e.waitUntil((async () => {
    const same = new URL(url, self.location.origin).origin === self.location.origin;
    if (same) {
      for (const c of await self.clients.matchAll({ type: 'window', includeUncontrolled: true })) {
        if (new URL(c.url).pathname.startsWith('/app') && 'focus' in c) return c.focus();
      }
    }
    return self.clients.openWindow(url);
  })());
});
