// Page speed budget for /app on a phone (appbundle.js, scripts/pagespeed.js).
// What a first visit downloads before the ODDS SCREEN can draw: the page and
// its script, brotli-compressed as the server sends them. If a change pushes
// it past the budget, make the new code smaller or load it only when its
// screen opens; raise the budget only on purpose, in the same PR, with why.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const appBundle = require('../appbundle');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
// set after the speed pass (v3.200.0): page 38 KB + script 184 KB brotli, 1.0 MB raw
const BUDGET = { brotli: 250 * 1024, raw: 1150 * 1024 };

// the page as server.js loadApp() hands it to the bundler
const served = html.replace('/*@@LRVENUE@@*/', () => fs.readFileSync(path.join(ROOT, 'venuelinks.js'), 'utf8'));

test('first-screen page plus script stay inside the size budget', async () => {
  const b = await appBundle.build(served);
  assert.equal(b.assets.size, 1, 'the big app script is split out to /assets');
  const [url, js] = [...b.assets][0];
  assert.match(url, /^\/assets\/app\.[0-9a-f]{16}\.js$/);
  assert.ok(b.page.raw.toString().includes(`<script src="${url}"></script>`));
  const br = b.page.br.length + js.br.length, raw = b.page.raw.length + js.raw.length;
  const kb = n => `${(n / 1024).toFixed(0)} KB`;
  assert.ok(br <= BUDGET.brotli, `page + script are ${kb(br)} brotli, over the ${kb(BUDGET.brotli)} budget`);
  assert.ok(raw <= BUDGET.raw, `page + script are ${kb(raw)} uncompressed, over the ${kb(BUDGET.raw)} budget`);
  // the split keeps every byte of the script and the page around it
  assert.equal(b.page.raw.length + js.raw.length - `<script src="${url}"></script>`.length + '<script></script>'.length, Buffer.byteLength(served));
  assert.equal(zlib.brotliDecompressSync(js.br).toString(), js.raw.toString());
  assert.equal(zlib.gunzipSync(b.page.gz).toString(), b.page.raw.toString());
});

test('opening the app does not download the full pick\'em line feeds', () => {
  const body = html.slice(html.indexOf('async function loadDFSLines'), html.indexOf('async function loadDFSLines') + 800);
  assert.doesNotMatch(body, /\/api\/(underdog|prizepicks)/, 'the header counts come from /api/status');
  assert.match(body, /lrStatus\(\)/);
});

test('fonts never hold up the first paint', () => {
  const css = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
  assert.doesNotMatch(css, /@import/, 'an @import in the page CSS blocks rendering until it loads');
  assert.match(html, /<link rel="stylesheet" href="https:\/\/fonts\.googleapis\.com[^"]*" media="print" onload="this\.media='all'">/);
});

test('the odds prices are asked for while the page loads, and used once', () => {
  const head = html.slice(0, html.indexOf('</head>'));
  assert.match(head, /window\.LR_EARLY = \{ key: key, res: fetch\(key\)/);
  assert.match(html, /window\.LR_EARLY && window\.LR_EARLY\.key === `\/api\/odds-screen\?\$\{qs\}`/);
  assert.match(html, /window\.LR_EARLY = null;/);
});

test('send() picks brotli, then gzip, answers 304 to a matching ETag', async () => {
  const f = await appBundle.packed('x'.repeat(5000), 'text/plain');
  const run = (headers) => {
    const out = { headers: {}, status: 200 };
    const req = { method: 'GET', fresh: headers['if-none-match'] === f.etag, acceptsEncodings: e => (headers['accept-encoding'] || '').includes(e) && e };
    const res = { set(k, v) { if (typeof k === 'object') Object.assign(out.headers, k); else out.headers[k] = v; return res; }, status(s) { out.status = s; return res; }, end(b) { out.body = b; return res; } };
    appBundle.send(req, res, f, 'no-cache');
    return out;
  };
  assert.equal(run({ 'accept-encoding': 'gzip, deflate, br' }).headers['Content-Encoding'], 'br');
  assert.equal(run({ 'accept-encoding': 'gzip' }).headers['Content-Encoding'], 'gzip');
  assert.equal(run({}).body.length, 5000);
  assert.equal(run({ 'if-none-match': f.etag }).status, 304);
});
