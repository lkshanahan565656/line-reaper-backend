const fs = require('fs');
const S = 'https://line-reaper-backend-production.up.railway.app';
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  fs.mkdirSync('data', { recursive: true });
  const out = [];
  for (let k = 0; k < 4; k++) {
    const j = await (await fetch(S + '/api/status?t=' + Date.now())).json();
    out.push({ at: new Date().toISOString(), version: j.version, offshoreRef: j.offshoreRef, upstream: j.upstream });
    console.log(new Date().toISOString(), j.version, JSON.stringify(j.offshoreRef), JSON.stringify(j.upstream));
    if (k < 3) await sleep(4 * 60e3);
  }
  fs.writeFileSync('data/ver.json', JSON.stringify(out, null, 1));
})().catch(e => { fs.mkdirSync('data', { recursive: true }); fs.writeFileSync('data/err.txt', e.message); console.log('err', e.message); });
