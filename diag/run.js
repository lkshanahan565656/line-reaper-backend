// Branch server on live data: stacks endpoint, plus the branch's own pricing
// at a record gap and the close follow, run in-process on the board it built.
const fs = require('fs'); const { spawn } = require('child_process');
const B = 'http://localhost:3999';
const wait = ms => new Promise(r => setTimeout(r, ms));
const get = async p => { try { const r = await fetch(B + p, { signal: AbortSignal.timeout(180000) }); return await r.text(); } catch (e) { return JSON.stringify({ error: e.message }); } };
const save = (p, body) => fs.writeFileSync(`out/${p.replace(/[^a-z0-9]+/gi, '_')}.json`, body);
(async () => {
  fs.mkdirSync('out', { recursive: true }); fs.mkdirSync('/tmp/lr', { recursive: true });
  const srv = spawn('node', ['server.js'], { env: { ...process.env, PORT: '3999', LR_DATA_DIR: '/tmp/lr', PINNACLE: 'on' }, stdio: ['ignore', fs.openSync('out/server.log', 'w'), fs.openSync('out/server.err', 'w')] });
  await wait(7 * 60e3);
  const SB = require('../slipbuild'); const { createSlipTracker } = require('../sliptrack');
  const picksRaw = await get('/api/esports/picks?minEV=-100'); save('/api/esports/picks?minEV=-100', picksRaw);
  let picks = []; try { const j = JSON.parse(picksRaw); picks = Array.isArray(j) ? j : j.picks || []; } catch {}
  const t0 = Date.now();
  const built = SB.autoSlips(picks);
  fs.writeFileSync('out/autoslips_gap.json', JSON.stringify(built.stacks, null, 1));
  const tr = createSlipTracker({ now: () => t0 });
  await tr.record(built.stacks);
  for (const p of ['/api/esports/auto-slips', '/api/status']) save(p, await get(p));
  await wait(4 * 60e3);
  const picksRaw2 = await get('/api/esports/picks?minEV=-100');
  let picks2 = []; try { const j = JSON.parse(picksRaw2); picks2 = Array.isArray(j) ? j : j.picks || []; } catch {}
  await tr.follow(SB.stackLegLookup(picks2));
  const rows = await tr.list();
  fs.writeFileSync('out/follow.json', JSON.stringify({ picks: picks.length, picks2: picks2.length, rows: rows.map(r => ({ id: r.id, start: r.start, legs: r.legs.map(l => ({ player: l.player, side: l.side, line: l.line, prob: l.prob, closeLine: l.closeLine, closeProb: l.closeProb })) })) }, null, 1));
  save('/api/esports/auto-slips-2', await get('/api/esports/auto-slips'));
  srv.kill();
})();
