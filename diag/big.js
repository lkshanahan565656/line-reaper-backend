// Runs this branch's server on live feeds (PINNACLE=on) for ~22 min and
// snapshots /api/big-money (market makers included) and /api/status.
const fs = require('fs'); const { spawn } = require('child_process');
const B = 'http://localhost:3999';
const wait = ms => new Promise(r => setTimeout(r, ms));
const get = async p => { try { const r = await fetch(B + p, { signal: AbortSignal.timeout(120000) }); return { st: r.status, tx: await r.text() }; } catch (e) { return { st: 'ERR', tx: JSON.stringify({ error: e.message }) }; } };
(async () => {
  fs.mkdirSync('out/snap', { recursive: true }); fs.mkdirSync('/tmp/lr', { recursive: true });
  const srv = spawn('node', ['server.js'], { env: { ...process.env, PORT: '3999', LR_DATA_DIR: '/tmp/lr', PINNACLE: 'on' }, stdio: ['ignore', fs.openSync('out/server.log', 'w'), fs.openSync('out/server.err', 'w')] });
  const polls = [];
  for (let i = 0; i < Number(process.env.MINUTES || 22); i++) {
    await wait(60e3);
    const [st, bm] = await Promise.all([get('/api/status'), get('/api/big-money?mm=1&minUsd=1000')]);
    let S = {}, M = {}; try { S = JSON.parse(st.tx); } catch {} try { M = JSON.parse(bm.tx); } catch {}
    polls.push({ at: new Date().toISOString(), big: S.bigMoney, whales: S.whales && { prints: S.whales.prints, lastKalshiPollAt: S.whales.lastKalshiPollAt, errors: S.whales.errors }, kprops: S.kalshiProps?.counts, fb: S.freeBooks && { gamesAt: S.freeBooks.gamesAt, errors: S.freeBooks.errors },
      count: M.count, flagged: M.flagged, hiddenMm: M.hiddenMarketMakers, err: M.error });
    if (i % 4 === 3 || i >= 18) fs.writeFileSync(`out/snap/big-${String(i).padStart(2, '0')}.json`, bm.tx);
    fs.writeFileSync('out/polls.json', JSON.stringify(polls, null, 1));
  }
  for (const p of ['/api/status', '/api/big-money?mm=1&minUsd=250', '/api/big-money', '/api/results', '/api/props/board?sport=SPORTS&sort=ev&limit=50']) { const r = await get(p); fs.writeFileSync('out/snap/' + p.replace(/[^a-z0-9]+/gi, '_') + '.json', r.tx); }
  srv.kill();
})();
