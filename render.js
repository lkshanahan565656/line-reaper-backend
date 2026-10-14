const { chromium } = require('playwright');
const fs = require('fs');
const U = 'https://line-reaper-backend-production.up.railway.app';
const TABS = ['best','lines','props','sharp','esports','ev','tail','arb','results','gas','tools','betlog','clv','shop'];
const DEAD = ['bet-action-btn','bet-actions','bet-log-form','bet-result','es-bookev','es-lean','es-num','es-pill','es-plays','esm-bet','esm-meter','esm-team','esm-teams','form-grid','form-group','form-input','form-label','form-select','form-title','log-btn'];
const mode = process.argv[2]; // 'swap' (before/after html) or 'live'
(async () => {
  const browser = await chromium.launch();
  const report = {};
  const variants = mode === 'live' ? ['live'] : ['before', 'after'];
  for (const v of variants) for (const [w, h, tag] of [[390, 844, 'phone'], [1280, 900, 'desktop']]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h } });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push('pageerror: ' + e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 200)); });
    if (v !== 'live') await page.route(U + '/app', r => r.fulfill({ status: 200, contentType: 'text/html', body: fs.readFileSync(`html/${v}.html`, 'utf8') }));
    await page.goto(U + '/app', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(8000);
    for (const t of TABS) {
      const r = await page.evaluate(async ({ t, DEAD }) => {
        const el = [...document.querySelectorAll('.tab')].find(x => (x.getAttribute('onclick') || '').includes(`'${t}'`));
        try { showTab(t, el || null); } catch (e) { return { err: e.message }; }
        await new Promise(res => setTimeout(res, 7000));
        const pg = document.getElementById('page-' + t);
        const deadHits = DEAD.filter(c => document.getElementsByClassName(c).length);
        return { textLen: pg ? pg.innerText.trim().length : -1, height: pg ? pg.scrollHeight : -1, deadHits, version: document.title };
      }, { t, DEAD });
      await page.screenshot({ path: `out/${v}-${t}-${tag}.png`, fullPage: false });
      report[`${v}/${tag}/${t}`] = r;
    }
    report[`${v}/${tag}/errors`] = errors;
    await ctx.close();
  }
  fs.writeFileSync(`out/report-${mode}.json`, JSON.stringify(report, null, 1));
  await browser.close();
})();
