// Latency study: every exchange value / steam flag the live server raises,
// its venue book read every 5 s for 2 minutes. At each read: what $100 costs
// all-in per contract (walking the asks, taker fee in), the best ask, and the
// Polymarket reference mid (so we can tell the US venue catching up from the
// reference reverting). Graded at +0, +10, +30, +60 and +120 s.
const axios = require('axios');
const fs = require('fs');
const APP_URL = process.env.APP_URL || 'https://line-reaper-backend-production.up.railway.app';
const DUR = Number(process.env.DUR_MIN || 100) * 60e3, POLL = 10e3, EVERY = 5e3, WATCH = 125e3, USD = 100;
const http = axios.create({ timeout: 8000, headers: { 'user-agent': 'line-reaper-diag' } });
http.interceptors.response.use(null, async e => { const c = e.config || {}; if (e.response?.status === 429 && (c.__t || 0) < 2) { c.__t = (c.__t || 0) + 1; await new Promise(r => setTimeout(r, 700)); return http(c); } throw e; });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const r4 = x => (x == null ? null : Math.round(x * 1e4) / 1e4);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const kFee = p => 0.07 * p * (1 - p), uFee = p => 0.0695 * p * (1 - p);

async function asks(e) {
  if (e.venue === 'kalshi') {
    const { data } = await http.get(`https://api.elections.kalshi.com/trade-api/v2/markets/${e.marketId}/orderbook`, { params: { depth: 30 } });
    const ob = data?.orderbook_fp || data?.orderbook || {};
    const opp = e.side === 'yes' ? (ob.no_dollars || ob.no) : (ob.yes_dollars || ob.yes);
    return (opp || []).map(([p, q]) => { const d = Number(p) > 1 ? Number(p) / 100 : Number(p); return { p: r4(1 - d), q: Number(q) }; }).filter(l => l.p > 0 && l.p < 1 && l.q > 0).sort((a, b) => a.p - b.p);
  }
  const { data } = await http.get(`https://gateway.polymarket.us/v1/markets/${encodeURIComponent(e.marketId)}/book`);
  const d = data?.marketData || data || {};
  const px = l => Number(l?.px?.value ?? l?.px ?? l?.price?.value ?? l?.price);
  const long = e.side === 'yes' ? e.yesSide === 'long' : e.yesSide !== 'long';
  const lv = long ? (d.offers || []).map(l => ({ p: px(l), q: Number(l.qty) })) : (d.bids || []).map(l => ({ p: r4(1 - px(l)), q: Number(l.qty) }));
  return lv.filter(l => l.p > 0 && l.p < 1 && l.q > 0).sort((a, b) => a.p - b.p);
}
// all-in cost a contract for USD of stake, and dollars resting at or under the alerted price
function walk(lv, venue, alertPrice) {
  const fee = venue === 'kalshi' ? kFee : uFee;
  let spent = 0, n = 0, atAlert = 0;
  for (const l of lv) {
    if (l.p <= alertPrice + 1e-9) atAlert += l.p * l.q;
    if (spent >= USD) continue;
    const c = l.p + fee(l.p), take = Math.min(l.q, (USD - spent) / c);
    spent += take * c; n += take;
  }
  return { best: lv[0] ? r4(lv[0].p + fee(lv[0].p)) : null, cost100: spent >= USD - 0.01 && n > 0 ? r4(spent / n) : null, usdAtAlert: Math.round(atAlert) };
}
async function refMid(token) {
  if (!token) return null;
  try {
    const { data } = await http.get('https://clob.polymarket.com/book', { params: { token_id: token } });
    const b = Math.max(0, ...(data.bids || []).map(x => Number(x.price))), a = Math.min(1, ...(data.asks || []).map(x => Number(x.price)));
    return a > b ? r4((a + b) / 2) : null;
  } catch { return null; }
}

