const B = 'https://line-reaper-backend-production.up.railway.app';
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  let st = null;
  for (let i = 0; i < 60; i++) {
    try { st = await (await fetch(B + '/api/status')).json(); if (st.version === '3.160.1' && st.matchups && st.matchups.ready) break; } catch (e) { console.error('status', e.message); }
    await sleep(20000);
  }
  const out = { at: new Date().toISOString(), version: st && st.version, statusMatchups: st && st.matchups };
  for (const p of ['/api/esports/matchups', '/api/esports/matchups/ratings', '/api/esports/matchups/record', '/api/esports/matchups/backtest']) {
    try { const r = await fetch(B + p); out[p] = { status: r.status, body: await r.json() }; } catch (e) { out[p] = { error: e.message }; }
  }
  const page = await (await fetch(B + '/app')).text();
  out.pageHasMatchups = page.includes('esMatchupsPane') && page.includes('loadEsMatchups');
  process.stdout.write(JSON.stringify(out));
})();
