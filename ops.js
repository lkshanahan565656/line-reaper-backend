// ─── OPS: health, stalls, slow requests, boot timeline ───────────────────────
// What /api/health and /api/ops report. Nothing here holds data worth hiding:
// route paths without their query, job labels, timings.
//
//   stalls     the event loop is sampled every 100 ms; a gap of 500 ms or more
//              is logged with the cron jobs and requests that were running
//   requests   per route: count, slowest, total; plus the slowest recent ones
//   boot       named marks from process start (module loaded, listening,
//              backup read, ...)

const STALL_MS = 500;

function createOps({ now = () => Date.now(), sampleMs = 100, stallMs = STALL_MS, keep = 50, log = console } = {}) {
  const t0 = now() - Math.round(process.uptime() * 1000);
  const boot = [];          // { mark, ms } since process start
  const activeJobs = new Map();   // token → { name, at }
  const activeReqs = new Map();   // token → { path, at }
  const stalls = [];        // newest last
  const jobs = {};          // name → { runs, lastMs, maxMs, lastAt, running, errors }
  const routes = {};        // 'GET /api/x' → { n, maxMs, totalMs, over1s }
  const slow = [];          // slowest recent requests (≥ 1 s)
  let token = 0, last = now(), timer = null, worstMs = 0;

  function mark(name) {
    if (boot.some(b => b.mark === name)) return;
    boot.push({ mark: name, ms: now() - t0, at: new Date(now()).toISOString() });
  }

  function start() {
    if (timer) return;
    last = now();
    timer = setInterval(() => {
      const t = now(), gap = t - last - sampleMs;
      last = t;
      if (gap < stallMs) return;
      if (gap > worstMs) worstMs = gap;
      const s = {
        at: new Date(t).toISOString(), ms: gap, uptimeS: Math.round((t - t0) / 1000),
        jobs: [...activeJobs.values()].map(j => j.name).slice(0, 12),
        requests: [...activeReqs.values()].map(r => r.path).slice(0, 12),
      };
      stalls.push(s);
      if (stalls.length > keep) stalls.shift();
      if (gap >= 2000) log.warn?.(`Event loop stalled ${gap} ms (jobs: ${s.jobs.join(', ') || 'none'}; requests: ${s.requests.join(', ') || 'none'})`);
    }, sampleMs);
    timer.unref?.();
  }

  // wraps a job: tracks it as running while its promise is pending
  function job(name, fn) {
    return async (...args) => {
      const j = jobs[name] ||= { runs: 0, lastMs: null, maxMs: 0, lastAt: null, running: 0, errors: 0 };
      const k = ++token, a = now();
      activeJobs.set(k, { name, at: a });
      j.running++;
      try { return await fn(...args); }
      catch (e) { j.errors++; throw e; }
      finally {
        activeJobs.delete(k);
        const ms = now() - a;
        j.running--; j.runs++; j.lastMs = ms; j.lastAt = new Date(a).toISOString();
        if (ms > j.maxMs) j.maxMs = ms;
      }
    };
  }

  // express middleware: in-flight requests and per-route timings
  const routeKey = req => `${req.method} ${(req.route?.path && req.baseUrl != null ? req.baseUrl + req.route.path : req.path).slice(0, 80)}`;
  function middleware(req, res, next) {
    const k = ++token, a = now();
    activeReqs.set(k, { path: `${req.method} ${String(req.path).slice(0, 80)}`, at: a });
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      activeReqs.delete(k);
      const ms = now() - a, key = routeKey(req);
      const r = routes[key] ||= { n: 0, maxMs: 0, totalMs: 0, over1s: 0 };
      r.n++; r.totalMs += ms; if (ms > r.maxMs) r.maxMs = ms; if (ms >= 1000) r.over1s++;
      if (ms >= 1000) {
        slow.push({ at: new Date(a).toISOString(), route: key, ms, status: res.statusCode });
        slow.sort((x, y) => y.ms - x.ms);
        if (slow.length > keep) slow.length = keep;
      }
    };
    res.on('finish', finish);
    res.on('close', finish);
    next();
  }

  function state() {
    const top = Object.entries(routes).map(([route, r]) => ({ route, n: r.n, avgMs: Math.round(r.totalMs / r.n), maxMs: r.maxMs, over1s: r.over1s }))
      .sort((a, b) => b.maxMs - a.maxMs).slice(0, 25);
    const jobList = Object.entries(jobs).map(([name, j]) => ({ name, ...j })).sort((a, b) => b.maxMs - a.maxMs).slice(0, 40);
    return {
      uptimeS: Math.round((now() - t0) / 1000), boot: [...boot],
      stalls: { count: stalls.length, worstMs, recent: stalls.slice(-20).reverse() },
      requests: { inFlight: activeReqs.size, routes: top, slowest: slow.slice(0, 20) },
      jobs: { running: [...activeJobs.values()].map(j => ({ name: j.name, forMs: now() - j.at })), byMaxMs: jobList },
      memory: (() => { const m = process.memoryUsage(); return { rssMb: Math.round(m.rss / 1048576), heapMb: Math.round(m.heapUsed / 1048576) }; })(),
    };
  }

  function stop() { clearInterval(timer); timer = null; }

  return { mark, start, stop, job, middleware, state, t0 };
}

