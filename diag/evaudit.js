// Freeze one moment: this repo's server (main) runs on Actions with every raw
// venue response kept (diag/rec.js); at the snapshot both it and prod are asked
// for every view, then the raw responses are dumped. Twice, SNAPGAP min apart.
const fs = require('fs'); const { spawn, execSync } = require('child_process');
const B = 'http://localhost:3999', P = 'https://line-reaper-backend-production.up.railway.app';
const wait = ms => new Promise(r => setTimeout(r, ms));
const get = async u => { const t = Date.now(); try { const r = await fetch(u, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(180000) }); const txt = await r.text(); try { return { _ms: Date.now() - t, ...JSON.parse(txt) }; } catch { return { error: r.status, body: txt.slice(0, 300) }; } } catch (e) { return { error: e.message }; } };
const VIEWS = { ev: '/api/ev?limit=1000', xarbs: '/api/xarbs', best: '/api/best?limit=500', espicks: '/api/esports/picks', autoslips: '/api/esports/auto-slips',
  coverage: '/api/props/coverage', status: '/api/status', h2h: '/api/esports/h2h', share: '/api/esports/share', rounds: '/api/esports/rounds', pintotals: '/api/esports/pintotals', pingaps: '/api/esports/pingaps',
  pp: '/api/prizepicks', ud: '/api/underdog', sl: '/api/sleeper', matches: '/api/esports/matches', exchanges: '/api/exchanges', scoreboard: '/api/ev/scoreboard' };
for (const b of ['prizepicks', 'underdog', 'sleeper', 'pick6']) VIEWS['lines_' + b] = `/api/props/board?sport=ALL&book=${b}&facets=1&limit=1`;
async function board(base) { const rows = []; let total = 0; for (let off = 0; off < 60000; off += 500) { const d = await get(`${base}/api/props/board?sport=ALL&sort=start&limit=500&offset=${off}`); rows.push(...(d.rows || [])); total = d.total; if (!d.rows || d.rows.length < 500) break; } return { rows, total }; }
async function views(base) { const o = { at: new Date().toISOString() }; await Promise.all(Object.entries(VIEWS).map(async ([k, p]) => { o[k] = await get(base + p); })); o.board = await board(base); o.end = new Date().toISOString(); return o; }
(async () => {
  fs.mkdirSync('out', { recursive: true }); fs.mkdirSync('/tmp/lr', { recursive: true });
  const srv = spawn('node', ['-r', './diag/rec.js', 'server.js'], { env: { ...process.env, PORT: '3999', LR_DATA_DIR: '/tmp/lr', PINNACLE: 'on' }, stdio: ['ignore', fs.openSync('out/server.log', 'w'), fs.openSync('out/server.err', 'w')] });
  await wait(+(process.env.WARM || 18) * 60e3);
  for (let i = 0; i < +(process.env.SNAPS || 2); i++) {
    const t = new Date().toISOString();
    const [prod, local] = await Promise.all([views(P), views(B)]);
    srv.kill('SIGUSR2'); await wait(15000);
    if (fs.existsSync('out/raw')) fs.renameSync('out/raw', `out/raw${i}`);
    fs.writeFileSync(`out/prod${i}.json`, JSON.stringify(prod)); fs.writeFileSync(`out/local${i}.json`, JSON.stringify(local));
    console.log(`snap ${i} at ${t}: prod ev ${prod.ev?.rows?.length} board ${prod.board.rows.length}; local ev ${local.ev?.rows?.length} board ${local.board.rows.length}`);
    if (i < +(process.env.SNAPS || 2) - 1) await wait(+(process.env.SNAPGAP || 4) * 60e3);
  }
  srv.kill(); process.exit(0);
})();
