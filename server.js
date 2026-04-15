require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cron = require('node-cron');
 
const app = express();
const PORT = process.env.PORT || 3001;
 
const ODDS_API_KEY = process.env.ODDS_API_KEY || 'f67774f673842b08fa547e41cf37178c';
const OWLS_API_KEY = process.env.OWLS_API_KEY || 'owlsinsight_1e9dfc3a29f37d639fb5b641ba7b2a24535d5e06b074713e88b2b1b19516b23b';
 
// ── CORRECT AUTH HEADER ──
const OWLS_HEADERS = { 'X-API-Key': OWLS_API_KEY };
 
app.use(cors({ origin: '*' }));
app.use(express.json());
 
// ─── CACHE ────────────────────────────────────────────────────────────────────
let cache = {
  prizepicks: { data: null, updated: null },
  underdog: { data: null, updated: null },
  sleeper: { data: null, updated: null },
  odds: {},
  owlsProps: {},
  owlsOdds: {},   // cached Owls odds per sport for sharp move diffing
  splits: {},
  lineHistory: {},
  oddsSnapshot: {}, // previous odds for diff-based sharp move detection
  sharpMoves: [],   // detected line moves
};
 
// ─── PRIZEPICKS SCRAPER ───────────────────────────────────────────────────────
async function scrapePrizePicks() {
  try {
    const allLines = [];
    const res = await axios.get('https://api.prizepicks.com/projections', {
      params: { per_page: 1000, single_stat: true, is_active: true },
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Origin': 'https://app.prizepicks.com',
        'Referer': 'https://app.prizepicks.com/',
      },
      timeout: 15000
    });
 
    const data = res.data;
    const players = {};
    const leagues = {};
 
    if (data.included) {
      for (const inc of data.included) {
        if (inc.type === 'new_player') {
          players[inc.id] = {
            name: inc.attributes.display_name || inc.attributes.name,
            team: inc.attributes.team || inc.attributes.team_name || '',
            position: inc.attributes.position || ''
          };
        }
        if (inc.type === 'league') {
          leagues[inc.id] = inc.attributes.name || inc.attributes.league || '';
        }
      }
    }
 
    if (data.data) {
      for (const proj of data.data) {
        const attr = proj.attributes;
        const playerId = proj.relationships?.new_player?.data?.id;
        const leagueId = proj.relationships?.league?.data?.id;
        const player = players[playerId] || {};
        const sport = leagues[leagueId] || attr.league || '';
        if (!attr.line_score) continue;
        allLines.push({
          book: 'prizepicks', sport,
          player: player.name || attr.description || '',
          team: player.team || '', position: player.position || '',
          market: attr.stat_type || attr.stat || '',
          line: parseFloat(attr.line_score),
          startTime: attr.start_time || '',
          isPromo: attr.is_promo || false,
          flash: attr.flash_sale_line_score || null,
        });
      }
    }
 
    if (allLines.length > 0) {
      cache.prizepicks = { data: allLines, updated: new Date().toISOString() };
      console.log(`PrizePicks: ${allLines.length} lines scraped`);
    }
  } catch (e) {
    console.error('PrizePicks scrape error:', e.message, e.response?.status);
  }
}
 
// ─── UNDERDOG SCRAPER ─────────────────────────────────────────────────────────
async function scrapeUnderdog() {
  try {
    const res = await axios.get('https://api.underdogfantasy.com/beta/v5/over_under_lines', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Accept': 'application/json', 'x-api-key': 'undefined' },
      timeout: 10000
    });
 
    const data = res.data;
    const players = {};
    const games = {};
    const lines = [];
 
    if (data.players) {
      for (const p of data.players) {
        players[p.id] = { name: p.name || `${p.first_name} ${p.last_name}`, team: p.team_name || p.team || '' };
      }
    }
    if (data.games) {
      for (const g of data.games) {
        games[g.id] = { sport: g.sport_id || g.sport, startTime: g.scheduled_at };
      }
    }
 
    if (data.over_under_lines) {
      for (const line of data.over_under_lines) {
        const app = line.over_under?.appearance_stat;
        const playerId = app?.appearance?.player_id || line.player_id;
        const player = players[playerId] || {};
        const game = games[line.over_under?.appearance_stat?.appearance?.match_id] || {};
        lines.push({
          book: 'underdog', sport: game.sport || line.sport || '',
          player: player.name || '', team: player.team || '',
          market: app?.display_stat || line.stat_value || '',
          line: parseFloat(line.stat_value || line.over_under?.stat_value || 0),
          startTime: game.startTime || '', id: line.id
        });
      }
    }
 
    cache.underdog = { data: lines, updated: new Date().toISOString() };
    console.log(`Underdog: ${lines.length} lines scraped`);
  } catch (e) {
    console.error('Underdog scrape error:', e.message);
  }
}
 
