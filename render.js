const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const fs = require('fs');
(async () => {
  const snap = JSON.parse(fs.readFileSync('/tmp/kh/gas-snap.json', 'utf8'));
  // a graded sample so the GRADED table and record tiles render too
  const variants = { live: snap, graded: { ...snap, record: { open: 116, graded: 3, wins: 2, losses: 1, units: -0.95, roi: -0.3167, avgClv: 0.011, clvN: 3 },
    recent: [{ state: 'CA', day: '26OCT14', side: 'yes', strike: 4.66, price: 0.97, outcome: 'win', profit: 0.0303 }, { state: 'OH', day: '26OCT14', side: 'no', strike: 3.55, price: 0.95, outcome: 'loss', profit: -1 }, { state: 'WA', day: '26OCT14', side: 'yes', strike: 5.45, price: 0.98, outcome: 'win', profit: 0.0191 }] },
    free: { count: 116, pro: false, record: snap.record, backtest: snap.backtest, rule: snap.rule, recent: [] } };
  const html = fs.readFileSync('/home/claude/line-reaper-backend/public/index.html', 'utf8');
  const b = await chromium.launch({ executablePath: fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined });
  for (const [v, data] of Object.entries(variants)) for (const [w, h, tag] of [[390, 1400, 'phone'], [1280, 1100, 'desktop']]) {
    const p = await b.newPage({ viewport: { width: w, height: h } });
    const errs = []; p.on('pageerror', e => errs.push(e.message));
    await p.route('**/*', r => {
      const u = r.request().url();
      if (u === 'https://app.local/') return r.fulfill({ body: html, contentType: 'text/html' });
      if (u.includes('/api/gas-locks')) return r.fulfill({ body: JSON.stringify(data), contentType: 'application/json' });
      if (u.includes('/api/')) return r.fulfill({ body: '{}', contentType: 'application/json' });
      if (/fonts\.g|cdn/.test(u)) return r.abort();
      return r.fulfill({ body: '', status: 404 });
    });
    await p.goto('https://app.local/', { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(800);
    await p.evaluate(() => { const btn = [...document.querySelectorAll('.tab')].find(x => x.textContent.trim() === 'GAS LOCKS'); showTab('gas', btn); });
    await p.waitForTimeout(1200);
    // close any welcome overlay
    await p.evaluate(() => document.querySelectorAll('.welcome, #welcome, .modal-backdrop, #lrWelcome').forEach(e => e.remove()));
    const sw = await p.evaluate(() => document.documentElement.scrollWidth);
    await p.screenshot({ path: `/tmp/kh/shots/gas-${v}-${tag}.png`, fullPage: false });
    console.log(v, tag, 'scrollWidth', sw, 'errors', errs.slice(0, 3));
    await p.close();
  }
  await b.close();
})();
