// probe: which extra odds sources answer from GitHub Actions (no keys used)
const fs = require('fs');
fs.mkdirSync('out/raw', { recursive: true });
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
const day = d => new Date(Date.now() + d * 864e5).toISOString().slice(0, 10).replace(/-/g, '');
const AN_BOOKS = '15,30,68,69,71,75,76,79,123,247,972,973,1902,1903,2194,2292';
const C = [
  // US books direct
  ['dk-nash', 'https://sportsbook-nash.draftkings.com/api/sportscontent/dkusnj/v1/leagues/88808', { Origin: 'https://sportsbook.draftkings.com', Referer: 'https://sportsbook.draftkings.com/' }],
  ['dk-v5', 'https://sportsbook.draftkings.com/sites/US-NJ-SB/api/v5/eventgroups/88808?format=json'],
  ['caesars', 'https://api.americanwagering.com/regions/us/locations/nj/brands/czr/sb/v3/sports/americanfootball/events/schedule'],
  ['betmgm-page', 'https://sports.nj.betmgm.com/en/sports/football-11/betting/usa-9/nfl-35'],
  ['fanatics', 'https://sportsbook.fanatics.com/'],
  ['hardrock', 'https://app.hardrock.bet/'],
  ['espnbet', 'https://espnbet.com/sport/football/organization/us/competition/nfl'],
  ['bet365', 'https://www.bet365.com/'],
  ['bovada-nfl', 'https://www.bovada.lv/services/sports/event/coupon/events/A/description/football/nfl?marketFilterId=def&lang=en'],
  ['bovada-esports', 'https://www.bovada.lv/services/sports/event/coupon/events/A/description/esports?marketFilterId=def&preMatchOnly=true&lang=en'],
  // ESPN (lists odds providers)
  ['espn-scoreboard', 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard'],
  ['espn-core-nfl-events', 'https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/events?limit=5'],
  // aggregators
  ['action-nfl', `https://api.actionnetwork.com/web/v1/scoreboard/nfl?period=game&bookIds=${AN_BOOKS}&date=${day(1)}`],
  ['action-ncaaf', `https://api.actionnetwork.com/web/v1/scoreboard/ncaaf?period=game&bookIds=${AN_BOOKS}&date=${day(2)}`],
  ['action-books', 'https://api.actionnetwork.com/web/v1/books'],
  ['action-props-nfl', `https://api.actionnetwork.com/web/v1/leagues/1/props/core_bet_type_9_passing_yards?bookIds=${AN_BOOKS}`],
  ['sbr-nfl', 'https://www.sportsbookreview.com/betting-odds/nfl-football/'],
  ['sbr-props', 'https://www.sportsbookreview.com/betting-odds/nfl-football/player-props/'],
  ['covers', 'https://www.covers.com/sport/football/nfl/odds'],
  ['oddstrader', 'https://www.oddstrader.com/nfl/'],
  ['vegasinsider', 'https://www.vegasinsider.com/nfl/odds/las-vegas/'],
  ['scoresandodds', 'https://www.scoresandodds.com/nfl'],
  ['oddsshark', 'https://www.oddsshark.com/nfl/odds'],
  ['bettingpros-page', 'https://www.bettingpros.com/nfl/odds/'],
  // exchanges
  ['smarkets-esports', 'https://api.smarkets.com/v3/events/?type_domain=esports&state=upcoming&limit=50'],
  ['smarkets-nfl', 'https://api.smarkets.com/v3/events/?type=american_football_match&state=upcoming&limit=50'],
  ['betfair-page', 'https://www.betfair.com/exchange/plus/en/esports-betting-27454571'],
  ['matchbook-sports', 'https://api.matchbook.com/edge/rest/lookups/sports?per-page=100'],
  ['matchbook-events', 'https://api.matchbook.com/edge/rest/events?per-page=20&include-prices=true&price-depth=1'],
  ['prophetx', 'https://www.prophetx.co/'],
  ['sporttrade', 'https://app.sporttrade.com/'],
  ['novig', 'https://app.novig.us/'],
  ['polymarket-esports', 'https://gamma-api.polymarket.com/events?tag_slug=esports&active=true&closed=false&limit=50'],
  // esports books
  ['rivalry', 'https://www.rivalry.com/esports'],
  ['thunderpick', 'https://thunderpick.io/esports'],
  ['ggbet', 'https://gg.bet/en/esports'],
  ['cloudbet', 'https://sports-api.cloudbet.com/pub/v2/odds/sports'],
  ['1xbet', 'https://1xbet.com/LineFeed/Get1x2_VZip?sports=40&count=50&lng=en&mode=4&country=1&getEmpty=true'],
  ['unibet-esports', 'https://eu-offering-api.kambicdn.com/offering/v2018/ub/listView/esports/all/all/all/matches.json?lang=en_GB&market=GB'],
  ['kambi-pa-esports', 'https://eu-offering-api.kambicdn.com/offering/v2018/rsiuspa/listView/esports/all/all/all/matches.json?lang=en_US&market=US'],
  ['oddsportal', 'https://www.oddsportal.com/esports/'],
  ['oddspedia', 'https://oddspedia.com/esports'],
  ['oddsapi-docs', 'https://the-odds-api.com/sports-odds-data/bookmaker-apis.html'],
  ['oddsapi-markets', 'https://the-odds-api.com/sports-odds-data/betting-markets.html'],
  ['oddsapi-sports-list', 'https://the-odds-api.com/sports-odds-data/sports-apis.html'],
  ['oddsapi-pricing', 'https://the-odds-api.com/'],
];
const get = async (key, url, hdr = {}) => {
  const t0 = Date.now();
  try {
    const r = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json, text/html;q=0.9, */*;q=0.8', 'accept-language': 'en-US,en;q=0.9', ...hdr }, signal: AbortSignal.timeout(20000) });
    const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {}
    const hd = Object.fromEntries([...r.headers].filter(([k]) => /server|cf-ray|content-type|akamai|x-cache/i.test(k)));
    fs.writeFileSync(`out/raw/${key}.${j ? 'json' : 'txt'}`, t.slice(0, 3e6));
    return { key, url, status: r.status, ms: Date.now() - t0, len: t.length, json: !!j, hd, head: j ? JSON.stringify(j).slice(0, 600) : t.slice(0, 300).replace(/\s+/g, ' '), nextData: /__NEXT_DATA__/.test(t) };
  } catch (e) { return { key, url, status: 0, err: String(e.message || e).slice(0, 200), ms: Date.now() - t0 }; }
};
(async () => {
  const out = [];
  for (const [k, u, h] of C) { const r = await get(k, u, h); out.push(r); console.log(r.key, r.status, r.len || r.err); }
  fs.writeFileSync('out/summary.json', JSON.stringify(out, null, 1));
})();
