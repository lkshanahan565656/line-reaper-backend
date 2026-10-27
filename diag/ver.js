const fs = require('fs');
const S = 'https://line-reaper-backend-production.up.railway.app';
(async () => {
  fs.mkdirSync('data', { recursive: true });
  const j = await (await fetch(S + '/api/status?t=' + Date.now())).json();
  fs.writeFileSync('data/ver.json', JSON.stringify({ version: j.version, offshoreRef: j.offshoreRef }, null, 1));
  console.log('version', j.version, JSON.stringify(j.offshoreRef));
})().catch(e => { fs.mkdirSync('data', { recursive: true }); fs.writeFileSync('data/err.txt', e.message); console.log('err', e.message); });
