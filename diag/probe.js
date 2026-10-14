const axios = require('axios');
const K = 'https://api.elections.kalshi.com/trade-api/v2';
const get = async (u, params) => { try { const r = await axios.get(u, { params, timeout: 30000 }); return r.data; } catch (e) { return { ERR: e.message, body: JSON.stringify(e.response?.data).slice(0, 300) }; } };
const show = (l, x) => console.log(l, JSON.stringify(x).slice(0, 1500));
(async () => {
  const now = Math.floor(Date.now() / 1000);
  const ev = await get(K + '/events', { series_ticker: 'KXEPLGAME', status: 'settled', with_nested_markets: true, limit: 5 });
  show('K events settled', { n: ev.events?.length, cursor: ev.cursor, first: ev.events?.[0] && { t: ev.events[0].event_ticker, title: ev.events[0].title, m: ev.events[0].markets?.slice(0, 1) } , ERR: ev.ERR, body: ev.body });
  const ev2 = await get(K + '/events', { series_ticker: 'KXATPMATCH', status: 'closed', with_nested_markets: true, limit: 3 });
  show('K events closed', { n: ev2.events?.length, t: ev2.events?.map(e => e.event_ticker), ERR: ev2.ERR });
  const m = ev.events?.[0]?.markets?.[0];
  if (m) {
    const close = Date.parse(m.close_time) / 1000;
    const c = await get(`${K}/series/KXEPLGAME/markets/${m.ticker}/candlesticks`, { start_ts: close - 86400 * 3, end_ts: close, period_interval: 1 });
    show('K candles', { n: c.candlesticks?.length, a: c.candlesticks?.slice(0, 2), z: c.candlesticks?.slice(-2), ERR: c.ERR, body: c.body });
    const c60 = await get(`${K}/series/KXEPLGAME/markets/${m.ticker}/candlesticks`, { start_ts: close - 86400 * 3, end_ts: close, period_interval: 60 });
    show('K candles60', { n: c60.candlesticks?.length, ERR: c60.ERR, body: c60.body });
  }
  const g = await get('https://gamma-api.polymarket.com/events', { closed: true, tag_slug: 'epl', limit: 3, order: 'endDate', ascending: false });
  const e0 = Array.isArray(g) ? g[0] : null;
  show('G closed', { n: Array.isArray(g) ? g.length : g, slug: e0?.slug, start: e0?.startTime, end: e0?.endDate, m: e0?.markets?.slice(0, 1).map(x => ({ q: x.question, tok: x.clobTokenIds, gst: x.gameStartTime, type: x.sportsMarketType, closed: x.closed, upd: x.updatedAt })) });
  const tok = e0 && JSON.parse(e0.markets[0].clobTokenIds)[0];
  if (tok) {
    const st = Date.parse(e0.markets[0].gameStartTime || e0.startTime) / 1000;
    const h = await get('https://clob.polymarket.com/prices-history', { market: tok, startTs: st - 6 * 3600, endTs: st, fidelity: 1 });
    show('PH', { n: h.history?.length, a: h.history?.slice(0, 3), z: h.history?.slice(-3), ERR: h.ERR, body: h.body });
  }
  const gs = await get('https://gamma-api.polymarket.com/events', { closed: true, tag_slug: 'sports', limit: 100, order: 'endDate', ascending: false, end_date_min: new Date(Date.now() - 2 * 86400e3).toISOString() });
  show('G sports 2d', { n: Array.isArray(gs) ? gs.length : gs, slugs: Array.isArray(gs) ? gs.slice(0, 20).map(e => e.slug) : null });
})();
