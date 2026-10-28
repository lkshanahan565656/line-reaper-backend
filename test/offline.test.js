// The service worker's offline rules (public/sw.js), run in a sandbox with a
// fake network and a fake Cache Storage: live answers always win, a saved copy
// is served only when the network fails or the server answers 5xx, and it is
// marked x-lr-cached with the time it was read. Per-person data is never saved.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'sw.js'), 'utf8');
const ORIGIN = 'https://lr.test';

function fakeCaches() {
  const stores = new Map();
  const open = async name => {
    if (!stores.has(name)) {
      const m = new Map();
      stores.set(name, {
        _m: m,
        put: async (k, r) => { m.set(typeof k === 'string' ? new URL(k, ORIGIN).href : k.url, r.clone()); },
        match: async k => { const r = m.get(typeof k === 'string' ? new URL(k, ORIGIN).href : k.url); return r ? r.clone() : undefined; },
        keys: async () => [...m.keys()].map(u => new Request(u)),
        delete: async k => m.delete(typeof k === 'string' ? new URL(k, ORIGIN).href : k.url),
      });
    }
    return stores.get(name);
  };
  return { stores, open, keys: async () => [...stores.keys()], delete: async n => stores.delete(n) };
}

function load({ version = '9.9.9' } = {}) {
  const listeners = {};
  const net = { mode: 'ok', status: 200, calls: [] };
  const caches = fakeCaches();
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (t, f) => { listeners[t] = f; },
    skipWaiting: async () => {},
    clients: { claim: async () => {}, matchAll: async () => [], openWindow: async () => {} },
    registration: {},
  };
  const fetch = async req => {
    const url = typeof req === 'string' ? new URL(req, ORIGIN).href : req.url;
    net.calls.push(url);
    if (net.mode === 'down') throw new TypeError('Failed to fetch');
    const body = JSON.stringify({ url, n: net.calls.length });
    const r = new Response(body, { status: net.status, headers: { 'content-type': /\/api\//.test(url) ? 'application/json' : 'text/html' } });
    Object.defineProperty(r, 'type', { value: 'basic' });
    return r;
  };
  const ctx = { self, caches, fetch, Request, Response, Headers, URL, console, atob, Uint8Array, JSON, Promise, Date, Number, String, Object, Set, Map, Math };
  vm.createContext(ctx);
  vm.runInContext(SRC.replace(/__LR_VERSION__/g, version), ctx);
  // dispatch a fetch event; resolves to the response, or null when the worker leaves it alone
  const get = async (url, { navigate = false, headers = {} } = {}) => {
    const request = new Request(new URL(url, ORIGIN).href, { headers });
    Object.defineProperty(request, 'mode', { value: navigate ? 'navigate' : 'cors' });
    let p = null;
    listeners.fetch({ request, respondWith: x => { p = x; } });
    return p ? p : null;
  };
  return { listeners, net, caches, get };
}

test('a live answer goes straight through and is saved with its read time', async () => {
  const w = load();
  const r = await w.get('/api/odds-screen?sport=nfl&t=123');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('x-lr-cached'), null, 'a live answer is never marked saved');
  const saved = await (await w.caches.open('lr-api-9.9.9')).match(`${ORIGIN}/api/odds-screen?sport=nfl`);
  assert.ok(saved, 'saved under the URL without the cache-buster');
  assert.ok(Number(saved.headers.get('x-lr-read-at')) > 0);
});

test('network down: the saved copy, marked cached with its read time', async () => {
  const w = load();
  await w.get('/api/odds-screen?sport=nfl');
  const first = w.net.calls.length;
  w.net.mode = 'down';
  const r = await w.get('/api/odds-screen?t=999&sport=nfl');
  assert.equal(w.net.calls.length, first + 1, 'it still tries the network first');
  assert.equal(r.headers.get('x-lr-cached'), '1');
  assert.ok(Number(r.headers.get('x-lr-read-at')) > 0);
  assert.equal((await r.json()).n, 1, 'the body is the earlier live answer');
});

test('server down for a deploy (502): the saved copy; with nothing saved, the 502 itself', async () => {
  const w = load();
  await w.get('/api/esports/matches');
  w.net.status = 502;
  const r = await w.get('/api/esports/matches');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('x-lr-cached'), '1');
  const none = await w.get('/api/props/board');
  assert.equal(none.status, 502);
  w.net.mode = 'down';
  await assert.rejects(() => w.get('/api/never-read'), /Failed to fetch/);
});

