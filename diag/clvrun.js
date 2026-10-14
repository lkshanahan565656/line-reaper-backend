// Runs this branch's server on live feeds, lets the board refresh a few times,
// and saves what the tracker recorded (market CLV) plus the board.
const fs = require('fs'); const { spawn } = require('child_process');
const B = 'http://localhost:3999';
const wait = ms => new Promise(r => setTimeout(r, ms));
const get = async p => { try { const r = await fetch(B + p, { signal: AbortSignal.timeout(60000) }); return await r.text(); } catch (e) { return JSON.stringify({ error: e.message }); } };
(async () => {
  fs.mkdirSync('out', { recursive: true });
  const srv = spawn('node', ['server.js'], { env: { ...process.env, PORT: '3999', LR_DATA_DIR: '/tmp/lr', TRACK_MIN_EV: '-100' }, stdio: ['ignore', fs.openSync('out/server.log', 'w'), fs.openSync('out/server.err', 'w')] });
  fs.mkdirSync('/tmp/lr', { recursive: true });
  const t0 = Date.now();
  const snap = async tag => {
    for (const p of ['/api/tracker/picks?status=open&limit=2000', '/api/tracker/summary', '/api/esports/picks?minEV=-100', '/api/status']) fs.writeFileSync(`out/${tag}_${p.replace(/[^a-z0-9]+/gi, '_')}.json`, await get(p));
  };
  await wait(5 * 60e3); await snap('a'); fs.writeFileSync('out/took.txt', 'a'); srv.kill(); return;
  await wait(6 * 60e3); await snap('b');
  fs.writeFileSync('out/took.txt', String((Date.now() - t0) / 1000));
  srv.kill();
})();
