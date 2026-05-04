require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cron = require('node-cron');
 
const app = express();
const PORT = process.env.PORT || 3001;
 
const ODDS_API_KEY = process.env.ODDS_API_KEY || 'f67774f673842b08fa547e41cf37178c';
const OWLS_API_KEY = process.env.OWLS_API_KEY || 'owlsinsight_1e9dfc3a29f37d639fb5b641ba7b2a24535d5e06b074713e88b2b1b19516b23b';
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
    // Only next 4 events to conserve quota
    for (const event of events.slice(0, 4)) {
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
 
        // Extract multiplier from options (UD's payout multiplier per side)
        // Options array contains { choice: 'higher'/'lower', payout_multiplier: '1.05' }
        let overMult = 1.00, underMult = 1.00;
        if (Array.isArray(line.options)) {
          for (const opt of line.options) {
            const m = parseFloat(opt.payout_multiplier || opt.multiplier || 1);
            if (opt.choice === 'higher' || opt.choice_display === 'Higher') overMult = m;
            else if (opt.choice === 'lower' || opt.choice_display === 'Lower') underMult = m;
          }
        }
        // Use the higher of the two as the "default" multiplier (model picks best side)
        const multiplier = Math.max(overMult, underMult);
 
        lines.push({
          book: 'underdog',
          sport: game.sport || '',
          player: player.name || '',
          team: player.team || '',
          market: app?.display_stat || '',
          line: parseFloat(line.stat_value || 0),
          startTime: game.startTime || '',
          overMultiplier: overMult,
          underMultiplier: underMult,
          multiplier,
        });
      }
    }
    cache.underdog = { data: lines, updated: new Date().toISOString() };
    const withMult = lines.filter(l => l.multiplier !== 1.00).length;
    console.log(`UD: ${lines.length} lines (${withMult} boosted/demoted)`);
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
 
// ─── ESPORTS PREDICTION ENGINE ────────────────────────────────────────────────
// Reverse engineered from a paid model. Average error vs source: 0.38% prob, 0.66% EV
// Math: prob = NormalCDF(pp_line, mean=model_pred, std=sqrt(model*k))
// EV: (prob / 0.5622 - 1) * 100  [PrizePicks pays at -128 implied 56.22%]
// k varies by sport+prop_type (see getVarianceMultiplier)
 
function _erf(x) {
  const sign = x >= 0 ? 1 : -1;
  x = Math.abs(x);
  const a1=0.254829592, a2=-0.284496736, a3=1.421413741, a4=-1.453152027, a5=1.061405429, p=0.3275911;
  const t = 1.0 / (1.0 + p * x);
  const y = 1.0 - (((((a5*t + a4)*t) + a3)*t + a2)*t + a1)*t * Math.exp(-x*x);
  return sign * y;
}
function _normalCDF(x, mean, std) {
  return 0.5 * (1 + _erf((x - mean) / (std * Math.sqrt(2))));
}
 
function getVarianceMultiplier(sport, propText) {
  const s = (sport || '').toUpperCase();
  const p = (propText || '').toUpperCase();
  const isCombo  = p.includes('COMBO');
  const isHS     = p.includes('HEADSHOT') || p.includes('HS');
  const isMap1   = /MAP\s*1\b/.test(p) && !p.includes('1-') && !p.includes('1+');
  const isMap3   = /MAP\s*3\b/.test(p) && !p.includes('-3') && !p.includes('+3');
  const isMaps12 = /MAPS?\s*1\s*[-+]\s*2/.test(p);
  const isMaps13 = /MAPS?\s*1\s*[-+]\s*2\s*[-+]\s*3/.test(p) || /MAPS?\s*1\s*[-]\s*3/.test(p) || /1\+2\+3/.test(p);
  const isGame3  = /GAME\s*3\b/.test(p) && !p.includes('+3');
  const isGame1  = /GAME\s*1\b/.test(p) && !p.includes('1+');
  const isGameCombo = /GAME\s*1[\s+]+2[\s+]+3/.test(p);
  const isAssists = p.includes('ASSIST');
  const isFantasy = p.includes('FANTASY');
 
  if (s.includes('COD')) {
    if (isCombo || isGameCombo || isMaps13) return 2.0;
    if (isMap3 || isGame3) return 4.6;
    if (isMap1 || isGame1) return 1.0;
    return 2.5;
  }
  if (s.includes('VAL')) {
    if (isCombo) return 2.5;
    if (isMaps13) return 2.4;
    if (isMaps12) return 2.1;
    return 2.3;
  }
  if (s.includes('CS')) {
    if (isHS) return 3.8;
    if (isMap3 || isMap1) return 2.8;
    if (isMaps12) return 1.9;
    return 2.5;
  }
  if (s.includes('DOTA')) {
    // DOTA: variance scales with kill volume — high-kill heroes have more variance
    // 15+ kills: k≈4, 10-15: k≈3, 5-10: k≈1.5, <5: k≈0.5
    return 4.0;  // default — refined per-prediction in calcEsportsEV
  }
  if (s.includes('LOL') || s.includes('LEAGUE')) {
    // LOL kills are extremely low-volume → high relative variance
    if (isAssists || isFantasy) return 5.0;
    return 8.0;  // LOL kills variance is ~7-9× the mean
  }
  return 2.5;
}
 
