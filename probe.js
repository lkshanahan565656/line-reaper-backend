// ESPN men's D1: a mid-season Saturday (2026-01-10) scoreboard and 12 box scores for the dry run
const fs = require('fs'); const zlib = require('zlib');
const ESPN = 'https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball';
(async () => {
  const g = async u => (await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0' } })).json();
  const b = await g(`${ESPN}/scoreboard?dates=20260110&groups=50&limit=500`);
  fs.writeFileSync('out/espn-board-20260110.json.gz', zlib.gzipSync(JSON.stringify(b)));
  const ids = b.events.filter(e => e.status?.type?.completed).map(e => e.id);
  console.log('events', b.events.length, 'done', ids.length);
  for (const id of ids.filter((x, i) => i % Math.floor(ids.length / 12) === 0).slice(0, 12)) {
    const s = await g(`${ESPN}/summary?event=${id}`);
    fs.writeFileSync(`out/espn-summary-${id}.json.gz`, zlib.gzipSync(JSON.stringify({ boxscore: s.boxscore, header: s.header, pickcenter: s.pickcenter })));
    await new Promise(r => setTimeout(r, 300));
  }
})();
