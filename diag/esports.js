const axios = require('axios');
const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36' };
const g = (u, o = {}) => axios.get(u, { timeout: 25000, headers: UA, ...o });
const out = (...a) => console.log(...a);
async function probe(name, url, opts, show) {
  try { const r = await g(url, opts); out(`\n## ${name}: ${r.status} len=${JSON.stringify(r.data).length}`); if (show) out(show(r.data)); return r.data; }
  catch (e) { out(`\n## ${name}: FAIL ${e.response?.status || e.code} ${String(e.response?.data || e.message).slice(0, 200)}`); }
}
const s = x => JSON.stringify(x, null, 0).slice(0, 1500);
(async () => {
  // Polymarket sports list
  const sports = await probe('PM /sports', 'https://gamma-api.polymarket.com/sports');
  const es = (sports || []).filter(x => String(x.tags || '').split(',').includes('64'));
  out('esports sports:', es.map(x => `${x.sport}:${x.series}`).join(' '));
  for (const sp of es) {
    const ev = await probe(`PM events ${sp.sport}`, `https://gamma-api.polymarket.com/events?series_id=${sp.series}&closed=false&limit=100&order=startDate&ascending=false`);
    if (!ev) continue;
    out(`count ${ev.length}`);
    for (const e of ev.slice(0, 4)) {
      out(`- ${e.slug} | ${e.title} | start ${e.startTime || e.startDate} end ${e.endDate} | vol ${e.volume} liq ${e.liquidity} | ${e.markets?.length} mkts`);
      for (const m of (e.markets || []).slice(0, 6)) out(`   * ${m.question} | type=${m.sportsMarketType} git=${m.groupItemTitle} out=${m.outcomes} px=${m.outcomePrices} bid/ask=${m.bestBid}/${m.bestAsk} liq=${m.liquidity} vol=${m.volume} gst=${m.gameStartTime} closed=${m.closed} active=${m.active} acc=${m.acceptingOrders} cond=${m.conditionId} tok=${String(m.clobTokenIds).slice(0,60)} negRisk=${m.negRisk} fee=${m.feeType||m.feesEnabled}`);
    }
    // all upcoming game titles
    out('titles:', ev.filter(e => /vs/i.test(e.title)).map(e => `${e.title} @${e.startTime || e.endDate}`).slice(0, 40).join(' || '));
  }
  // Kalshi series
  const ks = await probe('Kalshi series', 'https://api.elections.kalshi.com/trade-api/v2/series?category=Sports');
  const re = /lol|league of legends|cs2|counter|valorant|dota|call of duty|overwatch|rocket league|rainbow|starcraft|esport|honor of kings|mobile legends|apex|fortnite|tft|teamfight/i;
  const kes = (ks?.series || []).filter(x => re.test(x.title) || /^KX(LOL|CS2|VAL|DOTA|COD|OW|RL|R6)/.test(x.ticker));
  out('kalshi esports series:', kes.map(x => `${x.ticker}=${x.title}`).join(' | '));
  for (const k of kes) {
    const ev = await probe(`K events ${k.ticker}`, `https://api.elections.kalshi.com/trade-api/v2/events?series_ticker=${k.ticker}&status=open&with_nested_markets=true&limit=50`);
    const evs = ev?.events || [];
    out(`open ${evs.length}`);
    for (const e of evs.slice(0, 3)) {
      out(`- ${e.event_ticker} | ${e.title} | sub ${e.sub_title}`);
      for (const m of (e.markets || []).slice(0, 4)) out(`   * ${m.ticker} | ${m.yes_sub_title} | bid/ask ${m.yes_bid}/${m.yes_ask} ${m.yes_bid_dollars}/${m.yes_ask_dollars} | vol ${m.volume} oi ${m.open_interest} liq ${m.liquidity} | exp ${m.expected_expiration_time} close ${m.close_time} | rules ${String(m.rules_primary).slice(0,120)}`);
    }
  }
  // Polymarket US leagues
  await probe('PMUS leagues', 'https://gateway.polymarket.us/v2/leagues', {}, d => s(d).slice(0, 3000));
  // Free stats sources
  await probe('OpenDota proMatches', 'https://api.opendota.com/api/proMatches', {}, d => `n=${d.length} first=${s(d[0])}`);
  await probe('Leaguepedia cargo', 'https://lol.fandom.com/api.php?action=cargoquery&format=json&tables=ScoreboardGames&fields=Team1,Team2,WinTeam,DateTime_UTC,Tournament&order_by=DateTime_UTC%20DESC&limit=5', {}, s);
  await probe('OE listing', 'https://oracleselixir-downloadable-match-data.s3-us-west-2.amazonaws.com/?list-type=2&prefix=2026', {}, d => String(d).slice(0, 1500));
  await probe('vlrggapi results', 'https://vlrggapi.vercel.app/match?q=results', {}, s);
  await probe('vlr.gg results html', 'https://www.vlr.gg/matches/results', {}, d => `len ${String(d).length} sample ${String(d).replace(/\s+/g,' ').match(/match-item[\s\S]{0,600}/)?.[0]}`);
  await probe('vlr.gg stats html', 'https://www.vlr.gg/stats/?event_group_id=all&region=all&min_rounds=200&agent=all&map_id=all&timespan=60d', {}, d => `len ${String(d).length}`);
  await probe('bo3 matches', 'https://api.bo3.gg/api/v1/matches?page[offset]=0&page[limit]=5&sort=-start_date&filter[matches.status][in]=finished&filter[matches.discipline_id][eq]=1', { headers: { ...UA, origin: 'https://bo3.gg', referer: 'https://bo3.gg/' } }, s);
  await probe('hltv results', 'https://www.hltv.org/results', {}, d => `len ${String(d).length}`);
  await probe('liquipedia api cs', 'https://liquipedia.net/counterstrike/api.php?action=query&meta=siteinfo&format=json', { headers: { 'User-Agent': 'LineReaper/1.0 (contact lr)', 'Accept-Encoding': 'gzip' } }, s);
  await probe('gol.gg', 'https://gol.gg/tournament/list/', {}, d => `len ${String(d).length}`);
  await probe('lolesports schedule', 'https://esports-api.lolesports.com/persisted/gw/getSchedule?hl=en-US', { headers: { ...UA, 'x-api-key': '0TvQnueqKa5mxJntVWt0w4LpLfEkrV1Ta8rQBb9Z' } }, d => s(d).slice(0, 1500));
  await probe('UD v5', 'https://api.underdogfantasy.com/beta/v5/over_under_lines', {}, d => `keys ${Object.keys(d)}`);
  await probe('UD v6', 'https://api.underdogfantasy.com/beta/v6/over_under_lines', {}, d => `keys ${Object.keys(d)}`);
  await probe('UD v1 home', 'https://api.underdogfantasy.com/v1/over_under_lines', {}, d => `keys ${Object.keys(d)}`);
  await probe('PP projections', 'https://api.prizepicks.com/projections?per_page=10', {}, d => `n ${d.data?.length}`);
})();
