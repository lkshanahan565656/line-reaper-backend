// run the PR branch server on live feeds, check closes record their seen time and the scoreboard answers
const fs = require('fs'); const { spawn } = require('child_process');
fs.mkdirSync('out/snap', { recursive: true });
const env = { ...process.env, PORT: '3999', PINNACLE: 'on', LR_DATA_DIR: '/tmp/lrdata' };
const srv = spawn('node', ['server.js'], { cwd: 'app', env, stdio: ['ignore', fs.openSync('out/server.log', 'w'), fs.openSync('out/server.err', 'w')] });
const get = async p => { try { const r = await fetch('http://localhost:3999' + p); return { status: r.status, body: await r.text() }; } catch (e) { return { status: 0, body: e.message }; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const mins = +(process.env.MINS || 18);
  const log = [];
  for (let i = 0; i < mins; i++) {
    await sleep(60000);
    const sb = await get('/api/ev/scoreboard');
    const bets = await get('/api/ev/record/bets?status=open&limit=500');
    let seen = null;
    try { const b = JSON.parse(bets.body).bets; seen = { open: b.length, withSeen: b.filter(x => x.fairSeenAt).length, seenRecent: b.filter(x => Date.now() - Date.parse(x.fairSeenAt) < 15 * 60e3).length }; } catch {}
    let o = null; try { o = JSON.parse(sb.body).overall; } catch {}
    log.push({ t: new Date().toISOString(), sbStatus: sb.status, overall: o, seen });
    fs.writeFileSync('out/log.json', JSON.stringify(log, null, 1));
  }
  for (const [n, p] of [['scoreboard', '/api/ev/scoreboard'], ['record', '/api/ev/record'], ['open', '/api/ev/record/bets?status=open&limit=500'], ['closed', '/api/ev/record/bets?status=closed&limit=500'],
    ['alt-open', '/api/ev/record/bets?status=open&alt=1&limit=500'], ['props', '/api/props/record/picks?status=open&limit=1000'], ['locked', '/api/props/record/picks?status=locked&limit=1000'], ['status', '/api/status']]) {
    const r = await get(p); fs.writeFileSync(`out/snap/${n}.json`, r.body);
  }
  srv.kill(); process.exit(0);
})();
