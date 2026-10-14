// After deploy: wait for v3.107.0 on prod, then poll picks 10 times a minute apart and snapshot.
const fs = require('fs'); const P = 'https://line-reaper-backend-production.up.railway.app';
const wait = ms => new Promise(r => setTimeout(r, ms));
const get = async p => { try { const r = await fetch(P + p, { signal: AbortSignal.timeout(90000) }); return { st: r.status, j: await r.json().catch(() => null) }; } catch (e) { return { st: 'ERR ' + e.message }; } };
(async () => {
  fs.mkdirSync('out', { recursive: true }); const log = [];
  for (let i = 0; i < 25; i++) { const s = await get('/api/status'); log.push(['status', s.st, s.j?.version]); if (s.j?.version === '3.107.0') break; await wait(60e3); }
  await wait(5 * 60e3); const rows = [];
  for (let i = 0; i < 10; i++) { const pk = await get('/api/esports/picks'); rows.push({ st: pk.st, updated: pk.j?.updated, picks: (pk.j?.picks || []).map(p => [p.sport, p.player, p.market, p.ppLine, p.udLine, p.sleeperLine, p.side, p.prob, p.pinTeam?.factor ?? null]) }); await wait(60e3); }
  const m = await get('/api/esports/matches'), w = await get('/api/results'), b = await get('/api/best'), sm = await get('/api/tracker/summary');
  fs.writeFileSync('out/post.json', JSON.stringify({ log, rows, counts: m.j?.counts, matchesSt: m.st, resultsSt: w.st, bestSt: b.st, summarySt: sm.st, byPinTeam: sm.j?.byPinTeam ?? null, plays: (w.j?.plays || []).filter(p => p.source === 'esportsEdges') }));
})();
