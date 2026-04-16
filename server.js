require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cron = require('node-cron');
 
const app = express();
const PORT = process.env.PORT || 3001;
 
const ODDS_API_KEY = process.env.ODDS_API_KEY || 'f67774f673842b08fa547e41cf37178c';
const OWLS_API_KEY = process.env.OWLS_API_KEY || 'owlsinsight_3e409488d45a4a1019da9b52702b407dfbf87c1c5a44484aa00bd5f93da7fec2';
const OWLS_HEADERS = { 'X-API-Key': OWLS_API_KEY };
 
app.use(cors({ origin: '*' }));
app.use(express.json());
 
// ─── CACHE ────────────────────────────────────────────────────────────────────
let cache = {
  prizepicks: { data: [], updated: null },
  underdog: { data: [], updated: null },
  sleeper: { data: [], updated: null },
  odds: {},
  owlsProps: {},
  oddsApiProps: {},
  owlsOdds: {},
  splits: {},
  lineHistory: {},
  oddsSnapshot: {},
  sharpMoves: [],
};
 
// ─── ODDS API PROP MARKETS ────────────────────────────────────────────────────
const SPORT_PROP_MARKETS = {
  basketball_nba: [
    'player_points','player_rebounds','player_assists','player_threes',
    'player_points_rebounds_assists','player_points_rebounds','player_points_assists',
    'player_steals','player_blocks',
  ],
  baseball_mlb: [
    'batter_home_runs','batter_hits','batter_total_bases','batter_rbis',
    'batter_runs_scored','pitcher_strikeouts','pitcher_outs','batter_stolen_bases',
  ],
  icehockey_nhl: [
    'player_points','player_goals','player_assists','player_shots_on_goal','player_blocked_shots',
  ],
  americanfootball_nfl: [
    'player_pass_yds','player_pass_tds','player_rush_yds','player_reception_yds','player_receptions',
  ],
};
 
const PROP_BOOKS = 'draftkings,fanduel,betmgm,caesars,bet365,pinnacle,novig,bovada,betonlineag,lowvig,betrivers,pointsbetus';
 
// ─── ODDS API PLAYER PROPS ────────────────────────────────────────────────────
async function fetchOddsApiProps(sportKey) {
  const markets = SPORT_PROP_MARKETS[sportKey];
  if (!markets) return [];
 
  try {
    // Get all events
    const eventsRes = await axios.get(`https://api.the-odds-api.com/v4/sports/${sportKey}/events`, {
      params: { apiKey: ODDS_API_KEY }, timeout: 10000
    });
    const events = eventsRes.data || [];
    if (!events.length) return [];
 
    const allProps = [];
    // Only next 6 events to conserve quota
    for (const event of events.slice(0, 6)) {
      try {
        // Batch 1: first 4 markets
        const res = await axios.get(
          `https://api.the-odds-api.com/v4/sports/${sportKey}/events/${event.id}/odds`, {
          params: {
            apiKey: ODDS_API_KEY, regions: 'us',
            markets: markets.slice(0, 4).join(','),
            oddsFormat: 'american', bookmakers: PROP_BOOKS,
          },
          timeout: 12000
        });
 
        const data = res.data;
        if (!data?.bookmakers?.length) continue;
 
        const gameObj = {
          sport: sportKey, id: event.id,
          home_team: event.home_team, away_team: event.away_team,
          commence_time: event.commence_time, books: [],
        };
 
        for (const bm of data.bookmakers) {
          const bookProps = [];
          for (const market of (bm.markets || [])) {
            for (const o of (market.outcomes || [])) {
              if (o.description === 'Over' || (!o.description && o.point != null)) {
                const under = market.outcomes.find(u => u.name === o.name && u.description === 'Under');
                bookProps.push({
                  player: o.name, market: market.key, line: o.point,
                  overPrice: o.price, underPrice: under?.price ?? null,
                });
              }
            }
          }
          if (bookProps.length) gameObj.books.push({ key: bm.key, title: bm.title, props: bookProps });
        }
 
        if (gameObj.books.length) allProps.push(gameObj);
 
        // Batch 2: remaining markets
        if (markets.length > 4) {
          await new Promise(r => setTimeout(r, 300));
          try {
            const res2 = await axios.get(
              `https://api.the-odds-api.com/v4/sports/${sportKey}/events/${event.id}/odds`, {
              params: {
                apiKey: ODDS_API_KEY, regions: 'us',
                markets: markets.slice(4).join(','),
                oddsFormat: 'american', bookmakers: PROP_BOOKS,
              }, timeout: 12000
            });
            if (res2.data?.bookmakers?.length) {
              for (const bm of res2.data.bookmakers) {
                let eb = gameObj.books.find(b => b.key === bm.key);
                if (!eb) { eb = { key: bm.key, title: bm.title, props: [] }; gameObj.books.push(eb); }
                for (const market of (bm.markets || [])) {
                  for (const o of (market.outcomes || [])) {
                    if (o.description === 'Over' || (!o.description && o.point != null)) {
                      const under = market.outcomes.find(u => u.name === o.name && u.description === 'Under');
                      eb.props.push({ player: o.name, market: market.key, line: o.point, overPrice: o.price, underPrice: under?.price ?? null });
                    }
                  }
                }
              }
            }
          } catch(e2) { /* ignore */ }
        }
      } catch(e) {
        if (e.response?.status !== 422) console.warn(`OddsAPI props event ${event.id}:`, e.response?.status);
      }
      await new Promise(r => setTimeout(r, 400));
    }
 
    cache.oddsApiProps[sportKey] = { data: allProps, updated: new Date().toISOString() };
    const total = allProps.reduce((s, g) => s + g.books.reduce((s2, b) => s2 + b.props.length, 0), 0);
    console.log(`OddsAPI props ${sportKey}: ${allProps.length} games, ${total} props`);
    return allProps;
  } catch(e) {
    console.warn(`OddsAPI props ${sportKey}:`, e.response?.status, e.message);
    return cache.oddsApiProps[sportKey]?.data || [];
  }
}
 
