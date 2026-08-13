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

// ONE parser for map spans, used by both the predictor and the cross-book key.
// Formats seen in the wild:
//   "Kills on Maps 1+2"    → maps 1,2      (2 maps)
//   "Kills on Maps 1+2+3"  → maps 1,2,3    (3 maps)  ← was silently read as 2
//   "MAPS 1-2 Kills"       → range 1..2    (2 maps)
//   "Kills on Maps 1-3"    → range 1..3    (3 maps)
//   "Kills on Map 1"       → map 1         (1 map)
//   "GAME 1+2+3 Kills"     → COD games     (3 maps)
// Returns { count, label } — label is the canonical span for cross-book keys.
function parseMapSpan(propText) {
  // "Maps 1 2" (Sleeper) → treat the space as a plus
  const t = (propText || '').toUpperCase().replace(/(\d)\s+(\d)/g, '$1+$2');
  const m = t.match(/(?:MAPS?|GAMES?)\s*([\d\s+\-–]+)/);
  if (!m) return { count: 1, label: '1' };
  const body = m[1].replace(/\s+/g, '');

  // Sum form: 1+2, 1+2+3 — count the terms
  if (body.includes('+')) {
    const nums = body.split('+').map(n => parseInt(n)).filter(n => isFinite(n));
    if (nums.length >= 2) return { count: nums.length, label: `${Math.min(...nums)}-${Math.max(...nums)}` };
  }
  // Range form: 1-2, 1-3 — inclusive span
  const r = body.match(/^(\d)[-–](\d)/);
  if (r) {
    const a = parseInt(r[1]), b = parseInt(r[2]);
    if (isFinite(a) && isFinite(b) && b >= a) return { count: b - a + 1, label: `${a}-${b}` };
  }
  const single = body.match(/^(\d)/);
  if (single) return { count: 1, label: single[1] };
  return { count: 1, label: '1' };
}

function parseMapCount(propText) { return parseMapSpan(propText).count; }

function predictKillsFromStats(player, sport, mapCount, propType = 'kills') {
  if (!player) return null;
  const s = (sport || '').toUpperCase();
  // bo3's schema is undocumented — its "maps" counter can turn out to be a
  // MATCH counter, which doubles every per-map rate. KPR is the one number
  // whose units can't be wrong, so it arbitrates:
  //  · derived rounds/map above 32 is impossible for CS → fall back to 21.5
  //  · if the per-map path disagrees with the KPR path by >40%, trust KPR
  const rpmRaw = player.roundsPerMap;
  const rpm = (rpmRaw && rpmRaw <= 32) ? rpmRaw : (s === 'VAL' ? 22 : 21.5);
  const viaRounds = player.kpr ? player.kpr * rpm * mapCount : null;
  let viaMap = player.avgKillsPerMap ? player.avgKillsPerMap * mapCount : null;
  if (viaMap != null && (viaMap / mapCount) > 32) viaMap = null;   // impossible per-map scale
  let pred;
  if (viaMap != null && viaRounds != null) {
    pred = Math.abs(viaMap - viaRounds) / viaRounds > 0.4 ? viaRounds : 0.5 * (viaMap + viaRounds);
  } else {
    pred = viaMap ?? viaRounds;
  }
  if (pred == null) return null;
  if ((propType || '').toLowerCase().includes('headshot')) {
    pred = pred * ((player.hsPercent ? player.hsPercent / 100 : null) || 0.45);
  }
  if (player.rating) pred *= 1 + (player.rating - 1.0) * 0.15;
  return pred;
}

// ─── MARKET ANCHORING ─────────────────────────────────────────────────────────
// Our auto-model knows a player's 90-day averages. It does NOT know tonight's
// opponent, the roster, the map pool, or whether he's on a stand-in. The book
// knows all of that, so a raw model number that disagrees with the line by 5
// kills is almost always OUR error — not a 30% edge. We therefore keep only a
// FRACTION of the disagreement:
//
//     final = line + w * (rawModel - line)
//
// w=0.35 by default (override with MODEL_WEIGHT env var). Sample size shrinks
// it further: a player with 8 tracked maps gets less trust than one with 60.
// Manual predictions are NEVER shrunk — those come from a real model.
// Effect: a raw 26.5 → 31.31 (+30% EV) becomes ~28.2 (~+6% EV), which is the
// range the paid model actually lives in.
const MODEL_WEIGHT = parseFloat(process.env.MODEL_WEIGHT || '0.35');

function anchorToMarket(rawPred, line, sampleSize) {
  if (!rawPred || !line) return rawPred;
  let w = MODEL_WEIGHT;
  if (sampleSize != null) {
    // full weight at 40+ tracked maps/games, scaled down below that
    w *= Math.min(1, Math.max(0.25, sampleSize / 40));
  }
  return line + w * (rawPred - line);
}

// Underdog labels some 3-map props "Kills on Maps 1+2". The string lies, but
// the numbers don't: divide the line by the player's own per-map rate and you
// get ~3.0 for those, ~1.6 for real 2-map lines. So when a line implies a
// LONGER span than the label claims, trust the arithmetic.
//
// Upward-only on purpose. A line that looks too SHORT is usually a genuine
// OVER edge, and rescaling it down would erase exactly the edges we want.
// Requires a clear gap (>=0.55 maps) so ordinary disagreement never triggers it.
function inferMapSpan(line, rawPred, parsedMaps) {
  if (!line || !rawPred || !parsedMaps) return null;
  const perMap = rawPred / parsedMaps;
  if (perMap <= 0) return null;
  const ratio = line / perMap;
  if (ratio - parsedMaps < 0.55) return null;
  const inferred = Math.min(3, Math.round(ratio));
  return inferred > parsedMaps ? inferred : null;
}

// A line implies a per-map rate. If that rate is impossible for the sport, the
// market string was parsed wrong (or the feed is bad) — refuse to model it
// rather than print a fake 30% edge. CS/VAL tops out around 20 kills a map for
// a superstar; anything past 24 means our map span is off.
function lineIsPlausible(line, mapCount, sport, market) {
  if (!line || !mapCount) return true;
  const s = (sport || '').toUpperCase(), m = (market || '').toLowerCase();
  const perMap = line / mapCount;
  if (m.includes('fantasy')) return true;                 // different scale entirely
  if (s.includes('CS') || s.includes('VAL')) {
    const cap = m.includes('headshot') ? (mapCount > 1 ? 12 : 15) : (mapCount > 1 ? 20 : 24);
    return perMap <= cap;
  }
  if (s.includes('LOL') || s.includes('LEAGUE')) {
    return m.includes('assist') ? perMap <= 30 : perMap <= 16;
  }
  if (s.includes('DOTA')) return m.includes('assist') ? perMap <= 40 : perMap <= 22;
  if (s.includes('COD')) return perMap <= 45;
  return true;
}

