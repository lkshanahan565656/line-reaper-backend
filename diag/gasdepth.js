// Live depth on Kalshi AAA gas markets: for every open market whose favourite
// side asks 90-99c, how many contracts / dollars can be bought at <= ask+1c.
const K = 'https://api.elections.kalshi.com/trade-api/v2';
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function get(path, params = {}) { const u = new URL(K + path); for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.set(k, v); for (let i = 0; i < 5; i++) { try { const r = await fetch(u); if (r.status === 429) { await sleep(1000 * (i + 1)); continue; } if (!r.ok) return null; return await r.json(); } catch { await sleep(1000); } } return null; }
const num = v => (v == null ? null : Number(v));
(async () => {
  const ser = ((await get('/series'))?.series || []).filter(s => /^KXAAAGAS/.test(s.ticker)).map(s => s.ticker);
  console.log('series', ser.length);
  const rows = [];
  for (const s of ser) {
    const d = await get('/markets', { series_ticker: s, status: 'open', limit: 200 });
    for (const m of d?.markets || []) {
      const ya = num(m.yes_ask_dollars), na = num(m.no_ask_dollars);
      const side = ya >= 0.9 && ya <= 0.99 ? 'yes' : na >= 0.9 && na <= 0.99 ? 'no' : null; if (!side) continue;
      const ob = (await get(`/markets/${m.ticker}/orderbook`, { depth: 10 }))?.orderbook_fp || (await get(`/markets/${m.ticker}/orderbook`, { depth: 10 }))?.orderbook;
      // asks on our side = bids on the other side at (1 - price)
      const other = side === 'yes' ? (ob?.no_dollars || ob?.no) : (ob?.yes_dollars || ob?.yes);
      const lv = (other || []).map(([p, q]) => [1 - Number(p > 1 ? p / 100 : p), Number(q)]).sort((a, b) => a[0] - b[0]);
      const ask = side === 'yes' ? ya : na;
      let c1 = 0, d1 = 0; for (const [p, q] of lv) if (p <= ask + 0.0101) { c1 += q; d1 += q * p; }
      rows.push({ t: m.ticker, side, ask, close: m.close_time, exp: m.expected_expiration_time, contracts: Math.round(c1), dollars: Math.round(d1), vol: Math.round(num(m.volume_fp) || 0) });
    }
  }
  if (!rows.length) { console.log('no favourites open'); return; }
  console.log(JSON.stringify(rows.slice(0, 3)));
  const byExp = {}; for (const r of rows) (byExp[r.exp] ||= []).push(r);
  for (const [e, l] of Object.entries(byExp)) { const ds = l.map(r => r.dollars).sort((a, b) => a - b); console.log('expiry', e, 'favourite markets', l.length, 'depth $ at ask+1c: median', ds[Math.floor(ds.length / 2)], 'p25', ds[Math.floor(ds.length / 4)], 'p75', ds[Math.floor(ds.length * 0.75)], 'total', ds.reduce((a, b) => a + b, 0)); }
  const ob0 = await get(`/markets/${rows[0].t}/orderbook`, { depth: 5 }); console.log('sample book', JSON.stringify(ob0).slice(0, 600));
})();
