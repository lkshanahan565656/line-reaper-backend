// Runs this branch's server on live feeds (PINNACLE=on) ~16 min; compares its consensus and +EV counts with prod's
const fs = require('fs'); const { spawn } = require('child_process');
const B = 'http://localhost:3999', P = 'https://line-reaper-backend-production.up.railway.app';
const wait = ms => new Promise(r => setTimeout(r, ms));
const get = async (base, p) => { try { const r = await fetch(base + p, { signal: AbortSignal.timeout(120000) }); return { st: r.status, tx: await r.text() }; } catch (e) { return { st: 'ERR', tx: JSON.stringify({ error: e.message }) }; } };
const J = r => { try { return JSON.parse(r.tx); } catch { return {}; } };
const EP = ['/api/status', '/api/props/board?sport=SPORTS&sort=ev&limit=500&priced=1', '/api/props/board?sport=SPORTS&sort=ev&limit=150', '/api/props/board?sport=SPORTS&sort=ev&limit=150&sharp=1', '/api/best?limit=500', '/api/props/record', '/api/results', '/api/ev?limit=1000', '/api/ev/record'];
async function boardStats(base) {
  const rows = [];
  for (let off = 0; off < 20000; off += 500) { const d = J(await get(base, `/api/props/board?sport=SPORTS&sort=start&limit=500&offset=${off}`)); rows.push(...(d.rows || [])); if (!d.rows || d.rows.length < 500) break; }
  const by = {}, srcs = {};
  for (const r of rows) {
    const s = r.sport; by[s] = by[s] || { rows: 0, consensus: 0, sharp: 0 }; by[s].rows++;
    if (r.consensus) { by[s].consensus++; for (const x of r.consensus.sources) srcs[x.book] = (srcs[x.book] || 0) + 1; }
    if (r.best?.kind === 'sharp') by[s].sharp++;
  }
  return { rows: rows.length, by, srcs, sharpLegs: rows.filter(r => r.best?.kind === 'sharp').map(r => [r.sport, r.player, r.mkey, r.best.book, r.best.side, r.best.line, r.best.ev, r.best.sources.map(x => x.book).join('+')]) };
}
function evStats(E) {
  const rows = (E.rows || []).filter(r => !r.dfs);
  const clear = rows.filter(r => r.ev >= 2);
  const lines = rows.filter(r => !r.player);
  const withK = lines.filter(r => (r.sharpBooks || []).includes('kalshi_mid'));
  const spreads = withK.map(r => r.spreadPts).filter(x => x != null).sort((a, b) => a - b);
  return { rows: rows.length, clear2: clear.length, clear2Lines: clear.filter(r => !r.player).length, agree2: clear.filter(r => r.agree).length, agree2Lines: clear.filter(r => r.agree && !r.player).length,
    linesWithKalshi: withK.length, lines: lines.length, spreadMedian: spreads[Math.floor(spreads.length / 2)] ?? null, spreadP90: spreads[Math.floor(spreads.length * 0.9)] ?? null,
    counts: E.counts || null, agreeRows: clear.filter(r => r.agree).slice(0, 40).map(r => [r.sport, r.event, r.market, r.side, r.book, r.price, r.fairProb, r.ev, r.spreadPts, r.sharpBooks.join('+')]) };
}
(async () => {
  fs.mkdirSync('out/snap', { recursive: true }); fs.mkdirSync('/tmp/lr', { recursive: true });
  const srv = spawn('node', ['server.js'], { env: { ...process.env, PORT: '3999', LR_DATA_DIR: '/tmp/lr', PINNACLE: 'on' }, stdio: ['ignore', fs.openSync('out/server.log', 'w'), fs.openSync('out/server.err', 'w')] });
  const polls = [];
  for (let i = 0; i < 16; i++) {
    await wait(60e3);
    const S = J(await get(B, '/api/status')), E = J(await get(B, '/api/ev?limit=1000'));
    polls.push({ at: new Date().toISOString(), fb: S.freeBooks && { counts: S.freeBooks.counts, errors: S.freeBooks.errors }, pin: S.pinnacleProps && { props: S.pinnacleProps.props, bySport: S.pinnacleProps.bySport }, ev: evStats(E) });
  }
  const after = { board: await boardStats(B), ev: evStats(J(await get(B, '/api/ev?limit=1000'))) };
  const before = { board: await boardStats(P), ev: evStats(J(await get(P, '/api/ev?limit=1000'))) };
  const index = {};
  for (const p of EP) { const r = await get(B, p); const f = p.replace(/[^a-z0-9]+/gi, '_') + '.json'; fs.writeFileSync('out/snap/' + f, r.tx); index[p] = { st: r.st, f, bytes: r.tx.length }; }
  fs.writeFileSync('out/snap/index.json', JSON.stringify(index, null, 1));
  fs.writeFileSync('out/cb.json', JSON.stringify({ before, after, polls }, null, 1));
  srv.kill();
})();