// ─── DFS SCRAPERS ─────────────────────────────────────────────────────────────
async function scrapePrizePicks() {
  try {
    const res = await axios.get('https://api.prizepicks.com/projections', {
      params: { per_page: 1000, single_stat: true, is_active: true },
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json', 'Origin': 'https://app.prizepicks.com',
        'Referer': 'https://app.prizepicks.com/',
      },
      timeout: 15000
    });
    const data = res.data, players = {}, leagues = {}, allLines = [];
    if (data.included) {
      for (const inc of data.included) {
        if (inc.type === 'new_player') players[inc.id] = { name: inc.attributes.display_name || inc.attributes.name, team: inc.attributes.team || '' };
        if (inc.type === 'league') leagues[inc.id] = inc.attributes.name || '';
      }
    }
    if (data.data) {
      for (const proj of data.data) {
        const attr = proj.attributes;
        const player = players[proj.relationships?.new_player?.data?.id] || {};
        const sport = leagues[proj.relationships?.league?.data?.id] || attr.league || '';
        if (!attr.line_score) continue;
        allLines.push({ book: 'prizepicks', sport, player: player.name || attr.description || '', team: player.team || '', market: attr.stat_type || '', line: parseFloat(attr.line_score), startTime: attr.start_time || '' });
      }
    }
    if (allLines.length > 0) { cache.prizepicks = { data: allLines, updated: new Date().toISOString() }; console.log(`PP: ${allLines.length} lines`); }
  } catch(e) { console.error('PP error:', e.message, e.response?.status); }
}
 
