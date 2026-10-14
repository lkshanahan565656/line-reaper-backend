const U = 'https://line-reaper-backend-production.up.railway.app';
(async () => {
  for (let i = 0; i < 40; i++) {
    const s = await (await fetch(U + '/api/status')).json().catch(() => ({}));
    if (s.version === '3.111.1') { console.log('live', s.version); break; }
    console.log('waiting', s.version); await new Promise(r => setTimeout(r, 30000));
  }
  const g = await (await fetch(U + '/api/gas-locks')).json().catch(e => ({ e: e.message }));
  console.log(JSON.stringify({ rule: g.rule, backtest: g.backtest, count: g.count, errors: g.errors, counts: g.counts }));
})();
