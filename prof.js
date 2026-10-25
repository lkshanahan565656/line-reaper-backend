// Pause count without the profiler running (the profiler's own stop costs ~1.2 s),
// then two profiles for attribution.
const BASE = 'https://line-reaper-backend-production.up.railway.app';
const fs = require('fs');
const WAIT = process.env.WAIT_VERSION, SETTLE = Number(process.env.SETTLE_S || 480);
const get = async (p, ms = 90000) => { const t0 = Date.now(); try { const r = await fetch(BASE + p, { signal: AbortSignal.timeout(ms) }); return { code: r.status, ms: Date.now() - t0, j: await r.json().catch(() => null) }; } catch (e) { return { code: 0, ms: Date.now() - t0, err: e.message }; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const save = out => fs.writeFileSync('probe.json', JSON.stringify(out));
(async () => {
  const out = { windows: [], profiles: [] };
  const end = Date.now() + 25 * 60e3;
  while (Date.now() < end) { const h = await get('/api/health', 20000); if (h.j?.version === WAIT) { out.health = h.j; break; } await sleep(10000); }
  await sleep(SETTLE * 1000);
  // two quiet 4-minute windows: every stall the server logged in between
  for (let w = 0; w < 2; w++) {
    const a = await get('/api/ops'); const t0 = new Date().toISOString();
    // pings every 2 s: how long a tiny request waits
    const pings = [];
    const stop = Date.now() + 240e3;
    while (Date.now() < stop) { const h = await get('/api/health', 20000); pings.push(h.ms); await sleep(2000); }
    const b = await get('/api/ops'); const st = await get('/api/status');
    const recent = (b.j?.stalls?.recent || []).filter(s => s.at > t0);
    out.windows.push({ from: t0, to: new Date().toISOString(), stallsBefore: a.j?.stalls?.count, stallsAfter: b.j?.stalls?.count, recent, loop: b.j?.loop || null, pings,
      xarb: st.j?.xarb?.counts?.matchStats || st.j?.exchangeArbs?.counts?.matchStats || null, tail: st.j?.tail?.scoreStats || null, ops: b.j });
    save(out);
    console.log('window', w, recent.length, 'stalls', JSON.stringify(recent.map(s => s.ms)), 'ping max', Math.max(...pings));
  }
  for (let i = 0; i < 2; i++) {
    const p = await get('/api/ops/profile?s=50');
    out.profiles.push({ at: new Date().toISOString(), profile: p.j || p });
    save(out);
  }
})();