// Implied probabilities reverse-engineered from each book at 1.00x mult
// Two pricing models discovered:
//   MODEL A (PP, UD, Betr): implied=56.22%, multiplier scales bonus payout
//     EV = (prob * mult / 0.5622 - 1) * 100
//   MODEL B (ParlayPlay, Sleeper): multiplier IS the decimal payout
//     EV = (prob * mult - 1) * 100
const PP_IMPLIED = 0.5622;
const UD_IMPLIED = 0.5623;
const BETR_IMPLIED = 0.5622;
 
// Calculate EV for a specific book using its pricing model
function calcBookEV(prob, book, mult = 1.00) {
  prob = prob > 1 ? prob/100 : prob;  // accept 0-1 or 0-100
  switch ((book || '').toLowerCase()) {
    case 'prizepicks':
    case 'pp':
      return (prob / PP_IMPLIED - 1) * 100;
    case 'underdog':
    case 'ud':
      return (prob * mult / UD_IMPLIED - 1) * 100;
    case 'betr':
      return (prob * mult / BETR_IMPLIED - 1) * 100;
    case 'parlayplay':
    case 'pp2':
      // ParlayPlay: mult is the decimal payout directly
      // Default flex multiplier is 1.77x for 2-pick plays
      return (prob * (mult || 1.77) - 1) * 100;
    case 'sleeper':
      // Sleeper: mult is the decimal payout, varies wildly (1.68x to 2.26x)
      return (prob * (mult || 1.85) - 1) * 100;
    default:
      return (prob / PP_IMPLIED - 1) * 100;
  }
}
 
function calcEsportsEV(ppLine, modelPred, side, sport, propText, opts = {}) {
  if (!ppLine || !modelPred || modelPred <= 0) return null;
  let k = getVarianceMultiplier(sport, propText);
 
  // Adaptive variance for low-volume props (DOTA, LOL kills)
  // Empirically: variance scales with prediction size for these sports
  const s = (sport || '').toUpperCase();
  if (s.includes('DOTA')) {
    if (modelPred >= 15) k = 4.0;
    else if (modelPred >= 10) k = 2.8;
    else if (modelPred >= 7) k = 1.5;
    else if (modelPred >= 5) k = 0.7;
    else k = 0.4;
  }
  if (s.includes('LOL') && modelPred < 5) {
    k = Math.max(k * 0.5, 2.5);  // tiny LOL props (kills < 5) have lower abs variance
  }
 
  const std = Math.sqrt(modelPred * k);
  let prob;
  if (side === 'UNDER') prob = _normalCDF(ppLine, modelPred, std);
  else prob = 1 - _normalCDF(ppLine, modelPred, std);
 
  // PrizePicks EV (default no multiplier)
  const ppEv = calcBookEV(prob, 'prizepicks');
 
  // Other books — use multipliers if provided
  const udMult = opts.udMultiplier || 1.00;
  const udEv = calcBookEV(prob, 'underdog', udMult);
 
  const betrMult = opts.betrMultiplier || 1.00;
  const betrEv = calcBookEV(prob, 'betr', betrMult);
 
  const parlayMult = opts.parlayMultiplier || 1.77;
  const parlayEv = calcBookEV(prob, 'parlayplay', parlayMult);
 
  const sleeperMult = opts.sleeperMultiplier || 1.85;
  const sleeperEv = calcBookEV(prob, 'sleeper', sleeperMult);
 
  // Find best book
  const allEvs = [
    { book: 'PP', ev: ppEv, mult: 1.00 },
    { book: 'UD', ev: udEv, mult: udMult },
    { book: 'BETR', ev: betrEv, mult: betrMult },
    { book: 'PARLAY', ev: parlayEv, mult: parlayMult },
    { book: 'SLEEPER', ev: sleeperEv, mult: sleeperMult },
  ].filter(b => opts.bookList ? opts.bookList.includes(b.book) : true);
  const best = allEvs.reduce((a, b) => (b.ev > a.ev ? b : a));
 
  return {
    prob: prob * 100,
    ev: ppEv,           // primary EV is PP
    ppEv, udEv, betrEv, parlayEv, sleeperEv,
    udMultiplier: udMult,
    betrMultiplier: betrMult,
    parlayMultiplier: parlayMult,
    sleeperMultiplier: sleeperMult,
    bestBook: best.book,
    bestEv: best.ev,
    bestMult: best.mult,
    edge: best.ev - ppEv,
    confidence: prob > 0.62 ? 'HIGH' : prob > 0.56 ? 'MED' : 'LOW',
    varianceK: k,
  };
}
 
