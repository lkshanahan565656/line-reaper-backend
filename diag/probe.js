const fs = require('fs');
const B = 'https://line-reaper-backend-production.up.railway.app';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const get = async p => { try { const r = await fetch(B + p); return await r.text(); } catch (e) { return JSON.stringify({ err: e.message }); } };
fs.mkdirSync('out', { recursive: true });
(async () => {
  const log = [];
  for (let i = 0; i < 70; i++) {
    let v = null; try { v = JSON.parse(await get('/api/status')).version; } catch {}
    log.push([new Date().toISOString(), v]); fs.writeFileSync('out/log.json', JSON.stringify(log));
    if (v === '3.123.0') break;
    await sleep(30000);
  }
  // let a Pinnacle read (every 2 min) and a tracker sweep (every 5 min) run
  await sleep(11 * 60e3);
  for (const [n, p] of [['pintotals', '/api/esports/pintotals?limit=50'], ['pingaps', '/api/esports/pingaps?limit=1'], ['status', '/api/status'], ['val', '/api/tracker/picks?sport=VAL&limit=1000'], ['rounds', '/api/esports/rounds?limit=50'], ['share', '/api/esports/share?limit=50']]) fs.writeFileSync(`out/${n}.json`, await get(p));
})();
