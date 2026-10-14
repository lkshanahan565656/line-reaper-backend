const U = 'https://line-reaper-backend-production.up.railway.app';
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  let v = null;
  for (let i = 0; i < 60; i++) { try { v = (await (await fetch(U + '/?t=' + Date.now())).json()).version; } catch {} if (v === '3.110.0' || (v && v.localeCompare('3.110.0', undefined, { numeric: true }) > 0)) break; await sleep(30000); }
  console.log('live version', v);
  await sleep(120000); // first gas scan runs on :x3 minutes
  const g = await (await fetch(U + '/api/gas-locks')).json();
  console.log('gas-locks', JSON.stringify({ ...g, plays: undefined, recent: (g.recent || []).length }).slice(0, 1500));
  const r = await (await fetch(U + '/api/results')).json();
  console.log('results sources', Object.keys(r.sources || {}).join(','), JSON.stringify(r.sources?.gasLocks || null));
  const st = await (await fetch(U + '/api/status')).json().catch(() => null);
  console.log('gas job', JSON.stringify(st?.tail?.jobs?.gas || st?.jobs?.gas || Object.keys(st || {})).slice(0, 400));
})();
