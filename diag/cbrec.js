// Raw combo recorder: the branch server on live feeds, every combo row with each book's quote, Pinnacle's parts and the app cells, every 10 min
const fs = require('fs'); const { spawn, execSync } = require('child_process');
const B = 'http://localhost:3999';
const wait = ms => new Promise(r => setTimeout(r, ms));
const get = async u => { try { const r = await fetch(u, { signal: AbortSignal.timeout(180000) }); return r.ok ? await r.json() : { error: r.status }; } catch (e) { return { error: e.message }; } };
(async () => {
  fs.mkdirSync('out/h', { recursive: true }); fs.mkdirSync('/tmp/lr', { recursive: true });
  spawn('node', ['server.js'], { env: { ...process.env, PORT: '3999', LR_DATA_DIR: '/tmp/lr', PINNACLE: 'on', PICK6: 'on' }, stdio: ['ignore', fs.openSync('out/server.log', 'w'), fs.openSync('out/server.err', 'w')] });
  const runMin = +(process.env.RUNMIN || 330), t0 = Date.now();
  await wait(6 * 60e3);
  let i = 0;
  while (Date.now() - t0 < runMin * 60e3) {
    const s = Date.now();
    const d = await get(B + '/api/diag/combo');
    const tag = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15);
    fs.writeFileSync(`out/h/${tag}.json`, JSON.stringify(d));
    const rows = d.rows || [];
    const q = rows.reduce((a, r) => { for (const x of r.quotes || []) a[x.book] = (a[x.book] || 0) + 1; return a; }, {});
    const line = `${tag} rows ${rows.length} combo ${rows.filter(r => r.combo).length} quotes ${JSON.stringify(q)}`;
    console.log(line); fs.appendFileSync('out/report.txt', line + '\n');
    if (++i % 3 === 0) try { execSync('bash diag/push.sh', { stdio: 'inherit' }); } catch (e) { console.log('push failed'); }
    await wait(Math.max(0, 10 * 60e3 - (Date.now() - s)));
  }
  const rec = await get(B + '/api/props/record/picks?kind=combo&status=open&limit=1000'); fs.writeFileSync('out/combo-open.json', JSON.stringify(rec));
  const rec2 = await get(B + '/api/props/record/picks?kind=combo&status=locked&limit=1000'); fs.writeFileSync('out/combo-locked.json', JSON.stringify(rec2));
  process.exit(0);
})();
