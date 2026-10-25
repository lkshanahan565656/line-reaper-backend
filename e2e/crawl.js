// The click-everything crawler. For each tab it opens the tab the way a viewer
// does (the tab bar, or the MORE menu), then keeps clicking whatever is on
// screen that it has not clicked yet: buttons, chips, toggles, sort headers,
// links, selects, checkboxes, and whatever an open modal or menu shows. Each
// click must change something (the page, the URL, the scroll, a request, a
// dialog, a new window or the control's own state). After every click it reads
// the visible text for undefined / NaN / [object Object] / null / Infinity and
// for "proven" claims, and it collects console errors and page errors.
'use strict';
const installE2E = require('./page-helpers');

const TABS = ['best', 'odds', 'tail', 'arb', 'big', 'gas', 'esports', 'results', 'betlog', 'myslips', 'tools', 'lines', 'shop', 'props', 'ev', 'sharp', 'clv'];

function makeReport() {
  return { issues: [], clicks: 0, dead: [], tabs: {}, empties: [], proven: [], console: [], requests: 0, started: Date.now() };
}

function issue(rep, kind, detail) {
  const key = kind + '|' + JSON.stringify(detail).slice(0, 300);
  if (rep.issues.some(i => i.key === key)) return;
  rep.issues.push({ key, kind, ...detail });
}

// Watch one page: console errors, page errors, requests, dialogs, popups.
function watch(page, rep, opts) {
  const w = { requests: 0, dialogs: 0, popups: 0, downloads: 0, pending: new Set() };
  page.on('request', r => { w.requests++; rep.requests++; w.pending.add(r); });
  page.on('requestfinished', r => w.pending.delete(r));
  page.on('requestfailed', r => {
    w.pending.delete(r);
    const u = r.url();
    if (u.startsWith(opts.base) && !/blockedbyclient|ERR_ABORTED/i.test(r.failure()?.errorText || '')) issue(rep, 'request-failed', { url: u.slice(opts.base.length), error: r.failure()?.errorText, tab: w.tab });
  });
  page.on('response', r => {
    const u = r.url();
    if (!u.startsWith(opts.base)) return;
    if (r.status() >= 500 && !(opts.allow5xx || []).some(re => re.test(u))) issue(rep, 'http-5xx', { url: u.slice(opts.base.length), status: r.status(), tab: w.tab });
    if (r.status() === 404 && /\/(api|learn)\b/.test(u)) issue(rep, 'http-404', { url: u.slice(opts.base.length), tab: w.tab });
  });
  page.on('dialog', d => { w.dialogs++; d.dismiss().catch(() => {}); });
  page.on('popup', p => { w.popups++; p.close().catch(() => {}); });
  page.on('download', d => { w.downloads++; d.cancel().catch(() => {}); });
  page.on('pageerror', e => issue(rep, 'page-error', { message: String(e.message || e).slice(0, 300), stack: String(e.stack || '').split('\n').slice(0, 3).join(' | '), tab: w.tab, after: w.last }));
  page.on('console', m => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if ((opts.ignoreConsole || []).some(re => re.test(t))) return;
    // a failed request already shows up above, with its URL
    if (/^Failed to load resource/.test(t)) {
      const u = m.location()?.url || '';
      if (!u.startsWith(opts.base)) return;
      if (/the server responded with a status of (4\d\d)/.test(t) && !/\/api\//.test(u)) return;
    }
    issue(rep, 'console-error', { text: t.slice(0, 300), url: (m.location()?.url || '').slice(opts.base.length), tab: w.tab, after: w.last });
  });
  return w;
}

async function settle(page, w, opts, min = 120) {
  const t0 = Date.now();
  let quietSince = null;
  while (Date.now() - t0 < (opts.settleMax || 4000)) {
    if (opts.clock) await page.clock.runFor(100).catch(() => {});
    await page.waitForTimeout(40);
    const busy = [...w.pending].filter(r => r.url().startsWith(opts.base) && !/\/stream\b/.test(r.url())).length;
    if (busy) { quietSince = null; continue; }
    if (quietSince == null) quietSince = Date.now();
    if (Date.now() - quietSince >= min && Date.now() - t0 >= min) return;
  }
}

