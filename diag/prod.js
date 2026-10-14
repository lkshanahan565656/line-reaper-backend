const fs = require('fs'); fs.mkdirSync('out', { recursive: true });
const U = 'https://line-reaper-backend-production.up.railway.app';
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const log = [];
  let seen = null;
  for (let i = 0; i < 90; i++) {
    try {
      const s = await (await fetch(U + '/api/status')).json();
      log.push({ t: new Date().toISOString(), v: s.version, es: s.ev?.esports });
      if (s.version === '3.118.0' && !seen) seen = Date.now();
      if (seen && Date.now() - seen > 6 * 60e3) {
        fs.writeFileSync('out/prod-ev.json', await (await fetch(U + '/api/ev?limit=50')).text());
        fs.writeFileSync('out/prod-record.json', await (await fetch(U + '/api/ev/record')).text());
        break;
      }
    } catch (e) { log.push({ t: new Date().toISOString(), err: e.message }); }
    fs.writeFileSync('out/prod-log.json', JSON.stringify(log, null, 1));
    await sleep(30000);
  }
  fs.writeFileSync('out/prod-log.json', JSON.stringify(log, null, 1));
})();
