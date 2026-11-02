// npm run cold: a cold boot, the way a customer running their own copy or a
// fresh Railway container sees the site. No recorded snapshot, no results
// backup, no keys, every outbound call refused (harness.offline). Then:
//   - every GET route under /api without a path parameter, and the public
//     API's documented endpoints: no 5xx, JSON that parses, no NaN or
//     "undefined" in it
//   - every public page, and every app tab at phone and desktop size: no page
//     error, no console error, no 5xx, no visible undefined / NaN /
//     [object Object], nothing wider than a phone
// Exits 1 with the list on any failure. Runs in well under a minute.
'use strict';
const { chromium } = require('playwright');
const harness = require('./harness');
const { openTab, enterApp, newAppPage, watch, makeReport, checkText, checkOverflow, settle, TABS } = require('./crawl');

// every page in the sitemap, plus the pages it leaves out
const EXTRA_PAGES = ['/r', '/alerts', '/lines', '/status'];
const VIEWPORTS = {
  desktop: { viewport: { width: 1280, height: 860 } },
  phone: { viewport: { width: 375, height: 667 }, isMobile: true, hasTouch: true },
};
const BAD_TEXT = /\bundefined\b|\bNaN\b|\[object Object\]|\bInfinity\b/;

// GET routes the server registers, without a path parameter
function apiRoutes(app) {
  const out = new Set();
  for (const l of app._router?.stack || []) {
    const r = l.route;
    if (!r || !r.methods?.get) continue;
    // a path parameter gets a value nothing matches: the answer must still be clean (a 404, not a 500)
    for (const p of [].concat(r.path)) if (typeof p === 'string' && p.startsWith('/api/') && !p.includes('*')) out.add(p.replace(/:(\w+)\??/g, 'cold-boot-unknown'));
  }
  return [...out].sort();
}
// routes that hold a connection open or are not a JSON read
const SKIP = /\/stream$|\/alerts$|^\/api\/results\/backup$|^\/api\/ops\/(heap|profile)$/;

const unavailable = [];
async function sweepApi(base, routes, fails) {
  for (const p of routes) {
    if (SKIP.test(p)) continue;
    let r, text;
    try { r = await fetch(base + p, { signal: AbortSignal.timeout(8000) }); text = await r.text(); } catch (e) { fails.push({ where: p, what: `no answer: ${e.message}` }); continue; }
    const json = /json/.test(r.headers.get('content-type') || '');
    // 503 is the honest "not ready / off on this server" answer, and 502 a diagnostic
    // probe saying its upstream did not answer, as long as either says why in JSON
    if (r.status >= 500 && !((r.status === 503 || (r.status === 502 && /\/probe\//.test(p))) && json)) { fails.push({ where: p, what: `HTTP ${r.status}`, body: text.slice(0, 160) }); continue; }
    if (r.status >= 500) unavailable.push(`${p} ${r.status}`);
    if (json) {
      let body;
      try { body = JSON.parse(text); } catch { fails.push({ where: p, what: 'JSON that does not parse' }); continue; }
      const bad = [];
      (function walk(v, at) {
        if (bad.length > 2) return;
        if (typeof v === 'string' && BAD_TEXT.test(v)) bad.push(`${at}: ${v.slice(0, 80)}`);
        else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, `${at}.${k}`);
      })(body, '');
      if (bad.length) fails.push({ where: p, what: 'bad text in JSON', body: bad.join(' | ') });
    }
  }
}

async function main() {
  const t0 = Date.now();
  const h = await harness.start({ snapshot: { recordedAt: null, responses: {} } });
  const S = require('../server');
  const routes = apiRoutes(S.app);
  const fails = [];
  await sweepApi(h.base, routes, fails);
  const tApi = Date.now();
  const sitemap = await fetch(h.base + '/sitemap.xml').then(r => r.text()).catch(() => '');
  const PAGES = [...new Set([...[...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => new URL(m[1]).pathname), ...EXTRA_PAGES])];
  if (PAGES.length < 10) fails.push({ where: '/sitemap.xml', what: `lists only ${PAGES.length} pages` });

  const pagesN = PAGES.length;
  const browser = await chromium.launch();
  const reports = [];
  for (const [vp, opt] of Object.entries(VIEWPORTS)) {
    const ctx = await browser.newContext({ ...opt, serviceWorkers: 'block' });
    await ctx.route('**/*', r => (r.request().url().startsWith(h.base) || /^(data|blob):/.test(r.request().url()) ? r.continue() : r.abort()));
    const opts = { base: h.base, viewportName: vp, settleMax: 2500, ignoreConsole: [] };
    const rep = makeReport();
    // public pages
    const pg = await ctx.newPage();
    const pw = watch(pg, rep, opts);
    for (const p of PAGES) {
      pw.tab = p;
      const res = await pg.goto(h.base + p, { waitUntil: 'domcontentloaded' }).catch(e => ({ status: () => 0, e }));
      if (res.status() >= 400) fails.push({ where: `${vp} ${p}`, what: `HTTP ${res.status()}` });
      await settle(pg, pw, opts, 150);
      const txt = await pg.evaluate(() => document.body.innerText).catch(() => '');
      const m = BAD_TEXT.exec(txt);
      if (m) fails.push({ where: `${vp} ${p}`, what: `shows "${m[0]}"`, body: txt.slice(Math.max(0, m.index - 60), m.index + 40).replace(/\s+/g, ' ') });
      if (vp === 'phone') {
        const w = await pg.evaluate(() => document.documentElement.scrollWidth).catch(() => 0);
        if (w > 375) fails.push({ where: `phone ${p}`, what: `page is ${w}px wide` });
      }
    }
    await pg.close();
    // the app, every tab
    const page = await newAppPage(ctx, opts);
    const w = watch(page, rep, opts);
    await enterApp(page, w, opts, rep);
    for (const t of TABS) {
      try {
        await openTab(page, t, w, opts);
        await settle(page, w, opts, 150);
        await checkText(page, rep, `${vp} ${t}`);
        await checkOverflow(page, rep, t, 'open', opts);
        if (process.env.COLD_SHOTS) await page.screenshot({ path: `${process.env.COLD_SHOTS}/${vp}-${t}.png` });
      } catch (e) { fails.push({ where: `${vp} ${t}`, what: `could not open: ${e.message.slice(0, 120)}` }); }
    }
    reports.push({ vp, rep });
    await ctx.close();
  }
  await browser.close();
  for (const { vp, rep } of reports) {
    for (const i of rep.issues) {
      if (!['page-error', 'console-error', 'http-5xx', 'bad-text', 'phone-overflow', 'request-failed', 'welcome'].includes(i.kind)) continue;
      const { key, kind, ...rest } = i;
      fails.push({ where: `${vp} ${i.tab || i.after || ''}`.trim(), what: kind, body: JSON.stringify(rest).slice(0, 220) });
    }
  }
  await h.close();
  console.log(`cold boot: ${routes.length} API routes in ${((tApi - t0) / 1000).toFixed(1)} s, ${pagesN} pages and ${TABS.length} tabs at phone and desktop, ${((Date.now() - t0) / 1000).toFixed(1)} s in all`);
  if (unavailable.length) console.log(`answered 502/503 with a reason (allowed): ${unavailable.join(', ')}`);
  if (fails.length) {
    console.log(`${fails.length} problem${fails.length === 1 ? '' : 's'}:`);
    for (const f of fails) console.log(` - ${f.where}: ${f.what}${f.body ? `\n     ${f.body}` : ''}`);
    process.exit(1);
  }
  console.log('cold boot: pass');
  process.exit(0);
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
module.exports = { apiRoutes };
