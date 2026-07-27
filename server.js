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
  udSportLabels: [],        // distinct sport labels seen in the UD feed (diagnostics)
  ppLeagueLabels: [],       // distinct league labels seen in the PP feed (diagnostics)
  quotaRemaining: null,     // Odds API x-requests-remaining, last seen
};
 
// ─── IN-SEASON GATE ───────────────────────────────────────────────────────────
// Only spend Odds API credits on sports actually in season (month-based).
function inSeasonSports() {
  const m = new Date().getMonth() + 1;
  const s = [];
  if (m >= 3 && m <= 10) s.push('baseball_mlb');           // MLB: Mar-Oct
  if (m >= 8 || m <= 2)  s.push('americanfootball_nfl');   // NFL: Aug-Feb
  if (m >= 10 || m <= 6) s.push('basketball_nba', 'icehockey_nhl');  // NBA/NHL: Oct-Jun
  if (m >= 11 || m <= 3) s.push('basketball_ncaab');       // NCAAB: Nov-Mar
  s.push('mma_mixed_martial_arts');                        // MMA: year-round
  return s;
}
 
function noteQuota(res) {
  const rem = res?.headers?.['x-requests-remaining'];
  if (rem != null) cache.quotaRemaining = parseFloat(rem);
}
 
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
  // Off-season sports return nothing but still bill — skip them entirely.
  if (!inSeasonSports().includes(sportKey)) return cache.oddsApiProps[sportKey]?.data || [];
 
  try {
    // Get all events (the /events endpoint does not count against the quota)
    const eventsRes = await axios.get(`https://api.the-odds-api.com/v4/sports/${sportKey}/events`, {
      params: { apiKey: ODDS_API_KEY }, timeout: 10000
    });
    noteQuota(eventsRes);
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
        noteQuota(res);
 
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
            noteQuota(res2);
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
    console.log(`OddsAPI props ${sportKey}: ${allProps.length} games, ${total} props` + (cache.quotaRemaining != null ? ` · quota left: ${cache.quotaRemaining}` : ''));
    return allProps;
  } catch(e) {
    console.warn(`OddsAPI props ${sportKey}:`, e.response?.status, e.message);
    return cache.oddsApiProps[sportKey]?.data || [];
  }
}
 
// ─── DFS SCRAPERS ─────────────────────────────────────────────────────────────
// PP gets blocked (403) from datacenter IPs — when that happens, back off to
// 30-minute retries instead of hammering every 2 min. Esports runs on UD anyway.
let ppFail = { count: 0, until: 0 };
 
async function scrapePrizePicks() {
  if (Date.now() < ppFail.until) return;
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
    if (allLines.length > 0) {
      cache.prizepicks = { data: allLines, updated: new Date().toISOString() };
      ppFail = { count: 0, until: 0 };
      cache.ppLeagueLabels = [...new Set(allLines.map(l => l.sport))].slice(0, 20);
      console.log(`PP: ${allLines.length} lines · leagues: ${cache.ppLeagueLabels.slice(0, 12).join(', ')}`);
    }
  } catch(e) {
    const s = e.response?.status;
    ppFail.count++;
    if ((s === 403 || s === 429) && ppFail.count >= 3) {
      ppFail.until = Date.now() + 30 * 60 * 1000;
      if (ppFail.count === 3) console.warn(`PP blocked (${s}) — backing off to 30-min retries; esports keeps running on Underdog`);
    } else {
      console.error('PP error:', e.message, s);
    }
  }
}
 
