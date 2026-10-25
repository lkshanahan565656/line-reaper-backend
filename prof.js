const BASE = 'https://line-reaper-backend-production.up.railway.app';
const fs = require('fs');
const WAIT = process.env.WAIT_VERSION;
const get = async (p, ms = 90000) => { const t0 = Date.now(); try { const r = await fetch(BASE + p, { signal: AbortSignal.timeout(ms) }); return { code: r.status, ms: Date.now() - t0, j: await r.json().catch(() => null) }; } catch (e) { return { code: 0, ms: Date.now() - t0, err: e.message }; } };
(async () => {
  const out = { profiles: [] };
  const end = Date.now() + 25 * 60e3;
  while (Date.now() < end) { const h = await get('/api/health', 20000); if (h.j?.version === WAIT) { out.health = h.j; break; } await new Promise(r => setTimeout(r, 10000)); }
  await new Promise(r => setTimeout(r, 480000));
  for (let i = 0; i < 5; i++) {
    const p = await get('/api/ops/profile?s=50');
    const o = await get('/api/ops'); const st = await get('/api/status');
    out.profiles.push({ at: new Date().toISOString(), profile: p.j || p, ops: o.j || o, build: { props: st.j?.propsBoardBuild, ev: st.j?.evScreenBuild } });
    console.log(i, JSON.stringify(p.j?.top?.slice(0, 8)));
    fs.writeFileSync('probe.json', JSON.stringify(out));
  }
})();