async function openTab(page, name, w, opts) {
  w.tab = name;
  const how = await page.evaluate(n => {
    const want = `showTab('${n}',this)`;
    const btn = [...document.querySelectorAll('.tab')].find(b => b.getAttribute('onclick') === want);
    if (!btn) return 'missing';
    if (btn.closest('#moreMenu')) return btn.style.display === 'none' ? 'hidden' : 'more';
    return 'bar';
  }, name);
  const sel = `.tab[onclick="showTab('${name}',this)"]`;
  if (how === 'bar') await page.locator(`.tab-row ${sel}`).click({ timeout: 3000 });
  else if (how === 'more') {
    await page.locator('#moreBtn').click({ timeout: 3000 });
    await page.locator(`#moreMenu ${sel}`).click({ timeout: 3000 });
  } else if (how === 'hidden') {
    // switched off by the layout (the paid Odds API tabs while the server has no key): open it the way CUSTOMIZE would
    await page.evaluate(([n]) => window.showTab(n, [...document.querySelectorAll('.tab')].find(b => b.getAttribute('onclick') === `showTab('${n}',this)`)), [name]);
  } else return how;
  await settle(page, w, opts, 250);
  return how;
}

async function learnNoise(page, opts) {
  await page.evaluate(() => window.__e2e.learn());
  await page.waitForTimeout(opts.clock ? 30 : 400);
  await page.evaluate(() => window.__e2e.off());
}

async function checkText(page, rep, where) {
  const [bad, claims] = await page.evaluate(() => [window.__e2e.textIssues(), window.__e2e.provenClaims()]);
  for (const b of bad) issue(rep, 'bad-text', { ...b, after: where });
  for (const c of claims) {
    const key = c.word + '|' + c.text;
    if (!rep.proven.some(p => p.key === key)) rep.proven.push({ key, ...c, after: where });
  }
}

// one click, and whether anything happened
async function clickOne(page, c, w, opts) {
  const loc = page.locator(`[data-e2e-id="${c.id}"]`);
  const before = await page.evaluate(id => window.__e2e.state(id), c.id);
  const req0 = w.requests, dlg0 = w.dialogs, pop0 = w.popups, dl0 = w.downloads;
  await page.evaluate(() => window.__e2e.arm());
  try {
    if (c.kind === 'select') {
      const opt = await loc.evaluate(el => { const o = [...el.options].find(o => !o.selected && !o.disabled); return o ? o.value : null; });
      if (opt == null) { await page.evaluate(() => window.__e2e.off()); return { skipped: 'one option' }; }
      await loc.selectOption(opt, { timeout: 2000 });
    } else if (c.kind === 'text' || c.kind === 'number' || c.kind === 'search') {
      await loc.click({ timeout: 2000 });
      await loc.press('End').catch(() => {});
      await loc.pressSequentially(/num|stake|odds|price|amt|amount|line|size|bank|units|ev|min|max/i.test(c.label + c.family) ? '1' : 'a', { timeout: 2000 }).catch(() => loc.fill('1'));
    } else if (c.kind === 'file') {
      await page.evaluate(() => window.__e2e.off());
      return { skipped: 'file input (filled by the form flows)' };
    } else {
      await loc.click({ timeout: 2500 });
    }
  } catch (e) {
    await page.evaluate(() => window.__e2e.off()).catch(() => {});
    const msg = String(e.message || e);
    if (/intercepts pointer events/.test(msg)) return { covered: (msg.match(/<([^>]{0,120})>[^\n]*intercepts pointer events/) || [])[1] || 'another element' };
    if (/not attached|detached|not visible|Element is not|waiting for locator|Timeout/i.test(msg)) return { skipped: 'gone before the click' };
    return { error: msg.split('\n')[0].slice(0, 200) };
  }
  await settle(page, w, opts, 100);
  let after = await page.evaluate(id => window.__e2e.state(id), c.id).catch(() => null);
  let ch = await page.evaluate(() => window.__e2e.changed()).catch(() => ({ n: 1 }));
  const did = () => ch.n > 0 || w.requests > req0 || w.dialogs > dlg0 || w.popups > pop0 || w.downloads > dl0
    || !after || after.url !== before.url || after.scroll !== before.scroll || after.checked !== before.checked || after.value !== before.value || after.open !== before.open
    || (c.kind !== 'click' && c.kind !== 'link' && after.focus !== before.focus);
  if (!did()) {
    // a slow handler: give it one more look
    if (opts.clock) await page.clock.runFor(1500).catch(() => {});
    await page.waitForTimeout(opts.clock ? 60 : 700);
    after = await page.evaluate(id => window.__e2e.state(id), c.id).catch(() => null);
    ch = await page.evaluate(() => window.__e2e.changed()).catch(() => ({ n: 1 }));
  }
  await page.evaluate(() => window.__e2e.off()).catch(() => {});
  return { did: did(), urlChanged: after ? after.url !== before.url : true, sample: ch.sample };
}

