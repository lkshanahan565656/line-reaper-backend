const fs = require('fs');
const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36', Accept: '*/*' };
const out = {};
async function get(u, h = {}) { try { const r = await fetch(u, { headers: { ...UA, ...h } }); return { status: r.status, text: await r.text() }; } catch (e) { return { status: 0, text: String(e) }; } }
(async () => {
  const home = await get('https://app.prizepicks.com/');
  out.home = { status: home.status, len: home.text.length, head: home.text.slice(0, 3000) };
  const scripts = [...new Set([...home.text.matchAll(/(?:src|href)="([^"]+\.js[^"]*)"/g)].map(m => new URL(m[1], 'https://app.prizepicks.com/').href))];
  out.scripts = scripts;
  const kw = /correlat|payout_multiplier|payoutMultiplier|reduced_payout|lineup_payout|same.?game|same.?team|\/entries|payout_calc|calculate_payout|power_play|flex_play|game_mode|multiplier/gi;
  const hits = [];
  const seen = new Set(scripts); const queue = [...scripts];
  while (queue.length && seen.size < 400) {
    const u = queue.shift();
    const r = await get(u);
    if (r.status !== 200) { hits.push({ u, status: r.status }); continue; }
    // chunk references
    for (const m of r.text.matchAll(/["'`]((?:\/|https:\/\/[a-z.]*prizepicks\.com\/)[^"'`]*?\.js)["'`]/g)) { const v = new URL(m[1], u).href; if (!seen.has(v)) { seen.add(v); queue.push(v); } }
    for (const m of r.text.matchAll(/static\/(?:js|chunks)\/[A-Za-z0-9_\-./]+\.js/g)) { const v = new URL('/' + m[0], u).href; if (!seen.has(v)) { seen.add(v); queue.push(v); } }
    let n = 0;
    for (const m of r.text.matchAll(kw)) { if (n++ > 60) break; hits.push({ u, k: m[0], s: r.text.slice(Math.max(0, m.index - 250), m.index + 350) }); }
    const apis = [...new Set([...r.text.matchAll(/["'`](\/(?:v\d\/)?[a-z_]+(?:\/[a-z_{}$.:]+){0,3})["'`]/g)].map(m => m[1]))].filter(x => /entr|payout|lineup|game|config|mode|correl|multip/.test(x));
    if (apis.length) hits.push({ u, apis });
  }
  out.scanned = seen.size;
  fs.writeFileSync('out/hits.json', JSON.stringify(hits, null, 1));
  // anonymous API probes
  const cands = ['https://api.prizepicks.com/game_types', 'https://api.prizepicks.com/payouts', 'https://api.prizepicks.com/configs', 'https://api.prizepicks.com/leagues',
    'https://partner-api.prizepicks.com/projections?league_id=265&per_page=5', 'https://partner-api.prizepicks.com/game_types', 'https://partner-api.prizepicks.com/payouts'];
  out.api = {};
  for (const c of cands) { const r = await get(c, { Accept: 'application/json' }); out.api[c] = { status: r.status, body: r.text.slice(0, 6000) }; }
  fs.writeFileSync('out/probe.json', JSON.stringify(out, null, 1));
})();
