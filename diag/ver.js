const S = 'https://line-reaper-backend-production.up.railway.app';
(async () => {
  const j = await (await fetch(S + '/api/status?t=' + Date.now())).json();
  console.log('version', j.version, JSON.stringify(j.offshoreRef));
})().catch(e => console.log('err', e.message));
