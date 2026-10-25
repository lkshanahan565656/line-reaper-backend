const test = require('node:test');
const assert = require('node:assert/strict');
const { createLiveCheck } = require('../livecheck');

test('live check: reads the smoke result from the repo, trims it, and re-reads at most every 30 s', async () => {
  let t = 1e6, calls = 0;
  const result = { ok: false, at: '2026-10-25T05:00:00Z', version: '3.171.0', want: '3.171.0', clicks: 400, tabs: 17, failures: [{ summary: 'page-error on odds: x is undefined' }, { what: 'dead-control' }], extra: 'x'.repeat(10) };
  const axios = { get: async url => { calls++; assert.match(url, /raw\.githubusercontent/); return { data: JSON.stringify(result) }; } };
  const lc = createLiveCheck(axios, { url: 'https://raw.githubusercontent.com/o/r/diag-e2e-smoke-out/smoke.json', now: () => t });
  const s = await lc.refresh();
  assert.equal(s.last.ok, false);
  assert.equal(s.last.failures, 2);
  assert.deepEqual(s.last.first, ['page-error on odds: x is undefined', 'dead-control']);
  assert.equal(s.last.extra, undefined);
  await lc.refresh();
  assert.equal(calls, 1, 'a second ask inside 30 s does not re-read');
  t += 31e3;
  await lc.refresh();
  assert.equal(calls, 2);
});

test('live check: a bad file or a failed read leaves the last good result and says why', async () => {
  let t = 1e6, body = { ok: true, failures: [] };
  const axios = { get: async () => { if (!body) throw new Error('404'); return { data: body }; } };
  const lc = createLiveCheck(axios, { url: 'https://raw.githubusercontent.com/x', now: () => t });
  await lc.refresh();
  assert.equal(lc.state.last.ok, true);
  body = null; t += 31e3;
  await lc.refresh();
  assert.equal(lc.state.last.ok, true);
  assert.equal(lc.state.error, '404');
});
