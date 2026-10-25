// Probe: the live size record, Polymarket US settlement and history endpoints for its
// tennis markets, and which free tennis results sources answer from here.
const fs = require('fs');
fs.mkdirSync('out/raw', { recursive: true });
const B = 'https://line-reaper-backend-production.up.railway.app';
const G = 'https://gateway.polymarket.us';
const wait = ms => new Promise(r => setTimeout(r, ms));
const log = [];
async function get(name, url, { save = true } = {}) {
  const t0 = Date.now();
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64)', Accept: 'application/json' }, signal: AbortSignal.timeout(60000) });
    const txt = await r.text();
    log.push({ name, url, status: r.status, bytes: txt.length, ms: Date.now() - t0 });
    if (save) fs.writeFileSync(`out/raw/${name.replace(/[^a-z0-9._-]/gi, '_').slice(0, 120)}.txt`, txt.slice(0, 3e6));
    try { return { status: r.status, json: JSON.parse(txt) }; } catch { return { status: r.status, text: txt }; }
  } catch (e) { log.push({ name, url, error: e.message }); return { error: e.message }; }
}
(async () => {
  const st = await get('status', `${B}/api/status`);
  const xs = await get('xsize', `${B}/api/exchange-size?limit=2000`);
  const bets = xs.json?.bets || [];
  const ten = bets.filter(b => b.venue === 'polymarketus' && b.sport === 'tennis');
  const slugs = [...new Set(ten.map(b => b.marketId))];
  console.log('bets', bets.length, 'pm tennis', ten.length, 'slugs', slugs.length);
  let i = 0;
  for (const s of slugs) {
    await get(`mkt-${s}`, `${G}/v1/markets/${encodeURIComponent(s)}`); await wait(1200);
    await get(`ev-${s}`, `${G}/v1/events/slug/${encodeURIComponent(s)}`); await wait(1200);
    if (i++ < 2) for (const p of ['prices-history', 'price-history', 'trades', 'candles', 'history', 'chart']) { await get(`h-${p}-${s}`, `${G}/v1/markets/${encodeURIComponent(s)}/${p}`); await wait(1200); }
  }
  if (slugs[0]) for (const u of [`${G}/v1/trades?market=${slugs[0]}`, `${G}/v1/prices-history?market=${slugs[0]}`, `${G}/v1/markets/${slugs[0]}/prices?interval=1m`]) { await get(`hq-${u.split('/').pop()}`, u); await wait(1200); }
  for (const lg of ['atp', 'wta', 'tennis', 'challenger', 'itf']) {
    await get(`lg-${lg}`, `${G}/v2/leagues/${lg}/events?limit=50`); await wait(1200);
    await get(`lgc-${lg}`, `${G}/v2/leagues/${lg}/events?limit=50&closed=true`); await wait(1200);
  }
  await get('leagues', `${G}/v2/leagues`); await wait(1200);
  for (const d of ['2026-10-24', '2026-10-25']) await get(`sofa-${d}`, `https://api.sofascore.com/api/v1/sport/tennis/scheduled-events/${d}`);
  for (const tour of ['atp', 'wta']) for (const d of ['20261024', '20261025']) await get(`espn-${tour}-${d}`, `https://site.api.espn.com/apis/site/v2/sports/tennis/${tour}/scoreboard?dates=${d}`);
  await get('tsdb', 'https://www.thesportsdb.com/api/v1/json/3/eventsday.php?d=2026-10-24&s=Tennis');
  await get('gamma-tennis', 'https://gamma-api.polymarket.com/events?tag_slug=tennis&closed=true&limit=20&order=endDate&ascending=false');
  const gt = log.find(l => l.name === 'gamma-tennis');
  try {
    const ev = JSON.parse(fs.readFileSync('out/raw/gamma-tennis.txt', 'utf8'));
    const tok = JSON.parse(ev[0]?.markets?.[0]?.clobTokenIds || '[]')[0];
    if (tok) await get('clob-hist', `https://clob.polymarket.com/prices-history?market=${tok}&interval=max&fidelity=1`);
  } catch (e) { log.push({ name: 'gamma-parse', error: e.message, gt }); }
  await get('tdata', 'http://www.tennis-data.co.uk/alldata.php', { save: true });
  fs.writeFileSync('out/log.json', JSON.stringify({ at: new Date().toISOString(), version: st.json?.version, log }, null, 1));
  console.log(JSON.stringify(log.map(l => [l.name, l.status || l.error, l.bytes])));
})();
