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
