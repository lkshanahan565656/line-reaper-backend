// Read-only live audit of the v3.209 to v3.218 releases (10-27). Runs on GitHub Actions.
//   node audit.js <base> <outdir>
'use strict';
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { crawl, makeReport, TABS, watch, settle, openTab, enterApp, newAppPage, checkOverflow } = require('./e2e/crawl');

const base = (process.argv[2] || '').replace(/\/$/, '');
const OUT = process.argv[3] || 'out';
fs.mkdirSync(path.join(OUT, 'shots'), { recursive: true });
fs.mkdirSync(path.join(OUT, 'html'), { recursive: true });
const save = (f, v) => fs.writeFileSync(path.join(OUT, f), typeof v === 'string' ? v : JSON.stringify(v, null, 1));
const log = [];
const note = (...a) => { const s = a.join(' '); log.push(s); console.log(s); };

async function get(u, opts = {}) {
  const t0 = Date.now();
  try {
    const r = await fetch(base + u, { redirect: 'manual', ...opts });
    const buf = Buffer.from(await r.arrayBuffer());
    return { status: r.status, type: r.headers.get('content-type') || '', loc: r.headers.get('location'), body: buf, ms: Date.now() - t0 };
  } catch (e) { return { status: 0, error: String(e.message), body: Buffer.alloc(0), ms: Date.now() - t0 }; }
}

