// One-shot live check of the installable app: the worker takes over /app,
// caches the shell, the manifest parses, shortcuts open, push key answers.
const { chromium } = require('playwright');
const SITE = process.env.SITE;
(async () => {
  const out = {};
  const b = await chromium.launch();
  const ctx = await b.newContext({ serviceWorkers: 'allow' });
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push(String(e.message).slice(0, 200)));
  await p.goto(`${SITE}/app?start=install`, { waitUntil: 'load', timeout: 90000 });
  out.controller = await p.waitForFunction(() => !!navigator.serviceWorker?.controller, null, { timeout: 30000 }).then(() => true, () => false);
  out.swScript = await p.evaluate(() => navigator.serviceWorker?.controller?.scriptURL || null);
  out.caches = await p.evaluate(async () => { const ks = await caches.keys(); const o = {}; for (const k of ks) o[k] = (await (await caches.open(k)).keys()).map(r => new URL(r.url).pathname).slice(0, 12); return o; });
  out.ui = await p.evaluate(() => ({ stepsOpen: document.getElementById('pwaSteps')?.open, layOpen: document.getElementById('layModal')?.classList.contains('open'), pushBtn: document.getElementById('pushBtn')?.textContent, discordRowHidden: document.getElementById('layDiscordRow')?.hidden, pushBtns: document.querySelectorAll('#pushBtn').length, offBannerHidden: document.getElementById('offBanner')?.hidden, pwaBar: !!document.getElementById('pwaBar') }));
  out.manifestLink = await p.evaluate(() => document.querySelector('link[rel=manifest]')?.href);
  out.pageErrors = errs;
  for (const sc of ['odds', 'results', 'betlog', 'alerts']) {
    const q = await ctx.newPage();
    await q.goto(`${SITE}/app?start=${sc}`, { waitUntil: 'load', timeout: 90000 });
    await q.waitForTimeout(2500);
    out[`shortcut_${sc}`] = await q.evaluate(() => document.querySelector('.page.active')?.id || null);
    await q.close();
  }
  console.log(JSON.stringify(out, null, 1));
  await b.close();
})().catch(e => { console.log('CRASH', e.message); process.exit(1); });
