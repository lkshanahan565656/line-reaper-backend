// Esports section health: poll every endpoint the esports views read, every 60 s for N min; full snapshots at the end.
const fs = require('fs');
const P = process.env.BASE || 'https://line-reaper-backend-production.up.railway.app';
const wait = ms => new Promise(r => setTimeout(r, ms));
const get = async p => { const t = Date.now(); try { const r = await fetch(P + p, { signal: AbortSignal.timeout(90000) }); const tx = await r.text(); let j = null; try { j = JSON.parse(tx); } catch {} return { st: r.status, ms: Date.now() - t, j, tx, len: tx.length }; } catch (e) { return { st: 'ERR ' + e.message, ms: Date.now() - t, j: null, tx: '' }; } };
const EP = ['/api/status', '/api/esports/picks?minEV=-100', '/api/esports/matches', '/api/esports/auto-slips', '/api/esports/alerts?limit=30',
  '/api/tracker/summary?', '/api/tracker/picks?status=review&limit=100', '/api/tracker/picks?status=locked&limit=100',
  '/api/props/board?sport=ESPORTS&sort=ev&limit=150', '/api/props/board?sport=CS&sort=ev&limit=150', '/api/props/board?sport=ESPORTS&sort=ev&limit=150&gaps=1', '/api/props/record', '/api/results', '/api/best?limit=500', '/api/underdog', '/api/prizepicks'];
(async () => {
  fs.mkdirSync('out', { recursive: true });
  const N = +(process.env.N || 30);
  for (let i = 0; i < 30 && process.env.WAITVER; i++) { const s = await get('/api/status'); if (s.j?.version === process.env.WAITVER) break; await wait(60e3); }
  await wait(+(process.env.SETTLE || 0) * 60e3);
  for (let i = 0; i < N; i++) {
    const at = new Date().toISOString();
    const R = await Promise.all(EP.slice(0, 5).map(get));
    const [st, pk, mt, sl, al] = R;
    const row = { at, st: R.map(r => r.st), ms: R.map(r => r.ms), len: R.map(r => r.len), ver: st.j?.version, pp: st.j?.prizepicks, ppEs: st.j?.esports?.ppEsportsLines, updated: pk.j?.updated, mUpdated: mt.j?.updated, slUpdated: sl.j?.updated,
      picks: (pk.j?.picks || []).map(p => [p.sport, p.player, p.market, p.ppLine, p.udLine, p.sleeperLine, p.side, p.bestBook, p.bestEv, p.prob, p.startTime, p.matchTitle]),
      matches: (mt.j?.matches || []).map(m => [m.id, m.live ? 1 : 0, m.start, (m.edges || []).length, (m.markets || []).length, m.pin ? 1 : 0]),
      slips: Array.isArray(sl.j?.slips) ? sl.j.slips.map(s => [s.book, s.legs, s.status, s.ev]) : sl.j?.error || null,
      stacks: Array.isArray(sl.j?.stacks) ? sl.j.stacks.length : null, alerts: Array.isArray(al.j?.alerts) ? al.j.alerts.length : (al.j && Object.keys(al.j)) };
    fs.appendFileSync('out/poll.jsonl', JSON.stringify(row) + '\n');
    if (i < N - 1) await wait(60e3);
  }
  fs.mkdirSync('out/snap', { recursive: true }); const index = {};
  for (const p of EP) { const r = await get(p); const f = p.replace(/[^a-z0-9]+/gi, '_') + '.json'; fs.writeFileSync('out/snap/' + f, r.tx); index[p] = { st: r.st, f, bytes: r.len, ms: r.ms }; }
  fs.writeFileSync('out/snap/index.json', JSON.stringify(index, null, 1));
})();