function scanHtml(u, html) {
  const out = { polymarket: [], claims: [], americanTokens: 0 };
  for (const m of html.matchAll(/href=["']([^"']*polymarket\.com[^"']*)["']/gi)) out.polymarket.push(m[1]);
  const text = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ');
  for (const m of text.matchAll(/.{0,90}\b(proven|profit\w*|guarantee\w*|risk[- ]free|lock|winning|beat the close|edge)\b.{0,90}/gi)) out.claims.push(m[0].trim());
  out.americanTokens = (text.match(/(^|\s)[+-]\d{3,4}(?=\s|$)/g) || []).length;
  out.decimalTokens = (text.match(/(^|\s)\d{1,2}\.\d{2,3}(?=\s|$)/g) || []).length;
  out.amSamples = (text.match(/.{0,40}(^|\s)[+-]\d{3,4}(?=\s|$).{0,20}/g) || []).slice(0, 4);
  out.venues = ['FanDuel', 'BetRivers', 'DraftKings', 'BetMGM', 'Caesars', 'Kalshi', 'Polymarket US', 'Gemini', 'PrizePicks', 'Underdog', 'Sleeper', 'Pinnacle', 'Fanatics', 'ESPN BET', 'bet365', 'Novig', 'ProphetX'].filter(v => text.includes(v));
  out.v1Listed = ['/api/v1/search', '/api/v1/lines', '/api/v1/leaderboard', '/api/v1/alerts'].filter(v => html.includes(v));
  out.bad = (text.match(/.{0,40}\b(undefined|NaN|null|\[object Object\])\b.{0,40}/g) || []).slice(0, 5);
  out.textLen = text.length;
  return out;
}

async function apiPart() {
  const json = {};
  for (const u of ['/api/health', '/api/status', '/api/ops', '/api/states', '/api/states/TX', '/api/states/table', '/api/claims', '/api/record', '/api/results', '/api/digest', '/api/v1', '/api/moves', '/api/esports/map-unders', '/api/features', '/api/plans', '/api/search?q=nba', '/api/search?q=lakers&state=CA', '/api/search?q=x', '/api/lines?limit=5', '/api/lines?kind=prop&limit=3', '/api/alerts/history?limit=5', '/api/leaderboard', '/api/leaderboard?state=CA&window=7d', '/api/leaderboard?window=zz', '/api/records', '/api/esports/matchups']) {
    const r = await get(u);
    let v = null; try { v = JSON.parse(r.body.toString()); } catch { v = r.body.toString().slice(0, 500); }
    json[u] = { status: r.status, ms: r.ms, size: r.body.length };
    const s = JSON.stringify(v);
    save(`api${u.replace(/\//g, '_')}.json`, s.length > 400000 ? JSON.stringify({ truncated: true, keys: v && typeof v === 'object' ? Object.keys(v) : null, head: s.slice(0, 400000) }) : s);
  }
  save('api-index.json', json);
  const st = JSON.parse(fs.readFileSync(path.join(OUT, 'api_api_status.json'), 'utf8'));
  note('version', st.version, 'resultsBackup', JSON.stringify(st.resultsBackup || null).slice(0, 400));
}

async function pagesPart() {
  const res = {};
  const sm = await get('/sitemap.xml');
  const urls = new Set([...sm.body.toString().matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => new URL(m[1]).pathname));
  for (const u of ['/', '/app', '/learn', '/developers', '/leagues', '/status', '/digest', '/results', '/r/nobody-here-xyz', '/r/ab', '/share/record', '/share/price', '/share/move', '/share/league?league=nfl', '/share/digest',
    '/card/record.png', '/card/price.png', '/card/move.png', '/card/league.png?league=nfl', '/card/digest.png', '/embed/best-price', '/embed/line-move', '/embed/record', '/embed.js',
    '/nfl?state=TX', '/nfl?state=CA', '/nfl?state=ZZ', '/esports/lol?state=TX', '/api/v1/states', '/sales', '/pricing',
    '/alerts', '/alerts?odds=decimal', '/alerts?kind=ev&days=7', '/lines', '/lines?odds=decimal', '/lines?state=CA', '/lines?venues=all', '/lines?kind=prop', '/lines?q=lakers', '/lines/game/nope-xyz', '/lines/prop?key=nope',
    '/r', '/r?state=CA', '/r?window=7d&league=NBA', '/r?venues=mine', '/card/alerts.png', '/discord/interactions']) urls.add(u);
  try {
    const lx = JSON.parse((await get('/api/lines?limit=20')).body.toString());
    const g = (lx.rows || lx.markets || lx.lines || []).find(r => r.kind === 'game' || r.gameId) || null;
    const pp = JSON.parse((await get('/api/lines?kind=prop&limit=5')).body.toString());
    const p = (pp.rows || pp.markets || pp.lines || [])[0] || null;
    save('lines-pick.json', { g, p, keys: Object.keys(lx) });
    const gid = g && (g.gameId || g.id);
    if (gid) for (const q of ['', '?odds=decimal', '?odds=implied&state=CA', '?venues=all', '?market=spread']) urls.add(`/lines/game/${encodeURIComponent(gid)}${q}`);
    const pk = p && (p.key || p.id);
    if (pk) for (const q of ['', '&odds=decimal', '&state=CA']) urls.add(`/lines/prop?key=${encodeURIComponent(pk)}${q}`);
    if (gid) urls.add(`/api/lines/game/${encodeURIComponent(gid)}?format=csv`);
  } catch (e) { note('lines pick', e.message); }
  for (const u of urls) {
    const r = await get(u);
    const html = /html/.test(r.type) ? r.body.toString() : '';
    if (/csv/.test(r.type)) res[u + ' csvHead'] = r.body.toString().split('\n').slice(0, 3);
    res[u] = { status: r.status, type: r.type, loc: r.loc, size: r.body.length, ms: r.ms, ...(html ? scanHtml(u, html) : {}) };
    if (html) save(`html/${(u.replace(/[^a-z0-9]+/gi, '_') || 'root').slice(0, 60)}.html`, html);
  }
  save('pages.json', res);
  note('pages', Object.keys(res).length, 'non-2xx:', Object.entries(res).filter(([, v]) => v.status >= 300).map(([k, v]) => `${k}=${v.status}`).join(' '));
}

async function v1Part() {
  const out = { calls: {} };
  const k = await get('/api/v1/keys', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'audit-2026-10-27' }) });
  let key = null; try { key = JSON.parse(k.body.toString()).key; } catch {}
  out.create = { status: k.status, body: k.body.toString().replace(/lr[a-z]*_[A-Za-z0-9_-]{10,}/g, '<key>').slice(0, 600) };
  if (!key) { save('v1.json', out); return; }
  const H = { headers: { 'x-api-key': key } };
  const calls = ['/api/v1/key', '/api/v1/best-prices', '/api/v1/best-prices?state=TX', '/api/v1/best-prices?league=nfl&limit=3', '/api/v1/best-prices?state=ZZ', '/api/v1/moves?limit=3', '/api/v1/leagues', '/api/v1/leagues/nfl', '/api/v1/leagues/nfl?state=TX', '/api/v1/leagues/lol',
    '/api/v1/record', '/api/v1/record?state=TX', '/api/v1/record/flags?limit=3', '/api/v1/states', '/api/v1/states/TX', '/api/v1/states/zz', '/api/v1/digest', '/api/v1/status', '/api/v1/feed', '/api/v1/nope',
    '/api/v1', '/api/v1/search?q=nba', '/api/v1/search?q=lakers&state=TX&kind=game', '/api/v1/search', '/api/v1/search?q=nba&kind=zz', '/api/v1/lines?limit=3', '/api/v1/lines?kind=prop&limit=3', '/api/v1/lines?league=nba&limit=2',
    '/api/v1/lines/game/nope', '/api/v1/lines/prop?key=nope', '/api/v1/leaderboard', '/api/v1/leaderboard?state=CA&window=30d', '/api/v1/leaderboard?window=bad', '/api/v1/alerts?limit=3', '/api/v1/alerts?kind=ev&days=7', '/api/v1/alerts?kind=bad'];
  for (const u of calls) {
    const r = await get(u, H);
    let v = null; try { v = JSON.parse(r.body.toString()); } catch {}
    out.calls[u] = { status: r.status, sample: v ? JSON.stringify(v).slice(0, 3000) : r.body.toString().slice(0, 300) };
  }
  const mv = (() => { try { return JSON.parse(out.calls['/api/v1/moves?limit=3'].sample.length < 3000 ? out.calls['/api/v1/moves?limit=3'].sample : '{}'); } catch { return {}; } })();
  const gid = mv.rows?.[0]?.gameId;
  if (gid) { const r = await get(`/api/v1/moves/${encodeURIComponent(gid)}`, H); out.calls['/api/v1/moves/:gameId'] = { status: r.status, sample: r.body.toString().slice(0, 3000) }; }
  const dg = (() => { try { return JSON.parse(out.calls['/api/v1/digest'].sample); } catch { return {}; } })();
  const wk = dg.weeks?.[0]?.week || dg.weeks?.[0];
  if (wk && typeof wk === 'string') { const r = await get(`/api/v1/digest/${wk}`, H); out.calls['/api/v1/digest/:week'] = { status: r.status, sample: r.body.toString().slice(0, 3000) }; }
  try {
    const lx = JSON.parse(out.calls['/api/v1/lines?limit=3'].sample);
    const g = (lx.rows || lx.markets || lx.lines || []).find(r => r.gameId || r.kind === 'game');
    const gid = g && (g.gameId || g.id);
    if (gid) for (const q of ['', '?format=csv', '?market=total']) { const r = await get(`/api/v1/lines/game/${encodeURIComponent(gid)}${q}`, H); out.calls['/api/v1/lines/game/:id' + q] = { status: r.status, type: r.type, sample: r.body.toString().slice(0, 2000) }; }
    const px = JSON.parse(out.calls['/api/v1/lines?kind=prop&limit=3'].sample);
    const p = (px.rows || px.markets || px.lines || [])[0];
    const pk = p && (p.key || p.id);
    if (pk) for (const q of ['', '&format=csv']) { const r = await get(`/api/v1/lines/prop?key=${encodeURIComponent(pk)}${q}`, H); out.calls['/api/v1/lines/prop' + q] = { status: r.status, type: r.type, sample: r.body.toString().slice(0, 2000) }; }
  } catch (e) { out.linesErr = String(e.message); }
  const d = await get('/api/v1/key', { method: 'DELETE', ...H });
  out.revoke = { status: d.status, body: d.body.toString().slice(0, 200) };
  save('v1.json', out);
  note('v1', Object.entries(out.calls).map(([u, v]) => `${u}=${v.status}`).join(' '));
}

