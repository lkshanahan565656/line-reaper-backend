// The status page (status.js): states from each feed's last good read, the
// rolling 5-minute history, uptime only from samples taken, and the page
// saying "no data yet" when there are none.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createStatusBoard, renderPage, stateOf } = require('../status');

const MIN = 60e3;
function board(rows, t0 = Date.parse('2026-10-26T00:00:00Z')) {
  let t = t0;
  const b = createStatusBoard({ probe: () => rows(t), now: () => t, version: () => '9.9.9' });
  return { b, at: () => t, tick: ms => { t += ms; } };
}

test('state: up inside the stale limit, stale after it, down with no read, off when switched off', () => {
  const r = { enabled: true, staleMs: 5 * MIN };
  assert.equal(stateOf(r, 1000, 1000 + 4 * MIN), 'up');
  assert.equal(stateOf(r, 1000, 1000 + 6 * MIN), 'stale');
  assert.equal(stateOf(r, null, 1000), 'down');
  assert.equal(stateOf({ ...r, enabled: false }, 1000, 1000), 'off');
});

test('the newest good read is remembered when a later read fails', () => {
  let okAt = null;
  const { b, at, tick } = board(() => [{ key: 'pin', name: 'Pinnacle', group: 'sharp', enabled: true, okAt, staleMs: 5 * MIN }]);
  okAt = at();
  assert.equal(b.view().feeds[0].state, 'up');
  okAt = null;   // the feed's own state forgot it (a failed read)
  tick(2 * MIN);
  assert.equal(b.view().feeds[0].state, 'up');
  tick(10 * MIN);
  assert.equal(b.view().feeds[0].state, 'stale');
  assert.equal(b.view().feeds[0].ageS, 12 * 60);
});

test('no samples: uptime and the site figure say nothing, and the page says no data yet', () => {
  const { b } = board(t => [{ key: 'k', name: 'Kalshi', group: 'exchange', enabled: true, okAt: t, staleMs: 5 * MIN, count: 3, unit: 'markets' }]);
  const v = b.view();
  assert.equal(v.site.uptime24h, null);
  assert.equal(v.feeds[0].uptime24h, null);
  assert.equal(v.liveCheck, null);
  assert.ok(v.feeds[0].last24h.every(c => c === null));
  const html = renderPage(v);
  assert.match(html, /no data yet/);
  assert.match(html, /Kalshi/);
  assert.match(html, /Every feed that is on is reading/);
});

test('uptime counts only samples a feed was on; one sample per 5-minute slot', () => {
  let up = true;
  const { b, tick } = board(t => [
    { key: 'a', name: 'A', group: 'app', enabled: true, okAt: up ? t : null, staleMs: MIN },
    { key: 'o', name: 'Off', group: 'app', enabled: false, okAt: null, staleMs: MIN },
  ]);
  assert.ok(b.sample());
  assert.equal(b.sample(), null, 'same slot');
  for (let i = 0; i < 3; i++) { tick(5 * MIN); b.sample(); }
  up = false;
  tick(5 * MIN); b.sample();   // a's last read is now 5 min old, past its 1 min limit
  const v = b.view();
  assert.equal(b.size(), 5);
  assert.deepEqual(v.feeds[0].uptime24h, { pct: 4 / 5, samples: 5 });
  assert.equal(v.feeds[1].uptime24h, null, 'never on, no uptime');
  assert.equal(v.feeds[0].state, 'stale');
  assert.equal(v.site.uptime24h.pct, 1);
});

test('a gap with no samples (server not running) lowers site uptime; the history survives a dump and load', () => {
  const { b, tick } = board(t => [{ key: 'a', name: 'A', group: 'app', enabled: true, okAt: t, staleMs: MIN }]);
  b.sample();
  tick(5 * MIN); b.sample();
  tick(30 * MIN); b.sample();   // five slots missed
  const v = b.view();
  assert.equal(v.site.uptime24h.samples, 3);
  assert.ok(v.site.uptime24h.pct < 0.5 && v.site.uptime24h.pct > 0.3);
  const copy = board(() => [], Date.parse('2026-10-26T00:35:00Z'));
  assert.equal(copy.b.load(b.dump()), 3);
  assert.equal(copy.b.load(b.dump()), 0, 'ids are not added twice');
  assert.equal(copy.b.size(), 3);
  copy.tick(8 * 24 * 3600e3); copy.b.load([]);
  assert.equal(copy.b.size(), 0, 'older than 7 days is dropped');
});

test('the page shows the live check and escapes feed text', () => {
  const { b } = board(() => [{ key: 'x', name: 'X <b>', group: 'book', enabled: true, okAt: null, staleMs: MIN, error: '<script>' }]);
  const html = renderPage(b.view({ liveCheck: { last: { ok: true, at: '2026-10-26T00:00:00Z', version: '9.9.9', failures: 0 } }, uptimeS: 90 }));
  assert.match(html, /PASSED/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /X &lt;b&gt;/);
  assert.match(html, /1 of 1 feeds are not reading/);
});

test('the page reloads itself each minute with a pause button, and no meta refresh (WCAG 2.2.1)', () => {
  const { b } = board(() => [{ key: 'pin', name: 'Pinnacle', group: 'sharp', enabled: true, okAt: null, staleMs: MIN }]);
  const html = renderPage(b.view({ uptimeS: 90 }));
  assert.doesNotMatch(html, /http-equiv="refresh"/);
  assert.match(html, /<button type="button" id="rl"[^>]*>PAUSE RELOADING<\/button>/);
  assert.match(html, /<script id="reload">[\s\S]*location\.reload\(\)[\s\S]*<\/script>/);
  assert.match(html, /<div class="scroll" tabindex="0" role="region"/);
});
