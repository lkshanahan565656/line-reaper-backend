const axios = require('axios');
const K = 'https://api.elections.kalshi.com/trade-api/v2';
(async () => {
  for (const s of ['KXNFLGAME', 'KXNFLTOTAL']) {
    const { data } = await axios.get(K + '/events', { params: { series_ticker: s, status: 'settled', with_nested_markets: true, limit: 2 } });
    const e = data.events[0];
    console.log(s, 'EVENT', JSON.stringify({ ...e, markets: undefined }));
    console.log('MARKET', JSON.stringify(e.markets[0]));
    const now = Math.floor(Date.now() / 1000);
    const m = e.markets[0], exp = Math.floor(Date.parse(m.expected_expiration_time || m.close_time) / 1000);
    for (const [name, url, params] of [
      ['event candles', `${K}/series/${s}/events/${e.event_ticker}/candlesticks`, { start_ts: exp - 8 * 3600, end_ts: exp, period_interval: 60 }],
      ['market candles', `${K}/series/${s}/markets/${m.ticker}/candlesticks`, { start_ts: exp - 8 * 3600, end_ts: exp, period_interval: 60 }],
      ['batch candles', `${K}/markets/candlesticks`, { market_tickers: e.markets.slice(0, 2).map(x => x.ticker).join(','), start_ts: exp - 8 * 3600, end_ts: exp, period_interval: 60 }],
    ]) {
      try { const r = await axios.get(url, { params }); console.log(name, JSON.stringify(r.data).slice(0, 1500)); } catch (err) { console.log(name, 'ERR', err.response?.status, JSON.stringify(err.response?.data || '').slice(0, 200)); }
    }
  }
})();