const VP = { desktop: { viewport: { width: 1280, height: 860 } }, phone: { viewport: { width: 375, height: 667 }, isMobile: true, hasTouch: true } };
const readOnly = async context => context.route('**/*', route => {
  const req = route.request(), u = req.url();
  if (u.startsWith(base) && req.method() !== 'GET') return route.abort('blockedbyclient');
  return route.continue();
});

async function crawlPart(browser) {
  const reports = [];
  await Promise.all(Object.entries(VP).flatMap(([vp, cfg]) => [0, 1, 2].map(async s => {
    const context = await browser.newContext({ ...cfg, serviceWorkers: 'block', timezoneId: 'America/Chicago' });
    await readOnly(context);
    const rep = makeReport();
    rep.viewport = vp;
    try {
      await crawl(context, { base, viewportName: vp, msPerTab: 30000, maxClicksPerTab: 120, settleMax: 8000, forbidHosts: [/(^|\/\/)(www\.)?polymarket\.com/i] }, rep, TABS.filter((_, i) => i % 3 === s));
    } catch (e) { rep.crash = String(e.message); }
    reports.push(rep);
    await context.close();
  })));
  for (const vp of Object.keys(VP)) {
    const rs = reports.filter(r => r.viewport === vp);
    save(`crawl-${vp}.json`, { issues: rs.flatMap(r => r.issues), dead: rs.flatMap(r => r.dead), empties: rs.flatMap(r => r.empties), proven: rs.flatMap(r => r.proven), tabs: Object.assign({}, ...rs.map(r => r.tabs)), clicks: rs.reduce((n, r) => n + r.clicks, 0), crash: rs.map(r => r.crash).filter(Boolean) });
  }
  note('crawl done', reports.reduce((n, r) => n + r.clicks, 0), 'clicks');
}

