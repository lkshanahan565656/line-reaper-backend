// The CPU profile summary: self time, time on the stack, and the longest busy runs.
const test = require('node:test');
const assert = require('node:assert');
const { summarize, createProfiler } = require('../ops');

const frame = (id, functionName, url, children = []) => ({ id, callFrame: { functionName, url, lineNumber: 9 }, children });
// root → job (ours) → helper (ours) → JSON.parse (native); root → (idle)
const profile = {
  nodes: [
    frame(1, '(root)', '', [2, 5]),
    frame(2, 'job', '/app/server.js', [3]),
    frame(3, 'helper', '/app/xarb.js', [4]),
    frame(4, 'parse', 'node:internal/json'),
    frame(5, '(idle)', ''),
  ],
  // busy 3 ms, idle 1 ms, busy 1 ms
  samples: [4, 3, 4, 5, 2],
  timeDeltas: [1000, 1000, 1000, 1000, 1000],
};

test('profile summary: inclusive time counts each of our functions once a sample', () => {
  const s = summarize(profile);
  assert.deepStrictEqual(s.inclusive, [{ fn: 'job server.js:10', ms: 4 }, { fn: 'helper xarb.js:10', ms: 3 }]);
  assert.equal(s.top[0].fn, 'parse json:10');
  assert.equal(s.idleMs, 1);
});

test('profile summary: bursts are runs of busy samples, longest first, with what was on the stack', () => {
  const s = summarize(profile);
  assert.deepStrictEqual(s.bursts.map(b => b.ms), [3, 1]);
  assert.deepStrictEqual([...s.bursts[0].fns].sort((a, b) => a.fn.localeCompare(b.fn)), [{ fn: 'helper xarb.js:10', ms: 3 }, { fn: 'job server.js:10', ms: 3 }]);
});

test('profile summary: an empty profile is empty', () => {
  const s = summarize({});
  assert.deepStrictEqual([s.totalMs, s.inclusive, s.bursts], [0, [], []]);
});

test('profiler: a real profile of a busy loop names it', async () => {
  const p = createProfiler();
  const run = p.profile(5);
  const t0 = Date.now();
  const spin = () => { const end = Date.now() + 300; let x = 0; while (Date.now() < end) x += Math.sqrt(x + 1); return x; };
  await new Promise(r => setTimeout(r, 200));
  spin();
  const s = await run;
  assert.ok(Date.now() - t0 >= 5000);
  assert.ok(s.bursts[0].ms >= 250, `longest burst ${s.bursts[0].ms} ms`);
  assert.ok(s.inclusive.some(f => f.fn.startsWith('spin ')));
});
