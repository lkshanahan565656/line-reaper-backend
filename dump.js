const fs = require('fs'); fs.mkdirSync('out', { recursive: true });
const H = { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' };
async function get(u, t = 60000) {
  try { const r = await fetch(u, { headers: H, signal: AbortSignal.timeout(t) }); const txt = await r.text(); let j; try { j = JSON.parse(txt); } catch { j = { raw: txt.slice(0, 2000) }; } return { status: r.status, j, bytes: txt.length }; }
  catch (e) { return { status: 0, j: { error: String(e) }, bytes: 0 }; }
}
const save = (f, x) => fs.writeFileSync('out/' + f, JSON.stringify(x));
const PIN = 'https://guest.api.arcadia.pinnacle.com/0.1';
(async () => {
  const log = [];
  for (const id of [29, 33, 22, 19, 3, 4, 15]) {
    const r = await get(`${PIN}/sports/${id}/leagues?all=false`); log.push(`pin leagues ${id} ${r.status} ${r.bytes}`); save(`pin-leagues-${id}.json`, r.j);
    const a = await get(`${PIN}/sports/${id}/matchups`); const b = await get(`${PIN}/sports/${id}/markets/straight`);
    log.push(`pin sport ${id} matchups ${a.status} ${a.bytes} markets ${b.status} ${b.bytes}`);
    if ([29, 33, 22, 19, 3, 4].includes(id)) { save(`pin-mu-${id}.json`, a.j); save(`pin-mk-${id}.json`, b.j); }
  }
  for (const slug of ['nfl-pit-no-2026-10-25', 'epl-cfc-tot-2026-10-24', 'nba-mia-cha-2026-10-24', 'nhl-ana-phi-2026-10-24']) {
    const r = await get(`https://gateway.polymarket.us/v1/events/slug/${slug}`); log.push(`pmus slug ${slug} ${r.status} ${r.bytes}`); save(`pmus-slug-${slug}.json`, r.j);
  }
  const L = ['nfl', 'cfb', 'nba', 'nhl', 'epl', 'atp', 'ufc'];
  for (const l of L) { const r = await get(`https://gateway.polymarket.us/v2/leagues/${l}/events?limit=50&offset=0&type=sport`); log.push(`pmus ${l} ${r.status} ${r.bytes}`); }
  for (const s of ['soccer', 'american_football', 'basketball', 'hockey', 'baseball']) { const r = await get(`https://api.gemini.com/v1/prediction-markets/events?status=active&sport=${s}&limit=500`); log.push(`gem ${s} ${r.bytes}`); save(`gem-${s}.json`, r.j); }
  fs.writeFileSync('out/log.txt', log.join('\n'));
})();
