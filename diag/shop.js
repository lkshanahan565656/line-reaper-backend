// One-shot: runs this branch's server on live feeds (PINNACLE=on) for MIN
// minutes, snapshots /api/shopper views and /api/providers, then renders the
// SHOPPER tab at phone and desktop width. Records nothing.
const fs = require('fs'); const { spawn } = require('child_process');
const B = 'http://localhost:3999';
const MIN = parseInt(process.env.MIN || '6');
const wait = ms => new Promise(r => setTimeout(r, ms));
const get = async (u) => { try { const r = await fetch(u, { signal: AbortSignal.timeout(120000) }); return { st: r.status, tx: await r.text() }; } catch (e) { return { st: 'ERR', tx: JSON.stringify({ error: e.message }) }; } };
const J = x => { try { return JSON.parse(x.tx); } catch { return {}; } };
(async () => {
  fs.mkdirSync('out', { recursive: true }); fs.mkdirSync('/tmp/lr', { recursive: true });
  spawn('node', ['server.js'], { env: { ...process.env, PORT: '3999', LR_DATA_DIR: '/tmp/lr', PINNACLE: 'on' }, stdio: ['ignore', fs.openSync('out/server.log', 'w'), fs.openSync('out/server.err', 'w')] });
  const polls = [];
  for (let i = 0; i < MIN; i++) {
    await wait(60e3);
    const s = J(await get(B + '/api/shopper?limit=5'));
    const t1 = Date.now(); await get(B + '/calc.js'); const staticMs = Date.now() - t1;
    polls.push({ at: new Date().toISOString(), counts: s.counts, ms: s.buildMs, staticMs, providers: (s.providers || []).map(p => `${p.id}:${p.status}:${p.quotes}`) });
    fs.writeFileSync('out/polls.json', JSON.stringify(polls, null, 1));
  }
  const views = [['all', '/api/shopper?limit=1000&hours=168'], ['tx', '/api/shopper?state=TX&limit=1000&hours=168'], ['props', '/api/shopper?markets=player_prop&limit=300'],
    ['arbs', '/api/shopper?arbs=1&limit=200&hours=168'], ['lowhold', '/api/shopper?sort=hold&limit=200'], ['shin', '/api/shopper?method=shin&limit=200'],
    ['providers', '/api/providers'], ['status', '/api/status'], ['ev', '/api/ev?limit=1000']];
  for (const [n, u] of views) { const t0 = Date.now(); const r = await get(B + u); fs.writeFileSync(`out/${n}.json`, r.tx); polls.push({ view: n, st: r.st, bytes: r.tx.length, ms: Date.now() - t0 }); }
  fs.writeFileSync('out/polls.json', JSON.stringify(polls, null, 1));
  try {
    const { chromium } = require('playwright');
    const br = await chromium.launch();
    for (const [w, h, tag] of [[390, 844, 'phone'], [1280, 900, 'desktop']]) {
      const ctx = await br.newContext({ viewport: { width: w, height: h } });
      await ctx.addInitScript(() => { try { sessionStorage.setItem('lr_welcomed', '1'); localStorage.setItem('lr_shopper', JSON.stringify({ state: '', mode: 'lines' })); localStorage.setItem('lr_tab', 'odds'); } catch {} });
      const p = await ctx.newPage();
      const errs = []; p.on('pageerror', e => errs.push(e.message));
      await p.goto(B + '/app', { waitUntil: 'domcontentloaded', timeout: 60000 });
      await wait(4000);
      await p.evaluate(() => { showTab('odds', document.querySelector('.tab[onclick*="\'odds\'"]')); });
      await wait(6000);
      await p.screenshot({ path: `out/lines-${tag}.png`, fullPage: false });
      await p.evaluate(() => shpSet('mode', 'opps')); await wait(8000);
      await p.screenshot({ path: `out/opps-${tag}.png`, fullPage: false });
      await p.evaluate(() => { const k = shpUi.data?.opportunities?.[0]?.key; if (k) shpOpen(k); }); await wait(800);
      await p.screenshot({ path: `out/opps-open-${tag}.png`, fullPage: false });
      await p.evaluate(() => shpSet('mode', 'markets')); await wait(6000);
      await p.screenshot({ path: `out/markets-${tag}.png`, fullPage: false });
      await p.evaluate(() => shpSet('state', 'TX')); await wait(6000);
      await p.screenshot({ path: `out/markets-tx-${tag}.png`, fullPage: false });
      await p.evaluate(() => { shpSet('markets', 'player_prop'); }); await wait(6000);
      await p.screenshot({ path: `out/props-${tag}.png`, fullPage: false });
      await p.evaluate(() => { shpSet('markets', ''); shpSet('mode', 'arb'); }); await wait(6000);
      await p.screenshot({ path: `out/arbs-${tag}.png`, fullPage: false });
      await p.evaluate(() => { document.querySelector('#shpVenues').open = true; shpSet('fmt', 'decimal', false); shpSet('mode', 'markets'); }); await wait(6000);
      await p.screenshot({ path: `out/venues-decimal-${tag}.png`, fullPage: false });
      const wide = await p.evaluate(() => document.documentElement.scrollWidth);
      fs.writeFileSync(`out/page-${tag}.json`, JSON.stringify({ errs, scrollWidth: wide, viewport: w }));
      await ctx.close();
    }
    await br.close();
  } catch (e) { fs.writeFileSync('out/render-error.txt', String(e.stack || e)); }
  process.exit(0);
})();
