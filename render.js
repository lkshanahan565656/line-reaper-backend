const { chromium } = require('playwright');
const fs = require('fs');
const PROD = 'https://line-reaper-backend-production.up.railway.app';
const L = 'http://localhost:3999';
const TAG = process.argv[2] === 'again' ? 'after2' : 'after';
const slips = [
  { id: 's1', app: 'prizepicks', placedAt: new Date(Date.now() - 2 * 86400e3).toISOString(), stake: 10, payout: 60, flex: false, result: 'win', legs: [
    { player: 'Josh Allen', side: 'Over', line: 245.5, market: 'Pass Yds', sport: 'NFL' }, { player: 'Bo Nix', side: 'Under', line: 220.5, market: 'Pass Yds', sport: 'NFL' }, { player: 'Stefon Diggs', side: 'Over', line: 60.5, market: 'Rec Yds', sport: 'NFL' }] },
  { id: 's2', app: 'underdog', placedAt: new Date(Date.now() - 86400e3).toISOString(), stake: 5, flex: false, result: 'loss', legs: [
    { player: 'Jayson Tatum', side: 'Over', line: 27.5, market: 'Points', sport: 'NBA' }, { player: 'Jaylen Brown', side: 'Under', line: 24.5, market: 'Points', sport: 'NBA' }] },
];
const bets = [{ id: 'b1', placedAt: new Date(Date.now() - 3 * 86400e3).toISOString(), event: 'Cowboys @ Giants', pick: 'Giants +3', sport: 'NFL', book: 'Kalshi', tool: 'Manual', odds: 2.05, cents: false, stake: 20, unitUsd: 10, result: 'win', cashout: null, closeOdds: 1.95, track: null, settledAt: new Date().toISOString(), settledBy: 'manual', notes: '' }];
(async () => {
  const browser = await chromium.launch();
  const rep = {};
  for (const [w, h, tag] of [[390, 844, 'phone'], [1280, 900, 'desktop']]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h } });
    await ctx.addInitScript(([slips, bets]) => { try { sessionStorage.setItem('lr_welcomed', '1'); localStorage.setItem('lr_slips', JSON.stringify(slips)); localStorage.setItem('lr_bets', JSON.stringify(bets)); } catch {} }, [slips, bets]);
    await ctx.route(PROD + '/**', r => r.continue({ url: r.request().url().replace(PROD, L) }));
    const page = await ctx.newPage();
    const errs = []; page.on('pageerror', e => errs.push(e.message));
    await page.goto(L + '/app', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(5000);
    const tab = async (t, wait = 6000) => { await page.evaluate(t => { const el = [...document.querySelectorAll('.tab')].find(x => (x.getAttribute('onclick') || '').includes(`'${t}'`)); showTab(t, el || null); }, t); await page.waitForTimeout(wait); };
    try {
      await tab('odds');
      await page.screenshot({ path: `out/${TAG}-odds-${tag}.png` });
      rep[`${tag}/odds`] = (await page.evaluate(() => document.getElementById('page-odds').innerText)).slice(0, 6000);
      await page.evaluate(() => { const b = document.querySelector('#osContent .os-btn'); if (b) b.click(); });
      await page.waitForTimeout(3000);
      const ch = await page.$('.os-chart');
      if (ch) { await ch.scrollIntoViewIfNeeded(); const bx = await ch.boundingBox(); if (bx) await page.mouse.move(bx.x + bx.width * 0.6, bx.y + 80); await page.waitForTimeout(500); await page.screenshot({ path: `out/${TAG}-oddschart-${tag}.png` }); }
      await page.evaluate(() => { document.getElementById('osState').value = 'TX'; osSet('state', 'TX'); });
      await page.waitForTimeout(4000);
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({ path: `out/${TAG}-oddstx-${tag}.png` });
      await page.evaluate(() => osSet('state', ''));
    } catch (e) { errs.push('odds: ' + e.message); }
    try {
      await tab('tools', 4000);
      await page.evaluate(() => openTool('pickem'));
      await page.waitForTimeout(1500);
      await page.screenshot({ path: `out/${TAG}-pickem-${tag}.png`, fullPage: true });
    } catch (e) { errs.push('tools: ' + e.message); }
    try {
      await tab('betlog', 6000);
      await page.screenshot({ path: `out/${TAG}-betlog-${tag}.png`, fullPage: true });
      rep[`${tag}/betlog`] = (await page.evaluate(() => document.getElementById('page-betlog').innerText)).slice(0, 3000);
    } catch (e) { errs.push('betlog: ' + e.message); }
    rep[`${tag}/sw`] = await page.evaluate(() => document.documentElement.scrollWidth);
    rep[`${tag}/errors`] = errs;
    await ctx.close();
    const c2 = await browser.newContext({ viewport: { width: w, height: h } });
    await c2.route(PROD + '/**', r => r.continue({ url: r.request().url().replace(PROD, L) }));
    const p2 = await c2.newPage();
    await p2.goto(L + '/', { waitUntil: 'networkidle' }).catch(() => {});
    await p2.waitForTimeout(4000);
    await p2.screenshot({ path: `out/${TAG}-landing-${tag}.png`, fullPage: true });
    rep[`${tag}/landing`] = (await p2.evaluate(() => document.body.innerText)).slice(0, 5000);
    const p3 = await c2.newPage();
    await p3.goto(L + '/app', { waitUntil: 'domcontentloaded' }); await p3.waitForTimeout(5000);
    await p3.screenshot({ path: `out/${TAG}-welcome-${tag}.png` });
    await c2.close();
  }
  fs.writeFileSync(`out/report-${TAG}.json`, JSON.stringify(rep, null, 1));
  await browser.close();
})();
