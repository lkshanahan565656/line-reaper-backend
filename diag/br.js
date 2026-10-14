// Runs this branch's server on live feeds (PINNACLE=on) and snapshots every endpoint the esports views read.
const fs = require('fs'); const { spawn } = require('child_process');
const B = 'http://localhost:3999';
const wait = ms => new Promise(r => setTimeout(r, ms));
const get = async p => { try { const r = await fetch(B + p, { signal: AbortSignal.timeout(120000) }); return { st: r.status, tx: await r.text() }; } catch (e) { return { st: 'ERR', tx: JSON.stringify({ error: e.message }) }; } };
const EP = ['/api/status', '/api/esports/picks?minEV=-100', '/api/esports/matches', '/api/esports/auto-slips', '/api/esports/alerts?limit=30',
  '/api/tracker/summary?', '/api/tracker/picks?status=review&limit=100', '/api/tracker/picks?status=locked&limit=100',
  '/api/props/board?sport=ESPORTS&sort=ev&limit=150', '/api/props/record', '/api/results', '/api/best?limit=500'];
(async () => {
  fs.mkdirSync('out/snap', { recursive: true }); fs.mkdirSync('/tmp/lr', { recursive: true });
  const srv = spawn('node', ['server.js'], { env: { ...process.env, PORT: '3999', LR_DATA_DIR: '/tmp/lr', PINNACLE: 'on' }, stdio: ['ignore', fs.openSync('out/server.log', 'w'), fs.openSync('out/server.err', 'w')] });
  const rows = [];
  for (let i = 0; i < 22; i++) {
    await wait(60e3);
    const [pk, mt] = await Promise.all([get('/api/esports/picks?minEV=-100'), get('/api/esports/matches')]);
    let P = [], M = [];
    try { P = JSON.parse(pk.tx).picks || []; } catch {}
    try { M = JSON.parse(mt.tx).matches || []; } catch {}
    const now = Date.now();
    rows.push({ at: new Date().toISOString(), picks: P.length, started: P.filter(p => Date.parse(p.startTime) <= now).length, matches: M.length,
      liveOld: M.filter(m => m.live && now - Date.parse(m.start) > 8 * 3600e3).map(m => m.id), sigs: P.map(p => [p.player, p.market, p.side, p.bestBook].join('|')) });
  }
  const index = {};
  for (const p of EP) { const r = await get(p); const f = p.replace(/[^a-z0-9]+/gi, '_') + '.json'; fs.writeFileSync('out/snap/' + f, r.tx); index[p] = { st: r.st, f, bytes: r.tx.length }; }
  fs.writeFileSync('out/snap/index.json', JSON.stringify(index, null, 1));
  fs.writeFileSync('out/rows.json', JSON.stringify(rows));
  srv.kill();
})();