// Sanity gate for auto-predictions: beyond 20% off the line is usually a bad
// scrape — EXCEPT on tiny lines (a 1.5-kill LoL support prop), where a 1-kill
// difference is a legit 60% deviation. Absolute tolerance covers those.
function autoPredAcceptable(pred, line) {
  if (!pred || !line) return false;
  return Math.abs(pred - line) / line <= 0.20 || Math.abs(pred - line) <= 2.0;
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

// ─── VALORANT VIA VLR.GG MIRROR ───────────────────────────────────────────────
// Was: one region (NA) + exact name match, which is why VAL never populated —
// most pros aren't NA and DFS books spell names with different casing/tags.
// Now: every region pulled once into a normalized table, refreshed hourly.
const VLR_REGIONS = ['na', 'eu', 'ap', 'sa', 'jp', 'oce', 'mn'];
const vlrTable = { players: {}, updated: null, regions: {}, lastError: null };

function vlrNum(v) {
  if (v == null) return null;
  const n = parseFloat(String(v).replace('%', '').trim());
  return isFinite(n) ? n : null;
}

// Normalized key so "TenZ", "tenz", and "SEN TenZ" all resolve
const vlrKey = n => (n || '').toLowerCase().replace(/[^a-z0-9]/g, '');

function vlrIngestSegments(segments, region) {
  let added = 0;
  for (const s of (segments || [])) {
    const name = s.player || s.name;
    if (!name) continue;
    const kpr = vlrNum(s.kills_per_round ?? s.kpr);
    const hs = vlrNum(s.headshot_percentage ?? s.hs_percent);
    const rating = vlrNum(s.rating);
    const acs = vlrNum(s.average_combat_score ?? s.acs);
    const rounds = vlrNum(s.rounds_played ?? s.rounds);
    if (kpr == null && acs == null) continue;
    const key = vlrKey(name);
    const prev = vlrTable.players[key];
    // keep the entry with the larger sample when a player appears in 2 regions
    if (prev && (prev.rounds || 0) >= (rounds || 0)) continue;
    vlrTable.players[key] = {
      name, region, kpr, hsPercent: hs, rating, acs, rounds,
      roundsPerMap: 22, source: 'vlr', lastUpdate: Date.now(),
    };
    added++;
  }
  vlrTable.regions[region] = added;
  return added;
}

async function refreshVLRTable(timespan = 60) {
  let total = 0;
  const errs = [];
  for (const region of VLR_REGIONS) {
    try {
      const res = await axios.get('https://vlrggapi.vercel.app/stats', {
        params: { region, timespan }, timeout: 20000,
        headers: { 'User-Agent': 'LineReaper/3.7', 'Accept': 'application/json' },
      });
      const segs = res.data?.data?.segments || res.data?.segments || [];
      total += vlrIngestSegments(segs, region);
      await new Promise(r => setTimeout(r, 200));
    } catch (e) {
      errs.push(`${region}:${e.response?.status || e.message}`);
    }
  }
  vlrTable.updated = new Date().toISOString();
  vlrTable.lastError = errs.length ? errs.join(', ') : null;
  console.log(`VLR: ${Object.keys(vlrTable.players).length} players across ${Object.keys(vlrTable.regions).length} regions${errs.length ? ' (errors: ' + errs.join(', ') + ')' : ''}`);
  return total;
}

async function fetchVLRPlayerStats(playerName) {
  if (!vlrTable.updated || (Date.now() - Date.parse(vlrTable.updated)) > 3600000) {
    await refreshVLRTable().catch(() => {});
  }
  const key = vlrKey(playerName);
  let hit = vlrTable.players[key];
  if (!hit) {
    // DFS books sometimes prefix the org ("SEN TenZ") — try the last token
    const tail = vlrKey((playerName || '').split(/\s+/).pop());
    hit = vlrTable.players[tail];
  }
  if (!hit) return null;
  // shape it like the CS profile so predictKillsFromStats works unchanged
  return {
    name: hit.name, kpr: hit.kpr, hsPercent: hit.hsPercent, rating: hit.rating,
    roundsPerMap: hit.roundsPerMap, mapsPlayed: hit.rounds ? Math.round(hit.rounds / 22) : null,
    lastUpdate: hit.lastUpdate, source: 'vlr',
  };
}

// ─── DOTA 2 VIA OPENDOTA ──────────────────────────────────────────────────────
// Free public API, no key. Pro player directory → recent match kills.
// Two calls per player, cached 12h, so the per-cycle lookup budget still applies.
const dotaCache = { proPlayers: null, proFetched: 0, players: {}, lastError: null };

async function dotaLoadProPlayers() {
  if (dotaCache.proPlayers && (Date.now() - dotaCache.proFetched) < 24 * 3600000) return dotaCache.proPlayers;
  const res = await axios.get('https://api.opendota.com/api/proPlayers', { timeout: 25000 });
  const arr = Array.isArray(res.data) ? res.data : [];
  const byName = {};
  for (const p of arr) {
    for (const n of [p.name, p.personaname]) {
      if (!n) continue;
      const k = vlrKey(n);
      if (k && !byName[k]) byName[k] = p.account_id;
    }
  }
  dotaCache.proPlayers = byName;
  dotaCache.proFetched = Date.now();
  console.log(`OpenDota: ${Object.keys(byName).length} pro player names indexed`);
  return byName;
}

async function fetchDotaPlayerStats(playerName) {
  const key = vlrKey(playerName);
  const cached = dotaCache.players[key];
  if (cached && (Date.now() - cached.lastUpdate) < 12 * 3600000) return cached.failed ? null : cached;
  try {
    const dir = await dotaLoadProPlayers();
    const accountId = dir[key] || dir[vlrKey((playerName || '').split(/\s+/).pop())];
    if (!accountId) {
      dotaCache.players[key] = { failed: true, lastUpdate: Date.now() };
      return null;
    }
    const res = await axios.get(`https://api.opendota.com/api/players/${accountId}/matches`, {
      params: { limit: 40, significant: 1 }, timeout: 20000,
    });
    const ms = (Array.isArray(res.data) ? res.data : []).filter(m => m && isFinite(m.kills));
    if (ms.length < 5) {
      dotaCache.players[key] = { failed: true, lastUpdate: Date.now() };
      return null;
    }
    const kills = ms.reduce((s, m) => s + m.kills, 0) / ms.length;
    const assists = ms.reduce((s, m) => s + (m.assists || 0), 0) / ms.length;
    const stats = {
      name: playerName, accountId, avgKillsPerMap: kills, avgAssistsPerMap: assists,
      mapsPlayed: ms.length, lastUpdate: Date.now(), source: 'opendota',
    };
    dotaCache.players[key] = stats;
    console.log(`OpenDota ${playerName}: ${kills.toFixed(1)} kills/game over ${ms.length} matches`);
    return stats;
  } catch (e) {
    dotaCache.lastError = `${playerName}: ${e.response?.status || e.message}`;
    dotaCache.players[key] = { failed: true, lastUpdate: Date.now() };
    return null;
  }
}

// ─── CS STATS VIA BO3.GG ──────────────────────────────────────────────────────
// HLTV blocks datacenter IPs; bo3.gg is the standard server-friendly equivalent.
// Schema isn't documented, so field extraction probes several plausible names,
// logs the real keys once, and /api/esports/probe/cs/:name exposes raw payloads.
const BO3_BASE = 'https://api.bo3.gg/api/v1';
const BO3_HEADERS = {
  'authority': 'api.bo3.gg',
  'origin': 'https://bo3.gg',
  'referer': 'https://bo3.gg/',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  'Accept': 'application/json',
};

function bo3Pick(obj, keys) {
  if (!obj || typeof obj !== 'object') return null;
  for (const k of keys) {
    const v = obj[k];
    if (v != null && v !== '' && isFinite(parseFloat(v))) return parseFloat(v);
  }
  return null;
}
function bo3FirstObject(x) {
  if (!x) return null;
  if (Array.isArray(x)) return x[0] || null;
  if (x.data) return bo3FirstObject(x.data);
  if (x.results) return bo3FirstObject(x.results);
  return typeof x === 'object' ? x : null;
}
let bo3LoggedKeys = false;
const bo3Health = { profiles: 0, lastError: null, predsAccepted: 0, predsRejected: 0, lastRejected: null };

async function bo3SearchPlayer(name) {
  const res = await axios.get(`${BO3_BASE}/filters/players`, {
    headers: BO3_HEADERS, timeout: 12000,
    params: { 'page[offset]': '0', 'page[limit]': '4', 'filter[discipline_id][eq]': '1', 'with': 'country', 'search_text': name }
  });
  const raw = res.data?.data || res.data?.players || res.data?.results || res.data || [];
  const arr = Array.isArray(raw) ? raw : [];
  const exact = arr.find(p => (p.nickname || p.name || p.slug || '').toLowerCase() === name.toLowerCase());
  const hit = exact || arr[0];
  if (!hit) return null;
  return { slug: hit.slug || hit.id, name: hit.nickname || hit.name || name };
}

async function bo3RawStats(slug) {
  const today = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
  const [gen, map, acc] = await Promise.all([
    axios.get(`${BO3_BASE}/players/${slug}/general_stats`, { headers: BO3_HEADERS, timeout: 12000,
      params: { 'filter[start_date_to]': today, 'filter[start_date_from]': from } }).then(r => r.data).catch(() => null),
    axios.get(`${BO3_BASE}/players/${slug}/map_stats`, { headers: BO3_HEADERS, timeout: 12000,
      params: { 'filter[begin_at_to]': today, 'filter[begin_at_from]': from } }).then(r => r.data).catch(() => null),
    axios.get(`${BO3_BASE}/players/${slug}/accuracy_stats`, { headers: BO3_HEADERS, timeout: 12000,
      params: { 'filter[begin_at_to]': today, 'filter[begin_at_from]': from } }).then(r => r.data).catch(() => null),
  ]);
  return { gen, map, acc };
}

function bo3ExtractProfile(playerName, gen, map, acc) {
  const g = bo3FirstObject(gen), m = bo3FirstObject(map), a = bo3FirstObject(acc);
  if (!bo3LoggedKeys && (g || m || a)) {
    bo3LoggedKeys = true;
    console.log('bo3 schema — general:', g ? Object.keys(g).slice(0, 25).join(',') : 'none',
      '| map:', m ? Object.keys(m).slice(0, 25).join(',') : 'none',
      '| accuracy:', a ? Object.keys(a).slice(0, 25).join(',') : 'none');
  }
  const kpr = bo3Pick(g, ['kpr', 'kills_per_round', 'avg_kills_per_round', 'killsPerRound']);
  const kills = bo3Pick(g, ['kills', 'total_kills', 'kills_count', 'kills_sum']);
  const rounds = bo3Pick(g, ['rounds', 'rounds_count', 'total_rounds', 'round_count']);
  const mapsPlayed = bo3Pick(g, ['maps', 'maps_count', 'maps_played', 'matches_count'])
    ?? bo3Pick(m, ['maps_count', 'count', 'total']);
  const rating = bo3Pick(g, ['rating', 'player_rating', 'hltv_rating', 'rating_avg']);
  let hsPercent = bo3Pick(a, ['headshot_accuracy', 'hs_accuracy', 'headshots_percentage', 'hs_percent', 'headshot_percent'])
    ?? bo3Pick(g, ['headshots_percentage', 'hs_percent', 'headshot_percent']);

  const stats = { name: playerName, lastUpdate: Date.now(), source: 'bo3' };
  if (kpr) stats.kpr = kpr;
  else if (kills && rounds) stats.kpr = kills / rounds;
  if (kills && mapsPlayed) stats.avgKillsPerMap = kills / mapsPlayed;
  if (rounds && mapsPlayed) stats.roundsPerMap = rounds / mapsPlayed;
  if (rating) stats.rating = rating;
  if (hsPercent != null) stats.hsPercent = hsPercent > 1 ? hsPercent : hsPercent * 100;
  return (stats.kpr || stats.avgKillsPerMap) ? stats : null;
}

async function fetchBo3PlayerStats(playerName) {
  const key = playerName.toLowerCase();
  const cached = esportsCache.hltvPlayers[key];
  if (cached?.failed && (Date.now() - cached.lastUpdate) < 30 * 60000) return null;   // don't re-burn on recent misses
  if (cached && !cached.failed && (Date.now() - cached.lastUpdate) < 6 * 3600000) return cached;
  try {
    const found = await bo3SearchPlayer(playerName);
    if (!found?.slug) {
      bo3Health.lastError = `no search hit for "${playerName}"`;
      esportsCache.hltvPlayers[key] = { name: playerName, failed: true, lastUpdate: Date.now() };
      console.warn(`bo3 ${playerName}: no search hit`);
      return null;
    }
    const { gen, map, acc } = await bo3RawStats(found.slug);
    const stats = bo3ExtractProfile(playerName, gen, map, acc);
    if (stats) {
      esportsCache.hltvPlayers[key] = stats;
      bo3Health.profiles++;
      console.log(`bo3 ${playerName}: KPM=${stats.avgKillsPerMap?.toFixed(1) ?? '—'} KPR=${stats.kpr?.toFixed(2) ?? '—'} HS%=${stats.hsPercent?.toFixed(0) ?? '—'} R=${stats.rating ?? '—'}`);
      return stats;
    }
    bo3Health.lastError = `fields unrecognized for "${playerName}" — see /api/esports/probe/cs/${playerName}`;
    esportsCache.hltvPlayers[key] = { name: playerName, failed: true, lastUpdate: Date.now() };
    console.warn(`bo3 ${playerName}: no usable kill fields — inspect /api/esports/probe/cs/${encodeURIComponent(playerName)}`);
    return null;
  } catch (e) {
    const s = e.response?.status;
    bo3Health.lastError = `HTTP ${s || e.message}`;
    esportsCache.hltvPlayers[key] = { name: playerName, failed: true, lastUpdate: Date.now() };
    console.warn(`bo3 ${playerName}:`, s || e.message);
    return null;
  }
}

// ─── LOL STATS VIA ORACLE'S ELIXIR ────────────────────────────────────────────
// Daily-updated yearly CSV covering every pro league (LCK, LCK CL, LPL, ...).
// Parsed strictly BY HEADER NAME — OE adds columns and positions shift.
// Tried in order until one works; the S3 bucket has used both region-url styles.
const OE_HOSTS = [
  'https://oracleselixir-downloadable-match-data.s3-us-west-2.amazonaws.com',
  'https://oracleselixir-downloadable-match-data.s3.us-west-2.amazonaws.com',
];

function parseS3Keys(xml) {
  const keys = [];
  const re = /<Key>([^<]+)<\/Key>/g;
  let m;
  while ((m = re.exec(xml || ''))) keys.push(m[1]);
  return keys;
}

// The plain yearly filename 404s sometimes (dated snapshots, renames). If the
// bucket allows public listing, enumerate its keys and pick the right one.
async function oeDiscoverUrl() {
  const y = new Date().getFullYear();
  for (const host of OE_HOSTS) {
    try {
      const res = await axios.get(`${host}/?list-type=2&prefix=${y}`, { timeout: 20000 });
      const keys = parseS3Keys(res.data).filter(k => k.includes('OraclesElixir') && k.endsWith('.csv'));
      if (!keys.length) continue;
      const exact = keys.find(k => k === `${y}_LoL_esports_match_data_from_OraclesElixir.csv`);
      const key = exact || keys.sort().pop();   // latest dated snapshot
      console.log('OE: bucket listing found', keys.length, 'file(s); using', key);
      return `${host}/${encodeURIComponent(key)}`;
    } catch (e) {
      console.warn('OE: bucket listing failed on', host.slice(8, 40), '—', e.response?.status || e.message);
    }
  }
  return null;
}

async function oeCandidateUrls() {
  const y = new Date().getFullYear();
  const f = `${y}_LoL_esports_match_data_from_OraclesElixir.csv`;
  const discovered = await oeDiscoverUrl();
  return [...new Set([
    process.env.OE_URL || null,
    discovered,
    `${OE_HOSTS[0]}/${f}`,
    `${OE_HOSTS[1]}/${f}`,
  ].filter(Boolean))];
}

const lolStats = { players: {}, teams: {}, games: 0, updated: null, state: 'idle', lastError: null, source: null };

function parseCsvLine(line) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

// Streaming aggregator (pure, unit-tested): fold rows one at a time,
// pair each game's two team rows to get kills-allowed, derive per-player
// kills/game + kill share of team, per-team pace.
function createOEAggregator(headerCols, sinceMs) {
  const col = {};
  headerCols.forEach((h, i) => col[String(h).trim().toLowerCase()] = i);
  const need = ['gameid', 'date', 'position', 'playername', 'teamname', 'kills', 'league'];
  for (const n of need) if (col[n] == null) throw new Error(`OE csv missing column "${n}" — schema changed; check oracleselixir.com/tools/downloads`);
  const aCol = col['assists'];   // optional — assists model skips gracefully if OE drops it

  const players = {}, teams = {}, gameTeams = {};
  let games = 0;

  return {
    push(cells) {
      const d = Date.parse(cells[col['date']]);
      if (!isFinite(d) || d < sinceMs) return;
      const pos = (cells[col['position']] || '').toLowerCase();
      const team = cells[col['teamname']] || '';
      const kills = parseFloat(cells[col['kills']]) || 0;
      const gid = cells[col['gameid']];

      if (pos === 'team') {
        const tk = team.toLowerCase();
        const T = teams[tk] || (teams[tk] = { name: team, games: 0, kills: 0, killsAllowed: 0, assists: 0 });
        T.games++; T.kills += kills;
        if (aCol != null) T.assists += parseFloat(cells[aCol]) || 0;
        const gt = gameTeams[gid] || (gameTeams[gid] = []);
        gt.push({ team: tk, kills });
        if (gt.length === 2) {
          teams[gt[0].team].killsAllowed += gt[1].kills;
          teams[gt[1].team].killsAllowed += gt[0].kills;
          games++;
          delete gameTeams[gid];
        }
      } else {
        const name = (cells[col['playername']] || '').toLowerCase();
        if (!name) return;
        const P = players[name] || (players[name] = { name: cells[col['playername']], team: '', games: 0, kills: 0, assists: 0, league: '' });
        P.games++; P.kills += kills;
        if (aCol != null) P.assists += parseFloat(cells[aCol]) || 0;
        P.team = team; P.league = cells[col['league']] || P.league;
      }
    },
    finish() {
      for (const p of Object.values(players)) {
        p.kpg = p.games ? p.kills / p.games : 0;
        p.apg = p.games ? p.assists / p.games : 0;
        const T = teams[(p.team || '').toLowerCase()];
        p.teamKpg = T && T.games ? T.kills / T.games : null;
        p.teamApg = T && T.games ? T.assists / T.games : null;
        p.oppKillsAllowedPg = T && T.games ? T.killsAllowed / T.games : null;
        p.killShare = p.teamKpg ? p.kpg / p.teamKpg : null;
        p.assistShare = p.teamApg ? p.apg / p.teamApg : null;
      }
      for (const t of Object.values(teams)) {
        t.kpg = t.games ? t.kills / t.games : 0;
        t.kapg = t.games ? t.killsAllowed / t.games : 0;
      }
      return { players, teams, games };
    }
  };
}

// ─── LOL FALLBACK: LEAGUEPEDIA CARGO API ──────────────────────────────────────
// Oracle's Elixir publishes one CSV per year at a URL that moves; Leaguepedia
// is a public JSON API with no key and no moving parts. Rows are per-player,
// per-game scoreboard lines, so team totals are derived by summing each team's
// players within a game — which also yields kills-allowed from the opponent.
const LP_API = 'https://lol.fandom.com/api.php';

async function lpFetchPage(sinceDate, offset, limit = 500) {
  const params = {
    action: 'cargoquery', format: 'json', limit: String(limit), offset: String(offset),
    tables: 'ScoreboardPlayers=SP,ScoreboardGames=SG',
    join_on: 'SP.GameId=SG.GameId',
    fields: 'SP.Link=Link,SP.Team=Team,SP.Kills=Kills,SP.Assists=Assists,SP.GameId=GameId,SG.DateTime_UTC=DateTime',
    where: `SG.DateTime_UTC >= '${sinceDate}'`,
    order_by: 'SG.DateTime_UTC DESC',
  };
  const res = await axios.get(LP_API, { params, timeout: 30000,
    headers: { 'User-Agent': 'LineReaper/3.5 (personal analytics)', 'Accept': 'application/json' } });
  if (res.data?.error) throw new Error('Cargo error: ' + JSON.stringify(res.data.error).slice(0, 200));
  return (res.data?.cargoquery || []).map(r => r.title || r);
}

// Pure aggregator — same output shape as the OE one, unit-tested offline.
function aggregateLPRows(rows) {
  const players = {}, teams = {}, games = {};
  for (const r of rows) {
    const name = (r.Link || '').trim();
    const team = (r.Team || '').trim();
    const gid = r.GameId || '';
    const k = parseFloat(r.Kills) || 0;
    const a = parseFloat(r.Assists) || 0;
    if (!name || !team || !gid) continue;
    const key = name.toLowerCase();
    const P = players[key] || (players[key] = { name, team: '', games: 0, kills: 0, assists: 0, league: 'LP' });
    P.games++; P.kills += k; P.assists += a; P.team = team;
    const G = games[gid] || (games[gid] = {});
    const T = G[team] || (G[team] = { kills: 0, assists: 0 });
    T.kills += k; T.assists += a;
  }
  // team per-game aggregates + kills allowed from the opposing side
  for (const G of Object.values(games)) {
    const sides = Object.entries(G);
    if (sides.length !== 2) continue;
    for (let i = 0; i < 2; i++) {
      const [name, own] = sides[i], [, opp] = sides[1 - i];
      const tk = name.toLowerCase();
      const T = teams[tk] || (teams[tk] = { name, games: 0, kills: 0, assists: 0, killsAllowed: 0 });
      T.games++; T.kills += own.kills; T.assists += own.assists; T.killsAllowed += opp.kills;
    }
  }
  for (const p of Object.values(players)) {
    p.kpg = p.games ? p.kills / p.games : 0;
    p.apg = p.games ? p.assists / p.games : 0;
    const T = teams[(p.team || '').toLowerCase()];
    p.teamKpg = T && T.games ? T.kills / T.games : null;
    p.teamApg = T && T.games ? T.assists / T.games : null;
    p.oppKillsAllowedPg = T && T.games ? T.killsAllowed / T.games : null;
    p.killShare = p.teamKpg ? p.kpg / p.teamKpg : null;
    p.assistShare = p.teamApg ? p.apg / p.teamApg : null;
  }
  for (const t of Object.values(teams)) {
    t.kpg = t.games ? t.kills / t.games : 0;
    t.kapg = t.games ? t.killsAllowed / t.games : 0;
  }
  return { players, teams, games: Object.keys(games).length };
}

async function refreshLoLFromLeaguepedia(windowDays = 120) {
  const since = new Date(Date.now() - windowDays * 86400000).toISOString().slice(0, 10);
  const rows = [];
  for (let page = 0; page < 24; page++) {          // up to 12k rows
    const batch = await lpFetchPage(since, page * 500);
    rows.push(...batch);
    if (batch.length < 500) break;
    await new Promise(r => setTimeout(r, 250));    // be polite to the wiki
  }
  if (!rows.length) throw new Error('no rows returned');
  const out = aggregateLPRows(rows);
  Object.assign(lolStats, out, { updated: new Date().toISOString(), state: 'ready', lastError: null, source: 'leaguepedia' });
  console.log(`Leaguepedia: ${rows.length} scoreboard rows → ${Object.keys(out.players).length} players, ${Object.keys(out.teams).length} teams, ${out.games} games (last ${windowDays}d)`);
  generateEsportsPicks().catch(() => {});
}

async function refreshLoLStats(windowDays = 120) {
  if (lolStats.state === 'downloading') return;
  lolStats.state = 'downloading';
  const errors = [];
  for (const url of await oeCandidateUrls()) {
    try {
      console.log('OE: downloading', url.slice(0, 90), '...');
      const res = await axios.get(url, { responseType: 'stream', timeout: 180000, maxRedirects: 5 });
      const sinceMs = Date.now() - windowDays * 86400000;
      let agg = null, carry = '', bytes = 0;
      await new Promise((resolve, reject) => {
        res.data.on('data', chunk => {
          bytes += chunk.length;
          carry += chunk.toString('utf8');
          let idx;
          while ((idx = carry.indexOf('\n')) >= 0) {
            const line = carry.slice(0, idx).replace(/\r$/, '');
            carry = carry.slice(idx + 1);
            if (!agg) agg = createOEAggregator(parseCsvLine(line), sinceMs);
            else if (line) agg.push(parseCsvLine(line));
          }
        });
        res.data.on('end', resolve);
        res.data.on('error', reject);
      });
      if (carry.trim() && agg) agg.push(parseCsvLine(carry));
      if (!agg) throw new Error('empty CSV');
      const out = agg.finish();
      Object.assign(lolStats, out, { updated: new Date().toISOString(), state: 'ready', lastError: null });
      console.log(`OE: ${(bytes / 1048576).toFixed(1)}MB → ${Object.keys(out.players).length} players, ${Object.keys(out.teams).length} teams, ${out.games} games (last ${windowDays}d)`);
      generateEsportsPicks().catch(() => {});
      return;
    } catch (e) {
      const s = e.response?.status;
      errors.push(`${url.split('/').pop().slice(0, 40)} → ${s || e.message}`);
      console.warn('OE attempt failed:', s || e.message);
    }
  }
  console.warn('OE: all URL candidates failed —', errors.join(' | '), '· falling back to Leaguepedia');
  try {
    await refreshLoLFromLeaguepedia(windowDays);
    return;
  } catch (e2) {
    lolStats.state = 'error';
    lolStats.lastError = `OE: ${errors.join(' | ')} · Leaguepedia: ${e2.message}`;
    console.warn('Leaguepedia fallback also failed:', e2.message,
      '· inspect /api/esports/probe/lolsource for the raw response. Auto-retrying every 30 min.');
  }
}

// Lifetime rate blended with kill-share formulation:
//   half player's own kills/game, half (share of team kills × team pace).
// Identical today, but the share half becomes opponent-aware once lines
// carry match context (then team pace blends with opponent kills-allowed).
function predictLoLStat(playerName, mapCount, stat = 'kills') {
  const p = lolStats.players[(playerName || '').toLowerCase()];
  if (!p || !p.games || p.games < 4) return null;
  let perGame, share, teamPg;
  if (stat === 'assists') { perGame = p.apg; share = p.assistShare; teamPg = p.teamApg; }
  else { perGame = p.kpg; share = p.killShare; teamPg = p.teamKpg; }
  if (!perGame) return null;
  if (share && teamPg) perGame = 0.5 * perGame + 0.5 * (share * teamPg);
  return perGame * (mapCount || 1);
}
function predictLoLKills(playerName, mapCount) { return predictLoLStat(playerName, mapCount, 'kills'); }

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
  // "Kills Maps 1 2" (Sleeper) uses spaces — normalize to the + form first
  let mapCount = parseMapSpan(s.replace(/(\d)\s+(\d)/g, '$1+$2')).label;
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
  const MAX_FRESH_LOOKUPS = 40;
  const implausibleLines = [];
  const spanCounts = { inferred: 0 };

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
    let rawPred = null, sampleSize = null, spanInferred = null, statLine = null;

    if (modelPred == null) {
      const sportU = (lineObj.sport || '').toUpperCase();
      const mapCount = parseMapCount(lineObj.market);
      const plausible = lineIsPlausible(lineObj.line, mapCount, sportU, lineObj.market);
      if (!plausible) {
        implausibleLines.push(`${lineObj.player} · ${lineObj.market} · line ${lineObj.line} / ${mapCount} maps`);
      }
      let sportKey = null;
      if (sportU.includes('VAL')) sportKey = 'VAL';
      else if (sportU.includes('CS') || sportU.includes('COUNTER')) sportKey = 'CS';
      else if (sportU.includes('LOL') || sportU.includes('LEAGUE')) sportKey = 'LOL';
      else if (sportU.includes('DOTA')) sportKey = 'DOTA';

      let autoPred = null;
      if (sportKey === 'LOL') {
        // Oracle's Elixir aggregates are in memory — no lookup budget needed
        const mk = (lineObj.market || '').toLowerCase();
        if (mk.includes('fantasy')) autoPred = null;   // FP needs the book's scoring formula — manual for now
        else autoPred = predictLoLStat(lineObj.player, mapCount, mk.includes('assist') ? 'assists' : 'kills');
        const lp = lolStats.players[(lineObj.player || '').toLowerCase()];
        sampleSize = lp?.games ?? null;
        if (lp) statLine = `${lp.kpg.toFixed(1)} k/game · ${lp.apg.toFixed(1)} a/game · ${(lp.killShare != null ? (lp.killShare * 100).toFixed(0) + '% of team kills · ' : '')}${lp.games} games`;
      } else if (sportKey === 'VAL') {
        // VLR table is loaded in bulk and cached — no per-player budget needed
        const player = await fetchVLRPlayerStats(lineObj.player);
        if (player) {
          autoPred = predictKillsFromStats(player, 'VAL', mapCount, lineObj.market);
          sampleSize = player.mapsPlayed ?? null;
          statLine = describePlayer(player);
        }
      } else if (sportKey === 'DOTA') {
        const hasCached = !!dotaCache.players[vlrKey(lineObj.player)];
        if (hasCached || freshLookups < MAX_FRESH_LOOKUPS) {
          if (!hasCached) freshLookups++;
          const player = await fetchDotaPlayerStats(lineObj.player);
          if (player) {
            const mk = (lineObj.market || '').toLowerCase();
            const per = mk.includes('assist') ? player.avgAssistsPerMap : player.avgKillsPerMap;
            if (per) autoPred = per * mapCount;
            sampleSize = player.mapsPlayed ?? null;
            statLine = `${player.avgKillsPerMap.toFixed(1)} k/game · ${player.avgAssistsPerMap.toFixed(1)} a/game · ${player.mapsPlayed} matches`;
          }
        }
      } else if (sportKey) {
        let player = null;
        const hasCached = !!esportsCache.hltvPlayers[(lineObj.player || '').toLowerCase()];
        if (hasCached || freshLookups < MAX_FRESH_LOOKUPS) {
          if (!hasCached) freshLookups++;
          player = await fetchBo3PlayerStats(lineObj.player);
        }
        if (player) {
          autoPred = predictKillsFromStats(player, sportKey, mapCount, lineObj.market);
          sampleSize = player.mapsPlayed ?? null;
          statLine = describePlayer(player);
        }
      }
      rawPred = autoPred;

      // The label may understate the map span — rescale from the player's own
      // per-map rate before pricing, and record that we did.
      if (autoPred && sportKey !== 'LOL') {
        const inferred = inferMapSpan(lineObj.line, autoPred, mapCount);
        if (inferred) {
          const perMap = autoPred / mapCount;
          autoPred = perMap * inferred;
          rawPred = autoPred;
          spanInferred = inferred;
          spanCounts.inferred++;
        }
      }

      // Never auto-model a line whose implied per-map rate is impossible
      autoPred = plausible ? anchorToMarket(autoPred, lineObj.line, sampleSize) : null;

      // SANITY GATE — his rule, kept: big % deviations are usually bad data,
      // with an absolute-diff pass for tiny LoL lines.
      if (autoPred && lineObj.line) {
        if (autoPredAcceptable(autoPred, lineObj.line)) {
          modelPred = autoPred;
          predSource = 'auto';
          if (sportKey === 'CS') bo3Health.predsAccepted++;
        } else {
          if (sportKey === 'CS') {
            bo3Health.predsRejected++;
            bo3Health.lastRejected = `${lineObj.player} line ${lineObj.line} → pred ${autoPred.toFixed(1)}`;
          }
          console.log(`Esports: rejected auto-pred for ${lineObj.player} (line=${lineObj.line}, pred=${autoPred.toFixed(1)}, ${(Math.abs(autoPred - lineObj.line) / lineObj.line * 100).toFixed(0)}% diff)`);
        }
      }
    }
    return { modelPred, predSource, manualKey, rawPred, sampleSize, spanInferred, statLine };
  }

  // Build one pick object. Only books that ACTUALLY carry the line get an EV —
  // no more fabricated Betr/ParlayPlay/Sleeper numbers with default multipliers.
  function assemble(base, modelPred, predSource, manualKey, udm, lineSource, g = {}) {
    const lineVal = base.line;
    const pick = {
      sport: base.sport, player: base.player, team: base.team || '', market: base.market,
      ppLine: lineVal, startTime: base.startTime || '', lineSource,
      modelPred: modelPred != null ? parseFloat(modelPred.toFixed(2)) : null,
      predSource: modelPred != null ? predSource : null,
      rawPred: (predSource === 'auto' && g.rawPred != null) ? parseFloat(g.rawPred.toFixed(2)) : null,
      sampleSize: g.sampleSize ?? null,
      spanInferred: g.spanInferred ?? null,
      statLine: g.statLine ?? null,
      edge: null, edgePct: null,
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
    // How far our number sits from the book's, in stat units and percent
    pick.edge = parseFloat((modelPred - lineVal).toFixed(2));
    pick.edgePct = parseFloat(((modelPred - lineVal) / lineVal * 100).toFixed(1));
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
    const g = await getModelPred(line);
    picks.push(assemble(line, g.modelPred, g.predSource, g.manualKey, udm, 'pp', g));
  }

  // UD lines with no PP counterpart — the board stays full even when PP is blocked
  for (const udm of Object.values(udMap)) {
    if (udm.matched) continue;
    const base = { sport: udm.sport, player: udm.player, team: udm.team, market: udm.market, line: udm.line, startTime: udm.startTime };
    const g = await getModelPred(base);
    picks.push(assemble(base, g.modelPred, g.predSource, g.manualKey, udm, 'ud', g));
  }

  if (implausibleLines.length) {
    esportsCache.implausible = implausibleLines.slice(0, 20);
    console.warn(`Esports: ${implausibleLines.length} lines skipped as implausible (market string may be parsed wrong) e.g. ${implausibleLines[0]}`);
  } else esportsCache.implausible = [];
  esportsCache.spanInferred = spanCounts.inferred;
  if (spanCounts.inferred) console.log(`Esports: ${spanCounts.inferred} picks rescaled — line implied a longer map span than the market label claimed`);

  picks.sort((a, b) => (b.bestEv ?? -999) - (a.bestEv ?? -999));
  esportsCache.picks = picks;
  esportsCache.lastUpdated = new Date().toISOString();
  console.log(`Esports: generated ${picks.length} picks (${picks.filter(p => p.lineSource === 'ud').length} UD-sourced, ${picks.filter(p => p.predSource === 'manual').length} manual, ${picks.filter(p => p.modelPred == null).length} need model input)`);
  return picks;
}

