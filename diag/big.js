// Waits for the live site to run v3.118.1, then reads its big money view for ~15 min.
const fs = require('fs');
const B = 'https://line-reaper-backend-production.up.railway.app';
const wait = ms => new Promise(r => setTimeout(r, ms));
const get = async p => { try { const r = await fetch(B + p, { signal: AbortSignal.timeout(60000) }); return { st: r.status, tx: await r.text() }; } catch (e) { return { st: 'ERR', tx: JSON.stringify({ error: e.message }) }; } };
(async () => {
  fs.mkdirSync('out/snap', { recursive: true });
  const polls = [];
  for (let i = 0; i < 40; i++) { const s = await get('/api/status'); let S = {}; try { S = JSON.parse(s.tx); } catch {} polls.push({ at: new Date().toISOString(), v: S.version }); if (S.version === '3.118.1') break; await wait(30e3); }
  for (let i = 0; i < 3; i++) {
    await wait(60e3);
    const [st, bm] = await Promise.all([get('/api/status'), get('/api/big-money?mm=1&minUsd=1000')]);
    let S = {}, M = {}; try { S = JSON.parse(st.tx); } catch {} try { M = JSON.parse(bm.tx); } catch {}
    polls.push({ at: new Date().toISOString(), v: S.version, big: S.bigMoney, st: bm.st, count: M.count, flagged: M.flagged, hiddenMm: M.hiddenMarketMakers, bt: !!(M.backtest && M.backtest.summary), pro: M.pro, err: M.error });
    fs.writeFileSync('out/snap/big-live.json', bm.tx);
    fs.writeFileSync('out/polls.json', JSON.stringify(polls, null, 1));
  }
})();
