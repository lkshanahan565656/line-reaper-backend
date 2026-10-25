// The live smoke: the same crawl as the suite, run against the real site after
// a deploy, shorter (a few seconds a tab) and read-only (every POST is refused
// in the browser before it leaves, see live-safety.js). Runs on GitHub
// Actions (this sandbox cannot reach the site), from the diag-e2e-smoke
// branch that e2e/live-check.js pushes. Writes smoke.json:
//   node e2e/smoke.js <base url> [want version] [out file]
// Fails on page errors, console errors, broken text, 5xx/404, broken links,
// a missing tab or an unbacked "proven". Dead controls are listed as warnings,
// since live data moves under the crawl.
'use strict';
const fs = require('fs');
const { chromium } = require('playwright');
const { crawl, makeReport, TABS } = require('./crawl');
const { READ_ONLY_POSTS } = require('./live-safety');

const FAIL = new Set(['page-error', 'console-error', 'bad-text', 'http-5xx', 'http-404', 'broken-link', 'tab-missing', 'tab-open', 'forbidden-link', 'welcome', 'tour', 'sweep-crash', 'left-site']);

async function waitForVersion(base, want, maxMin = 25) {
  const t0 = Date.now();
  let seen = null;
  while (Date.now() - t0 < maxMin * 60e3) {
    try {
      const r = await fetch(`${base}/api/status?t=${Date.now()}`);
      if (r.ok) { seen = (await r.json()).version; if (!want || seen === want) return seen; }
    } catch { /* the deploy swap answers 502 for a few minutes */ }
    await new Promise(r => setTimeout(r, 20e3));
  }
  throw new Error(`the site never reached v${want} (last seen v${seen})`);
}

async function main() {
  const base = (process.argv[2] || '').replace(/\/$/, '');
  const want = process.argv[3] || '';
  const out = process.argv[4] || 'smoke.json';
  const t0 = Date.now();
  const result = { ok: false, at: new Date().toISOString(), base, want: want || null, version: null, run: process.env.GITHUB_RUN_ID || null, nonce: process.env.SMOKE_NONCE || null, failures: [], warnings: 0 };
  try {
    result.version = await waitForVersion(base, want);
    // a minute for the new process to read its feeds before judging the pages
    if (want) await new Promise(r => setTimeout(r, 60e3));
    const results = await (await fetch(`${base}/api/results`)).json().catch(() => null);
    const provenN = (results?.plays || []).filter(p => p.verdict === 'proven').length;
    const browser = await chromium.launch();
    const reports = [];
    const VP = { desktop: { viewport: { width: 1280, height: 860 } }, phone: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } };
    await Promise.all(Object.entries(VP).flatMap(([vp, cfg]) => [0, 1, 2].map(async s => {
      const context = await browser.newContext({ ...cfg, serviceWorkers: 'block', timezoneId: 'America/Chicago' });
      await context.route('**/*', route => {
        const req = route.request(), u = req.url();
        if (u.startsWith(base) && req.method() !== 'GET' && !READ_ONLY_POSTS.includes(new URL(u).pathname)) return route.abort('blockedbyclient');
        return route.continue();
      });
      const rep = makeReport();
      rep.viewport = vp;
      await crawl(context, { base, viewportName: vp, msPerTab: 7000, maxClicksPerTab: 40, settleMax: 8000, forbidHosts: [/(^|\/\/)(www\.)?polymarket\.com/i] }, rep, TABS.filter((_, i) => i % 3 === s));
      reports.push(rep);
      await context.close();
    })));
    await browser.close();
    const seen = new Set();
    for (const r of reports) {
      for (const i of r.issues) {
        const summary = `${i.kind} ${r.viewport}${i.tab ? ' ' + i.tab : ''}: ${i.message || i.text || i.url || i.href || i.error || ''}`.slice(0, 240);
        if (seen.has(summary)) continue;
        seen.add(summary);
        if (FAIL.has(i.kind)) result.failures.push({ what: i.kind, summary, detail: { ...i, key: undefined } });
        else result.warnings++;
      }
      for (const p of r.proven) {
        if (/^proven$/i.test(p.word) && p.badge && provenN) continue;
        if (/^guaranteed$/i.test(p.word) && /#toolOut/.test(p.where)) continue;
        if (/PROVEN needs \d+ graded/i.test(p.text)) continue;
        const summary = `proven-claim ${r.viewport}: "${p.text}" at ${p.where}`.slice(0, 240);
        if (!seen.has(summary)) { seen.add(summary); result.failures.push({ what: 'proven-claim', summary }); }
      }
      result.warnings += r.dead.length;
      (result.dead ||= []).push(...r.dead.slice(0, 20));
    }
    result.clicks = reports.reduce((n, r) => n + r.clicks, 0);
    result.tabs = new Set(reports.flatMap(r => Object.keys(r.tabs))).size;
    result.ok = !result.failures.length;
  } catch (e) {
    result.failures.push({ what: 'smoke-crash', summary: String(e.message || e).slice(0, 240) });
  }
  result.ms = Date.now() - t0;
  fs.writeFileSync(out, JSON.stringify(result, null, 1));
  console.log(`live smoke v${result.version}: ${result.ok ? 'PASS' : 'FAIL'}, ${result.clicks || 0} clicks on ${result.tabs || 0} tabs, ${result.failures.length} failures, ${result.warnings} warnings, ${Math.round(result.ms / 1000)} s`);
  for (const f of result.failures.slice(0, 40)) console.log(' - ' + f.summary);
}

main();
