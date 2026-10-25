// Reads every Pick6 sport once from GitHub's servers (DraftKings answers them,
// not Railway) and writes the board for the pick6-data branch, where the app
// picks it up while its own read is blocked (pick6.js readRelay).
// node relay/pick6.js out/pick6.json
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { createPick6Reader } = require('../pick6');

(async () => {
  const r = createPick6Reader(axios, { enabled: true });
  await r.tick();                                   // the sport list, payouts and the first sport
  const n = r.state.sports.length;
  for (let i = 1; i < n && !r.state.fail.until; i++) await r.tick();
  const snap = r.snapshot();
  const lines = Object.values(snap.bySport).reduce((a, v) => a + v.lines.length, 0);
  console.log(`Pick6 relay: ${Object.keys(snap.bySport).length} of ${n} sports, ${lines} lines${r.state.lastError ? `, last error ${r.state.lastError.status ?? ''} ${r.state.lastError.message}` : ''}`);
  if (!Object.keys(snap.bySport).length) process.exit(1);
  const out = process.argv[2] || 'out/pick6.json';
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(snap));
})().catch(e => { console.error(e); process.exit(1); });
