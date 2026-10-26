// dry run of diag/llinplay.js (shapes only)
process.env.INPLAY_ANY = '1';
const axios = require('axios');
const IP = require('./llinplay');
const PIN = 'https://guest.api.arcadia.pinnacle.com/0.1', H = { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' };
(async () => {
  for (const id of [4, 19, 29]) {
    try {
      const mu = (await axios.get(`${PIN}/sports/${id}/matchups/live`, { headers: H })).data;
      const mk = (await axios.get(`${PIN}/sports/${id}/markets/live/straight`, { headers: H })).data;
      const gs = IP.parseLive(mu, mk);
      console.log('pin sport', id, 'live', mu.length, 'parsed', gs.length, 'withML', gs.filter(g => g.ml).length, 'withSp', gs.filter(g => g.spreads.length).length, 'withTot', gs.filter(g => g.totals.length).length);
      console.log(JSON.stringify(gs[0]).slice(0, 1200));
    } catch (e) { console.log('pin', id, e.response?.status, e.message); }
  }
  const K = 'https://api.elections.kalshi.com/trade-api/v2';
  for (const [root, sfx] of [['KXNBA', '26OCT26WSHCHA'], ['KXNHL', '26OCT26LANYR'], ['KXNFL', '26OCT26DALPHI']]) {
    const evs = [];
    for (const s of ['GAME', 'SPREAD', 'TOTAL']) {
      try { const d = (await axios.get(`${K}/events/${root}${s}-${sfx}`, { params: { with_nested_markets: true } })).data; evs.push(d); console.log(root + s, 'markets', (d.event?.markets || d.markets || []).length, 'keys', Object.keys(d).join(','), 'evkeys', Object.keys(d.event || {}).slice(0, 30).join(',')); }
      catch (e) { console.log(root + s, sfx, e.response?.status, e.message); }
    }
    const g = evs[0]?.event; const ms = g?.markets || evs[0]?.markets || [];
    const teams = ms.map(m => m.yes_sub_title).slice(0, 2);
    const kk = IP.kalshiQuotes(evs, teams, 'same');
    const by = {}; for (const x of kk) by[x[1]] = (by[x[1]] || 0) + 1;
    console.log(root, 'teams', teams, 'quotes', JSON.stringify(by), JSON.stringify(kk.filter(x => x[1] === 'm')), JSON.stringify(kk.filter(x => x[1] === 's').slice(0, 4)), JSON.stringify(kk.filter(x => x[1] === 't').slice(0, 3)));
    const sm = (evs[1]?.event?.markets || evs[1]?.markets || [])[0]; if (sm) console.log('spread sample', sm.ticker, sm.yes_sub_title, sm.floor_strike, sm.strike_type);
  }
  delete process.env.INPLAY_ANY;
  const stats = {};
  const ip = IP.createInplay({ http: axios, kget: (u, o) => axios.get(u, o), stats });
  await new Promise(r => setTimeout(r, 70e3));
  await ip.end();
  console.log('stats', JSON.stringify(stats));
  process.exit(0);
})();
