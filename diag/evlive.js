// Live check after deploy: wait for the new version on prod, then read every view twice.
const fs = require('fs');
const P = 'https://line-reaper-backend-production.up.railway.app';
const wait = ms => new Promise(r => setTimeout(r, ms));
const get = async u => { try { const r = await fetch(u, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(180000) }); return await r.json(); } catch (e) { return { error: e.message }; } };
const VIEWS = { ev: '/api/ev?limit=1000', best: '/api/best?limit=500', status: '/api/status', record: '/api/props/record' };
async function board() { const rows = []; for (let off = 0; off < 60000; off += 500) { const d = await get(`${P}/api/props/board?sport=ALL&sort=start&limit=500&offset=${off}`); rows.push(...(d.rows || [])); if (!d.rows || d.rows.length < 500) break; } return { rows }; }
(async () => {
  fs.mkdirSync('out', { recursive: true });
  for (let i = 0; i < 40; i++) { const s = await get(P + '/api/status'); console.log(new Date().toISOString(), s.version); if (s.version === process.env.WANT) break; await wait(30000); }
  await wait(4 * 60e3);
  for (let i = 0; i < 2; i++) {
    const o = { at: new Date().toISOString() };
    for (const [k, p] of Object.entries(VIEWS)) o[k] = await get(P + p);
    o.board = await board();
    fs.writeFileSync(`out/live${i}.json`, JSON.stringify(o));
    await wait(2 * 60e3);
  }
})();
