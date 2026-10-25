// Live check for PR 224 (v3.162.0): learn pages, features flag, prop history.
const fs = require('fs');
const B = 'https://line-reaper-backend-production.up.railway.app';
const out = { checks: {} };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const get = async (p, o = {}) => { const t0 = Date.now(); try { const r = await fetch(B + p, { signal: AbortSignal.timeout(30000), ...o }); return { status: r.status, ms: Date.now() - t0, text: await r.text(), headers: Object.fromEntries(r.headers) }; } catch (e) { return { status: 0, error: e.message }; } };
(async () => {
  fs.mkdirSync('out', { recursive: true });
  const t0 = Date.now();
  let v = null;
  while (Date.now() - t0 < 25 * 60e3) { const r = await get('/api/health'); try { v = JSON.parse(r.text).version; } catch {} if (v === '3.162.0') break; await sleep(20000); }
  out.version = v; out.waitedS = Math.round((Date.now() - t0) / 1000);
  for (const p of ['/learn', '/learn/no-vig-fair-odds', '/learn/expected-value', '/learn/closing-line-value', '/learn/hold-and-arbitrage', '/learn/middles', '/learn/kelly-criterion', '/learn/exchange-fees', '/learn/pickem-math', '/learn/how-the-record-works']) {
    const r = await get(p);
    out.checks[p] = { status: r.status, ms: r.ms, h1: (r.text || '').match(/<h1>([^<]+)/)?.[1], bad: /NaN|undefined|Infinity/.test(r.text || '') };
  }
  const red = await get('/learn/clv', { redirect: 'manual' });
  out.checks.redirect = { status: red.status, location: red.headers?.location };
  out.checks.features = (await get('/api/features')).text;
  out.checks.sitemapHasLearn = /\/learn\/pickem-math/.test((await get('/sitemap.xml')).text || '');
  out.checks.landingLinksLearn = /href="\/learn"/.test((await get('/', { headers: { accept: 'text/html' } })).text || '');
  out.checks.appHasNewCode = ['shpPresetBar', 'shpMovesBlock', 'LAY_ODDS_API'].map(k => [k, ((out._app = out._app || (await get('/app')).text) || '').includes(k)]);
  delete out._app;
  // prop history fills after the first quote builds: poll status up to 8 min
  for (let i = 0; i < 24; i++) {
    const r = await get('/api/status'); let s = null; try { s = JSON.parse(r.text); } catch {}
    out.checks.propHistory = s?.propHistory || { status: r.status, error: r.error };
    if (s?.propHistory?.series > 0) break;
    await sleep(20000);
  }
  const sh = await get('/api/shopper?markets=player_prop&limit=5&sort=venues');
  try {
    const d = JSON.parse(sh.text);
    out.checks.shopperProps = { status: sh.status, counts: d.counts, firstKeys: d.markets.slice(0, 5).map(m => m.key) };
    for (const k of d.markets.slice(0, 5).map(m => m.key)) {
      const h = JSON.parse((await get(`/api/shopper/history?key=${encodeURIComponent(k)}`)).text);
      (out.checks.history = out.checks.history || []).push({ key: k, sides: h.series.length, pts: h.series[0]?.pts.length || 0, venues: Object.keys(h.series[0]?.pts.at(-1)?.[3] || {}), fair: h.series[0]?.pts.at(-1)?.[2] ?? null });
    }
    const fav = JSON.parse((await get('/api/shopper?league=nfl,nba&limit=5')).text);
    out.checks.leagueList = fav.facets ? Object.keys(fav.facets.leagues) : fav;
  } catch (e) { out.checks.shopperProps = { status: sh.status, error: e.message }; }
  fs.writeFileSync('out/result.json', JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
})();