function predictEsportsSide(ppLine, modelPred, sport, propText, opts = {}) {
  if (!ppLine || !modelPred) return null;
  const side = modelPred < ppLine ? 'UNDER' : modelPred > ppLine ? 'OVER' : null;
  if (!side) return null;
  const r = calcEsportsEV(ppLine, modelPred, side, sport, propText, opts);
  if (!r) return null;
  return { ...r, side, ppLine, modelPred };
}
 
// Prediction layer: convert player stats to expected kills
const ROUNDS_PER_MAP = { CS: 24, VAL: 22, DOTA: 1, COD: 1, LOL: 1 };
 
function parseMapCount(propText) {
  if (!propText) return 1;
  const text = propText.toUpperCase();
  const rangeMatch = text.match(/MAPS?\s*(\d)\s*[-–]\s*(\d)/);
  if (rangeMatch) return parseInt(rangeMatch[2]) - parseInt(rangeMatch[1]) + 1;
  return 1;
}
 
function predictKillsFromStats(player, sport, mapCount, propType = 'kills') {
  if (!player || !player.kpr) return null;
  const rpm = ROUNDS_PER_MAP[sport.toUpperCase()] || 24;
  let pred = player.kpr * rpm * mapCount;
  if (propType.toLowerCase().includes('headshot')) {
    pred = pred * (player.hsPercent / 100 || 0.45);
  }
  if (player.rating) {
    const formFactor = 1 + (player.rating - 1.0) * 0.15;
    pred *= formFactor;
  }
  return pred;
}
 
// ─── ESPORTS DATA SCRAPERS ────────────────────────────────────────────────────
// HLTV (CS2) and VLR.gg (Valorant) — these will work from Railway servers
let esportsCache = {
  hltvPlayers: {},   // playerKey -> { kpr, rating, lastUpdate }
  vlrPlayers: {},
  manualPredictions: {},  // user-supplied predictions: { 'player|market' -> modelPred }
  picks: [],         // generated picks
  lastUpdated: null,
};
 
const HLTV_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://www.hltv.org/',
};
 
