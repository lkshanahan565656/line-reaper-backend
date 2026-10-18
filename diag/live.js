const fs = require('fs'); const P = 'https://line-reaper-backend-production.up.railway.app';
const wait = ms => new Promise(r => setTimeout(r, ms));
const get = async u => { try { const r = await fetch(u, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(120000) }); return r.ok ? await r.json() : { error: r.status }; } catch (e) { return { error: e.message }; } };
const out = []; const say = s => { out.push(s); console.log(s); fs.writeFileSync('out/report.txt', out.join('\n')); };
(async () => {
  fs.mkdirSync('out', { recursive: true });
  let v; for (let i = 0; i < 60; i++) { v = (await get(P + '/')).version; if (v === '3.142.0') break; await wait(20e3); }
  say('version ' + v);
  const sb = await get(P + '/api/ev/scoreboard'); fs.writeFileSync('out/scoreboard.json', JSON.stringify(sb));
  for (const r of (sb.rows || []).filter(r => ['fanduel', 'betrivers'].includes(r.book) && ['ev', 'alt'].includes(r.kind))) say(`${r.book} ${r.kind}: ${r.graded} games, clv ${r.avgClv}, 2min ${r.avgExecClv}, mark ${r.mark}`);
  say(`byBook fanduel ${sb.byBook?.fanduel?.mark}, betrivers ${sb.byBook?.betrivers?.mark}; proven rows: ${(sb.rows || []).filter(r => r.mark === 'proven').map(r => r.book + ':' + r.kind).join(', ')}`);
  const st = await get(P + '/api/status'); say('alertBooks ' + JSON.stringify(st.ev?.alertBooks ?? st.alerts?.books ?? null));
  const pr = await get(P + '/api/props/record'); fs.writeFileSync('out/props-record.json', JSON.stringify(pr));
  for (const s of ['open', 'locked', 'graded', 'void']) { const d = await get(`${P}/api/props/record/picks?limit=1000&status=${s}`); const p = d.picks || []; const nfl = p.filter(x => /nfl/i.test(x.sport)); say(`props ${s}: ${p.length} (NFL ${nfl.length}, NFL started ${nfl.filter(x => Date.parse(x.start) < Date.now()).length})`); fs.writeFileSync(`out/picks-${s}.json`, JSON.stringify(p)); }
  const { chromium } = require('playwright'); const browser = await chromium.launch();
  for (const [name, w, h, mobile] of [['phone', 390, 844, true], ['desktop', 1280, 900, false]]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2, isMobile: mobile }); const page = await ctx.newPage();
    await page.goto(P + '/app?start=app', { waitUntil: 'domcontentloaded' }); await wait(5000);
    await page.evaluate(() => { const t = [...document.querySelectorAll('.tab')].find(b => /\+EV/.test(b.textContent)); if (t) t.click(); }); await wait(5000);
    await page.evaluate(() => { try { evSet('kind', 'record'); } catch (e) {} }); await wait(8000);
    await page.screenshot({ path: `out/record-${name}.png`, fullPage: false });
    await page.evaluate(() => { try { evBoardSet('kind'); } catch (e) {} }); await wait(3000);
    await page.screenshot({ path: `out/record-kind-${name}.png`, fullPage: false });
    await page.evaluate(() => { try { evBoardSet('bookkind'); } catch (e) {} }); await wait(3000);
    await page.screenshot({ path: `out/record-bookkind-${name}.png`, fullPage: true });
    await page.evaluate(() => { try { evSet('kind', 'alt'); } catch (e) {} }); await wait(6000);
    await page.screenshot({ path: `out/alt-${name}.png` });
    say(`${name} text has proven: ` + await page.evaluate(() => (document.body.innerText.match(/.{0,60}proven.{0,40}/gi) || []).slice(0, 6).join(' || ')));
    await ctx.close();
  }
  await browser.close(); process.exit(0);
})();