// One-line "why this number" summary shown under each pick.
function describePlayer(p) {
  if (!p) return null;
  const bits = [];
  if (p.avgKillsPerMap) bits.push(`${p.avgKillsPerMap.toFixed(1)} k/map`);
  else if (p.kpr) bits.push(`${(p.kpr * (p.roundsPerMap || 21.5)).toFixed(1)} k/map`);
  if (p.kpr) bits.push(`${p.kpr.toFixed(2)} KPR`);
  if (p.hsPercent) bits.push(`${p.hsPercent.toFixed(0)}% HS`);
  if (p.rating) bits.push(`${p.rating.toFixed(2)} rating`);
  if (p.mapsPlayed) bits.push(`${p.mapsPlayed} maps`);
  return bits.join(' · ') || null;
}

// ─── CS PROFILE WARMER ────────────────────────────────────────────────────────
// A pick only gets an EV once its player has a stats profile. Pick generation
// fetches at most MAX_FRESH_LOOKUPS new players per cycle (to stay fast), and
// the whole cache is lost on redeploy — which is why the board can show 700
// lines but only ~50 priced. This warmer walks the board in the background and
// fills the gaps a few players at a time until coverage is complete.
const warmer = { running: false, done: 0, misses: 0, lastRun: null, queueSize: 0 };

