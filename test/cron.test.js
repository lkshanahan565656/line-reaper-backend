'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const toFields = require('node-cron/src/convert-expression');

const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const exprs = [...src.matchAll(/^\s*schedule\('([^']+)'/gm)].map(m => m[1]);

test('every server job goes through the catch-up wrapper', () => {
  assert.ok(exprs.length >= 20, `found ${exprs.length} jobs`);
  assert.equal(src.match(/cron\.schedule\(/g).length, 1, 'only the wrapper calls node-cron directly');
  assert.match(src, /const schedule = \(expr, fn\) => cron\.schedule\(expr, fn, \{ recoverMissedExecutions: true \}\)/);
});

test('no job uses a stepped range, which node-cron 3 expands wrong', () => {
  assert.equal(toFields('20 7-59/10 * * * *').split(' ')[1], '10,20,30,40,50', 'why: the step is taken from 0, not 7');
  for (const e of exprs) {
    assert.ok(cron.validate(e), e);
    assert.doesNotMatch(e, /\d-\d+\/\d/, e);
  }
  assert.ok(exprs.includes('20 7,17,27,37,47,57 * * * *'), 'the settle job, every 10 minutes from :07');
  assert.equal(toFields('20 7,17,27,37,47,57 * * * *').split(' ')[1], '7,17,27,37,47,57');
});

test('a job whose second passes while the event loop is busy runs late with the wrapper, and is dropped without it', async () => {
  const at = Math.floor(Date.now() / 1000) + 2;   // a second that starts at least 1s from now
  const expr = `${at % 60} * * * * *`;
  const fired = { recover: 0, plain: 0 };
  const a = cron.schedule(expr, () => { fired.recover++; }, { recoverMissedExecutions: true });
  const b = cron.schedule(expr, () => { fired.plain++; });
  while (Date.now() < at * 1000 + 1500) { /* hold the event loop through that second */ }
  await new Promise(r => setTimeout(r, 1300));
  a.stop(); b.stop();
  assert.deepEqual(fired, { recover: 1, plain: 0 });
});
