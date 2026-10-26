// Page speed on a phone: boots the offline e2e server on the recorded
// snapshot, opens /app at 375 px with a throttled network and CPU, and
// reports bytes over the wire, first paint and the time until the ODDS SCREEN
// shows its first game. Cold (empty cache) and warm (second visit) runs.
//   node scripts/pagespeed.js            Slow 4G (150 ms RTT, 1.6 Mbps down) and 4x CPU
//   PS_RUNS=5 node scripts/pagespeed.js  median of 5 runs each
//   PS_JSON=out.json                     also write the numbers to a file
//   node scripts/pagespeed.js https://site  the live site instead (real fonts, real API)
// Offline, nothing leaves this machine: Google Fonts fail at once, so the
// offline numbers leave out what fonts cost a real phone (the live run has them).
'use strict';
/* global document */
const fs = require('fs');
const { chromium } = require('playwright');

const NET = { offline: false, latency: 150, downloadThroughput: 1.6e6 / 8, uploadThroughput: 750e3 / 8 };
const CPU = 4;
const RUNS = Number(process.env.PS_RUNS || 3);
const PHONE = { viewport: { width: 375, height: 667 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' };

async function visit(context, base) {
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', NET);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU });
  const reqs = new Map();
  cdp.on('Network.responseReceived', e => { const r = reqs.get(e.requestId) || {}; r.url = e.response.url; r.type = e.type; r.cached = e.response.fromDiskCache || e.response.fromMemoryCache; r.enc = e.response.headers['content-encoding'] || e.response.headers['Content-Encoding'] || ''; reqs.set(e.requestId, r); });
  cdp.on('Network.loadingFinished', e => { const r = reqs.get(e.requestId) || {}; r.bytes = e.encodedDataLength; reqs.set(e.requestId, r); });
  cdp.on('Network.dataReceived', e => { const r = reqs.get(e.requestId) || {}; r.raw = (r.raw || 0) + e.dataLength; reqs.set(e.requestId, r); });
  const t0 = Date.now();
  await page.goto(base + '/app', { waitUntil: 'commit' });
  await page.waitForFunction(() => document.querySelector('#osContent .os-game, #osContent table, #osContent .empty-wrap:not(:first-child)') || !/LOADING/.test(document.querySelector('#osContent')?.textContent || 'LOADING'), null, { timeout: 120e3, polling: 50 });
  const usable = Date.now() - t0;
  await page.waitForTimeout(1500);
  const m = await page.evaluate(() => {
    const nav = performance.getEntriesByType('navigation')[0];
    const fcp = performance.getEntriesByName('first-contentful-paint')[0];
    return { fcp: fcp ? Math.round(fcp.startTime) : null, dcl: Math.round(nav.domContentLoadedEventEnd), load: Math.round(nav.loadEventEnd) };
  });
  await page.close();
  const list = [...reqs.values()].filter(r => r.url && !r.url.startsWith('data:'));
  const sum = f => list.filter(f).reduce((s, r) => s + (r.bytes || 0), 0);
  const isApi = r => /\/api\//.test(r.url), isDoc = r => /\/app(\?|$)/.test(new URL(r.url).pathname) || r.type === 'Document';
  return {
    ...m, usable,
    wire: sum(() => true), doc: sum(isDoc), scripts: sum(r => r.type === 'Script'), api: sum(isApi), apiRaw: list.filter(isApi).reduce((s, r) => s + (r.raw || 0), 0),
    requests: list.length,
    apis: list.filter(isApi).map(r => ({ path: new URL(r.url).pathname, bytes: r.bytes, raw: r.raw, enc: r.enc })),
    files: list.filter(r => !isApi(r)).map(r => ({ path: new URL(r.url).pathname, bytes: r.bytes, raw: r.raw, enc: r.enc, cached: !!r.cached })),
  };
}

const median = a => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

async function main() {
  const live = process.argv[2] ? String(process.argv[2]).replace(/\/+$/, '') : '';
  const h = live ? { base: live, close: async () => {} } : await require('../e2e/harness').start();
  // the server compresses the page a moment after boot: measure the steady state
  for (let i = 0; i < 40 && !live; i++) { if ((await (await fetch(h.base + '/app')).text()).includes('/assets/app.')) break; await new Promise(r => setTimeout(r, 250)); }
  // offline, outside hosts (Google Fonts) are refused at once. Not with
  // page.route: routing turns the browser cache off, and the warm visit needs it.
  const browser = await chromium.launch(live ? {} : { args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'] });
  const runs = { cold: [], warm: [] };
  try {
    for (let i = 0; i < RUNS; i++) {
      const context = await browser.newContext({ ...PHONE, serviceWorkers: 'block', timezoneId: 'America/Chicago', locale: 'en-US' });
      runs.cold.push(await visit(context, h.base));
      runs.warm.push(await visit(context, h.base));
      await context.close();
    }
  } finally { await browser.close(); await h.close(); }
  const out = {};
  for (const k of ['cold', 'warm']) {
    const r = runs[k];
    out[k] = Object.fromEntries(['fcp', 'dcl', 'usable', 'wire', 'doc', 'scripts', 'api', 'apiRaw', 'requests'].map(f => [f, median(r.map(x => x[f]))]));
    out[k].apis = r[0].apis; out[k].files = r[0].files;
  }
  const kb = n => (n / 1024).toFixed(0) + ' KB';
  for (const k of ['cold', 'warm']) {
    const o = out[k];
    console.log(`${k.toUpperCase()} (median of ${RUNS}): first paint ${o.fcp} ms, page ready ${o.dcl} ms, ODDS SCREEN usable ${o.usable} ms; ${kb(o.wire)} over the wire in ${o.requests} requests (page ${kb(o.doc)}, scripts ${kb(o.scripts)}, API ${kb(o.api)} of ${kb(o.apiRaw)} raw)`);
    for (const f of o.files) console.log(`   ${f.path.padEnd(34)} ${kb(f.bytes || 0).padStart(8)} wire ${kb(f.raw || 0).padStart(8)} raw ${f.enc}${f.cached ? ' (cache)' : ''}`);
    for (const a of o.apis) console.log(`   ${a.path.padEnd(34)} ${kb(a.bytes || 0).padStart(8)} wire ${kb(a.raw || 0).padStart(8)} raw ${a.enc}`);
  }
  if (process.env.PS_JSON) fs.writeFileSync(process.env.PS_JSON, JSON.stringify(out, null, 2));
}

main().catch(e => { console.error(e); process.exit(2); });