async function warmCsProfiles(batch = 12) {
  if (warmer.running) return;
  warmer.running = true;
  try {
    const seen = new Set();
    const queue = [];
    for (const l of (cache.underdog.data || [])) {
      if (!isEsports(l.sport)) continue;
      const s = (l.sport || '').toUpperCase();
      if (!(s.includes('CS') || s.includes('COUNTER'))) continue;   // bo3 covers CS
      const k = (l.player || '').toLowerCase();
      if (!k || seen.has(k)) continue;
      seen.add(k);
      const c = esportsCache.hltvPlayers[k];
      const fresh = c && !c.failed && (Date.now() - c.lastUpdate) < 6 * 3600000;
      const recentMiss = c && c.failed && (Date.now() - c.lastUpdate) < 30 * 60000;
      if (!fresh && !recentMiss) queue.push(l.player);
    }
    warmer.queueSize = queue.length;
    let filled = 0;
    for (const name of queue.slice(0, batch)) {
      const got = await fetchBo3PlayerStats(name);
      got ? warmer.done++ : warmer.misses++;
      if (got) filled++;
      await new Promise(r => setTimeout(r, 400));   // gentle on bo3
    }
    warmer.lastRun = new Date().toISOString();
    if (filled) {
      console.log(`Warmer: +${filled} CS profiles (${queue.length - batch > 0 ? queue.length - batch : 0} still queued)`);
      generateEsportsPicks().catch(() => {});
    }
  } finally { warmer.running = false; }
}