// Pure parser so the UD payload handling is testable and survives shape changes.
// UD has shipped several shapes over time:
//   - appearance embedded on the line (over_under.appearance_stat.appearance = {...})
//   - appearance referenced by id (appearance_id) with a top-level data.appearances[] array
//   - esports/single events living in data.solo_games[] instead of data.games[]
// Sport is resolved: game.sport_id → solo_game.sport_id → player.sport_id → ''.
function parseUnderdogPayload(data) {
  const players = {}, games = {}, soloGames = {}, appearances = {};
  if (Array.isArray(data.players)) for (const p of data.players) {
    players[p.id] = {
      name: p.name || [p.first_name, p.last_name].filter(Boolean).join(' '),
      team: p.team_name || p.team || '',
      sport: p.sport_id || p.sport || '',
    };
  }
  if (Array.isArray(data.games)) for (const g of data.games) {
    games[g.id] = { sport: g.sport_id || g.sport || '', startTime: g.scheduled_at || '' };
  }
  if (Array.isArray(data.solo_games)) for (const g of data.solo_games) {
    soloGames[g.id] = { sport: g.sport_id || g.sport || '', startTime: g.scheduled_at || '' };
  }
  if (Array.isArray(data.appearances)) for (const a of data.appearances) {
    appearances[a.id] = { player_id: a.player_id, match_id: a.match_id || a.solo_game_id || null };
  }
 
  const lines = [];
  for (const line of (data.over_under_lines || [])) {
    const ou = line.over_under || {};
    const appStat = ou.appearance_stat || line.appearance_stat || {};
 
    // appearance: embedded object OR id reference into data.appearances
    let appearance = appStat.appearance || null;
    const appearanceId = appStat.appearance_id || line.appearance_id || appearance?.id;
    if (!appearance && appearanceId && appearances[appearanceId]) appearance = appearances[appearanceId];
 
    const playerId = appearance?.player_id || line.player_id;
    const matchId = appearance?.match_id || appearance?.solo_game_id || null;
 
    const player = players[playerId] || {};
    const game = games[matchId] || soloGames[matchId] || {};
    const sport = game.sport || player.sport || '';
 
    // per-side payout multipliers
    let overMult = 1.00, underMult = 1.00;
    if (Array.isArray(line.options)) {
      for (const opt of line.options) {
        const m = parseFloat(opt.payout_multiplier || opt.multiplier || 1);
        if (opt.choice === 'higher' || opt.choice_display === 'Higher') overMult = m;
        else if (opt.choice === 'lower' || opt.choice_display === 'Lower') underMult = m;
      }
    }
 
    lines.push({
      book: 'underdog',
      sport,
      player: player.name || '',
      team: player.team || '',
      market: appStat.display_stat || ou.title || '',
      line: parseFloat(line.stat_value || 0),
      startTime: game.startTime || '',
      overMultiplier: overMult,
      underMultiplier: underMult,
      multiplier: Math.max(overMult, underMult),
    });
  }
  return lines;
}
 
async function scrapeUnderdog() {
  try {
    const res = await axios.get('https://api.underdogfantasy.com/beta/v5/over_under_lines', {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json', 'x-api-key': 'undefined' },
      timeout: 10000
    });
    const lines = parseUnderdogPayload(res.data || {});
    cache.underdog = { data: lines, updated: new Date().toISOString() };
    cache.udSportLabels = [...new Set(lines.map(l => l.sport).filter(Boolean))].slice(0, 25);
    const withMult = lines.filter(l => l.multiplier !== 1.00).length;
    console.log(`UD: ${lines.length} lines (${withMult} boosted/demoted) · sports: ${cache.udSportLabels.slice(0, 12).join(', ') || 'NONE RESOLVED'}`);
  } catch(e) { console.error('UD error:', e.message); }
}
 
// ─── OWLS FETCHERS (with dead-key circuit breaker) ────────────────────────────
// After 3 consecutive auth failures (401/403), Owls fetching disables itself
// entirely — no more log spam, no wasted CPU/egress on a lapsed key.
// Set a valid OWLS_API_KEY env var on Railway and restart to re-enable.
let owlsAuthFails = 0;
const owlsDisabled = () => owlsAuthFails >= 3;
function noteOwlsError(e, label) {
  const s = e.response?.status;
  if (s === 401 || s === 403) {
    owlsAuthFails++;
    if (owlsAuthFails === 3) console.warn('Owls: auth failing (dead key) — Owls fetching DISABLED. Set a valid OWLS_API_KEY and restart to re-enable.');
    else if (owlsAuthFails < 3) console.warn(`${label}: ${s} (auth) — ${3 - owlsAuthFails} more failures until Owls disables itself`);
  } else if (!owlsDisabled()) {
    console.warn(`${label}:`, s, e.message);
  }
}
 
async function fetchOwlsProps(sport) {
  if (owlsDisabled()) return cache.owlsProps[sport]?.data || null;
  try {
    const res = await axios.get(`https://api.owlsinsight.com/api/v1/${sport}/props`, { headers: OWLS_HEADERS, timeout: 12000 });
    owlsAuthFails = 0;
    cache.owlsProps[sport] = { data: res.data, updated: new Date().toISOString() };
    console.log(`Owls props ${sport}: ${Array.isArray(res.data) ? res.data.length : '?'} games`);
    return res.data;
  } catch(e) { noteOwlsError(e, `Owls props ${sport}`); return cache.owlsProps[sport]?.data || null; }
}
 
