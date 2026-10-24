// Plain public-page check: what a logged-out visitor's browser gets. No auth workarounds.
const fs = require('fs');
const out = { at: new Date().toISOString() };
async function get(u) {
  try { const r = await fetch(u, { redirect: 'follow', signal: AbortSignal.timeout(20000) });
    const t = await r.text(); return { status: r.status, url: r.url, len: t.length, head: t.slice(0, 2000) };
  } catch (e) { return { error: String(e.message || e) }; }
}
(async () => {
  for (const u of ['https://picks.betr.app/', 'https://www.betr.app/', 'https://chalkboard.io/', 'https://www.chalkboard.io/', 'https://app.chalkboard.io/', 'https://play.chalkboard.io/', 'https://api.chalkboard.io/'])
    out[u] = await get(u);
  fs.writeFileSync('out/probe.json', JSON.stringify(out, null, 1));
})();
