const fs = require('fs');
const S = 'https://line-reaper-backend-production.up.railway.app';
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const t0 = Date.now(); let v = null;
  while (Date.now() - t0 < 50 * 60e3) {
    try { const j = await (await fetch(S + '/api/status?t=' + Date.now())).json(); v = j.version; if (v === '3.203.0') break; } catch {}
    await sleep(30e3);
  }
  console.log('version', v, 'after', Math.round((Date.now() - t0) / 60e3), 'min');
  await sleep(25 * 60e3);   // let the recorder run 25 minutes
  const st = await (await fetch(S + '/api/status?t=' + Date.now())).json();
  const ref = await (await fetch(S + '/api/offshore-ref?t=' + Date.now())).json();
  fs.mkdirSync('data', { recursive: true });
  fs.writeFileSync('data/live.json', JSON.stringify({ status: st.offshoreRef, version: st.version, resultsBackup: st.resultsBackup, ref: { ...ref, backtest: undefined, mismatches: undefined } }, null, 1));
  console.log(JSON.stringify(st.offshoreRef), JSON.stringify(ref.record?.slice(0, 4)));
})();
