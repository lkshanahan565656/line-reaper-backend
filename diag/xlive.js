const fs = require('fs');
const { chromium } = require('playwright');
const U = 'https://line-reaper-backend-production.up.railway.app';
(async () => {
  fs.mkdirSync('out', { recursive: true });
  const ev = await (await fetch(`${U}/api/ev?minEv=0&limit=1000`)).json();
  const clear = ev.rows.filter(r => !r.dfs && r.ev >= 2);
  const tally = f => clear.reduce((m, r) => { const k = f(r); m[k] = (m[k] || 0) + 1; return m; }, {});
  fs.writeFileSync('out/ev.json', JSON.stringify({ counts: ev.counts, clear2: clear.length, byBook: tally(r => r.book), bySource: tally(r => (r.sharpBooks || []).slice().sort().join('+') || r.source),
    consensusRelayed: clear.filter(r => r.source === 'consensus' && ['draftkings','betmgm','caesars','bet365','fanatics','hardrock','thescore'].includes(r.book)).length,
    matchbookOnly: clear.filter(r => (r.sharpBooks || []).join() === 'matchbook').length, agreeWithMb: clear.filter(r => r.agree).map(r => r.sharpBooks.join('+')) }, null, 1));
  const b = await chromium.launch();
  for (const [name, w, h] of [['phone', 390, 844], ['desktop', 1280, 900]]) {
    const p = await b.newPage({ viewport: { width: w, height: h } });
    await p.goto(`${U}/app`, { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {});
    await p.locator('input[type=checkbox]').first().check().catch(e => console.log(e.message));
    await p.getByText('Enter the app').first().click().catch(e => console.log(e.message));
    await p.waitForTimeout(5000);
    await p.locator('button.tab', { hasText: '+EV' }).first().click().catch(e => console.log(e.message));
    await p.waitForTimeout(8000);
    await p.screenshot({ path: `out/ev-${name}.png`, fullPage: false });
  }
  await b.close();
})();