async function fetchOwlsOdds(sport) {
  if (owlsDisabled()) return cache.owlsOdds[sport]?.data || null;
  try {
    const res = await axios.get(`https://api.owlsinsight.com/api/v1/${sport}/odds`, { headers: OWLS_HEADERS, timeout: 12000 });
    owlsAuthFails = 0;
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
  } catch(e) { noteOwlsError(e, `Owls odds ${sport}`); return cache.owlsOdds[sport]?.data || null; }
}
 
async function fetchOwlsSplits(sport) {
  if (owlsDisabled()) return cache.splits[sport]?.data || null;
  try {
    const res = await axios.get(`https://api.owlsinsight.com/api/v1/${sport}/splits`, { headers: OWLS_HEADERS, timeout: 10000 });
    owlsAuthFails = 0;
    cache.splits[sport] = { data: res.data, updated: new Date().toISOString() };
    return res.data;
  } catch(e) { noteOwlsError(e, `Owls splits ${sport}`); return cache.splits[sport]?.data || null; }
}
 
// Lazy only — the old 3-minute cron for this was burning ~5,700 credits/DAY
// (4 sports × 3 markets × every 3 min). The frontend fetches its own odds
// directly, so nothing needs this on a timer. Kept as an on-request route.
async function fetchOddsForSport(sport) {
  try {
    const res = await axios.get(`https://api.the-odds-api.com/v4/sports/${sport}/odds/`, {
      params: { apiKey: ODDS_API_KEY, regions: 'us', markets: 'h2h,spreads,totals', oddsFormat: 'american' }, timeout: 10000
    });
    noteQuota(res);
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
    // DOTA: variance scales with kill volume — refined per-prediction in calcEsportsEV
    return 4.0;
  }
  if (s.includes('LOL') || s.includes('LEAGUE')) {
    if (isAssists || isFantasy) return 5.0;
    return 8.0;  // LOL kills variance is ~7-9x the mean
  }
  return 2.5;
}
 
// Implied probabilities reverse-engineered from each book at 1.00x mult
//   MODEL A (PP, UD, Betr): implied=56.22%, multiplier scales bonus payout
//   MODEL B (ParlayPlay, Sleeper): multiplier IS the decimal payout
const PP_IMPLIED = 0.5622;
const UD_IMPLIED = 0.5623;
const BETR_IMPLIED = 0.5622;
 
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
      return (prob * (mult || 1.77) - 1) * 100;
    case 'sleeper':
      return (prob * (mult || 1.85) - 1) * 100;
    default:
      return (prob / PP_IMPLIED - 1) * 100;
  }
}
 
