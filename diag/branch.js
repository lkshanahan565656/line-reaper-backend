// run the PR branch server, let it fill, snapshot the kill-share numbers and the PROPS board
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
    const s = await get('/api/status');
    try { const j = JSON.parse(s.body); const rr = await get('/api/esports/rounds'); let rounds = rr.status; try { const x = JSON.parse(rr.body); rounds = { now: x.now && { ...x.now, fits: undefined }, books: x.books, priced: x.priced?.length ?? x.priced }; } catch {} log.push({ t: new Date().toISOString(), rounds, warmer: j.esports?.warmer ?? null }); } catch { log.push({ t: new Date().toISOString(), status: s.status }); }
    fs.writeFileSync('out/status-log.json', JSON.stringify(log, null, 1));
  }
  const snaps = [['rounds', '/api/esports/rounds'], ['share', '/api/esports/share'], ['esbooks', '/api/ev?kind=esports&limit=1000'], ['status', '/api/status'], ['picks', '/api/esports/picks'], ['pingaps', '/api/esports/pingaps'],
    ['board-pp', '/api/props/board?book=prizepicks&facets=1&sport=ESPORTS&limit=500'], ['board-ud', '/api/props/board?book=underdog&facets=1&sport=ESPORTS&limit=500'],
    ['board-sl', '/api/props/board?book=sleeper&facets=1&sport=ESPORTS&limit=500'], ['board', '/api/props/board?limit=300&sport=ESPORTS'], ['ev', '/api/ev?limit=1000'], ['ev-record', '/api/ev/record']];
  for (const [n, p] of snaps) { const r = await get(p); fs.writeFileSync(`out/snap/${n}.json`, r.body); }
  srv.kill(); process.exit(0);
})();
// run 22:49
