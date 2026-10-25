// npm run e2e: boot the offline server on the recorded snapshot, then crawl
// every tab at phone and desktop size, run the form flows, and fail on any
// console error, page error, broken text, dead control, fixture miss or
// unbacked "proven" claim. Writes e2e/out/report.json and prints a summary.
//   E2E_TABS=odds,props     only these tabs
//   E2E_VIEWPORTS=desktop   only one size
//   E2E_HEADED=1            watch it
'use strict';
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const harness = require('./harness');
const { crawl, makeReport, TABS } = require('./crawl');
const flows = require('./flows');
const verdict = require('./verdict');

const VIEWPORTS = {
  desktop: { viewport: { width: 1280, height: 860 } },
  phone: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' },
};

async function main() {
  const t0 = Date.now();
  const h = await harness.start();
  const tabs = process.env.E2E_TABS ? process.env.E2E_TABS.split(',') : TABS;
  const vps = process.env.E2E_VIEWPORTS ? process.env.E2E_VIEWPORTS.split(',') : Object.keys(VIEWPORTS);
  const browser = await chromium.launch({ headless: !process.env.E2E_HEADED });
  const shards = Number(process.env.E2E_SHARDS || 3);
  const opts = {
    base: h.base, clock: h.recordedAt, msPerTab: Number(process.env.E2E_MS_PER_TAB || 30000), maxClicksPerTab: Number(process.env.E2E_MAX_CLICKS || 160),
    forbidHosts: [/(^|\/\/)(www\.)?polymarket\.com/i],
  };
  const reports = [];
  const jobs = [];
  for (const vp of vps) {
    // split the tabs over a few browser windows so the crawl runs in parallel
    for (let s = 0; s < shards; s++) {
      const mine = tabs.filter((_, i) => i % shards === s);
      if (!mine.length) continue;
      jobs.push((async () => {
        const context = await newContext(browser, h, vp);
        const rep = makeReport();
        rep.viewport = vp;
        await crawl(context, { ...opts, viewportName: vp }, rep, mine);
        await context.close();
        reports.push(rep);
      })());
    }
    if (!process.env.E2E_TABS || process.env.E2E_FLOWS) {
      jobs.push((async () => {
        const context = await newContext(browser, h, vp);
        const rep = makeReport();
        rep.viewport = vp; rep.flows = {};
        await flows.run(context, { ...opts, viewportName: vp }, rep);
        await context.close();
        reports.push(rep);
      })());
    }
  }
  await Promise.all(jobs);
  await browser.close();
  const out = verdict.combine(reports, { misses: h.misses(), recordedAt: h.recordedAt, snapshot: h.snapshot, ms: Date.now() - t0 });
  await h.close();
  fs.mkdirSync(path.join(__dirname, 'out'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, 'out', 'report.json'), JSON.stringify(out, null, 1));
  console.log(verdict.summary(out));
  process.exit(out.failures.length ? 1 : 0);
}

async function newContext(browser, h, vp) {
  const context = await browser.newContext({ ...VIEWPORTS[vp], serviceWorkers: 'block', acceptDownloads: true, timezoneId: 'America/Chicago', locale: 'en-US' });
  // nothing leaves this machine: fonts get an empty stylesheet, every other outside request is refused
  await context.route('**/*', route => {
    const u = route.request().url();
    if (u.startsWith(h.base) || u.startsWith('data:') || u.startsWith('blob:')) return route.continue();
    if (/fonts\.(googleapis|gstatic)\.com/.test(u)) return route.fulfill({ status: 200, contentType: 'text/css', body: '' });
    return route.abort('blockedbyclient');
  });
  return context;
}

main().catch(e => { console.error(e); process.exit(2); });
