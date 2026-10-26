const fs = require('fs');
const B = 'https://line-reaper-backend-production.up.railway.app';
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const t0 = Date.now(); const log = [];
  while (Date.now() - t0 < 30 * 60e3) {
    let line = new Date().toISOString();
    try { const r = await fetch(B + '/api/status'); const j = await r.json().catch(() => ({})); line += ` status ${r.status} v ${j.version} started ${j.startedAt || j.started || ''}`; if (j.version === '3.201.0') { log.push(line + ' REACHED'); break; } }
    catch (e) { line += ' ERR ' + e.message; }
    log.push(line); fs.writeFileSync('out/watch.txt', log.join('\n') + '\n'); await sleep(60e3);
  }
  fs.writeFileSync('out/watch.txt', log.join('\n') + '\n');
  for (const u of ['/api/ops', '/api/health']) { try { const r = await fetch(B + u); fs.writeFileSync('out/' + u.replace(/\//g, '_') + '.txt', `${r.status}\n` + (await r.text()).slice(0, 20000)); } catch (e) {} }
})();