test('a 4xx is passed through and never replaced by a saved copy', async () => {
  const w = load();
  await w.get('/api/results');
  w.net.status = 404;
  const r = await w.get('/api/results');
  assert.equal(r.status, 404);
});

test('per-person data, streams and token URLs are left alone and never saved', async () => {
  const w = load();
  for (const u of ['/api/auth/me', '/api/me/used', '/api/push/kinds', '/api/billing/portal', '/api/ops', '/api/ev/stream', '/api/esports/stream?token=abc', '/api/odds?token=abc', '/api/v1/odds', '/api/slips/record', '/api/sync/bets']) {
    assert.equal(await w.get(u), null, u);
  }
  assert.equal(await w.get('/api/odds', { headers: { accept: 'text/event-stream' } }), null);
  assert.equal(await w.get('https://elsewhere.test/api/odds'), null, 'other sites are not touched');
  const saved = await w.caches.open('lr-api-9.9.9');
  assert.equal((await saved.keys()).length, 0);
});

test('the app shell: live when it loads, the saved copy when it does not', async () => {
  const w = load();
  const live = await w.get('/app', { navigate: true });
  assert.equal(live.status, 200);
  const n = (await live.json()).n;
  w.net.mode = 'down';
  const off = await w.get('/app', { navigate: true });
  assert.equal((await off.json()).n, n);
  w.net.mode = 'ok'; w.net.status = 502;
  const swap = await w.get('/app', { navigate: true });
  assert.equal(swap.status, 200, 'a 502 during a deploy shows the last app, not an error page');
  w.net.status = 200;
  const next = await w.get('/app', { navigate: true });
  assert.ok((await next.json()).n > n, 'the next good load is the new version');
});

test('a new version drops the old version\'s saved copies; the app can clear saved answers', async () => {
  const w = load({ version: '2.0.0' });
  await w.caches.open('lr-api-1.0.0'); await w.caches.open('lr-shell-1.0.0'); await w.caches.open('other');
  let p; w.listeners.activate({ waitUntil: x => { p = x; } }); await p;
  const names = await w.caches.keys();
  assert.ok(!names.includes('lr-api-1.0.0') && !names.includes('lr-shell-1.0.0'));
  assert.ok(names.includes('other'), 'caches that are not ours stay');
  await w.get('/api/results');
  w.listeners.message({ data: { type: 'lr-clear-api' }, waitUntil: x => { p = x; } }); await p;
  assert.ok(!(await w.caches.keys()).includes('lr-api-2.0.0'));
});

test('the server writes its version into the worker and never lets it be cached', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(server, /replace\(\/__LR_VERSION__\/g, require\('\.\/package\.json'\)\.version\)/);
  assert.match(server, /'Cache-Control': 'no-cache, no-store', 'Service-Worker-Allowed': '\/'/);
  assert.match(SRC, /const VERSION = '__LR_VERSION__'/);
});

test('the page: install steps, the offline banner, stamps and the Discord row are in place', () => {
  // the page and its script (public/app.js, served as /assets/app.<hash>.js)
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8') + fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  for (const t of ['id="offBanner"', 'role="status"', 'x-lr-cached', "s.className = 'lr-stamp'", 'may be stale', 'Add to Home Screen', 'Install app', 'id="pwaBar"', 'pwaBarHide(true)', 'onclick="lrOffRetry()"',
    "start === 'install'", 'id="pwaSteps"', 'id="layDiscordRow" hidden', 's.community?.discord']) {
    assert.ok(html.includes(t), t);
  }
  // a saved price is never called live
  assert.match(html, /SAVED DATA/);
  // logging out drops every saved answer
  assert.match(html, /if \(was && !t && typeof lrOffClear === 'function'\) lrOffClear\(\)/);
});

test('hashed app files under /assets/ are saved on first load and served from the device after', async () => {
  const w = load();
  const first = await w.get('/assets/app.0123456789abcdef.js');
  const n = (await first.json()).n;
  w.net.mode = 'down';
  const off = await w.get('/assets/app.0123456789abcdef.js');
  assert.equal((await off.json()).n, n, 'offline: the saved file');
  w.net.mode = 'ok';
  const calls = w.net.calls.length;
  await w.get('/assets/app.0123456789abcdef.js');
  assert.equal(w.net.calls.length, calls, 'a saved hashed file needs no network');
});