async function fetchHLTVPlayerStats(playerName) {
  try {
    const cached = esportsCache.hltvPlayers[playerName.toLowerCase()];
    if (cached && (Date.now() - cached.lastUpdate) < 3600000) return cached;
 
    // Search HLTV stats page
    const searchRes = await axios.get(`https://www.hltv.org/stats/players?search=${encodeURIComponent(playerName)}`, {
      headers: HLTV_HEADERS, timeout: 12000
    });
    const searchHtml = searchRes.data;
    const linkMatch = searchHtml.match(/href="\/stats\/players\/(\d+)\/[^"]+"/);
    if (!linkMatch) return null;
    const playerId = linkMatch[1];
 
    const res = await axios.get(`https://www.hltv.org/stats/players/${playerId}`, {
      headers: HLTV_HEADERS, timeout: 12000
    });
    const html = res.data;
 
    // Pull stats via regex (cheerio-free for simplicity)
    const stats = { name: playerName, lastUpdate: Date.now() };
    const ratingMatch = html.match(/Rating[^<]*<[^>]+>[\s\S]*?>([\d.]+)</);
    const kprMatch = html.match(/Kills\s*\/\s*round[^<]*<[^>]+>[\s\S]*?>([\d.]+)</);
    const adrMatch = html.match(/ADR[^<]*<[^>]+>[\s\S]*?>([\d.]+)</);
    const hsMatch = html.match(/Headshot\s*%[^<]*<[^>]+>[\s\S]*?>([\d.]+)/);
    const mapsMatch = html.match(/Maps\s*played[^<]*<[^>]+>[\s\S]*?>(\d+)/);
 
    if (ratingMatch) stats.rating = parseFloat(ratingMatch[1]);
    if (kprMatch) stats.kpr = parseFloat(kprMatch[1]);
    if (adrMatch) stats.adr = parseFloat(adrMatch[1]);
    if (hsMatch) stats.hsPercent = parseFloat(hsMatch[1]);
    if (mapsMatch) stats.mapsPlayed = parseInt(mapsMatch[1]);
 
    if (stats.kpr) {
      esportsCache.hltvPlayers[playerName.toLowerCase()] = stats;
      console.log(`HLTV ${playerName}: KPR=${stats.kpr} R=${stats.rating}`);
      return stats;
    }
    return null;
  } catch (e) {
    console.warn(`HLTV ${playerName}:`, e.response?.status || e.message);
    return esportsCache.hltvPlayers[playerName.toLowerCase()] || null;
  }
}
 
async function fetchVLRPlayerStats(playerName) {
  try {
    const cached = esportsCache.vlrPlayers[playerName.toLowerCase()];
    if (cached && (Date.now() - cached.lastUpdate) < 3600000) return cached;
 
    // Try public VLR API mirror
    const res = await axios.get(`https://vlrggapi.vercel.app/stats?region=na&timespan=60`, { timeout: 12000 });
    const players = res.data?.data?.segments || [];
    const found = players.find(p => (p.player || '').toLowerCase() === playerName.toLowerCase());
    if (!found) return null;
 
    const stats = {
      name: found.player,
      kpr: parseFloat(found.kills_per_round) || 0,
      adr: parseFloat(found.average_damage_per_round) || 0,
      hsPercent: parseFloat(found.headshot_percentage) || 0,
      rating: parseFloat(found.rating) || 0,
      lastUpdate: Date.now(),
    };
    esportsCache.vlrPlayers[playerName.toLowerCase()] = stats;
    console.log(`VLR ${playerName}: KPR=${stats.kpr} R=${stats.rating}`);
    return stats;
  } catch (e) {
    console.warn(`VLR ${playerName}:`, e.response?.status || e.message);
    return esportsCache.vlrPlayers[playerName.toLowerCase()] || null;
  }
}
 
// Generate picks from PP esports lines + auto/manual predictions
// Normalize player name for cross-book matching
function normalizeName(n) {
  return (n || '').toLowerCase().replace(/\s+/g, '').replace(/[^a-z0-9]/g, '');
}
 
// Normalize market for cross-book matching
// Handles formats: "MAPS 1-2 Kills" (PP), "Kills on Maps 1+2" (UD), "Kills Map 1+2" (Betr), "Kills Maps 1 2" (Sleeper)
function normalizeMarket(m) {
  const s = (m || '').toLowerCase();
  const isKills    = s.includes('kill');
  const isHS       = s.includes('headshot') || s.includes('hs');
  const isAssists  = s.includes('assist');
  const isFantasy  = s.includes('fantasy');
  // Map ranges: "1+2", "1-2", "1 2" (Sleeper), "1+2+3"
  let mapCount = '1';
  // Check for 3-map combos first: "1+2+3", "1-3"
  if (/(?:map|maps?)\s*1\s*[-+]\s*2\s*[-+]\s*3/.test(s) || /1[-+]2[-+]3/.test(s)) {
    mapCount = '1-3';
  } else if (/maps?\s*1[-+]?\s*[-+]\s*2/.test(s) || /maps?\s*1\s+2/.test(s)) {
    mapCount = '1-2';
  } else {
    const m1 = s.match(/(?:map|maps?)\s*(\d)\b/);
    if (m1) mapCount = m1[1];
  }
  // "Game N" format (COD)
  const g = s.match(/game\s*(\d)\s*[+]?\s*(\d)?\s*[+]?\s*(\d)?/);
  if (g && !s.includes('map')) {
    if (g[3]) mapCount = '1-3';
    else if (g[2]) mapCount = `${g[1]}-${g[2]}`;
    else mapCount = g[1];
  }
  let stat = isHS ? 'hs' : isAssists ? 'ast' : isFantasy ? 'fp' : 'k';
  return `${stat}|${mapCount}`;
}
 
