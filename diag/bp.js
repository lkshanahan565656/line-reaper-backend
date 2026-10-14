// Waits for production to run v3.112.0, then reads its /api/best and /api/results.
const fs = require('fs');
const P = 'https://line-reaper-backend-production.up.railway.app';
const wait = ms => new Promise(r => setTimeout(r, ms));
const j = async p => { try { const r = await fetch(P + p, { signal: AbortSignal.timeout(60000) }); return { st: r.status, d: await r.json() }; } catch (e) { return { st: 'ERR', d: { error: e.message } }; } };
(async () => {
  fs.mkdirSync('out', { recursive: true });
  let v = null;
  for (let i = 0; i < 40; i++) { v = (await j('/api/status')).d.version; if (v === '3.112.0') break; await wait(30e3); }
  await wait(180e3);
  const polls = [];
  for (let i = 0; i < 4; i++) { const b = await j('/api/best?limit=500'); polls.push({ at: new Date().toISOString(), st: b.st, total: b.d.total, counts: b.d.counts, pro: b.d.pro }); if (i < 3) await wait(60e3); }
  const b = await j('/api/best?limit=500'), r = await j('/api/results');
  const rows = (b.d.rows || []).filter(x => ['sportsProp', 'bookProp'].includes(x.kind)).map(x => ({ kind: x.kind, id: x.id, bet: x.bet, title: x.title, venue: x.venue, ev: x.ev, verdict: x.verdict, why: x.why }));
  fs.writeFileSync('out/check.json', JSON.stringify({ version: v, polls, counts: b.d.counts, rows, results: r.st, sportsProps: r.d.sources && r.d.sources.sportsProps }, null, 1));
})();
