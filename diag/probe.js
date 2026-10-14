const fs = require('fs');
fs.mkdirSync('out', { recursive: true });
const AK = 'FhMFpcPWXMeyZxOx';
const FD = 'https://sbapi.nj.sportsbook.fanduel.com/api';
const K = 'https://eu-offering-api.kambicdn.com/offering/v2018/rsiusnj';
const H = { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36', accept: 'application/json, text/html, */*' };
const q = `pbHorizontal=false&_ak=${AK}&timezone=America%2FNew_York`;
const urls = {};
for (const id of ['home', 'boost', 'odds-boost', 'oddsboosts', 'boosts-page', 'daily-odds-boosts', 'super-boosts', 'profit-boost', 'featured', 'popular', 'sgp', 'parlay-hub', 'fanduel-specials', 'specials-boosts', 'nfl-boosts', 'nba-boosts', 'odds-boosts-hub'])
  urls[`fd_c_${id}`] = `${FD}/content-managed-page?page=CUSTOM&customPageId=${id}&${q}`;
for (const p of ['HOME', 'BOOSTS', 'ODDS_BOOSTS', 'PROMOTIONS', 'SPECIALS', 'PROFIT_BOOSTS'])
  urls[`fd_p_${p}`] = `${FD}/content-managed-page?page=${p}&${q}`;
urls.fd_sport = `${FD}/content-managed-page?page=SPORT&eventTypeId=6423&${q}`;
urls.fd_home2 = `${FD}/content-managed-page?page=HOME&_ak=${AK}`;
urls.fd_web = 'https://sportsbook.fanduel.com/';
urls.br_web = 'https://nj.betrivers.com/';
for (const p of ['sugar_house_specials/all/all/all/competitions', 'sugar_house_specials/all/all/all/all', 'sugar_house_specials/nfl_specials/all/all/competitions', 'sugar_house_specials', 'american_football/nfl/all/all/competitions'])
  urls[`k_${p.replace(/\//g, '_')}`] = `${K}/listView/${p}.json?lang=en_US&market=US`;
urls.k_group_specials = `${K}/group/2000117700.json?lang=en_US&market=US`;
urls.k_landing_full = `${K}/betoffer/landing.json?lang=en_US&market=US&includeParticipants=true`;
async function get(name, url) {
  try {
    const r = await fetch(url, { headers: H, signal: AbortSignal.timeout(25000) });
    const text = await r.text();
    fs.writeFileSync(`out/${name}.txt`, text);
    return { status: r.status, bytes: text.length, head: text.slice(0, 160), text };
  } catch (e) { return { error: String(e) }; }
}
(async () => {
  const summary = {};
  for (const [name, url] of Object.entries(urls)) {
    const r = await get(name, url);
    summary[name] = { status: r.status, bytes: r.bytes, head: r.head, error: r.error };
    await new Promise(r => setTimeout(r, 600));
  }
  // web bundles: grep JS for boost strings
  for (const [site, base] of [['fd', 'https://sportsbook.fanduel.com'], ['br', 'https://nj.betrivers.com']]) {
    const html = fs.existsSync(`out/${site}_web.txt`) ? fs.readFileSync(`out/${site}_web.txt`, 'utf8') : '';
    const srcs = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map(m => m[1]).slice(0, 40);
    summary[`${site}_scripts`] = srcs;
    const hits = [];
    for (const s of srcs) {
      const u = s.startsWith('http') ? s : s.startsWith('//') ? 'https:' + s : base + (s.startsWith('/') ? '' : '/') + s;
      const nm = `${site}_js_${srcs.indexOf(s)}`; const r = await get(nm, u);
      if (!r.text) continue;
      for (const m of r.text.matchAll(/.{0,160}(boost|Boost|BOOST).{0,160}/g)) { hits.push(`${u.slice(-40)}: ${m[0]}`); if (hits.length > 400) break; }
      try { fs.unlinkSync(`out/${nm}.txt`); } catch {}
    }
    fs.writeFileSync(`out/${site}_js_boost_hits.txt`, hits.join('\n'));
  }
  fs.writeFileSync('out/summary.json', JSON.stringify(summary, null, 1));
})();
