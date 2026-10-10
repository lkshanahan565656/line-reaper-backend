// One-off: Kalshi's and Polymarket's US race markets (Senate, governor, House), side by side.
const axios = require('axios');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let last = 0;
const http = { async get(url, opts = {}) { const w = last + 400 - Date.now(); if (w > 0) await sleep(w); last = Date.now();
  for (let i = 0; ; i++) { try { return await axios.get(url, { timeout: 30000, ...opts }); } catch (e) { if (e?.response?.status === 429 && i < 5) { await sleep(4000 * (i + 1)); continue; } throw e; } } } };
const out = (name, v) => console.log(`==== ${name}\n${JSON.stringify(v)}\n====`);
const K = 'https://api.elections.kalshi.com/trade-api/v2';
async function main() {
  const series = (await http.get(`${K}/series`)).data?.series || [];
  const race = series.filter(s => s.category === 'Elections' && /senate|governor|gubernatorial|house/i.test(s.title || '') && !/primary|nominee|margin|turnout|combo|endorse|counties|runoff|drop out|closer|percent|vote|poll|debate|mention/i.test(s.title || ''));
  out('race-series', { n: race.length, list: race.map(s => `${s.ticker}|${s.title}`).slice(0, 400) });
  // open events in a sample of them
  const pick = race.filter(s => /^(SENATE|GOV|KXGOV|KXSENATE|HOUSE)/.test(s.ticker)).slice(0, 25);
  for (const s of pick) {
    try {
      const evs = (await http.get(`${K}/events`, { params: { status: 'open', series_ticker: s.ticker, with_nested_markets: true, limit: 50 } })).data?.events || [];
      if (!evs.length) continue;
      out(`k-${s.ticker}`, evs.slice(0, 2).map(e => ({ e: e.event_ticker, title: e.title, sub: e.sub_title, me: e.mutually_exclusive,
        m: (e.markets || []).slice(0, 3).map(m => `${m.ticker}|${m.title}|${m.yes_sub_title}|close=${m.close_time}|exp=${m.expected_expiration_time}|y=${m.yes_ask_dollars}`) })));
    } catch (e) { out(`k-error-${s.ticker}`, e.message); }
  }
  // Polymarket: midterm race events
  for (const q of ['Senate Election Winner', 'Governor Election Winner', 'House Election Winner']) {
    try {
      const r = await axios.get('https://gamma-api.polymarket.com/public-search', { params: { q, limit_per_type: 20 }, timeout: 20000 });
      const evs = r.data?.events || [];
      out(`pm-${q}`, evs.slice(0, 20).map(e => ({ slug: e.slug, title: e.title, end: e.endDate, m: (e.markets || []).slice(0, 2).map(m => `${m.question}|${m.groupItemTitle}|end=${m.endDate}`) })));
    } catch (e) { out(`pm-error-${q}`, e.message); }
  }
}
main().catch(e => out('fatal', { m: e.message, stack: e.stack }));
