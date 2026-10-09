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
