// Price age: how old each venue's price is (priceage.js)
// Moved out of server.js as it was (the route split): mount(ctx) runs where
// the section used to be, so routes keep their order. ctx carries what the
// section reads from server.js; it returns what server.js reads back.
'use strict';

module.exports = function mount(ctx) {
// ctx.evBookProven is replaced every refresh: read it per request
const {
  FREE_BOOKS_MAX_AGE_MS, GEMINI_MAX_AGE_MS, ODDS_API_KEY, TAIL_REGION, XBOOKS_MAX_AGE_MS, app,
  bigGames, cache, depthBook, freeBooksState, geminiState, hasPro, kalshiStream,
  licenceOf, lineArchive, lineHist, oddsEngine, oddsProviders, oddsSchema, pick6, pmusBooksState,
  ppState, resultsBackup, shopDepth, shopDepthOn, shopReadAt, shopState, shopper, venues, xarbState,
  xbooksState
} = ctx;

const priceAge = require('../priceage');
let priceAgeMemo = { at: 0, body: null };
function priceAgeNow() {
  const t = Date.now();
  if (priceAgeMemo.body && t - priceAgeMemo.at < 2000) return priceAgeMemo.body;
  const pin = freeBooksState.gamesAt || null, xb = xbooksState.at || null;
  const streamed = !!kalshiStream?.covers();
  const p6 = Math.max(0, ...Object.values(pick6.readTimes() || {}).map(x => Date.parse(x) || 0)) || null;
  const nm = k => venues.NAMES?.[k] || k;
  const list = [
    { key: 'pinnacle', at: pin, staleMs: FREE_BOOKS_MAX_AGE_MS },
    { key: 'fanduel', at: pin, staleMs: FREE_BOOKS_MAX_AGE_MS },
    { key: 'betrivers', at: pin, staleMs: FREE_BOOKS_MAX_AGE_MS },
    { key: 'kalshi', at: streamed ? kalshiStream.heardAt() : xarbState.rows?.at || null, staleMs: streamed ? 30e3 : 3 * 60e3, via: streamed ? 'stream' : 'poll' },
    { key: 'polymarketus', at: pmusBooksState.at || null, staleMs: 6 * 60e3 },
    { key: 'gemini', at: geminiState.at || null, staleMs: GEMINI_MAX_AGE_MS },
    { key: 'matchbook', at: xb, staleMs: XBOOKS_MAX_AGE_MS },
    ...['draftkings', 'betmgm', 'caesars', 'bet365', 'fanatics', 'hardrock', 'thescore'].map(key => ({ key, at: xb, staleMs: XBOOKS_MAX_AGE_MS })),
    ...(TAIL_REGION === 'us' ? [] : [{ key: 'polymarket', at: xarbState.rows?.at || null, staleMs: 3 * 60e3 }]),
    { key: 'prizepicks', at: ppState.fullOkAt || null, staleMs: 45 * 60e3 },
    { key: 'underdog', at: cache.underdog.updated || null, staleMs: 10 * 60e3 },
    { key: 'sleeper', at: cache.sleeperSports.updated || cache.sleeper.updated || null, staleMs: 10 * 60e3 },
    { key: 'pick6', at: p6, staleMs: 30 * 60e3 },
  ].map(v => ({ ...v, name: nm(v.key) }));
  priceAgeMemo = { at: t, body: priceAge.build(list, t) };
  return priceAgeMemo.body;
}
app.get('/api/price-age', (req, res) => res.set('Cache-Control', 'no-store').json(priceAgeNow()));
const shopKey = () => `${Date.now() - Date.parse(freeBooksState.gamesAt || 0) < FREE_BOOKS_MAX_AGE_MS ? freeBooksState.gamesAt : ''}|${xarbState.rows?.at || 0}`;
// After each free-books read (the 40-second chain): the quotes are rebuilt one
// league at a time with a yield between, so no request waits on a long block.
async function prebuildShopQuotes() {
  const key = shopKey();
  if (shopState.key === key || !freeBooksState.gamesAt) return;
  const t0 = Date.now();
  const readAt = shopReadAt();
  const fresh = !key.startsWith('|');
  const out = { quotes: [], stats: {} };
  try {
    for (const [lg, games] of fresh ? Object.entries(freeBooksState.games || {}) : []) {
      const r = oddsProviders.fromFreeGames({ [lg]: games }, { readAt });
      for (const q of r.quotes) out.quotes.push(q);
      for (const [k, v] of Object.entries(r.stats)) { const a = out.stats[k] || (out.stats[k] = { events: 0, quotes: 0 }); a.events += v.events; a.quotes += v.quotes; }
      await new Promise(r2 => setImmediate(r2));
    }
  } catch (e) { console.warn('Shopper free books:', e.message); out.error = e.message; }
  let kal = { quotes: [], stats: {} };
  try { if (fresh && xarbState.rows?.at) kal = oddsProviders.fromKalshiBets(bigGames().bets, { readAt: readAt.kalshi }); }
  catch (e) { console.warn('Shopper Kalshi:', e.message); kal = { quotes: [], stats: {}, error: e.message }; }
  Object.assign(shopState, { key, free: out, kalshi: kal, builtAt: new Date().toISOString(), ms: Date.now() - t0, views: new Map() });
}
function shopQuotes() {
  const key = shopKey();
  const fresh = !key.startsWith('|');
  if (shopState.key !== key && !(shopState.key && Date.now() - Date.parse(shopState.builtAt || 0) < 90e3)) {
    const t0 = Date.now();
    const readAt = shopReadAt();
    try { shopState.free = fresh ? oddsProviders.fromFreeGames(freeBooksState.games, { readAt }) : { quotes: [], stats: {} }; }
    catch (e) { console.warn('Shopper free books:', e.message); shopState.free = { quotes: [], stats: {}, error: e.message }; }
    try { shopState.kalshi = fresh && xarbState.rows?.at ? oddsProviders.fromKalshiBets(bigGames().bets, { readAt: readAt.kalshi }) : { quotes: [], stats: {} }; }
    catch (e) { console.warn('Shopper Kalshi:', e.message); shopState.kalshi = { quotes: [], stats: {}, error: e.message }; }
    Object.assign(shopState, { key, builtAt: new Date().toISOString(), ms: Date.now() - t0, views: new Map() });
  }
  return shopState;
}
function shopHealth() {
  const st = shopQuotes();
  const errors = [...(freeBooksState.errors || []), ...(xbooksState.errors || []).map(e => (/^(action|matchbook)/i.test(e) ? e : `action ${e}`)),
    ...(geminiState.errors || []).map(e => `gemini ${e}`), ...(pmusBooksState.errors || []).map(e => `polymarketus ${e}`), ...(st.free.error ? [`pinnacle ${st.free.error}`] : []),
    ...((xarbState.errors || []).filter(e => /kalshi/i.test(String(e))).map(e => `kalshi ${e}`)), ...(st.kalshi.error ? [`kalshi ${st.kalshi.error}`] : [])];
  const enabled = { pinnacle: freeBooksState.enabled, fanduel: freeBooksState.enabled, betrivers: freeBooksState.enabled, gemini: geminiState.enabled, polymarketus: pmusBooksState.enabled,
    matchbook: xbooksState.enabled && xbooksState.matchbook, kalshi: true,
    ...Object.fromEntries(['draftkings', 'betmgm', 'caesars', 'bet365', 'fanatics', 'hardrock', 'thescore'].map(k => [k, xbooksState.enabled && xbooksState.action])) };
  return oddsProviders.health({ stats: { ...st.free.stats, ...st.kalshi.stats }, errors, readAt: shopReadAt(), enabled });
}
const shopList = v => (v ? String(v).toLowerCase().split(',').map(x => x.trim()).filter(Boolean) : null);
const shopNum = v => (v == null || v === '' ? null : Number.isFinite(parseFloat(v)) ? parseFloat(v) : null);
// GET /api/shopper?sport=&league=&q=&markets=moneyline,spread,total,player_prop
// &providers=&exclude=&state=TX&hours=48&minEv=1 (percent)&minEdge= (points)
// &minLiquidity=&minSize= (dollars every shown exchange price must fill, fee in)&maxAge= (seconds)&priced=1&arbs=1&sort=ev|start|hold|gap|venues
// &stake=100&method=power|multiplicative|additive|shin&limit=200
app.get('/api/shopper', (req, res) => {
  const q = req.query;
  const st = shopQuotes();
  const lic = licenceOf(req);
  const pro = hasPro(req);
  // the same question within 30 s of the same read is answered from memory
  const vkey = `${lic.kalshi ? 1 : 0}|${pro ? 1 : 0}|${Object.keys(q).sort().map(k => `${k}=${q[k]}`).join('&')}`;
  const hit = st.views?.get(vkey);
  if (hit && Date.now() - hit.at < 30e3) return res.type('json').send(hit.body);
  const quotes = lic.kalshi ? [...st.free.quotes, ...st.kalshi.quotes] : st.free.quotes;
  const hours = shopNum(q.hours);
  const minEv = shopNum(q.minEv);
  const view = shopper.build(quotes, {
    sport: q.sport || null, league: q.league || null, q: q.q || '', marketTypes: shopList(q.markets), providers: shopList(q.providers), exclude: shopList(q.exclude),
    state: q.state || null, toMs: hours != null && hours > 0 ? Date.now() + Math.min(hours, 24 * 14) * 3600e3 : undefined,
    minEv: minEv == null ? undefined : minEv / 100, minEdgePts: shopNum(q.minEdge) ?? undefined, minLiquidity: shopNum(q.minLiquidity) ?? undefined,
    maxAgeSec: shopNum(q.maxAge) ?? undefined, pricedOnly: q.priced === '1', arbsOnly: q.arbs === '1', sort: q.sort || 'ev', stake: shopNum(q.stake) || 100,
    method: q.method, limit: parseInt(q.limit) || 200, proven: ctx.evBookProven,
    depth: shopDepth.forQuote, minSize: Math.min(Math.max(shopNum(q.minSize) || 0, 0), 100000) || null,
  });
  const body = JSON.stringify({ ...(pro ? view : shopper.stripPro(view)), pro, builtAt: st.builtAt, buildMs: st.ms, providers: shopHealth(), formats: oddsSchema.FORMATS,
    devigMethods: oddsEngine.DEVIG_METHODS, stateInfo: venues.stateInfo(q.state),
    note: 'Prices are what each feed showed at its last read. Nothing here is a proven edge unless its label says proven; check the price in the app before you bet.' });
  if (st.views) { if (st.views.size > 40) st.views.clear(); st.views.set(vkey, { at: Date.now(), body }); }
  res.type('json').send(body);
});
// Line history for player props (shopper.createLineHistory): after a quote
// rebuild, at most every 3 minutes, each prop market's fair and venue prices
// are noted, a few hundred markets at a time with a yield between. Rides the
// results backup like the odds screen's game-line history.
const propHistory = shopper.createLineHistory({ onDrop: x => lineArchive.add('prop', x) });
let propHistoryBooted = false;
const propHistoryStore = resultsBackup.wrap('propHistory', {
  init: async () => {}, all: async () => (propHistoryBooted ? propHistory.dump() : []),
  put: async d => { propHistory.load([d]); }, putMany: async ds => { propHistory.load(ds); },
}, { appendOnly: false });
propHistoryStore.init().catch(e => console.warn('Prop history: restore failed:', e.message)).finally(() => { propHistoryBooted = true; });
const propHistoryState = { at: 0, observedAt: null, markets: 0, ms: null, error: null };
async function observePropHistory() {
  const st = shopState;
  if (!st.builtAt || Date.now() - propHistoryState.at < 3 * 60e3) return;
  propHistoryState.at = Date.now();
  const t0 = Date.now();
  try {
    const props = [...st.free.quotes, ...st.kalshi.quotes].filter(q => q.marketType === 'player_prop' && q.marketStatus === 'open' && q.available !== false && Date.parse(q.startUtc) > Date.now() - 5 * 60e3);
    const grouped = [...shopper.groupMarkets(props).values()];
    const filter = shopper.providerFilter({});
    let views = [];
    for (let i = 0; i < grouped.length; i++) {
      const v = shopper.viewMarket(grouped[i], { filter, stake: 100, now: Date.now(), method: 'power' });
      if (v) views.push(v);
      if (i % 300 === 299) { propHistory.observe(views); views = []; await new Promise(r => setImmediate(r)); }
    }
    propHistory.observe(views);
    Object.assign(propHistoryState, { observedAt: new Date().toISOString(), markets: grouped.length, ms: Date.now() - t0, error: null });
  } catch (e) { propHistoryState.error = e.message; console.warn('Prop history:', e.message); }
}
// The shopper's own book reads: exchange prices on markets with a fair, near
// or above it, and arb legs, read a few a minute per venue (depthbook.READ_BUDGET)
// on top of the size record's reads; each book kept 5 minutes.
let shopDepthRunning = false;
async function readShopDepth() {
  if (!shopDepthOn() || shopDepthRunning || !shopState.builtAt) return;
  shopDepthRunning = true;
  try {
    const t = Date.now();
    const all = [...shopState.free.quotes, ...shopState.kalshi.quotes].filter(q => q.marketType !== 'player_prop' && q.marketStatus === 'open' && q.available !== false
      && Date.parse(q.startUtc) > t && Date.parse(q.startUtc) < t + 48 * 3600e3);
    const keys = new Set(all.filter(q => depthBook.EXCHANGES.has(q.providerId)).map(q => shopper.groupOf(q)?.key).filter(Boolean));
    const grouped = [...shopper.groupMarkets(all.filter(q => keys.has(shopper.groupOf(q)?.key))).values()];
    const filter = shopper.providerFilter({});
    const views = [];
    for (let i = 0; i < grouped.length; i++) {
      const v = shopper.viewMarket(grouped[i], { filter, stake: 100, now: t, method: 'power' });
      if (v && v.fair) views.push(v);
      if (i % 300 === 299) await new Promise(r => setImmediate(r));
    }
    await shopDepth.readPass(depthBook.candidates(views));
  } catch (e) { shopDepth.state.errors = [e.message, ...shopDepth.state.errors].slice(0, 5); }
  finally { shopDepthRunning = false; }
}
// one prop market's history: GET /api/shopper/history?key=<market key>.
// Free viewers get prices without the fair; Kalshi needs its data licence.
app.get('/api/shopper/history', (req, res) => {
  const key = String(req.query.key || '').slice(0, 300);
  const lic = licenceOf(req), pro = hasPro(req);
  let h = key ? propHistory.forMarket(key) : null;
  // gone from the board: the 30-day line archive
  if (!h && key) { const a = lineArchive.propSeries(key); if (a) h = { id: a.id, event: a.event, league: a.league, start: a.start, player: a.player, stat: a.stat, line: a.line, thinned: a.thinned, archived: true, series: lineHist.propSides(a) }; }
  if (!h) return res.json({ key, series: [], pro, note: 'No saved prices for this market yet: prop prices are saved every few minutes from when a market first shows up.' });
  res.json({ ...h, pro, series: h.series.map(x => ({ ...x, pts: x.pts.map(([t, line, fair, px]) => [t, line, pro ? fair : null,
    lic.kalshi ? px : Object.fromEntries(Object.entries(px).filter(([k]) => k !== 'kalshi'))]) })) });
});
// which optional feeds this server has, for the app's tab bar: without an
// Odds API key the LINES, LINE SHOP and CLV tabs have nothing to show, so the
// app hides them (the ODDS SCREEN covers them from the free feeds)
app.get('/api/features', (req, res) => res.set('Cache-Control', 'public, max-age=300').json({ oddsApi: !!ODDS_API_KEY }));
// provider health on its own (status, last read, errors, fee handling)
app.get('/api/providers', (req, res) => res.json({ providers: shopHealth(), builtAt: shopQuotes().builtAt }));

return {
  priceAgeNow, prebuildShopQuotes, shopQuotes, propHistory, propHistoryState,
  observePropHistory, readShopDepth
};
};
