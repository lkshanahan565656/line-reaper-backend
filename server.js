require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 3001;

const ODDS_API_KEY = process.env.ODDS_API_KEY || 'f67774f673842b08fa547e41cf37178c';
const OWLS_API_KEY = process.env.OWLS_API_KEY || 'owlsinsight_1e9dfc3a29f37d639fb5b641ba7b2a24535d5e06b074713e88b2b1b19516b23b';

app.use(cors({ origin: '*' }));
app.use(express.json());

// ─── CACHE ────────────────────────────────────────────────────────────────────
let cache = {
  prizepicks: { data: null, updated: null },
  underdog: { data: null, updated: null },
  sleeper: { data: null, updated: null },
  odds: {},
  owlsProps: {},
  splits: {},
  lineHistory: {},
};

// ─── PRIZEPICKS SCRAPER ───────────────────────────────────────────────────────
async function scrapePrizePicks() {
  try {
    const allLines = [];

    // PrizePicks API - fetch all active projections at once
    const res = await axios.get('https://api.prizepicks.com/projections', {
      params: {
        per_page: 1000,
        single_stat: true,
        is_active: true
      },
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Origin': 'https://app.prizepicks.com',
        'Referer': 'https://app.prizepicks.com/',
        'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="120"',
        'sec-ch-ua-mobile': '?0',
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-site',
        'Connection': 'keep-alive'
      },
      timeout: 15000
    });

    const data = res.data;
    const players = {};
    const leagues = {};

    // Build lookups from included
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
          book: 'prizepicks',
          sport,
          player: player.name || attr.description || '',
          team: player.team || '',
          position: player.position || '',
          market: attr.stat_type || attr.stat || '',
          line: parseFloat(attr.line_score),
          startTime: attr.start_time || '',
          isPromo: attr.is_promo || false,
          flash: attr.flash_sale_line_score || null,
          upcomingGame: attr.description || ''
        });
      }
    }

    if (allLines.length > 0) {
      cache.prizepicks = { data: allLines, updated: new Date().toISOString() };
      console.log(`PrizePicks: ${allLines.length} lines scraped`);
    } else {
      console.warn('PrizePicks: 0 lines returned, keeping old cache');
    }
  } catch (e) {
    console.error('PrizePicks scrape error:', e.message, e.response?.status);
  }
}

function getSportId(sport) {
  const ids = { NBA: 7, MLB: 2, NHL: 12, NFL: 1, NCAAB: 3, NCAAF: 4, PGA: 13, MMA: 9, WNBA: 10 };
  return ids[sport] || 7;
}

// ─── UNDERDOG SCRAPER ─────────────────────────────────────────────────────────
async function scrapeUnderdog() {
  try {
    const res = await axios.get('https://api.underdogfantasy.com/beta/v5/over_under_lines', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
        'x-api-key': 'undefined'
      },
      timeout: 10000
    });

    const data = res.data;
    const players = {};
    const games = {};
    const lines = [];

    // Build lookups
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
          book: 'underdog',
          sport: game.sport || line.sport || '',
          player: player.name || '',
          team: player.team || '',
          market: app?.display_stat || line.stat_value || '',
          line: parseFloat(line.stat_value || line.over_under?.stat_value || 0),
          startTime: game.startTime || '',
          id: line.id
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
    const sports = ['nba', 'mlb', 'nhl', 'nfl'];
    const allLines = [];

    for (const sport of sports) {
      try {
        const res = await axios.get(`https://api.sleeper.com/projections/${sport}/2026/regular?season_type=regular&position[]=QB&position[]=RB&position[]=WR&position[]=TE&position[]=K&position[]=DEF&position[]=SF&position[]=PF&position[]=C&position[]=PG&position[]=SG&position[]=P&position[]=SP&position[]=RP`, {
          headers: { 'User-Agent': 'Mozilla/5.0' },
          timeout: 8000
        });

        // Sleeper projections
        if (Array.isArray(res.data)) {
          for (const proj of res.data) {
            for (const [stat, val] of Object.entries(proj.stats || {})) {
              if (val > 0) {
                allLines.push({
                  book: 'sleeper',
                  sport: sport.toUpperCase(),
                  player: proj.player_id || '',
                  market: stat,
                  line: val
                });
              }
            }
          }
        }
      } catch (e) {
        console.warn(`Sleeper ${sport}:`, e.message);
      }
    }

    cache.sleeper = { data: allLines, updated: new Date().toISOString() };
    console.log(`Sleeper: ${allLines.length} lines scraped`);
  } catch (e) {
    console.error('Sleeper scrape error:', e.message);
  }
}

