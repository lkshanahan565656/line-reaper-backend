const { chromium } = require('playwright');
const fs = require('fs');
const U = 'https://line-reaper-backend-production.up.railway.app';
const TAG = process.argv[2] || 'before';
const TABS = (fs.existsSync('TABS') ? fs.readFileSync('TABS','utf8').trim().split(/\s+/) : ['best','tail','arb','big','gas','esports','results','betlog','myslips','tools','lines','shop','props','ev','sharp','clv']);
const EXTRA = fs.existsSync('EXTRA') ? JSON.parse(fs.readFileSync('EXTRA','utf8')) : [];
(async () => {
  const browser = await chromium.launch();
  const report = {};
  fs.mkdirSync('out/snap', { recursive: true });
  let nsnap = 0; const seen = new Set();
  for (const [w, h, tag] of [[390, 844, 'phone'], [1280, 900, 'desktop']]) {
    // landing page
    {
      const ctx = await browser.newContext({ viewport: { width: w, height: h } });
      const page = await ctx.newPage();
      await page.goto(U + '/', { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {});
      await page.waitForTimeout(3000);
      await page.screenshot({ path: `out/${TAG}-landing-${tag}.png`, fullPage: true });
      report[`${tag}/landing`] = { text: (await page.evaluate(() => document.body.innerText)).slice(0, 20000) };
      await ctx.close();
    }
    for (const x of EXTRA) {
      const ctx = await browser.newContext({ viewport: { width: w, height: h } });
      await ctx.addInitScript(() => { try { sessionStorage.setItem('lr_welcomed', '1'); } catch {} });
      const page = await ctx.newPage();
      await page.goto(U + x.path, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      await page.waitForTimeout(x.wait || 12000);
      await page.screenshot({ path: `out/${TAG}-${x.name}-${tag}.png`, fullPage: !!x.full });
      report[`${tag}/${x.name}`] = { text: (await page.evaluate(() => document.body.innerText)).slice(0, 20000) };
      await ctx.close();
    }
    const ctx = await browser.newContext({ viewport: { width: w, height: h } });
    await ctx.addInitScript(() => { try { sessionStorage.setItem('lr_welcomed', '1'); } catch {} });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push('pageerror: ' + e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 200)); });
    page.on('response', async r => {
      try {
        const url = r.url();
        if (!url.startsWith(U + '/api/') || tag !== 'desktop') return;
        const key = url.slice(U.length);
        if (seen.has(key)) return; seen.add(key);
        const b = await r.body();
        if (b.length > 15e6) return;
        const f = 'out/snap/' + (nsnap++) + '.bin';
        fs.writeFileSync(f, b);
        fs.appendFileSync('out/snap/index.jsonl', JSON.stringify({ key, f, status: r.status(), ct: r.headers()['content-type'] || '' }) + '\n');
      } catch {}
    });
    await page.goto(U + '/app', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(10000);
    for (const t of TABS) {
      const r = await page.evaluate(async ({ t }) => {
        const el = [...document.querySelectorAll('.tab')].find(x => (x.getAttribute('onclick') || '').includes(`'${t}'`));
        try { showTab(t, el || null); } catch (e) { return { err: e.message }; }
        await new Promise(res => setTimeout(res, 9000));
        const pg = document.getElementById('page-' + t);
        return { text: pg ? pg.innerText.trim().slice(0, 15000) : '', height: pg ? pg.scrollHeight : -1, sw: document.documentElement.scrollWidth };
      }, { t });
      await page.screenshot({ path: `out/${TAG}-${t}-${tag}.png`, fullPage: tag === 'phone' ? false : false });
      report[`${tag}/${t}`] = r;
    }
    report[`${tag}/errors`] = errors;
    await ctx.close();
  }
  fs.writeFileSync(`out/report-${TAG}.json`, JSON.stringify(report, null, 1));
  await browser.close();
})();
