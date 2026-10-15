const fs = require('fs');
const P = 'https://line-reaper-backend-production.up.railway.app';
const wait = ms => new Promise(r => setTimeout(r, ms));
const get = async u => { try { const r = await fetch(u, { signal: AbortSignal.timeout(120000) }); if (!r.ok) return { error: r.status }; return await r.json(); } catch (e) { return { error: e.message }; } };
const out = []; const say = s => { out.push(s); console.log(s); fs.writeFileSync('out/log.txt', out.join('\n')); };
(async () => {
  fs.mkdirSync('out', { recursive: true });
  let st; for (let i = 0; i < 40; i++) { st = await get(P + '/api/status'); if (st.version === '3.134.0') break; await wait(60e3); }
  say(`version ${st.version} at ${new Date().toISOString()}`);
  await wait(8 * 60e3);
  const rows = []; for (let off = 0; off < 40000; off += 500) { const d = await get(`${P}/api/props/board?sport=SPORTS&sort=start&limit=500&offset=${off}`); rows.push(...(d.rows || [])); if (!d.rows || d.rows.length < 500) break; }
  const L = {}; for (const r of rows) for (const c of Object.values(r.books || {})) if (c.ev?.bookFair) { const a = (L[r.sport] ||= { both: 0, single: 0, clear2: 0 }); a[c.ev.bookFair]++; if (c.ev.ev >= 2) a.clear2++; }
  say(`board rows ${rows.length}; book-fair legs by league ${JSON.stringify(L)}`);
  const cov = await get(P + '/api/props/coverage'); say('coverage total ' + JSON.stringify(cov.total));
  const rec = await get(P + '/api/props/record'); say('record byKind ' + JSON.stringify(Object.fromEntries(Object.entries(rec.byKind || {}).map(([k, v]) => [k, v.signals]))) + ' headline ' + rec.overall?.signals + ' graded ' + rec.overall?.graded);
  const sb = await get(P + '/api/ev/scoreboard'); say('scoreboard overall ' + JSON.stringify({ g: sb.overall?.graded, clv: sb.overall?.avgClv }) + ' book-fair ' + JSON.stringify(Object.keys(sb.byKind || {}).filter(k => /book-fair/.test(k))));
})();