// ─── ROUTES ───────────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({ status: 'Line Reaper backend running', version: '3.8.0', updated: new Date().toISOString() }));

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
  else if (sport.toLowerCase().includes('lol')) stats = lolStats.players[name.toLowerCase()] || null;
  else if (sport.toLowerCase().includes('cs')) stats = await fetchBo3PlayerStats(name);
  res.json(stats || { error: 'Player not found' });
});

// What does Underdog ACTUALLY call each esports market, and what lines come
// with it? Distinct market strings with line ranges + how we parse each one.
app.get('/api/esports/probe/udmarkets', (req, res) => {
  const rows = (cache.underdog.data || []).filter(l => isEsports(l.sport));
  const byMarket = {};
  for (const l of rows) {
    const k = `${l.sport} :: ${l.market}`;
    const B = byMarket[k] || (byMarket[k] = { sport: l.sport, market: l.market, count: 0, lines: [], samplePlayers: [] });
    B.count++;
    if (l.line != null) B.lines.push(l.line);
    if (B.samplePlayers.length < 3) B.samplePlayers.push(`${l.player} ${l.line}`);
  }
  const out = Object.values(byMarket).map(B => {
    const ls = B.lines.slice().sort((a, b) => a - b);
    const span = parseMapSpan(B.market);
    const med = ls.length ? ls[Math.floor(ls.length / 2)] : null;
    return {
      sport: B.sport, market: B.market, count: B.count,
      lineMin: ls[0] ?? null, lineMedian: med, lineMax: ls[ls.length - 1] ?? null,
      parsedMaps: span.count, parsedLabel: span.label,
      impliedPerMap: med != null ? +(med / span.count).toFixed(2) : null,
      plausible: lineIsPlausible(med, span.count, B.sport, B.market),
      samplePlayers: B.samplePlayers,
    };
  }).sort((a, b) => b.count - a.count);
  res.json({ totalEsportsLines: rows.length, markets: out });
});

