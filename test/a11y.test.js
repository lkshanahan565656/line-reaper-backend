const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const a11y = require('../a11y');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

test('server pages get a focus ring, reduced motion and a skip link to <main>', () => {
  const out = a11y.decorate('<!doctype html><html><head><title>x</title></head><body class="b"><header>h</header><main><h1>Hi</h1></main></body></html>');
  assert.match(out, /<style id="lr-a11y">[\s\S]*:focus-visible[\s\S]*prefers-reduced-motion[\s\S]*<\/style><\/head>/);
  assert.match(out, /<body class="b"><a class="lr-skip" href="#main">Skip to content<\/a>/);
  assert.match(out, /<main id="main" tabindex="-1">/);
  // once only
  assert.equal(a11y.decorate(out), out);
});

test('skip link keeps an existing main id; pages without <main> or <head> get no skip link', () => {
  assert.match(a11y.decorate('<html><head></head><body><main id="top" class="x">a</main></body></html>'), /href="#top"[\s\S]*<main tabindex="-1" id="top" class="x">/);
  assert.doesNotMatch(a11y.decorate('<html><head></head><body><div>a</div></body></html>'), /lr-skip"/);
  assert.equal(a11y.decorate('{"json":true}'), '{"json":true}');
});

test('the middleware decorates HTML sent as a string and leaves JSON and skipped paths alone', () => {
  const run = (path, type, body) => {
    let sent;
    const res = { send: b => { sent = b; }, get: () => type };
    a11y.middleware(r => r.path === '/app')({ method: 'GET', path }, res, () => {});
    res.send(body);
    return sent;
  };
  const page = '<html><head></head><body><main>a</main></body></html>';
  assert.match(run('/pricing', 'text/html; charset=utf-8', page), /lr-a11y/);
  assert.equal(run('/app', 'text/html', page), page);
  assert.equal(run('/api/x', 'application/json', '{"a":"</head>"}'), '{"a":"</head>"}');
});

test('the app: skip link, main landmark, focus ring, reduced motion, one live region', () => {
  assert.match(html, /<a class="skip-link" href="#main"/);
  assert.match(html, /<main id="main" tabindex="-1">/);
  assert.match(html, /<nav class="tab-row" aria-label="Screens">/);
  assert.match(html, /:focus-visible \{ outline:2px solid #34d399/);
  assert.match(html, /@media \(prefers-reduced-motion: reduce\)/);
  assert.equal((html.match(/id="lrLive"/g) || []).length, 1);
  // toasts are read through #lrLive, not as a new live region each
  assert.match(html, /lrSay\(msg\);/);
});

test('the app: single-key shortcuts can be switched off (WCAG 2.1.4)', () => {
  assert.match(html, /if \(typeof layout !== 'undefined' && layout\.keysOff\) return;/);
  assert.match(html, /id="layKeys" onclick="layToggleKeys\(\)"/);
  assert.match(html, /id="kbdKeysBtn" onclick="layToggleKeys\(\)"/);
});

test('the app: clickable spans, cells and rows are reachable by keyboard', () => {
  const tags = [...html.matchAll(/<(span|div|td|tr|th)\b[^>]*\sonclick="[^"]*"[^>]*>/g)].map(m => m[0])
    // pop-up backdrops close on a click outside the box; a chart only stops a click bubbling
    .filter(t => !/onclick="if\(event\.target===this\)|onclick="event\.stopPropagation\(\)"/.test(t));
  const bad = tags.filter(t => !/tabindex="0"/.test(t));
  assert.deepStrictEqual(bad, []);
});

test('no muted text colour under 4.5:1 on the darkest cards (old #64748b and #475569 greys)', () => {
  for (const f of ['public/index.html', 'public/landing.html', 'learn.js', 'status.js', 'digest.js', 'linehist.js', 'alertlog.js', 'embeds.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    assert.doesNotMatch(src, /#64748b|#475569/i, f);
  }
});