async function generateEsportsPicks() {
  const ppLines = cache.prizepicks.data || [];
  const udLines = cache.underdog.data || [];
 
  const isEsports = (s) => {
    const u = (s || '').toUpperCase();
    return ['CS', 'CS2', 'VAL', 'VALORANT', 'COD', 'CALL OF DUTY', 'DOTA', 'LOL', 'LEAGUE'].some(k => u.includes(k));
  };
 
  const ppEsports = ppLines.filter(l => isEsports(l.sport));
  const udEsports = udLines.filter(l => isEsports(l.sport));
 
  // Build UD lookup: { 'normalizedName|normalizedMarket' -> { line, overMult, underMult } }
  const udMap = {};
  for (const l of udEsports) {
    if (!l.player || l.line == null) continue;
    const key = `${normalizeName(l.player)}|${normalizeMarket(l.market)}`;
    udMap[key] = {
      line: l.line,
      overMultiplier: l.overMultiplier || 1.00,
      underMultiplier: l.underMultiplier || 1.00,
      multiplier: l.multiplier || 1.00,
      market: l.market,
    };
  }
 
  console.log(`Esports: PP=${ppEsports.length} UD=${udEsports.length} udMap=${Object.keys(udMap).length}`);
 
  const picks = [];
  for (const line of ppEsports) {
    if (!line.player || line.line == null) continue;
 
    // Try manual prediction first
    const manualKey = `${line.player}|${line.market}`;
    let modelPred = esportsCache.manualPredictions[manualKey];
    let predSource = 'manual';
 
    // Auto-predict from stats if no manual prediction
    if (!modelPred) {
      const sport = (line.sport || '').toUpperCase();
      const mapCount = parseMapCount(line.market);
      let player = null;
      let sportKey = 'CS';
 
      if (sport.includes('VAL')) {
        player = await fetchVLRPlayerStats(line.player);
        sportKey = 'VAL';
      } else if (sport.includes('CS')) {
        player = await fetchHLTVPlayerStats(line.player);
        sportKey = 'CS';
      }
 
      if (player) {
        const autoPred = predictKillsFromStats(player, sportKey, mapCount, line.market);
        // SANITY CHECK: reject auto-predictions that are too far from the line
        // The paid model rarely deviates more than 15% from the line
        // Anything beyond 20% is almost certainly a bad scrape, not a real edge
        if (autoPred && line.line) {
          const pctDiff = Math.abs(autoPred - line.line) / line.line;
          if (pctDiff <= 0.20) {
            modelPred = autoPred;
            predSource = 'auto';
          } else {
            // Reject — auto-predictor is generating garbage for this player
            console.log(`Esports: rejected auto-pred for ${line.player} (line=${line.line}, pred=${autoPred.toFixed(1)}, ${(pctDiff*100).toFixed(0)}% diff)`);
          }
        }
      }
    }
 
    // Look up UD line for the same player+market
    const udKey = `${normalizeName(line.player)}|${normalizeMarket(line.market)}`;
    const udInfo = udMap[udKey];
 
    if (!modelPred) {
      picks.push({
        player: line.player, sport: line.sport, market: line.market,
        ppLine: line.line, modelPred: null, side: null, prob: null, ev: null,
        ppEv: null, udEv: null,
        udLine: udInfo?.line, udMultiplier: udInfo?.multiplier,
        manualKey,
      });
      continue;
    }
 
    // Calculate EV — use the multiplier for whichever side the model picks
    const sideForUd = modelPred < line.line ? 'UNDER' : modelPred > line.line ? 'OVER' : null;
    const udMultForSide = sideForUd === 'UNDER'
      ? (udInfo?.underMultiplier || 1.00)
      : (udInfo?.overMultiplier || 1.00);
 
    const result = predictEsportsSide(line.line, modelPred, line.sport, line.market, {
      udMultiplier: udMultForSide,
    });
    if (!result) continue;
 
    // Also check the OPPOSITE side on UD if line is different
    let udSpecific = null;
    if (udInfo && udInfo.line !== line.line) {
      const udSide = modelPred < udInfo.line ? 'UNDER' : 'OVER';
      const udMultSpecific = udSide === 'UNDER' ? udInfo.underMultiplier : udInfo.overMultiplier;
      const udResult = calcEsportsEV(udInfo.line, modelPred, udSide, line.sport, line.market, {
        udMultiplier: udMultSpecific,
      });
      if (udResult) udSpecific = { ...udResult, side: udSide, line: udInfo.line, multiplier: udMultSpecific };
    }
 
    picks.push({
      player: line.player,
      sport: line.sport,
      market: line.market,
      team: line.team || '',
      startTime: line.startTime || '',
      ppLine: line.line,
      modelPred: parseFloat(modelPred.toFixed(1)),
      side: result.side,
      prob: parseFloat(result.prob.toFixed(1)),
      ev: parseFloat(result.ev.toFixed(1)),
      ppEv: parseFloat(result.ppEv.toFixed(1)),
      udEv: parseFloat(result.udEv.toFixed(1)),
      betrEv: parseFloat(result.betrEv.toFixed(1)),
      parlayEv: parseFloat(result.parlayEv.toFixed(1)),
      sleeperEv: parseFloat(result.sleeperEv.toFixed(1)),
      udLine: udInfo?.line,
      udMultiplier: udMultForSide,
      udOverMult: udInfo?.overMultiplier || 1.00,
      udUnderMult: udInfo?.underMultiplier || 1.00,
      parlayMultiplier: 1.77,
      sleeperMultiplier: result.sleeperMultiplier,
      udSpecific,
      bestBook: result.bestBook,
      bestEv: parseFloat(result.bestEv.toFixed(1)),
      bestMult: result.bestMult,
      edge: parseFloat(result.edge.toFixed(2)),
      confidence: result.confidence,
      varianceK: result.varianceK,
      predSource,
      manualKey,
    });
  }
 
  // Sort by best EV across both books
  picks.sort((a, b) => (b.bestEv ?? b.ev ?? -999) - (a.bestEv ?? a.ev ?? -999));
  esportsCache.picks = picks;
  esportsCache.lastUpdated = new Date().toISOString();
  return picks;
}
 
 
 
