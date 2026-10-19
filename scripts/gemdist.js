// every 2 minutes for ~36 min: Pinnacle's game lines + Gemini's, merged the
// way the server does, every Gemini side scored against Pinnacle's no-vig
const axios = require('axios');
const fs = require('fs');
const pingames = require('../app/pingames'), freebooks = require('../app/freebooks'), gb = require('../app/geminibooks'), ev = require('../app/ev');
const SP = { football: 15, basketball: 4, hockey: 19, baseball: 3 };
(async () => {
  const out = fs.createWriteStream('out/gemdist.jsonl');
  for (let i = 0; i < 19; i++) {
    const t = Date.now();
    try {
      const [pin, gem] = await Promise.all([pingames.fetchPinnacleGames(axios, { sports: SP }), gb.fetchGemini(axios)]);
      for (const s of Object.keys(freebooks.LEAGUES)) {
        const merged = { [s]: freebooks.mergeGames(s, freebooks.leagueGames(pin.games, s), gem.books[s] || []) };
        const games = gb.mainLinesOnly(merged, pin.games)[s];
        const rows = ev.screen({ feeds: [{ sport: s, label: 'free-odds', games }], minEv: -100 });
        for (const r of rows.filter(r => r.book === 'gemini')) out.write(JSON.stringify({ t, s, ev: r.ev, m: r.market, side: r.side, pt: r.point, price: r.price, fair: r.fairProb, ev_: r.event, start: r.start }) + '\n');
      }
      console.log(i, pin.games.length, gem.events, pin.errors, gem.errors);
    } catch (e) { console.log('err', e.message); }
    await new Promise(r => setTimeout(r, Math.max(0, 120e3 - (Date.now() - t))));
  }
  out.end();
})();
