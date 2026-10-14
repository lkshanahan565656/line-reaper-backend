const fs = require('fs');
fs.mkdirSync('out', { recursive: true });
const PIN = 'https://guest.api.arcadia.pinnacle.com/0.1';
const H = { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' };
(async () => {
  for (const [n, id] of [['football', 15], ['baseball', 3]]) {
    for (const k of ['matchups', 'markets/straight']) {
      try { const r = await fetch(`${PIN}/sports/${id}/${k}`, { headers: H }); fs.writeFileSync(`out/${n}_${k.replace('/', '_')}.json`, await r.text()); } catch (e) { fs.writeFileSync(`out/${n}_${k.replace('/', '_')}.err`, String(e)); }
    }
  }
})();