async function scrapeUnderdog() {
  try {
    const res = await axios.get('https://api.underdogfantasy.com/beta/v5/over_under_lines', {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json', 'x-api-key': 'undefined' },
      timeout: 10000
    });
    const data = res.data, players = {}, games = {}, lines = [];
    if (data.players) for (const p of data.players) players[p.id] = { name: p.name || `${p.first_name} ${p.last_name}`, team: p.team_name || '' };
    if (data.games) for (const g of data.games) games[g.id] = { sport: g.sport_id || g.sport, startTime: g.scheduled_at };
    if (data.over_under_lines) {
      for (const line of data.over_under_lines) {
        const app = line.over_under?.appearance_stat;
        const player = players[app?.appearance?.player_id || line.player_id] || {};
        const game = games[app?.appearance?.match_id] || {};
        lines.push({ book: 'underdog', sport: game.sport || '', player: player.name || '', team: player.team || '', market: app?.display_stat || '', line: parseFloat(line.stat_value || 0), startTime: game.startTime || '' });
      }
    }
    cache.underdog = { data: lines, updated: new Date().toISOString() };
    console.log(`UD: ${lines.length} lines`);
  } catch(e) { console.error('UD error:', e.message); }
}
 
// ─── OWLS FETCHERS ────────────────────────────────────────────────────────────
async function fetchOwlsProps(sport) {
  try {
    const res = await axios.get(`https://api.owlsinsight.com/api/v1/${sport}/props`, { headers: OWLS_HEADERS, timeout: 12000 });
    cache.owlsProps[sport] = { data: res.data, updated: new Date().toISOString() };
    console.log(`Owls props ${sport}: ${Array.isArray(res.data) ? res.data.length : '?'} games`);
    return res.data;
  } catch(e) { console.warn(`Owls props ${sport}:`, e.response?.status, e.message); return cache.owlsProps[sport]?.data || null; }
}
 
async function fetchOwlsOdds(sport) {
  try {
    const res = await axios.get(`https://api.owlsinsight.com/api/v1/${sport}/odds`, { headers: OWLS_HEADERS, timeout: 12000 });
    const games = res.data;
    const now = new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' });
    const sharpBooks = ['pinnacle','novig','circa','westgate','wynn','south_point'];
    if (Array.isArray(games)) {
      for (const game of games) {
        const gl = `${(game.away_team||'').split(' ').pop()}@${(game.home_team||'').split(' ').pop()}`;
        for (const bm of (game.bookmakers||[])) {
          const isSharp = sharpBooks.includes(bm.key);
          for (const mkt of (bm.markets||[])) {
            for (const o of (mkt.outcomes||[])) {
              const sk = `${game.id}_${bm.key}_${mkt.key}_${o.name}`;
              const prev = cache.oddsSnapshot[sk], curr = o.price;
              if (curr && prev !== undefined && prev !== curr) {
                const diff = Math.abs(curr-prev);
                if (diff >= 3) cache.sharpMoves.unshift({ id: Date.now()+Math.random(), book: bm.key, sport, game: gl, market: mkt.key, oldOdds: prev, newOdds: curr, side: o.name, timestamp: now, isSharp, diff, direction: curr>prev?'up':'down' });
              }
              if (curr) cache.oddsSnapshot[sk] = curr;
            }
          }
        }
      }
      if (cache.sharpMoves.length > 500) cache.sharpMoves = cache.sharpMoves.slice(0, 500);
    }
    cache.owlsOdds[sport] = { data: games, updated: new Date().toISOString() };
    return games;
  } catch(e) { console.warn(`Owls odds ${sport}:`, e.response?.status, e.message); return cache.owlsOdds[sport]?.data || null; }
}
 
async function fetchOwlsSplits(sport) {
  try {
    const res = await axios.get(`https://api.owlsinsight.com/api/v1/${sport}/splits`, { headers: OWLS_HEADERS, timeout: 10000 });
    cache.splits[sport] = { data: res.data, updated: new Date().toISOString() };
    return res.data;
  } catch(e) { return cache.splits[sport]?.data || null; }
}
 
async function fetchOddsForSport(sport) {
  try {
    const res = await axios.get(`https://api.the-odds-api.com/v4/sports/${sport}/odds/`, {
      params: { apiKey: ODDS_API_KEY, regions: 'us', markets: 'h2h,spreads,totals', oddsFormat: 'american' }, timeout: 10000
    });
    cache.odds[sport] = { data: res.data, updated: new Date().toISOString() };
    return res.data;
  } catch(e) { return cache.odds[sport]?.data || []; }
}
 
