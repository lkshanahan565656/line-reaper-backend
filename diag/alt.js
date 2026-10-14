// Runs this branch's server on live feeds (PINNACLE=on) for MIN minutes, polls the
// alt-lines counts, snapshots /api/ev and /api/ev/record, reads prod's BIG MONEY,
// then renders the +EV tab's ALT LINES view and TRACK RECORD at phone and desktop width.
const fs = require('fs'); const { spawn } = require('child_process');
const B = 'http://localhost:3999', PROD = 'https://line-reaper-backend-production.up.railway.app';
const MIN = parseInt(process.env.MIN || '24');
const wait = ms => new Promise(r => setTimeout(r, ms));
const get = async (u) => { try { const r = await fetch(u, { signal: AbortSignal.timeout(120000) }); return { st: r.status, tx: await r.text() }; } catch (e) { return { st: 'ERR', tx: JSON.stringify({ error: e.message }) }; } };
const J = x => { try { return JSON.parse(x.tx); } catch { return {}; } };
(async () => {
  fs.mkdirSync('out', { recursive: true }); fs.mkdirSync('/tmp/lr', { recursive: true });
  const srv = spawn('node', ['server.js'], { env: { ...process.env, PORT: '3999', LR_DATA_DIR: '/tmp/lr', PINNACLE: 'on' }, stdio: ['ignore', fs.openSync('out/server.log', 'w'), fs.openSync('out/server.err', 'w')] });
  const polls = [];
  for (let i = 0; i < MIN; i++) {
    await wait(60e3);
    const st = J(await get(B + '/api/status')), e = J(await get(B + '/api/ev?limit=50'));
    polls.push({ at: new Date().toISOString(), alt: st.ev?.alt, counts: e.counts, fb: st.freeBooks && { gamesAt: st.freeBooks.gamesAt, errors: st.freeBooks.errors, counts: st.freeBooks.counts } });
    fs.writeFileSync('out/polls.json', JSON.stringify(polls, null, 1));
  }
  for (const [n, u] of [['ev', B + '/api/ev?limit=1000'], ['record', B + '/api/ev/record'], ['status', B + '/api/status'], ['prod-status', PROD + '/api/status'], ['prod-big', PROD + '/api/big-money']]) {
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
      await p.evaluate(() => { showTab('ev', document.querySelector('.tab[onclick*="\'ev\'"]')); });
      await wait(6000);
      await p.evaluate(() => evSet('kind', 'alt')); await wait(1500);
      await p.screenshot({ path: `out/alt-${tag}.png`, fullPage: false });
      await p.evaluate(() => { evState.altModel = true; renderEv(); }); await wait(800);
      await p.screenshot({ path: `out/alt-model-${tag}.png`, fullPage: false });
      await p.evaluate(() => evSet('kind', 'record')); await wait(4000);
      await p.screenshot({ path: `out/record-${tag}.png`, fullPage: true });
      await p.evaluate(() => evSet('kind', 'all')); await wait(1500);
      await p.screenshot({ path: `out/all-${tag}.png`, fullPage: false });
      await ctx.close();
    }
    await br.close();
  } catch (e) { fs.writeFileSync('out/render-error.txt', String(e.stack || e)); }
  srv.kill();
})();