// every tab under each odds format and state
async function matrixPart(browser) {
  const combos = [['american', 'TX'], ['decimal', 'TX'], ['american', ''], ['implied', 'CA']];
  const res = [];
  for (const [vp, cfg] of Object.entries(VP)) {
    for (const [fmt, st] of combos) {
      if (vp === 'desktop' && fmt === 'implied') continue;
      const context = await browser.newContext({ ...cfg, serviceWorkers: 'block', timezoneId: 'America/Chicago' });
      await readOnly(context);
      const rep = makeReport();
      const opts = { base, viewportName: vp, settleMax: 9000 };
      const page = await newAppPage(context, opts);
      const w = watch(page, rep, opts);
      try {
        await enterApp(page, w, opts, rep);
        await page.evaluate(([f, s]) => { localStorage.setItem('lr_odds_fmt', f); localStorage.setItem('lr_state', s); }, [fmt, st]);
        await page.reload({ waitUntil: 'domcontentloaded' });
        await settle(page, w, opts, 400);
        for (const tab of [...TABS, 'mybets', 'customize']) {
          let how = null;
          try { how = await openTab(page, tab, w, opts); } catch (e) { how = 'err ' + String(e.message).slice(0, 80); }
          await page.waitForTimeout(2500);
          const info = await page.evaluate(t => {
            const el = document.getElementById('page-' + t);
            if (!el) return { none: true };
            const text = el.innerText || '';
            const am = (text.match(/(^|[\s(])[+-]\d{3,4}(?=[\s),]|$)/gm) || []).length;
            const dec = (text.match(/(^|\s)\d{1,2}\.\d{2}(?=\s|$)/gm) || []).length;
            const pctT = (text.match(/\b\d{1,2}\.\d%/g) || []).length;
            const btns = [...el.querySelectorAll('button')].filter(b => b.offsetParent).map(b => b.textContent.trim()).filter(Boolean);
            const empties = (window.__e2e && window.__e2e.empties('#page-' + t)) || [];
            const amSamples = (text.match(/.{0,30}(^|[\s(])[+-]\d{3,4}(?=[\s),]|$).{0,20}/gm) || []).slice(0, 6);
            const pm = [...el.querySelectorAll('a[href*="polymarket.com"]')].map(a => a.href);
            return { len: text.length, am, dec, pctT, amSamples, showAll: btns.some(b => /SHOW ALL STATES/i.test(b)), stateBar: el.querySelector('[data-state-bar]')?.innerText?.slice(0, 200) || null, empties, head: text.slice(0, 600), pm };
          }, tab).catch(e => ({ err: String(e.message) }));
          if (vp === 'phone') {
            const ov = await page.evaluate(() => window.__e2e.overflow()).catch(() => []);
            info.overflow = ov.slice(0, 5);
          }
          res.push({ vp, fmt, st, tab, how, ...info });
          if ((fmt === 'american' && st === 'TX') || (fmt === 'decimal' && vp === 'phone')) await page.screenshot({ path: path.join(OUT, 'shots', `${vp}-${fmt}-${st || 'all'}-${tab}.png`), fullPage: false }).catch(() => {});
        }
      } catch (e) { res.push({ vp, fmt, st, crash: String(e.message) }); }
      res.push({ vp, fmt, st, issues: rep.issues.map(i => ({ ...i, key: undefined })) });
      await context.close();
    }
  }
  save('matrix.json', res);
  note('matrix rows', res.length);
}