// Per-sport source inspectors
// NOTE: two explicit routes instead of an optional ":name?" param — Express 5
// removed optional-param syntax and throws at startup on it.
async function valProbe(req, res) {
  if (!vlrTable.updated) await refreshVLRTable().catch(() => {});
  const name = req.params.name;
  res.json({
    source: 'vlr.gg mirror', players: Object.keys(vlrTable.players).length,
    regions: vlrTable.regions, updated: vlrTable.updated, lastError: vlrTable.lastError,
    lookup: name ? await fetchVLRPlayerStats(name) : null,
    sample: Object.values(vlrTable.players).slice(0, 5),
  });
}
app.get('/api/esports/probe/val', valProbe);
app.get('/api/esports/probe/val/:name', valProbe);

async function dotaProbe(req, res) {
  try {
    const dir = await dotaLoadProPlayers();
    res.json({
      source: 'opendota', indexedNames: Object.keys(dir).length, lastError: dotaCache.lastError,
      lookup: req.params.name ? await fetchDotaPlayerStats(req.params.name) : null,
    });
  } catch (e) { res.json({ error: e.message, status: e.response?.status }); }
}
app.get('/api/esports/probe/dota', dotaProbe);
app.get('/api/esports/probe/dota/:name', dotaProbe);

// Raw Leaguepedia inspector — shows exactly what the wiki returns
app.get('/api/esports/probe/lolsource', async (req, res) => {
  const since = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  try {
    const rows = await lpFetchPage(since, 0, 5);
    res.json({ ok: true, since, rowsReturned: rows.length, sample: rows.slice(0, 5), parsed: aggregateLPRows(rows) });
  } catch (e) {
    res.json({ ok: false, error: e.message, status: e.response?.status, body: String(e.response?.data || '').slice(0, 500) });
  }
});

