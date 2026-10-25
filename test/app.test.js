const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

test('the bundled app can be pointed at its own server', () => {
  // server.js rewrites this line when it serves /app
  assert.match(html, /const BACKEND_URL = '[^']*';/);
});

test('the bundled app carries no API keys', () => {
  assert.doesNotMatch(html, /owlsinsight_[0-9a-f]{20,}/, 'Owls key');
  assert.doesNotMatch(html, /api\.the-odds-api\.com/, 'direct Odds API calls');
  assert.doesNotMatch(html, /apiKey=\$\{/, 'key in a query string');
  assert.doesNotMatch(html, /\b[0-9a-f]{32}\b/, 'something shaped like an Odds API key');
});

// ready-to-sell UI: no emoji anywhere, first-visit welcome screen
test('page has no emoji and ships the welcome screen', () => {
  const pict = /[\u{1F300}-\u{1FAFF}☀-➿⭐⌀-⏿]|️/u;
  const bad = html.split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => pict.test(l.replace(/[✓→▲▼●○◆▸▾◐★✕✗]/g, '')));
  assert.deepStrictEqual(bad.map(b => b[0]), []);
  assert.ok(html.includes('id="welcome"') && html.includes('by sharps'));
  assert.ok(html.includes("ssGet('lr_welcomed')"));
});

test('layout customizer: MORE menu, tab reorder/hide, foldable help panels', () => {
  for (const id of ['layModal', 'moreMenu']) assert.ok(html.includes(id), id);
  for (const fn of ['layApply', 'layMove', 'layHide', 'layPin', 'layReset', 'layFoldInit']) assert.ok(html.includes(`function ${fn}`), fn);
  assert.ok(html.includes("const LAY_KEY = 'lr_layout'"));
});

test('TOOLS tab ships the calculators and loads calc.js from the server', () => {
  assert.ok(html.includes("showTab('tools',this)") && html.includes('id="page-tools"'));
  assert.ok(html.includes("'/calc.js'"));
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(server, /app\.get\('\/calc\.js'/);
});

// the public sales page at /
test('sales page: no emoji, legal links, links into the app', () => {
  const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'landing.html'), 'utf8');
  const pict = /[\u{1F300}-\u{1FAFF}☀-➿⭐⌀-⏿]|️/u;
  assert.deepStrictEqual(page.split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => pict.test(l)).map(b => b[0]), []);
  for (const href of ['/terms', '/privacy', '/refunds', '/app?start=signup', '/app?start=app']) assert.ok(page.includes(`href="${href}"`), href);
  assert.ok(html.includes("get('start')"), 'the app reads ?start= from the sales page links');
  assert.ok(page.includes('href="/app?start=pro"') && html.includes("start === 'pro'"), 'Get Pro goes to checkout');
  assert.ok(page.includes('href="/app?start=results"'), 'the record links to the full Results tab');

});

test('MY BETS tab: on the main bar, loads bets.js after calc.js, LOG buttons on plays', () => {
  assert.ok(html.includes("showTab('betlog',this)\">MY BETS<") && html.includes('id="page-betlog"'));
  assert.ok(!/LAY_MORE_DEFAULT = \[[^\]]*'betlog'/.test(html), 'not hidden under MORE');
  assert.ok(html.indexOf("'/calc.js'") < html.indexOf("'/bets.js'"));
  for (const fn of ['mybLogBest', 'mybLogTail', 'mybAutoSettle', 'mybExport', 'mybImport']) assert.ok(html.includes(`function ${fn}`), fn);
  assert.ok(html.includes("const MYB_KEY = 'lr_bets'") && html.includes("lsGet('ww_bets')"), 'old BET LOG migrates');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(server, /app\.get\('\/bets\.js'/);
  assert.match(server, /app\.post\('\/api\/bets\/settle'/);
});

// 10-25: a stray backslash in id="layModal\" (PR 233) made CUSTOMIZE throw and
// do nothing, push alert settings included
test('no element id carries a backslash or a quote', () => {
  const bad = [...html.matchAll(/\bid="([^"]*)"/g)].map(m => m[1]).filter(id => /[\\'`]/.test(id) && !id.includes('${'));
  assert.deepStrictEqual(bad, []);
  assert.ok(html.includes('<div class="lay-modal" id="layModal" '), 'the CUSTOMIZE panel has its id');
});
