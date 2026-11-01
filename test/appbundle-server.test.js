// The app on the real server: the page names its script by hash, the script is
// kept a year and goes out brotli or gzip, a stale hash still gets today's
// script, API answers are compressed and event streams are not.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const zlib = require('zlib');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lr-bundle-'));
for (const k of ['DATABASE_URL', 'ODDS_API_KEY', 'OWLS_API_KEY', 'ALERT_WEBHOOK_URL', 'PUBLIC_URL']) delete process.env[k];
Object.assign(process.env, { LR_DATA_DIR: DIR, TRACKER_FILE: path.join(DIR, 'picks.json'), USERS_FILE: path.join(DIR, 'users.json'), EV_TRACK_FILE: path.join(DIR, 'ev.json'),
  SPORT_PROPS_FILE: path.join(DIR, 'sport-props.json'), DIGEST_FILE: path.join(DIR, 'digest.json'), ESPORTS_CALIBRATION: 'off' });
const axios = require('axios');
axios.get = async () => { throw Object.assign(new Error('offline'), { response: { status: 503 } }); };
axios.post = axios.get;
const srv = require('../server');
const appbundle = require('../appbundle');
const cron = require('node-cron');
let server, port;
test.before(async () => { server = srv.app.listen(0); await new Promise(r => server.once('listening', r)); port = server.address().port; });
test.after(() => { server?.close(); for (const t of cron.getTasks().values()) t.stop(); fs.rmSync(DIR, { recursive: true, force: true }); setTimeout(() => process.exit(0), 50).unref(); });

// raw bytes and headers, nothing decoded for us
const get = (p, headers = {}) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path: p, headers }, res => {
    const chunks = [];
    res.on('data', c => chunks.push(c));
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
  }).on('error', reject);
});
const decode = r => (r.headers['content-encoding'] === 'br' ? zlib.brotliDecompressSync(r.body) : r.headers['content-encoding'] === 'gzip' ? zlib.gunzipSync(r.body) : r.body).toString('utf8');
const scriptOf = html => (html.match(/<script src="(\/assets\/app\.[0-9a-f]{12}\.js)"><\/script>/) || [])[1];

test('/app names its script by hash, in place of the old inline script', async () => {
  const r = await get('/app');
  assert.equal(r.status, 200);
  const html = decode(r);
  assert.ok(scriptOf(html), 'script tag with the hash');
  assert.ok(!html.includes('<script src="/app.js">'), 'the placeholder is replaced');
  assert.ok(!/BACKEND_URL = /.test(html), 'no app code left in the page');
  assert.match(html, /window\.LRVenue|root\.LRVenue/, 'venuelinks.js still inlined before it');
  assert.equal(r.headers['cache-control'], 'no-cache');
});

test('the script: a year for the current hash, brotli or gzip as asked, the server origin and terms version filled in', async () => {
  const src = scriptOf(decode(await get('/app')));
  const raw = await get(src);
  assert.equal(raw.status, 200);
  assert.match(raw.headers['content-type'], /javascript/);
  assert.equal(raw.headers['cache-control'], 'public, max-age=31536000, immutable');
  const js = decode(raw);
  assert.match(js, /const BACKEND_URL = location\.origin;/);
  assert.ok(!js.includes('__TERMS_VERSION__'));
  assert.doesNotThrow(() => new Function(js), 'the served script parses');
  // the compressed copies are made off the main thread after the first load
  // (brotli-11 on ~900 KB takes a few seconds); until then the middleware
  // compresses on the fly
  await srv.appBundleReady();
  const br = await get(src, { 'Accept-Encoding': 'gzip, deflate, br' });
  assert.equal(br.headers['content-encoding'], 'br');
  assert.equal(decode(br), js);
  assert.ok(br.body.length < js.length / 3, `brotli ${br.body.length} of ${js.length}`);
  const gz = await get(src, { 'Accept-Encoding': 'gzip' });
  assert.equal(gz.headers['content-encoding'], 'gzip');
  assert.equal(decode(gz), js);
  assert.match(br.headers.vary || '', /Accept-Encoding/i);
});

test('a page cached from before a deploy asks for an old hash: it gets today\'s script, revalidated', async () => {
  const r = await get('/assets/app.000000000000.js');
  assert.equal(r.status, 200);
  assert.equal(r.headers['cache-control'], 'no-cache');
  assert.match(decode(r), /const BACKEND_URL = location\.origin;/);
});

test('API answers are compressed when the browser asks; event streams are not', async () => {
  const r = await get('/api/status', { 'Accept-Encoding': 'gzip' });
  assert.equal(r.status, 200);
  assert.equal(r.headers['content-encoding'], 'gzip');
  assert.equal(JSON.parse(decode(r)).version, require('../package.json').version);
  const plain = await get('/api/status');
  assert.equal(plain.headers['content-encoding'], undefined);
  // an event stream: headers arrive at once and uncompressed
  await new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/ev/stream', headers: { 'Accept-Encoding': 'gzip, br' } }, res => {
      try {
        assert.match(res.headers['content-type'], /text\/event-stream/);
        assert.equal(res.headers['content-encoding'], undefined);
        resolve();
      } catch (e) { reject(e); } finally { req.destroy(); }
    });
    req.on('error', () => {});
  });
});

test('appbundle.pick: br over gzip; the request\'s best only once it is ready', () => {
  assert.equal(appbundle.pick({ br: Buffer.from('a'), gz: Buffer.from('b') }, 'gzip, br'), 'br');
  assert.equal(appbundle.pick({ br: Buffer.from('a'), gz: Buffer.from('b') }, 'gzip'), 'gzip');
  assert.equal(appbundle.pick({ br: null, gz: Buffer.from('b') }, 'gzip, br'), null, 'brotli still compressing: on the fly, not the bigger gzip');
  assert.equal(appbundle.pick({ br: null, gz: null }, 'gzip, br'), null);
  assert.equal(appbundle.pick({ br: Buffer.from('a'), gz: Buffer.from('b') }, ''), null);
});
