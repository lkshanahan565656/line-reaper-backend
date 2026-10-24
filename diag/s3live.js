// Branch server on live feeds: which pick'em legs Pinnacle + two more sharps price at the app's number
const fs = require('fs'); const { spawn } = require('child_process');
const B = 'http://localhost:3999';
const wait = ms => new Promise(r => setTimeout(r, ms));
const get = async u => { try { const r = await fetch(u, { signal: AbortSignal.timeout(120000) }); return r.ok ? await r.json() : { error: r.status }; } catch (e) { return { error: e.message }; } };
const out = []; const say = s => { out.push(s); console.log(s); fs.writeFileSync('out/report.txt', out.join('\n')); };
async function board() { const rows = []; for (let off = 0; off < 60000; off += 500) { const d = await get(`${B}/api/props/board?sport=SPORTS&sort=start&limit=500&offset=${off}`); rows.push(...(d.rows || [])); if (!d.rows || d.rows.length < 500) break; } return rows; }
(async () => {
  fs.mkdirSync('out', { recursive: true }); fs.mkdirSync('/tmp/lr', { recursive: true });
  const srv = spawn('node', ['server.js'], { env: { ...process.env, PORT: '3999', LR_DATA_DIR: '/tmp/lr', PINNACLE: 'on', PICK6: 'on' }, stdio: ['ignore', fs.openSync('out/server.log', 'w'), fs.openSync('out/server.err', 'w')] });
  const runMin = +(process.env.RUNMIN || 20), t0 = Date.now();
  const snaps = [];
  while (Date.now() - t0 < runMin * 60e3) {
    await wait(5 * 60e3);
    const rows = await board();
    const st = await get(B + '/api/status');
    const s3 = rows.filter(r => r.threeSharp);
    // coverage: app cells where Pinnacle hangs the same number, and how many of FD/BR/Kalshi do too
    const cov = {};
    for (const r of rows) for (const [bk, c] of Object.entries(r.books || {})) {
      const k = `${r.sport}|${bk}`; const o = (cov[k] ||= { cells: 0, pin: 0, pin1: 0, pin2: 0 });
      o.cells++;
      if (r.pinnacle?.line !== c.line) continue;
      o.pin++;
      const others = new Set((r.consensus?.sources || []).filter(s => ['fanduel', 'betrivers'].includes(s.book) && s.line === c.line).map(s => s.book));
      if (c.fair != null) others.add('kalshi');
      if (others.size >= 1) o.pin1++; if (others.size >= 2) o.pin2++;
    }
    snaps.push({ at: new Date().toISOString(), rows: rows.length, s3: s3.length });
    say(`\n${new Date().toISOString()} v${st.version} rows ${rows.length}, three-sharps rows ${s3.length}`);
    say('coverage sport|app cells / Pinnacle at number / +1 / +2: ' + Object.entries(cov).filter(([, o]) => o.pin).map(([k, o]) => `${k} ${o.cells}/${o.pin}/${o.pin1}/${o.pin2}`).join('  '));
    for (const r of s3) for (const p of r.threeSharp.plays) say(`  ${r.sport} ${r.player} ${r.market} | ${p.book} ${p.side} ${p.line} ev ${p.ev} min ${p.evMin} | ${r.matchTitle || ''} ${r.startTime} | ${r.threeSharp.sources.map(s => `${s.book} ${s.line} ${s.p}%o`).join(', ')} | entries ${(r.threeSharp.entries || []).join(',')}`);
    fs.writeFileSync('out/board.json', JSON.stringify(rows.filter(r => r.threeSharp || r.consensus)));
  }
  const rec = await get(B + '/api/props/record'); fs.writeFileSync('out/record.json', JSON.stringify(rec));
  say('\nrecord byKind sharp3: ' + JSON.stringify(rec.byKind?.sharp3 || null) + ' p6: ' + JSON.stringify(rec.byKind?.['p6-sharp3'] || null));
  const sb = await get(B + '/api/ev/scoreboard?state=TX'); fs.writeFileSync('out/scoreboard.json', JSON.stringify(sb));
  say('TX scoreboard sharp3 rows: ' + JSON.stringify((sb.rows || []).filter(r => /sharp3/.test(r.kind)).map(r => ({ kind: r.kindLabel, book: r.bookName, recorded: r.recorded, mark: r.mark }))));
  try {
    const { chromium } = require('playwright'); const browser = await chromium.launch();
    for (const [name, w, h, mobile] of [['phone', 390, 844, true], ['desktop', 1280, 900, false]]) {
      const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2, isMobile: mobile });
      const page = await ctx.newPage();
      await page.route(/line-reaper-backend-production\.up\.railway\.app/, route => route.continue({ url: route.request().url().replace(/https:\/\/line-reaper-backend-production\.up\.railway\.app/, B) }));
      await page.goto(B + '/app?start=app', { waitUntil: 'domcontentloaded' }); await wait(4000);
      await page.evaluate(() => { const t = [...document.querySelectorAll('.tab')].find(b => b.textContent.trim() === 'PROPS'); if (t) t.click(); }); await wait(5000);
      await page.evaluate(() => { pbState.sport = 'SPORTS'; pbState.view = 'cards'; try { localStorage.setItem('lr_pb_view', 'cards'); } catch (e) {} loadPropsBoard(); }); await wait(7000);
      const el = await page.$('.pb-gap.dim[title*="three"], .pb-gap.dim[title*="sharps"]'); if (el) await el.scrollIntoViewIfNeeded();
      await page.screenshot({ path: `out/s3-props-${name}.png` });
      await page.evaluate(() => { const t = [...document.querySelectorAll('.tab')].find(b => /TRACK|\+EV/.test(b.textContent.trim())); if (t) t.click(); }); await wait(6000);
      await page.screenshot({ path: `out/s3-record-${name}.png`, fullPage: false });
      await ctx.close();
    }
    await browser.close(); say('renders done');
  } catch (e) { say('render error ' + e.message); }
  srv.kill(); process.exit(0);
})();
