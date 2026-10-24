const { chromium } = require('playwright');
process.on('unhandledRejection', () => {});
process.on('uncaughtException', e => console.error('ignored', e.message));
const fs = require('fs');
const models = JSON.parse(fs.readFileSync('models.json'));
const esModels = Object.fromEntries(models.models.map(c => [c.key, { verdict: c.verdict, graded: c.graded, wins: c.wins, losses: c.losses, hitPct: c.hitPct, breakEvenPct: c.breakEvenPct, units: c.units }]));
(async () => {
  const b = await chromium.launch();
  for (const [name, vp] of [['desktop', { width: 1280, height: 900 }], ['phone', { width: 390, height: 844 }]]) {
    const ctx = await b.newContext({ viewport: vp, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    await page.addInitScript(() => { try { localStorage.setItem('lr_pb_lbook', 'prizepicks'); localStorage.setItem('lr_es_view', 'record'); sessionStorage.setItem('lr_welcomed', '1'); } catch {} });
    
    const SL = JSON.parse(fs.readFileSync('slips.json'));
    await page.route('**/api/esports/auto-slips*', r => r.fulfill({ json: SL }));
    if (0) await page.route('**/api/esports/auto-slips*', async r => { try { const resp = await r.fetch(); let j = {}; try { j = await resp.json(); } catch {} if (!j.stackNeeds) j.stackNeeds = models.stacks; await r.fulfill({ json: j }); } catch (e) {} });
    await page.route('**/api/props/board*', async r => { try { const resp = await r.fetch(); let j = {}; try { j = await resp.json(); } catch {} j.esModels = esModels; await r.fulfill({ json: j }); } catch (e) {} });
    await page.goto('http://127.0.0.1:8080/index.html', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(4000);
    const shot = async (f, want) => { if (want) await page.waitForFunction(w => (document.querySelector('.page.active')?.innerText || '').includes(w), want, { timeout: 120000 }).catch(() => {}); await page.waitForTimeout(5000); await page.screenshot({ path: `out/${f}-${name}.png`, fullPage: true }); fs.writeFileSync(`out/${f}-${name}.txt`, await page.evaluate(() => document.querySelector('.page.active')?.innerText.slice(0, 30000) || '')); };
    await page.evaluate(() => showTab('esports', document.querySelector(".tab[onclick*=esports]")));
    await page.waitForTimeout(3000);
    await page.evaluate(() => { try { setEsMode('props'); } catch (e) {} });
    await page.waitForTimeout(3000);
    await page.evaluate(() => setEsportsView('record'));
    await shot('record', 'ESPORTS MODELS');
    await page.evaluate(() => setEsportsView('plays'));
    await page.waitForFunction(() => (document.querySelector('.page.active')?.innerText || '').includes('Plays'), null, { timeout: 200000 }).catch(() => {}); await shot('plays', 'If repriced');
    await page.evaluate(() => showTab('props', document.querySelector(".tab[onclick*=props]")));
    await shot('lines', 'PRIZEPICKS');
    fs.writeFileSync(`out/text-${name}.txt`, await page.evaluate(() => document.body.innerText.slice(0, 20000)));
    await page.unrouteAll({ behavior: 'ignoreErrors' }); await ctx.close();
  }
  await b.close();
})().catch(e => { console.error(e); fs.writeFileSync('out/error.txt', String(e.stack)); });
