// Before/after: prod (main) and this branch's server asked for every view at
// the same moment, then phone and desktop renders of +EV, PROPS and Best Plays.
const fs = require('fs'); const { spawn } = require('child_process');
const B = 'http://localhost:3999', P = 'https://line-reaper-backend-production.up.railway.app';
const wait = ms => new Promise(r => setTimeout(r, ms));
const get = async u => { const t = Date.now(); try { const r = await fetch(u, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(180000) }); const txt = await r.text(); try { return { _ms: Date.now() - t, ...JSON.parse(txt) }; } catch { return { error: r.status, body: txt.slice(0, 300) }; } } catch (e) { return { error: e.message }; } };
const VIEWS = { ev: '/api/ev?limit=1000', xarbs: '/api/xarbs', best: '/api/best?limit=500', autoslips: '/api/esports/auto-slips', coverage: '/api/props/coverage', status: '/api/status', record: '/api/props/record' };
for (const b of ['prizepicks', 'underdog', 'sleeper', 'pick6']) VIEWS['lines_' + b] = `/api/props/board?sport=ALL&book=${b}&facets=1&limit=1`;
async function board(base) { const rows = []; let total = 0; for (let off = 0; off < 60000; off += 500) { const d = await get(`${base}/api/props/board?sport=ALL&sort=start&limit=500&offset=${off}`); rows.push(...(d.rows || [])); total = d.total; if (!d.rows || d.rows.length < 500) break; } return { rows, total }; }
async function views(base) { const o = { at: new Date().toISOString() }; await Promise.all(Object.entries(VIEWS).map(async ([k, p]) => { o[k] = await get(base + p); })); o.board = await board(base); o.end = new Date().toISOString(); return o; }
(async () => {
  fs.mkdirSync('out', { recursive: true }); fs.mkdirSync('/tmp/lr', { recursive: true });
  const srv = spawn('node', ['--max-old-space-size=6000', 'server.js'], { env: { ...process.env, PORT: '3999', LR_DATA_DIR: '/tmp/lr', PINNACLE: 'on' }, stdio: ['ignore', fs.openSync('out/server.log', 'w'), fs.openSync('out/server.err', 'w')] });
  await wait(+(process.env.WARM || 18) * 60e3);
  for (let i = 0; i < +(process.env.SNAPS || 2); i++) {
    const [prod, local] = await Promise.all([views(P), views(B)]);
    fs.writeFileSync(`out/prod${i}.json`, JSON.stringify(prod)); fs.writeFileSync(`out/local${i}.json`, JSON.stringify(local));
    console.log(`snap ${i}: prod ev ${prod.ev?.rows?.length} board ${prod.board.rows.length}; local ev ${local.ev?.rows?.length} board ${local.board.rows.length}`);
    if (i < +(process.env.SNAPS || 2) - 1) await wait(+(process.env.SNAPGAP || 3) * 60e3);
  }
  try {
    const { chromium } = require('playwright');
    const browser = await chromium.launch();
    for (const [name, w, h, mobile] of [['phone', 390, 844, true], ['desktop', 1280, 900, false]]) {
      const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2, isMobile: mobile });
      const page = await ctx.newPage();
      await page.route(/line-reaper-backend-production\.up\.railway\.app/, route => route.continue({ url: route.request().url().replace(/https:\/\/line-reaper-backend-production\.up\.railway\.app/, B) }));
      await page.goto(B + '/app?start=app', { waitUntil: 'domcontentloaded' }); await wait(4000);
      for (const tab of ['ev', 'best']) {
        await page.evaluate(t => { const b = [...document.querySelectorAll('.tab')].find(x => (x.getAttribute('onclick') || '').includes(`'${t}'`)); if (b) b.click(); }, tab);
        await wait(9000);
        await page.screenshot({ path: `out/r-${tab}-${name}.png`, fullPage: false });
      }
      await page.evaluate(() => { const b = [...document.querySelectorAll('.tab')].find(x => (x.getAttribute('onclick') || '').includes("'props'")); if (b) b.click(); });
      await wait(5000);
      for (const [tag, setup] of [['nfl-cards', "pbState.sport='NFL';pbState.view='cards';pbState.sort='ev';pbState.show='priced'"], ['nfl-lines', "pbState.sport='NFL';pbState.view='lines';pbState.lineBook='sleeper'"]]) {
        await page.evaluate(s => { try { eval(s); localStorage.setItem('lr_pb_view', pbState.view); loadPropsBoard(); } catch (e) {} }, setup);
        await wait(7000);
        await page.screenshot({ path: `out/r-props-${tag}-${name}.png`, fullPage: false });
      }
      await ctx.close();
    }
    await browser.close(); console.log('renders done');
  } catch (e) { console.log('render error ' + e.message); }
  srv.kill(); process.exit(0);
})();
