// PrizePicks: does one full read (per_page=10000) carry the whole board? One request.
const fs = require('fs');
(async () => {
  const H = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', Accept: 'application/json', Origin: 'https://app.prizepicks.com', Referer: 'https://app.prizepicks.com/' };
  const out = {};
  for (const pp of ['10000']) {
    const r = await fetch(`https://partner-api.prizepicks.com/projections?per_page=${pp}&single_stat=true`, { headers: H });
    const t = await r.text();
    let j = null; try { j = JSON.parse(t); } catch {}
    const d = j?.data || [];
    const byLeague = {}; for (const x of d) { const id = x.relationships?.league?.data?.id; byLeague[id] = (byLeague[id] || 0) + 1; }
    const odds = {}; for (const x of d) odds[x.attributes?.odds_type] = (odds[x.attributes?.odds_type] || 0) + 1;
    out[pp] = { status: r.status, bytes: t.length, data: d.length, included: (j?.included || []).length, links: j?.links, meta: j?.meta, byLeague, odds, headers: Object.fromEntries([...r.headers].filter(([k]) => /rate|retry|cf-|age|cache/i.test(k))) };
  }
  console.log(JSON.stringify(out, null, 1));
  fs.writeFileSync('out/report.json', JSON.stringify(out));
})();
