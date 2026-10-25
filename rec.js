// raw snapshot recorder for the 10-25 US Grand Prix (and any golf both sides price), every 2 min to STOP_AT
const fs = require('fs'), zlib = require('zlib');
const o = require('./outrights');
const STOP_AT = Date.parse(process.env.STOP_AT || '2026-10-25T20:02:00Z');
const PIN = 'https://guest.api.arcadia.pinnacle.com/0.1', K = 'https://api.elections.kalshi.com/trade-api/v2', PM = 'https://gateway.polymarket.us';
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function get(url) {
  for (let i = 0; i < 2; i++) {
    try { const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
      if (r.status === 429) { await sleep(3000); continue; }
      if (!r.ok) return { status: r.status }; return { status: 200, data: await r.json() };
    } catch (e) { if (i) return { status: 0, error: String(e) }; }
  }
  return { status: 429 };
}
fs.mkdirSync('out', { recursive: true });
const outF = zlib.createGzip(); outF.pipe(fs.createWriteStream('out/snaps.jsonl.gz'));
const SER = o.KALSHI_SERIES_LIST.filter(s => o.KALSHI_SERIES[s].type !== 'season');
let pmLeagues = null, n = 0;
(async () => {
  while (Date.now() < STOP_AT) {
    const t0 = Date.now(), snap = { at: new Date(t0).toISOString(), pin: {}, kalshi: [], pmus: [], books: {} };
    for (const [sport, id] of Object.entries(o.PIN_SPORTS)) {
      const lg = await get(`${PIN}/sports/${id}/leagues?all=false`);
      for (const l of (lg.data || []).filter(l => l.matchupCount > 0)) {
        const [mu, mk] = await Promise.all([get(`${PIN}/leagues/${l.id}/matchups`), get(`${PIN}/leagues/${l.id}/markets/straight`)]);
        snap.pin[`${sport}|${l.id}`] = { mu: mu.data || null, mk: mk.data || null, at: new Date().toISOString() };
      }
    }
    for (const s of SER) { const r = await get(`${K}/events?series_ticker=${s}&status=open&with_nested_markets=true&limit=50`); snap.kalshi.push(...(r.data?.events || [])); await sleep(120); }
    if (!pmLeagues || n % 15 === 0) {
      const sp = await get(`${PM}/v2/sports`);
      pmLeagues = (sp.data?.sports || []).flatMap(x => (x.leagues || []).map(l => ({ ...l, sport: x.slug }))).filter(l => (l.sport === 'golf' || l.slug === 'f1') && l.activeEventCount > 0);
    }
    for (const l of pmLeagues) { const r = await get(`${PM}/v2/leagues/${l.slug}/events?type=futures&limit=50`); for (const e of r.data?.events || []) snap.pmus.push({ sport: l.slug === 'f1' ? 'f1' : 'golf', e }); await sleep(300); }
    // candidates' books
    const pins = Object.entries(snap.pin).flatMap(([k, v]) => o.parsePinLeague(k.split('|')[0], v.mu || [], v.mk || [], t0));
    const exch = [...snap.kalshi.map(o.parseKalshiEvent), ...snap.pmus.map(x => o.parsePmusEvent(x.e, x.sport))].filter(Boolean);
    const board = o.boardOf({ pins, exch });
    const cands = board.filter(x => !x.season && x.fair >= o.MIN_FAIR && x.ev >= 0);
    let kb = 0, pb = 0;
    for (const x of cands) {
      if (x.venue === 'kalshi' && kb < 12) { kb++; const r = await get(`${K}/markets/${x.marketId}/orderbook`); snap.books[`kalshi|${x.marketId}`] = r.data || { status: r.status }; await sleep(150); }
      if (x.venue === 'polymarketus' && pb < 4 && !snap.books[`polymarketus|${x.marketId}`]) { pb++; const r = await get(`${PM}/v1/markets/${x.marketId}/book`); snap.books[`polymarketus|${x.marketId}`] = r.data || { status: r.status }; await sleep(500); }
    }
    outF.write(JSON.stringify(snap) + '\n');
    console.log(snap.at, 'pin', pins.length, 'exch', exch.length, 'board', board.length, 'cands', cands.length, 'top', board.filter(x => !x.season).slice(0, 3).map(x => `${x.venue}:${x.runner}:${x.buy}:${x.ev}`).join(' '));
    n++;
    const wait = 120000 - (Date.now() - t0);
    if (wait > 0 && Date.now() + wait < STOP_AT) await sleep(wait); else if (Date.now() + wait >= STOP_AT) break;
  }
  outF.end(); await sleep(2000);
})();
