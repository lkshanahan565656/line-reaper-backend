const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createPush, withPush, toNotification, validSubscription } = require('../push');

const memStore = () => { const m = new Map(); return { async init() {}, async all() { return [...m.values()]; }, async put(d) { m.set(d.id, d); } }; };
const sub = n => ({ endpoint: `https://push.example.com/send/${n}`, keys: { p256dh: 'BPk' + n, auth: 'au' + n } });
const fakeWebpush = (fail = {}) => {
  const sent = [];
  return { sent, generateVAPIDKeys: () => ({ publicKey: 'PUB', privateKey: 'PRIV' }),
    async sendNotification(s, payload, opts) { if (fail[s.endpoint]) throw Object.assign(new Error('gone'), { statusCode: fail[s.endpoint] }); sent.push({ s, payload: JSON.parse(payload), opts }); } };
};

test('notification text: same lines as the webhook, links stripped, tap opens the first link', () => {
  const n = toNotification('Sharp Tail: Team A ML\n<https://kalshi.com/m/abc> edge 3%\nline 3\nline 4\nline 5', 'Tail alerts');
  assert.equal(n.title, 'Tail alerts');
  assert.equal(n.url, 'https://kalshi.com/m/abc');
  assert.match(n.body, /^Sharp Tail: Team A ML\nedge 3%\nline 3\n\+2 more$/);
  assert.equal(toNotification('plain').url, '/app');
  assert.equal(toNotification('see http://insecure.example/x').url, '/app');
});

test('subscriptions are validated', () => {
  assert.ok(validSubscription(sub(1)));
  assert.ok(!validSubscription({ endpoint: 'http://x.com/a', keys: sub(1).keys }));
  assert.ok(!validSubscription({ endpoint: 'https://x.com/a' }));
  assert.ok(!validSubscription(null || {}));
});

test('keys are made once and kept; env keys override', async () => {
  const store = memStore();
  const a = createPush({ store, webpush: fakeWebpush(), env: {} });
  assert.equal(await a.publicKey(), 'PUB');
  const b = createPush({ store, webpush: { ...fakeWebpush(), generateVAPIDKeys: () => ({ publicKey: 'OTHER', privateKey: 'x' }) }, env: {} });
  assert.equal(await b.publicKey(), 'PUB', 'a restart reads the stored pair');
  const c = createPush({ store: memStore(), webpush: fakeWebpush(), env: { VAPID_PUBLIC_KEY: 'EP', VAPID_PRIVATE_KEY: 'ES' } });
  assert.equal(await c.publicKey(), 'EP');
});

test('every subscriber gets the identical payload; dead endpoints are dropped; a restart keeps subscribers', async () => {
  const store = memStore();
  const wp = fakeWebpush({ 'https://push.example.com/send/2': 410 });
  const p = createPush({ store, webpush: wp, env: {} });
  await p.subscribe(sub(1)); await p.subscribe(sub(2)); await p.subscribe(sub(1));
  assert.equal(p.devices(), 2, 'resubscribing is idempotent');
  assert.equal(await p.send('Alert line\n<https://a.test/x>', 'Best Plays'), 1);
  assert.equal(wp.sent.length, 1);
  assert.deepEqual(wp.sent[0].payload, { title: 'Best Plays', body: 'Alert line', url: 'https://a.test/x' });
  assert.equal(p.devices(), 1, '410 marks it dead');
  assert.equal(p.stats().dropped, 1);
  const again = createPush({ store, webpush: fakeWebpush(), env: {} });
  await again.ready;
  assert.equal(again.devices(), 1);
  await again.unsubscribe(sub(1).endpoint);
  assert.equal(again.devices(), 0);
  await assert.rejects(again.subscribe({ endpoint: 'nope' }), { status: 400 });
});

test('withPush: webhook and phones both get alerts, but startup notices stay off phones', async () => {
  const hook = { enabled: false, kinds: [], stats: () => ({}), sent: [], async send(t) { this.sent.push(t); return 1; } };
  const wp = fakeWebpush();
  const p = createPush({ store: memStore(), webpush: wp, env: {} });
  await p.subscribe(sub(1));
  const both = withPush(hook, p);
  assert.ok(both.enabled, 'push alone turns alerts on');
  await both.send('hello', 'Sharp alerts');
  await both.send('v is live', 'Startup');
  assert.equal(hook.sent.length, 2);
  assert.equal(wp.sent.length, 1);
});

test('the installable app files are in place', () => {
  const pub = path.join(__dirname, '..', 'public');
  const m = JSON.parse(fs.readFileSync(path.join(pub, 'manifest.webmanifest'), 'utf8'));
  assert.equal(m.display, 'standalone');
  assert.ok(m.start_url && m.icons.some(i => i.sizes === '192x192') && m.icons.some(i => i.sizes === '512x512') && m.icons.some(i => i.purpose === 'maskable'));
  for (const i of m.icons) assert.ok(fs.existsSync(path.join(pub, i.src)), i.src);
  assert.ok(fs.existsSync(path.join(pub, 'icons', 'apple-touch-icon.png')));
  const sw = fs.readFileSync(path.join(pub, 'sw.js'), 'utf8');
  assert.match(sw, /addEventListener\('push'/);
  assert.match(sw, /notificationclick/);
  const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
  for (const t of ['rel="manifest"', 'apple-touch-icon', 'theme-color', "register('/sw.js'", '/api/push/subscribe']) assert.ok(html.includes(t), t);
});

test('server mounts the app files and push routes', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  for (const r of ["get('/manifest.webmanifest'", "get('/sw.js'", "get('/icons/:name'", "get('/api/push/key'", "post('/api/push/subscribe'", "post('/api/push/unsubscribe'"]) assert.ok(server.includes(`app.${r}`), r);
  assert.match(server, /withPush\(webhookOnly, push\)/);
});
