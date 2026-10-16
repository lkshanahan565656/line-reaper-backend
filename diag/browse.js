// open each page in headless Chrome, record every XHR/fetch JSON response
const fs = require('fs');
const { chromium } = require('playwright-core');
const PAGES = [
  ['dk-nhl', 'https://sportsbook.draftkings.com/leagues/hockey/nhl'],
  ['dk-nhl-sog', 'https://sportsbook.draftkings.com/leagues/hockey/nhl?category=shots-on-goal&subcategory=shots-on-goal'],
  ['hr-home', 'https://app.hardrock.bet/'],
  ['hr-nhl', 'https://app.hardrock.bet/sports/ice-hockey/nhl'],
];
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
  const log = [];
  for (const [name, url] of PAGES) {
    const ctx = await browser.newContext({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36', locale: 'en-US', timezoneId: 'America/New_York', geolocation: { latitude: 40.73, longitude: -74.17 }, permissions: ['geolocation'] });
    const page = await ctx.newPage();
    let n = 0;
    page.on('response', async r => {
      const ct = r.headers()['content-type'] || '';
      const req = r.request();
      if (!/json|graphql|text\/plain/.test(ct) && !/api|graphql/.test(r.url())) return;
      if (/google|facebook|segment|sentry|doubleclick|appsflyer|optimizely|launchdarkly|datadog|onetrust|cookielaw/.test(r.url())) return;
      let body = '';
      try { body = await r.text(); } catch {}
      n++;
      const f = `out/${name}-${String(n).padStart(3, '0')}.txt`;
      fs.writeFileSync(f, `${req.method()} ${r.url()}\nSTATUS ${r.status()}\nREQHEADERS ${JSON.stringify(req.headers())}\nPOST ${req.postData() || ''}\n\n${body.slice(0, 4e6)}`);
      log.push({ page: name, f, method: req.method(), url: r.url().slice(0, 400), status: r.status(), len: body.length });
    });
    try { await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 }); } catch (e) { log.push({ page: name, error: e.message.slice(0, 200) }); }
    await page.waitForTimeout(8000);
    try { fs.writeFileSync(`out/${name}.html`, await page.content()); await page.screenshot({ path: `out/${name}.png` }); } catch {}
    fs.writeFileSync('out/browse.json', JSON.stringify(log, null, 1));
    await ctx.close();
  }
  await browser.close();
})();
