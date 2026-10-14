// Runs this branch's server on live feeds (PINNACLE=on) for MIN minutes: polls
// the stale-lines status each minute, snapshots /api/ev every 5 minutes and the
// record at the end, then renders the STALE view at phone and desktop width.
const fs = require('fs'); const { spawn } = require('child_process');
const B = 'http://localhost:3999';
const MIN = parseInt(process.env.MIN || '60');
const wait = ms => new Promise(r => setTimeout(r, ms));
const get = async (u) => { try { const r = await fetch(u, { signal: AbortSignal.timeout(120000) }); return { st: r.status, tx: await r.text() }; } catch (e) { return { st: 'ERR', tx: JSON.stringify({ error: e.message }) }; } };
const J = x => { try { return JSON.parse(x.tx); } catch { return {}; } };
async function render(tag0) {
  try {
    const { chromium } = require('playwright');
    const br = await chromium.launch();
    for (const [w, h, tag] of [[390, 844, 'phone'], [1280, 900, 'desktop']]) {
      const ctx = await br.newContext({ viewport: { width: w, height: h } });
      await ctx.addInitScript(() => { try { sessionStorage.setItem('lr_welcomed', '1'); localStorage.setItem('lr_ev', JSON.stringify({ kind: 'stale', minEv: 0 })); } catch {} });
      const p = await ctx.newPage();
      await p.goto(B + '/app', { waitUntil: 'domcontentloaded', timeout: 60000 });
      await wait(4000);
      await p.evaluate(() => { const t = document.querySelector('.tab[onclick*="\'ev\'"]'); showTab('ev', t); });
      await wait(6000);
      await p.evaluate(() => { evSet('minEv', 0); evSet('kind', 'stale'); document.querySelectorAll('details').forEach(d => d.open = true); });
      await wait(1500);
      await p.screenshot({ path: `out/${tag0}-stale-${tag}.png`, fullPage: true });
      await p.evaluate(() => evSet('kind', 'record')); await wait(6000);
      await p.screenshot({ path: `out/${tag0}-record-${tag}.png`, fullPage: true });
      await ctx.close();
    }
    await br.close();
  } catch (e) { fs.writeFileSync(`out/render-error-${tag0}.txt`, String(e.stack || e)); }
}
(async () => {
  fs.mkdirSync('out', { recursive: true }); fs.mkdirSync('/tmp/lr', { recursive: true });
  const srv = spawn('node', ['server.js'], { env: { ...process.env, PORT: '3999', LR_DATA_DIR: '/tmp/lr', PINNACLE: 'on' }, stdio: ['ignore', fs.openSync('out/server.log', 'w'), fs.openSync('out/server.err', 'w')] });
  const polls = [];
  for (let i = 0; i < MIN; i++) {
    await wait(60e3);
    const st = J(await get(B + '/api/status'));
    polls.push({ at: new Date().toISOString(), stale: st.ev?.stale, fbAt: st.freeBooks?.gamesAt, pinProps: st.pinnacleProps || null, fbErr: st.freeBooks?.errors });
    fs.writeFileSync('out/polls.json', JSON.stringify(polls, null, 1));
    if (i % 5 === 4) { const ev = J(await get(B + '/api/ev?limit=50')); fs.writeFileSync(`out/ev-${String(i + 1).padStart(2, '0')}.json`, JSON.stringify({ stale: ev.stale, counts: ev.counts, staleLag: ev.staleLag }, null, 1)); }
    if (i === 29) await render('mid');
  }
  for (const [n, u] of [['ev', B + '/api/ev?limit=1000'], ['record', B + '/api/ev/record'], ['bets', B + '/api/ev/record/bets?stale=1&limit=500'], ['props-record', B + '/api/props/record'], ['status', B + '/api/status']]) {
    const r = await get(u); fs.writeFileSync(`out/${n}.json`, r.tx);
  }
  await render('end');
  srv.kill();
})();
