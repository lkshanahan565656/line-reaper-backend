// Offline check: the one e2e job that lets the service worker run. Load the
// app online so the worker saves the shell and a screen's data, then cut the
// network and reload. The app must still open, the screen must show its saved
// rows with an age stamp on every row, the banner must say the data is saved
// and not live, the live pill must not say live, and nothing may stick out at
// phone size. Then the network comes back and TRY AGAIN must load live data
// with no stamps left.
'use strict';
const { issue, watch, enterApp, openTab, newAppPage, settle, checkOverflow } = require('./crawl');

const TAB = 'esports';

async function run(context, opts, rep) {
  const page = await newAppPage(context, opts);
  page.setDefaultTimeout(8000);
  const w = watch(page, rep, { ...opts, allow5xx: [/./] });
  const fail = (step, message) => issue(rep, 'offline', { step, message, viewport: opts.viewportName });
  try {
    await enterApp(page, w, opts, rep);
    // the worker installs on the first load and takes over this page at once
    const ok = await page.waitForFunction(() => !!navigator.serviceWorker?.controller, null, { timeout: 15000 }).then(() => true, () => false);
    if (!ok) return fail('install', 'the service worker never took over the page');
    // a load under the worker saves the app and the screen's data
    await page.reload({ waitUntil: 'domcontentloaded' });
    await settle(page, w, opts, 300);
    await openTab(page, TAB, w, opts);
    await settle(page, w, opts, 400);
    const liveRows = await page.evaluate(sel => document.querySelectorAll(sel).length, `#page-${TAB} tbody tr, #page-${TAB} .esm-card, #page-${TAB} .emu-row`);
    if (!liveRows) return fail('online', `${TAB} drew no rows online`);
    if (await page.locator('.lr-stamp').count()) fail('online', 'rows carry an age stamp while the data is live');

    // the network goes away
    await context.setOffline(true);
    await page.reload({ waitUntil: 'domcontentloaded' }).catch(e => fail('offline reload', String(e.message).split('\n')[0]));
    await settle(page, w, opts, 400);
    if (!(await page.locator('.tab-row').count())) return fail('offline reload', 'the app did not open without a network');
    await openTab(page, TAB, w, opts);
    await settle(page, w, opts, 400);
    const got = await page.evaluate(tab => {
      const pg = document.getElementById(`page-${tab}`);
      const rows = [...pg.querySelectorAll('tbody tr, .esm-card, .emu-row')].filter(r => r.getClientRects().length && !(r.tagName === 'TR' && r.cells.length === 1 && r.cells[0].colSpan > 1));
      const stamped = rows.filter(r => r.querySelector('.lr-stamp'));
      const ban = document.getElementById('offBanner');
      return {
        rows: rows.length, stamped: stamped.length,
        stampText: stamped[0]?.querySelector('.lr-stamp')?.textContent || '',
        banner: !!ban && !ban.hidden && ban.getClientRects().length > 0, bannerText: ban?.innerText || '',
        pill: document.getElementById('wsLabel')?.textContent || '',
      };
    }, TAB);
    if (!got.rows) fail('offline', `${TAB} showed no saved rows offline`);
    if (got.stamped < got.rows) fail('offline', `${got.rows - got.stamped} of ${got.rows} rows have no age stamp`);
    if (!/^read .+ ago, may be stale$/.test(got.stampText)) fail('offline', `stamp reads "${got.stampText}"`);
    if (!got.banner || !/not live/i.test(got.bannerText)) fail('offline', `banner missing or unclear: "${got.bannerText}"`);
    if (/live|polling/i.test(got.pill)) fail('offline', `the live pill says "${got.pill}" on saved data`);
    await checkOverflow(page, rep, TAB, 'offline', opts);
    if (process.env.E2E_OFFLINE_SHOT) await page.screenshot({ path: `${process.env.E2E_OFFLINE_SHOT}/offline-${opts.viewportName}.png` });

    // back online: TRY AGAIN reads live data and the stamps go
    await context.setOffline(false);
    await page.locator('#offBanner .off-retry').click();
    await page.waitForLoadState('domcontentloaded');
    await settle(page, w, opts, 300);
    await openTab(page, TAB, w, opts);
    await settle(page, w, opts, 400);
    const after = await page.evaluate(() => ({ stamps: document.querySelectorAll('.lr-stamp').length, banner: !document.getElementById('offBanner').hidden }));
    if (after.stamps || after.banner) fail('back online', `after TRY AGAIN: ${after.stamps} stamps, banner ${after.banner ? 'still up' : 'gone'}`);
  } catch (e) {
    fail('crash', String(e.message || e).split('\n')[0].slice(0, 300));
  } finally {
    // requests that fail while the network is cut are the point of the test
    rep.issues = rep.issues.filter(i => !(i.kind === 'request-failed' && /INTERNET_DISCONNECTED/.test(i.error || '')));
    await context.setOffline(false).catch(() => {});
    await page.close().catch(() => {});
  }
}

module.exports = { run, TAB };
