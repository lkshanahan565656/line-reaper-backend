// Production after the PR 178 merge: wait for v3.140.0, then read the stacks endpoint.
const fs = require('fs');
const P = 'https://line-reaper-backend-production.up.railway.app';
const wait = ms => new Promise(r => setTimeout(r, ms));
const get = async p => { try { const r = await fetch(P + p, { signal: AbortSignal.timeout(120000) }); return await r.text(); } catch (e) { return JSON.stringify({ error: e.message }); } };
(async () => {
  fs.mkdirSync('out', { recursive: true });
  let st = {};
  for (let i = 0; i < 40; i++) { try { st = JSON.parse(await get('/api/status')); } catch {} if (st.version === '3.140.0') break; await wait(30e3); }
  fs.writeFileSync('out/status.json', JSON.stringify(st));
  await wait(60e3);
  fs.writeFileSync('out/auto_slips.json', await get('/api/esports/auto-slips'));
})();