async function sharePart(browser) {
  const out = [];
  const context = await browser.newContext({ ...VP.desktop, serviceWorkers: 'block' });
  await readOnly(context);
  const rep = makeReport();
  const opts = { base, viewportName: 'desktop', settleMax: 9000 };
  const page = await newAppPage(context, opts);
  const w = watch(page, rep, opts);
  await enterApp(page, w, opts, rep);
  for (const [tab, st] of [['odds', 'TX'], ['odds', 'CA'], ['props', 'TX'], ['esports', ''], ['results', 'TX'], ['best', 'NY']]) {
    try {
      await page.evaluate(s => window.lrSetState ? window.lrSetState(s) : null, st).catch(() => {});
      await openTab(page, tab, w, opts);
      await page.waitForTimeout(2000);
      const s1 = await page.evaluate(() => { const s = window.lrShareState(); return { s, url: window.lrShareUrl(s) }; });
      const ctx2 = await browser.newContext({ ...VP.phone, serviceWorkers: 'block' });
      await readOnly(ctx2);
      const p2 = await newAppPage(ctx2, opts);
      const w2 = watch(p2, makeReport(), opts);
      await p2.goto(s1.url, { waitUntil: 'domcontentloaded' });
      await settle(p2, w2, opts, 500);
      if (await p2.evaluate(() => document.getElementById('welcome')?.classList.contains('open'))) { await p2.locator('#wlAgree').check().catch(() => {}); await p2.locator('#wlEnter').click().catch(() => {}); await settle(p2, w2, opts, 300); }
      if (await p2.locator('#tour.open').count()) { await p2.keyboard.press('Escape'); }
      await p2.waitForTimeout(2500);
      const s2 = await p2.evaluate(() => window.lrShareState()).catch(e => ({ err: String(e.message) }));
      const lsState = await p2.evaluate(() => localStorage.getItem('lr_state'));
      out.push({ tab, st, url: s1.url, before: s1.s, after: s2, same: JSON.stringify(s1.s) === JSON.stringify(s2), lsStateAfter: lsState });
      await ctx2.close();
    } catch (e) { out.push({ tab, st, err: String(e.message) }); }
  }
  await context.close();
  save('share.json', out);
  note('share', out.map(o => `${o.tab}/${o.st}:${o.same}`).join(' '));
}