// Click everything reachable from one tab, within a click and time budget.
async function sweepTab(page, name, rep, w, opts) {
  const T = (rep.tabs[name] ||= { clicks: 0, families: {}, dead: 0, opened: null, views: 0 });
  const tried = new Set();
  const famCount = {};
  const appUrl = page.url();
  const t0 = Date.now();
  let stuck = 0;
  while (T.clicks < (opts.maxClicksPerTab || 150) && Date.now() - t0 < (opts.msPerTab || 25000)) {
    const C = await page.evaluate(sel => window.__e2e.cands(sel), `#page-${name}`).catch(() => null);
    if (!C) break;
    const pick = C.list.find(c => {
      if (c.inNav && !C.overlay) return false; // the tab bar is driven by openTab
      const sig = c.family + '|' + c.label.replace(/\d+/g, '#');
      if (tried.has(sig)) return false;
      if ((famCount[c.family] || 0) >= (opts.perFamily || 4)) return false;
      return true;
    });
    if (!pick) {
      if (C.overlay) {
        // done with this modal: close it the way a viewer would, then carry on
        await page.keyboard.press('Escape');
        await settle(page, w, opts, 60);
        if (await page.evaluate(() => window.__e2e.overlay())) {
          issue(rep, 'modal-no-escape', { tab: name, modal: C.root });
          await page.evaluate(() => window.__e2e.closeOverlay());
        }
        if (++stuck > 5) break;
        continue;
      }
      break;
    }
    const sig = pick.family + '|' + pick.label.replace(/\d+/g, '#');
    tried.add(sig);
    famCount[pick.family] = (famCount[pick.family] || 0) + 1;
    // links: same-site pages are fetched, other sites are only checked for a real href
    if (pick.kind === 'link') {
      const h = pick.href || '';
      if (!h || h === '#' || /^javascript:/i.test(h)) {
        if (!pick.onclick) { issue(rep, 'dead-link', { tab: name, label: pick.label, href: h }); continue; }
      } else if (!h.startsWith('#') && !/^(mailto|tel|sms):/i.test(h)) {
        const abs = new URL(h, appUrl).href;
        if (abs.startsWith(opts.base) && !pick.onclick) {
          T.links = (T.links || 0) + 1;
          const res = await page.request.get(abs, { maxRedirects: 3 }).catch(e => ({ status: () => 0, err: e }));
          if (res.status() >= 400 || res.status() === 0) issue(rep, 'broken-link', { tab: name, label: pick.label, href: h, status: res.status() });
          continue;
        }
        if (!abs.startsWith(opts.base)) {
          if (pick.target !== '_blank') issue(rep, 'external-link-same-window', { tab: name, label: pick.label, href: h });
          if (opts.forbidHosts && opts.forbidHosts.some(re => re.test(abs))) issue(rep, 'forbidden-link', { tab: name, label: pick.label, href: h });
          T.links = (T.links || 0) + 1;
          continue;
        }
      }
    }
    w.last = `${name}: ${pick.label || pick.family}`;
    const r = await clickOne(page, pick, w, opts);
    if (r.skipped) continue;
    T.clicks++; rep.clicks++;
    T.families[pick.family] = (T.families[pick.family] || 0) + 1;
    if (r.covered) { issue(rep, 'covered', { tab: name, label: pick.label, family: pick.family, by: r.covered, overlay: C.overlay ? C.root : null }); continue; }
    if (r.error) { issue(rep, 'click-error', { tab: name, label: pick.label, error: r.error }); continue; }
    if (!r.did) {
      T.dead++;
      rep.dead.push({ tab: name, label: pick.label, family: pick.family, onclick: pick.onclick, overlay: C.overlay ? C.root : null, viewport: opts.viewportName });
    }
    if (r.urlChanged) {
      // the click left the app (or changed its query string): come back to this tab
      if (!page.url().startsWith(opts.base)) issue(rep, 'left-site', { tab: name, label: pick.label, url: page.url() });
      await page.goto(appUrl, { waitUntil: 'domcontentloaded' });
      await settle(page, w, opts, 200);
      await openTab(page, name, w, opts);
    }
    await checkText(page, rep, w.last);
    stuck = 0;
  }
  T.ms = Date.now() - t0;
  const em = await page.evaluate(sel => window.__e2e.empties(sel), `#page-${name}`).catch(() => []);
  for (const e of em) rep.empties.push({ tab: name, ...e, viewport: opts.viewportName });
}

