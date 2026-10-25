// Waits for prod to run v3.157.0, then reads /api/shopper and /api/providers
// and renders the odds screen's shopper views at phone and desktop width.
const fs = require('fs');
const B = 'https://line-reaper-backend-production.up.railway.app';
const wait = ms => new Promise(r => setTimeout(r, ms));
const get = async p => { const t = Date.now(); try { const r = await fetch(B + p, { signal: AbortSignal.timeout(60000) }); return { st: r.status, tx: await r.text(), ms: Date.now() - t }; } catch (e) { return { st: 'ERR', tx: JSON.stringify({ error: e.message }), ms: Date.now() - t }; } };
(async () => {
  fs.mkdirSync('out', { recursive: true });
  const polls = [];
  // latency of a cheap endpoint on warm prod, 8 reads 20 s apart
  for (let i = 0; i < 8; i++) { const s = await get('/api/status'); let S = {}; try { S = JSON.parse(s.tx); } catch {} polls.push({ at: new Date().toISOString(), v: S.version, st: s.st, ms: s.ms }); fs.writeFileSync('out/polls.json', JSON.stringify(polls, null, 1)); await wait(20e3); }
  await wait(5e3);
  for (const [n, u] of [['status', '/api/status']]) { const r = await get(u); fs.writeFileSync(`out/${n}.json`, r.tx); polls.push({ view: n, st: r.st, ms: r.ms }); }
  for (const [n, u] of [['shopper', '/api/shopper?limit=300'], ['tx', '/api/shopper?state=TX&limit=300'], ['providers', '/api/providers'], ['shopper2', '/api/shopper?limit=300'], ['calc', '/calc.js'], ['app', '/app']]) {
    const r = await get(u); fs.writeFileSync(`out/${n}.${/calc|app/.test(n) ? 'txt' : 'json'}`, r.tx); polls.push({ view: n, st: r.st, bytes: r.tx.length, ms: r.ms });
  }
  fs.writeFileSync('out/polls.json', JSON.stringify(polls, null, 1));
  try {
    const { chromium } = require('playwright');
    const br = await chromium.launch();
    for (const [w, h, tag] of [[390, 844, 'phone'], [1280, 900, 'desktop']]) {
      const ctx = await br.newContext({ viewport: { width: w, height: h } });
      await ctx.addInitScript(() => { try { sessionStorage.setItem('lr_welcomed', '1'); localStorage.setItem('lr_tab', 'odds'); localStorage.setItem('lr_shopper', JSON.stringify({ state: 'TX', mode: 'opps' })); } catch {} });
      const p = await ctx.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
      await p.goto(B + '/app', { waitUntil: 'domcontentloaded', timeout: 60000 }); await wait(9000);
      await p.screenshot({ path: `out/opps-${tag}.png` });
      await p.evaluate(() => shpSet('mode', 'markets')); await wait(7000);
      await p.screenshot({ path: `out/markets-${tag}.png` });
      await p.evaluate(() => shpSet('mode', 'lines')); await wait(7000);
      await p.screenshot({ path: `out/lines-${tag}.png` });
      fs.writeFileSync(`out/page-${tag}.json`, JSON.stringify({ errs, scrollWidth: await p.evaluate(() => document.documentElement.scrollWidth) }));
      await ctx.close();
    }
    await br.close();
  } catch (e) { fs.writeFileSync('out/render-error.txt', String(e.stack || e)); }
  process.exit(0);
})();