// ─── MERGE HELPER ─────────────────────────────────────────────────────────────
function mergeProps(owlsData, oddsApiData) {
  const merged = Array.isArray(owlsData) ? [...owlsData] : [];
  if (Array.isArray(oddsApiData)) {
    for (const og of oddsApiData) {
      const ex = merged.find(g => g.home_team === og.home_team && g.away_team === og.away_team);
      if (ex) {
        const eks = new Set((ex.books||[]).map(b=>b.key));
        for (const b of (og.books||[])) if (!eks.has(b.key)) { ex.books = ex.books||[]; ex.books.push(b); }
      } else { merged.push(og); }
    }
  }
  return merged;
}
 
// ─── ROUTES ───────────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({ status: 'Line Reaper backend running', version: '3.0.0', updated: new Date().toISOString() }));
 
app.get('/api/prizepicks', (req, res) => {
  const sport = req.query.sport;
  let data = cache.prizepicks.data || [];
  if (sport) data = data.filter(l => l.sport.toLowerCase() === sport.toLowerCase());
  res.json({ data, updated: cache.prizepicks.updated, count: data.length });
});
 
app.get('/api/underdog', (req, res) => {
  const sport = req.query.sport;
  let data = cache.underdog.data || [];
  if (sport) data = data.filter(l => (l.sport||'').toLowerCase() === sport.toLowerCase());
  res.json({ data, updated: cache.underdog.updated, count: data.length });
});
 
app.get('/api/sleeper', (req, res) => res.json({ data: cache.sleeper.data || [] }));
 
// ── MAIN PROPS — merges Owls + Odds API for 24/7 coverage ────────────────────
app.get('/api/props/:sport', async (req, res) => {
  const sport = req.params.sport;
  const oddsApiMap = { nba:'basketball_nba', mlb:'baseball_mlb', nhl:'icehockey_nhl', nfl:'americanfootball_nfl', mma:'mma_mixed_martial_arts', basketball_nba:'basketball_nba', baseball_mlb:'baseball_mlb', icehockey_nhl:'icehockey_nhl', americanfootball_nfl:'americanfootball_nfl' };
  const oddsKey = oddsApiMap[sport] || sport;
 
  // Owls props (Pinnacle/Novig sharp lines)
  let owls = cache.owlsProps[sport]?.data;
  const owlsFresh = cache.owlsProps[sport]?.updated && (Date.now()-new Date(cache.owlsProps[sport].updated).getTime()) < 300000;
  if (!owlsFresh) owls = await fetchOwlsProps(sport);
 
  // Odds API props (24/7 DK/FD/MGM/Caesars for all upcoming games)
  let oddsApi = cache.oddsApiProps[oddsKey]?.data;
  const oddsApiFresh = cache.oddsApiProps[oddsKey]?.updated && (Date.now()-new Date(cache.oddsApiProps[oddsKey].updated).getTime()) < 600000;
  if (!oddsApiFresh) oddsApi = await fetchOddsApiProps(oddsKey);
 
  const merged = mergeProps(owls, oddsApi);
  const total = merged.reduce((s,g)=>s+g.books.reduce((s2,b)=>s2+b.props.length,0),0);
  console.log(`Props ${sport}: ${merged.length} games, ${total} props`);
  res.json(merged);
});
 
// All sports props combined
app.get('/api/props', async (req, res) => {
  const sports = ['nba','mlb','nhl','nfl'];
  const oddsMap = { nba:'basketball_nba', mlb:'baseball_mlb', nhl:'icehockey_nhl', nfl:'americanfootball_nfl' };
  const result = {};
  for (const s of sports) {
    result[s] = mergeProps(cache.owlsProps[s]?.data, cache.oddsApiProps[oddsMap[s]]?.data);
  }
  res.json(result);
});
 
app.get('/api/owls-odds/:sport', async (req, res) => {
  const sport = req.params.sport;
  const c = cache.owlsOdds[sport];
  if (c?.updated && (Date.now()-new Date(c.updated).getTime()) < 30000) return res.json(c.data);
  res.json(await fetchOwlsOdds(sport) || []);
});
 
