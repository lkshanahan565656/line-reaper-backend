'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createMemGuard, limitsFromEnv } = require('../memguard');

const MB = 1048576;
function rig({ heap = 500, rss = 800, backupAt = null, limits } = {}) {
  const r = { t: 0, heap, rss, backupAt, exits: [], flushed: 0 };
  r.guard = createMemGuard({
    limits: limits || { on: true, capMb: 1584, softMb: 1346, hardMb: 1520, rssSoftMb: 2096 },
    usage: () => ({ heapUsed: r.heap * MB, rss: r.rss * MB }),
    lastBackupAt: () => r.backupAt,
    flush: async () => { r.flushed++; },
    exit: c => r.exits.push(c),
    now: () => r.t,
    log: { warn() {} },
  });
  r.at = min => { r.t = min * 60e3; return r.guard.check(); };
  return r;
}
const settle = () => new Promise(res => setImmediate(res));

test('limits come from the heap cap, and only switch on by themselves on Railway', () => {
  const l = limitsFromEnv({ RAILWAY_ENVIRONMENT: 'production' }, 1584);
  assert.deepStrictEqual(l, { on: true, capMb: 1584, softMb: 1346, hardMb: 1521, rssSoftMb: 2096 });
  assert.strictEqual(limitsFromEnv({}, 1584).on, false);
  assert.strictEqual(limitsFromEnv({ MEM_GUARD: 'on' }, 1584).on, true);
  assert.strictEqual(limitsFromEnv({ RAILWAY_PROJECT_ID: 'x', MEM_GUARD: 'off' }, 1584).on, false);
  assert.strictEqual(limitsFromEnv({ RAILWAY_PROJECT_ID: 'x', LR_DESKTOP: '1' }, 1584).on, false);
  const set = limitsFromEnv({ MEM_SOFT_MB: '1000', MEM_HARD_MB: '900', MEM_RSS_SOFT_MB: '1800' }, 1584);
  assert.deepStrictEqual([set.softMb, set.hardMb, set.rssSoftMb], [1000, 1000, 1800]);
});

test('normal memory never restarts', async () => {
  const r = rig();
  for (let m = 0; m < 120; m++) assert.strictEqual(r.at(m), null);
  await settle();
  assert.deepStrictEqual(r.exits, []);
  assert.strictEqual(r.guard.status().peakHeapMb, 500);
});

test('over the soft line for 10 minutes: restarts right after the next backup, flushing first', async () => {
  const r = rig({ heap: 1400 });
  r.at(0); r.at(5);
  assert.strictEqual(r.guard.status().restartPendingSince, null);
  r.at(10);
  assert.ok(r.guard.status().restartPendingSince, 'pending after 10 minutes over');
  r.backupAt = new Date(5 * 60e3).toISOString();     // an old backup does not count
  assert.strictEqual(r.at(12), null);
  r.backupAt = new Date(13 * 60e3).toISOString();
  assert.strictEqual(r.at(13.5), 'soft');
  await settle(); await settle();
  assert.deepStrictEqual(r.exits, [1]);
  assert.strictEqual(r.flushed, 1);
  assert.strictEqual(r.at(14), null, 'nothing more once exiting');
});

test('no backup comes: restarts anyway after 25 minutes', async () => {
  const r = rig({ heap: 1400 });
  r.at(0); r.at(10);
  assert.strictEqual(r.at(34), null);
  assert.strictEqual(r.at(35), 'soft');
  await settle(); await settle();
  assert.deepStrictEqual(r.exits, [1]);
});

test('memory going back down cancels; a dip just under the line does not', () => {
  const r = rig({ heap: 1400 });
  r.at(0);
  r.heap = 1300; r.at(4);            // under the line but above 90%: still counting
  r.heap = 1400; r.at(10);
  assert.ok(r.guard.status().restartPendingSince);
  r.heap = 1000; r.at(11);
  assert.strictEqual(r.guard.status().restartPendingSince, null);
  assert.strictEqual(r.guard.status().overSince, null);
});

test('RSS alone over its line counts too', () => {
  const r = rig({ heap: 600, rss: 2200 });
  r.at(0); r.at(10);
  assert.ok(r.guard.status().restartPendingSince);
});

test('hard line: two checks in a row exit at once, but not during the boot window', async () => {
  const r = rig({ heap: 1530 });
  assert.strictEqual(r.at(1), null);
  assert.strictEqual(r.at(2), null, 'boot restore peak is allowed');
  assert.strictEqual(r.at(11), null, 'one check is not enough');
  r.heap = 1400; r.at(11.5);
  r.heap = 1530;
  assert.strictEqual(r.at(12), null);
  assert.strictEqual(r.at(12.5), 'hard');
  await settle(); await settle();
  assert.deepStrictEqual(r.exits, [1]);
});

test('a flush that hangs still exits', async () => {
  const exits = [];
  const g = createMemGuard({ limits: { on: true, capMb: 100, softMb: 50, hardMb: 60, rssSoftMb: 1e6 },
    usage: () => ({ heapUsed: 70 * MB, rss: 0 }), flush: () => new Promise(() => {}), exit: c => exits.push(c),
    now: (() => { let t = 0; return () => (t += 6 * 60e3); })(), flushMs: 20, log: { warn() {} } });
  g.check(); g.check(); g.check();
  await new Promise(res => setTimeout(res, 60));
  assert.deepStrictEqual(exits, [1]);
});

test('off: never samples or exits', () => {
  const r = rig({ heap: 5000, limits: { on: false, capMb: 1584, softMb: 1346, hardMb: 1520, rssSoftMb: 2096 } });
  for (let m = 0; m < 60; m++) assert.strictEqual(r.at(m), null);
  assert.deepStrictEqual(r.exits, []);
});

test('a heap spike clears once the heap comes down, even with RSS high but under its line (live 11-02)', () => {
  const r = rig({ heap: 1100, rss: 2000 });   // RSS in the top 10% of its 2,096 MB line, never over it
  r.at(0);
  r.heap = 1400; r.at(1);                     // one spike over the 1,346 MB soft line
  r.heap = 1150; r.at(2);                     // back under 90% of it
  assert.strictEqual(r.guard.status().overSince, null);
  for (let m = 3; m <= 30; m++) r.at(m);
  assert.strictEqual(r.guard.status().restartPendingSince, null, 'no restart from a spike that passed');
  assert.deepStrictEqual(r.exits, []);
});

test('leaving keeps why, for the next boot to show', async () => {
  const kept = [];
  const r = rig({ heap: 1530 });
  r.guard = createMemGuard({ limits: { on: true, capMb: 1584, softMb: 1346, hardMb: 1520, rssSoftMb: 2096 },
    usage: () => ({ heapUsed: r.heap * MB, rss: 900 * MB }), exit: c => r.exits.push(c), now: () => r.t,
    record: x => kept.push(x), previousExit: { reason: 'earlier', at: 'x' }, log: { warn() {} } });
  r.t = 11 * 60e3; r.guard.check(); r.t = 11.5 * 60e3; r.guard.check();
  await settle(); await settle();
  assert.strictEqual(kept.length, 1);
  assert.match(kept[0].reason, /hard line/);
  assert.strictEqual(kept[0].peakHeapMb, 1530);
  assert.strictEqual(kept[0].upMin, 12);
  assert.deepStrictEqual(r.guard.status().previousExit, { reason: 'earlier', at: 'x' });
});
