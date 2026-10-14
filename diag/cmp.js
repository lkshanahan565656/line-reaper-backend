// main and this branch side by side on live feeds (PINNACLE=on), then counts and renders
const fs = require('fs'); const { spawn } = require('child_process');
const MIN = parseInt(process.env.MIN || '20');
const M = 'http://localhost:3998', B = 'http://localhost:3999';
const wait = ms => new Promise(r => setTimeout(r, ms));
const get = async u => { try { const r = await fetch(u, { signal: AbortSignal.timeout(120000) }); return { st: r.status, tx: await r.text() }; } catch (e) { return { st: 'ERR', tx: JSON.stringify({ error: e.message }) }; } };
const J = x => { try { return JSON.parse(x.tx); } catch { return {}; } };
const start = (dir, port, extra = {}) => { fs.mkdirSync(`/tmp/lr${port}`, { recursive: true }); return spawn('node', ['server.js'], { cwd: dir, env: { ...process.env, PORT: String(port), LR_DATA_DIR: `/tmp/lr${port}`, PINNACLE: 'on', ...extra }, stdio: ['ignore', fs.openSync(`out/server-${port}.log`, 'w'), fs.openSync(`out/server-${port}.err`, 'w')] }); };
function evCounts(e) {
  const rows = e.rows || [];
  const by = f => rows.reduce((m, r) => { const k = f(r); m[k] = (m[k] || 0) + 1; return m; }, {});
  const p2 = rows.filter(r => r.ev >= 2 && !r.dfs);
  return { rows: rows.length, ev2: p2.length, ev2agree: p2.filter(r => r.agree).length, ev2ByBook: p2.reduce((m, r) => { m[r.book] = (m[r.book] || 0) + 1; return m; }, {}),
    agreeByBook: p2.filter(r => r.agree).reduce((m, r) => { m[r.book] = (m[r.book] || 0) + 1; return m; }, {}),
    fairSources: by(r => (r.sharpBooks || []).slice().sort().join('+')), dfs2: rows.filter(r => r.dfs && r.ev >= 2).length,
    esports: e.esports ? { n: (e.esports.rows || e.esports).length } : null, counts: e.counts };
}
(async () => {
  fs.mkdirSync('out', { recursive: true });
  const sm = start('mn', 3998), sb = start('br', 3999, { BOVADA_ESPORTS: 'on' });
  const polls = [];
  for (let i = 0; i < MIN; i++) {
    await wait(60e3);
    const out = { at: new Date().toISOString() };
    for (const [k, U] of [['main', M], ['branch', B]]) {
      const st = J(await get(U + '/api/status')), e = J(await get(U + '/api/ev?limit=2000'));
      out[k] = { version: st.version, ev: evCounts(e), esports: st.ev?.esports, freeBooks: st.freeBooks?.counts, more: st.moreBooks, alt: st.ev?.alt };
    }
    polls.push(out); fs.writeFileSync('out/polls.json', JSON.stringify(polls, null, 1));
  }
  for (const [k, U] of [['main', M], ['branch', B]]) {
    for (const [n, path] of [['ev', '/api/ev?limit=3000'], ['status', '/api/status'], ['board', '/api/props/board?facets=1'], ['esev', '/api/ev?kind=esports&limit=500'], ['probe', '/api/esports/probe/books?only=actionnetwork,matchbook,bovada']]) {
      const r = await get(U + path); fs.writeFileSync(`out/${k}-${n}.json`, r.tx);
    }
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
      await p.screenshot({ path: `out/ev-${tag}.png`, fullPage: false });
      try { await p.evaluate(() => evSet('kind', 'esports')); await wait(2000); await p.screenshot({ path: `out/esev-${tag}.png`, fullPage: false }); } catch {}
      await p.evaluate(() => { showTab('props', document.querySelector('.tab[onclick*="\'props\'"]')); });
      await wait(6000);
      for (const bk of ['prizepicks', 'underdog']) {
        try { await p.evaluate(b => pbSet('book', b), bk); await wait(5000); await p.screenshot({ path: `out/lines-${bk}-${tag}.png`, fullPage: false }); } catch {}
      }
      await ctx.close();
    }
    await br.close();
  } catch (e) { fs.writeFileSync('out/render-error.txt', String(e.stack || e)); }
  sm.kill(); sb.kill();
})();