app.get('/api/sharp-moves', (req, res) => {
  res.json({ moves: cache.sharpMoves.slice(0, parseInt(req.query.limit)||100), count: cache.sharpMoves.length, updated: new Date().toISOString() });
});
app.delete('/api/sharp-moves', (req, res) => { cache.sharpMoves = []; res.json({ ok: true }); });
 
app.get('/api/splits/:sport', async (req, res) => res.json(await fetchOwlsSplits(req.params.sport) || {}));
app.get('/api/odds/:sport', async (req, res) => res.json(await fetchOddsForSport(req.params.sport)));
 
app.get('/api/owls/*', async (req, res) => {
  const path = req.params[0], query = new URLSearchParams(req.query).toString();
  try {
    const r = await axios.get(`https://api.owlsinsight.com/api/v1/${path}${query?'?'+query:''}`, { headers: OWLS_HEADERS, timeout: 10000 });
    res.json(r.data);
  } catch(e) { res.status(e.response?.status||500).json({ error: e.message }); }
});
 
app.post('/api/history/record', (req, res) => {
  const { player, market, line, book, odds, timestamp } = req.body;
  const key = `${player}|${market}`;
  if (!cache.lineHistory[key]) cache.lineHistory[key] = [];
  cache.lineHistory[key].push({ line, book, odds, timestamp: timestamp || new Date().toISOString() });
  if (cache.lineHistory[key].length > 50) cache.lineHistory[key] = cache.lineHistory[key].slice(-50);
  res.json({ ok: true });
});
app.get('/api/history/:player', (req, res) => res.json(cache.lineHistory[`${decodeURIComponent(req.params.player)}|${req.query.market}`] || []));
 
app.get('/api/status', (req, res) => res.json({
  prizepicks: { count: cache.prizepicks.data?.length||0, updated: cache.prizepicks.updated },
  underdog: { count: cache.underdog.data?.length||0, updated: cache.underdog.updated },
  sharpMoves: cache.sharpMoves.length,
  owlsProps: Object.entries(cache.owlsProps).map(([k,v])=>`${k}:${Array.isArray(v.data)?v.data.length:0}`).join(', ') || 'none',
  oddsApiProps: Object.entries(cache.oddsApiProps).map(([k,v])=>`${k}:${Array.isArray(v.data)?v.data.length:0}`).join(', ') || 'none',
}));
 
// ─── CRON JOBS ────────────────────────────────────────────────────────────────
cron.schedule('*/2 * * * *', async () => { await Promise.all([scrapePrizePicks(), scrapeUnderdog()]); });
cron.schedule('*/30 * * * * *', async () => { for (const s of ['nba','mlb','nhl','nfl','mma']) fetchOwlsOdds(s); });
cron.schedule('*/5 * * * *', async () => { for (const s of ['nba','mlb','nhl','nfl','mma']) fetchOwlsProps(s); });
// Stagger OddsAPI prop fetches to conserve quota
cron.schedule('0,15,30,45 * * * *', () => fetchOddsApiProps('basketball_nba'));
cron.schedule('3,18,33,48 * * * *', () => fetchOddsApiProps('baseball_mlb'));
cron.schedule('6,21,36,51 * * * *', () => fetchOddsApiProps('icehockey_nhl'));
cron.schedule('9,24,39,54 * * * *', () => fetchOddsApiProps('americanfootball_nfl'));
cron.schedule('*/3 * * * *', async () => { for (const s of ['basketball_nba','baseball_mlb','icehockey_nhl','americanfootball_nfl']) fetchOddsForSport(s); });
 
// ─── START ────────────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`Line Reaper v3 on port ${PORT}`);
  await Promise.all([scrapePrizePicks(), scrapeUnderdog()]);
  for (const s of ['nba','mlb','nhl','nfl']) { fetchOwlsProps(s); fetchOwlsOdds(s); }
  // Stagger OddsAPI prop fetches on startup
  setTimeout(() => fetchOddsApiProps('basketball_nba'), 3000);
  setTimeout(() => fetchOddsApiProps('baseball_mlb'), 7000);
  setTimeout(() => fetchOddsApiProps('icehockey_nhl'), 11000);
  setTimeout(() => fetchOddsApiProps('americanfootball_nfl'), 15000);
  console.log('Startup complete');
});
