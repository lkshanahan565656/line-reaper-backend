// Action Network NHL shots-on-goal props for every book, read 8 times 3 min apart
const fs = require('fs');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
const BOOKS = { 68: 'draftkings', 75: 'betmgm', 123: 'caesars', 79: 'bet365', 2988: 'fanatics', 2724: 'hardrock', 4620: 'thescore', 69: 'fanduel', 71: 'betrivers' };
const date = new Date(Date.now() - 5 * 3600e3).toISOString().slice(0, 10).replace(/-/g, '');
const url = `https://api.actionnetwork.com/web/v2/scoreboard/nhl?bookIds=${Object.keys(BOOKS).join(',')}&periods=event&date=${date}&customPickTypes=core_bet_type_31_shots_on_goal`;
(async () => {
  for (let k = 0; k < 8; k++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
      const t = await r.text();
      fs.writeFileSync(`out/sog-${k}.json`, t);
      console.log(k, r.status, t.length);
    } catch (e) { console.log(k, e.message); }
    if (k < 7) await new Promise(r => setTimeout(r, 180e3));
  }
})();
