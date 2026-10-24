const fs = require('fs'); const { spawn } = require('child_process');
const B = 'http://localhost:3999';
const wait = ms => new Promise(r => setTimeout(r, ms));
const get = async u => { try { const r = await fetch(u, { signal: AbortSignal.timeout(180000) }); return r.ok ? await r.json() : { error: r.status }; } catch (e) { return { error: e.message }; } };
const out = []; const say = s => { out.push(s); console.log(s); fs.writeFileSync('out/report.txt', out.join('\n')); };
(async () => {
  fs.mkdirSync('out', { recursive: true }); fs.mkdirSync('/tmp/lr', { recursive: true });
  // the relay script on its own: how long one full read takes, and what it gets
  const t1 = Date.now();
  try { require('child_process').execSync('node relay/pick6.js out/pick6.json', { stdio: 'inherit', timeout: 600000 }); } catch (e) { say('relay failed ' + e.message); }
  say(`relay read took ${Math.round((Date.now() - t1) / 1000)} s`);
  try { const d = JSON.parse(fs.readFileSync('out/pick6.json')); for (const [k, v] of Object.entries(d.bySport)) { const m = {}; for (const l of v.lines) m[l.market] = (m[l.market] || 0) + 1; say(`P6 ${k}: ${v.lines.length} lines, ${v.tabs} tabs: ${Object.entries(m).map(([a, b]) => `${a} ${b}`).join(', ')}`); } } catch (e) { say('relay parse ' + e.message); }
  spawn('node', ['server.js'], { env: { ...process.env, PORT: '3999', LR_DATA_DIR: '/tmp/lr', PINNACLE: 'on', PICK6: 'on' }, stdio: ['ignore', fs.openSync('out/server.log', 'w'), fs.openSync('out/server.err', 'w')] });
  const runMin = +(process.env.RUNMIN || 24), t0 = Date.now();
  while (Date.now() - t0 < runMin * 60e3) {
    await wait(6 * 60e3);
    const d = await get(B + '/api/diag/combo');
    const rows = d.rows || [];
    const q = {}; for (const r of rows) for (const x of new Set((r.quotes || []).map(x => x.book))) q[x] = (q[x] || 0) + 1;
    const nba = d.counts?.nba?.props;
    say(`\n${d.at} combo rows ${rows.length} (by app ${JSON.stringify(rows.reduce((a, r) => { for (const b of Object.keys(r.books)) a[b] = (a[b] || 0) + 1; return a; }, {}))}); rows with a quote from ${JSON.stringify(q)}; Pinnacle parts on ${rows.filter(r => r.parts && Object.values(r.parts).every(l => l.length)).length}; NBA props read ${JSON.stringify(nba)}`);
    const c = rows.filter(r => r.combo);
    say(`combo clears ${c.length}`);
    for (const r of c) for (const p of r.combo.plays) say(`  ${r.sport} ${r.player} ${r.mkey} | ${p.book} ${p.side} ${p.line} ev ${p.ev} min ${p.evMin} | ${r.startTime} | ${r.combo.sources.map(s => `${s.book} ${s.line} ${s.p}%o`).join(', ')}`);
    fs.writeFileSync('out/combo.json', JSON.stringify(d));
    const st = await get(B + '/api/status'); say(`v${st.version} pick6 ${JSON.stringify(st.pick6 || st.pickem?.pick6 || '').slice(0, 300)}`);
  }
  const rec = await get(B + '/api/props/record'); say('record byKind combo: ' + JSON.stringify(rec.byKind?.combo || null) + ' p6-combo ' + JSON.stringify(rec.byKind?.['p6-combo'] || null));
  try {
    const { chromium } = require('playwright'); const browser = await chromium.launch();
    for (const [name, w, h, mobile] of [['phone', 390, 844, true], ['desktop', 1280, 900, false]]) {
      const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2, isMobile: mobile });
      const page = await ctx.newPage();
      await page.route(/line-reaper-backend-production\.up\.railway\.app/, route => route.continue({ url: route.request().url().replace(/https:\/\/line-reaper-backend-production\.up\.railway\.app/, B) }));
      await page.goto(B + '/app?start=app', { waitUntil: 'domcontentloaded' }); await wait(4000);
      await page.evaluate(() => { const t = [...document.querySelectorAll('.tab')].find(b => b.textContent.trim() === 'PROPS'); if (t) t.click(); }); await wait(5000);
      await page.evaluate(() => { pbState.sport = 'NBA'; pbState.view = 'cards'; try { localStorage.setItem('lr_pb_view', 'cards'); } catch (e) {} loadPropsBoard(); }); await wait(7000);
      const el = await page.$('.pb-gap.dim[title*="Pinnacle\'s parts"], .pb-gap.dim[title*="break-even"]'); if (el) await el.scrollIntoViewIfNeeded();
      await page.screenshot({ path: `out/cb-props-${name}.png` });
      await ctx.close();
    }
    await browser.close(); say('renders done');
  } catch (e) { say('render error ' + e.message); }
  process.exit(0);
})();
