// routes/*.js sit one folder below server.js: a path built from __dirname must
// step up first, or a seed file is silently not found (the reads catch it).
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

test('route modules resolve repo files from the repo root, not from routes/', () => {
  const dir = path.join(__dirname, '..', 'routes');
  for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    const bad = src.match(/path\.(join|resolve)\(__dirname, '(?!\.\.')[^']*'/g) || [];
    assert.deepEqual(bad, [], `${f} builds a path under routes/`);
    assert.doesNotMatch(src, /require\('\.\/(?!routes\/)/, `${f} requires a sibling of server.js as ./`);
  }
});
