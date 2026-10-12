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
