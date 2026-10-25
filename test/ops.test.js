const test = require('node:test');
const assert = require('node:assert/strict');
const { createOps, createMemo } = require('../ops');

test('a blocked event loop is reported with the job that held it', async () => {
  const ops = createOps({ sampleMs: 10, stallMs: 50, log: {} });
  ops.start();
  const busy = ops.job('busy job', async () => { const t = Date.now(); while (Date.now() - t < 150); });
  await busy();
  await new Promise(r => setTimeout(r, 30));
  ops.stop();
  const st = ops.state();
  assert.ok(st.stalls.count >= 1, 'stall seen');
  assert.ok(st.stalls.worstMs >= 50);
  assert.ok(st.jobs.byMaxMs.find(j => j.name === 'busy job' && j.runs === 1 && j.maxMs >= 140));
});

test('a job error is counted and still thrown', async () => {
  const ops = createOps();
  await assert.rejects(ops.job('bad', async () => { throw new Error('x'); })(), /x/);
  assert.equal(ops.state().jobs.byMaxMs.find(j => j.name === 'bad').errors, 1);
});

test('boot marks keep the first time of each', () => {
  let t = 1000;
  const ops = createOps({ now: () => t });
  ops.mark('listening'); t += 50; ops.mark('listening'); ops.mark('backup read');
  const b = ops.state().boot;
  assert.equal(b.length, 2);
  assert.equal(b[1].ms - b[0].ms, 50);
});

test('the middleware times each route', async () => {
  const ops = createOps();
  const EventEmitter = require('events');
  const res = Object.assign(new EventEmitter(), { statusCode: 200 });
  const req = { method: 'GET', path: '/api/x', baseUrl: '', route: { path: '/api/x' } };
  let nexted = false;
  ops.middleware(req, res, () => { nexted = true; });
  assert.equal(ops.state().requests.inFlight, 1);
  res.emit('finish'); res.emit('close');
  const r = ops.state().requests.routes.find(x => x.route === 'GET /api/x');
  assert.ok(nexted);
  assert.equal(r.n, 1, 'counted once though finish and close both fire');
  assert.equal(ops.state().requests.inFlight, 0);
});

test('memo: one build per window, shared by callers in flight; errors are not kept', async () => {
  let t = 0, builds = 0;
  const memo = createMemo({ ttlMs: 100, now: () => t });
  const build = async () => { builds++; await new Promise(r => setTimeout(r, 5)); return builds; };
  const [a, b] = await Promise.all([memo('k', build), memo('k', build)]);
  assert.equal(a, 1); assert.equal(b, 1); assert.equal(builds, 1);
  t = 50; assert.equal(await memo('k', build), 1);
  t = 150; assert.equal(await memo('k', build), 2);
  await assert.rejects(memo('e', async () => { throw new Error('no'); }));
  assert.equal(await memo('e', async () => 'ok'), 'ok');
});

test('a CPU profile names the function that burned the time', async () => {
  const { summarize } = require('../ops');
  const p = { nodes: [
    { id: 1, callFrame: { functionName: '(idle)', url: '', lineNumber: -1 } },
    { id: 2, callFrame: { functionName: 'buildBoard', url: 'file:///app/server.js', lineNumber: 99 } },
    { id: 3, callFrame: { functionName: '', url: 'file:///app/x.js', lineNumber: 4 } },
  ], samples: [1, 2, 2, 2, 3], timeDeltas: [1000, 1000, 1000, 1000, 1000] };
  const s = summarize(p);
  assert.equal(s.top[0].fn, 'buildBoard server.js:100');
  assert.equal(s.top[0].ms, 3);
  assert.equal(s.idleMs, 1);
  assert.equal(s.busyPct, 80);
  assert.ok(s.top.some(r => r.fn === '(anonymous) x.js:5'));
});

test('loop counts gaps of 100, 250 and 500 ms with the jobs running', async () => {
  const ops = createOps({ sampleMs: 10, log: {} });
  ops.start();
  // still running (awaiting) when the sampler wakes after the block
  const busy = ops.job('slow step', async () => { const t = Date.now(); while (Date.now() - t < 300); await new Promise(r => setTimeout(r, 30)); });
  await busy();
  ops.stop();
  const { loop } = ops.state();
  assert.ok(loop.samples > 0 && loop.since);
  assert.ok(loop.over100 >= 1 && loop.over250 >= 1, JSON.stringify(loop));
  assert.equal(loop.over500, 0);
  assert.ok(loop.maxMs >= 250 && loop.maxMs < 500);
  assert.ok(loop.recent.some(g => g.ms >= 250 && g.jobs.includes('slow step')));
});