(async () => {
  const t0 = Date.now();
  const seen = new Set(), watches = [];
  let first = true, polls = 0, fails = 0;
  const watch = async (e, at) => {
    const w = { id: e.id, venue: e.venue, marketId: e.marketId, side: e.side, title: e.title, pick: e.pick, league: e.league, market: e.market, start: e.start,
      steam: !!e.steam, alertCost: e.cost, alertPrice: e.price, fair: e.fair, ev: e.ev, refMid0: e.ref?.mid ?? null, flaggedSeen: new Date(at).toISOString(), samples: [] };
    watches.push(w);
    log('flag', e.venue, e.market, e.league, e.title, e.pick, 'cost', e.cost, 'fair', e.fair, 'ev', e.ev, e.steam ? 'STEAM' : '');
    while (Date.now() - at <= WATCH) {
      const s0 = Date.now();
      try {
        const [lv, mid] = await Promise.all([asks(e), refMid(e.refToken)]);
        w.samples.push({ dt: Math.round((Date.now() - at) / 1000), ...walk(lv, e.venue, e.price), refMid: mid });
      } catch (err) { w.samples.push({ dt: Math.round((Date.now() - at) / 1000), error: err.message }); }
      await sleep(Math.max(0, EVERY - (Date.now() - s0)));
    }
  };
  while (Date.now() - t0 < DUR) {
    const p0 = Date.now();
    try {
      const { data } = await http.get(`${APP_URL}/api/exchange-value`, { params: { limit: 500 } });
      polls++;
      for (const e of data.edges || []) {
        if (!e.id || e.locked || seen.has(e.id)) continue;
        seen.add(e.id);
        if (!first) watch(e, Date.now());
      }
      if (first) log('already listed (not timed):', seen.size, 'updated', data.updated, 'counts', JSON.stringify(data.counts || {}).slice(0, 300));
      first = false;
    } catch (err) { fails++; if (fails < 5) log('poll failed', err.message); }
    await sleep(Math.max(0, POLL - (Date.now() - p0)));
  }
  await sleep(WATCH + 5e3);
  fs.writeFileSync('latency-out.json', JSON.stringify(watches));
  // ── grade at each lag: nearest sample at or after it
  const at = (w, s) => w.samples.find(x => x.dt >= s && !x.error) || null;
  const lags = [0, 10, 30, 60, 120];
  console.log(`\n=== polls ${polls}, failed ${fails}, flags timed ${watches.length}`);
  for (const [name, f] of [['all', () => true], ['steam', w => w.steam], ['kalshi', w => w.venue === 'kalshi'], ['polymarketus', w => w.venue === 'polymarketus']]) {
    const ws = watches.filter(f);
    if (!ws.length) continue;
    const row = { group: name, n: ws.length };
    for (const s of lags) {
      const pts = ws.map(w => ({ w, x: at(w, s) })).filter(p => p.x && p.x.cost100 != null);
      // EV of $100 at this lag against the fair at the flag, and against the reference mid now (fair moved by the ref's move)
      const evFlag = pts.map(p => p.w.fair / p.x.cost100 - 1);
      const evNow = pts.filter(p => p.x.refMid != null && p.w.refMid0 != null).map(p => { const d = Math.abs(p.w.refMid0 - p.w.fair) < Math.abs(1 - p.w.refMid0 - p.w.fair) ? 1 : -1; return (p.w.fair + d * (p.x.refMid - p.w.refMid0)) / p.x.cost100 - 1; });
      const stillThere = pts.filter(p => p.x.cost100 <= p.w.alertCost + 0.0051).length;
      const avg = l => (l.length ? +(l.reduce((a, b) => a + b, 0) / l.length * 100).toFixed(2) : null);
      row[`+${s}s`] = { n: pts.length, holds100: stillThere, evVsFlagFair: avg(evFlag), evVsRefNow: avg(evNow), positiveNow: evNow.filter(x => x > 0).length };
    }
    console.log(JSON.stringify(row));
  }
  for (const w of watches) console.log(JSON.stringify({ ...w, samples: w.samples.filter(x => [0, 10, 30, 60, 120].some(s => x.dt >= s && x.dt < s + 5)) }));
})();
