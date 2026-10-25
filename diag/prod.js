const B = 'https://line-reaper-backend-production.up.railway.app';
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  let st = null;
  for (let i = 0; i < 60; i++) {
    try { st = await (await fetch(B + '/api/status')).json(); const g = st.matchupGames || {}; if (g.CS2 && g.VAL && !g.CS2.error && !g.VAL.error) break; } catch (e) { console.error('status', e.message); }
    await sleep(20000);
  }
  const ratings = st && (st.ratings || st.matchContext?.ratings);
  process.stdout.write(JSON.stringify({ at: new Date().toISOString(), version: st && st.version, matchupGames: st && st.matchupGames, ratings }));
})();
