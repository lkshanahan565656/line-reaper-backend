// run the PR branch server, let it fill, snapshot Best Slips, the picks and the Lines boards
const fs = require('fs'); const { spawn } = require('child_process');
fs.mkdirSync('out/snap', { recursive: true });
const env = { ...process.env, PORT: '3999', PINNACLE: 'on', LR_DATA_DIR: '/tmp/lrdata' };
const srv = spawn('node', ['server.js'], { cwd: 'app', env, stdio: ['ignore', fs.openSync('out/server.log', 'w'), fs.openSync('out/server.err', 'w')] });
const get = async (p, opt) => { try { const r = await fetch('http://localhost:3999' + p, opt); return { status: r.status, body: await r.text() }; } catch (e) { return { status: 0, body: e.message }; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const mins = +(process.env.MINS || 16);
  const log = [];
  for (let i = 0; i < mins * 2; i++) {
    await sleep(30000);
    const r = await get('/api/esports/h2h');
    try { const x = JSON.parse(r.body); log.push({ t: new Date().toISOString(), priced: x.priced?.length ?? x.priced }); } catch { log.push({ t: new Date().toISOString(), status: r.status }); }
    fs.writeFileSync('out/status-log.json', JSON.stringify(log, null, 1));
  }
  const snaps = [['auto', '/api/esports/auto-slips'], ['h2h', '/api/esports/h2h'], ['status', '/api/status'], ['picks', '/api/esports/picks'],
    ['board-pp', '/api/props/board?book=prizepicks&facets=1&limit=500'], ['board-ud', '/api/props/board?book=underdog&facets=1&limit=500'],
    ['board-sl', '/api/props/board?book=sleeper&facets=1&limit=500']];
  for (const [n, p] of snaps) { const r = await get(p); fs.writeFileSync(`out/snap/${n}.json`, r.body); }
  // the slip bar's call: two model-priced legs on the side the Lines table leans, and the opposite side
  try {
    const picks = JSON.parse(fs.readFileSync('out/snap/picks.json')).picks.filter(p => p.pricing?.lines && Object.keys(p.pricing.lines.books).length);
    const two = picks.slice(0, 2);
    const out = {};
    for (const flip of [false, true]) {
      const legs = two.map(p => { const b = Object.values(p.pricing.lines.books)[0]; const s = flip ? (b.side === 'OVER' ? 'UNDER' : 'OVER') : b.side; return { player: p.player, market: p.market, side: s }; });
      const r = await get('/api/esports/slip', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ legs }) });
      out[flip ? 'flipped' : 'lean'] = { legs, status: r.status, body: JSON.parse(r.body) };
    }
    fs.writeFileSync('out/snap/slip-post.json', JSON.stringify(out, null, 1));
  } catch (e) { fs.writeFileSync('out/snap/slip-post.json', JSON.stringify({ error: e.message })); }
  srv.kill(); process.exit(0);
})();
