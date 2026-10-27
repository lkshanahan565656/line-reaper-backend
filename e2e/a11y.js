// npm run a11y: accessibility check with axe-core (WCAG 2.1 A and AA rules).
// Boots the same offline server as npm run e2e, opens every app tab, the
// CUSTOMIZE, SEARCH and shortcut pop-ups, and every public page at phone and
// desktop size, and runs axe on each. A serious or critical finding fails
// the run unless e2e/a11y-baseline.json lists it (rule and page, with the
// most nodes allowed and the reason it is left). Findings that are gone from
// the baseline are reported so the file can shrink.
//   A11Y_UPDATE=1     write the current findings as the new baseline (keeps reasons)
//   A11Y_PAGES=app:odds,/pricing   only these
'use strict';
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const harness = require('./harness');
const { TABS, newAppPage, watch, makeReport, settle, openTab, enterApp } = require('./crawl');

const AXE = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
const BASELINE = path.join(__dirname, 'a11y-baseline.json');
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];
const FAIL = new Set(['serious', 'critical']);

const VIEWPORTS = {
  desktop: { viewport: { width: 1280, height: 860 } },
  phone: { viewport: { width: 375, height: 667 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
  // a 1280 x 860 desktop window zoomed to 200%: only checked for sideways scrolling
  zoom200: { viewport: { width: 640, height: 430 } },
};

// 200% zoom (WCAG 1.4.10 reflow): nothing may make the page scroll sideways
async function zoomCheck(page, where) {
  const o = await page.evaluate(() => {
    const vw = window.innerWidth, sw = document.documentElement.scrollWidth;
    if (sw <= vw + 1) return null;
    const wide = [...document.querySelectorAll('body *')].filter(e => { const r = e.getBoundingClientRect(); return r.width && r.right > vw + 1 && !e.closest('[style*="overflow"], .scroll, pre, table'); }).slice(0, 4)
      .map(e => (e.id ? '#' + e.id : e.tagName.toLowerCase() + (e.className && typeof e.className === 'string' ? '.' + e.className.trim().split(/\s+/)[0] : '')));
    return { sw, vw, wide };
  });
  if (!o) return [];
  return [{ id: 'zoom-overflow', impact: 'serious', help: `Scrolls sideways at 200% zoom (${o.sw} px wide on a ${o.vw} px window)`, where, nodes: o.wide.map(t => ({ target: t, summary: '', html: '' })) }];
}
const check = (page, where, vp) => vp === 'zoom200' ? zoomCheck(page, where) : runAxe(page, where);

// pop-ups inside the app, opened by their own function the way a key or tap does
const APP_EXTRA = {
  customize: 'layOpen()',
  search: 'gsOpen()',
  shortcuts: 'kbdOpen()',
  'search-results': "gsOpen(); gsType('NFL')",
  'bet-form': 'mybForm()',
  login: "acctOpen('login')",
  tour: 'tourStart()',
};

function publicPages(snapshot) {
  const pages = ['/', '/learn', '/pricing', '/developers', '/leagues', '/r', '/alerts', '/lines', '/status', '/digest', '/terms', '/learn/expected-value'];
  try {
    const lg = require('../leagues');
    for (const k of lg.ORDER.slice(0, 2)) pages.push(lg.LEAGUES[k].path);
  } catch { /* leagues list unavailable */ }
  try {
    const board = JSON.parse(snapshot.responses['/api/odds-screen']?.body || '{}').games || [];
    if (board[0]) pages.push(`/lines/game/${encodeURIComponent(board[0].id)}`);
  } catch { /* no recorded board */ }
  return pages;
}

async function runAxe(page, where) {
  if (process.env.A11Y_TRACE) console.log('axe', where);
  // the app pauses its fake clock; axe needs timers, so let time run while it checks
  await page.clock.resume().catch(() => {});
  await page.evaluate(AXE);
  const res = await page.evaluate(async tags => {
    // eslint-disable-next-line no-undef
    const r = await axe.run(document, { runOnly: { type: 'tag', values: tags }, resultTypes: ['violations'] });
    return r.violations.map(v => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.map(n => ({ data: v.id === 'color-contrast' ? (n.any[0]?.data || null) : undefined, target: n.target.join(' '), summary: (n.failureSummary || '').split('\n').slice(1, 3).join(' ').slice(0, 200), html: n.html.slice(0, 160) })) }));
  }, TAGS);
  return res.map(v => ({ ...v, where }));
}

async function newContext(browser, h, vp) {
  const context = await browser.newContext({ ...VIEWPORTS[vp], serviceWorkers: 'block', timezoneId: 'America/Chicago', locale: 'en-US' });
  await context.route('**/*', route => {
    const u = route.request().url();
    if (u.startsWith(h.base) || u.startsWith('data:') || u.startsWith('blob:')) return route.continue();
    if (/fonts\.(googleapis|gstatic)\.com/.test(u)) return route.fulfill({ status: 200, contentType: 'text/css', body: '' });
    return route.abort('blockedbyclient');
  });
  return context;
}

