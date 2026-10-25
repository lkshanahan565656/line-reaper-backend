// After the deploy: wait for v3.170.0, then read /api/props/mlb and the record kinds.
const fs = require('fs');
const U = 'https://line-reaper-backend-production.up.railway.app';
const j = async u => { try { const r = await fetch(u); return r.ok ? await r.json() : { _err: r.status }; } catch (e) { return { _err: e.message }; } };
(async () => {
  fs.mkdirSync('out', { recursive: true });
  const log = [];
  for (let i = 0; i < 80; i++) { const s = await j(U + '/api/status'); log.push(`${new Date().toISOString()} ${s.version || s._err}`); if (s.version === '3.170.0') break; await new Promise(r => setTimeout(r, 30000)); }
  await new Promise(r => setTimeout(r, 240000));
  fs.writeFileSync('out/versions.txt', log.join('\n'));
  fs.writeFileSync('out/mlb.json', JSON.stringify(await j(U + '/api/props/mlb')));
  fs.writeFileSync('out/record.json', JSON.stringify(await j(U + '/api/props/record')));
  fs.writeFileSync('out/status.json', JSON.stringify(await j(U + '/api/status')));
})();
