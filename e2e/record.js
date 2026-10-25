// Records the fixture snapshot from a running site (the live one, from a diag
// workflow: this sandbox cannot reach it). It runs the same crawl and form
// flows as the suite, in a real browser, and saves every same-site GET under
// /api that the app made, with its status and body. Writes are not sent: every
// POST except the read-only graders is refused before it leaves the browser.
//   node e2e/record.js https://line-reaper-backend-production.up.railway.app out/snapshot.json.gz
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { chromium } = require('playwright');
const { crawl, makeReport, TABS } = require('./crawl');
const flows = require('./flows');
const { keyOf } = require('./harness');
const { READ_ONLY_POSTS } = require('./live-safety');

const VIEWPORTS = {
  desktop: { viewport: { width: 1280, height: 860 } },
  phone: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
};

async function main() {
  const base = (process.argv[2] || '').replace(/\/$/, '');
  const out = process.argv[3] || path.join(__dirname, 'out', 'snapshot.json.gz');
  if (!/^https?:\/\//.test(base)) throw new Error('usage: node e2e/record.js <base url> [out.json.gz]');
  const recordedAt = new Date().toISOString();
  const responses = {};
  const extra = ['/api/props/mlb?limit=300', '/api/props/cfbmodel?limit=300', '/api/props/nbamodel?limit=300', '/api/tracker/summary', '/api/tracker/picks?limit=100&status=review',
    '/api/tracker/picks?limit=100&status=locked', '/api/esports/models', '/api/esports/inplay', '/api/tail/record?limit=60', '/api/props/coverage?sport=NFL', '/api/features', '/api/push/kinds',
    ...(process.env.RECORD_EXTRA || '').split(',').filter(Boolean)];
  const browser = await chromium.launch();
  const jobs = [];
  const reports = [];
  for (const vp of Object.keys(VIEWPORTS)) {
    for (let s = 0; s < 3; s++) {
      jobs.push((async () => {
        const context = await browser.newContext({ ...VIEWPORTS[vp], serviceWorkers: 'block', timezoneId: 'America/Chicago' });
        await context.route('**/*', async route => {
          const req = route.request();
          const u = req.url();
          if (!u.startsWith(base)) return route.continue();
          if (req.method() !== 'GET' && !READ_ONLY_POSTS.some(p => new URL(u).pathname === p)) return route.abort('blockedbyclient');
          const p = new URL(u).pathname;
          if (req.method() !== 'GET' || !p.startsWith('/api/') || /\/stream$/.test(p)) return route.continue();
          const k = keyOf(u);
          if (responses[k]) return route.fulfill({ status: responses[k].status, contentType: responses[k].type, body: responses[k].body });
          try {
            const res = await route.fetch({ timeout: 45000 });
            const body = await res.text();
            responses[k] = { status: res.status(), type: (res.headers()['content-type'] || 'application/json').split(';')[0], body };
            return route.fulfill({ response: res, body });
          } catch { return route.abort('failed'); }
        });
        const rep = makeReport();
        const mine = TABS.filter((_, i) => i % 3 === s);
        await crawl(context, { base, viewportName: vp, msPerTab: 40000, maxClicksPerTab: 200, settleMax: 15000 }, rep, mine);
        if (s === 0) { rep.flows = {}; await flows.run(context, { base, viewportName: vp, live: true, settleMax: 15000 }, rep).catch(e => console.log('flows', e.message)); }
        reports.push(rep);
        await context.close();
      })());
    }
  }
  await Promise.all(jobs);
  // endpoints the crawl may not reach on the day (empty boards) but the suite asks for
  const ctx = await browser.newContext();
  // every game's LINE MOVES chart on the odds screen (the crawl opens only some)
  try {
    const games = JSON.parse(responses['/api/odds-screen']?.body || '{}').games || [];
    for (const g of games.slice(0, 80)) extra.push(`/api/odds-screen/history/${encodeURIComponent(g.id)}`);
  } catch { /* no board */ }
  for (const p of extra) {
    const k = keyOf(base + p);
    if (responses[k]) continue;
    const r = await ctx.request.get(base + p, { timeout: 45000 }).catch(() => null);
    if (r) responses[k] = { status: r.status(), type: (r.headers()['content-type'] || 'application/json').split(';')[0], body: await r.text() };
  }
  await browser.close();
  const snap = { recordedAt, base, version: tryVersion(responses), responses };
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, zlib.gzipSync(JSON.stringify(snap), { level: 9 }));
  const sizes = Object.entries(responses).map(([k, v]) => [k, v.status, v.body.length]).sort((a, b) => b[2] - a[2]);
  console.log(`recorded ${sizes.length} responses at ${recordedAt}, ${(fs.statSync(out).size / 1e6).toFixed(2)} MB gzipped`);
  for (const s of sizes) console.log(`${String(s[1]).padEnd(4)} ${String(s[2]).padStart(9)} ${s[0]}`);
  const issues = reports.flatMap(r => r.issues.map(i => ({ viewport: r.viewport, ...i, key: undefined })));
  console.log(`live crawl: ${reports.reduce((n, r) => n + r.clicks, 0)} clicks, ${issues.length} issues`);
  for (const i of issues.slice(0, 200)) console.log(JSON.stringify(i).slice(0, 400));
  for (const r of reports) for (const d of r.dead) console.log('dead', JSON.stringify(d).slice(0, 300));
}
function tryVersion(r) {
  try { return JSON.parse(r['/api/status'].body).version; } catch { return null; }
}

main().catch(e => { console.error(e); process.exit(1); });
