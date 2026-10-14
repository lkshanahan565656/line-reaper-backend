const fs = require('fs');
const B = 'https://line-reaper-backend-production.up.railway.app';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const get = async p => { try { const r = await fetch(B + p); return { status: r.status, body: await r.text() }; } catch (e) { return { status: 0, body: e.message }; } };
(async () => {
  fs.mkdirSync('out/snap', { recursive: true });
  const log = [];
  for (let i = 0; i < 80; i++) {
    const s = await get('/api/status');
    let v = null, rm = null; try { const j = JSON.parse(s.body); v = j.version; rm = j.esports?.roundModel ?? j.roundModel ?? null; } catch {}
    log.push({ t: new Date().toISOString(), v, rm });
    fs.writeFileSync('out/log.json', JSON.stringify(log, null, 1));
    if (v === '3.122.0' && rm && rm.priced > 0 && i > 0) break;
    await sleep(30000);
  }
  await sleep(120000);
  for (const [n, p] of [['rounds', '/api/esports/rounds'], ['status', '/api/status'], ['ev', '/api/ev?limit=1000']]) { const r = await get(p); fs.writeFileSync(`out/snap/${n}.json`, r.body); }
})();
