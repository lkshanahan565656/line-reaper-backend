// Prod (old rules) vs this branch's server on live feeds: the proven label in
// Best Plays and /api/results, and the book-fair legs with their line gaps.
const fs = require('fs'); const { spawn } = require('child_process');
const B = 'http://localhost:3999', P = 'https://line-reaper-backend-production.up.railway.app';
const wait = ms => new Promise(r => setTimeout(r, ms));
const get = async u => { try { const r = await fetch(u, { headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(120000) }); if (!r.ok) return { error: r.status }; return await r.json(); } catch (e) { return { error: e.message }; } };
const out = []; const say = s => { out.push(s); console.log(s); fs.writeFileSync('out/report.txt', out.join('\n')); };
async function board(base) { const rows = []; for (let off = 0; off < 40000; off += 500) { const d = await get(`${base}/api/props/board?sport=SPORTS&sort=start&limit=500&offset=${off}`); rows.push(...(d.rows || [])); if (!d.rows || d.rows.length < 500) break; } return rows; }
const proven = b => (b.rows || []).filter(r => /^proven/.test((r.why || []).join(' | ')) || r.verdict === 'proven');
(async () => {
  fs.mkdirSync('out', { recursive: true }); fs.mkdirSync('/tmp/lr', { recursive: true });
  const srv = spawn('node', ['server.js'], { env: { ...process.env, PORT: '3999', LR_DATA_DIR: '/tmp/lr', PINNACLE: 'on' }, stdio: ['ignore', fs.openSync('out/server.log', 'w'), fs.openSync('out/server.err', 'w')] });
  const t0 = Date.now();
  const prodBest = await get(`${P}/api/best`), prodRes = await get(`${P}/api/results`), prodBoard = await board(P);
  fs.writeFileSync('out/prod-best.json', JSON.stringify(prodBest)); fs.writeFileSync('out/prod-board.json', JSON.stringify(prodBoard));
  say(`PROD Best Plays ${prodBest.rows?.length} rows, verdict proven ${(prodBest.rows || []).filter(r => r.verdict === 'proven').length}`);
  for (const r of (prodBest.rows || []).filter(r => r.verdict === 'proven').slice(0, 5)) say('  ' + r.kind + ' | ' + (r.why || []).slice(-1)[0]);
  say(`PROD /api/results proven plays: ${(prodRes.plays || []).filter(p => p.verdict === 'proven').map(p => `${p.source}:${p.by || 'all'}:${p.play} n${p.n}`).join('; ')}`);
  const runMin = +(process.env.RUNMIN || 14);
  while (Date.now() - t0 < runMin * 60e3) await wait(20e3);
  const st = await get(B + '/api/status');
  const br = await board(B); fs.writeFileSync('out/branch-board.json', JSON.stringify(br));
  const bestB = await get(`${B}/api/best`), resB = await get(`${B}/api/results`), sb = await get(`${B}/api/ev/scoreboard`);
  fs.writeFileSync('out/branch-best.json', JSON.stringify(bestB)); fs.writeFileSync('out/branch-results.json', JSON.stringify(resB));
  say(`\nBRANCH ${st.version} Best Plays ${bestB.rows?.length} rows, verdict proven ${(bestB.rows || []).filter(r => r.verdict === 'proven').length}`);
  const kinds = {}; for (const r of bestB.rows || []) { const k = `${r.kind}|${r.verdict}`; kinds[k] = (kinds[k] || 0) + 1; }
  say('BRANCH verdict mix: ' + JSON.stringify(kinds));
  for (const r of (bestB.rows || []).filter(r => /not proven yet|not graded yet/.test((r.why || []).slice(-1)[0] || '')).slice(0, 8)) say(`  ${r.kind} ${r.venue} | ${(r.why || []).slice(-1)[0]}`);
  say('BRANCH /api/results ev + sportsProps plays: ' + (resB.plays || []).filter(p => ['ev', 'sportsProps'].includes(p.source) && (p.by === 'book' || p.play === 'all')).map(p => `${p.source}:${p.by || 'all'}:${p.play} n${p.n} ${p.verdict} ${p.provenNote || ''}`).join('\n  '));
  say('BRANCH scoreboard overall ' + JSON.stringify(sb.overall));
  // the book-fair legs, prod vs branch
  const legs = rows => { const o = []; for (const r of rows) for (const [bk, c] of Object.entries(r.books || {})) if (c.ev?.bookFair || c.lineDiffers) o.push({ r, bk, c }); return o; };
  const lp = legs(prodBoard), lb = legs(br);
  const clear = l => l.filter(x => x.c.ev?.bookFair && x.c.ev.ev >= 2);
  say(`\nbook-fair legs: prod ${lp.filter(x => x.c.ev?.bookFair).length} (clearing 2%: ${clear(lp).length}); branch priced ${lb.filter(x => x.c.ev?.bookFair).length} (clearing 2%: ${clear(lb).length}), line differs ${lb.filter(x => x.c.lineDiffers).length}`);
  const show = x => `${x.r.sport} ${x.r.player} ${x.r.mkey} ${x.bk} ${x.c.line}: ` + (x.c.ev?.bookFair ? `ev ${x.c.ev.ev} [${x.c.ev.bookFair}] vs ${(x.r.bookFair?.sources || []).map(s => `${s.book} ${s.line}`).join(',')}` : `LINE DIFFERS (${x.c.lineDiffers.book} ${x.c.lineDiffers.line})`);
  say('PROD clearing:'); clear(lp).forEach(x => say('  ' + show(x)));
  say('BRANCH clearing:'); clear(lb).forEach(x => say('  ' + show(x)));
  say('BRANCH line differs (sample):'); lb.filter(x => x.c.lineDiffers).slice(0, 25).forEach(x => say('  ' + show(x)));
  for (const n of ['Melton', 'Sparks', 'Embiid', 'Nygard', 'Brandsegg']) { say(`named ${n}: prod ` + lp.filter(x => x.r.player.includes(n)).map(show).join(' || ') + ' | branch ' + lb.filter(x => x.r.player.includes(n)).map(show).join(' || ')); }
  try {
    const { chromium } = require('playwright'); const browser = await chromium.launch();
    for (const [name, w, h, mobile] of [['phone', 390, 844, true], ['desktop', 1280, 900, false]]) {
      const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2, isMobile: mobile });
      const page = await ctx.newPage();
      await page.route(/line-reaper-backend-production\.up\.railway\.app/, route => route.continue({ url: route.request().url().replace(/https:\/\/line-reaper-backend-production\.up\.railway\.app/, B) }));
      await page.goto(B + '/app?start=app', { waitUntil: 'domcontentloaded' }); await wait(4000);
      await page.evaluate(() => { const t = [...document.querySelectorAll('.tab')].find(b => b.textContent.trim() === 'BEST PLAYS'); if (t) t.click(); }); await wait(7000);
      await page.screenshot({ path: `out/pl-best-${name}.png` });
      await page.evaluate(() => { const t = [...document.querySelectorAll('.tab')].find(b => b.textContent.trim() === 'PROPS'); if (t) t.click(); }); await wait(5000);
      for (const [tag, setup] of [['cfb-lines', "pbState.sport='CFB';pbState.view='lines';pbState.lineBook='prizepicks'"], ['nhl-lines', "pbState.sport='NHL';pbState.view='lines';pbState.lineBook='underdog'"], ['nfl-lines', "pbState.sport='NFL';pbState.view='lines';pbState.lineBook='prizepicks'"]]) {
        await page.evaluate(s => { eval(s); try { localStorage.setItem('lr_pb_view', pbState.view); } catch (e) {} loadPropsBoard(); }, setup); await wait(6000);
        await page.screenshot({ path: `out/pl-${tag}-${name}.png` });
      }
      await ctx.close();
    }
    await browser.close(); say('renders done');
  } catch (e) { say('render error ' + e.message); }
  srv.kill(); process.exit(0);
})();
