// run the PR branch server, let it fill, snapshot the h2h numbers and the PROPS board
const fs = require('fs'); const { spawn } = require('child_process');
fs.mkdirSync('out/snap', { recursive: true });
const env = { ...process.env, PORT: '3999', PINNACLE: 'on', LR_DATA_DIR: '/tmp/lrdata' };
const srv = spawn('node', ['server.js'], { cwd: 'app', env, stdio: ['ignore', fs.openSync('out/server.log', 'w'), fs.openSync('out/server.err', 'w')] });
const get = async p => { try { const r = await fetch('http://localhost:3999' + p); return { status: r.status, body: await r.text() }; } catch (e) { return { status: 0, body: e.message }; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const mins = +(process.env.MINS || 20);
  const log = [];
  for (let i = 0; i < mins * 2; i++) {
    await sleep(30000);
    const r = await get('/api/esports/h2h');
    try { const x = JSON.parse(r.body); log.push({ t: new Date().toISOString(), now: x.now, data: x.data, priced: x.priced?.length ?? x.priced }); } catch { log.push({ t: new Date().toISOString(), status: r.status }); }
    fs.writeFileSync('out/status-log.json', JSON.stringify(log, null, 1));
  }
  const snaps = [['h2h', '/api/esports/h2h'], ['share', '/api/esports/share'], ['status', '/api/status'], ['picks', '/api/esports/picks'],
    ['board-pp', '/api/props/board?book=prizepicks&facets=1&sport=ESPORTS&limit=500'], ['board-ud', '/api/props/board?book=underdog&facets=1&sport=ESPORTS&limit=500'],
    ['board-sl', '/api/props/board?book=sleeper&facets=1&sport=ESPORTS&limit=500'], ['board', '/api/props/board?limit=300&sport=ESPORTS'],
    ['board-pp-150', '/api/props/board?book=prizepicks&facets=1&sport=ESPORTS&limit=150&sort=ev'], ['board-ud-150', '/api/props/board?book=underdog&facets=1&sport=ESPORTS&limit=150&sort=ev']];
  for (const [n, p] of snaps) { const r = await get(p); fs.writeFileSync(`out/snap/${n}.json`, r.body); }
  srv.kill(); process.exit(0);
})();
