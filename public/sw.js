'use strict';
// Line Reaper service worker: shows push alerts and opens the app on tap.
// It caches nothing, so the app is always the live version.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Line Reaper', {
    body: d.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag: d.title || 'line-reaper',
    renotify: true,
    data: { url: d.url || '/app' },
  }));
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
