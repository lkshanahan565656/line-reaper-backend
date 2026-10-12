const axios = require('axios');
const log = (...a) => console.log(...a);
const KEY = '0TvQnueqKa5mxJntVWt0w4LpLfEkrV1Ta8rQBb9Z';
const H = { 'x-api-key': KEY, 'User-Agent': 'Mozilla/5.0' };
const j = x => JSON.stringify(x);
(async () => {
  // 1. lolesports: schedule page with completed matches from today
  try {
    const s = await axios.get('https://esports-api.lolesports.com/persisted/gw/getSchedule', { params: { hl: 'en-US' }, headers: H });
    const evs = s.data.data.schedule.events.filter(e => e.state === 'completed').slice(-8);
    for (const e of evs) log('LOL ev', e.startTime, e.league?.name, e.match?.id, e.match?.teams?.map(t => t.name + ':' + t.code + ':' + t.result?.gameWins).join(' v '));
    const kt = evs.find(e => /KT|Vitality/i.test(j(e.match?.teams))) || evs[evs.length - 1];
    const d = await axios.get('https://esports-api.lolesports.com/persisted/gw/getEventDetails', { params: { hl: 'en-US', id: kt.match.id }, headers: H });
    const games = d.data.data.event.match.games;
    log('games', j(games).slice(0, 600));
    const g = games.find(g => g.state === 'completed');
    for (const q of ['', '?startingTime=' + new Date(Math.floor((Date.parse(kt.startTime) + 3 * 3600e3) / 10000) * 10000).toISOString()]) {
      try {
        const w = await axios.get(`https://feed.lolesports.com/livestats/v1/window/${g.id}${q}`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const f = w.data.frames || [];
        log('window', q, w.status, 'frames', f.length, 'first', f[0]?.rfc460Timestamp, 'last', f.at(-1)?.rfc460Timestamp, f.at(-1)?.gameState);
        log(' meta', j(w.data.gameMetadata?.blueTeamMetadata?.participantMetadata?.slice(0, 2)));
        log(' lastframe blue', j(f.at(-1)?.blueTeam).slice(0, 700));
      } catch (e) { log('window err', q, e.response?.status, e.message); }
    }
    try {
      const det = await axios.get(`https://feed.lolesports.com/livestats/v1/details/${g.id}`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      log('details', j(det.data).slice(0, 600));
    } catch (e) { log('details err', e.response?.status); }
  } catch (e) { log('LOL fail', e.response?.status, e.message); }

  // 2. Kalshi: sports series that look like player props
  try {
    const r = await axios.get('https://api.elections.kalshi.com/trade-api/v2/series', { params: { category: 'Sports' } });
    const all = r.data.series || [];
    log('\nKalshi sports series', all.length);
    const ours = ['KXMLBKS','KXMLBHITS','KXMLBTB','KXMLBHR','KXMLBRBI','KXNFLRECYDS','KXNFLRSHYDS','KXNFLPASSYDS','KXNFLREC','KXNFLPASSTDS','KXNBAPTS','KXNBAREB','KXNBAAST','KXNBA3PT','KXWNBAPTS','KXWNBAREB','KXWNBAAST','KXNHLGOAL','KXNHLSOG','KXNHLPTS','KXNHLAST'];
    const propish = all.filter(s => /yard|points|rebound|assist|strikeout|hits|home run|goal|shots|touchdown|reception|three|pra|saves|kills|total bases|rbi|steals|blocks|passing|rushing|receiving|player/i.test(s.title || '') && !/game|match|winner|champion|mvp|award|draft|season|series|total points$/i.test(s.title || ''));
    for (const s of propish) log(' S', s.ticker, '|', s.title, ours.includes(s.ticker) ? '(ours)' : '');
    for (const t of ours) if (!all.some(s => s.ticker === t)) log(' MISSING', t);
  } catch (e) { log('Kalshi series fail', e.response?.status, e.message); }
  // count open events for ours + candidates
  for (const t of ['KXMLBKS','KXNFLRECYDS','KXNFLRSHYDS','KXNFLPASSYDS','KXNFLREC','KXNFLPASSTDS','KXNFLANYTD','KXNBAPTS','KXNBAREB','KXNBAAST','KXNBA3PT','KXNHLGOAL','KXNHLSOG','KXNHLPTS','KXNHLAST','KXNFLTD','KXNFLRUSHYDS','KXNBAPRA','KXNCAAFPASSYDS','KXNCAAFRSHYDS','KXNCAAFRECYDS']) {
    try { const r = await axios.get('https://api.elections.kalshi.com/trade-api/v2/events', { params: { series_ticker: t, status: 'open', with_nested_markets: true, limit: 200 } });
      const evs = r.data.events || []; const mk = evs.flatMap(e => e.markets || []);
      log(' E', t, 'events', evs.length, 'markets', mk.length, 'quoted', mk.filter(m => +m.yes_bid_dollars > 0 && +m.yes_ask_dollars < 1).length, mk[0] ? j({ t: mk[0].title, fs: mk[0].floor_strike, st: mk[0].strike_type, exp: mk[0].expected_expiration_time }) : '');
    } catch (e) { log(' E', t, 'err', e.response?.status); }
    await new Promise(r => setTimeout(r, 250));
  }
  // 3. Dota Rain
  try { const p = (await axios.get('https://api.opendota.com/api/proPlayers')).data.filter(p => /^rain$/i.test(p.name || '') || /^rain$/i.test(p.personaname || ''));
    log('\nDOTA Rain', j(p.map(x => [x.account_id, x.name, x.team_name, x.last_match_time])));
    for (const x of p.slice(0, 2)) { const m = (await axios.get(`https://api.opendota.com/api/players/${x.account_id}/matches`, { params: { date: 2, significant: 0 } })).data; log(' matches', x.account_id, m.length, j(m.slice(0, 3).map(g => [new Date(g.start_time * 1000).toISOString(), g.kills, g.lobby_type]))); }
  } catch (e) { log('dota fail', e.message); }
  // 4. bo3: a parsed and unparsed match detail
  try { const r = await axios.get('https://api.bo3.gg/api/v1/matches/nuclear-tigeres-vs-xi-esport-12-10-2026', { headers: { origin: 'https://bo3.gg', referer: 'https://bo3.gg/', 'User-Agent': 'Mozilla/5.0' } }); log('\nbo3 unparsed', j({ ps: r.data.parsed_status, tier: r.data.tier, tr: r.data.tier_rank })); } catch (e) { log('bo3 det', e.response?.status); }
  try { const r = await axios.get('https://api.bo3.gg/api/v1/matches/vitality-vs-mouz-cs2-11-10-2026', { headers: { origin: 'https://bo3.gg', referer: 'https://bo3.gg/', 'User-Agent': 'Mozilla/5.0' } }); log('bo3 parsed', j({ ps: r.data.parsed_status, tier: r.data.tier, tr: r.data.tier_rank })); } catch (e) { log('bo3 det', e.response?.status); }
})();