// ─── ROUTES ───────────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({ status: 'Line Reaper backend running', version: '3.1.0', updated: new Date().toISOString() }));
 
// ── ESPORTS ENDPOINTS ─────────────────────────────────────────────────────────
 
// Get all esports picks (auto-generated)
app.get('/api/esports/picks', async (req, res) => {
  // Refresh if older than 5 min or never generated
  const fresh = esportsCache.lastUpdated &&
    (Date.now() - new Date(esportsCache.lastUpdated).getTime()) < 300000;
  if (!fresh) await generateEsportsPicks();
  const minEV = parseFloat(req.query.minEV) || -100;
  const sport = req.query.sport;
  let picks = esportsCache.picks || [];
  if (sport) picks = picks.filter(p => (p.sport || '').toUpperCase().includes(sport.toUpperCase()));
  picks = picks.filter(p => p.ev == null || p.ev >= minEV);
  res.json({ picks, count: picks.length, updated: esportsCache.lastUpdated });
});
 
// Force refresh
app.post('/api/esports/refresh', async (req, res) => {
  await generateEsportsPicks();
  res.json({ ok: true, count: esportsCache.picks.length });
});
 
// Manual prediction input — when user has a model number not on auto-predictor
app.post('/api/esports/predict', (req, res) => {
  const { ppLine, modelPred, sport, propText, side } = req.body;
  if (!ppLine || !modelPred) return res.status(400).json({ error: 'ppLine and modelPred required' });
  const result = side
    ? calcEsportsEV(ppLine, modelPred, side, sport, propText)
    : predictEsportsSide(ppLine, modelPred, sport, propText);
  res.json(result);
});
 
// Save a manual prediction for a specific player+market
app.post('/api/esports/manual', (req, res) => {
  const { player, market, modelPred } = req.body;
  if (!player || !market) return res.status(400).json({ error: 'player and market required' });
  const key = `${player}|${market}`;
  if (modelPred == null) delete esportsCache.manualPredictions[key];
  else esportsCache.manualPredictions[key] = parseFloat(modelPred);
  res.json({ ok: true, key, value: esportsCache.manualPredictions[key] });
});
 