async function newAppPage(context, opts) {
  const page = await context.newPage();
  await page.addInitScript(installE2E);
  if (opts.clock) await page.clock.install({ time: new Date(opts.clock) });
  return page;
}

async function enterApp(page, w, opts, rep) {
  await page.goto(`${opts.base}/app`, { waitUntil: 'domcontentloaded' });
  if (opts.clock) await page.clock.pauseAt(new Date(new Date(opts.clock).getTime() + 2000)).catch(() => {});
  await settle(page, w, opts, 300);
  // the welcome screen: Enter without ticking the box must ask for it, then tick and enter
  const open = await page.evaluate(() => document.getElementById('welcome')?.classList.contains('open'));
  if (open) {
    await page.locator('#wlEnter').click();
    const need = await page.evaluate(() => document.getElementById('wlAgreeRow').classList.contains('need'));
    if (!need) issue(rep, 'welcome', { message: 'Enter without the box ticked did not ask for it' });
    await page.locator('#wlAgree').check();
    await page.locator('#wlEnter').click();
    await settle(page, w, opts, 150);
    if (await page.evaluate(() => document.getElementById('welcome')?.classList.contains('open'))) issue(rep, 'welcome', { message: 'Enter did not close the welcome screen' });
  }
  await checkText(page, rep, 'app load');
}

// crawl the given tabs in one browser context
async function crawl(context, opts, rep = makeReport(), tabs = TABS) {
  const page = await newAppPage(context, opts);
  const w = watch(page, rep, opts);
  await enterApp(page, w, opts, rep);
  for (const name of tabs) {
    let how;
    try { how = await openTab(page, name, w, opts); } catch (e) { issue(rep, 'tab-open', { tab: name, error: String(e.message).split('\n')[0] }); continue; }
    if (how === 'missing') { issue(rep, 'tab-missing', { tab: name }); continue; }
    (rep.tabs[name] ||= { clicks: 0, families: {}, dead: 0, views: 0 }).opened = how;
    await learnNoise(page, opts);
    await checkText(page, rep, `open ${name}`);
    try { await sweepTab(page, name, rep, w, opts); } catch (e) { issue(rep, 'sweep-crash', { tab: name, error: String(e.message).split('\n')[0] }); }
    // leave the tab clean for the next one
    await page.evaluate(() => { while (window.__e2e.closeOverlay()); }).catch(() => {});
  }
  await page.close();
  return rep;
}

module.exports = { crawl, makeReport, watch, settle, openTab, enterApp, newAppPage, checkText, issue, TABS, installE2E };
