const axios = require('axios');
const X = require(process.env.APP + '/execcheck');
(async () => {
  const ev = (await axios.get('https://api.elections.kalshi.com/trade-api/v2/events', { params: { series_ticker: 'KXNBAGAME', status: 'open', with_nested_markets: true, limit: 3 } })).data.events;
  for (const e of ev) for (const m of e.markets.slice(0, 1)) {
    const ob = (await axios.get(X.KALSHI_BOOK_URL(m.ticker))).data;
    console.log(m.ticker, 'ask', m.yes_ask_dollars, 'bid', m.yes_bid_dollars, 'keys', Object.keys(ob), JSON.stringify(ob).slice(0, 300));
    const ya = parseFloat(m.yes_ask_dollars);
    console.log('  depth yes at ask', JSON.stringify(X.kalshiDepth(ob, 'yes', ya)), 'no at ask', JSON.stringify(X.kalshiDepth(ob, 'no', parseFloat(m.no_ask_dollars))));
  }
})();