// ─── SLEEPER SCRAPER ──────────────────────────────────────────────────────────
async function scrapeSleeper() {
  try {
    const sports = ['nba', 'nfl'];
    const allLines = [];
    for (const sport of sports) {
      try {
        const res = await axios.get(`https://api.sleeper.com/projections/${sport}/2026/regular?season_type=regular&position[]=QB&position[]=RB&position[]=WR&position[]=TE&position[]=SF&position[]=PF&position[]=C&position[]=PG&position[]=SG`, {
          headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 8000
        });
        if (Array.isArray(res.data)) {
          for (const proj of res.data) {
            for (const [stat, val] of Object.entries(proj.stats || {})) {
              if (val > 0) allLines.push({ book: 'sleeper', sport: sport.toUpperCase(), player: proj.player_id || '', market: stat, line: val });
            }
          }
        }
      } catch (e) { console.warn(`Sleeper ${sport}:`, e.message); }
    }
    cache.sleeper = { data: allLines, updated: new Date().toISOString() };
    console.log(`Sleeper: ${allLines.length} lines scraped`);
  } catch (e) { console.error('Sleeper scrape error:', e.message); }
}
 
// ─── OWLS FETCHERS ────────────────────────────────────────────────────────────
async function fetchOwlsProps(sport) {
  try {
    const res = await axios.get(`https://api.owlsinsight.com/api/v1/${sport}/props`, {
      headers: OWLS_HEADERS, timeout: 12000
    });
    cache.owlsProps[sport] = { data: res.data, updated: new Date().toISOString() };
    console.log(`Owls props ${sport}: OK (${Array.isArray(res.data) ? res.data.length : '?'} games)`);
    return res.data;
  } catch (e) {
    console.warn(`Owls props ${sport}:`, e.response?.status, e.message);
    return cache.owlsProps[sport]?.data || null;
  }
}
 
async function fetchOwlsOdds(sport) {
  try {
    const res = await axios.get(`https://api.owlsinsight.com/api/v1/${sport}/odds`, {
      headers: OWLS_HEADERS, timeout: 12000
    });
    const games = res.data;
 
    // Diff against snapshot to detect line moves
    const now = new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' });
    const sharpBooks = ['pinnacle', 'novig', 'circa', 'westgate', 'wynn', 'south_point'];
 
    if (Array.isArray(games)) {
      for (const game of games) {
        const gl = `${(game.away_team || '').split(' ').pop()}@${(game.home_team || '').split(' ').pop()}`;
        for (const bm of (game.bookmakers || [])) {
          const isSharp = sharpBooks.includes(bm.key);
          for (const mkt of (bm.markets || [])) {
            for (const o of (mkt.outcomes || [])) {
              const snapKey = `${game.id}_${bm.key}_${mkt.key}_${o.name}`;
              const prev = cache.oddsSnapshot[snapKey];
              const curr = o.price;
              if (curr && prev !== undefined && prev !== curr) {
                const diff = Math.abs(curr - prev);
                if (diff >= 3) {
                  cache.sharpMoves.unshift({
                    id: Date.now() + Math.random(), book: bm.key,
                    sport, game: gl, market: mkt.key,
                    oldOdds: prev, newOdds: curr, side: o.name,
                    timestamp: now, isSharp, diff,
                    direction: curr > prev ? 'up' : 'down'
                  });
                }
              }
              if (curr) cache.oddsSnapshot[snapKey] = curr;
            }
          }
        }
      }
      if (cache.sharpMoves.length > 500) cache.sharpMoves = cache.sharpMoves.slice(0, 500);
    }
 
    cache.owlsOdds[sport] = { data: games, updated: new Date().toISOString() };
    return games;
  } catch (e) {
    console.warn(`Owls odds ${sport}:`, e.response?.status, e.message);
    return cache.owlsOdds[sport]?.data || null;
  }
}
 