const extraStatic = [];
async function fillExtra() {
  try { const lx = JSON.parse((await get('/api/lines?limit=20')).body.toString()); const g = (lx.rows || lx.markets || lx.lines || []).find(r => r.gameId || r.kind === 'game'); if (g) extraStatic.push(`/lines/game/${encodeURIComponent(g.gameId || g.id)}`, `/lines/game/${encodeURIComponent(g.gameId || g.id)}?odds=decimal`); } catch {}
}
async function staticShots(browser) {
  if (!extraStatic.length) await fillExtra();
  const list = ['/', '/leagues', '/nfl', '/nfl?state=CA', '/nba', '/esports/lol', '/esports/dota2', '/soccer', '/developers', '/status', '/learn', '/digest', '/results', '/r/nobody-here-xyz', '/share/price', '/embed/best-price', '/terms', '/pricing', '/alerts', '/lines', '/lines?odds=decimal&state=CA', '/r', '/r?state=CA', ...extraStatic];
  const out = {};
  for (const [vp, cfg] of Object.entries(VP)) {
    const context = await browser.newContext({ ...cfg, serviceWorkers: 'block' });
    await readOnly(context);
    const page = await context.newPage();
    for (const u of list) {
      try {
        const r = await page.goto(base + u, { waitUntil: 'networkidle', timeout: 30000 });
        await page.waitForTimeout(800);
        const info = await page.evaluate(() => {
          const W = document.documentElement.clientWidth;
          const wide = [...document.querySelectorAll('body *')].filter(e => { const b = e.getBoundingClientRect(); return b.width && (b.right > W + 1 || b.left < -1) && getComputedStyle(e).position !== 'fixed'; }).slice(0, 5).map(e => `${e.tagName}.${e.className}`.slice(0, 80) + ' ' + (e.textContent || '').trim().slice(0, 40));
          const btns = [...document.querySelectorAll('button, a')].filter(b => b.offsetParent).map(b => ({ t: (b.textContent || '').trim().slice(0, 40), href: b.getAttribute('href'), on: !!b.getAttribute('onclick') || b.tagName === 'BUTTON' }));
          return { scrollW: document.documentElement.scrollWidth, W, wide, dead: btns.filter(b => b.href === '#' || b.href === '' ).slice(0, 10), pm: btns.filter(b => /polymarket\.com/.test(b.href || '')).map(b => b.href), title: document.title };
        });
        out[`${vp} ${u}`] = { status: r?.status(), ...info };
        await page.screenshot({ path: path.join(OUT, 'shots', `static-${vp}-${(u.replace(/[^a-z0-9]+/gi, '_') || 'root').slice(0, 40)}.png`), fullPage: vp === 'phone' });
      } catch (e) { out[`${vp} ${u}`] = { err: String(e.message).slice(0, 200) }; }
    }
    await context.close();
  }
  save('static.json', out);
}


