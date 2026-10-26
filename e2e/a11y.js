// Accessibility check (axe-core, WCAG 2 A and AA rules) on every tab at phone
// and desktop size. A "serious" or "critical" finding fails the run.
'use strict';
const fs = require('fs');
const { issue, watch, enterApp, openTab, newAppPage, settle, TABS } = require('./crawl');

const AXE = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
const BAD = new Set(['serious', 'critical']);

async function scan(page, where, rep) {
  if (rep) rep.a11yScans = (rep.a11yScans || 0) + 1;
  // axe waits on timers: let the page's clock run while it scans
  await page.clock.resume().catch(() => {});
  if (!(await page.evaluate(() => !!window.axe))) await page.evaluate(AXE);
  return page.evaluate(async () => {
    const r = await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] }, resultTypes: ['violations'] });
    return r.violations.map(v => ({ id: v.id, impact: v.impact, help: v.help, n: v.nodes.length, nodes: v.nodes.slice(0, 4).map(n => ({ target: n.target.join(' '), html: n.html.slice(0, 160), why: (n.failureSummary || '').split('\n').slice(1, 2).join(' ').slice(0, 200) })) }));
  }).then(list => list.map(v => ({ ...v, where })));
}

// the app on load and each tab as it opens
async function run(context, opts, rep, tabs = TABS) {
  const page = await newAppPage(context, opts);
  const w = watch(page, rep, opts);
  await enterApp(page, w, opts, rep);
  const found = [];
  if (opts.a11yLoad !== false) found.push(...await scan(page, 'app load', rep));
  for (const name of tabs) {
    try { if (await openTab(page, name, w, opts) === 'missing') continue; } catch { continue; }
    await settle(page, w, opts, 200);
    found.push(...await scan(page, `tab ${name}`, rep));
  }
  // the CUSTOMIZE panel (install and push)
  if (opts.a11yLoad !== false) try {
    await page.evaluate(() => window.layOpen && window.layOpen());
    await settle(page, w, opts, 150);
    found.push(...await scan(page, 'customize', rep));
  } catch {}
  await page.close();
  rep.a11y = found;
  for (const v of found) if (BAD.has(v.impact)) issue(rep, 'a11y', { rule: v.id, impact: v.impact, help: v.help, count: v.n, where: v.where, viewport: opts.viewportName, example: v.nodes[0] });
  return found;
}

module.exports = { run, scan };
