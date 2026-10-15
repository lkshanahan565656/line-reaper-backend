// Read-only production check after the merge: version, /slips.js, the slip record, MY SLIPS in the app
const fs = require('fs');
const B = 'https://line-reaper-backend-production.up.railway.app';
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const out = {};
  for (let i = 0; i < 30; i++) { try { out.version = (await (await fetch(B + '/')).json()).version; if (out.version === '3.131.0') break; } catch (e) { out.verErr = String(e); } await sleep(30000); }
  const js = await (await fetch(B + '/slips.js')).text(); out.slipsJs = { bytes: js.length, umd: js.includes('LRSlips') };
  out.record = await (await fetch(B + '/api/slips/record')).json().catch(e => String(e));
  const app = await (await fetch(B + '/app')).text(); out.appHasTab = app.includes("showTab('myslips',this)");
  fs.writeFileSync('out/sliplog.json', JSON.stringify(out, null, 1)); console.log(JSON.stringify(out).slice(0, 1500));
})();
