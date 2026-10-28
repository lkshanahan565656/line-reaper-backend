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
  assert.ok(!validSubscription({}));
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
  assert.deepEqual(wp.sent[0].payload, { title: 'Best Plays', body: 'Alert line', url: 'https://a.test/x', kind: 'other' });
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
  // home-screen shortcuts open real tabs (?start=<tab>, or alerts: RESULTS on the alert history)
  const src = require('./app-source').both;
  assert.ok(m.shortcuts.length >= 3);
  for (const sc of m.shortcuts) {
    const tab = new URL(sc.url, 'https://x').searchParams.get('start');
    assert.ok(tab === 'alerts' || src.includes(`showTab('${tab}',this)`), sc.url);
    for (const i of sc.icons || []) assert.ok(fs.existsSync(path.join(pub, i.src)), i.src);
  }
  assert.ok(fs.existsSync(path.join(pub, 'icons', 'apple-touch-icon.png')));
  const sw = fs.readFileSync(path.join(pub, 'sw.js'), 'utf8');
  assert.match(sw, /addEventListener\('push'/);
  assert.match(sw, /notificationclick/);
  const html = require('./app-source').both;
  for (const t of ['rel="manifest"', 'apple-touch-icon', 'theme-color', "register('/sw.js'", '/api/push/subscribe']) assert.ok(html.includes(t), t);
});

test('server mounts the app files and push routes', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  for (const r of ["get('/manifest.webmanifest'", "get('/sw.js'", "get('/icons/:name'", "get('/api/push/key'", "post('/api/push/subscribe'", "post('/api/push/unsubscribe'"]) assert.ok(server.includes(`app.${r}`), r);
  assert.match(server, /withPush\(webhookOnly, push[,)]/);
});

const { kindOf, KIND_KEYS, keyIdOf } = require('../push');
const noSleep = () => Promise.resolve();
const scripted = script => { // endpoint → list of statusCodes to throw before succeeding (0 = ok)
  const sent = [];
  return { sent, generateVAPIDKeys: () => ({ publicKey: 'PUB', privateKey: 'PRIV' }), getVapidHeaders: () => ({}),
    async sendNotification(s, payload) {
      const q = script[s.endpoint] || [];
      const code = q.length ? q.shift() : 0;
      if (code) throw Object.assign(new Error(`status ${code}`), { statusCode: code === -1 ? undefined : code });
      sent.push({ s, payload: JSON.parse(payload) });
      return { statusCode: 201 };
    } };
};

test('every alert title the server sends maps to a kind; unknown ones go to other', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const titles = new Set();
  for (const m of server.matchAll(/(?:postAlert|webhook\.send|\bsend)\(.*?,\s*'([^']+)'(?:,\s*\{.*\})?\)\s*;?\s*$/gm)) titles.add(m[1]);
  assert.ok(titles.size >= 10, `found ${[...titles].join(', ')}`);
  for (const t of titles) if (t !== 'Startup') assert.notEqual(kindOf(t), 'other', `${t} has no kind`);
  assert.equal(kindOf('Something new'), 'other');
  assert.ok(KIND_KEYS.includes('other'));
});

test('a device only gets the kinds it chose; the text is identical for every device that gets it', async () => {
  const wp = scripted({});
  const p = createPush({ store: memStore(), webpush: wp, env: {}, sleep: noSleep });
  await p.subscribe(sub(1));
  await p.subscribe(sub(2), { kinds: ['ev'] });
  await p.subscribe(sub(3), { kinds: ['tail', 'bogus'] });
  assert.deepEqual((await p.device(sub(3).endpoint)).kinds, ['tail']);
  assert.equal(await p.send('BetRivers Over 5.5 +110', 'EV alerts'), 2);
  const evs = wp.sent.map(x => x.payload);
  assert.deepEqual(evs[0], evs[1]);
  assert.equal(evs[0].kind, 'ev');
  wp.sent.length = 0;
  assert.equal(await p.send('Wallet bought', 'Tail alerts'), 2);
  assert.deepEqual(wp.sent.map(x => x.s.endpoint).sort(), [sub(1).endpoint, sub(3).endpoint]);
  await p.setKinds(sub(2).endpoint, ['ev', 'tail']);
  wp.sent.length = 0;
  assert.equal(await p.send('x', 'Tail alerts'), 3);
  // re-subscribing (app re-sync) keeps the choices
  await p.subscribe(sub(2));
  assert.deepEqual((await p.device(sub(2).endpoint)).kinds, ['ev', 'tail']);
  await assert.rejects(p.setKinds('https://push.example.com/send/none', ['ev']), { status: 404 });
});

test('retries 429/5xx/network, drops 404/410 and key mismatches, five failures in a row retire a device', async () => {
  const E = n => sub(n).endpoint;
  const wp = scripted({ [E(1)]: [503, 429], [E(2)]: [410], [E(3)]: [403], [E(4)]: [-1, -1, -1], [E(5)]: [400, 400, 400, 400, 400] });
  const p = createPush({ store: memStore(), webpush: wp, env: {}, sleep: noSleep });
  for (const n of [1, 2, 3, 4, 5]) await p.subscribe(sub(n));
  assert.equal(await p.send('a', 'EV alerts'), 1, 'device 1 gets it on the third try');
  const s = p.stats();
  assert.equal(s.dropped, 2);
  assert.ok(s.retried >= 4);
  const line = p.log(1)[0];
  assert.equal(line.sent, 1); assert.equal(line.dropped, 2); assert.equal(line.failed, 2);
  assert.ok(line.errors.every(e => /^push\.example\.com /.test(e)), 'log names the host, never the endpoint');
  assert.ok(!JSON.stringify(p.log()).includes('/send/'), 'no endpoint paths in the log');
  for (let i = 0; i < 4; i++) await p.send('b', 'EV alerts');
  assert.equal((await p.device(E(5))).active, false, 'five 400s in a row');
  assert.equal(p.devices(), 2);
});

