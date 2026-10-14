// Steam backtest: replay Polymarket's minute prices against Kalshi's minute
// asks for games that already started, with the live steam rules, graded on
// CLV like evtrack (close = Polymarket's fair at the last minute before start).
const axios = require('axios');
const fs = require('fs');
const A = process.env.APP || './app';
const X = require(`${A}/xarb`), { createSteamWatch } = require(`${A}/steam`), { kalshiFee } = require(`${A}/exchanges`), V = require(`${A}/xvalue`);
const K = 'https://api.elections.kalshi.com/trade-api/v2';
const DAYS = parseFloat(process.env.BT_DAYS || '4');
const NOW = Date.now(), FROM = NOW - DAYS * 86400e3, TO = NOW - 30 * 60e3;
const LOOKBACK = 6 * 3600e3;
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function get(u, params, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try { return (await axios.get(u, { params, timeout: 30000 })).data; }
    catch (e) { const s = e.response?.status; if (s === 404 || s === 400 || s === 422) return null; await sleep(1500 * (i + 1)); }
  }
  return null;
}
async function pool(items, n, fn) { let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const x = items[i++]; await fn(x); } })); }

(async () => {
  const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
  // ── Polymarket closed game events, in 8h windows (Gamma stops at offset 2,100)
  const pEvents = new Map();
  for (let t = FROM - 6 * 3600e3; t < NOW + 6 * 3600e3; t += 8 * 3600e3) {
    for (const tag of ['sports', 'esports']) for (let off = 0; off < 2100; off += 100) {
      const g = await get('https://gamma-api.polymarket.com/events', { closed: true, tag_slug: tag, limit: 100, offset: off, end_date_min: new Date(t).toISOString(), end_date_max: new Date(t + 8 * 3600e3).toISOString() });
      if (!Array.isArray(g)) break;
      for (const e of g) pEvents.set(e.id, e);
      if (g.length < 100) break;
    }
  }
  const iso = new Date(NOW).toISOString();
  const pSan = [...pEvents.values()].map(e => ({ ...e, closed: false, active: true, markets: (e.markets || []).map(m => ({ ...m, closed: false, active: true, acceptingOrders: true, archived: false, updatedAt: iso, bestAsk: 0.5, bestBid: 0.49, liquidityNum: 1e5, liquidity: 1e5 })) }));
  const poly = X.parsePolymarketBinaries(pSan, { now: NOW }).filter(p => p.startTime && Date.parse(p.startTime) >= FROM && Date.parse(p.startTime) <= TO);
  log('polymarket events', pEvents.size, 'rows in window', poly.length);
  // ── Kalshi settled game series
  let series = [];
  try { series = await X.fetchKalshiGameSeries({ get: (u, o) => axios.get(u, o) }); } catch (e) { log('series list failed', e.message); series = X.SEED_GAME_SERIES; }
  const kEvents = [];
  await pool(series, 4, async s => {
    let cursor = null;
    for (let p = 0; p < 10; p++) {
      const d = await get(K + '/events', { series_ticker: s, status: 'settled', with_nested_markets: true, limit: 200, min_close_ts: Math.floor((FROM - 86400e3) / 1000), ...(cursor ? { cursor } : {}) });
      if (!d) break;
      kEvents.push(...(d.events || []).map(e => ({ ...e, series_ticker: e.series_ticker || s })));
      cursor = d.cursor; if (!cursor || !(d.events || []).length) break;
    }
  });
  const kSan = kEvents.map(e => ({ ...e, markets: (e.markets || []).map(m => ({ ...m, status: 'active', result: '', yes_ask_dollars: '0.5', no_ask_dollars: '0.5', liquidity_dollars: '10000' })) }));
  const kalshi = X.parseKalshiBinaries(kSan);
  const seriesOf = new Map(); for (const e of kEvents) for (const m of e.markets || []) seriesOf.set(m.ticker, e.series_ticker);
  log('kalshi series', series.length, 'events', kEvents.length, 'rows', kalshi.length);
  // ── pairs, as xvalue.findValue builds them (plus each team market's twin)
  const matches = X.matchMarkets(kalshi, poly).filter(m => m.by !== 'title');
  const teamMkts = new Map(); for (const k of kalshi) if (k.kind === 'teams') teamMkts.set(`${k.eventKey}|${k.outcomeLabel}`, k);
  const pairs = new Map();
  for (const m of matches) {
    pairs.set(m.kalshi.id, { target: m.kalshi, ref: m.polymarket, same: m.same });
    const twin = m.by === 'teams' && m.kalshi.noLabel ? teamMkts.get(`${m.kalshi.eventKey}|${m.kalshi.noLabel}`) : null;
    if (twin && !pairs.has(twin.id)) pairs.set(twin.id, { target: twin, ref: m.polymarket, same: !m.same });
  }
  log('matches', matches.length, 'pairs', pairs.size, JSON.stringify(matches.reduce((a, m) => (a[m.by] = (a[m.by] || 0) + 1, a), {})));
  // ── histories
  const pHist = new Map(), kHist = new Map();
  const list = [...pairs.values()].map(x => ({ ...x, start: Date.parse(x.ref.startTime || x.target.startTime) })).filter(x => x.start >= FROM && x.start <= TO);
  const toks = [...new Set(list.map(x => x.ref.tokenIds?.[x.ref.yesIndex ?? 0]).filter(Boolean))];
  await pool(list.map(x => x.ref).filter((r, i, a) => a.findIndex(y => y.id === r.id) === i), 6, async r => {
    const tok = r.tokenIds?.[r.yesIndex ?? 0]; if (!tok) return;
    const st = Date.parse(r.startTime);
    const h = await get('https://clob.polymarket.com/prices-history', { market: tok, startTs: Math.floor((st - LOOKBACK) / 1000), endTs: Math.floor(st / 1000), fidelity: 1 });
    if (h?.history?.length) pHist.set(r.id, h.history.map(p => [p.t * 1000, p.p]));
  });
  log('polymarket histories', pHist.size, 'of', toks.length);
  await pool(list, 6, async x => {
    const s = seriesOf.get(x.target.id) || x.target.id.split('-')[0];
    const d = await get(`${K}/series/${s}/markets/${x.target.id}/candlesticks`, { start_ts: Math.floor((x.start - LOOKBACK) / 1000), end_ts: Math.floor(x.start / 1000), period_interval: 1 });
    const c = (d?.candlesticks || []).map(k => [k.end_period_ts * 1000, parseFloat(k.yes_ask?.close_dollars), parseFloat(k.yes_bid?.close_dollars)]).filter(k => Number.isFinite(k[1]) && Number.isFinite(k[2]));
    if (c.length) kHist.set(x.target.id, c);
  });
  log('kalshi histories', kHist.size, 'of', list.length);
  fs.writeFileSync('bt-data.json', JSON.stringify({ at: NOW, list: list.map(x => ({ id: x.target.id, ref: x.ref.id, same: x.same, start: x.start, league: x.target.league || x.ref.league || V.leagueTag(x.target) || V.leagueTag(x.ref), market: x.target.kind === 'teams' || x.target.game3 ? 'moneyline' : x.target.kind, title: x.target.eventTitle, yes: x.target.outcomeLabel || 'YES', no: x.target.noLabel || 'NO' })), pHist: [...pHist], kHist: [...kHist] }));
  log('saved bt-data.json');
})();
