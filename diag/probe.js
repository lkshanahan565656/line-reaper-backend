// Grading pull for checks/pmus-tennis-2026-10-25: the live size record, Polymarket US
// events (by slug for every PM US tennis bet, plus the ATP/WTA league listings, all pages)
// and ESPN tennis scoreboards. Raw JSON only; grading runs offline (grade.py).
const fs = require('fs');
fs.mkdirSync('out/ev', { recursive: true });
const B = 'https://line-reaper-backend-production.up.railway.app';
const G = 'https://gateway.polymarket.us';
const wait = ms => new Promise(r => setTimeout(r, ms));
const log = [];
async function get(name, url) {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64)', Accept: 'application/json' }, signal: AbortSignal.timeout(90000) });
    const txt = await r.text();
    log.push({ name, status: r.status, bytes: txt.length });
    try { return JSON.parse(txt); } catch { return null; }
  } catch (e) { log.push({ name, error: e.message }); return null; }
}
(async () => {
  const xs = await get('xsize', `${B}/api/exchange-size?limit=2000`);
  fs.writeFileSync('out/xsize.json', JSON.stringify(xs));
  const slugs = [...new Set((xs?.bets || []).filter(b => b.venue === 'polymarketus' && b.sport === 'tennis').map(b => b.marketId))];
  for (const s of slugs) {
    const ev = s.replace(/^aec-/, '');
    const j = await get(`ev-${ev}`, `${G}/v1/events/slug/${encodeURIComponent(ev)}`);
    if (j) fs.writeFileSync(`out/ev/${ev}.json`, JSON.stringify(j));
    await wait(1500);
  }
  const listing = {};
  for (const lg of ['atp', 'wta']) {
    listing[lg] = [];
    for (let page = 0; page < 12; page++) {
      const j = await get(`lg-${lg}-${page}`, `${G}/v2/leagues/${lg}/events?limit=50&offset=${page * 50}`);
      const evs = j?.events || [];
      listing[lg].push(...evs);
      await wait(1500);
      if (evs.length < 50) break;
    }
  }
  fs.writeFileSync('out/listing.json', JSON.stringify(listing));
  const espn = {};
  const day = d => d.toISOString().slice(0, 10).replace(/-/g, '');
  for (const tour of ['atp', 'wta']) for (let i = -2; i <= 0; i++) {
    const d = day(new Date(Date.now() + i * 864e5));
    espn[`${tour}-${d}`] = await get(`espn-${tour}-${d}`, `https://site.api.espn.com/apis/site/v2/sports/tennis/${tour}/scoreboard?dates=${d}`);
  }
  fs.writeFileSync('out/espn.json', JSON.stringify(espn));
  fs.writeFileSync('out/log.json', JSON.stringify({ at: new Date().toISOString(), log }, null, 1));
  console.log(JSON.stringify(log.map(l => [l.name, l.status || l.error])));
})();
