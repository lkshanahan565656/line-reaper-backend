const fs = require('fs');
fs.mkdirSync('out', { recursive: true });
const AK = 'FhMFpcPWXMeyZxOx';
const FD = 'https://sbapi.nj.sportsbook.fanduel.com/api';
const K = 'https://eu-offering-api.kambicdn.com/offering/v2018/rsiusnj';
const H = { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36', accept: 'application/json' };
const urls = {
  fd_home: `${FD}/content-managed-page?page=HOME&pbHorizontal=false&_ak=${AK}&timezone=America%2FNew_York`,
  fd_nfl: `${FD}/content-managed-page?page=CUSTOM&customPageId=nfl&pbHorizontal=false&_ak=${AK}&timezone=America%2FNew_York`,
  fd_nba: `${FD}/content-managed-page?page=CUSTOM&customPageId=nba&pbHorizontal=false&_ak=${AK}&timezone=America%2FNew_York`,
  fd_mlb: `${FD}/content-managed-page?page=CUSTOM&customPageId=mlb&pbHorizontal=false&_ak=${AK}&timezone=America%2FNew_York`,
  fd_nhl: `${FD}/content-managed-page?page=CUSTOM&customPageId=nhl&pbHorizontal=false&_ak=${AK}&timezone=America%2FNew_York`,
  fd_ncaaf: `${FD}/content-managed-page?page=CUSTOM&customPageId=ncaaf&pbHorizontal=false&_ak=${AK}&timezone=America%2FNew_York`,
  fd_boosts: `${FD}/content-managed-page?page=CUSTOM&customPageId=boosts&pbHorizontal=false&_ak=${AK}&timezone=America%2FNew_York`,
  fd_oddsboosts: `${FD}/content-managed-page?page=CUSTOM&customPageId=odds-boosts&pbHorizontal=false&_ak=${AK}&timezone=America%2FNew_York`,
  fd_profitboost: `${FD}/content-managed-page?page=CUSTOM&customPageId=profit-boosts&pbHorizontal=false&_ak=${AK}&timezone=America%2FNew_York`,
  fd_promos: `${FD}/content-managed-page?page=CUSTOM&customPageId=promotions&pbHorizontal=false&_ak=${AK}&timezone=America%2FNew_York`,
  fd_specials: `${FD}/content-managed-page?page=CUSTOM&customPageId=specials&pbHorizontal=false&_ak=${AK}&timezone=America%2FNew_York`,
  fd_dailyboosts: `${FD}/content-managed-page?page=CUSTOM&customPageId=daily-boosts&pbHorizontal=false&_ak=${AK}&timezone=America%2FNew_York`,
  fd_sgp: `${FD}/content-managed-page?page=CUSTOM&customPageId=same-game-parlay&pbHorizontal=false&_ak=${AK}&timezone=America%2FNew_York`,
  fd_navigation: `${FD}/navigation?_ak=${AK}`,
  fd_azsports: `${FD}/content-managed-page?page=AZ_SPORTS&_ak=${AK}&timezone=America%2FNew_York`,
  k_all: `${K}/listView/all/all/all/all/matches.json?lang=en_US&market=US`,
  k_nfl: `${K}/listView/american_football/nfl/all/all/matches.json?lang=en_US&market=US`,
  k_groups: `${K}/group.json?lang=en_US&market=US`,
  k_highlight: `${K}/group/highlight.json?lang=en_US&market=US`,
  k_boost: `${K}/listView/all/all/all/all/matches.json?lang=en_US&market=US&category=odds_boost`,
  k_specials: `${K}/listView/specials/all/all/all/matches.json?lang=en_US&market=US`,
  k_landing: `${K}/betoffer/landing.json?lang=en_US&market=US`,
  k_boosted: `${K}/boostedodds.json?lang=en_US&market=US`,
  k_prepacks: `${K}/listView/all/all/all/all/prepacks.json?lang=en_US&market=US`,
  k_rsi_boost: `${K}/listView/all/all/all/all/boosts.json?lang=en_US&market=US`,
  br_cms: `https://nj.betrivers.com/api/service/sportsbook/offering/listview/details?groupId=1000093656&pageNr=1&pageSize=10&offset=0&t=1`,
  br_boost: `https://nj.betrivers.com/api/service/sportsbook/offering/listview/events?t=1&cageCode=201&type=prematch&groupId=odds-boost`,
};
function scan(obj, path = '', hits = [], depth = 0) {
  if (hits.length > 60 || depth > 30) return hits;
  if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) {
      if (/boost|promo|enhanc|special|supercharg/i.test(k)) hits.push(`${path}.${k} = ${JSON.stringify(v).slice(0, 300)}`);
      else if (typeof v === 'string' && /boost|enhanc|supercharg/i.test(v)) hits.push(`${path}.${k} = ${v.slice(0, 200)}`);
      scan(v, `${path}.${k}`, hits, depth + 1);
    }
  }
  return hits;
}
(async () => {
  const summary = {};
  for (const [name, url] of Object.entries(urls)) {
    try {
      const r = await fetch(url, { headers: H, signal: AbortSignal.timeout(25000) });
      const text = await r.text();
      fs.writeFileSync(`out/${name}.json`, text);
      let hits = [];
      try { hits = scan(JSON.parse(text)); } catch (e) { hits = ['not json: ' + text.slice(0, 200)]; }
      summary[name] = { status: r.status, bytes: text.length, hits };
    } catch (e) { summary[name] = { error: String(e) }; }
    await new Promise(r => setTimeout(r, 800));
  }
  fs.writeFileSync('out/summary.json', JSON.stringify(summary, null, 1));
})();