// ─── ODDS API PROXY ───────────────────────────────────────────────────────────
async function fetchOddsForSport(sport) {
  try {
    const res = await axios.get(`https://api.the-odds-api.com/v4/sports/${sport}/odds/`, {
      params: {
        apiKey: ODDS_API_KEY,
        regions: 'us',
        markets: 'h2h,spreads,totals',
        oddsFormat: 'american'
      },
      timeout: 10000
    });
    cache.odds[sport] = { data: res.data, updated: new Date().toISOString() };
    return res.data;
  } catch (e) {
    console.warn(`Odds ${sport}:`, e.message);
    return cache.odds[sport]?.data || [];
  }
}

// ─── OWLS PROXY ───────────────────────────────────────────────────────────────
async function fetchOwlsProps(sport) {
  try {
    const res = await axios.get(`https://api.owlsinsight.com/api/v1/${sport}/props`, {
      headers: { 'Authorization': `Bearer ${OWLS_API_KEY}` },
      timeout: 10000
    });
    cache.owlsProps[sport] = { data: res.data, updated: new Date().toISOString() };
    return res.data;
  } catch (e) {
    console.warn(`Owls props ${sport}:`, e.message);
    return cache.owlsProps[sport]?.data || null;
  }
}

async function fetchOwlsSplits(sport) {
  try {
    const res = await axios.get(`https://api.owlsinsight.com/api/v1/${sport}/splits`, {
      headers: { 'Authorization': `Bearer ${OWLS_API_KEY}` },
      timeout: 10000
    });
    cache.splits[sport] = { data: res.data, updated: new Date().toISOString() };
    return res.data;
  } catch (e) {
    console.warn(`Owls splits ${sport}:`, e.message);
    return cache.splits[sport]?.data || null;
  }
}

async function fetchOwlsRealtime(sport) {
  try {
    const res = await axios.get(`https://api.owlsinsight.com/api/v1/${sport}/realtime`, {
      headers: { 'Authorization': `Bearer ${OWLS_API_KEY}` },
      timeout: 10000
    });
    return res.data;
  } catch (e) {
    console.warn(`Owls realtime ${sport}:`, e.message);
    return null;
  }
}

// ─── ROUTES ───────────────────────────────────────────────────────────────────

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'Line Reaper backend running', version: '1.0.0', updated: new Date().toISOString() });
});

// PrizePicks lines
app.get('/api/prizepicks', (req, res) => {
  const sport = req.query.sport;
  let data = cache.prizepicks.data || [];
  if (sport) data = data.filter(l => l.sport.toLowerCase() === sport.toLowerCase());
  res.json({ data, updated: cache.prizepicks.updated, count: data.length });
});

// Underdog lines
app.get('/api/underdog', (req, res) => {
  const sport = req.query.sport;
  let data = cache.underdog.data || [];
  if (sport) data = data.filter(l => (l.sport||'').toLowerCase() === sport.toLowerCase());
  res.json({ data, updated: cache.underdog.updated, count: data.length });
});

// Sleeper lines
app.get('/api/sleeper', (req, res) => {
  res.json({ data: cache.sleeper.data || [], updated: cache.sleeper.updated });
});

