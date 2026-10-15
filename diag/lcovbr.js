// Runs this branch's server on live feeds (PINNACLE=on) ~13 min, then counts
// sports pick'em legs by price source on the branch and on prod at the same moment.
const fs = require('fs'); const { spawn } = require('child_process');
const B = 'http://localhost:3999', P = 'https://line-reaper-backend-production.up.railway.app';
const wait = ms => new Promise(r => setTimeout(r, ms));
const get = async u => { try { const r = await fetch(u, { signal: AbortSignal.timeout(120000) }); return await r.json(); } catch (e) { return { error: e.message }; } };
const pb = require('../propsboard');
async function board(base) {
  const rows = [];
  for (let off = 0; off < 40000; off += 500) {
    const d = await get(`${base}/api/props/board?sport=SPORTS&sort=start&limit=500&offset=${off}`);
    rows.push(...(d.rows || []));
    if (!d.rows || d.rows.length < 500) break;
  }
  return rows;
}
const line = (k, a) => `${k.padEnd(14)} legs ${String(a.legs).padStart(5)}  sharp ${String(a.sharp).padStart(5)}  pin ${String(a.pinnacle).padStart(5)}  kal ${String(a.kalshi).padStart(4)}  book ${String(a.books).padStart(4)}  apps ${String(a.apps).padStart(5)}  none ${String(a.none).padStart(5)}`;
(async () => {
  fs.mkdirSync('out', { recursive: true }); fs.mkdirSync('/tmp/lr', { recursive: true });
  const srv = spawn('node', ['server.js'], { env: { ...process.env, PORT: '3999', LR_DATA_DIR: '/tmp/lr', PINNACLE: 'on' }, stdio: ['ignore', fs.openSync('out/server.log', 'w'), fs.openSync('out/server.err', 'w')] });
  await wait(+(process.env.RUNMIN || 13) * 60e3);
  const [br, prod] = await Promise.all([board(B), board(P)]);
  const cov = await get(B + '/api/props/coverage');
  const st = await get(B + '/api/status');
  fs.writeFileSync('out/branch-board.json', JSON.stringify(br));
  fs.writeFileSync('out/coverage.json', JSON.stringify(cov));
  fs.writeFileSync('out/status.json', JSON.stringify({ pinnacleProps: st.pinnacleProps, kalshiExtra: st.kalshiExtra, kalshiProps: st.kalshiProps, version: st.version }));
  for (const s of ['MMA', 'TENNIS', 'SOCCER', 'NFL']) for (const b of ['underdog', 'prizepicks', 'sleeper']) {
    const f = `/api/props/board?sport=${s}&book=${b}&priced=1&facets=1&limit=150`;
    fs.writeFileSync(`out/snap-${s}-${b}.json`, JSON.stringify(await get(B + f)));
  }
  fs.writeFileSync('out/snap-all.json', JSON.stringify(await get(B + '/api/props/board?sport=SPORTS&limit=150')));
  const cb = pb.coverage(br), cp = pb.coverage(prod);
  const out = [`branch ${st.version} vs prod at ${new Date().toISOString()}`, '', '== PROD (same moment, classified by propsboard.coverage)'];
  for (const [k, a] of Object.entries(cp.leagues).sort((x, y) => y[1].legs - x[1].legs)) out.push(line(k, a));
  out.push(line('TOTAL', cp.total), '', '== BRANCH');
  for (const [k, a] of Object.entries(cb.leagues).sort((x, y) => y[1].legs - x[1].legs)) out.push(line(k, a));
  out.push(line('TOTAL', cb.total), '', '== BRANCH markets in MMA, TENNIS, SOCCER, MOTORSPORTS, NBA, NHL, CFB');
  for (const m of cb.markets.filter(m => /^(MMA|TENNIS|SOCCER|MOTORSPORTS|NBA|NHL|CFB)$/.test(m.sport) && m.legs >= 3)) out.push(`${(m.sport + ' ' + m.market).padEnd(40)} ${line('', m)}${m.never ? '  NEVER' : ''}`);
  out.push('', 'status ' + JSON.stringify({ pinnacleProps: st.pinnacleProps, kalshiExtra: st.kalshiExtra, kalshiProps: st.kalshiProps }).slice(0, 4000));
  // examples of new prices
  const ex = br.filter(r => /^(MMA|TENNIS|MOTORSPORTS|SOCCER)$/.test(r.sport) && Object.values(r.books).some(c => pb.legSource(r, c) === 'pinnacle' || pb.legSource(r, c) === 'kalshi')).slice(0, 40);
  out.push('', '== EXAMPLES');
  for (const r of ex) out.push(`${r.sport} ${r.player} ${r.market} pin=${JSON.stringify(r.pinnacle || null)} cons=${r.consensus ? r.consensus.sources.map(s => s.book + ' ' + s.line + ' ' + s.p).join(',') : '-'} ${Object.entries(r.books).map(([b, c]) => `${b} ${c.line} fair=${c.fair ?? '-'} ev=${c.ev ? c.ev.side + ' ' + c.ev.ev : '-'}`).join(' | ')} best=${r.best ? r.best.book + ' ' + r.best.side + ' ' + r.best.ev + ' ' + r.best.source + ' ' + r.best.kind : '-'}`);
  fs.writeFileSync('out/report.txt', out.join('\n'));
  srv.kill();
})();
