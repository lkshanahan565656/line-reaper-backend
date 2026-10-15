// one live read per minute, screened by main's ev.js and this branch's
const fs = require('fs');
const axios = require('axios');
const pingames = require('../pingames'), pinprops = require('../pinprops'), freebooks = require('../freebooks'), xbooks = require('../xbooks');
const NEW = require('../ev'), OLD = require('./ev-old');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
const sleep = ms => new Promise(r => setTimeout(r, ms));
fs.mkdirSync('out', { recursive: true });
(async () => {
  const res = [];
  let pinProps = [];
  for (let c = 0; c < 6; c++) {
    const t0 = Date.now();
    try {
      const p = await pinprops.fetchPinnacleProps(axios, ''); if (p.props.length) pinProps = p.props;
      const pin = await pingames.fetchPinnacleGames(axios, {});
      const extraNew = {}, extraOld = {};
      for (const s of Object.keys(xbooks.LEAGUES)) { extraNew[s] = []; extraOld[s] = []; }
      for (const s of Object.keys(xbooks.LEAGUES)) for (const url of xbooks.actionUrls(s)) {
        try { const r = await axios.get(url, { headers: { 'User-Agent': UA }, timeout: 20000 }); const g = xbooks.parseAction(r.data, { props: xbooks.AN_PROPS[s] }); extraNew[s].push(...g); extraOld[s].push(...g); } catch (e) { console.log('an', s, e.message); }
      }
      for (const id of [1, 4, 6, 3]) {
        try {
          const r = await axios.get(`https://api.matchbook.com/edge/rest/events?sport-ids=${id}&per-page=300&include-prices=true&price-depth=3&states=open&odds-type=DECIMAL`, { headers: { 'User-Agent': UA }, timeout: 20000 });
          for (const s of Object.keys(xbooks.LEAGUES).filter(x => xbooks.LEAGUES[x].mb === id)) { extraNew[s].push(...xbooks.parseMatchbook(r.data)); extraOld[s].push(...xbooks.parseMatchbook(r.data, { props: true })); }
        } catch (e) { console.log('mb', id, e.message); }
      }
      const one = async (E, extra) => {
        const { games } = await freebooks.fetchFreeBooks(axios, pin.games, { pinProps, fdProps: true, extra });
        const feeds = Object.entries(games).map(([sport, g]) => ({ sport, games: g }));
        const rows = E.screen({ feeds, minEv: 0 }).filter(r => !r.dfs && r.ev >= 2);
        const tally = f => rows.reduce((m, r) => { const k = f(r); m[k] = (m[k] || 0) + 1; return m; }, {});
        return { clear2: rows.length, agree: rows.filter(r => r.agree).length, byBook: tally(r => r.book), bySource: tally(r => (r.sharpBooks || []).slice().sort().join('+') || r.source), rows: rows.map(r => `${r.ev} ${r.book} ${r.event} ${r.player || ''} ${r.side} ${r.point ?? ''} ${r.price} [${(r.sharpBooks || []).join('+') || r.source}]`) };
      };
      const o = await one(OLD, extraOld), n = await one(NEW, extraNew);
      res.push({ at: new Date().toISOString(), old: o, new: n });
      fs.writeFileSync('out/replay.json', JSON.stringify(res, null, 1));
      console.log(c, 'old', o.clear2, o.agree, 'new', n.clear2, n.agree);
    } catch (e) { console.log(e.stack); }
    await sleep(Math.max(0, 60e3 - (Date.now() - t0)));
  }
})();