// All DFS lines combined - for comparison with sharp books
app.get('/api/dfs', async (req, res) => {
  const sport = req.query.sport || 'NBA';
  const pp = (cache.prizepicks.data || []).filter(l => l.sport.toLowerCase() === sport.toLowerCase());
  const ud = (cache.underdog.data || []).filter(l => (l.sport||'').toLowerCase().includes(sport.toLowerCase()));
  res.json({
    prizepicks: pp,
    underdog: ud,
    updated: new Date().toISOString()
  });
});

// Odds API proxy
app.get('/api/odds/:sport', async (req, res) => {
  const sport = req.params.sport;
  const data = await fetchOddsForSport(sport);
  res.json(data);
});

// Owls props proxy (bypasses CORS)
app.get('/api/props/:sport', async (req, res) => {
  const sport = req.params.sport;
  const data = await fetchOwlsProps(sport);
  res.json(data || { error: 'No data' });
});

// Owls splits (public betting %)
app.get('/api/splits/:sport', async (req, res) => {
  const sport = req.params.sport;
  const data = await fetchOwlsSplits(sport);
  res.json(data || { error: 'No data' });
});

// Owls realtime sharp odds
app.get('/api/realtime/:sport', async (req, res) => {
  const sport = req.params.sport;
  const data = await fetchOwlsRealtime(sport);
  res.json(data || { error: 'No data' });
});

// Generic Owls proxy - pass any path through
app.get('/api/owls/*', async (req, res) => {
  const path = req.params[0];
  const query = new URLSearchParams(req.query).toString();
  const url = `https://api.owlsinsight.com/api/v1/${path}${query ? '?' + query : ''}`;
  try {
    const result = await axios.get(url, {
      headers: { 'Authorization': `Bearer ${OWLS_API_KEY}` },
      timeout: 10000
    });
    res.json(result.data);
  } catch (e) {
    res.status(e.response?.status || 500).json({ error: e.message });
  }
});

// Line history - track how lines move over time
app.post('/api/history/record', (req, res) => {
  const { player, market, line, book, odds, timestamp } = req.body;
  const key = `${player}|${market}`;
  if (!cache.lineHistory[key]) cache.lineHistory[key] = [];
  cache.lineHistory[key].push({ line, book, odds, timestamp: timestamp || new Date().toISOString() });
  if (cache.lineHistory[key].length > 50) cache.lineHistory[key] = cache.lineHistory[key].slice(-50);
  res.json({ ok: true });
});

app.get('/api/history/:player', (req, res) => {
  const player = decodeURIComponent(req.params.player);
  const market = req.query.market;
  const key = `${player}|${market}`;
  res.json(cache.lineHistory[key] || []);
});

// Cache status
app.get('/api/status', (req, res) => {
  res.json({
    prizepicks: { count: cache.prizepicks.data?.length || 0, updated: cache.prizepicks.updated },
    underdog: { count: cache.underdog.data?.length || 0, updated: cache.underdog.updated },
    sleeper: { count: cache.sleeper.data?.length || 0, updated: cache.sleeper.updated },
    oddsCache: Object.keys(cache.odds).length + ' sports cached',
  });
});

// ─── SCHEDULED SCRAPING ───────────────────────────────────────────────────────
// Scrape DFS books every 2 minutes
cron.schedule('*/2 * * * *', async () => {
  console.log('Scraping DFS books...');
  await Promise.all([scrapePrizePicks(), scrapeUnderdog()]);
});

// Scrape Sleeper every 5 minutes
cron.schedule('*/5 * * * *', () => scrapeSleeper());

// Pre-cache odds for main sports every 3 minutes
cron.schedule('*/3 * * * *', async () => {
  const sports = ['basketball_nba', 'baseball_mlb', 'icehockey_nhl', 'americanfootball_nfl'];
  for (const s of sports) await fetchOddsForSport(s);
});

// ─── START ────────────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`Line Reaper backend running on port ${PORT}`);
  // Initial scrape on startup
  console.log('Running initial scrape...');
  await Promise.all([scrapePrizePicks(), scrapeUnderdog(), scrapeSleeper()]);
  console.log('Initial scrape complete');
});
