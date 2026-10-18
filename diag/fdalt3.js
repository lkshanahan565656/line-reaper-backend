// branch server on live feeds vs prod: which alt rungs clear and on what; and
// the branch scoreboard over prod's own alt and main records
const fs = require('fs'); const { spawn } = require('child_process');
const B = 'http://localhost:3999', P = 'https://line-reaper-backend-production.up.railway.app';
const wait = ms => new Promise(r => setTimeout(r, ms));
const get = async u => { try { const r = await fetch(u, { headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(120000) }); if (!r.ok) return { error: r.status }; return await r.json(); } catch (e) { return { error: e.message }; } };
const out = []; const say = s => { out.push(s); console.log(s); fs.writeFileSync('out/report.txt', out.join('\n')); };
async function all(q) { const rows = []; let before = ''; for (let i = 0; i < 40; i++) { const d = await get(`${P}/api/ev/record/bets?limit=500&status=closed&${q}${before ? `&before=${before}` : ''}`); const b = d.bets || []; rows.push(...b); if (b.length < 500) break; before = b[b.length - 1].flaggedAt; } return rows; }
const mix = rows => { const m = {}; for (const r of rows.filter(r => r.clears)) { const k = `${r.book}:${r.sources.filter(s => s.exact).map(s => s.book).sort().join('+')}`; m[k] = (m[k] || 0) + 1; } return m; };
(async () => {
  fs.mkdirSync('out', { recursive: true }); fs.mkdirSync('/tmp/lr', { recursive: true });
  const srv = spawn('node', ['server.js'], { env: { ...process.env, PORT: '3999', LR_DATA_DIR: '/tmp/lr', PINNACLE: 'on' }, stdio: ['ignore', fs.openSync('out/server.log', 'w'), fs.openSync('out/server.err', 'w')] });
  const t0 = Date.now();
  // the branch rules over prod's records
  const cb = require('./closeboard');
  const alt = [...await all('alt=1&book=fanduel'), ...await all('alt=1&book=betrivers')];
  const ev = [...await all('book=fanduel'), ...await all('book=betrivers')];
  const sb = cb.scoreboard({ alt, ev });
  say(`prod records read: alt ${alt.length}, main ${ev.length}`);
  for (const r of sb.rows.filter(r => ['fanduel', 'betrivers'].includes(r.book) && ['ev', 'alt'].includes(r.kind))) say(`BRANCH RULE ${r.book} ${r.kind}: ${r.graded} games, clv ${r.avgClv}, 2min ${r.avgExecClv}, mark ${r.mark}`);
  say(`BRANCH RULE byBook fanduel ${sb.byBook.fanduel?.mark}, betrivers ${sb.byBook.betrivers?.mark}; alertBooks ${[...cb.alertBooks(sb)]}`);
  const prodSb = await get(`${P}/api/ev/scoreboard`);
  say(`PROD now: fanduel alt ${prodSb.rows?.find(r => r.book === 'fanduel' && r.kind === 'alt')?.mark}, byBook fanduel ${prodSb.byBook?.fanduel?.mark}, betrivers ev ${prodSb.rows?.find(r => r.book === 'betrivers' && r.kind === 'ev')?.mark}`);
  const runMin = +(process.env.RUNMIN || 13);
  while (Date.now() - t0 < runMin * 60e3) await wait(20e3);
  const [pe, be, st] = [await get(`${P}/api/ev`), await get(`${B}/api/ev`), await get(`${B}/`)];
  fs.writeFileSync('out/prod-alt.json', JSON.stringify(pe.alt || [])); fs.writeFileSync('out/branch-alt.json', JSON.stringify(be.alt || []));
  say(`\nbranch ${st.version}: alt shown ${(be.alt || []).length}, clearing ${(be.alt || []).filter(r => r.clears).length} ${JSON.stringify(mix(be.alt || []))}`);
  say(`prod: alt shown ${(pe.alt || []).length}, clearing ${(pe.alt || []).filter(r => r.clears).length} ${JSON.stringify(mix(pe.alt || []))}`);
  srv.kill(); process.exit(0);
})();