async function fetchOwlsSplits(sport) {
  try {
    const res = await axios.get(`https://api.owlsinsight.com/api/v1/${sport}/splits`, {
      headers: OWLS_HEADERS, timeout: 10000
    });
    cache.splits[sport] = { data: res.data, updated: new Date().toISOString() };
    return res.data;
  } catch (e) {
    console.warn(`Owls splits ${sport}:`, e.message);
    return cache.splits[sport]?.data || null;
  }
}
 
// ─── ODDS API PROXY ───────────────────────────────────────────────────────────
async function fetchOddsForSport(sport) {
  try {
    const res = await axios.get(`https://api.the-odds-api.com/v4/sports/${sport}/odds/`, {
      params: { apiKey: ODDS_API_KEY, regions: 'us', markets: 'h2h,spreads,totals', oddsFormat: 'american' },
      timeout: 10000
    });
    cache.odds[sport] = { data: res.data, updated: new Date().toISOString() };
    return res.data;
  } catch (e) {
    console.warn(`Odds ${sport}:`, e.message);
    return cache.odds[sport]?.data || [];
  }
}
 
// ─── ROUTES ───────────────────────────────────────────────────────────────────
 
app.get('/', (req, res) => {
  res.json({ status: 'Line Reaper backend running', version: '2.0.0', updated: new Date().toISOString() });
});
 
// DFS lines
app.get('/api/prizepicks', (req, res) => {
  const sport = req.query.sport;
  let data = cache.prizepicks.data || [];
  if (sport) data = data.filter(l => l.sport.toLowerCase() === sport.toLowerCase());
  res.json({ data, updated: cache.prizepicks.updated, count: data.length });
});
 
app.get('/api/underdog', (req, res) => {
  const sport = req.query.sport;
  let data = cache.underdog.data || [];
  if (sport) data = data.filter(l => (l.sport || '').toLowerCase() === sport.toLowerCase());
  res.json({ data, updated: cache.underdog.updated, count: data.length });
});
 
app.get('/api/sleeper', (req, res) => {
  res.json({ data: cache.sleeper.data || [], updated: cache.sleeper.updated });
});
 
app.get('/api/dfs', (req, res) => {
  const sport = req.query.sport || 'NBA';
  const pp = (cache.prizepicks.data || []).filter(l => l.sport.toLowerCase() === sport.toLowerCase());
  const ud = (cache.underdog.data || []).filter(l => (l.sport || '').toLowerCase().includes(sport.toLowerCase()));
  res.json({ prizepicks: pp, underdog: ud, updated: new Date().toISOString() });
});
 
// Owls props — server-side proxy, no CORS
app.get('/api/props/:sport', async (req, res) => {
  const sport = req.params.sport;
  // Return cache if fresh (< 2 min)
  const cached = cache.owlsProps[sport];
  if (cached && cached.updated && (Date.now() - new Date(cached.updated).getTime()) < 120000) {
    return res.json(cached.data);
  }
  const data = await fetchOwlsProps(sport);
  res.json(data || []);
});
 
// Owls odds — server-side proxy
app.get('/api/owls-odds/:sport', async (req, res) => {
  const sport = req.params.sport;
  const cached = cache.owlsOdds[sport];
  if (cached && cached.updated && (Date.now() - new Date(cached.updated).getTime()) < 30000) {
    return res.json(cached.data);
  }
  const data = await fetchOwlsOdds(sport);
  res.json(data || []);
});
 
// Sharp moves detected by server-side diffing
app.get('/api/sharp-moves', (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  res.json({ moves: cache.sharpMoves.slice(0, limit), count: cache.sharpMoves.length, updated: new Date().toISOString() });
});
 
