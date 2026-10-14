// Capture full pick objects for picks whose side flips between polls (prod), 25 polls a minute apart.
const fs = require('fs'); const P = 'https://line-reaper-backend-production.up.railway.app';
const wait = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  fs.mkdirSync('out', { recursive: true });
  let prev = new Map(); const caught = [];
  for (let i = 0; i < 25; i++) {
    let j = null; try { j = await (await fetch(P + '/api/esports/picks', { signal: AbortSignal.timeout(90000) })).json(); } catch {}
    const cur = new Map((j?.picks || []).map(p => [`${p.sport}|${p.player}|${p.market}`, p]));
    for (const [k, p] of cur) { const q = prev.get(k); if (q && q.side !== p.side && caught.length < 60) caught.push({ at: new Date().toISOString(), updated: j.updated, before: q, after: p }); }
    prev = cur; fs.writeFileSync('out/flips.json', JSON.stringify(caught));
    await wait(60e3);
  }
})();
