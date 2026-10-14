// Waits for prod to report 3.119.0, then reads book arbs for 8 minutes
const fs = require('fs');
const P = 'https://line-reaper-backend-production.up.railway.app';
const wait = ms => new Promise(r => setTimeout(r, ms));
const J = async u => { try { const r = await fetch(u, { signal: AbortSignal.timeout(60000) }); return await r.json(); } catch (e) { return { error: e.message }; } };
(async () => {
  fs.mkdirSync('out', { recursive: true });
  const log = [];
  for (let i = 0; i < 40; i++) { const s = await J(P + '/api/status'); if (s.version === '3.119.0') break; log.push({ at: new Date().toISOString(), v: s.version }); await wait(30e3); }
  for (let i = 0; i < 10; i++) {
    await wait(60e3);
    const s = await J(P + '/api/status'), x = await J(P + '/api/xarbs');
    log.push({ at: new Date().toISOString(), v: s.version, book: s.bookArbs, job: s.tail?.jobs?.bookArbs, rec: x.books?.record, n: [x.books?.arbCount, x.books?.middleCount] });
    fs.writeFileSync('out/prod.json', JSON.stringify(log, null, 1));
    if (i === 9) fs.writeFileSync('out/prod-xarbs.json', JSON.stringify(x.books || x, null, 1));
  }
})();