// Raw-source inspector: paste this output in chat if a parse ever misses
app.get('/api/esports/probe/:sport/:name', async (req, res) => {
  const { sport, name } = req.params;
  const s = sport.toLowerCase();
  try {
    if (s.includes('lol')) {
      return res.json({ source: 'oracles-elixir', updated: lolStats.updated,
        player: lolStats.players[name.toLowerCase()] || null,
        prediction12: predictLoLKills(name, 2) });
    }
    if (s.includes('val')) return res.json({ source: 'vlr', player: await fetchVLRPlayerStats(name) });
    const found = await bo3SearchPlayer(name);
    if (!found?.slug) return res.json({ source: 'bo3', error: 'no search hit for that name' });
    const raw = await bo3RawStats(found.slug);
    res.json({ source: 'bo3', found, raw, parsed: bo3ExtractProfile(name, raw.gen, raw.map, raw.acc) });
  } catch (e) { res.status(500).json({ error: e.message }); }
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
  version: '3.8.0',
  modelWeight: MODEL_WEIGHT,
  prizepicks: { count: cache.prizepicks.data?.length||0, updated: cache.prizepicks.updated, blocked: Date.now() < ppFail.until },
  underdog: { count: cache.underdog.data?.length||0, updated: cache.underdog.updated, sports: cache.udSportLabels },
  esports: {
    picks: esportsCache.picks.length,
    updated: esportsCache.lastUpdated,
    ppEsportsLines: (cache.prizepicks.data||[]).filter(l => isEsports(l.sport)).length,
    udEsportsLines: (cache.underdog.data||[]).filter(l => isEsports(l.sport)).length,
  },
  lolData: { players: Object.keys(lolStats.players).length, teams: Object.keys(lolStats.teams).length, games: lolStats.games, updated: lolStats.updated, state: lolStats.state, error: lolStats.lastError, source: lolStats.source },
  implausibleLines: esportsCache.implausible || [],
  spanInferredCount: esportsCache.spanInferred || 0,
  warmer: { filled: warmer.done, misses: warmer.misses, queued: warmer.queueSize, lastRun: warmer.lastRun },
  valData: { players: Object.keys(vlrTable.players).length, regions: vlrTable.regions, updated: vlrTable.updated, error: vlrTable.lastError },
  dotaData: { indexed: dotaCache.proPlayers ? Object.keys(dotaCache.proPlayers).length : 0, profiles: Object.values(dotaCache.players).filter(p => !p.failed).length, error: dotaCache.lastError },
  bo3: { profiles: bo3Health.profiles, predsAccepted: bo3Health.predsAccepted, predsRejected: bo3Health.predsRejected, lastRejected: bo3Health.lastRejected, lastError: bo3Health.lastError },
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

// Profile warmer: every minute, fill a few more players' stats until the whole
// board is priced. Self-limiting — it stops when the queue empties.
cron.schedule('* * * * *', () => warmCsProfiles().catch(()=>{}));

// Valorant table refresh (cheap, 7 regions)
cron.schedule('20 * * * *', () => refreshVLRTable().catch(()=>{}));

// LoL stats: Oracle's Elixir updates once per day — no value in more
cron.schedule('10 7 * * *', () => refreshLoLStats().catch(()=>{}));
// ...but until the FIRST successful load, retry every 30 min (covers boot
// failures, timeouts, and transient S3 hiccups without any manual poking)
cron.schedule('*/30 * * * *', () => { if (lolStats.state !== 'ready') refreshLoLStats().catch(()=>{}); });

// ─── START ────────────────────────────────────────────────────────────────────
if (require.main === module) {
  app.listen(PORT, async () => {
    console.log(`Line Reaper v3.8 on port ${PORT}`);
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
    // LoL dataset download (~1 min); regenerates picks when done
    setTimeout(() => refreshLoLStats().catch(()=>{}), 8000);
    // Valorant table (all regions) + Dota pro directory
    setTimeout(() => refreshVLRTable().catch(()=>{}), 12000);
    setTimeout(() => dotaLoadProPlayers().catch(()=>{}), 16000);
    // start filling CS profiles right away after a redeploy wipes the cache
    setTimeout(() => warmCsProfiles(20).catch(()=>{}), 20000);
    console.log('Startup complete');
  });
}

module.exports = {
  app, cache, esportsCache, lolStats,
  parseUnderdogPayload, normalizeName, normalizeMarket, isEsports,
  calcBookEV, calcEsportsEV, predictEsportsSide, generateEsportsPicks,
  getVarianceMultiplier, parseMapCount, parseMapSpan, lineIsPlausible, inSeasonSports, anchorToMarket, MODEL_WEIGHT,
  parseCsvLine, createOEAggregator, predictLoLKills, predictLoLStat, refreshLoLStats,
  aggregateLPRows, refreshLoLFromLeaguepedia,
  vlrIngestSegments, vlrTable, vlrKey, fetchVLRPlayerStats, dotaCache, warmCsProfiles, warmer,
  inferMapSpan, describePlayer,
  predictKillsFromStats, autoPredAcceptable, bo3Pick, bo3FirstObject, bo3ExtractProfile,
};