// A short-lived memo for expensive read-only answers (the results scoreboard):
// one build at a time per key, every caller in the window shares it.
function createMemo({ ttlMs = 30e3, now = () => Date.now(), max = 20 } = {}) {
  const hits = new Map();   // key → { at, value } | { promise }
  return async function memo(key, build) {
    const h = hits.get(key);
    if (h?.promise) return h.promise;
    if (h && now() - h.at < ttlMs) return h.value;
    const promise = Promise.resolve().then(build);
    hits.set(key, { promise });
    try {
      const value = await promise;
      hits.set(key, { at: now(), value });
      if (hits.size > max) hits.delete(hits.keys().next().value);
      return value;
    } catch (e) { hits.delete(key); throw e; }
  };
}

module.exports = { createOps, createMemo, STALL_MS };

// ─── CPU profile on demand ────────────────────────────────────────────────────
// GET /api/ops/profile?s=20 samples the CPU for s seconds (5 to 60, one at a
// time) and returns the functions with the most self time: name, file, line.
// That names whatever holds the event loop, which the stall log can only
// narrow to the jobs that were running.
function createProfiler({ inspector = require('inspector') } = {}) {
  let busy = false;
  async function profile(seconds = 20, top = 40) {
    if (busy) { const e = new Error('a profile is already running'); e.status = 409; throw e; }
    busy = true;
    const session = new inspector.Session();
    session.connect();
    const post = (m, p) => new Promise((res, rej) => session.post(m, p || {}, (e, r) => (e ? rej(e) : res(r))));
    try {
      await post('Profiler.enable');
      await post('Profiler.setSamplingInterval', { interval: 1000 });
      await post('Profiler.start');
      await new Promise(r => setTimeout(r, Math.min(60, Math.max(5, seconds)) * 1000));
      const { profile: p } = await post('Profiler.stop');
      return summarize(p, top);
    } finally { session.disconnect(); busy = false; }
  }
  return { profile, busy: () => busy };
}
// self time per function from a V8 cpu profile
function summarize(p, top = 40) {
  const dt = new Map();   // node id → ms of samples
  const ids = p.samples || [], deltas = p.timeDeltas || [];
  for (let i = 0; i < ids.length; i++) dt.set(ids[i], (dt.get(ids[i]) || 0) + (deltas[i] || 0) / 1000);
  const by = new Map();
  let total = 0, idle = 0;
  for (const n of p.nodes || []) {
    const ms = dt.get(n.id) || 0;
    if (!ms) continue;
    total += ms;
    const f = n.callFrame || {};
    if (f.functionName === '(idle)' || f.functionName === '(program)') { idle += f.functionName === '(idle)' ? ms : 0; }
    const file = String(f.url || '').split('/').pop() || '';
    const key = `${f.functionName || '(anonymous)'} ${file}:${(f.lineNumber ?? -1) + 1}`;
    by.set(key, (by.get(key) || 0) + ms);
  }
  const rows = [...by.entries()].sort((a, b) => b[1] - a[1]).slice(0, top).map(([fn, ms]) => ({ fn, ms: Math.round(ms), pct: total ? Math.round(1000 * ms / total) / 10 : 0 }));
  return { totalMs: Math.round(total), idleMs: Math.round(idle), busyPct: total ? Math.round(1000 * (total - idle) / total) / 10 : 0, top: rows, ...stacks(p, top) };
}

// Self time names the leaf (a regex, JSON.parse); the stalls need the caller.
// inclusive: ms each of our own functions (a .js file outside node's
// internals and node_modules) spent on the stack. bursts: the longest runs
// of back-to-back busy samples (each one holds the event loop for its whole
// length), with the functions of ours on the stack for most of each.
const IDLE = new Set(['(idle)', '(program)', '(garbage collector)', '(root)']);
const ownFile = url => /\.js$/.test(url || '') && !/node_modules|^node:/.test(url);
function stacks(p, top = 40) {
  const nodes = new Map((p.nodes || []).map(n => [n.id, n]));
  const parent = new Map();
  for (const n of nodes.values()) for (const c of n.children || []) parent.set(c, n.id);
  const keyOf = n => { const f = n.callFrame || {}; return `${f.functionName || '(anonymous)'} ${String(f.url || '').split('/').pop()}:${(f.lineNumber ?? -1) + 1}`; };
  const chainMemo = new Map();   // node id → our functions on its stack, once each
  const chain = id => {
    if (chainMemo.has(id)) return chainMemo.get(id);
    const out = new Set();
    for (let x = id; x != null; x = parent.get(x)) { const n = nodes.get(x); if (n && ownFile(n.callFrame?.url)) out.add(keyOf(n)); }
    chainMemo.set(id, out);
    return out;
  };
  const ids = p.samples || [], deltas = p.timeDeltas || [];
  const incl = new Map(), bursts = [];
  let cur = null;
  const close = () => { if (cur) bursts.push(cur); cur = null; };
  for (let i = 0; i < ids.length; i++) {
    const n = nodes.get(ids[i]);
    const ms = (deltas[i] || 0) / 1000;
    const name = n?.callFrame?.functionName;
    if (!n || name === '(idle)') { close(); continue; }
    if (!cur) cur = { ms: 0, fns: new Map() };
    cur.ms += ms;
    if (IDLE.has(name)) continue;
    for (const k of chain(ids[i])) { incl.set(k, (incl.get(k) || 0) + ms); cur.fns.set(k, (cur.fns.get(k) || 0) + ms); }
  }
  close();
  const list = (m, n) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([fn, ms]) => ({ fn, ms: Math.round(ms) }));
  return {
    inclusive: list(incl, top),
    bursts: bursts.sort((a, b) => b.ms - a.ms).slice(0, 8).map(b => ({ ms: Math.round(b.ms), fns: list(b.fns, 10) })),
  };
}

module.exports.createProfiler = createProfiler;
module.exports.summarize = summarize;
