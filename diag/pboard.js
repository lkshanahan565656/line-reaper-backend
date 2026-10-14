// Live sports props board from a local server (current main): every row,
// snapshots every 3 minutes for gap lifetime, plus prod's EV record.
const fs = require('fs');
const U = 'http://localhost:3999', P = 'https://line-reaper-backend-production.up.railway.app';
const get = async (base, p) => { try { const r = await fetch(base + p, { signal: AbortSignal.timeout(120000) }); return await r.json(); } catch (e) { return { error: e.message }; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
(async () => {
  const prod = {};
  for (const p of ['/api/status', '/api/props/board?sport=SPORTS&limit=500&multi=1&sort=gap']) prod[p] = await get(P, p);
  fs.writeFileSync('out/prod.json', JSON.stringify(prod));
  log('prod saved', prod['/api/status']?.version, (prod['/api/ev/record/bets?limit=500'].bets || []).length);
  const t0 = Date.now();
  let st = {};
  while (Date.now() - t0 < 14 * 60e3) {
    await sleep(20000);
    st = await get(U, '/api/status');
    log('ud', st.underdog?.count, 'pp', st.prizepicks?.count, 'sl', st.sleeper?.sports, 'kalshi', JSON.stringify(st.kalshiProps?.counts));
    if (st.underdog?.count > 0 && st.prizepicks?.count > 0 && st.sleeper?.sports > 0 && st.kalshiProps?.updated && Date.now() - t0 > 6 * 60e3) break;
  }
  const snaps = [];
  for (let k = 0; k < 8; k++) {
    const rows = [];
    for (let off = 0; off < 20000; off += 500) {
      const d = await get(U, `/api/props/board?sport=SPORTS&limit=500&offset=${off}&sort=start`);
      rows.push(...(d.rows || []));
      if (!d.rows || d.rows.length < 500) break;
    }
    const rec = await get(U, '/api/props/record');
    const ev = { rows: [] };
    snaps.push({ at: new Date().toISOString(), status: k === 0 ? st : undefined, rows, rec });
    log('snap', k, 'rows', rows.length, 'multi', rows.filter(r => r.nBooks > 1).length, 'gap>0', rows.filter(r => r.gap > 0).length, 'priced', rows.filter(r => r.best).length, 'ev', (ev.rows || []).length);
    fs.writeFileSync('out/board.json', JSON.stringify(snaps));
    if (k < 7) await sleep(180000);
  }
})();