app.get('/api/esports/manual', (req, res) => {
  res.json(esportsCache.manualPredictions);
});
 
// Player stats lookup
app.get('/api/esports/player/:sport/:name', async (req, res) => {
  const { sport, name } = req.params;
  let stats = null;
  if (sport.toLowerCase().includes('val')) stats = await fetchVLRPlayerStats(name);
  else if (sport.toLowerCase().includes('cs')) stats = await fetchHLTVPlayerStats(name);
  res.json(stats || { error: 'Player not found' });
});
 
 
 
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
 
  let merged = mergeProps(owls, oddsApi);
 
  // FALLBACK: if nothing from Owls or Odds API, build from PP/UD data
  // This gives us props 24/7 from DFS books even when sportsbook APIs are empty
  if (!merged.length) {
    const sportUpper = sport.toUpperCase();
    const ppLines = (cache.prizepicks.data || []).filter(l =>
      l.sport && l.sport.toLowerCase().includes(sport.toLowerCase()) ||
      (sport === 'nba' && l.sport === 'NBA') ||
      (sport === 'mlb' && l.sport === 'MLB') ||
      (sport === 'nhl' && l.sport === 'NHL') ||
      (sport === 'nfl' && l.sport === 'NFL')
    );
    const udLines = (cache.underdog.data || []).filter(l =>
      l.sport && (l.sport.toLowerCase().includes(sport.toLowerCase()) || l.sport.toUpperCase() === sportUpper)
    );
 
    if (ppLines.length || udLines.length) {
      // Group by player+market into fake game objects
      const playerMap = {};
      for (const l of ppLines) {
        const key = `${l.player}|||${l.market}`;
        if (!playerMap[key]) playerMap[key] = { player: l.player, team: l.team, market: l.market, pp: l.line, ud: null };
      }
      for (const l of udLines) {
        const key = `${l.player}|||${l.market}`;
        if (!playerMap[key]) playerMap[key] = { player: l.player, team: l.team, market: l.market, pp: null, ud: l.line };
        else playerMap[key].ud = l.line;
      }
 
      // Build a single fake game with PP and UD as "books"
      const ppProps = [], udProps = [];
      for (const p of Object.values(playerMap)) {
        if (p.pp != null) ppProps.push({ player: p.player, market: p.market, line: p.pp, overPrice: -110, underPrice: -110 });
        if (p.ud != null) udProps.push({ player: p.player, market: p.market, line: p.ud, overPrice: -110, underPrice: -110 });
      }
 
      const books = [];
      if (ppProps.length) books.push({ key: 'prizepicks', title: 'PrizePicks', props: ppProps });
      if (udProps.length) books.push({ key: 'underdog', title: 'Underdog', props: udProps });
 
      if (books.length) {
        merged = [{ sport, id: `dfs_${sport}`, home_team: `${sportUpper} Players`, away_team: 'DFS Lines', commence_time: new Date().toISOString(), books }];
        console.log(`Props ${sport}: using DFS fallback — PP:${ppProps.length} UD:${udProps.length}`);
      }
    }
  }
 
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
// Stagger OddsAPI prop fetches - every 30 min to conserve quota (~200 credits/day)
cron.schedule('0,30 * * * *', () => fetchOddsApiProps('basketball_nba'));
cron.schedule('3,33 * * * *', () => fetchOddsApiProps('baseball_mlb'));
cron.schedule('6,36 * * * *', () => fetchOddsApiProps('icehockey_nhl'));
cron.schedule('9,39 * * * *', () => fetchOddsApiProps('americanfootball_nfl'));
cron.schedule('*/3 * * * *', async () => { for (const s of ['basketball_nba','baseball_mlb','icehockey_nhl','americanfootball_nfl']) fetchOddsForSport(s); });
 
// Esports: refresh picks every 5 min (after PP scrape)
cron.schedule('*/5 * * * *', () => generateEsportsPicks().catch(()=>{}));
 
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
  // Generate esports picks once PP is loaded (~3s after startup)
  setTimeout(() => generateEsportsPicks().catch(()=>{}), 5000);
  console.log('Startup complete');
});
