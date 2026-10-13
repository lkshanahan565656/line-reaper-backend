// Our Kalshi prices vs Kalshi's live market, on the movers (moving lines) and edges
const axios = require('axios');
const B = 'https://line-reaper-backend-production.up.railway.app';
const K = 'https://api.elections.kalshi.com/trade-api/v2/markets/';
const px = (m, f) => { const d = parseFloat(m?.[`${f}_dollars`]); if (Number.isFinite(d)) return d; const c = parseFloat(m?.[f]); return Number.isFinite(c) ? c / 100 : null; };
(async () => {
  for (let round = 0; round < 3; round++) {
    const x = (await axios.get(B + '/api/exchange-value', { timeout: 60000 })).data;
    const legs = [];
    for (const m of x.movers || []) for (const v of m.venues) if (v.venue === 'kalshi') legs.push({ id: v.id, price: v.price, what: `${m.league} ${m.title} ${v.pick}` });
    for (const e of x.edges || []) if (e.venue === 'kalshi') legs.push({ id: e.id, price: e.price, what: `EDGE ${e.league} ${e.title} ${e.pick} ev ${e.ev}${e.steam ? ' STEAM' : ''}` });
    const age = (Date.now() - Date.parse(x.updated)) / 1000;
    let diff = 0, n = 0, big = 0;
    for (const l of legs) {
      const [, ticker, side] = l.id.split('|');
      try {
        const m = (await axios.get(K + ticker, { timeout: 15000 })).data.market;
        const live = px(m, side === 'yes' ? 'yes_ask' : 'no_ask');
        if (live == null) continue;
        const d = Math.round((live - l.price) * 1000) / 10;
        n++; if (d !== 0) diff++; if (Math.abs(d) >= 2) big++;
        if (d !== 0) console.log(`  ${l.what}: ours ${l.price} live ${live} (${d > 0 ? '+' : ''}${d}c)`);
      } catch (e) { console.log('  err', ticker, e.message); }
    }
    console.log(`ROUND ${round} scan age ${Math.round(age)}s: ${n} Kalshi legs checked, ${diff} differ, ${big} by 2c+`);
    await new Promise(r => setTimeout(r, 120000));
  }
})();
