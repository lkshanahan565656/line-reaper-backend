// Live log: esports match-winner prices on Kalshi, Polymarket US, Polymarket and Pinnacle, every minute.
const fs = require('fs'), zlib = require('zlib');
const { parsePinnacle } = require('../esboard');
const MIN = Number(process.env.LOG_MIN || 300), T0 = Date.now();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
async function get(u, headers = {}) { for (let i = 0; i < 3; i++) { try { const r = await fetch(u, { headers, signal: AbortSignal.timeout(15000) }); if (r.status === 429) { await sleep(1500 * (i + 1)); continue; } if (!r.ok) return null; return await r.json(); } catch { await sleep(1000); } } return null; }
const num = v => (v == null || v === '' ? null : Number(v));
const amt = v => num(v && typeof v === 'object' ? v.value : v);
const KS = { CS2: 'KXCS2GAME', LOL: 'KXLOLGAME', VAL: 'KXVALORANTGAME', DOTA: 'KXDOTA2GAME' };
const PMUS = { CS2: 'cs2', LOL: 'lol', VAL: 'valorant', DOTA: 'dota2' };
const PMI = { CS2: 10310, LOL: 10311, DOTA: 10309, VAL: 10369 };
async function kalshi(game) {
  const d = await get(`https://api.elections.kalshi.com/trade-api/v2/events?series_ticker=${KS[game]}&status=open&with_nested_markets=true&limit=200`);
  return (d?.events || []).map(e => ({ ev: e.event_ticker, title: e.title, ms: (e.markets || []).map(m => [m.yes_sub_title, num(m.yes_bid_dollars), num(m.yes_ask_dollars), num(m.yes_bid_size_fp), num(m.yes_ask_size_fp), m.ticker]) }));
}
async function pmus(game) {
  const out = [];
  for (let off = 0; off < 300; off += 50) {
    const d = await get(`https://gateway.polymarket.us/v2/leagues/${PMUS[game]}/events?limit=50&offset=${off}`);
    const evs = d?.events || []; 
    for (const e of evs) for (const m of e.markets || []) { if (m.sportsMarketType !== 'esports_match_winner') continue; const sides = (m.marketSides || []).map(s => [s.team?.name || s.description, s.long === true || s.long === 'true']); out.push({ slug: m.slug, ev: e.slug, start: e.startTime, live: !!e.live, ended: !!e.ended, sides, bid: amt(m.bestBidQuote), ask: amt(m.bestAskQuote), fee: num(m.feeCoefficient) }); }
    if (evs.length < 50) break; await sleep(150);
  }
  return out;
}
async function pmi(game) {
  const d = await get(`https://gamma-api.polymarket.com/events?series_id=${PMI[game]}&active=true&closed=false&limit=200`);
  const out = [];
  for (const e of d || []) { const m = (e.markets || []).find(x => x.sportsMarketType === 'moneyline'); if (!m) continue; let o = null; try { o = JSON.parse(m.outcomes); } catch {} out.push({ slug: e.slug, start: m.gameStartTime || e.startTime, outcomes: o, bid: num(m.bestBid), ask: num(m.bestAsk), liq: num(m.liquidityNum ?? m.liquidity) }); }
  return out;
}
async function pin() {
  const h = { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' };
  const [mu, mk] = await Promise.all([get('https://guest.api.arcadia.pinnacle.com/0.1/sports/12/matchups', h), get('https://guest.api.arcadia.pinnacle.com/0.1/sports/12/markets/straight', h)]);
  if (!mu || !mk) return [];
  return parsePinnacle(mu, mk).map(m => { const mm = m.markets.find(x => x.key === 'match'); return mm && { game: m.game, teams: m.teams, start: m.start, live: m.live, prob: mm.prob, limit: mm.limit }; }).filter(Boolean);
}
(async () => {
  fs.mkdirSync('out', { recursive: true });
  const snaps = []; let n = 0;
  while (Date.now() - T0 < MIN * 60e3) {
    const t = Date.now(); const s = { t, k: {}, us: {}, pm: {}, pin: [] };
    try {
      await Promise.all(Object.keys(KS).map(async g => { s.k[g] = await kalshi(g); s.us[g] = await pmus(g); s.pm[g] = await pmi(g); }));
      if (n % 2 === 0) s.pin = await pin();
    } catch (e) { log('err', e.message); }
    snaps.push(s); n++;
    if (n % 10 === 1) { fs.writeFileSync('out/eslog.json.gz', zlib.gzipSync(JSON.stringify(snaps))); log('snap', n, Object.entries(s.us).map(([g, a]) => g + ' us ' + a.length + ' k ' + (s.k[g] || []).length + ' pm ' + (s.pm[g] || []).length).join(' | '), 'pin', s.pin.length); }
    const wait = 60e3 - (Date.now() - t); if (wait > 0) await sleep(wait);
  }
  fs.writeFileSync('out/eslog.json.gz', zlib.gzipSync(JSON.stringify(snaps)));
  log('done', snaps.length);
})();
