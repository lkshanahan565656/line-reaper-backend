// Every setting the server reads is named in .env.example, so an operator can
// find it without reading the code. Railway's own variables are exempt.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const SKIP_DIRS = new Set(['node_modules', 'test', 'e2e', 'scripts', '.git', 'data', 'public']);
const EXEMPT = /^(RAILWAY_[A-Z_]+|PORT|NODE_ENV)$/;

function runtimeFiles(dir = root) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) out.push(...runtimeFiles(path.join(dir, e.name))); }
    else if (e.name.endsWith('.js')) out.push(path.join(dir, e.name));
  }
  return out;
}

test('every environment variable the server reads is in .env.example', () => {
  const doc = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
  const missing = new Map();
  for (const file of runtimeFiles()) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/(?:process\.env|\benv)(?:\.([A-Z][A-Z0-9_]+)|\[['"]([A-Z][A-Z0-9_]+)['"]\])/g)) {
      const name = m[1] || m[2];
      if (EXEMPT.test(name) || new RegExp(`\\b${name}\\b`).test(doc)) continue;
      missing.set(name, path.relative(root, file));
    }
  }
  assert.deepEqual([...missing].map(([n, f]) => `${n} (${f})`), []);
});

test('every endpoint /developers lists has a route', () => {
  const src = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const routed = new Set([...src.matchAll(/app\.(?:get|post|delete)\('([^']+)'/g)].map(m => m[1].replace(/:[A-Za-z]+/g, ':p')));
  const listed = require('../publicapi').ENDPOINTS.map(e => String(e.path).split('?')[0].replace(/\{[A-Za-z]+\}/g, ':p'));
  assert.ok(listed.length > 10);
  assert.deepEqual(listed.filter(p => !routed.has(p)), []);
});
