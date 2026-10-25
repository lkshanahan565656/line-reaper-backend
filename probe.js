// times the live site's pages every few seconds; writes probe.json
const BASE = 'https://line-reaper-backend-production.up.railway.app';
const fs = require('fs');
const MIN = +(process.env.MINUTES || 6), WAIT = process.env.WAIT_VERSION || '';
const paths = ['/api/status', '/calc.js', '/app', '/api/health'];
const out = { start: new Date().toISOString(), samples: [], statuses: [] };
async function timed(p) {
  const t0 = Date.now();
  try { const r = await fetch(BASE + p + (p.includes('?') ? '&' : '?') + 't=' + t0, { signal: AbortSignal.timeout(60000) }); const body = await r.text(); return { p, code: r.status, ms: Date.now() - t0, bytes: body.length, body }; }
  catch (e) { return { p, code: 0, ms: Date.now() - t0, err: e.message }; }
}
(async () => {
  const end = Date.now() + MIN * 60e3;
  let lastVer = null;
  while (Date.now() < end) {
    const at = new Date().toISOString();
    const rs = await Promise.all(paths.map(timed));
    const st = rs[0];
    let ver = null, loop = null, uptime = null;
    try { const j = JSON.parse(st.body); ver = j.version; loop = j.eventLoop; uptime = j.uptime; if (ver !== lastVer || out.statuses.length < 1) { out.statuses.push({ at, j }); lastVer = ver; } } catch {}
    out.samples.push({ at, ver, loop, r: rs.map(r => ({ p: r.p, code: r.code, ms: r.ms, bytes: r.bytes, err: r.err })) });
    console.log(at, ver, rs.map(r => `${r.p} ${r.code} ${r.ms}ms`).join(' | '));
    fs.writeFileSync('probe.json', JSON.stringify(out, null, 1));
    if (WAIT && ver === WAIT && out.samples.filter(s => s.ver === WAIT).length > +(process.env.AFTER || 60)) break;
    await new Promise(r => setTimeout(r, 5000));
  }
  try { const j = await timed('/api/status'); out.final = JSON.parse(j.body); } catch {}
  fs.writeFileSync('probe.json', JSON.stringify(out, null, 1));
})();
