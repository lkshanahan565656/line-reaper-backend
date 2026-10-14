const fs = require('fs');
fs.mkdirSync('out', { recursive: true });
const AK = 'FhMFpcPWXMeyZxOx';
const H = { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36', accept: 'application/json', origin: 'https://sportsbook.fanduel.com', referer: 'https://sportsbook.fanduel.com/' };
const FD = 'https://sbapi.nj.sportsbook.fanduel.com/api';
const out = {};
const get = async (name, url) => { try { const r = await fetch(url, { headers: H, signal: AbortSignal.timeout(25000) }); const t = await r.text(); out[name] = { status: r.status, bytes: t.length, head: t.slice(0, 300) }; return t; } catch (e) { out[name] = { error: String(e) }; return ''; } };
(async () => {
  const nfl = JSON.parse(await get('nfl', `${FD}/content-managed-page?page=CUSTOM&customPageId=nfl&pbHorizontal=false&_ak=${AK}&timezone=America%2FNew_York`) || '{}');
  const gid = Object.values(nfl?.attachments?.events || {}).find(e => / @ /.test(e.name))?.eventId;
  await get('ev_real', `${FD}/event-page?_ak=${AK}&eventId=${gid}`);
  await get('ev_bogus', `${FD}/event-page?_ak=${AK}&eventId=99999999`);
  const extra = '&useCombinedTouchdownsVirtualMarket=true&usePulse=true&useQuickBets=true&useQuickBetsMLB=true&includePrices=true&pbHorizontal=false&timezone=America%2FNew_York';
  for (const id of [30861650, 34118083, 34052664]) {
    await get(`ev_${id}_extra`, `${FD}/event-page?_ak=${AK}&eventId=${id}${extra}`);
    await get(`ev_${id}_tab`, `${FD}/event-page?_ak=${AK}&eventId=${id}&tab=odds-boosts`);
  }
  for (const [hn, hv] of [['x-sportsbook-region', 'NJ'], ['X-Sportsbook-Region', 'nj']]) { H[hn] = hv; await get('cmp_region_' + hv, `${FD}/content-managed-page?page=CUSTOM&customPageId=oddsboosts&pbHorizontal=false&_ak=${AK}&timezone=America%2FNew_York`); await get('ev_region_' + hv, `${FD}/event-page?_ak=${AK}&eventId=30861650`); delete H[hn]; }
  await get('cmp_extra', `${FD}/content-managed-page?page=CUSTOM&customPageId=oddsboosts${extra}&_ak=${AK}`);
  const html = await get('web', 'https://sportsbook.fanduel.com/');
  const srcs = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map(m => m[1]);
  const finds = [];
  for (const s of srcs) {
    const js = await get('js', 'https://sportsbook.fanduel.com' + s);
    for (const m of js.matchAll(/.{0,300}(requiresRegion[^:]|x-sportsbook-region|X-Sportsbook-Region|sportsbook-region|x-application).{0,300}/g)) finds.push(`${s}: ${m[0]}`);
  }
  fs.writeFileSync('out/js_finds.txt', finds.slice(0, 300).join('\n\n'));
  fs.writeFileSync('out/summary.json', JSON.stringify(out, null, 1));
})();