function calcEsportsEV(ppLine, modelPred, side, sport, propText, opts = {}) {
  if (!ppLine || !modelPred || modelPred <= 0) return null;
  let k = getVarianceMultiplier(sport, propText);
 
  // Adaptive variance for low-volume props (DOTA, LOL kills)
  const s = (sport || '').toUpperCase();
  if (s.includes('DOTA')) {
    if (modelPred >= 15) k = 4.0;
    else if (modelPred >= 10) k = 2.8;
    else if (modelPred >= 7) k = 1.5;
    else if (modelPred >= 5) k = 0.7;
    else k = 0.4;
  }
  if (s.includes('LOL') && modelPred < 5) {
    k = Math.max(k * 0.5, 2.5);
  }
 
  const std = Math.sqrt(modelPred * k);
  let prob;
  if (side === 'UNDER') prob = _normalCDF(ppLine, modelPred, std);
  else prob = 1 - _normalCDF(ppLine, modelPred, std);
 
  return {
    prob: prob * 100,
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
  return { ...r, side, ppLine, modelPred, ev: calcBookEV(r.prob, 'prizepicks') };
}
 
// Prediction layer: convert player stats to expected kills
const ROUNDS_PER_MAP = { CS: 24, VAL: 22, DOTA: 1, COD: 1, LOL: 1 };
 
function parseMapCount(propText) {
  if (!propText) return 1;
  const text = propText.toUpperCase();
  const rangeMatch = text.match(/MAPS?\s*(\d)\s*[-–+]\s*(\d)/);
  if (rangeMatch) return parseInt(rangeMatch[2]) - parseInt(rangeMatch[1]) + 1;
  return 1;
}
 
function predictKillsFromStats(player, sport, mapCount, propType = 'kills') {
  if (!player || !player.kpr) return null;
  const rpm = ROUNDS_PER_MAP[(sport || '').toUpperCase()] || 24;
  let pred = player.kpr * rpm * mapCount;
  if ((propType || '').toLowerCase().includes('headshot')) {
    pred = pred * (player.hsPercent / 100 || 0.45);
  }
  if (player.rating) {
    const formFactor = 1 + (player.rating - 1.0) * 0.15;
    pred *= formFactor;
  }
  return pred;
}
 
// ─── ESPORTS DATA SCRAPERS (HLTV / VLR) ───────────────────────────────────────
let esportsCache = {
  hltvPlayers: {},
  vlrPlayers: {},
  manualPredictions: {},   // { 'player|market' -> modelPred }
  picks: [],
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
 
// ─── CROSS-BOOK NORMALIZATION ─────────────────────────────────────────────────
function normalizeName(n) {
  return (n || '').toLowerCase().replace(/\s+/g, '').replace(/[^a-z0-9]/g, '');
}
 
// Handles: "MAPS 1-2 Kills" (PP), "Kills on Maps 1+2" (UD), "Kills Map 1+2" (Betr), "Kills Maps 1 2" (Sleeper)
function normalizeMarket(m) {
  const s = (m || '').toLowerCase();
  const isKills    = s.includes('kill');
  const isHS       = s.includes('headshot') || s.includes('hs');
  const isAssists  = s.includes('assist');
  const isFantasy  = s.includes('fantasy');
  let mapCount = '1';
  if (/(?:map|maps?)\s*1\s*[-+]\s*2\s*[-+]\s*3/.test(s) || /1[-+]2[-+]3/.test(s)) {
    mapCount = '1-3';
  } else if (/maps?\s*1[-+]?\s*[-+]\s*2/.test(s) || /maps?\s*1\s+2/.test(s)) {
    mapCount = '1-2';
  } else {
    const m1 = s.match(/(?:map|maps?)\s*(\d)\b/);
    if (m1) mapCount = m1[1];
  }
  const g = s.match(/game\s*(\d)\s*[+]?\s*(\d)?\s*[+]?\s*(\d)?/);
  if (g && !s.includes('map')) {
    if (g[3]) mapCount = '1-3';
    else if (g[2]) mapCount = `${g[1]}-${g[2]}`;
    else mapCount = g[1];
  }
  let stat = isHS ? 'hs' : isAssists ? 'ast' : isFantasy ? 'fp' : 'k';
  return `${stat}|${mapCount}`;
}
 
// ─── ESPORTS PICK GENERATION (UD-primary, PP as bonus) ────────────────────────
const ES_TOKENS = ['CS','VAL','COD','CALL OF DUTY','DOTA','LOL','LEAGUE','ESPORT','CSGO','COUNTER','OVERWATCH','OW2','HALO','R6','RAINBOW','ROCKET'];
function isEsports(s) {
  const u = (s || '').toUpperCase();
  return ES_TOKENS.some(k => u.includes(k));
}
 
async function generateEsportsPicks() {
  const ppLines = cache.prizepicks.data || [];
  const udLines = cache.underdog.data || [];
 
  const ppEsports = ppLines.filter(l => isEsports(l.sport));
  const udEsports = udLines.filter(l => isEsports(l.sport));
 
  // UD lookup, side-aware multipliers
  const udMap = {};
  for (const l of udEsports) {
    if (!l.player || l.line == null) continue;
    udMap[`${normalizeName(l.player)}|${normalizeMarket(l.market)}`] = {
      line: l.line, overMultiplier: l.overMultiplier || 1.00, underMultiplier: l.underMultiplier || 1.00,
      market: l.market, sport: l.sport, player: l.player, team: l.team || '', startTime: l.startTime || '',
      matched: false,
    };
  }
  console.log(`Esports: PP=${ppEsports.length} UD=${udEsports.length} udMap=${Object.keys(udMap).length}`);
 
  // Limit fresh stat lookups per cycle so pick generation stays fast;
  // cached players are free and refresh hourly.
  let freshLookups = 0;
  const MAX_FRESH_LOOKUPS = 15;
 
  // Manual predictions are stored under the exact 'player|market' string the user
  // clicked ✏️ on — but the same pick reads "MAPS 1-2 Kills" on PP and
  // "Kills on Maps 1+2" on UD. Normalized index makes a manual number stick to
  // the pick no matter which book's format is on screen.
  const manualNorm = {};
  for (const [k, v] of Object.entries(esportsCache.manualPredictions)) {
    const i = k.indexOf('|');
    if (i > 0) manualNorm[`${normalizeName(k.slice(0, i))}|${normalizeMarket(k.slice(i + 1))}`] = v;
  }
 
  async function getModelPred(lineObj) {
    const manualKey = `${lineObj.player}|${lineObj.market}`;
    let modelPred = esportsCache.manualPredictions[manualKey];
    if (modelPred == null) modelPred = manualNorm[`${normalizeName(lineObj.player)}|${normalizeMarket(lineObj.market)}`];
    let predSource = modelPred != null ? 'manual' : null;
 
    if (modelPred == null) {
      const sportU = (lineObj.sport || '').toUpperCase();
      const mapCount = parseMapCount(lineObj.market);
      let sportKey = null;
      if (sportU.includes('VAL')) sportKey = 'VAL';
      else if (sportU.includes('CS') || sportU.includes('COUNTER')) sportKey = 'CS';
 
      let player = null;
      if (sportKey) {
        const cacheStore = sportKey === 'VAL' ? esportsCache.vlrPlayers : esportsCache.hltvPlayers;
        const hasCached = !!cacheStore[(lineObj.player || '').toLowerCase()];
        if (hasCached || freshLookups < MAX_FRESH_LOOKUPS) {
          if (!hasCached) freshLookups++;
          player = sportKey === 'VAL'
            ? await fetchVLRPlayerStats(lineObj.player)
            : await fetchHLTVPlayerStats(lineObj.player);
        }
      }
 
      if (player) {
        const autoPred = predictKillsFromStats(player, sportKey, mapCount, lineObj.market);
        // SANITY CHECK: reject auto-predictions too far from the line.
        // The paid model rarely deviates more than 15% from the line —
        // beyond 20% is almost certainly a bad scrape, not a real edge.
        if (autoPred && lineObj.line) {
          const pctDiff = Math.abs(autoPred - lineObj.line) / lineObj.line;
          if (pctDiff <= 0.20) {
            modelPred = autoPred;
            predSource = 'auto';
          } else {
            console.log(`Esports: rejected auto-pred for ${lineObj.player} (line=${lineObj.line}, pred=${autoPred.toFixed(1)}, ${(pctDiff*100).toFixed(0)}% diff)`);
          }
        }
      }
    }
    return { modelPred, predSource, manualKey };
  }
 
  // Build one pick object. Only books that ACTUALLY carry the line get an EV —
  // no more fabricated Betr/ParlayPlay/Sleeper numbers with default multipliers.
  function assemble(base, modelPred, predSource, manualKey, udm, lineSource) {
    const lineVal = base.line;
    const pick = {
      sport: base.sport, player: base.player, team: base.team || '', market: base.market,
      ppLine: lineVal, startTime: base.startTime || '', lineSource,
      modelPred: modelPred != null ? parseFloat(modelPred.toFixed(2)) : null,
      predSource: modelPred != null ? predSource : null,
      manualKey,
      side: null, prob: null, ev: null,
      ppEv: null, udEv: null, betrEv: null, parlayEv: null, sleeperEv: null,
      udMultiplier: null, sleeperMultiplier: null, udLine: udm ? udm.line : null,
      bestBook: null, bestEv: null, edge: null, confidence: null, varianceK: null,
    };
    if (modelPred == null || !lineVal) return pick;   // no model yet — still listed for ✏️ input
 
    const side = modelPred < lineVal ? 'UNDER' : modelPred > lineVal ? 'OVER' : null;
    if (!side) return pick;
    const r = calcEsportsEV(lineVal, modelPred, side, base.sport, base.market);
    if (!r) return pick;
 
    pick.side = side;
    pick.prob = parseFloat(r.prob.toFixed(2));
    pick.confidence = r.confidence;
    pick.varianceK = r.varianceK;
 
    if (lineSource === 'pp') pick.ppEv = parseFloat(calcBookEV(r.prob, 'prizepicks').toFixed(2));
 
    if (udm) {
      const udSideMult = side === 'OVER' ? (udm.overMultiplier || 1.00) : (udm.underMultiplier || 1.00);
      // UD's line can differ from PP's — price UD against ITS OWN line
      let udProb = r.prob;
      if (udm.line != null && udm.line !== lineVal) {
        const r2 = calcEsportsEV(udm.line, modelPred, side, base.sport, base.market);
        if (r2) udProb = r2.prob;
      }
      pick.udEv = parseFloat(calcBookEV(udProb, 'underdog', udSideMult).toFixed(2));
      pick.udMultiplier = udSideMult;
    }
 
    const books = [['PP', pick.ppEv], ['UD', pick.udEv]].filter(b => b[1] != null);
    if (books.length) {
      const best = books.reduce((a, b) => (b[1] > a[1] ? b : a));
      pick.bestBook = best[0];
      pick.bestEv = best[1];
      pick.ev = pick.ppEv != null ? pick.ppEv : pick.udEv;
      pick.edge = parseFloat((best[1] - (pick.ppEv ?? best[1])).toFixed(2));
    }
    return pick;
  }
 
  const picks = [];
 
  // PP lines first (when PP is alive) — cross-matched to UD
  for (const line of ppEsports) {
    if (!line.player || line.line == null) continue;
    const udm = udMap[`${normalizeName(line.player)}|${normalizeMarket(line.market)}`] || null;
    if (udm) udm.matched = true;
    const { modelPred, predSource, manualKey } = await getModelPred(line);
    picks.push(assemble(line, modelPred, predSource, manualKey, udm, 'pp'));
  }
 
  // UD lines with no PP counterpart — the board stays full even when PP is blocked
  for (const udm of Object.values(udMap)) {
    if (udm.matched) continue;
    const base = { sport: udm.sport, player: udm.player, team: udm.team, market: udm.market, line: udm.line, startTime: udm.startTime };
    const { modelPred, predSource, manualKey } = await getModelPred(base);
    picks.push(assemble(base, modelPred, predSource, manualKey, udm, 'ud'));
  }
 
  picks.sort((a, b) => (b.bestEv ?? -999) - (a.bestEv ?? -999));
  esportsCache.picks = picks;
  esportsCache.lastUpdated = new Date().toISOString();
  console.log(`Esports: generated ${picks.length} picks (${picks.filter(p => p.lineSource === 'ud').length} UD-sourced, ${picks.filter(p => p.predSource === 'manual').length} manual, ${picks.filter(p => p.modelPred == null).length} need model input)`);
  return picks;
}
 
// ─── ROUTES ───────────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({ status: 'Line Reaper backend running', version: '3.2.0', updated: new Date().toISOString() }));
 
// ── ESPORTS ENDPOINTS ─────────────────────────────────────────────────────────
app.get('/api/esports/picks', async (req, res) => {
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
 
app.post('/api/esports/refresh', async (req, res) => {
  await generateEsportsPicks();
  res.json({ ok: true, count: esportsCache.picks.length });
});
 
app.post('/api/esports/predict', (req, res) => {
  const { ppLine, modelPred, sport, propText, side } = req.body;
  if (!ppLine || !modelPred) return res.status(400).json({ error: 'ppLine and modelPred required' });
  const result = side
    ? calcEsportsEV(ppLine, modelPred, side, sport, propText)
    : predictEsportsSide(ppLine, modelPred, sport, propText);
  res.json(result);
});
 
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
 
  let owls = cache.owlsProps[sport]?.data;
  const owlsFresh = cache.owlsProps[sport]?.updated && (Date.now()-new Date(cache.owlsProps[sport].updated).getTime()) < 300000;
  if (!owlsFresh) owls = await fetchOwlsProps(sport);
 
  let oddsApi = cache.oddsApiProps[oddsKey]?.data;
  const oddsApiFresh = cache.oddsApiProps[oddsKey]?.updated && (Date.now()-new Date(cache.oddsApiProps[oddsKey].updated).getTime()) < 600000;
  if (!oddsApiFresh) oddsApi = await fetchOddsApiProps(oddsKey);
 
  let merged = mergeProps(owls, oddsApi);
 
  // FALLBACK: if nothing from Owls or Odds API, build from PP/UD data
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
 
// Regex path: works on both Express 4 and Express 5 (string '*' wildcards break on v5)
app.get(/^\/api\/owls\/(.*)$/, async (req, res) => {
  if (owlsDisabled()) return res.status(503).json({ error: 'Owls disabled — API key is dead (repeated 403s). Set OWLS_API_KEY and restart.' });
  const path = req.params[0], query = new URLSearchParams(req.query).toString();
  try {
    const r = await axios.get(`https://api.owlsinsight.com/api/v1/${path}${query?'?'+query:''}`, { headers: OWLS_HEADERS, timeout: 10000 });
    res.json(r.data);
  } catch(e) { noteOwlsError(e, `Owls proxy ${path}`); res.status(e.response?.status||500).json({ error: e.message }); }
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
  prizepicks: { count: cache.prizepicks.data?.length||0, updated: cache.prizepicks.updated, blocked: Date.now() < ppFail.until },
  underdog: { count: cache.underdog.data?.length||0, updated: cache.underdog.updated, sports: cache.udSportLabels },
  esports: {
    picks: esportsCache.picks.length,
    updated: esportsCache.lastUpdated,
    ppEsportsLines: (cache.prizepicks.data||[]).filter(l => isEsports(l.sport)).length,
    udEsportsLines: (cache.underdog.data||[]).filter(l => isEsports(l.sport)).length,
  },
  sharpMoves: cache.sharpMoves.length,
  owls: owlsDisabled() ? 'DISABLED — dead key (repeated 403s)' : 'active',
  oddsApiQuotaRemaining: cache.quotaRemaining,
  owlsProps: Object.entries(cache.owlsProps).map(([k,v])=>`${k}:${Array.isArray(v.data)?v.data.length:0}`).join(', ') || 'none',
  oddsApiProps: Object.entries(cache.oddsApiProps).map(([k,v])=>`${k}:${Array.isArray(v.data)?v.data.length:0}`).join(', ') || 'none',
}));
 
// ─── CRON JOBS ────────────────────────────────────────────────────────────────
// PP/UD scrapes (PP self-backs-off when blocked)
cron.schedule('*/2 * * * *', async () => { await Promise.all([scrapePrizePicks(), scrapeUnderdog()]); });
 
// Owls — fully skipped once the breaker trips
cron.schedule('*/30 * * * * *', async () => { if (!owlsDisabled()) for (const s of ['nba','mlb','nhl','nfl','mma']) fetchOwlsOdds(s); });
cron.schedule('*/5 * * * *', async () => { if (!owlsDisabled()) for (const s of ['nba','mlb','nhl','nfl','mma']) fetchOwlsProps(s); });
 
// Odds API props — 30-min staggered, in-season only (the guard inside skips off-season sports)
cron.schedule('0,30 * * * *', () => fetchOddsApiProps('basketball_nba'));
cron.schedule('3,33 * * * *', () => fetchOddsApiProps('baseball_mlb'));
cron.schedule('6,36 * * * *', () => fetchOddsApiProps('icehockey_nhl'));
cron.schedule('9,39 * * * *', () => fetchOddsApiProps('americanfootball_nfl'));
 
// REMOVED: the */3 fetchOddsForSport cron. It cost 4 sports x 3 markets every
// 3 minutes = ~5,700 Odds API credits per DAY, and nothing consumed it — the
// frontend fetches its own odds. /api/odds/:sport still works on demand.
 
// Esports: refresh picks every 5 min (runs off UD, PP joins when unblocked)
cron.schedule('*/5 * * * *', () => generateEsportsPicks().catch(()=>{}));
 
// ─── START ────────────────────────────────────────────────────────────────────
if (require.main === module) {
  app.listen(PORT, async () => {
    console.log(`Line Reaper v3.2 on port ${PORT}`);
    await Promise.all([scrapePrizePicks(), scrapeUnderdog()]);
    // One Owls call as a key check — if the key is dead, the breaker arms
    // quickly on the first cron cycle and everything goes quiet.
    fetchOwlsProps('mlb');
    // Stagger in-season Odds API prop fetches on startup
    const season = inSeasonSports();
    let delay = 3000;
    for (const s of ['basketball_nba','baseball_mlb','icehockey_nhl','americanfootball_nfl']) {
      if (!season.includes(s)) continue;
      setTimeout(() => fetchOddsApiProps(s), delay);
      delay += 4000;
    }
    // Generate esports picks once UD is loaded
    setTimeout(() => generateEsportsPicks().catch(()=>{}), 5000);
    console.log('Startup complete');
  });
}
 
module.exports = {
  app, cache, esportsCache,
  parseUnderdogPayload, normalizeName, normalizeMarket, isEsports,
  calcBookEV, calcEsportsEV, predictEsportsSide, generateEsportsPicks,
  getVarianceMultiplier, parseMapCount, inSeasonSports,
};
