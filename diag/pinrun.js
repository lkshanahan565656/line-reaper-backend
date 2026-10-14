// Waits for prod to serve 3.113.0, then saves /api/esports/pingaps and status.
const fs = require('fs'); const P = 'https://line-reaper-backend-production.up.railway.app';
const wait = ms => new Promise(r => setTimeout(r, ms));
const get = async p => { try { return await (await fetch(P + p, { signal: AbortSignal.timeout(90000) })).text(); } catch (e) { return JSON.stringify({ error: e.message }); } };
(async () => {
  fs.mkdirSync('out', { recursive: true });
  for (let i = 0; i < 40; i++) { const s = await get('/api/status'); if (s.includes('3.113.0')) break; await wait(30e3); }
  await wait(10 * 60e3);
  for (const p of ['/api/status', '/api/esports/pingaps']) fs.writeFileSync(`out/prod_${p.replace(/[^a-z0-9]+/gi, '_')}.json`, await get(p));
})();
