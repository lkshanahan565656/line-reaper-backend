// Page weight for /app: what a first visit downloads before any screen draws
// is the page plus its script (served brotli). If a change pushes it past the
// budget, make the new code smaller or load it when its screen opens; raise
// the budget only on purpose, in the same PR, saying why.
const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('zlib');
const { page, script } = require('./app-source');

// set 10-27 (v3.223.0): page 37 KB + script 210 KB at brotli-11 (the server), 262 KB at the quality 9 used here
const BUDGET_BROTLI = 300 * 1024;
const br = s => zlib.brotliCompressSync(Buffer.from(s), { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9 } }).length;

test('page plus script stay inside the brotli budget', () => {
  const n = br(page) + br(script);
  assert.ok(n <= BUDGET_BROTLI, `page + script are ${Math.round(n / 1024)} KB brotli, over ${BUDGET_BROTLI / 1024} KB`);
});

test('the page holds no app code: one script tag for the bundle, after the inlined venue links', () => {
  assert.equal((page.match(/<script src="\/app\.js"><\/script>/g) || []).length, 1);
  assert.match(page, /<script>\/\*@@LRVENUE@@\*\/<\/script>\s*<script src="\/app\.js"><\/script>/);
  const inline = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  assert.deepEqual(inline, ['/*@@LRVENUE@@*/']);
});

test('opening the app does not download the full pick\'em line feeds for the header counts', () => {
  const i = script.indexOf('async function loadDFSLines');
  const body = script.slice(i, script.indexOf('\n}\n', i));
  assert.doesNotMatch(body, /\/api\/(underdog|prizepicks)/);
  assert.match(body, /lrStatus\(\)/);
});

test('fonts never hold up the first paint', () => {
  const css = page.slice(page.indexOf('<style>'), page.indexOf('</style>'));
  assert.doesNotMatch(css, /@import/, 'an @import in the page CSS blocks rendering until it loads');
  assert.match(page, /<link rel="stylesheet" href="https:\/\/fonts\.googleapis\.com[^"]*" media="print" onload="this\.media='all'">/);
});
