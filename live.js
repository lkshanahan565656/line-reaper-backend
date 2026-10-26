// After the deploy: wait for v3.170.0, then read /api/props/mlb and the record kinds.
const fs = require('fs');
const U = 'https://line-reaper-backend-production.up.railway.app';
const j = async u => { try { const r = await fetch(u); return r.ok ? await r.json() : { _err: r.status }; } catch (e) { return { _err: e.message }; } };
(async () => {
  fs.mkdirSync('out', { recursive: true });
  const log = [];
  for (let i = 0; i < 80; i++) { const s = await j(U + '/api/status'); log.push(`${new Date().toISOString()} ${s.version || s._err}`); if (s.version) break; await new Promise(r => setTimeout(r, 30000)); }
  
  fs.writeFileSync('out/versions.txt', log.join('\n'));
  fs.writeFileSync('out/mlb.json', JSON.stringify(await j(U + '/api/props/mlb')));
  fs.writeFileSync('out/record.json', JSON.stringify(await j(U + '/api/props/record')));
  const picks = []; for (const k of ['mlb-pin','p6-mlb-pin','ud-mlb-pin','sl-mlb-pin','mlb-even','p6-mlb-even','ud-mlb-even','sl-mlb-even']) { const r = await j(`${U}/api/props/record/picks?status=open&kind=${k}&limit=1000`); picks.push(...(r.picks || [])); const g = await j(`${U}/api/props/record/picks?status=graded&kind=${k}&limit=1000`); picks.push(...(g.picks || [])); }
  fs.writeFileSync('out/mlb-picks.json', JSON.stringify(picks));
  fs.writeFileSync('out/status.json', JSON.stringify(await j(U + '/api/status')));
})();
