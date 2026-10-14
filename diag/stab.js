// Live esports section stability: poll prod every 60 s for 30 min; full snapshot at the end.
const fs = require('fs'); const zlib = require('zlib');
const P = 'https://line-reaper-backend-production.up.railway.app';
const wait = ms => new Promise(r => setTimeout(r, ms));
const get = async p => { const t = Date.now(); try { const r = await fetch(P + p, { signal: AbortSignal.timeout(90000) }); const tx = await r.text(); let j = null; try { j = JSON.parse(tx); } catch {} return { st: r.status, ms: Date.now() - t, j, len: tx.length }; } catch (e) { return { st: 'ERR ' + e.message, ms: Date.now() - t, j: null }; } };
(async () => {
  fs.mkdirSync('out', { recursive: true });
  const N = +(process.env.N || 30);
  for (let i = 0; i < N; i++) {
    const at = new Date().toISOString();
    const [pk, mt, sl, sm, st] = await Promise.all(['/api/esports/picks', '/api/esports/matches', '/api/esports/auto-slips', '/api/tracker/summary', '/api/status'].map(get));
    const row = { at, st: [pk.st, mt.st, sl.st, sm.st, st.st], ms: [pk.ms, mt.ms, sl.ms, sm.ms, st.ms], ver: st.j?.version, updated: pk.j?.updated, mUpdated: mt.j?.updated,
      picks: (pk.j?.picks || []).map(p => [p.sport, p.player, p.market, p.ppLine, p.udLine, p.sleeperLine, p.side, p.bestBook, p.bestEv, p.prob, p.lineGap ? 1 : 0, p.clvWarn ? 1 : 0, p.matchupLed ?? null, p.startTime, p.team, p.matchTitle]),
      matches: (mt.j?.matches || []).map(m => [m.id, m.live ? 1 : 0, m.start, (m.edges || []).length, (m.markets || []).length]),
      slips: Array.isArray(sl.j?.slips) ? sl.j.slips.length : sl.j?.error || null };
    fs.appendFileSync('out/stab.jsonl.gz', zlib.gzipSync(JSON.stringify(row) + '\n'));
    if (i === N - 1) for (const [n, r] of Object.entries({ picks: pk, matches: mt, slips: sl, summary: sm, status: st })) fs.writeFileSync(`out/full_${n}.json`, JSON.stringify(r.j));
    if (i < N - 1) await wait(60e3);
  }
  for (const p of ['/api/tracker/picks?status=open&limit=2000', '/api/tracker/picks?status=graded&limit=2000', '/api/esports/alerts', '/api/best', '/api/results']) { const r = await get(p); fs.writeFileSync(`out/full_${p.replace(/[^a-z0-9]+/gi, '_')}.json`, JSON.stringify(r.j ?? { st: r.st })); }
})();
