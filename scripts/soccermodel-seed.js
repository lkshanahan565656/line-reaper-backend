// Ratings as of the last football-data final → seeds/soccermodel-seed.json (the server's start point)
//   node scripts/soccermodel-seed.js <football-data dir>
const fs = require('fs');
const M = require('../soccermodel');
const P = require('../seeds/soccermodel-params.json');
const { loadFd } = require('./soccer-load');
const ms = loadFd(process.argv[2]);
const R = M.createRatings(P);
let last = 0;
for (const m of ms) { R.update(m); if (m.done && m.kickoff > last) last = m.kickoff; }
const st = R.exportState();
st.teams = st.teams.filter(t => t[6] > Date.parse('2024-06-01'));   // clubs seen in the last two seasons
fs.writeFileSync('seeds/soccermodel-seed.json', JSON.stringify({ builtAt: new Date().toISOString(), lastMatch: new Date(last).toISOString(), matches: ms.length, ...st }) + '\n');
console.log('teams', st.teams.length, 'last', new Date(last).toISOString());
