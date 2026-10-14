// Runs this branch's server on live feeds with PINNACLE=on, then saves the board, picks, best plays.
const fs = require('fs'); const { spawn } = require('child_process');
const B = 'http://localhost:3999';
const wait = ms => new Promise(r => setTimeout(r, ms));
const get = async p => { try { const r = await fetch(p.startsWith('http') ? p : B + p, { signal: AbortSignal.timeout(90000) }); return await r.text(); } catch (e) { return JSON.stringify({ error: e.message }); } };
(async () => {
  fs.mkdirSync('out', { recursive: true }); fs.mkdirSync('/tmp/lr', { recursive: true });
  const srv = spawn('node', ['server.js'], { env: { ...process.env, PORT: '3999', LR_DATA_DIR: '/tmp/lr', TRACK_MIN_EV: '-100', PINNACLE: 'on' }, stdio: ['ignore', fs.openSync('out/server.log', 'w'), fs.openSync('out/server.err', 'w')] });
  const PROD = 'https://line-reaper-backend-production.up.railway.app';
  fs.writeFileSync('out/prod_results.json', await get(PROD + '/api/results'));
  fs.writeFileSync('out/prod_status.json', await get(PROD + '/api/status'));
  const snap = async tag => {
    for (const p of ['/api/esports/matches', '/api/esports/picks?minEV=-100', '/api/best', '/api/tracker/summary', '/api/status', '/api/esports/match-odds']) fs.writeFileSync(`out/${tag}_${p.replace(/[^a-z0-9]+/gi, '_')}.json`, await get(p));
  };
  await wait(7 * 60e3); await snap('a');
  await wait(4 * 60e3); await snap('b');
  srv.kill();
})();
