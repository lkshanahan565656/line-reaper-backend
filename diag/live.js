// Runs this branch's server on live feeds with PINNACLE=on; polls picks each minute to count side flips.
const fs = require('fs'); const { spawn } = require('child_process');
const B = 'http://localhost:3999';
const wait = ms => new Promise(r => setTimeout(r, ms));
const get = async p => { try { const r = await fetch(B + p, { signal: AbortSignal.timeout(90000) }); return await r.text(); } catch (e) { return JSON.stringify({ error: e.message }); } };
(async () => {
  fs.mkdirSync('out', { recursive: true }); fs.mkdirSync('/tmp/lr', { recursive: true });
  const srv = spawn('node', ['server.js'], { env: { ...process.env, PORT: '3999', LR_DATA_DIR: '/tmp/lr', PINNACLE: 'on' }, stdio: ['ignore', fs.openSync('out/server.log', 'w'), fs.openSync('out/server.err', 'w')] });
  await wait(6 * 60e3);
  const rows = [];
  for (let i = 0; i < 20; i++) {
    let j = {}; try { j = JSON.parse(await get('/api/esports/picks')); } catch {}
    rows.push({ at: new Date().toISOString(), updated: j.updated, picks: (j.picks || []).map(p => [p.sport, p.player, p.market, p.ppLine, p.udLine, p.sleeperLine, p.side, p.bestEv, p.prob, p.pinTeam?.factor ?? null, p.team, p.matchTitle]) });
    await wait(60e3);
  }
  fs.writeFileSync('out/poll.json', JSON.stringify(rows));
  for (const p of ['/api/esports/matches', '/api/esports/picks?minEV=-100', '/api/best', '/api/tracker/summary', '/api/status', '/api/results']) fs.writeFileSync(`out/z_${p.replace(/[^a-z0-9]+/gi, '_')}.json`, await get(p));
  srv.kill();
})();
