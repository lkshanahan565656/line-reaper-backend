// Runs this branch's server on live feeds (PINNACLE=on) for MIN minutes, polls the
// book arbs counts each minute, snapshots /api/xarbs every 5 minutes and the fill
// record at the end, then renders the ARBS tab at phone and desktop width.
const fs = require('fs'); const { spawn } = require('child_process');
const B = 'http://localhost:3999';
const MIN = parseInt(process.env.MIN || '25');
const wait = ms => new Promise(r => setTimeout(r, ms));
const get = async (u) => { try { const r = await fetch(u, { signal: AbortSignal.timeout(120000) }); return { st: r.status, tx: await r.text() }; } catch (e) { return { st: 'ERR', tx: JSON.stringify({ error: e.message }) }; } };
const J = x => { try { return JSON.parse(x.tx); } catch { return {}; } };
(async () => {
  fs.mkdirSync('out', { recursive: true }); fs.mkdirSync('/tmp/lr', { recursive: true });
  const srv = spawn('node', ['server.js'], { env: { ...process.env, PORT: '3999', LR_DATA_DIR: '/tmp/lr', PINNACLE: 'on' }, stdio: ['ignore', fs.openSync('out/server.log', 'w'), fs.openSync('out/server.err', 'w')] });
  const polls = [];
  for (let i = 0; i < MIN; i++) {
    await wait(60e3);
    const st = J(await get(B + '/api/status'));
    const x = J(await get(B + '/api/xarbs'));
    polls.push({ at: new Date().toISOString(), book: st.bookArbs, job: st.tail?.jobs?.bookArbs, record: x.books?.record, fbAt: st.freeBooks?.gamesAt, xarbCounts: st.xarb?.counts && { kalshiMarkets: st.xarb.counts.kalshiMarkets, us: st.xarb.counts.polymarketUs?.rows } });
    fs.writeFileSync('out/polls.json', JSON.stringify(polls, null, 1));
    if (i % 5 === 4) fs.writeFileSync(`out/xarbs-${String(i + 1).padStart(2, '0')}.json`, JSON.stringify(x.books || {}, null, 1));
  }
  for (const [n, u] of [['xarbs', B + '/api/xarbs'], ['record', B + '/api/book-arbs/record?limit=2000'], ['status', B + '/api/status']]) {
    const r = await get(u); fs.writeFileSync(`out/${n}.json`, r.tx);
  }
  try {
    const { chromium } = require('playwright');
    const br = await chromium.launch();
    for (const [w, h, tag] of [[390, 844, 'phone'], [1280, 900, 'desktop']]) {
      const ctx = await br.newContext({ viewport: { width: w, height: h } });
      await ctx.addInitScript(() => { try { sessionStorage.setItem('lr_welcomed', '1'); } catch {} });
      const p = await ctx.newPage();
      await p.goto(B + '/app', { waitUntil: 'domcontentloaded', timeout: 60000 });
      await wait(4000);
      await p.evaluate(() => { showTab('arb', document.querySelector('.tab[onclick*="\'arb\'"]')); arbMode('exchanges'); });
      await wait(8000);
      await p.screenshot({ path: `out/arbs-all-${tag}.png`, fullPage: false });
      await p.evaluate(() => xarbSet('venues', 'books')); await wait(1000);
      await p.screenshot({ path: `out/arbs-books-${tag}.png`, fullPage: true });
      await p.evaluate(() => arbMode('books')); await wait(4000);
      await p.screenshot({ path: `out/arbs-oddsapi-${tag}.png`, fullPage: false });
      await ctx.close();
    }
    await br.close();
  } catch (e) { fs.writeFileSync('out/render-error.txt', String(e.stack || e)); }
  srv.kill();
})();
