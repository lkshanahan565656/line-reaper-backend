// run the PR branch server, let it fill, snapshot what the +EV tab reads
const fs = require('fs'); const { spawn } = require('child_process');
fs.mkdirSync('out/snap', { recursive: true });
const env = { ...process.env, PORT: '3999', PINNACLE: 'on', LR_DATA_DIR: '/tmp/lrdata' };
const srv = spawn('node', ['server.js'], { cwd: 'app', env, stdio: ['ignore', fs.openSync('out/server.log', 'w'), fs.openSync('out/server.err', 'w')] });
const get = async p => { try { const r = await fetch('http://localhost:3999' + p); return { status: r.status, body: await r.text() }; } catch (e) { return { status: 0, body: e.message }; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const mins = +(process.env.MINS || 14);
  const log = [];
  for (let i = 0; i < mins * 2; i++) {
    await sleep(30000);
    const s = await get('/api/status');
    try { const j = JSON.parse(s.body); log.push({ t: new Date().toISOString(), es: j.ev?.esports, board: j.esportsBoard?.counts }); } catch { log.push({ t: new Date().toISOString(), status: s.status }); }
    fs.writeFileSync('out/status-log.json', JSON.stringify(log, null, 1));
  }
  for (const [n, p] of [['ev', '/api/ev?limit=1000'], ['ev-record', '/api/ev/record'], ['ev-record-bets', '/api/ev/record/bets?limit=50'], ['status', '/api/status'], ['es-bets', '/api/ev/record/bets?es=1&status=open&limit=500']]) {
    const r = await get(p); fs.writeFileSync(`out/snap/${n}.json`, r.body);
  }
  srv.kill(); process.exit(0);
})();
