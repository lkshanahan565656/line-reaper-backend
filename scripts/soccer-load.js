// football-data.co.uk CSV folder → every match in kickoff order (soccer model scripts)
const fs = require('fs'), path = require('path');
const M = require('../soccermodel');
function loadFd(dir) {
  const all = [];
  for (const f of fs.readdirSync(dir)) {
    let m = /^([A-Z0-9]+)-(\d{4})\.csv$/.exec(f), league, season = null;
    if (m) { league = m[1]; season = m[2]; }
    else if ((m = /^new-([A-Z]+)\.csv$/.exec(f))) league = m[1];
    else continue;
    if (!M.LEAGUES[league]) continue;
    for (const x of M.parseFootballData(fs.readFileSync(path.join(dir, f), 'utf8'), league, season)) all.push(x);
  }
  // one row per match (files can overlap), kickoff order
  const seen = new Set(), out = [];
  for (const x of all.sort((a, b) => a.kickoff - b.kickoff)) { const k = `${x.league}|${x.kickoff}|${M.canon(x.home)}|${M.canon(x.away)}`; if (!seen.has(k)) { seen.add(k); out.push(x); } }
  return out;
}
module.exports = { loadFd };
if (require.main === module) {
  const ms = loadFd(process.argv[2]);
  const by = {};
  for (const m of ms) { const k = m.league; by[k] = by[k] || { n: 0, done: 0, close: 0, sot: 0, first: m.kickoff, last: 0 }; const b = by[k]; b.n++; if (m.done) b.done++; if (m.close) b.close++; if (m.hst != null) b.sot++; b.last = m.kickoff; }
  for (const [k, b] of Object.entries(by)) console.log(k.padEnd(4), b.n, b.done, 'close', b.close, 'sot', b.sot, new Date(b.first).toISOString().slice(0, 10), new Date(b.last).toISOString().slice(0, 10));
  console.log('total', ms.length);
}
