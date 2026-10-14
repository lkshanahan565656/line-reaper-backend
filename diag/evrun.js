// This branch's server on live feeds with PINNACLE=on: the free books, the +EV board and its tracker.
const fs = require('fs'); const { spawn } = require('child_process');
const B = 'http://localhost:3999';
const wait = ms => new Promise(r => setTimeout(r, ms));
const get = async p => { try { const r = await fetch(B + p, { signal: AbortSignal.timeout(60000) }); return await r.text(); } catch (e) { return JSON.stringify({ error: e.message }); } };
(async () => {
  fs.mkdirSync('/tmp/lr', { recursive: true });
  const srv = spawn('node', ['../server.js'], { env: { ...process.env, PORT: '3999', LR_DATA_DIR: '/tmp/lr', PINNACLE: 'on', EV_TRACK_FILE: '/tmp/lr/ev-bets.json' }, stdio: ['ignore', fs.openSync('server.log', 'w'), fs.openSync('server.err', 'w')] });
  const snap = async tag => {
    for (const p of ['/api/status', '/api/ev?minEv=-100&limit=1000', '/api/ev', '/api/ev/record', '/api/ev/bets?limit=500', '/api/bestplays', '/api/exchanges'])
      fs.writeFileSync(`${tag}_${p.replace(/[^a-z0-9]+/gi, '_')}.json`, await get(p));
  };
  for (const [i, m] of [[1, 4], [2, 4], [3, 4]]) { await wait(m * 60e3); await snap(`s${i}`); }
  srv.kill();
})();
