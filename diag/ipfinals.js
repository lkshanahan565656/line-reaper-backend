// ESPN finals for the in-play grader → out/finals.json [{ lg, home, away, hs, as, final, st }]
const fs = require('fs');
const L = { nba: 'basketball/nba', nhl: 'hockey/nhl', nfl: 'football/nfl', ncaaf: 'football/college-football' };
const dates = (process.env.DATES || '20261026,20261027').split(',');
(async () => {
  const out = [];
  for (const [lg, p] of Object.entries(L)) for (const d of dates) {
    try {
      const r = await fetch(`https://site.api.espn.com/apis/site/v2/sports/${p}/scoreboard?dates=${d}&limit=400${lg === 'ncaaf' ? '&groups=80' : ''}`);
      const j = await r.json();
      for (const e of j.events || []) {
        const c = e.competitions?.[0]; const h = c?.competitors?.find(x => x.homeAway === 'home'), a = c?.competitors?.find(x => x.homeAway === 'away');
        if (!h || !a) continue;
        out.push({ lg, id: e.id, home: h.team.displayName, away: a.team.displayName, hs: +h.score, as: +a.score, final: e.status?.type?.completed ? 1 : 0, st: e.date });
      }
    } catch (e) { console.log(lg, d, e.message); }
  }
  fs.mkdirSync('out', { recursive: true });
  fs.writeFileSync('out/finals.json', JSON.stringify(out));
  console.log('finals', out.length, out.filter(x => x.final).length);
})();
