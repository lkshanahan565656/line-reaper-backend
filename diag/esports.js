const axios = require('axios');
const fs = require('fs');
const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36' };
const g = (u, o = {}) => axios.get(u, { timeout: 30000, headers: UA, ...o });
const out = (...a) => console.log(...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const s = (x, n = 2500) => JSON.stringify(x).slice(0, n);
async function probe(name, url, opts, show) {
  try { const r = await g(url, opts); out(`\n## ${name}: ${r.status}`); if (show) out(show(r.data)); return r.data; }
  catch (e) { out(`\n## ${name}: FAIL ${e.response?.status || e.code} ${String(e.message).slice(0, 200)}`); }
}
(async () => {
  // UD v1 parsed by the server's parser
  const src = fs.readFileSync('server.js', 'utf8');
  const fn = src.slice(src.indexOf('function parseUnderdogPayload'), src.indexOf('async function scrapeUnderdog'));
  const parseUnderdogPayload = eval('(' + fn + ')');
  const ud = await probe('UD v1', 'https://api.underdogfantasy.com/v1/over_under_lines', { headers: { ...UA, Accept: 'application/json' } }, d => `lines ${d.over_under_lines?.length} games ${d.games?.length} solo ${d.solo_games?.length} apps ${d.appearances?.length} players ${d.players?.length}\nline0 ${s(d.over_under_lines?.[0], 1500)}\napp0 ${s(d.appearances?.[0], 400)}\nplayer0 ${s(d.players?.[0], 400)}\ngame0 ${s(d.games?.[0], 600)}\nsolo0 ${s(d.solo_games?.[0], 600)}`);
  if (ud) {
    const lines = parseUnderdogPayload(ud);
    const bySport = {}; for (const l of lines) bySport[l.sport] = (bySport[l.sport] || 0) + 1;
    out('parsed', lines.length, s(bySport, 1500));
    const es = lines.filter(l => /CS|VAL|LOL|DOTA|COD|ESPORT|R6|OW|HALO|APEX|RL/i.test(l.sport));
    out('esports sample', s(es.slice(0, 6), 2500));
  }
  // bo3 with team names
  const H = { headers: { ...UA, origin: 'https://bo3.gg', referer: 'https://bo3.gg/' } };
  await probe('bo3 matches with teams', 'https://api.bo3.gg/api/v1/matches?page[offset]=0&page[limit]=3&sort=-start_date&filter[matches.status][in]=finished&filter[matches.discipline_id][eq]=1&with=teams,tournament', H, d => s(d, 4000));
  await probe('bo3 matches upcoming', 'https://api.bo3.gg/api/v1/matches?page[offset]=0&page[limit]=2&sort=start_date&filter[matches.status][in]=upcoming,current&filter[matches.discipline_id][eq]=1&with=teams', H, d => s(d, 2500));
  await probe('bo3 teams', 'https://api.bo3.gg/api/v1/teams?filter[teams.id][in]=791,441', H, d => s(d, 1500));
  await probe('bo3 games', 'https://api.bo3.gg/api/v1/games?filter[games.match_id][eq]=131134', H, d => s(d, 2000));
  // vlr results html
  await probe('vlr results p1', 'https://www.vlr.gg/matches/results', {}, d => {
    const t = String(d);
    const i = t.indexOf('wf-label mod-large');
    return t.slice(i - 200, i + 6000).replace(/\s+/g, ' ');
  });
  await probe('vlr results p2', 'https://www.vlr.gg/matches/results/?page=2', {}, d => `len ${String(d).length}`);
  await probe('vlr upcoming', 'https://www.vlr.gg/matches', {}, d => `len ${String(d).length}`);
  // lolesports
  const LH = { headers: { ...UA, 'x-api-key': '0TvQnueqKa5mxJntVWt0w4LpLfEkrV1Ta8rQBb9Z' } };
  const sch = await probe('lolesports schedule', 'https://esports-api.lolesports.com/persisted/gw/getSchedule?hl=en-US', LH, d => {
    const ev = d.data.schedule.events; return `n ${ev.length} states ${s([...new Set(ev.map(e => e.state + ':' + e.type))])} leagues ${s([...new Set(ev.map(e => e.league.slug))])} first ${ev[0].startTime} last ${ev[ev.length-1].startTime}\nsample ${s(ev[0], 1500)}`;
  });
  if (sch) await probe('lolesports older', `https://esports-api.lolesports.com/persisted/gw/getSchedule?hl=en-US&pageToken=${sch.data.schedule.pages.older}`, LH, d => { const ev = d.data.schedule.events; return `n ${ev.length} first ${ev[0]?.startTime} last ${ev[ev.length-1]?.startTime}`; });
  await probe('lolesports leagues', 'https://esports-api.lolesports.com/persisted/gw/getLeagues?hl=en-US', LH, d => `n ${d.data.leagues.length} ${d.data.leagues.map(l => l.slug).join(',')}`);
  // Kalshi esports game-ish series, slowly
  for (const t of ['KXCS2GAME', 'KXLOLGAME', 'KXDOTA2GAME', 'KXCS2MAP', 'KXLOLMAP', 'KXCS2SPREAD', 'KXLOLTOTALMAPS', 'KXCODGAME', 'KXR6GAME', 'KXOWGAME', 'KXRLGAME', 'KXDOTA2MAP', 'KXCS2MAPWINNER', 'KXMLBBGAME', 'KXVALORANTSPREAD', 'KXVALORANTTOTALMAPS', 'KXLOLGAMES', 'KXCSGOGAME', 'KXCS2GAMES', 'KXROCKETLEAGUEGAME', 'KXDOTA2GAME3WAY', 'KXLOLSPREAD', 'KXDOTA2SPREAD']) {
    await sleep(1500);
    await probe(`K ${t}`, `https://api.elections.kalshi.com/trade-api/v2/events?series_ticker=${t}&status=open&with_nested_markets=true&limit=100`, {}, d => {
      const evs = d.events || [];
      return `open ${evs.length}` + evs.slice(0, 2).map(e => `\n- ${e.event_ticker} | ${e.title} | ${e.sub_title} | mutex ${e.mutually_exclusive}` + (e.markets || []).slice(0, 3).map(m => `\n   * ${m.ticker} | ${m.yes_sub_title} | ${m.yes_bid_dollars}/${m.yes_ask_dollars} | liq ${m.liquidity_dollars} vol ${m.volume_fp ?? m.volume} oi ${m.open_interest_fp ?? m.open_interest} | exp ${m.expected_expiration_time} | st ${m.status} | ${String(m.rules_primary).slice(0, 160)}`).join('')).join('');
    });
  }
})();
