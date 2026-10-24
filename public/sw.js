'use strict';
// Line Reaper service worker: shows push alerts and opens the app on tap.
// It caches nothing, so the app is always the live version.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

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