// links on the new pages: every internal href answers
async function linksPart() {
  if (!extraStatic.length) await fillExtra();
  const pages = ['/pricing', '/alerts', '/lines', '/lines?kind=prop', '/r', '/developers', ...extraStatic];
  const seen = new Map();
  for (const u of pages) {
    const r = await get(u);
    const html = r.body.toString();
    for (const m of html.matchAll(/href=["']([^"'#][^"']*)["']/g)) {
      let h = m[1].replace(/&amp;/g, '&');
      if (/^(mailto:|javascript:|data:)/.test(h)) continue;
      if (/^https?:/.test(h) && !h.startsWith(base)) { if (!seen.has(h)) seen.set(h, { from: u, external: true }); continue; }
      if (h.startsWith(base)) h = h.slice(base.length);
      if (!h.startsWith('/')) h = '/' + h;
      if (!seen.has(h)) seen.set(h, { from: u });
    }
  }
  let n = 0;
  for (const [h, v] of seen) {
    if (v.external || n++ > 220) continue;
    const r = await get(h);
    v.status = r.status; v.loc = r.loc;
  }
  save('links.json', Object.fromEntries(seen));
  note('links', seen.size, 'bad:', [...seen].filter(([, v]) => v.status && v.status >= 400).map(([h, v]) => `${h}=${v.status}`).join(' '));
}

// the new in-app flows under decimal odds and California
async function inappPart(browser) {
  const out = [];
  for (const [vp, cfg] of Object.entries(VP)) {
    for (const [fmt, st] of [['decimal', 'CA'], ['american', 'TX']]) {
      const context = await browser.newContext({ ...cfg, serviceWorkers: 'block', timezoneId: 'America/Chicago' });
      await readOnly(context);
      const rep = makeReport();
      const opts = { base, viewportName: vp, settleMax: 9000 };
      const page = await newAppPage(context, opts);
      const w = watch(page, rep, opts);
      const row = { vp, fmt, st };
      const shot = n => page.screenshot({ path: path.join(OUT, 'shots', `inapp-${vp}-${fmt}-${n}.png`) }).catch(() => {});
      const am = t => (t.match(/(^|[\s(])[+-]\d{3,4}(?=[\s),]|$)/gm) || []).length;
      const wide = () => page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
      try {
        await enterApp(page, w, opts, rep);
        await page.evaluate(([f, s]) => { localStorage.setItem('lr_odds_fmt', f); localStorage.setItem('lr_state', s); }, [fmt, st]);
        await page.reload({ waitUntil: 'domcontentloaded' });
        await settle(page, w, opts, 400);
        // SEARCH
        try {
          await openTab(page, 'results', w, opts);
          await page.locator('#gsBtn').click();
          await page.locator('#gsModal.open').waitFor({ timeout: 4000 });
          for (const q of ['nba', 'lakers', 'chiefs', 't1']) {
            await page.locator('#gsInput').fill(q);
            await page.waitForTimeout(2500);
            const t = await page.locator('#gsList').innerText();
            row['search ' + q] = { rows: await page.locator('#gsList .gs-row').count(), am: am(t), head: t.slice(0, 700), wide: await wide() };
            if (q === 'nba') await shot('search');
          }
          await page.keyboard.press('Escape');
        } catch (e) { row.searchErr = String(e.message).slice(0, 200); }
        // RESULTS > ALERT HISTORY
        try {
          await openTab(page, 'results', w, opts);
          await page.locator('#page-results [data-recview="alerts"]').click();
          await page.waitForTimeout(4000);
          const t = await page.locator('#alertHistContent').innerText();
          row.alerts = { len: t.length, am: am(t), head: t.slice(0, 1500), proven: /PROVEN/.test(t), wide: await wide() };
          await shot('alerthistory');
          await page.locator('#page-results [data-recview="record"]').click().catch(() => {});
        } catch (e) { row.alertsErr = String(e.message).slice(0, 200); }
        // CHART > Full history link carries the format and state
        row.fullHistory = await page.evaluate(() => { try { return [osFullHistory({ id: 'g1' }, { market: 'ml', id: 'g1|home' }), osFullHistory({ id: 'pk1', player: 'X' }, { id: 's1' })]; } catch (e) { return String(e.message); } });
        // MATCHUPS LOG buttons
        try {
          await openTab(page, 'esports', w, opts);
          await page.waitForTimeout(4000);
          const b = await page.locator('#page-esports button', { hasText: /^LOG/ }).count();
          row.esLog = { logButtons: b, wide: await wide() };
          await shot('esports');
        } catch (e) { row.esErr = String(e.message).slice(0, 200); }
        // MY SLIPS: PUBLISH RECORD and paste box present
        try {
          await openTab(page, 'myslips', w, opts);
          await page.waitForTimeout(2000);
          const t = await page.locator('#page-myslips').innerText();
          row.myslips = { publish: /PUBLISH RECORD/i.test(t), paste: /PASTE/i.test(t), am: am(t), head: t.slice(0, 600), wide: await wide() };
          await shot('myslips');
        } catch (e) { row.msErr = String(e.message).slice(0, 200); }
      } catch (e) { row.crash = String(e.message); }
      row.issues = rep.issues.map(i => ({ ...i, key: undefined })).slice(0, 30);
      out.push(row);
      await context.close();
    }
  }
  save('inapp.json', out);
  note('inapp', out.length);
}

(async () => {
  const t0 = Date.now();
  const only = (process.env.PARTS || 'api,pages,v1,links,static,inapp,share,matrix,crawl').split(',');
  for (const [n, f] of [['api', apiPart], ['pages', pagesPart], ['v1', v1Part], ['links', linksPart]]) { if (!only.includes(n)) continue; try { await f(); } catch (e) { note(n, 'crash', e.stack); } }
  const browser = await chromium.launch();
  for (const [n, f] of [['static', staticShots], ['inapp', inappPart], ['share', sharePart], ['matrix', matrixPart], ['crawl', crawlPart]]) { if (!only.includes(n)) continue; try { await f(browser); } catch (e) { note(n, 'crash', e.stack); } }
  await browser.close();
  const st2 = await get('/api/status');
  try { note('resultsBackup at end', JSON.stringify(JSON.parse(st2.body.toString()).resultsBackup).slice(0, 300)); } catch {}
  note('done in', Math.round((Date.now() - t0) / 1000), 's');
  save(`log-${process.env.PARTS || 'all'}.txt`, log.join('\n'));
})();