test('a key change hides devices subscribed under the old key until they re-subscribe', async () => {
  const store = memStore();
  const a = createPush({ store, webpush: scripted({}), env: {}, sleep: noSleep });
  await a.subscribe(sub(1));
  const b = createPush({ store, webpush: scripted({}), env: { VAPID_PUBLIC_KEY: 'NEWPUB', VAPID_PRIVATE_KEY: 'NEWPRIV' }, sleep: noSleep });
  await b.ready;
  assert.equal(b.devices(), 0);
  assert.equal((await b.device(sub(1).endpoint)).staleKey, true);
  assert.equal((await b.selfTest()).staleKeyDevices, 1);
  await b.subscribe(sub(1));
  assert.equal(b.devices(), 1);
  assert.equal((await b.selfTest()).keyId, keyIdOf('NEWPUB'));
});

test('send me a test: one device only, real outcome, ack when shown, rate limited', async () => {
  let t = 1e12;
  const wp = scripted({});
  const p = createPush({ store: memStore(), webpush: wp, env: {}, sleep: noSleep, now: () => t });
  await p.subscribe(sub(1)); await p.subscribe(sub(2));
  const r = await p.test(sub(1).endpoint);
  assert.equal(wp.sent.length, 1);
  assert.equal(wp.sent[0].s.endpoint, sub(1).endpoint);
  assert.equal(wp.sent[0].payload.nonce, r.nonce);
  assert.equal(p.testStatus(r.nonce).shown, false);
  assert.deepEqual(p.ack(r.nonce), { ok: true });
  assert.equal(p.testStatus(r.nonce).shown, true);
  assert.deepEqual(p.ack('nope'), { ok: false });
  await assert.rejects(p.test(sub(1).endpoint), { status: 429 });
  t += 31e3;
  await p.test(sub(1).endpoint);
  await assert.rejects(p.test('https://push.example.com/send/unknown'), { status: 404 });
  const gone = createPush({ store: memStore(), webpush: scripted({ [sub(1).endpoint]: [410] }), env: {}, sleep: noSleep });
  await gone.subscribe(sub(1));
  await assert.rejects(gone.test(sub(1).endpoint), { status: 502, message: /no longer signed up/ });
  assert.equal(gone.devices(), 0);
});

test('self-test reports setup without secrets', async () => {
  const p = createPush({ store: memStore(), webpush: scripted({}), env: {}, sleep: noSleep });
  let st = await p.selfTest({ persistent: true });
  assert.equal(st.keySource, 'none');
  await p.subscribe(sub(1), { kinds: ['ev'] });
  await p.send('x', 'EV alerts');
  st = await p.selfTest({ persistent: false });
  assert.equal(st.keySource, 'stored');
  assert.equal(st.devices, 1);
  assert.equal(st.byKind.ev, 1); assert.equal(st.byKind.tail, 0);
  assert.deepEqual(st.byHost, { 'push.example.com': 1 });
  assert.equal(st.checks.find(c => c.check === 'kept across deploys').ok, false);
  const txt = JSON.stringify(st);
  assert.ok(!txt.includes('PRIV') && !txt.includes('/send/') && !txt.includes('BPk'), 'no keys or endpoints');
});

test('server: push store rides the results backup; every push route is mounted', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(server, /resultsBackup\.wrap\('push', pushStore, \{ appendOnly: false \}\)/);
  assert.ok(server.indexOf('const resultsBackup =') < server.indexOf('const push ='));
  for (const r of ["get('/api/push/kinds'", "post('/api/push/kinds'", "post('/api/push/device'", "post('/api/push/test'", "post('/api/push/ack'", "get('/api/push/test/:nonce'", "get('/api/push/selftest'", "get('/api/push/log'"]) assert.ok(server.includes(`app.${r}`), r);
  const html = require('./app-source').both;
  for (const t of ['onclick="pushTest()"', 'id="pushKinds"', '/api/push/test', '/api/push/device', 'function pushSync']) assert.ok(html.includes(t), t);
  const sw = fs.readFileSync(path.join(__dirname, '..', 'public', 'sw.js'), 'utf8');
  assert.match(sw, /\/api\/push\/ack/);
  assert.match(sw, /pushsubscriptionchange/);
});

test('a subscription the push service dropped reads as expired, so the app can renew it', async () => {
  const gone = createPush({ store: memStore(), webpush: fakeWebpush({ [sub(7).endpoint]: 410 }), env: {}, sleep: async () => {} });
  await gone.subscribe(sub(7));
  await gone.test(sub(7).endpoint).catch(() => {});
  const d = await gone.device(sub(7).endpoint);
  assert.equal(d.active, false);
  assert.equal(d.expired, true);
  assert.match(d.reason, /^gone/);
});
