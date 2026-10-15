// run the PR branch server against live data and log its esports STALE rows
const fs = require('fs'); const { spawn } = require('child_process');
fs.mkdirSync('out/snap', { recursive: true });
const env = { ...process.env, PORT: '3999', PINNACLE: 'on', LR_DATA_DIR: '/tmp/lrdata' };
const srv = spawn('node', ['server.js'], { cwd: 'app', env, stdio: ['ignore', fs.openSync('out/server.log', 'w'), fs.openSync('out/server.err', 'w')] });
const get = async p => { try { const r = await fetch('http://localhost:3999' + p); return { status: r.status, body: await r.text() }; } catch (e) { return { status: 0, body: e.message }; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const mins = +(process.env.MINS || 50);
  const log = []; const seen = {};
  for (let i = 0; i < mins * 2; i++) {
    await sleep(30000);
    const r = await get('/api/ev?minEv=-100');
    try {
      const x = JSON.parse(r.body);
      for (const row of x.esStale || []) { const k = `${row.key}|${row.app}|${row.moveAt}`; if (!seen[k]) seen[k] = { first: new Date().toISOString(), row }; seen[k].last = new Date().toISOString(); seen[k].lastEv = row.ev; }
      const st = JSON.parse((await get('/api/status')).body);
      log.push({ t: new Date().toISOString(), rows: (x.esStale || []).length, clear: (x.esStale || []).filter(z => z.clears).length, lag: x.esStaleLag, status: st.ev?.esStale && { ...st.ev.esStale, lag: undefined } });
    } catch (e) { log.push({ t: new Date().toISOString(), status: r.status, err: e.message }); }
    fs.writeFileSync('out/log.json', JSON.stringify(log, null, 1));
    fs.writeFileSync('out/rows-seen.json', JSON.stringify(seen, null, 1));
    if (i % 10 === 9) for (const [n, p] of [['ev', '/api/ev?minEv=-100'], ['ev-default', '/api/ev'], ['record', '/api/ev/record'], ['status', '/api/status']]) { const r = await get(p); fs.writeFileSync(`out/snap/${n}.json`, r.body); }
  }
  for (const [n, p] of [['ev', '/api/ev?minEv=-100'], ['ev-default', '/api/ev'], ['record', '/api/ev/record'], ['status', '/api/status'], ['picks', '/api/esports/picks']]) { const r = await get(p); fs.writeFileSync(`out/snap/${n}.json`, r.body); }
  srv.kill(); process.exit(0);
})();
