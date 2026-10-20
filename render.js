const { chromium } = require('playwright');
const fs = require('fs');
const models = JSON.parse(fs.readFileSync('models.json'));
const esModels = Object.fromEntries(models.models.map(c => [c.key, { verdict: c.verdict, graded: c.graded, wins: c.wins, losses: c.losses, hitPct: c.hitPct, breakEvenPct: c.breakEvenPct, units: c.units }]));
(async () => {
  const b = await chromium.launch();
  for (const [name, vp] of [['desktop', { width: 1280, height: 900 }], ['phone', { width: 390, height: 844 }]]) {
    const ctx = await b.newContext({ viewport: vp, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    await page.addInitScript(() => { try { localStorage.setItem('lr_pb_lbook', 'prizepicks'); localStorage.setItem('lr_es_view', 'record'); } catch {} });
    await page.route('**/api/esports/models*', r => r.fulfill({ json: models }));
    await page.route('**/api/esports/auto-slips*', async r => { const resp = await r.fetch(); let j = {}; try { j = await resp.json(); } catch {} j.stackNeeds = models.stacks; await r.fulfill({ json: j }); });
    await page.route('**/api/props/board*', async r => { const resp = await r.fetch(); let j = {}; try { j = await resp.json(); } catch {} j.esModels = esModels; await r.fulfill({ json: j }); });
    await page.goto('http://127.0.0.1:8080/index.html', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(4000);
    const shot = async f => { await page.waitForTimeout(9000); await page.screenshot({ path: `out/${f}-${name}.png`, fullPage: true }); };
    await page.evaluate(() => showTab('esports', document.querySelector(".tab[onclick*=esports]")));
    await page.waitForTimeout(3000);
    await page.evaluate(() => { try { setEsMode('props'); } catch (e) {} });
    await page.waitForTimeout(3000);
    await page.evaluate(() => setEsportsView('record'));
    await shot('record');
    await page.evaluate(() => setEsportsView('plays'));
    await shot('plays');
    await page.evaluate(() => showTab('props', document.querySelector(".tab[onclick*=props]")));
    await shot('lines');
    fs.writeFileSync(`out/text-${name}.txt`, await page.evaluate(() => document.body.innerText.slice(0, 20000)));
    await ctx.close();
  }
  await b.close();
})().catch(e => { console.error(e); fs.writeFileSync('out/error.txt', String(e.stack)); });
