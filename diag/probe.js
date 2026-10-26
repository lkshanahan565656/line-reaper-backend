const fs = require('fs');
const B = 'https://line-reaper-backend-production.up.railway.app';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const strip = h => h.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');
(async () => {
  const t0 = Date.now();
  let v = '';
  while (Date.now() - t0 < 40 * 60e3) { try { v = (await (await fetch(B + '/api/status')).json()).version; if (v === '3.199.0') break; } catch {} await sleep(30e3); }
  const st = await (await fetch(B + '/api/status')).json().catch(() => ({})); const out = [`version ${v} started ${st.startedAt || st.started || ''} uptime ${st.uptime || ''}`];
  for (const p of ['/leagues', '/nfl', '/nba', '/nhl', '/cfb', '/cbb', '/mlb', '/soccer', '/tennis', '/esports/lol', '/esports/cs2', '/esports/valorant', '/esports/dota2']) {
    try {
      const r = await fetch(B + p, { headers: { accept: 'text/html' } }); const h = await r.text();
      fs.writeFileSync(`out/${p.replace(/\//g, '_')}.html`, h);
      const t = strip(h);
      out.push(`${p} ${r.status} ${h.length}b og:${(h.match(/og:image" content="([^"]+)"/) || [])[1] || '-'} | ${t.slice(t.indexOf('Board read'), t.indexOf('Board read') + 60)} | ${(t.match(/\d+ games, 48 h \d+ markets \d+ with a fair \S+ above fair, TX/) || t.match(/\d+ matches \d+ on Kalshi \d+ with a sharp price \S+ under the sharp price/) || ['-'])[0]} | ${(t.match(/BetRivers[^|]{0,200}?(Profit not shown yet|profit [^ ]+)/) || ['no proven row'])[0]} | NaN:${/NaN|undefined/.test(t)}`);
    } catch (e) { out.push(`${p} ERR ${e.message}`); }
  }
  const sm = await (await fetch(B + '/sitemap.xml')).text(); out.push(`sitemap leagues: ${(sm.match(/\/(nfl|esports\/dota2|leagues)<\/loc>/g) || []).length}`);
  out.push((await (await fetch(B + '/robots.txt')).text()).replace(/\n/g, ' '));
  fs.writeFileSync('out/summary.txt', out.join('\n') + '\n');
})();
