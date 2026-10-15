// Runs this branch's server on live feeds with PICK6=on and PINNACLE=on long enough for Pick6's
// rotation to read every sport, then snapshots the views and counts what Pick6 gave.
const fs = require('fs'); const { spawn } = require('child_process');
const B = 'http://localhost:3999';
const MIN = parseFloat(process.env.MINUTES || '26');
const wait = ms => new Promise(r => setTimeout(r, ms));
const get = async p => { try { const r = await fetch(B + p, { signal: AbortSignal.timeout(120000) }); return { st: r.status, tx: await r.text() }; } catch (e) { return { st: 'ERR', tx: JSON.stringify({ error: e.message }) }; } };
const EP = ['/api/status',
  '/api/props/board?sport=ALL&sort=ev&limit=150', '/api/props/board?sport=ALL&sort=ev&limit=2000&book=pick6',
  '/api/props/board?sport=ALL&sort=ev&limit=150&book=pick6&priced=1&facets=1', '/api/props/board?sport=ALL&sort=ev&limit=150&book=prizepicks&priced=1&facets=1',
  '/api/props/board?sport=ESPORTS&sort=ev&limit=150', '/api/props/board?sport=SPORTS&sort=ev&limit=150&sharp=1',
  '/api/props/board?sport=ESPORTS&sort=ev&limit=150&book=pick6&priced=1&facets=1',
  '/api/ev?dfs=1&limit=2000', '/api/props/record', '/api/best?limit=500', '/api/results', '/api/close/board'];
(async () => {
  fs.mkdirSync('out/snap', { recursive: true }); fs.mkdirSync('/tmp/lr', { recursive: true });
  const srv = spawn('node', ['server.js'], { env: { ...process.env, PORT: '3999', LR_DATA_DIR: '/tmp/lr', PINNACLE: 'on', PICK6: 'on' }, stdio: ['ignore', fs.openSync('out/server.log', 'w'), fs.openSync('out/server.err', 'w')] });
  const polls = [];
  for (let i = 0; i < MIN / 2; i++) {
    await wait(120e3);
    const st = await get('/api/status');
    let S = {}; try { S = JSON.parse(st.tx); } catch {}
    polls.push({ at: new Date().toISOString(), pick6: S.pick6, board: S.propsBoard });
    fs.writeFileSync('out/polls.json', JSON.stringify(polls, null, 1));
  }
  const index = {};
  for (const p of EP) { const r = await get(p); const f = p.replace(/[^a-z0-9]+/gi, '_') + '.json'; fs.writeFileSync('out/snap/' + f, r.tx); index[p] = { st: r.st, f, bytes: r.tx.length }; }
  fs.writeFileSync('out/snap/index.json', JSON.stringify(index, null, 1));
  // what Pick6 gave: lines, rows it shares with another app, priced, clearing 2% on a sharp price
  let all = {}; try { all = JSON.parse(fs.readFileSync('out/snap/' + index['/api/props/board?sport=ALL&sort=ev&limit=2000&book=pick6'].f)); } catch {}
  const rows = all.rows || [];
  const sum = {};
  for (const r of rows) {
    const k = r.esports ? `esports ${r.sport}` : r.sport;
    const s = sum[k] ||= { rows: 0, shared: 0, priced: 0, consensus: 0, clears2: 0, ev2any: 0 };
    const c = r.books.pick6;
    s.rows++;
    if (Object.keys(r.books).length > 1) s.shared++;
    if (c.ev) s.priced++;
    if (c.ev?.consensus) s.consensus++;
    const sharp = c.ev && (c.ev.share || c.ev.h2h ? c.ev.clears : (r.esports || c.ev.consensus));
    if (sharp && c.ev.ev >= 2) s.clears2++;
    if (c.ev && c.ev.ev >= 2) s.ev2any++;
  }
  const clears = rows.filter(r => { const c = r.books.pick6; return c.ev && c.ev.ev >= 2 && (c.ev.share || c.ev.h2h ? c.ev.clears : (r.esports || c.ev.consensus)); })
    .map(r => ({ sport: r.sport, player: r.player, market: r.market, line: r.books.pick6.line, side: r.books.pick6.ev.side, ev: r.books.pick6.ev.ev, fair: r.books.pick6.ev.fair, mult: r.books.pick6.ev.side === 'Over' ? r.books.pick6.over : r.books.pick6.under, others: Object.fromEntries(Object.entries(r.books).filter(([b]) => b !== 'pick6').map(([b, x]) => [b, x.line])), start: r.startTime, sources: r.consensus?.sources }));
  fs.writeFileSync('out/summary.json', JSON.stringify({ total: all.total, sum, clears, status: polls[polls.length - 1]?.pick6 }, null, 1));
  srv.kill();
})();