// Clear sharp moves
app.delete('/api/sharp-moves', (req, res) => {
  cache.sharpMoves = [];
  res.json({ ok: true });
});
 
// Owls splits (public betting %)
app.get('/api/splits/:sport', async (req, res) => {
  const data = await fetchOwlsSplits(req.params.sport);
  res.json(data || { error: 'No data' });
});
 
// Odds API proxy
app.get('/api/odds/:sport', async (req, res) => {
  const data = await fetchOddsForSport(req.params.sport);
  res.json(data);
});
 
// Generic Owls proxy
app.get('/api/owls/*', async (req, res) => {
  const path = req.params[0];
  const query = new URLSearchParams(req.query).toString();
  const url = `https://api.owlsinsight.com/api/v1/${path}${query ? '?' + query : ''}`;
  try {
    const result = await axios.get(url, { headers: OWLS_HEADERS, timeout: 10000 });
    res.json(result.data);
  } catch (e) {
    res.status(e.response?.status || 500).json({ error: e.message, status: e.response?.status });
  }
});
 
// Line history
app.post('/api/history/record', (req, res) => {
  const { player, market, line, book, odds, timestamp } = req.body;
  const key = `${player}|${market}`;
  if (!cache.lineHistory[key]) cache.lineHistory[key] = [];
  cache.lineHistory[key].push({ line, book, odds, timestamp: timestamp || new Date().toISOString() });
  if (cache.lineHistory[key].length > 50) cache.lineHistory[key] = cache.lineHistory[key].slice(-50);
  res.json({ ok: true });
});
 
app.get('/api/history/:player', (req, res) => {
  const key = `${decodeURIComponent(req.params.player)}|${req.query.market}`;
  res.json(cache.lineHistory[key] || []);
});
 
app.get('/api/status', (req, res) => {
  res.json({
    prizepicks: { count: cache.prizepicks.data?.length || 0, updated: cache.prizepicks.updated },
    underdog: { count: cache.underdog.data?.length || 0, updated: cache.underdog.updated },
    sleeper: { count: cache.sleeper.data?.length || 0, updated: cache.sleeper.updated },
    sharpMoves: cache.sharpMoves.length,
    oddsCache: Object.keys(cache.odds).length + ' sports',
    owlsOdds: Object.keys(cache.owlsOdds).length + ' sports',
    owlsProps: Object.keys(cache.owlsProps).join(', ') || 'none',
  });
});
 
// ─── SCHEDULED JOBS ───────────────────────────────────────────────────────────
 
// DFS every 2 min
cron.schedule('*/2 * * * *', async () => {
  console.log('Scraping DFS books...');
  await Promise.all([scrapePrizePicks(), scrapeUnderdog()]);
});
 
// Sleeper every 5 min
cron.schedule('*/5 * * * *', () => scrapeSleeper());
 
// Odds API every 3 min
cron.schedule('*/3 * * * *', async () => {
  for (const s of ['basketball_nba', 'baseball_mlb', 'icehockey_nhl', 'americanfootball_nfl']) {
    await fetchOddsForSport(s);
  }
});
 
// Owls props every 4 min — server caches, frontend calls /api/props/:sport
cron.schedule('*/4 * * * *', async () => {
  for (const s of ['nba', 'mlb', 'nhl', 'nfl', 'mma']) {
    await fetchOwlsProps(s);
  }
});
 
// Owls odds every 30s for sharp move detection — this is the engine
cron.schedule('*/30 * * * * *', async () => {
  for (const s of ['nba', 'mlb', 'nhl', 'nfl', 'mma']) {
    await fetchOwlsOdds(s);
  }
});
 
// ─── START ────────────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`Line Reaper backend v2 running on port ${PORT}`);
  await Promise.all([scrapePrizePicks(), scrapeUnderdog(), scrapeSleeper()]);
  // Start Owls caching immediately
  for (const s of ['nba', 'mlb', 'nhl', 'nfl']) {
    fetchOwlsProps(s);
    fetchOwlsOdds(s);
  }
  console.log('Initial scrape complete');
});
 