async function auditApp(context, opts, only, vp) {
  const out = [];
  const rep = makeReport();
  const page = await newAppPage(context, opts);
  const w = watch(page, rep, opts);
  // the welcome screen a first visit gets, before it is closed
  if (vp !== 'zoom200' && (!only || only.has('app:welcome'))) {
    await page.goto(`${opts.base}/app`, { waitUntil: 'domcontentloaded' });
    await settle(page, w, opts, 300);
    out.push(...await runAxe(page, 'app:welcome'));
  }
  await enterApp(page, w, opts, rep);
  for (const name of TABS) {
    if (only && !only.has('app:' + name)) continue;
    let how;
    try { how = await openTab(page, name, w, opts); } catch { continue; }
    if (how === 'missing') continue;
    if (vp === 'zoom200') await page.clock.resume().catch(() => {});
    out.push(...await check(page, 'app:' + name, vp));
  }
  if (vp === 'zoom200') { await page.close(); return out; }
  for (const [name, fn] of Object.entries(APP_EXTRA)) {
    if (only && !only.has('app:' + name)) continue;
    await page.evaluate(f => { try { (0, eval)(f); } catch { /* not in this build */ } }, fn);
    await settle(page, w, opts, 250);
    out.push(...await runAxe(page, 'app:' + name));
    await page.keyboard.press('Escape');
    await settle(page, w, opts, 80);
  }
  await page.close();
  return out;
}

async function auditPublic(context, opts, pages, vp) {
  const out = [];
  const page = await context.newPage();
  if (opts.clock) await page.clock.install({ time: new Date(opts.clock) });
  for (const p of pages) {
    const r = await page.goto(opts.base + p, { waitUntil: 'domcontentloaded' }).catch(() => null);
    if (!r || r.status() >= 400) continue;
    if (opts.clock) await page.clock.runFor(1500).catch(() => {});
    await page.waitForTimeout(150);
    out.push(...await check(page, 'page:' + p.replace(/\/lines\/game\/.*/, '/lines/game/:id')));
  }
  await page.close();
  return out;
}

// one entry per rule a page breaks: the most nodes either size showed
function summarise(found) {
  const by = {};
  for (const v of found) {
    const k = `${v.where}|${v.id}`;
    const e = by[k] ||= { where: v.where, rule: v.id, impact: v.impact, help: v.help, nodes: 0, examples: [] };
    e.nodes = Math.max(e.nodes, v.nodes.length);
    if (process.env.A11Y_PAIRS && v.id === 'color-contrast') for (const n of v.nodes) if (n.data) { const pk = `${n.data.fgColor} on ${n.data.bgColor} (${n.data.fontSize}${n.data.fontWeight === 'bold' ? ' bold' : ''}) ${n.data.contrastRatio}`; (e.pairs ||= {})[pk] = (e.pairs[pk] || 0) + 1; }
    for (const n of v.nodes) if (e.examples.length < 4 && !e.examples.some(x => x.target === n.target)) e.examples.push(n);
  }
  return Object.values(by).sort((a, b) => a.where.localeCompare(b.where) || a.rule.localeCompare(b.rule));
}

async function main() {
  const t0 = Date.now();
  const h = await harness.start();
  const browser = await chromium.launch();
  const opts = { base: h.base, clock: h.recordedAt };
  const only = process.env.A11Y_PAGES ? new Set(process.env.A11Y_PAGES.split(',')) : null;
  const pages = publicPages(h.snapshot).filter(p => !only || only.has('page:' + p));
  const jobs = [];
  for (const vp of Object.keys(VIEWPORTS)) {
    jobs.push((async () => { const c = await newContext(browser, h, vp); try { return await auditApp(c, opts, only, vp); } finally { await c.close(); } })());
    jobs.push((async () => { const c = await newContext(browser, h, vp); try { return await auditPublic(c, opts, pages, vp); } finally { await c.close(); } })());
  }
  const found = summarise((await Promise.all(jobs)).flat());
  await browser.close();
  await h.close();

  const base = fs.existsSync(BASELINE) ? JSON.parse(fs.readFileSync(BASELINE, 'utf8')) : { allow: [] };
  const allowed = new Map(base.allow.map(a => [`${a.where}|${a.rule}`, a]));
  const failures = [];
  for (const f of found) {
    if (!FAIL.has(f.impact)) continue;
    const a = allowed.get(`${f.where}|${f.rule}`);
    if (!a) failures.push({ ...f, why: 'new' });
    else if (f.nodes > a.maxNodes) failures.push({ ...f, why: `${f.nodes} nodes, baseline allows ${a.maxNodes}` });
  }
  const seen = new Set(found.map(f => `${f.where}|${f.rule}`));
  const gone = base.allow.filter(a => !seen.has(`${a.where}|${a.rule}`) && (!only || only.has(a.where)));

  fs.mkdirSync(path.join(__dirname, 'out'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, 'out', 'a11y.json'), JSON.stringify({ found, failures, gone }, null, 1));
  if (process.env.A11Y_UPDATE) {
    const allow = found.filter(f => FAIL.has(f.impact)).map(f => ({ where: f.where, rule: f.rule, maxNodes: f.nodes, reason: allowed.get(`${f.where}|${f.rule}`)?.reason || 'TODO' }));
    fs.writeFileSync(BASELINE, JSON.stringify({ note: base.note || 'Serious or critical axe findings left on purpose. Each needs a reason. npm run a11y fails on anything not listed here, or on more nodes than maxNodes.', allow }, null, 1) + '\n');
  }
  const minor = found.filter(f => !FAIL.has(f.impact));
  console.log(`a11y: ${found.length} rule findings over ${pages.length} pages and ${TABS.length + Object.keys(APP_EXTRA).length} app views, ${Math.round((Date.now() - t0) / 1000)} s`);
  for (const f of failures) console.log(`FAIL ${f.impact} ${f.where} ${f.rule} (${f.why}): ${f.help}\n  ${f.examples.map(e => e.target).join('\n  ')}`);
  if (minor.length) console.log(`${minor.length} moderate or minor findings (not failing), see e2e/out/a11y.json`);
  if (gone.length) console.log(`fixed and still in the baseline (remove them): ${gone.map(g => `${g.where} ${g.rule}`).join(', ')}`);
  console.log(failures.length ? `${failures.length} accessibility failures` : 'a11y: pass');
  process.exit(failures.length ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(2); });
