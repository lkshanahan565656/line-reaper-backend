require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;

// Keys come from the environment only (Railway variables / local .env).
// Never commit a fallback key: anything in source ships to every buyer.
const ODDS_API_KEY = process.env.ODDS_API_KEY || '';
const OWLS_API_KEY = process.env.OWLS_API_KEY || '';
if (!ODDS_API_KEY) console.warn('ODDS_API_KEY is not set: Odds API props and odds are disabled.');
if (!OWLS_API_KEY) console.warn('OWLS_API_KEY is not set: Owls feeds will fail and switch themselves off.');
const OWLS_HEADERS = { 'X-API-Key': OWLS_API_KEY };

app.use(cors({ origin: '*' }));

// Stripe signs the raw bytes, so this one route must see the body before
// express.json parses it. Registered first for that reason.
app.post('/api/billing/webhook', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
  let event;
  try { event = verifyWebhook(req.body, req.get('stripe-signature'), process.env.STRIPE_WEBHOOK_SECRET); }
  catch (e) { return res.status(400).json({ error: e.message }); }
  try { res.json({ received: true, result: await billing.handleEvent(event) }); }
  catch (e) { console.error('Billing webhook failed:', e.message); res.status(500).json({ error: 'handler failed' }); }
});

app.use(express.json());
app.use((req, res, next) => auth.attach()(req, res, next));

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

// Low-usage mode for small Odds API plans (see quota.js).
const { createCreditBudget, oddsCost } = require('./quota');
const oddsBudget = createCreditBudget({
  setting: process.env.ODDS_API_BUDGET || '', resetDay: parseInt(process.env.ODDS_API_RESET_DAY) || 1,
});
// Player props cost a credit per market per game, far more than a small plan
// has, so low-usage mode skips them unless ODDS_API_PROPS=on.
const propsAllowed = () => !oddsBudget.active() || /^(1|on|true|yes)$/i.test(process.env.ODDS_API_PROPS || '');

function noteQuota(res) {
  const rem = res?.headers?.['x-requests-remaining'];
  if (rem != null) cache.quotaRemaining = parseFloat(rem);
  if (res?.headers) oddsBudget.noteHeaders(res.headers);
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
    if (!propsAllowed()) return cache.oddsApiProps[sportKey]?.data || [];
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
// the last failure of each DFS scrape, for /api/status (cleared on success)
const dfsError = { prizepicks: null, underdog: null };
const noteDfsError = (book, e) => { dfsError[book] = { status: e?.response?.status ?? null, message: String(e?.message || e).slice(0, 200), at: new Date().toISOString() }; };

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
        allLines.push({ book: 'prizepicks', sport, player: player.name || attr.description || '', team: player.team || '', market: attr.stat_type || '', line: parseFloat(attr.line_score), startTime: attr.start_time || '',
          matchTitle: player.name ? (attr.description || '') : '', gameId: attr.game_id || null });
      }
    }
    if (allLines.length > 0) {
      cache.prizepicks = { data: allLines, updated: new Date().toISOString() };
      ppFail = { count: 0, until: 0 };
      dfsError.prizepicks = null;
      cache.ppLeagueLabels = [...new Set(allLines.map(l => l.sport))].slice(0, 20);
      console.log(`PP: ${allLines.length} lines · leagues: ${cache.ppLeagueLabels.slice(0, 12).join(', ')}`);
    }
  } catch(e) {
    const s = e.response?.status;
    noteDfsError('prizepicks', e);
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
    games[g.id] = { sport: g.sport_id || g.sport || '', startTime: g.scheduled_at || '', title: g.title || g.full_team_names_title || g.abbreviated_title || '' };
  }
  if (Array.isArray(data.solo_games)) for (const g of data.solo_games) {
    soloGames[g.id] = { sport: g.sport_id || g.sport || '', startTime: g.scheduled_at || '', title: g.title || g.full_team_names_title || g.abbreviated_title || '' };
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
      matchTitle: game.title || '',
      gameId: matchId,
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
    dfsError.underdog = null;
    cache.udSportLabels = [...new Set(lines.map(l => l.sport).filter(Boolean))].slice(0, 25);
    const withMult = lines.filter(l => l.multiplier !== 1.00).length;
    console.log(`UD: ${lines.length} lines (${withMult} boosted/demoted) · sports: ${cache.udSportLabels.slice(0, 12).join(', ') || 'NONE RESOLVED'}`);
  } catch(e) { noteDfsError('underdog', e); console.error('UD error:', e.message, e.response?.status); }
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
    ingestSharp(sport, games);
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
  if (!oddsBudget.take(oddsCost('h2h,spreads,totals', 'us')).ok) return cache.odds[sport]?.data || [];
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

// ─── UNDERDOG PRICING: TWO REGIMES ────────────────────────────────────────────
// UD's payout_multiplier means different things at different scales:
//   0.80-1.35  → a BOOST/DISCOUNT on standard pick'em pricing (-128, 56.23%)
//                EV = prob x mult / 0.5623 - 1
//   >1.35      → a DECIMAL PAYOUT in its own right (4.38x implies ~23%)
//                EV = prob x mult - 1
// Treating the second kind as the first is what produced +339% "edges".
//
// Then a reality check: every payout implies a probability. If our model
// disagrees with the book's implied number by more than 15 points, one of us
// is badly wrong — and on a single leg it is almost always us. Those get no
// EV and a flag instead of a fantasy edge.
const UD_DECIMAL_THRESHOLD = 1.35;
// Was 0.15 — two legs at a 14-point gap still slipped through and compounded
// into an "+88% EV" 2-leg slip. On a single prop, a 10-point disagreement with
// a live market is already a strong sign the error is ours.
const MAX_PROB_DISAGREEMENT = 0.10;

function udPricing(prob, mult) {
  const p = prob > 1 ? prob / 100 : prob;
  const m = parseFloat(mult) || 1.00;
  const decimal = m > UD_DECIMAL_THRESHOLD;
  const implied = decimal ? 1 / m : UD_IMPLIED / m;
  const ev = decimal ? (p * m - 1) * 100 : (p * m / UD_IMPLIED - 1) * 100;
  const gap = p - implied;
  const flag = Math.abs(gap) > MAX_PROB_DISAGREEMENT ? 'price-mismatch' : null;
  return { ev: flag ? null : ev, implied: implied * 100, regime: decimal ? 'decimal' : 'boost', flag, gap: gap * 100 };
}

function calcBookEV(prob, book, mult = 1.00) {
  prob = prob > 1 ? prob/100 : prob;  // accept 0-1 or 0-100
  switch ((book || '').toLowerCase()) {
    case 'prizepicks':
    case 'pp':
      return (prob / PP_IMPLIED - 1) * 100;
    case 'underdog':
    case 'ud':
      return udPricing(prob, mult).ev;   // null when book price and model disagree wildly
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

const {
  matchContext, describeContext, opponentFrom, createOddsBook, teamsMatch,
} = require('./context');
const { refreshRatings } = require('./ratings');
const { propProb } = require('./dist');
const { priceAll, bestSlips, PAYOUTS } = require('./slip');
const { createAlerter } = require('./alerts');
const { createAuth, createUserStoreFromEnv, publicUser, isPro } = require('./auth');
const { createBilling, verifyWebhook } = require('./billing');
const evScreen = require('./ev');
const exchanges = require('./exchanges');
const { createEvTracker, createStoreFromEnv: createEvStoreFromEnv } = require('./evtrack');
// Every flagged +EV price is logged and graded on closing-line value.
const evTracker = createEvTracker({ store: createEvStoreFromEnv(), minEv: process.env.TRACK_EV_MIN != null ? parseFloat(process.env.TRACK_EV_MIN) : 2 });
const { createSharpTracker, reverseLineMoves, describeSharp } = require('./sharp');

// Sharp money: every odds poll is diffed per book. Steam (3+ books move the
// same way within minutes), sharp leads (Pinnacle/Circa/exchanges move while
// soft books sit still) and reverse line moves against public betting.
const sharpTracker = createSharpTracker();
const SHORT_SPORT = { basketball_nba: 'nba', baseball_mlb: 'mlb', icehockey_nhl: 'nhl', americanfootball_nfl: 'nfl', mma_mixed_martial_arts: 'mma', basketball_ncaab: 'ncaab', americanfootball_ncaaf: 'ncaaf' };
const sharpListeners = new Set();
function ingestSharp(sport, games) {
  if (!Array.isArray(games) || !games.length) return [];
  let fresh;
  try { fresh = sharpTracker.ingest(SHORT_SPORT[sport] || sport, games); } catch (e) { console.warn('Sharp tracker:', e.message); return []; }
  const loud = fresh.filter(e => e.kind !== 'move');
  if (loud.length) for (const fn of sharpListeners) { try { fn(loud); } catch { /* keep going */ } }
  const ping = loud.filter(e => e.kind === 'steam' || e.kind === 'sharp_lead');
  if (ping.length && process.env.ALERT_WEBHOOK_URL && process.env.SHARP_WEBHOOK !== 'off') {
    axios.post(process.env.ALERT_WEBHOOK_URL, { username: 'Line Reaper', content: ping.slice(0, 10).map(e => '⚡ ' + describeSharp(e)).join('\n') }, { timeout: 10000 })
      .catch(e => console.warn('Sharp alerts: webhook failed:', e.message));
  }
  return fresh;
}
// Owls splits arrive per game; reshape to { 'Away @ Home': { market: { side: {...} } } }.
// Field names are guessed from the splits route's use in the app, so unknown shapes yield nothing.
function splitsMap() {
  const out = {};
  for (const c of Object.values(cache.splits || {})) {
    for (const g of Array.isArray(c?.data) ? c.data : []) {
      if (!g?.home_team || !g?.away_team) continue;
      const m = g.splits || g.markets || g.betting_splits;
      if (m && typeof m === 'object') out[`${g.away_team} @ ${g.home_team}`] = m;
    }
  }
  return out;
}

// ─── ACCOUNTS + BILLING ───────────────────────────────────────────────────────
// AUTH_SECRET signs login tokens. Without it, a random one is used and every
// restart logs everyone out, which is fine locally and wrong in production.
const AUTH_SECRET = process.env.AUTH_SECRET || require('crypto').randomBytes(32).toString('hex');
if (!process.env.AUTH_SECRET) console.warn('AUTH_SECRET is not set: logins will not survive a restart.');
const auth = createAuth({ store: createUserStoreFromEnv(), secret: AUTH_SECRET });
const billing = createBilling({
  http: axios, secretKey: process.env.STRIPE_SECRET_KEY, priceId: process.env.STRIPE_PRICE_ID,
  store: auth.store, trialDays: parseInt(process.env.STRIPE_TRIAL_DAYS) || 0,
});
// PAYWALL=on turns the gates on. Off by default so a deploy never locks you out.
const PAYWALL = /^(1|on|true|yes)$/i.test(process.env.PAYWALL || '');

// New edges and line moves, pushed to the app (server-sent events) and, when
// ALERT_WEBHOOK_URL is set, to a Discord-compatible webhook.
const alerter = createAlerter({
  minEv: process.env.ALERT_MIN_EV != null ? parseFloat(process.env.ALERT_MIN_EV) : undefined,
  send: process.env.ALERT_WEBHOOK_URL
    ? body => axios.post(process.env.ALERT_WEBHOOK_URL, body, { timeout: 10000 })
    : null,
});

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

  // Counts are priced as counts (negative binomial); fantasy points and any
  // case the count model can't represent fall back to the normal curve.
  const sc = opts.context?.scenarios;
  const scenarios = (sc && sc.length && opts.context.expMaps > 0) ? sc : [{ maps: 1, weight: 1 }];
  const meanPerMap = scenarios.length > 1 || opts.context?.expMaps
    ? modelPred / opts.context.expMaps
    : modelPred;
  const stat = /fantasy/i.test(propText || '') ? 'fantasy'
    : /assist/i.test(propText || '') ? 'assists'
    : /headshot/i.test(propText || '') ? 'headshots' : 'kills';
  const r = propProb(ppLine, side, { meanPerMap, k, stat, scenarios });
  const prob = r.effective;

  return {
    prob: prob * 100,
    confidence: prob > 0.62 ? 'HIGH' : prob > 0.56 ? 'MED' : 'LOW',
    varianceK: k,
    model: r.model,
    pushProb: r.push > 0 ? +(r.push * 100).toFixed(2) : 0,
    meanPerMap, scenarios, stat,
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
  const isHS       = s.includes('headshot') || s.includes('hs');
  const isAssists  = s.includes('assist');
  const isFantasy  = s.includes('fantasy');
  // "Kills Maps 1 2" (Sleeper) uses spaces — normalize to the + form first
  let mapCount = parseMapSpan(s.replace(/(\d)\s+(\d)/g, '$1+$2')).label;
  let stat = isHS ? 'hs' : isAssists ? 'ast' : isFantasy ? 'fp' : 'k';
  return `${stat}|${mapCount}`;
}

// ─── MATCH CONTEXT STATE ──────────────────────────────────────────────────────
// Elo per sport from recent results (refreshed every 6h) + odds entered by hand.
const ratingsState = { elo: {}, meta: {} };
const oddsBook = createOddsBook();

// ── EXTRA DATA FEEDS (feeds.js) ──
// PandaScore: CS2/CoD/Valorant ratings, best-of schedule, CS2/VAL/CoD grading.
// Pinnacle guest API: sharp esports match prices for context (check its terms
// before charging for a product built on it).
const { createPandaScoreClient, fetchPinnacleEsports, loadMatchPrices } = require('./feeds');
const panda = process.env.PANDASCORE_TOKEN ? createPandaScoreClient(axios, process.env.PANDASCORE_TOKEN) : null;
const feedState = {
  pandascore: { enabled: !!panda, schedules: {}, updated: null, errors: {} },
  pinnacle: { enabled: !!process.env.PINNACLE_GUEST_KEY, matches: 0, loaded: 0, updated: null, error: null },
};

async function refreshMatchFeeds() {
  if (panda) {
    for (const sport of ['CS', 'VAL', 'COD', 'LOL', 'DOTA']) {
      try { feedState.pandascore.schedules[sport] = await panda.upcoming(sport); delete feedState.pandascore.errors[sport]; }
      catch (e) { feedState.pandascore.errors[sport] = `${e.response?.status || ''} ${e.message}`.trim(); }
    }
    feedState.pandascore.updated = new Date().toISOString();
  }
  if (feedState.pinnacle.enabled) {
    try {
      const prices = await fetchPinnacleEsports(axios, process.env.PINNACLE_GUEST_KEY);
      feedState.pinnacle.matches = prices.length;
      feedState.pinnacle.loaded = loadMatchPrices(oddsBook, prices, feedState.pandascore.schedules);
      feedState.pinnacle.updated = new Date().toISOString();
      feedState.pinnacle.error = null;
    } catch (e) { feedState.pinnacle.error = `${e.response?.status || ''} ${e.message}`.trim(); }
  }
}
const ratingsOpts = { panda };

function spanToMapList(label, count) {
  const m = String(label || '').match(/^(\d+)(?:-(\d+))?$/);
  if (m) {
    const a = parseInt(m[1]), b = m[2] ? parseInt(m[2]) : a;
    if (b - a + 1 === count) return Array.from({ length: count }, (_, i) => a + i);
  }
  return Array.from({ length: count || 1 }, (_, i) => i + 1);
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
      matchTitle: l.matchTitle || '',
      gameId: l.gameId || null,
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
  let priceMismatches = 0;
  const contextCounts = {};

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
    let rawPred = null, sampleSize = null, spanInferred = null, statLine = null, context = null;

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

      // MATCH CONTEXT — scale per-map rate by the matchup and price the span
      // by how many maps are actually likely to be played.
      if (autoPred && plausible) {
        const spanMaps = spanInferred ? spanInferred : mapCount;
        const label = spanInferred ? `1-${spanInferred}` : parseMapSpan(lineObj.market).label;
        const maps = spanToMapList(label, spanMaps);
        const opponent = opponentFrom(lineObj.team, lineObj.matchTitle, null)
          || (lineObj.matchTitle && !/\d|map|game/i.test(lineObj.matchTitle) && !teamsMatch(lineObj.team, lineObj.matchTitle) ? lineObj.matchTitle : null);
        context = matchContext({ sport: sportU, team: lineObj.team, opponent, maps }, { oddsBook, elo: ratingsState.elo });
        if (context) {
          const perMap = autoPred / spanMaps;
          autoPred = perMap * context.factor * context.expMaps;
          rawPred = autoPred;
          contextCounts[context.source] = (contextCounts[context.source] || 0) + 1;
        } else contextCounts.none = (contextCounts.none || 0) + 1;
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
    if (predSource !== 'auto') context = null;   // manual numbers are the user's own model
    if (context) statLine = [statLine, describeContext(context)].filter(Boolean).join(' · ');
    return { modelPred, predSource, manualKey, rawPred, sampleSize, spanInferred, statLine, context };
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
      displayMarket: g.spanInferred ? relabelMarket(base.market, g.spanInferred) : base.market,
      statLine: g.statLine ?? null,
      context: g.context ? {
        source: g.context.source, opponent: g.context.opponent, pMap: +g.context.pMap.toFixed(3),
        pLastMap: +g.context.pLastMap.toFixed(3), expMaps: +g.context.expMaps.toFixed(2),
        factor: +g.context.factor.toFixed(3), bestOf: g.context.bestOf,
      } : null,
      edge: null, edgePct: null,
      manualKey,
      side: null, prob: null, ev: null,
      ppEv: null, udEv: null, betrEv: null, parlayEv: null, sleeperEv: null,
      udMultiplier: null, sleeperMultiplier: null, udLine: udm ? udm.line : null,
      udRegime: null, udImplied: null, udFlag: null,
      bestBook: null, bestEv: null, bookEdge: null, confidence: null, varianceK: null,
      model: null, pushProb: 0, gameId: base.gameId ?? null,
      pricing: null,
    };
    if (modelPred == null || !lineVal) return pick;   // no model yet — still listed for ✏️ input

    const ctxOpts = { context: g.context || null };
    let side = modelPred < lineVal ? 'UNDER' : modelPred > lineVal ? 'OVER' : null;
    if (g.context?.scenarios?.length > 1) {
      // a 2-or-3-map mixture isn't symmetric: pick the side with the better probability
      const over = calcEsportsEV(lineVal, modelPred, 'OVER', base.sport, base.market, ctxOpts);
      if (over) side = over.prob >= 50 ? 'OVER' : 'UNDER';
    }
    if (!side) return pick;
    const r = calcEsportsEV(lineVal, modelPred, side, base.sport, base.market, ctxOpts);
    if (!r) return pick;

    pick.side = side;
    pick.prob = parseFloat(r.prob.toFixed(2));
    // How far our number sits from the book's, in stat units and percent
    pick.edge = parseFloat((modelPred - lineVal).toFixed(2));
    pick.edgePct = parseFloat(((modelPred - lineVal) / lineVal * 100).toFixed(1));
    pick.confidence = r.confidence;
    pick.varianceK = r.varianceK;
    pick.model = r.model;
    pick.pushProb = r.pushProb;
    // everything a slip needs to re-price this leg inside a shared scenario
    pick.pricing = {
      line: lineVal, side, meanPerMap: r.meanPerMap, k: r.varianceK, stat: r.stat,
      scenarios: r.scenarios.map(x => ({ maps: x.maps, weight: +x.weight.toFixed(4) })),
    };

    if (lineSource === 'pp') pick.ppEv = parseFloat(calcBookEV(r.prob, 'prizepicks').toFixed(2));

    if (udm) {
      const udSideMult = side === 'OVER' ? (udm.overMultiplier || 1.00) : (udm.underMultiplier || 1.00);
      // UD's line can differ from PP's — price UD against ITS OWN line
      let udProb = r.prob;
      if (udm.line != null && udm.line !== lineVal) {
        const r2 = calcEsportsEV(udm.line, modelPred, side, base.sport, base.market, ctxOpts);
        if (r2) udProb = r2.prob;
      }
      const udP = udPricing(udProb, udSideMult);
      pick.udEv = udP.ev != null ? parseFloat(udP.ev.toFixed(2)) : null;
      pick.udMultiplier = udSideMult;
      pick.udRegime = udP.regime;
      pick.udImplied = parseFloat(udP.implied.toFixed(1));
      pick.udFlag = udP.flag;
      if (udP.flag) priceMismatches++;
    }

    const books = [['PP', pick.ppEv], ['UD', pick.udEv]].filter(b => b[1] != null);
    if (books.length) {
      const best = books.reduce((a, b) => (b[1] > a[1] ? b : a));
      pick.bestBook = best[0];
      pick.bestEv = best[1];
      pick.ev = pick.ppEv != null ? pick.ppEv : pick.udEv;
      // book-vs-book EV gap — under its own name so it can't clobber pick.edge,
      // which is our projection's distance from the line
      pick.bookEdge = parseFloat((best[1] - (pick.ppEv ?? best[1])).toFixed(2));
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
    const base = { sport: udm.sport, player: udm.player, team: udm.team, market: udm.market, line: udm.line, startTime: udm.startTime, matchTitle: udm.matchTitle, gameId: udm.gameId };
    const g = await getModelPred(base);
    picks.push(assemble(base, g.modelPred, g.predSource, g.manualKey, udm, 'ud', g));
  }

  if (implausibleLines.length) {
    esportsCache.implausible = implausibleLines.slice(0, 20);
    console.warn(`Esports: ${implausibleLines.length} lines skipped as implausible (market string may be parsed wrong) e.g. ${implausibleLines[0]}`);
  } else esportsCache.implausible = [];
  esportsCache.spanInferred = spanCounts.inferred;
  esportsCache.contextCounts = contextCounts;
  esportsCache.priceMismatches = priceMismatches;
  if (priceMismatches) console.log(`Esports: ${priceMismatches} picks withheld — model probability disagreed with the book's implied price by >15 points`);
  if (spanCounts.inferred) console.log(`Esports: ${spanCounts.inferred} picks rescaled — line implied a longer map span than the market label claimed`);

  picks.sort((a, b) => (b.bestEv ?? -999) - (a.bestEv ?? -999));
  esportsCache.picks = picks;
  esportsCache.lastUpdated = new Date().toISOString();
  tracker.recordBoard(picks).catch(e => console.warn('Tracker: recordBoard failed:', e.message));
  alerter.onBoard(picks).catch(e => console.warn('Alerts: failed:', e.message));
  console.log(`Esports: generated ${picks.length} picks (${picks.filter(p => p.lineSource === 'ud').length} UD-sourced, ${picks.filter(p => p.predSource === 'manual').length} manual, ${picks.filter(p => p.modelPred == null).length} need model input)`);
  return picks;
}

// If a book labels a 3-map prop "Kills on Maps 1+2", rewrite the label to what
// the line actually covers. Clearer than showing the wrong name plus an asterisk.
function relabelMarket(market, maps) {
  if (!market || !maps) return market;
  const span = maps === 1 ? '1' : `1+${Array.from({ length: maps - 1 }, (_, i) => i + 2).join('+')}`;
  if (/maps?\s*[\d\s+\-–]+/i.test(market)) {
    return market.replace(/maps?\s*[\d\s+\-–]+/i, maps === 1 ? 'Map 1' : `Maps ${span}`);
  }
  return `${market} (Maps ${span})`;
}

// One-line "why this number" summary shown under each pick.
function describePlayer(p) {
  if (!p) return null;
  const bits = [];
  // Mirror predictKillsFromStats' arbitration so the displayed rate matches the
  // one used for the projection. bo3's "maps" counter is sometimes a MATCH
  // counter, which inflates avgKillsPerMap — KPR is the reliable number.
  const rpm = (p.roundsPerMap && p.roundsPerMap <= 32) ? p.roundsPerMap : 21.5;
  const viaRounds = p.kpr ? p.kpr * rpm : null;
  let viaMap = p.avgKillsPerMap && p.avgKillsPerMap <= 32 ? p.avgKillsPerMap : null;
  let eff = null;
  if (viaMap != null && viaRounds != null) {
    eff = Math.abs(viaMap - viaRounds) / viaRounds > 0.4 ? viaRounds : 0.5 * (viaMap + viaRounds);
  } else eff = viaMap ?? viaRounds;
  if (eff) bits.push(`${eff.toFixed(1)} k/map`);
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

// ─── PICK TRACKER ─────────────────────────────────────────────────────────────
// Every signaled pick is recorded, frozen at kickoff, and graded from results.
// Storage: Postgres when DATABASE_URL is set (use this on Railway), otherwise
// a JSON file at TRACKER_FILE (default ./data/esports-picks.json).
const { createTracker, createStoreFromEnv } = require('./tracker');
const { createLoLGrader, createDotaGrader } = require('./graders');

async function dotaAccountId(playerName) {
  const dir = await dotaLoadProPlayers();
  return dir[vlrKey(playerName)] || dir[vlrKey((playerName || '').split(/\s+/).pop())] || null;
}

const tracker = createTracker({
  store: createStoreFromEnv(),
  graders: {
    LOL: createLoLGrader(axios), DOTA: createDotaGrader(axios, dotaAccountId),
    ...(panda ? { CS: panda.grader('CS'), VAL: panda.grader('VAL'), COD: panda.grader('COD') } : {}),
  },
  normalizeName, normalizeMarket, parseMapSpan,
});
tracker.ready().then(
  () => console.log('Tracker: store ready'),
  e => console.error('Tracker: store failed to initialise:', e.message));

// Paid features. With the paywall off, everyone is treated as a subscriber.
// The admin token always counts, so the owner never needs a subscription.
function isAdmin(req) {
  const admin = process.env.TRACKER_ADMIN_TOKEN;
  return !!admin && req.get('x-admin-token') === admin;
}
function hasPro(req) {
  if (!PAYWALL) return true;
  if (isAdmin(req)) return true;
  return isPro(req.user);
}

// Data licences. Polymarket's terms give a personal licence and Kalshi's data
// terms are personal and non-commercial, so showing either to other people
// needs the owner's written permission, flagged with POLYMARKET_DISPLAY_OK /
// KALSHI_DISPLAY_OK (default off). With the paywall on (other people using
// it) a source whose flag is off is shown to the admin only, and everyone
// else gets a short note instead. The paywall off is the owner using it
// himself: everything shows. Flags are read per request, so a test (or a
// redeploy with new env) needs no restart.
const LICENCE_NOTE = 'waiting on data permission';
const envOn = k => /^(1|on|true|yes)$/i.test(String(process.env[k] || '').trim());
function licenceFor({ paywall = PAYWALL, admin = false } = {}) {
  const open = !paywall || admin;
  return { polymarket: open || envOn('POLYMARKET_DISPLAY_OK'), kalshi: open || envOn('KALSHI_DISPLAY_OK') };
}
const licenceOf = req => licenceFor({ paywall: PAYWALL, admin: isAdmin(req) });
// what /api/status and /api/tail/settings report: the flags, what the public
// gets, and what this viewer gets
function licenceState(req) {
  const pub = licenceFor({ paywall: PAYWALL, admin: false }), you = licenceOf(req);
  const show = ok => (ok ? 'shown' : 'admin only');
  return {
    paywall: PAYWALL, polymarketDisplayOk: envOn('POLYMARKET_DISPLAY_OK'), kalshiDisplayOk: envOn('KALSHI_DISPLAY_OK'),
    polymarket: show(pub.polymarket), kalshi: show(pub.kalshi), viewer: you, note: pub.polymarket && pub.kalshi ? null : LICENCE_NOTE,
  };
}
function requirePro(req, res, next) {
  if (hasPro(req)) return next();
  res.status(req.user ? 402 : 401).json({
    error: req.user ? 'This needs a Line Reaper Pro subscription' : 'Log in to use this',
    upgrade: !!req.user,
  });
}
// Free users still see the board, with the actual picks on +EV lines hidden,
// so they can see how much they're missing.
function redactForFree(picks) {
  return picks.map(p => (p.bestEv != null && p.bestEv > 0)
    ? { ...p, side: null, prob: null, modelPred: null, rawPred: null, edge: null, edgePct: null,
        ppEv: null, udEv: null, bestEv: null, ev: null, pricing: null, statLine: null, context: null,
        // these give the side or the size of the edge away too
        udMultiplier: null, udImplied: null, udRegime: null, udFlag: null, confidence: null, bestBook: null,
        bookEdge: null, pushProb: null, model: null, overMultiplier: null, underMultiplier: null, locked: true }
    : p);
}

// Writes (manual grading) need TRACKER_ADMIN_TOKEN, sent as the x-admin-token header.
function requireAdmin(req, res, next) {
  const want = process.env.TRACKER_ADMIN_TOKEN;
  if (!want) return res.status(503).json({ error: 'Set TRACKER_ADMIN_TOKEN on the server to enable manual grading.' });
  if (req.get('x-admin-token') !== want) return res.status(401).json({ error: 'Bad or missing admin token' });
  next();
}

// ─── +EV SCREENER ─────────────────────────────────────────────────────────────
// Scores every cached sportsbook price against devigged sharp prices. Runs on
// odds the backend already pulls (Owls every 30s, Odds API props every 30 min),
// so it spends no extra Odds API credits.
const EV_SPORTS = { nba: 'basketball_nba', mlb: 'baseball_mlb', nhl: 'icehockey_nhl', nfl: 'americanfootball_nfl', mma: 'mma_mixed_martial_arts' };
let evCache = { at: 0, rows: [], feeds: [] };
// Kalshi and Polymarket prices, refreshed every minute and attached to the
// matching games as two more books (prices include Kalshi's taker fee).
const exchangeState = { rows: [], errors: [], updated: null };
async function refreshExchanges() {
  // through the polite per-host queue (createPoliteHttp, below)
  const [k, p] = await Promise.all([
    exchanges.fetchKalshi(upstream, { seriesTickers: (process.env.KALSHI_SERIES || '').split(',').filter(Boolean).length ? process.env.KALSHI_SERIES.split(',') : undefined }),
    exchanges.fetchPolymarket(upstream, { tags: (process.env.POLYMARKET_TAGS || '').split(',').filter(Boolean).length ? process.env.POLYMARKET_TAGS.split(',') : undefined }),
  ]);
  exchangeState.rows = [...k.rows, ...p.rows];
  exchangeState.errors = [...k.errors, ...p.errors];
  exchangeState.updated = new Date().toISOString();
}
const EXCHANGE_OPTS = { polymarketFeeRate: parseFloat(process.env.POLYMARKET_FEE_RATE) || 0, kalshiFeeRate: process.env.KALSHI_FEE_RATE != null ? parseFloat(process.env.KALSHI_FEE_RATE) : 0.07 };
function evFeeds() {
  const feeds = [];
  const add = (sport, label, c) => {
    if (!Array.isArray(c?.data) || !c.data.length) return;
    // game-line feeds get the exchange books attached
    const games = /odds$/.test(label) && exchangeState.rows.length ? exchanges.attachExchanges(c.data, exchangeState.rows, { ...EXCHANGE_OPTS, league: sport }) : c.data;
    feeds.push({ sport, label, games, updated: c.updated || null });
  };
  for (const [s, key] of Object.entries(EV_SPORTS)) {
    add(s, 'owls-odds', cache.owlsOdds[s]);
    add(s, 'owls-props', cache.owlsProps[s]);
    add(s, 'oddsapi-odds', cache.odds[key] || cache.odds[s]);
    add(s, 'oddsapi-props', cache.oddsApiProps[key]);
  }
  return feeds;
}
// Re-scored right after every odds poll (see the crons), so the board is
// never older than the newest odds. New edges stream to the app and webhook.
const EV_ALERT_MIN = process.env.EV_ALERT_MIN != null ? parseFloat(process.env.EV_ALERT_MIN) : 3;
const evListeners = new Set();
const evSeen = new Map();
let evRecent = [];
function runEvScreen(force = false) {
  if (!force && Date.now() - evCache.at < 30000) return evCache;
  const feeds = evFeeds();
  const dfsLines = [...(cache.prizepicks.data || []), ...(cache.underdog.data || [])].filter(l => !isEsports(l.sport));
  const fairs = new Map();
  const rows = evScreen.screen({ feeds, dfsLines, dfsEv: calcBookEV, minEv: 0, method: process.env.EV_DEVIG || 'power', fairs });
  const prev = evCache.at ? evCache.rows : null;
  evCache = { at: Date.now(), rows, feeds: feeds.map(f => ({ sport: f.sport, source: f.label, games: f.games.length, updated: f.updated })) };
  evTracker.recordBoard(rows, fairs).catch(e => console.warn('EV tracker:', e.message));
  // the first screen after a restart only primes the diff
  if (prev) {
    const fresh = evScreen.diffEv(prev, rows, { minEv: EV_ALERT_MIN, seen: evSeen });
    if (fresh.length) {
      evRecent = [...fresh, ...evRecent].slice(0, 200);
      for (const fn of evListeners) { try { fn(fresh); } catch { /* keep going */ } }
      // the webhook can reach other people: it gets what the public may see
      const posted = fresh.filter(evRowOk(webhookLicence()));
      if (process.env.ALERT_WEBHOOK_URL && posted.length) {
        const lines = posted.slice(0, 10).map(evScreen.describeEv);
        if (posted.length > 10) lines.push(`…and ${posted.length - 10} more`);
        axios.post(process.env.ALERT_WEBHOOK_URL, { username: 'Line Reaper', content: lines.join('\n') }, { timeout: 10000 })
          .catch(e => console.warn('EV alerts: webhook failed:', e.message));
      }
    }
  } else {
    for (const r of rows) if (r.ev >= EV_ALERT_MIN) evSeen.set(evScreen.rowKey(r), Date.now());
  }
  return evCache;
}
function redactEv(rows) {
  return rows.map(r => ({ sport: r.sport, event: r.event, start: r.start, market: r.market, dfs: !!r.dfs, prop: !!r.player,
    source: r.source, sharpBooks: r.sharpBooks, locked: true }));
}
// +EV rows a viewer may see: a Kalshi book needs the Kalshi licence; a
// Polymarket book needs its licence and never shows in US mode
const evRowOk = lic => r => (r?.book !== 'kalshi' || lic.kalshi) && (r?.book !== 'polymarket' || (lic.polymarket && TAIL_REGION !== 'us'));
// a webhook post can reach other people, so it gets the public's licences
const webhookLicence = () => licenceFor({ paywall: PAYWALL, admin: false });

// ─── SHARP TAIL ───────────────────────────────────────────────────────────────
// Following the money on the exchanges, all from free keyless public APIs:
//   tail.js       which Polymarket wallets have a provable edge; their new bets
//                 become signals sized in units at the price you can get now
//   tailtrack.js  every sized signal, graded when its market resolves
//   whales.js     big prints: Kalshi flow (anonymous) and Polymarket trades
//                 tagged with the wallet's grade
//   xarb.js       arbs across Kalshi, Polymarket and the sportsbooks
// New signals, whales and arbs go out on /api/ev/stream as `tail`, `whale` and
// `xarb` events. Sized A-grade and consensus signals, and arbs of
// XARB_ALERT_MIN % or more, also go to ALERT_WEBHOOK_URL.
//
// TAIL_REGION=us (the default): US persons can't trade on Polymarket
// International, so arbs only use Kalshi and US sportsbooks, every signal is
// routed to the best US venue for the same proposition (Kalshi, or the team's
// moneyline at a US book), and nothing links to polymarket.com. intl keeps
// round 1's venues. Sizing is the same for everyone: units (1u = 1% of
// bankroll), never dollars from anyone's bankroll.
const tail = require('./tail');
const { createTailTracker, createStoreFromEnv: createTailStoreFromEnv, createFreshStoreFromEnv } = require('./tailtrack');
const whales = require('./whales');
const xarb = require('./xarb');
const pmus = require('./pmus');
const { createTradeStream } = require('./tailstream');
const { createFileStore: createDocFileStore } = require('./evtrack');

// Kalshi, Polymarket's data API and Gamma are free, so be polite: one queue
// per host that starts at most one request every gapMs (a number, or a
// function of the host). Identical GETs that are in flight or were answered in the last few
// seconds share one response (the tail engine and the whale watcher both read
// the same recent-trades page every 30s). A 429 pauses that host (Retry-After,
// else retry429Ms doubling with each 429 in a row, at most 30s): requests
// already queued wait it out too, and this one goes once more at the end.
// Kalshi's public API shares its budget per IP, and Railway's IPs are shared.
const retryAfterMs = e => { const s = Number(e?.response?.headers?.['retry-after']); return s > 0 ? Math.min(s * 1000, 30e3) : null; };
function createPoliteHttp(get, { gapMs = 1000, shareMs = 5000, retry429Ms = 2000, now = () => Date.now(), sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  const nextAt = new Map();   // host → when the next request may start
  const pauseUntil = new Map(), streak = new Map();   // host → end of its 429 pause; 429s in a row
  const shared = new Map();   // url + params → { promise, doneAt }
  const stats = { requests: 0, shared: 0, failed: 0, retried429: 0, byHost: {} };
  const keyOf = (url, params) => `${url}?${JSON.stringify(Object.entries(params || {})
    .filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))}`;
  const hostOf = url => { try { return new URL(url).host; } catch { return ''; } };
  const gapFor = typeof gapMs === 'function' ? gapMs : () => gapMs;
  const backOff = (host, e) => {
    const n = (streak.get(host) || 0) + 1;
    streak.set(host, n);
    const until = now() + (retryAfterMs(e) ?? Math.min(30e3, retry429Ms * 2 ** (n - 1)));
    pauseUntil.set(host, Math.max(pauseUntil.get(host) ?? 0, until));
    return pauseUntil.get(host);
  };
  const ok = (host, r) => { streak.set(host, 0); return r; };
  return {
    get(url, cfg = {}) {
      const t = now();
      for (const [k, v] of shared) if (v.doneAt != null && t - v.doneAt > shareMs) shared.delete(k);
      const key = keyOf(url, cfg.params);
      const hit = shared.get(key);
      if (hit) { stats.shared++; return hit.promise; }
      const host = hostOf(url);
      const start = Math.max(t, nextAt.get(host) ?? 0);
      nextAt.set(host, start + gapFor(host));
      const entry = { doneAt: null };
      entry.promise = (async () => {
        if (start > t) await sleep(start - t);
        const paused = pauseUntil.get(host) ?? 0;
        if (paused > now()) await sleep(paused - now());
        stats.requests++;
        stats.byHost[host] = (stats.byHost[host] || 0) + 1;
        try { return ok(host, await get(url, cfg)); }
        catch (e) {
          if (e?.response?.status !== 429) throw e;
          const again = Math.max(backOff(host, e), nextAt.get(host) ?? 0);
          nextAt.set(host, again + gapFor(host));
          stats.retried429++;
          await sleep(again - now());
          stats.requests++;
          stats.byHost[host]++;
          try { return ok(host, await get(url, cfg)); }
          catch (e2) { if (e2?.response?.status === 429) backOff(host, e2); throw e2; }
        }
      })();
      entry.promise.then(() => { entry.doneAt = now(); }, () => { stats.failed++; if (shared.get(key) === entry) shared.delete(key); });
      shared.set(key, entry);
      return entry.promise;
    },
    // backlogMs: how long a request to that host made now would wait
    stats() {
      const t = now();
      return { gapMs: typeof gapMs === 'function' ? Object.fromEntries([...nextAt.keys()].map(h => [h, gapFor(h)])) : gapMs, ...stats, byHost: { ...stats.byHost }, backlogMs: Object.fromEntries([...nextAt].map(([h, at]) => [h, Math.max(0, Math.round(at - t))])) };
    },
  };
}
// Polymarket allows 150 to 300 requests per 10 seconds per endpoint and
// Kalshi 20 reads a second. Grading wallets reads Polymarket's data API
// hardest, so it gets about 7 a second (70 per 10 s, under half the
// strictest limit); Gamma, the order book and Kalshi 4 to 5. Anyone else: one
// a second. UPSTREAM_GAP_MS sets one gap for every host.
const HOST_GAP_MS = { 'data-api.polymarket.com': 150, 'gamma-api.polymarket.com': 250, 'clob.polymarket.com': 200, 'api.elections.kalshi.com': 250, 'gateway.polymarket.us': 100 };
const UPSTREAM_GAP_MS = Number.isFinite(parseFloat(process.env.UPSTREAM_GAP_MS)) ? Math.max(0, parseFloat(process.env.UPSTREAM_GAP_MS)) : null;
const upstreamGap = UPSTREAM_GAP_MS != null ? UPSTREAM_GAP_MS : host => HOST_GAP_MS[host] ?? 1000;
// axios.get is looked up on every call, so tests can stub it after this file loads
const upstream = createPoliteHttp((url, cfg) => axios.get(url, cfg), { gapMs: upstreamGap });

// Scores survive restarts (scoring every candidate again takes hours of
// polite requests): Postgres table tail_traders with DATABASE_URL, otherwise
// the TAIL_TRADERS_FILE JSON file.
function createTraderStoreFromEnv(env = process.env) {
  if (!env.DATABASE_URL) return createDocFileStore(env.TAIL_TRADERS_FILE || path.join(__dirname, 'data', 'tail-traders.json'));
  const { Pool } = require('pg');
  const pool = new Pool({
    connectionString: env.DATABASE_URL,
    ssl: /localhost|127\.0\.0\.1|\.railway\.internal/.test(env.DATABASE_URL) ? false : { rejectUnauthorized: false },
  });
  return {
    kind: 'postgres',
    async init() { await pool.query('CREATE TABLE IF NOT EXISTS tail_traders (id TEXT PRIMARY KEY, doc JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())'); },
    async all() { return (await pool.query('SELECT doc FROM tail_traders')).rows.map(r => r.doc); },
    async put(tr) {
      await pool.query(`INSERT INTO tail_traders (id, doc, updated_at) VALUES ($1, $2, now())
        ON CONFLICT (id) DO UPDATE SET doc = EXCLUDED.doc, updated_at = now()`, [tr.id || tr.wallet, tr]);
    },
  };
}

// Thresholds come from TAIL_* (see .env.example), e.g. TAIL_MIN_TRADE, TAIL_A_MIN_Z.
const tailEngine = tail.createTailEngine({ http: upstream, store: createTraderStoreFromEnv(), opts: tail.optionsFromEnv() });
// TAIL_STREAM=off: poll only
const tailStream = createTradeStream({ onTrades: trades => runTailJob('stream', () => streamTail(trades)) });
const tailStreamOn = !/^(off|0|false|no)$/i.test(String(process.env.TAIL_STREAM || '').trim());
const tailTracker = createTailTracker({ store: createTailStoreFromEnv(), http: upstream });
tailTracker.ready().catch(e => console.error('Tail tracker: store failed to initialise:', e.message));
// the fresh-wallet radar's own record: its alerts as flat 1u bets
const freshTracker = createTailTracker({ store: createFreshStoreFromEnv(), http: upstream });
freshTracker.ready().catch(e => console.error('Fresh tracker: store failed to initialise:', e.message));

// Polymarket US: the same game market a US follower can buy (POLYMARKET_US=off: not quoted)
const polymarketUs = pmus.enabledFromEnv() ? pmus.createPolymarketUs({ http: upstream }) : null;
const TAIL_REGION = xarb.regionFromEnv();   // 'us' | 'intl'
const XARB_OPTS = xarb.optsFromEnv();          // carries the region too
const XARB_ALERT_MIN = Number.isFinite(parseFloat(process.env.XARB_ALERT_MIN)) ? parseFloat(process.env.XARB_ALERT_MIN) : 1;
const XARB_REALERT_MS = 30 * 60e3;   // an arb gone this long that comes back is news again
// Kalshi vs Polymarket US arbs: the Polymarket US leagues read each scan
// (XARB_PMUS_LEAGUES; off = none) and at most this many of its live books
// read to confirm what clears (XARB_PMUS_BOOKS_PER_SCAN)
const XARB_PMUS_LEAGUES = pmus.arbLeaguesFromEnv();
const XARB_PMUS_BOOKS = Number.isFinite(parseInt(process.env.XARB_PMUS_BOOKS_PER_SCAN)) ? Math.max(0, parseInt(process.env.XARB_PMUS_BOOKS_PER_SCAN)) : 40;
const xarbState = { arbs: [], errors: [], counts: null, updated: null, durationMs: null, running: false, primed: { kalshi: false, polymarket: false, polymarketus: false }, kalshiTitles: new Map(),
  venues: null };   // the last scan's rows, indexed for routing signals (xarb.venueIndex)
const xarbSeen = new Map();          // arb id → last scan it showed up in (ms)
// every Kalshi GAME/MATCH series read on its own, a slice a scan, so games
// the capped open-events list misses can still be tailed (XARB_GAME_SERIES_PER_SCAN, default 40; 0 = off)
const KALSHI_GAME_SWEEP_PER_SCAN = Number.isFinite(parseInt(process.env.XARB_GAME_SERIES_PER_SCAN)) ? parseInt(process.env.XARB_GAME_SERIES_PER_SCAN) : 40;
const kalshiGameSweep = KALSHI_GAME_SWEEP_PER_SCAN > 0 ? xarb.createKalshiGameSweep({ http: upstream, perScan: KALSHI_GAME_SWEEP_PER_SCAN }) : null;

const whaleWatcher = whales.createWhaleWatcher({
  http: upstream, opts: whales.optionsFromEnv(),
  // a wallet tail.js has scored: its grade in that market's category
  gradeOf: (wallet, trade) => {
    const tr = tailEngine.trader(wallet);
    return tr ? { grade: tail.gradeFor(tr, tail.classify(trade), tailEngine.settings()).grade, name: tr.name } : null;
  },
  // Kalshi trades carry only a ticker; the arb scan knows every open market's title
  kalshiInfo: ticker => xarbState.kalshiTitles.get(ticker) || null,
  // the fresh-wallet radar: one read of an ungraded whale's trade history
  walletHistory: wallet => whales.fetchWalletHistory(upstream, wallet),
});

// /api/ev/stream subscribers: fn(eventType, data)
const liveListeners = new Set();
function broadcast(type, data) {
  for (const fn of liveListeners) { try { fn(type, data); } catch { /* keep going */ } }
}
// One Discord-style post of up to 10 lines. TAIL_WEBHOOK=off stops these.
function postAlert(lines, what) {
  if (!lines.length || !process.env.ALERT_WEBHOOK_URL || process.env.TAIL_WEBHOOK === 'off') return null;
  const out = lines.slice(0, 10);
  if (lines.length > 10) out.push(`…and ${lines.length - 10} more`);
  return axios.post(process.env.ALERT_WEBHOOK_URL, { username: 'Line Reaper', content: out.join('\n').slice(0, 1900) }, { timeout: 10000 })
    .catch(e => console.warn(`${what}: webhook failed:`, e.message));
}
const cents = p => (p == null ? '—' : `${Math.round(p * 1000) / 10}¢`);
const dollars = x => `$${Math.round(x || 0).toLocaleString('en-US')}`;
const shortWallet = w => (w ? `${w.slice(0, 6)}…${w.slice(-4)}` : '?');
const american = a => (a == null ? '—' : a > 0 ? `+${a}` : String(a));

// ── US mode: no polymarket.com links ──
// Any string that is a polymarket.com URL becomes null, however deep. Only
// links: the data API and image hosts aren't pages anyone is sent to.
const PM_LINK = /^https?:\/\/(?:www\.)?polymarket\.com(?:[/?#]|$)/i;
function stripPolymarketLinks(x) {
  if (typeof x === 'string') return PM_LINK.test(x) ? null : x;
  if (Array.isArray(x)) return x.map(stripPolymarketLinks);
  if (!x || typeof x !== 'object') return x;
  const out = {};
  for (const [k, v] of Object.entries(x)) out[k] = stripPolymarketLinks(v);
  return out;
}
const regionSafe = x => (TAIL_REGION === 'us' ? stripPolymarketLinks(x) : x);

// ── where to tail ──
// Each new entry signal gets every venue quote for the same proposition
// (xarb.venueQuotes over the last arb scan), each sized with tail.sizeAt at
// that venue's price and fee, and the one with the most units as `venue`
// (ties: cheaper). No venue in US mode: venue null, "watch only". A top-up
// only adds what the venue's size is above the units already signalled.
const NO_VENUE = TAIL_REGION === 'us' ? 'No US venue found yet: watch only' : 'No venue found yet: watch only';
const r2u = x => Math.round(x * 100) / 100;
function sizeQuote(s, v) {
  const q = Number(s.q ?? s.prob);
  let z = null;
  if (typeof tail.sizeAt === 'function' && q > 0 && q < 1) {
    try {
      z = tail.sizeAt({ q, price: v.price, feePerContract: v.fee || 0, grade: s.grade, consensus: Array.isArray(s.consensus) && s.consensus.length ? s.consensus : 1, opts: tailEngine.settings() });
    } catch (e) { console.warn('Tail venue sizing:', e.message); }
  }
  let units = Number.isFinite(z?.units) ? z.units : 0;
  // in-play and near-certain bets aren't tails anywhere; nor is any venue's price at the near-certain line
  const maxEntry = tailEngine.settings().maxEntryPrice;
  if (s.blocked || (Number.isFinite(maxEntry) && v.price >= maxEntry - 1e-9)) units = 0;
  // a top-up adds only what this venue's size is above what was already
  // signalled (the engine remembers that from the venue it was sent to)
  const before = Number(s.priorUnits) > 0 ? Number(s.priorUnits) : 0;
  if (before > 0) units = Math.max(0, r2u(units - before));
  // and no more than the room left on this game or event (its other markets' tails count)
  if (Number.isFinite(s.eventRoom)) units = Math.max(0, Math.min(units, s.eventRoom));
  return { ...v, units, kelly: z?.kelly ?? null, maxPrice: z?.maxPrice ?? null };
}
const venueView = v => (v ? { key: v.key, name: v.name, price: v.price, fee: v.fee, cost: v.cost, ...(v.american != null ? { american: v.american } : {}),
  units: v.units, kelly: v.kelly, maxPrice: v.maxPrice, pick: v.pick ?? null, ...(v.buy ? { buy: v.buy } : {}), ...(v.side ? { side: v.side } : {}), url: v.url || null,
  ...(v.warning ? { warning: v.warning } : {}) } : null);
// the routing of recent signals by id, in case the engine hands back copies
const routedSignals = new Map();
// extra: quotes found elsewhere (Polymarket US) to weigh with the scan's
function routeSignal(s, { index = xarbState.venues, now = Date.now(), extra = [] } = {}) {
  if (!s || s.type !== 'entry') return s;
  let quotes = [];
  try { quotes = xarb.venueQuotes(s, index, { ...XARB_OPTS, now }); } catch (e) { console.warn('Tail venues:', e.message); }
  quotes = [...quotes, ...(extra || []).filter(Boolean)];
  const venues = quotes.map(v => sizeQuote(s, v));
  venues.sort((a, b) => (b.units - a.units) || (a.cost - b.cost) || (a.price - b.price));
  s.venues = venues.map(venueView);
  s.venue = venueView(xarb.pickVenue(venues));
  if (s.id) {
    routedSignals.delete(s.id);
    routedSignals.set(s.id, { venue: s.venue, venues: s.venues });
    while (routedSignals.size > 2000) routedSignals.delete(routedSignals.keys().next().value);
  }
  return s;
}
// A viewer without the Kalshi licence gets the best venue that isn't Kalshi.
function venueFor(sig, lic) {
  const s = sig && !('venue' in sig) && routedSignals.has(sig.id) ? { ...sig, ...routedSignals.get(sig.id) } : sig;
  if (s?.type !== 'entry' || lic.kalshi || !Array.isArray(s.venues) || !s.venues.some(v => v.key === 'kalshi')) return s;
  const venues = s.venues.filter(v => v.key !== 'kalshi');
  return { ...s, venues, venue: xarb.pickVenue(venues), venueNote: `Kalshi prices: ${LICENCE_NOTE}` };
}
// "Tail at Kalshi: NO New York K 55¢ · 1.25u · don't pay above 58¢" (a book's price in American odds too).
// What to buy is spelled out: on Kalshi the same bet can be YES on one market or NO on another.
function venueLine(s) {
  const v = s.venue;
  if (!v) return NO_VENUE;
  const book = v.american != null;
  const max = v.maxPrice == null ? '—' : book ? `${cents(v.maxPrice)} (${american(evScreen.probToAmerican(v.maxPrice))})` : cents(v.maxPrice);
  return `Tail at ${v.name}${v.buy ? `: ${v.buy}` : ''} ${book ? american(v.american) : cents(v.price)} · ${v.units}u · don't pay above ${max}`;
}
// <url> stops Discord unfurling a preview card under every line. US mode
// links the venue, never polymarket.com.
function describeTail(s) {
  const who = `${s.grade}-grade ${s.name || shortWallet(s.wallet)}`;
  const where = `${s.outcome || '?'} on "${s.market}" at ${cents(s.theirPrice)} (${dollars(s.theirNotional)})`;
  const url = TAIL_REGION === 'us' ? (s.venue?.url && !PM_LINK.test(s.venue.url) ? s.venue.url : null) : s.url;
  const link = url ? ` <${url}>` : '';
  if (s.type === 'exit') return describeExit(s, who);
  const size = s.units > 0 || s.venue ? venueLine(s) : `0u: ${s.reason}`;
  return `🐋 ${who} bought ${where} · ${size}${s.isConsensus ? ` · consensus ×${s.consensus.length}` : ''}${link}`;
}
// "🚪 Exit: A-grade X sold 80% of Yes on "…" at 62¢ ($4,000), bought at 41¢ · we tailed it 1.2u at Kalshi: YES … <url>"
// The venue is where the entry was sent, so followers know where to sell.
function describeExit(s, who) {
  const share = s.soldShare != null && s.soldShare < 0.995 ? `${Math.round(s.soldShare * 100)}% of ` : '';
  const paid = s.boughtAt != null ? `, bought at ${cents(s.boughtAt)}` : '';
  let v = s.tailed?.id ? routedSignals.get(s.tailed.id)?.venue : null;
  if (v?.key === 'kalshi' && !webhookLicence().kalshi) v = null;
  const ours = s.tailed ? ` · we tailed it ${s.tailed.units}u${v ? ` at ${v.name}${v.buy ? `: ${v.buy}` : ''}` : ''}` : '';
  const url = TAIL_REGION === 'us' ? (v?.url && !PM_LINK.test(v.url) ? v.url : null) : (v?.url || s.url);
  return `🚪 Exit: ${who} sold ${share}${s.outcome || '?'} on "${s.market}" at ${cents(s.theirPrice)} (${dollars(s.theirNotional)})${paid}${ours}${url ? ` <${url}>` : ''}`;
}
const VENUE_NAMES = { kalshi: 'Kalshi', polymarket: 'Polymarket', polymarketus: 'Polymarket US' };
function describeArb(a) {
  const legs = (a.legs || []).map(l => `${l.venueTitle || VENUE_NAMES[l.venue] || l.venue} ${l.pick} ${l.price != null ? cents(l.price) : l.american > 0 ? `+${l.american}` : l.american}`).join(' + ');
  const note = a.exhaustive === false ? ' · NOT PROVEN EXHAUSTIVE' : '';
  return `♻️ Arb +${a.profitPct}%${note}: ${a.title} · ${legs}${a.warnings?.length ? ` · ⚠ ${a.warnings.join('; ')}` : ''}`;
}

// Each cron job's last run and error, for /api/status.
const tailJobs = {};
async function runTailJob(name, fn) {
  const j = tailJobs[name] ||= { lastRun: null, ms: null, error: null };
  const t0 = Date.now();
  try { const out = await fn(); j.error = null; return out; }
  catch (e) { j.error = e?.message || String(e); console.warn(`Tail ${name}:`, j.error); return null; }
  finally { j.lastRun = new Date().toISOString(); j.ms = Date.now() - t0; }
}

// New trades → signals. Sized ones are logged for the track record. The
// first poll after a restart re-reads the last hour, so then only what the
// tracker hadn't logged before counts as news. "First" is read before the
// await: a slow first poll overlapped by the next tick (which returns [] as
// busy) is still the first one when it lands. A top-up adds to a position
// already pinged, so it isn't pinged again.
let tailPolled = false;
const tailRouting = { routed: 0, withVenue: 0, lastAt: null, byCategory: {}, byVenue: {} };
// What a routed entry told followers to add: the venue's units, or with no
// venue the Polymarket size the track record logs it at.
const tailUnits = s => (s.venue && Number(s.venue.price) > 0 && Number(s.venue.price) < 1 ? Number(s.venue.units) || 0 : Number(s.units) || 0);
// where to tail, as each entry is made (so the next buy by the same wallet
// tops up what that venue was told) and before it's logged (the record
// grades it at that venue's price)
async function routeTail(s) {
  let extra = [];
  if (polymarketUs && s?.type === 'entry' && !s.blocked) {
    try { const q = await polymarketUs.quoteFor(s); if (q) extra = [q]; } catch (e) { console.warn('Polymarket US:', e.message); }
  }
  routeSignal(s, { extra });
  tailRouting.routed++;
  if (s.venue) tailRouting.withVenue++;
  const c = tailRouting.byCategory[s.category || 'other'] ||= { routed: 0, withVenue: 0 };
  c.routed++;
  if (s.venue) c.withVenue++;
  if (s.venue?.key) tailRouting.byVenue[s.venue.key] = (tailRouting.byVenue[s.venue.key] || 0) + 1;
  tailRouting.lastAt = new Date().toISOString();
  return tailUnits(s);
}
// The webhook gets every new A entry and consensus, and B entries that are
// sized somewhere (TAIL_PING_B=off: A and consensus only).
const TAIL_PING_B = !/^(off|0|false|no)$/i.test(String(process.env.TAIL_PING_B || '').trim());
async function pollTail() {
  const primed = tailPolled;
  const fresh = await publishTail(await tailEngine.pollTrades({ route: routeTail }), primed);
  tailPolled = true;
  return fresh;
}
// Trades pushed by Polymarket's live feed: the same signals as the poll, out
// within seconds of the fill.
async function streamTail(trades) {
  return publishTail(await tailEngine.ingest(trades, { route: routeTail }), tailPolled);
}
// A first entry: every A and consensus, B when sized somewhere. A blocked buy
// (in-play, near-certain, split) is nothing to act on. An exit pings only when
// followers are in it: the wallet sold most of a position we tailed.
const tailPings = s => (s.type === 'exit' ? !!s.tailed && s.full !== false
  : !s.parentId && !s.blocked && (s.grade === 'A' || s.isConsensus || (TAIL_PING_B && s.grade === 'B' && tailUnits(s) > 0)));
async function publishTail(signals, primed) {
  const fresh = [], ping = [];
  for (const s of signals) {
    let logged = false;
    try { logged = await tailTracker.record(s); } catch (e) { console.warn('Tail tracker:', e.message); }
    if (logged || primed) fresh.push(s);
    // exits aren't logged; once primed, a tailed one is news (the engine
    // only knows what it tailed since it started, so nothing repeats)
    if ((logged || (s.type === 'exit' && primed)) && tailPings(s)) ping.push(s);
  }
  if (fresh.length) broadcast('tail', fresh);
  // the webhook can reach other people: Polymarket wallets only with that
  // licence, Kalshi venues only with Kalshi's
  const lic = webhookLicence();
  if (lic.polymarket) postAlert(ping.map(s => describeTail(venueFor(s, lic))), 'Tail alerts');
  return fresh;
}

// Every 2 minutes: the top of the Sharp Board priced from the live order
// book, and a "second chance" alert when a side the sharps hold is back at or
// under their average entry (tail.boardAlerts). The prices also feed
// /api/tail/board for a few minutes.
const boardPrices = new Map();   // token → { ask, at }
const BOARD_PRICE_TTL_MS = 5 * 60e3;
let boardWatch = new Map(), boardPrimed = false;
const boardLivePrice = asset => { const p = boardPrices.get(String(asset)); return p && Date.now() - p.at < BOARD_PRICE_TTL_MS ? p.ask : null; };
async function watchBoard() {
  const top = tailEngine.sharpBoard({ limit: 40 });
  for (const r of top) {
    const b = await tailEngine.book(r.lead.asset);
    if (b?.ask != null) boardPrices.set(String(r.lead.asset), { ask: b.ask, at: Date.now() });
  }
  for (const [k, p] of boardPrices) if (Date.now() - p.at > BOARD_PRICE_TTL_MS * 3) boardPrices.delete(k);
  const rows = tailEngine.sharpBoard({ limit: 40, livePrice: boardLivePrice });
  const { alerts, state } = tail.boardAlerts(rows, boardWatch, { now: Date.now(), prime: !boardPrimed });
  boardWatch = state;
  boardPrimed = true;
  if (!alerts.length) return [];
  const all = { polymarket: true, kalshi: true };
  const out = alerts.map(a => ({ ...a, venues: boardVenues({ conditionId: a.conditionId, title: a.title, lead: { asset: a.asset, outcome: a.outcome, outcomeIndex: a.outcomeIndex } }, all) }));
  broadcast('board', out);
  const lic = webhookLicence();
  if (lic.polymarket) postAlert(out.map(a => describeBoardAlert(lic.kalshi ? a : { ...a, venues: a.venues.filter(v => v.key !== 'kalshi') })), 'Board alerts');
  return out;
}
// "🎯 Second chance: 3 sharps (2A 1B) hold Yes on "…" at 41¢ avg; it's 39¢ now · Kalshi 40¢ <url>"
function describeBoardAlert(a) {
  const mix = [a.A ? `${a.A}A` : '', a.B ? `${a.B}B` : ''].filter(Boolean).join(' ');
  const v = (a.venues || [])[0];
  const where = v ? ` · ${v.name}${v.buy ? `: ${v.buy}` : ''} ${v.american != null ? american(v.american) : cents(v.price)}` : ` · ${NO_VENUE}`;
  const url = v?.url && !(TAIL_REGION === 'us' && PM_LINK.test(v.url)) ? ` <${v.url}>` : '';
  return `🎯 Second chance: ${a.wallets} sharp${a.wallets === 1 ? '' : 's'} (${mix}) hold ${a.outcome || '?'} on "${a.title}" at ${cents(a.avgEntry)} avg; it's ${cents(a.price)} now${where}${url}`;
}

async function pollWhales() {
  const fresh = await whaleWatcher.poll();
  for (const e of fresh.filter(x => x.fresh)) {
    try { await publishFresh(e); } catch (err) { console.warn('Fresh wallets:', err.message); }
  }
  if (fresh.length) broadcast('whale', fresh);
  return fresh;
}

// ── fresh-wallet radar ──
// A fresh wallet's buy (whales.js tags it) gets every venue asking the same
// question (xarb.venueQuotes; US mode: Kalshi and US books only), cheapest all
// in first, as e.venues and e.venue. One still open, not near-certain, not
// resolving within minutes and not bought after its game started is logged
// in the radar's own record as a flat 1u at what a follower could pay then
// (the cheapest venue, else Polymarket's ask plus its taker fee) and pinged.
// → the record's signal, or null when it isn't followable.
const FRESH_UNITS = 1;
async function freshSignal(e, { now = Date.now() } = {}) {
  let quotes = [];
  try { quotes = xarb.venueQuotes(e, xarbState.venues, { ...XARB_OPTS, now }); } catch (err) { console.warn('Fresh venues:', err.message); }
  quotes.sort((a, b) => (a.cost - b.cost) || (a.price - b.price));
  e.venues = quotes.map(v => venueView({ ...v, units: FRESH_UNITS }));
  e.venue = e.venues[0] || null;
  const o = tailEngine.settings();
  let market = null;
  try { market = e.conditionId ? await tail.fetchMarket(upstream, e.conditionId) : null; } catch (err) { console.warn('Fresh market:', err.message); }
  if (!market || market.closed || market.active === false) return null;
  const end = tail.toMs(market.gameStartTime) == null ? tail.toMs(market.endDate) : null;
  if (end != null && end - now < o.minCloseMs) return null;
  const started = tail.toMs(market.gameStartTime);
  if (started != null && Date.parse(e.at) >= started) return null;
  if (e.price >= o.maxEntryPrice - 1e-9) return null;
  const book = await tailEngine.book(e.asset);
  const ask = tail.liveAsk(market, book, e, { now, opts: o }).price;
  if (ask == null && !e.venue) return null;
  const category = tail.classify({ ...e, question: market.question, eventSlug: e.eventSlug || market.eventSlug });
  return {
    id: `fresh:${e.id}`, type: 'entry', wallet: e.wallet, name: e.name || null, grade: 'fresh', scope: 'radar', category,
    market: e.title || market.question || '', eventSlug: e.eventSlug || market.eventSlug || null, conditionId: e.conditionId, asset: e.asset,
    outcome: e.outcome, outcomeIndex: e.outcomeIndex, url: e.url || null, theirPrice: e.price, theirNotional: e.notional,
    currentPrice: ask, fee: ask == null ? 0 : tail.polymarketFee(ask, market.fee), units: FRESH_UNITS, venue: e.venue, at: e.at, fresh: e.fresh,
  };
}
async function publishFresh(e) {
  const sig = await freshSignal(e);
  if (!sig || !(await freshTracker.record(sig))) return false;
  const lic = webhookLicence();
  if (lic.polymarket) postAlert([describeFresh(e, lic)], 'Fresh wallet alerts');
  return true;
}
// "🆕 Fresh wallet (first trade 2.1 days ago, 1 market) bought Yes on "…" at 18¢ ($12,400) · Kalshi: YES … 20¢ <url>"
function describeFresh(e, lic = { kalshi: true }) {
  const v = (e.venues || []).find(x => lic.kalshi || x.key !== 'kalshi') || null;
  const f = e.fresh || {};
  const age = f.ageDays < 1 ? 'today' : `${f.ageDays} days ago`;
  const where = v ? ` · ${v.name}${v.buy ? `: ${v.buy}` : ''} ${v.american != null ? american(v.american) : cents(v.price)}` : ` · ${NO_VENUE}`;
  const link = TAIL_REGION === 'us' ? (v?.url && !PM_LINK.test(v.url) ? v.url : null) : e.url;
  return `🆕 Fresh wallet (first trade ${age}, ${f.markets} market${f.markets === 1 ? '' : 's'}) bought ${e.outcome || '?'} on "${e.title}" at ${cents(e.price)} (${dollars(e.notional)})${where}${link ? ` <${link}>` : ''}`;
}

const countBy = (list, keyOf) => { const out = {}; for (const x of list) { const k = keyOf(x); out[k] = (out[k] || 0) + 1; } return out; };
// The Owls and Odds API feeds can both carry a game: one book arb per game and legs.
function dedupeArbs(arbs) {
  const out = new Map();
  for (const a of arbs) {
    const key = a.type === 'book' ? `book|${a.title}|${a.legs.map(l => `${l.venue}:${l.pick}`).join('+')}` : a.id;
    if (!out.has(key) || out.get(key).profitPct < a.profitPct) out.set(key, a);
  }
  return [...out.values()].sort((a, b) => b.profitPct - a.profitPct);
}

// Kalshi vs Polymarket US (xarb.findUsArbs): every game the Polymarket US
// leagues list, paired with this scan's Kalshi rows the way Polymarket's are,
// plus Polymarket US's own soccer result sets. What clears on the listed
// prices is re-priced on the live books (which also say how many contracts
// sit at that price) before it counts (a result set missing a book is no set:
// xarb.findUnderrounds). → { arbs, rows, games, matches, screened }
async function polymarketUsArbs(kalshi, now) {
  const none = { arbs: [], rows: 0, games: 0, matches: 0, screened: 0 };
  if (!polymarketUs || !XARB_PMUS_LEAGUES.length) return none;
  const rows = await polymarketUs.arbRows({ leagues: XARB_PMUS_LEAGUES });
  if (!rows.length) return none;
  const o = { ...XARB_OPTS, now };
  const matches = xarb.matchMarkets(kalshi, rows, o);
  const screened = xarb.findUsArbs(kalshi, rows, { ...o, matches });
  const counts = { rows: rows.length, games: new Set(rows.map(r => r.eventKey)).size, matches: matches.length, screened: screened.length };
  if (!screened.length || XARB_PMUS_BOOKS <= 0) return { ...none, ...counts };
  const ids = new Set(screened.flatMap(a => a.legs.filter(l => l.venue === 'polymarketus').map(l => l.marketId)));
  const live = await polymarketUs.reprice(rows.filter(r => ids.has(r.id)), { maxBooks: XARB_PMUS_BOOKS });
  const liveRows = [...live.values()].filter(Boolean);
  const byId = new Map(liveRows.map(r => [r.id, r]));
  const liveMatches = matches.filter(m => byId.has(m.polymarket.id)).map(m => ({ ...m, polymarket: byId.get(m.polymarket.id) }));
  return { ...counts, arbs: xarb.findUsArbs(kalshi, liveRows, { ...o, matches: liveMatches }) };
}

// One scan: every open Kalshi and Polymarket event, plus the game lines the
// backend already holds (sportsbooks, with the exchange books attached).
async function scanXarbs() {
  if (xarbState.running) return [];
  xarbState.running = true;
  const t0 = Date.now();
  try {
    // each page parsed as it lands; the raw JSON isn't kept
    const kalshi = [], polymarket = [];
    const [k, p, swept] = await Promise.all([
      xarb.fetchKalshiEvents(upstream, { onPage: page => kalshi.push(...xarb.parseKalshiBinaries(page)) }),
      xarb.fetchPolymarketEvents(upstream, { onPage: page => polymarket.push(...xarb.parsePolymarketBinaries(page)) }),
      kalshiGameSweep ? kalshiGameSweep.step().catch(e => { console.warn('Kalshi game sweep:', e.message); return []; }) : [],
    ]);
    // the sweep's games the main list missed (the main list's copy is fresher)
    const listed = new Set(kalshi.map(r => r.id));
    let sweptIn = 0;
    for (const r of swept) if (!listed.has(r.id)) { kalshi.push(r); sweptIn++; }
    let games = [];
    try { games = evFeeds().filter(f => /odds$/.test(f.label)).flatMap(f => f.games); }
    catch (e) { console.warn('Exchange arbs: game feeds:', e.message); }
    const now = Date.now();
    // matched once: the cross-exchange arbs (intl) and signal routing both use it
    const matches = xarb.matchMarkets(kalshi, polymarket, { ...XARB_OPTS, now, games });
    let us = { arbs: [], rows: 0, games: 0, matches: 0, screened: 0 };
    try { us = await polymarketUsArbs(kalshi, now); } catch (e) { console.warn('Exchange arbs: Polymarket US:', e.message); }
    const arbs = dedupeArbs([...xarb.findArbs({ kalshi, polymarket, games }, { ...XARB_OPTS, now, matches }), ...us.arbs]);
    if (polymarket.length) xarbState.venues = xarb.venueIndex({ kalshi, polymarket, matches, games }, { ...XARB_OPTS, now });
    if (kalshi.length) {
      xarbState.kalshiTitles = new Map(kalshi.map(r => [r.id, {
        title: r.outcomeLabel && !r.title.toLowerCase().includes(r.outcomeLabel.toLowerCase()) ? `${r.title} · ${r.outcomeLabel}` : r.title,
        eventTicker: r.eventKey.replace(/^kalshi:/, ''), url: r.url,
      }]));
    }
    Object.assign(xarbState, {
      arbs, errors: [...k.errors, ...p.errors], updated: new Date(now).toISOString(), durationMs: Date.now() - t0,
      counts: { kalshiEvents: k.count, kalshiPages: k.pages, kalshiTruncated: k.truncated, kalshiMarkets: kalshi.length,
        polymarketEvents: p.count, polymarketPages: p.pages, polymarketTruncated: p.truncated, polymarketMarkets: polymarket.length, games: games.length, arbs: arbs.length,
        kalshiSwept: sweptIn, matches: matches.length, matchesBy: countBy(matches, m => m.by),
        polymarketUs: { rows: us.rows, games: us.games, matches: us.matches, screened: us.screened, arbs: us.arbs.length } },
    });
    const fresh = arbs.filter(a => !xarbSeen.has(a.id) || now - xarbSeen.get(a.id) > XARB_REALERT_MS);
    for (const a of arbs) xarbSeen.set(a.id, now);
    for (const [id, at] of xarbSeen) if (now - at > 86400e3) xarbSeen.delete(id);
    // An exchange's first scan with data only primes: a restart, or that
    // exchange coming back after being down at startup, isn't news. So an arb
    // with a leg on an exchange that wasn't primed before this scan is quiet.
    const before = { ...xarbState.primed };
    if (kalshi.length) xarbState.primed.kalshi = true;
    if (polymarket.length) xarbState.primed.polymarket = true;
    if (us.rows) xarbState.primed.polymarketus = true;
    const news = fresh.filter(a => (a.legs || []).every(l => !(l.venue in before) || before[l.venue]));
    if (news.length) {
      broadcast('xarb', news);
      // an outcome set not proven exhaustive can lose every leg: listed, never
      // alerted; and the webhook only gets legs the public may see
      const ok = arbOk(webhookLicence());
      postAlert(news.filter(a => a.profitPct >= XARB_ALERT_MIN && a.exhaustive !== false && ok(a)).map(describeArb), 'Exchange arbs');
    }
    return news;
  } finally { xarbState.running = false; }
}

// Free users get the shape of it, not who to follow: wallets become a keyed
// hash (not reversible from Polymarket's public leaderboard), and names and
// dollar totals (which would find the wallet on that leaderboard) are dropped.
// So is anything a dollar total can be worked back from (edge with roi gives
// risked and P&L), and anything that fingerprints the trade itself: Polymarket
// lists every trade of a market with its wallet, so market + exact size +
// exact time finds the wallet. Free rows get the market and side, a price to
// the cent, a time to the quarter hour and a size range.
const TAIL_FREE_DELAY_MS = 30 * 60e3;
const FREE_TIME_MS = 15 * 60e3;
const maskId = v => (v ? `x${require('crypto').createHmac('sha256', AUTH_SECRET).update(String(v)).digest('hex').slice(0, 12)}` : null);
const maskWallet = w => (w ? `${String(w).slice(0, 4)}••••` : null);
const quarterHour = v => { const t = v ? Date.parse(v) : NaN; return Number.isFinite(t) ? new Date(Math.floor(t / FREE_TIME_MS) * FREE_TIME_MS).toISOString() : v ?? null; };
const toCent = v => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 100) / 100 : v ?? null);
const SIZE_STEPS = [500, 1000, 2500, 5000, 10000, 25000, 50000, 100000, 250000, 500000, 1e6];
const kUsd = x => (x >= 1e6 ? `$${x / 1e6}M` : x >= 1000 ? `$${x / 1000}k` : `$${x}`);
function sizeRange(x) {
  if (!(x > 0)) return null;
  const i = SIZE_STEPS.findIndex(v => x < v);
  if (i === 0) return `under ${kUsd(SIZE_STEPS[0])}`;
  if (i < 0) return `${kUsd(SIZE_STEPS[SIZE_STEPS.length - 1])}+`;
  return `${kUsd(SIZE_STEPS[i - 1])}–${kUsd(SIZE_STEPS[i])}`;
}
// "only $45,123 risked (need $50,000)" names the wallet's total; the bar is public
const freeText = t => String(t).replace(/only \$[\d,.]+ risked/g, 'not enough risked');
const freeReasons = list => (Array.isArray(list) ? list.map(freeText) : list);
const round2 = v => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 100) / 100 : v ?? null);
const TRADER_PRIVATE = ['pnl', 'risked', 'openValue', 'lastAt', 'sources', 'truncated', 'edge', 'openPnl', 'openRisked', 'forwardPnl', 'selectedAt'];
function maskStats(s) {
  const out = { ...s };
  for (const k of TRADER_PRIVATE) delete out[k];
  for (const k of ['roi', 'resolvedRoi', 'recentRoi', 'forwardRoi']) if (k in out) out[k] = round2(out[k]);
  for (const k of ['reasons', 'whyNotA']) if (k in out) out[k] = freeReasons(out[k]);
  return out;
}
function maskTrader(tr) {
  const categories = {};
  for (const [c, s] of Object.entries(tr.categories || {})) categories[c] = maskStats(s);
  return { ...maskStats(tr), id: maskId(tr.wallet), wallet: maskWallet(tr.wallet), name: null, url: null, categories, locked: true };
}
// signals and tracked records: their ids carry the wallet (and tx hash) too.
// q (our probability) gives the edge back like prob does, and so does a
// venue's Kelly with its price; the venue line itself (units, max price) stays.
const maskVenue = v => { if (!v || typeof v !== 'object') return v; const { kelly, ...rest } = v; return rest; };
function maskSignal(s) {
  const { conditionId, asset, theirSize, txHash, edge, prob, q, kelly, slippage, ...rest } = s;
  return {
    ...rest, id: maskId(s.id), wallet: maskWallet(s.wallet), name: null, consensus: (s.consensus || []).map(maskWallet),
    ...('venue' in s ? { venue: maskVenue(s.venue) } : {}), ...(Array.isArray(s.venues) ? { venues: s.venues.map(maskVenue) } : {}),
    ...(s.parentId ? { parentId: maskId(s.parentId) } : {}), ...(Array.isArray(s.topUps) ? { topUps: s.topUps.map(maskId) } : {}),
    theirPrice: toCent(s.theirPrice), ...('entry' in s ? { entry: toCent(s.entry) } : {}),
    ...('boughtAt' in s ? { boughtAt: toCent(s.boughtAt) } : {}), ...(s.soldShare != null ? { soldShare: Math.round(s.soldShare * 10) / 10 } : {}),
    ...(s.tailed ? { tailed: { id: maskId(s.tailed.id), units: s.tailed.units } } : {}),
    theirNotional: null, sizeRange: sizeRange(s.theirNotional),
    at: quarterHour(s.at), ...('seenAt' in s ? { seenAt: quarterHour(s.seenAt) } : {}), ...('recordedAt' in s ? { recordedAt: quarterHour(s.recordedAt) } : {}),
    locked: true,
  };
}
// A recent Polymarket whale might be a graded wallet's live bet, so its grade
// waits; and a print that is (or might be) graded is coarsened like a signal.
// Ungraded old prints only lose the wallet: there's nobody to find.
function maskWhale(e, t = Date.now()) {
  if (!e || e.exchange !== 'polymarket') return e;
  const recent = t - Date.parse(e.at) < TAIL_FREE_DELAY_MS;
  const out = { ...e, id: maskId(e.id), wallet: maskWallet(e.wallet), name: null, txHash: null,
    ...(recent ? { grade: null, graded: false, known: false, tag: 'whale', gradeLocked: true, fresh: null, venue: null, venues: null } : {}) };
  if (!recent && !e.graded) return out;
  const sig = n => (n > 0 ? Number(n.toPrecision(2)) : n ?? null);
  return { ...out, conditionId: null, asset: null, contracts: null, price: toCent(e.price), notional: sig(e.notional), sizeRange: sizeRange(e.notional), at: quarterHour(e.at) };
}
// ── what a viewer may see under the data licences ──
// An arb with a leg on an exchange whose licence is off is withheld whole
// (its other legs alone aren't an arb).
const arbOk = lic => a => (a.legs || []).every(l => (l.venue !== 'kalshi' || lic.kalshi) && (l.venue !== 'polymarket' || lic.polymarket));
const whaleOk = lic => e => !e || (e.exchange === 'kalshi' ? lic.kalshi : e.exchange === 'polymarket' ? lic.polymarket : true);
const withheldOf = (lic, sources) => sources.filter(x => !lic[x]);
// live events for one stream listener
function liveFor(type, data, lic) {
  if (!Array.isArray(data)) return [];
  const out = type === 'tail' ? (lic.polymarket ? data.map(s => venueFor(s, lic)) : [])
    : type === 'whale' ? data.filter(whaleOk(lic)).map(kalshiVenuesOk(lic))
    : type === 'xarb' ? data.filter(arbOk(lic))
    : type === 'board' ? (lic.polymarket ? data.map(a => ({ ...a, venues: (a.venues || []).filter(v => lic.kalshi || v.key !== 'kalshi') })) : [])
    : data;
  return regionSafe(out);
}

// /api/whales and /api/status state for free users: no graded count (it would
// say which locked prints are graded) and no error text
function publicWhaleState(st) {
  const { errors, ...rest } = st;
  return { ...rest, lastHour: { whales: st.lastHour?.whales ?? 0, usd: st.lastHour?.usd ?? 0 } };
}
// the engine's errors name wallets and markets, and the last signal time says
// when a live (locked) signal fired
function publicTailState(st) {
  const { errors, lastSignalAt, signals, ...rest } = st;
  return rest;
}
const publicJobs = jobs => Object.fromEntries(Object.entries(jobs).map(([k, j]) => [k, { lastRun: j.lastRun, ms: j.ms, failed: !!j.error }]));

// ─── ROUTES ───────────────────────────────────────────────────────────────────
// The app itself. Served from here it talks to this same server, so one
// deploy ships both and there's no backend URL to keep in sync.
const APP_FILE = path.join(__dirname, 'public', 'index.html');
let appHtml = null;
function loadApp() {
  if (appHtml) return appHtml;
  try {
    appHtml = fs.readFileSync(APP_FILE, 'utf8')
      .replace(/const BACKEND_URL = '[^']*';/, 'const BACKEND_URL = location.origin;');
  } catch { appHtml = null; }
  return appHtml;
}
app.get('/app', (req, res) => {
  const html = loadApp();
  if (!html) return res.status(404).send('App not bundled with this deploy');
  res.set('Cache-Control', 'no-cache').type('html').send(html);
});
// Browsers opening the bare URL get the app; API clients (and the app's own
// health check, which sends Accept: */*) still get the JSON status.
app.get('/', (req, res) => {
  if (req.accepts(['json', 'html']) === 'html' && /text\/html/.test(req.get('accept') || '') && loadApp()) return res.redirect('/app');
  res.json({ status: 'Line Reaper backend running', version: '3.40.0', updated: new Date().toISOString() });
});

// ── ACCOUNTS + BILLING ────────────────────────────────────────────────────────
const sendErr = (res, e) => res.status(e.status || 500).json({ error: e.status ? e.message : 'Something went wrong' });

app.post('/api/auth/signup', async (req, res) => {
  try { res.status(201).json(await auth.signup(req.body?.email, req.body?.password)); }
  catch (e) { sendErr(res, e); }
});
app.post('/api/auth/login', async (req, res) => {
  try { res.json(await auth.login(req.body?.email, req.body?.password)); }
  catch (e) { sendErr(res, e); }
});
app.get('/api/auth/me', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not logged in' });
  res.json({ user: publicUser(req.user), paywall: PAYWALL, billing: billing.configured() });
});
// where Stripe should send people back to: the page they came from
function returnUrl(req, fallback = '/') {
  const u = req.body?.returnUrl || req.get('referer') || fallback;
  return /^https?:\/\//.test(u) ? u : fallback;
}
app.post('/api/billing/checkout', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Log in first' });
  try {
    const back = returnUrl(req, `${req.protocol}://${req.get('host')}/`);
    const sep = back.includes('?') ? '&' : '?';
    res.json(await billing.checkout(req.user, { successUrl: `${back}${sep}upgraded=1`, cancelUrl: back }));
  } catch (e) { console.error('Checkout failed:', e.response?.data?.error?.message || e.message); sendErr(res, e); }
});
app.post('/api/billing/portal', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Log in first' });
  try { res.json(await billing.portal(req.user, { returnUrl: returnUrl(req, `${req.protocol}://${req.get('host')}/`) })); }
  catch (e) { console.error('Portal failed:', e.response?.data?.error?.message || e.message); sendErr(res, e); }
});
// Give an account Pro without paying (you, testers, friends). body: { email, comp: true|false }
app.post('/api/admin/comp', requireAdmin, async (req, res) => {
  const user = await auth.store.byEmail(String(req.body?.email || '').trim().toLowerCase());
  if (!user) return res.status(404).json({ error: 'No account with that email' });
  user.comp = req.body?.comp !== false;
  await auth.store.put(user);
  res.json({ ok: true, user: publicUser(user) });
});

// ── +EV SCREENER ──────────────────────────────────────────────────────────────
// ?sport=nba&minEv=2&book=draftkings&market=points&props=1&dfs=1&source=sharp&limit=200
app.get('/api/ev', (req, res) => {
  const { rows: all, feeds, at } = runEvScreen();
  const rows = all.filter(evRowOk(licenceOf(req)));
  const pro = hasPro(req);
  // free users can't filter by anything a locked row hides (book, EV, market, side)
  const q = pro ? req.query : { sport: req.query.sport, props: req.query.props, dfs: req.query.dfs, limit: req.query.limit };
  const minEv = pro ? parseFloat(q.minEv) : 1;
  const books = q.book ? String(q.book).toLowerCase().split(',') : null;
  let out = rows.filter(r =>
    (!q.sport || r.sport === q.sport) &&
    (!Number.isFinite(minEv) || r.ev >= minEv) &&
    (!books || books.includes(r.book)) &&
    (!q.market || r.market === q.market) &&
    (q.props == null || (q.props === '1') === !!r.player) &&
    (q.dfs == null || (q.dfs === '1') === !!r.dfs) &&
    (!q.source || r.source === q.source));
  const total = out.length;
  out = out.slice(0, Math.min(parseInt(q.limit) || 200, 1000));
  res.json({ rows: pro ? out : redactEv(out), count: total, pro, updated: new Date(at).toISOString(), feeds });
});
// New edges as they appear: event "ev" carries an array of rows.
// ?sport=nba&kind=steam,sharp_lead&limit=100. Open sharp leads (soft books
// still stale) are the actionable part, so they're Pro.
app.get('/api/sharp', (req, res) => {
  const kind = req.query.kind ? String(req.query.kind).split(',') : undefined;
  const pro = hasPro(req);
  const events = sharpTracker.events({ sport: req.query.sport, kind, limit: Math.min(parseInt(req.query.limit) || 100, 500) })
    .filter(e => pro || e.kind !== 'sharp_lead')
    .map(e => ({ ...e, text: describeSharp(e) }));
  const stale = pro ? sharpTracker.stale().filter(l => !req.query.sport || l.sport === req.query.sport).map(e => ({ ...e, text: describeSharp(e) })) : [];
  let rlm = [];
  try { rlm = reverseLineMoves(sharpTracker.events({ limit: 500 }), splitsMap()).map(e => ({ ...e, text: describeSharp(e) })); } catch { /* splits shape unknown */ }
  res.json({ events, stale, rlm, pro, lockedLeads: pro ? 0 : sharpTracker.stale().length, state: sharpTracker.state() });
});
// Kalshi and Polymarket prices: each only with its data licence, and
// Polymarket's never in US mode (a US person can't trade there)
app.get('/api/exchanges', (req, res) => {
  const lic = licenceOf(req);
  const ok = r => (r.exchange === 'kalshi' ? lic.kalshi : r.exchange === 'polymarket' ? lic.polymarket && TAIL_REGION !== 'us' : true);
  const withheld = ['kalshi', 'polymarket'].filter(x => !lic[x]);
  res.json({ markets: exchanges.toMarketsList(exchangeState.rows.filter(ok)), updated: exchangeState.updated, errors: exchangeState.errors,
    region: TAIL_REGION, ...(withheld.length ? { withheld, note: LICENCE_NOTE } : {}) });
});
// The screener's own record: free to see, since it's the sales pitch.
app.get('/api/ev/record', async (req, res) => {
  const q = req.query;
  const out = await evTracker.summary({ sport: q.sport, book: q.book, source: q.source, sinceDays: parseFloat(q.days) || undefined });
  // an exchange's own line in the by-book table needs its licence
  const ok = evRowOk(licenceOf(req));
  if (out?.byBook) out.byBook = Object.fromEntries(Object.entries(out.byBook).filter(([book]) => ok({ book })));
  res.json(out);
});
app.get('/api/ev/record/bets', async (req, res) => {
  // open bets are today's live edges, so only closed ones are free
  const status = hasPro(req) ? req.query.status : 'closed';
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  const bets = (await evTracker.list({ status, limit: limit * 2 })).filter(evRowOk(licenceOf(req))).slice(0, limit);
  res.json({ bets });
});
app.get('/api/ev/alerts', requirePro, (req, res) => res.json({ alerts: evRecent.filter(evRowOk(licenceOf(req))).slice(0, parseInt(req.query.limit) || 50), minEv: EV_ALERT_MIN }));
app.get('/api/ev/stream', requirePro, (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders?.();
  // what this viewer may see (data licences), fixed for the connection
  const lic = licenceOf(req), evOk = evRowOk(lic);
  res.write(`event: hello\ndata: ${JSON.stringify({ at: evCache.at, rows: evCache.rows.length })}\n\n`);
  const send = rows => { const mine = rows.filter(evOk); if (mine.length) res.write(`event: ev\ndata: ${JSON.stringify(mine)}\n\n`); };
  const sendSharp = evs => res.write(`event: sharp\ndata: ${JSON.stringify(evs.map(e => ({ ...e, text: describeSharp(e) })))}\n\n`);
  sharpListeners.add(sendSharp);
  // sharp tail: `tail` (signals), `whale` (big prints) and `xarb` (new arbs),
  // each an array, cut to this viewer's licences (and no polymarket.com links in US mode)
  const sendLive = (type, data) => {
    const mine = liveFor(type, data, lic);
    if (mine.length) res.write(`event: ${type}\ndata: ${JSON.stringify(mine)}\n\n`);
  };
  liveListeners.add(sendLive);
  // a heartbeat with the board time lets the page refresh even when nothing new crossed the line
  const ping = setInterval(() => res.write(`event: tick\ndata: ${JSON.stringify({ at: evCache.at })}\n\n`), 25000);
  evListeners.add(send);
  req.on('close', () => { clearInterval(ping); evListeners.delete(send); sharpListeners.delete(sendSharp); liveListeners.delete(sendLive); });
});

// ── SHARP TAIL ────────────────────────────────────────────────────────────────
// Every route here also answers to the data licences (licenceOf): with the
// paywall on, a source whose *_DISPLAY_OK flag is off is withheld from
// everyone but the admin, with `withheld: [source]` and a short `note`. In US
// mode no response links to polymarket.com (regionSafe).
const withheldBody = list => (list.length ? { withheld: list, note: LICENCE_NOTE } : {});

// Scored wallets, best first. ?category=politics&grade=A|B|graded&limit=100.
// Free: the leaderboard with wallets masked.
app.get('/api/tail/traders', (req, res) => {
  const pro = hasPro(req), lic = licenceOf(req);
  const category = tail.CATEGORIES.includes(req.query.category) ? req.query.category : null;
  const g = String(req.query.grade || '').toUpperCase();
  const grade = ['A', 'B', 'GRADED'].includes(g) ? g : null;
  const list = lic.polymarket ? tailEngine.traders({ category, grade, limit: Math.min(parseInt(req.query.limit) || 100, 500) }) : [];
  const st = tailEngine.state();
  res.json(regionSafe({
    traders: pro ? list.map(({ holdings, ...t }) => t) : list.map(maskTrader), pro, category, grade,
    state: { candidates: st.candidates, scored: st.scored, pending: st.pending, graded: st.graded, lastScoreAt: st.lastScoreAt },
    ...withheldBody(withheldOf(lic, ['polymarket'])),
  }));
});
// The Sharp Board: markets where graded wallets hold a position now, the side
// with the most sharp weight first, with where a US bettor can take that side.
// Pro: wallets and venue prices. Free: the top rows, wallets masked, the rest
// counted as locked. ?category=politics&limit=50
const BOARD_FREE_ROWS = 3;
function boardVenues(row, lic, now = Date.now()) {
  let quotes = [];
  try {
    quotes = xarb.venueQuotes({ type: 'entry', conditionId: row.conditionId, asset: row.lead.asset, outcome: row.lead.outcome, outcomeIndex: row.lead.outcomeIndex, market: row.title },
      xarbState.venues, { ...XARB_OPTS, now });
  } catch (e) { console.warn('Board venues:', e.message); }
  return quotes.filter(v => lic.kalshi || v.key !== 'kalshi').sort((a, b) => a.cost - b.cost)
    .map(v => ({ key: v.key, name: v.name, price: v.price, fee: v.fee, cost: v.cost, american: v.american ?? null, pick: v.pick || null, buy: v.buy || null, url: v.url || null, warning: v.warning || null }));
}
app.get('/api/tail/board', (req, res) => {
  const pro = hasPro(req), lic = licenceOf(req);
  const category = tail.CATEGORIES.includes(req.query.category) ? req.query.category : null;
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const rows = lic.polymarket ? tailEngine.sharpBoard({ category, limit, livePrice: boardLivePrice }) : [];
  const now = Date.now();
  const full = rows.map(r => ({ ...r, venues: boardVenues(r, lic, now) }));
  const mask = r => ({ ...r, conditionId: null, lead: { ...r.lead, asset: null, list: r.lead.list.map(w => ({ grade: w.grade, wallet: maskWallet(w.wallet), name: null, cost: null })) }, locked: true });
  const st = tailEngine.state();
  res.json(regionSafe({
    rows: pro ? full : full.slice(0, BOARD_FREE_ROWS).map(mask), locked: pro ? 0 : Math.max(0, full.length - BOARD_FREE_ROWS), pro, category,
    graded: st.graded, scored: st.scored, pending: st.pending, updated: new Date(now).toISOString(),
    ...withheldBody(withheldOf(lic, ['polymarket'])),
  }));
});

// One wallet's full score, its recent signals and their record (Pro: a
// wallet's grade is what's being sold).
app.get('/api/tail/trader/:wallet', requirePro, async (req, res) => {
  const lic = licenceOf(req);
  if (!lic.polymarket) return res.status(403).json({ error: `Polymarket wallets: ${LICENCE_NOTE}`, ...withheldBody(['polymarket']) });
  const tr = tailEngine.trader(req.params.wallet);
  if (!tr) return res.status(404).json({ error: 'That wallet has not been scored yet' });
  const signals = tailEngine.signals({ limit: 500 }).filter(s => s.wallet === tr.wallet).slice(0, 50).map(s => venueFor(s, lic));
  let record = [];
  try { record = (await tailTracker.list({ limit: 5000 })).filter(r => r.wallet === tr.wallet).slice(0, 50); } catch { /* store down */ }
  res.json(regionSafe({ trader: tr, signals, record }));
});
// Newest first. ?type=entry|exit&since=<iso>&limit=100. Pro: live. Free: only
// signals at least 30 minutes old, wallets masked; `locked` counts the rest.
// Each entry carries `venue` (where to tail it: the most units, or null) and
// every `venues` quote.
app.get('/api/tail/signals', (req, res) => {
  const pro = hasPro(req), lic = licenceOf(req);
  const type = ['entry', 'exit'].includes(req.query.type) ? req.query.type : null;
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  let list = lic.polymarket ? tailEngine.signals({ limit: 500, type, since: req.query.since || null }).map(s => venueFor(s, lic)) : [];
  let locked = 0;
  if (!pro) {
    const cut = Date.now() - TAIL_FREE_DELAY_MS;
    const old = list.filter(s => Date.parse(s.seenAt || s.at) <= cut);
    locked = list.length - old.length;
    list = old.map(maskSignal);
  }
  res.json(regionSafe({ signals: list.slice(0, limit), pro, delayMinutes: pro ? 0 : TAIL_FREE_DELAY_MS / 60e3, locked, updated: tailEngine.state().lastPollAt,
    region: TAIL_REGION, ...withheldBody(withheldOf(lic, ['polymarket'])) }));
});
// The signals' own track record: free, since it's the pitch. Open ones are
// live tails, so free users only see the settled list. The rows are
// Polymarket wallets' bets, so they need that licence; the totals don't.
// ?days=30&grade=A&category=politics&status=open|settled&limit=50
app.get('/api/tail/record', async (req, res) => {
  try {
    const pro = hasPro(req), lic = licenceOf(req);
    const q = req.query;
    // ?book=fresh: the fresh-wallet radar's record instead
    const book = q.book === 'fresh' ? 'fresh' : 'tail';
    const tracker = book === 'fresh' ? freshTracker : tailTracker;
    const grade = ['A', 'B'].includes(String(q.grade || '').toUpperCase()) ? String(q.grade).toUpperCase() : undefined;
    const category = tail.CATEGORIES.includes(q.category) ? q.category : undefined;
    const sinceDays = parseFloat(q.days) || undefined;
    const summary = { ...(await tracker.summary({ sinceDays, grade, category })), book };
    const status = pro ? (['open', 'settled'].includes(q.status) ? q.status : undefined) : 'settled';
    const cut = sinceDays ? Date.now() - sinceDays * 86400e3 : 0;
    const list = !lic.polymarket ? [] : (await tracker.list({ status, limit: 5000 }))
      .filter(r => (!grade || r.grade === grade) && (!category || r.category === category) && Date.parse(r.recordedAt) >= cut)
      .slice(0, Math.min(parseInt(q.limit) || 50, 500));
    res.json(regionSafe({ ...summary, signals: pro ? list : list.map(maskSignal), pro, ...withheldBody(withheldOf(lic, ['polymarket'])) }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Whale prints (newest first) and per-market flow over the last hour.
// ?exchange=kalshi|polymarket&graded=1|0&fresh=1|0&minUsd=10000&since=<iso>&limit=100.
// Free: wallets masked, and graded and fresh-wallet tags only once they're 30
// minutes old. Each exchange's prints need its licence, and so do Kalshi venues.
// freshRecord: the fresh-wallet radar's totals (its bets: /api/tail/record?book=fresh).
const kalshiVenuesOk = lic => e => (lic.kalshi || !Array.isArray(e?.venues) ? e
  : { ...e, venues: e.venues.filter(v => v.key !== 'kalshi'), venue: e.venues.find(v => v.key !== 'kalshi') || null });
app.get('/api/whales', async (req, res) => {
  const pro = hasPro(req), lic = licenceOf(req);
  const q = req.query;
  const exchange = ['kalshi', 'polymarket'].includes(q.exchange) ? q.exchange : null;
  const graded = pro && q.graded != null && q.graded !== '' ? /^(1|true|yes)$/i.test(q.graded) : null;
  const freshOnly = pro && q.fresh != null && q.fresh !== '' ? /^(1|true|yes)$/i.test(q.fresh) : null;
  const minUsd = parseFloat(q.minUsd);
  const t = Date.now();
  const limit = Math.min(parseInt(q.limit) || 100, 500);
  const shown = whaleOk(lic);
  // the feed is cut to this viewer's exchanges before the limit, so a withheld one doesn't eat it
  const only = exchange || (lic.kalshi === lic.polymarket ? null : lic.kalshi ? 'kalshi' : 'polymarket');
  const events = lic.kalshi || lic.polymarket ? whaleWatcher.events({ limit, exchange: only, graded, fresh: freshOnly, minUsd: Number.isFinite(minUsd) ? minUsd : null, since: q.since || null })
    .filter(shown).map(kalshiVenuesOk(lic)) : [];
  const flow = whaleWatcher.flow({ exchange, limit: Math.min(parseInt(q.flowLimit) || 50, 200) }).filter(f => shown(f));
  let freshRecord = null;
  try { const r = await freshTracker.summary({}); freshRecord = { overall: r.overall, open: r.open }; } catch { /* store down */ }
  res.json(regionSafe({
    freshRecord,
    events: pro ? events : events.map(e => maskWhale(e, t)),
    flow: pro ? flow : flow.map(f => ({ ...f, largest: maskWhale(f.largest, t) })),
    pro, minUsd: whaleWatcher.settings().minUsd, windowMs: whaleWatcher.settings().windowMs, state: pro ? whaleWatcher.state() : publicWhaleState(whaleWatcher.state()),
    ...withheldBody(withheldOf(lic, ['kalshi', 'polymarket'])),
  }));
});
// Exchange arbs, best first. ?type=cross|multi|book&category=sports&minPct=1.
// Stakes are the same for everyone: each leg's `pct` of the total (and the
// $100 reference split in `stakes`). US mode only has Kalshi and US
// sportsbook legs. Free: count and profit % only.
app.get('/api/xarbs', (req, res) => {
  const pro = hasPro(req), lic = licenceOf(req);
  const q = req.query;
  const minPct = parseFloat(q.minPct);
  const arbs = xarbState.arbs.filter(arbOk(lic))
    .filter(a => (!q.type || a.type === q.type) && (!q.category || a.category === q.category) && (!Number.isFinite(minPct) || a.profitPct >= minPct));
  const base = { count: arbs.length, updated: xarbState.updated, pro, region: TAIL_REGION, ...withheldBody(withheldOf(lic, TAIL_REGION === 'us' ? ['kalshi'] : ['kalshi', 'polymarket'])) };
  if (!pro) return res.json({ ...base, arbs: arbs.map(a => ({ profitPct: a.profitPct, locked: true })) });
  res.json(regionSafe({
    ...base, arbs: arbs.slice(0, Math.min(parseInt(q.limit) || 200, 1000)),
    minPct: XARB_OPTS.minPct ?? xarb.DEFAULTS.minPct, counts: xarbState.counts, errors: xarbState.errors.slice(0, 5),
  }));
});
// The thresholds in force (defaults overridden by env), so the app can show
// them, plus the region and the data-licence gates.
app.get('/api/tail/settings', (req, res) => {
  const w = whaleWatcher.settings();
  res.json({
    tail: tailEngine.settings(),
    whales: { minUsd: w.minUsd, windowMs: w.windowMs },
    xarb: { minPct: XARB_OPTS.minPct ?? xarb.DEFAULTS.minPct, alertMinPct: XARB_ALERT_MIN,
      kalshiFeeRate: XARB_OPTS.kalshiFeeRate ?? xarb.DEFAULTS.kalshiFeeRate, polymarketFeeRate: XARB_OPTS.polymarketFeeRate ?? xarb.DEFAULTS.polymarketFeeRate,
      polymarketFees: 'per market: shares × rate × p(1 − p), sports 5%' },
    freeDelayMinutes: TAIL_FREE_DELAY_MS / 60e3,
    region: TAIL_REGION, licence: licenceState(req),
  });
});

// ── ESPORTS ENDPOINTS ─────────────────────────────────────────────────────────
app.get('/api/esports/picks', async (req, res) => {
  const fresh = esportsCache.lastUpdated &&
    (Date.now() - new Date(esportsCache.lastUpdated).getTime()) < 300000;
  if (!fresh) await generateEsportsPicks();
  const pro = hasPro(req);
  // an EV filter would let a free user find each locked pick's EV by bisection
  const minEV = pro ? (parseFloat(req.query.minEV) || -100) : -100;
  const sport = req.query.sport;
  let picks = esportsCache.picks || [];
  if (sport) picks = picks.filter(p => (p.sport || '').toUpperCase().includes(sport.toUpperCase()));
  picks = picks.filter(p => p.ev == null || p.ev >= minEV);
  if (!pro) picks = redactForFree(picks);
  res.json({ picks, count: picks.length, updated: esportsCache.lastUpdated, pro, locked: pro ? 0 : picks.filter(p => p.locked).length });
});

let lastManualRefresh = 0;
app.post('/api/esports/refresh', async (req, res) => {
  // anyone can ask, but only the admin can force more than one rebuild a minute
  const admin = process.env.TRACKER_ADMIN_TOKEN && req.get('x-admin-token') === process.env.TRACKER_ADMIN_TOKEN;
  if (!admin && Date.now() - lastManualRefresh < 60000) return res.json({ ok: true, count: esportsCache.picks.length, cached: true });
  lastManualRefresh = Date.now();
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

// Manual model numbers change everyone's board and the public track record.
app.post('/api/esports/manual', requireAdmin, (req, res) => {
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

// The app's Odds API calls come through here so the key stays on the server,
// and every viewer shares one cached response instead of each spending credits.
// ?markets=h2h,spreads&regions=us&includeLinks=true
const ODDS_FEED_TTL_MS = parseInt(process.env.ODDS_FEED_TTL_MS) || 120000;
const FEED_MARKETS = new Set(['h2h', 'spreads', 'totals', 'outrights']);
const oddsFeedCache = new Map();
const oddsFeedInflight = new Map();
app.get('/api/odds-feed/:sport', async (req, res) => {
  const sport = String(req.params.sport);
  if (!/^[a-z0-9_]+$/.test(sport)) return res.status(400).json({ error: 'Bad sport key' });
  if (!ODDS_API_KEY) return res.status(503).json({ error: 'ODDS_API_KEY is not set on the server' });
  // Every request maps to one of two upstream fetches per sport (the main view,
  // or the arb scan's wider one), so query variations can't fan out into new
  // billed calls. Markets the caller didn't ask for are trimmed from the reply.
  const wanted = new Set(String(req.query.markets || 'h2h,spreads').split(',').filter(x => FEED_MARKETS.has(x)));
  // Low-usage mode fetches only the main US books: the wide pull costs 3× the credits.
  const wide = !oddsBudget.active() && (/us2|us_ex/.test(String(req.query.regions || '')) || wanted.has('totals'));
  const markets = 'h2h,spreads,totals';
  const regions = wide ? 'us,us2,us_ex' : 'us';
  const includeLinks = wide;
  const key = `${sport}|${regions}`;
  const trim = data => (Array.isArray(data) ? data.map(g => ({ ...g, bookmakers: (g.bookmakers || []).map(b => ({ ...b, markets: (b.markets || []).filter(m => wanted.has(m.key)) })) })) : data);
  res.set('Access-Control-Expose-Headers', 'x-requests-remaining, x-cache');
  const hit = oddsFeedCache.get(key);
  if (hit && Date.now() - hit.at < ODDS_FEED_TTL_MS) {
    if (cache.quotaRemaining != null) res.set('x-requests-remaining', String(cache.quotaRemaining));
    res.set('x-cache', 'hit');
    return res.json(trim(hit.data));
  }
  try {
    // concurrent viewers wait on the same request
    if (!oddsFeedInflight.has(key)) {
      const budget = oddsBudget.take(oddsCost(markets, regions));
      if (!budget.ok) {
        const mins = Math.ceil(budget.waitMs / 60000);
        res.set('x-cache', 'budget');
        if (hit) return res.json(trim(hit.data));
        return res.status(503).json({ error: `Saving Odds API credits: next refresh in about ${mins} min`, lowUsage: true, retryInMs: budget.waitMs });
      }
      oddsFeedInflight.set(key, axios.get(`https://api.the-odds-api.com/v4/sports/${sport}/odds/`, {
        params: { apiKey: ODDS_API_KEY, regions, markets, oddsFormat: 'american', ...(includeLinks ? { includeLinks: true } : {}) }, timeout: 12000,
      }).finally(() => oddsFeedInflight.delete(key)));
    }
    const r = await oddsFeedInflight.get(key);
    noteQuota(r);
    oddsFeedCache.set(key, { at: Date.now(), data: r.data });
    // the screener and sharp tracker read game lines from here too
    if (!wide) cache.odds[sport] = { data: r.data, updated: new Date().toISOString() };
    ingestSharp(sport, r.data);
    if (cache.quotaRemaining != null) res.set('x-requests-remaining', String(cache.quotaRemaining));
    res.set('x-cache', 'miss');
    res.json(trim(r.data));
  } catch (e) {
    const status = e.response?.status || 502;
    if (hit) { res.set('x-cache', 'stale'); return res.json(trim(hit.data)); }   // better old odds than none
    res.status(status).json({ error: status === 429 ? 'Odds API quota used up' : status === 401 ? 'Odds API key rejected' : `Odds API error ${status}` });
  }
});

// Regex path: works on both Express 4 and Express 5 (string '*' wildcards break on v5)
app.get(/^\/api\/owls\/(.*)$/, async (req, res) => {
  if (owlsDisabled()) return res.status(503).json({ error: 'Owls disabled — API key is dead (repeated 403s). Set OWLS_API_KEY and restart.' });
  const path = req.params[0], query = new URLSearchParams(req.query).toString();
  // only the read endpoints the app uses, so the server key can't be pointed elsewhere
  if (!/^(nba|mlb|nhl|nfl|mma|ncaab|ncaaf|wnba|soccer)\/(odds|props|splits|scores)$/.test(path)) return res.status(404).json({ error: 'Not a proxied Owls path' });
  // odds and props are already polled on a timer: serve those from cache
  const m = !query && /^(\w+)\/(odds|props)$/.exec(path);
  const hit = m && (m[2] === 'odds' ? cache.owlsOdds : cache.owlsProps)[m[1]];
  if (hit?.data && Date.now() - new Date(hit.updated).getTime() < (m[2] === 'odds' ? 30000 : 300000)) return res.json(hit.data);
  try {
    const r = await axios.get(`https://api.owlsinsight.com/api/v1/${path}${query?'?'+query:''}`, { headers: OWLS_HEADERS, timeout: 10000 });
    res.json(r.data);
  // not noteOwlsError: a visitor's bad request must not trip the dead-key breaker
  } catch(e) { res.status(e.response?.status||502).json({ error: `Owls error ${e.response?.status || ''}`.trim() }); }
});


// ── ALERTS ────────────────────────────────────────────────────────────────────
app.get('/api/esports/alerts', requirePro, (req, res) => {
  res.json({ alerts: alerter.recent(Math.min(parseInt(req.query.limit) || 50, 200)) });
});

// Server-sent events: one `alert` event per edge / move / gone.
app.get('/api/esports/stream', requirePro, (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders?.();
  res.write(`retry: 10000\n\n`);
  const off = alerter.subscribe(e => res.write(`event: alert\ndata: ${JSON.stringify(e)}\n\n`));
  // proxies drop idle connections; a comment line every 25s keeps it open
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => { off(); clearInterval(ping); });
});

// ── SLIP PRICING ──────────────────────────────────────────────────────────────
// Legs from the same series share whether the last map is played, so pricing
// them as independent overstates the entry. These endpoints price the real
// thing. body: { legs: [{ player, market }] } referencing the current board,
// or full leg objects.
function legsFromBoard(input) {
  const board = esportsCache.picks || [];
  return (input || []).map(spec => {
    if (spec.pricing || spec.prob != null) return spec;
    const hit = board.find(p =>
      normalizeName(p.player) === normalizeName(spec.player) &&
      (!spec.market || normalizeMarket(p.market) === normalizeMarket(spec.market)));
    if (!hit || hit.prob == null) return null;
    return {
      player: hit.player, team: hit.team, gameId: hit.gameId, stat: hit.pricing?.stat,
      side: hit.side, line: hit.pricing?.line, prob: hit.prob / 100,
      meanPerMap: hit.pricing?.meanPerMap, k: hit.pricing?.k, scenarios: hit.pricing?.scenarios,
      ev: hit.bestEv,
    };
  });
}

app.post('/api/esports/slip', requirePro, (req, res) => {
  const legs = legsFromBoard(req.body?.legs);
  const missing = (req.body?.legs || []).filter((_, i) => !legs[i]);
  if (missing.length) return res.status(400).json({ error: 'Not on the board or not priced yet', missing: missing.map(m => m.player) });
  if (legs.length < 2) return res.status(400).json({ error: 'A slip needs at least 2 legs' });
  res.json({ legs: legs.length, prices: priceAll(legs), payoutTables: Object.keys(PAYOUTS) });
});

app.get('/api/esports/best-slips', requirePro, (req, res) => {
  const minEV = parseFloat(req.query.minEV);
  const maxLegs = Math.min(parseInt(req.query.maxLegs) || 5, 6);
  const sport = req.query.sport;
  let pool = (esportsCache.picks || []).filter(p => p.pricing && p.bestEv != null);
  if (sport) pool = pool.filter(p => (p.sport || '').toUpperCase().includes(sport.toUpperCase()));
  pool = pool.filter(p => p.bestEv >= (isFinite(minEV) ? minEV : 0))
    .slice(0, 40)
    .map(p => ({
      player: p.player, team: p.team, gameId: p.gameId, sport: p.sport, market: p.displayMarket,
      side: p.side, line: p.pricing.line, prob: p.prob / 100, ev: p.bestEv,
      meanPerMap: p.pricing.meanPerMap, k: p.pricing.k, stat: p.pricing.stat, scenarios: p.pricing.scenarios,
    }));
  if (pool.length < 2) return res.json({ slips: [], pool: pool.length });
  const slips = bestSlips(pool, { maxLegs }).map(s => ({
    ...s,
    picks: s.picks.map(p => ({ player: p.player, sport: p.sport, market: p.market, side: p.side, line: p.line, prob: +(p.prob * 100).toFixed(1), ev: p.ev })),
  }));
  res.json({ slips, pool: pool.length });
});

// ── MATCH CONTEXT ─────────────────────────────────────────────────────────────
// Enter a match price (e.g. from Pinnacle) so CS2/Valorant picks get context.
// body: { sport, teamA, teamB, priceA, priceB, bestOf? }  American or decimal prices
//    or { sport, teamA, teamB, pA, bestOf? }               series win prob for teamA
// add perMap: true when the price is for a single map rather than the series.
app.post('/api/esports/match-odds', requireAdmin, async (req, res) => {
  try {
    const row = oddsBook.set(req.body || {});
    generateEsportsPicks().catch(() => {});
    res.json({ ok: true, match: row });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.get('/api/esports/match-odds', (req, res) => res.json({ matches: oddsBook.list() }));
app.get('/api/feeds', (req, res) => res.json({
  pandascore: { enabled: feedState.pandascore.enabled, updated: feedState.pandascore.updated, errors: feedState.pandascore.errors,
    upcoming: Object.fromEntries(Object.entries(feedState.pandascore.schedules).map(([k, v]) => [k, v.length])) },
  pinnacle: feedState.pinnacle,
}));
app.get('/api/esports/context', (req, res) => res.json({
  ratings: ratingsState.meta,
  picksWithContext: esportsCache.contextCounts || {},
  manualMatches: oddsBook.list().length,
}));

// ── TRACK RECORD ──────────────────────────────────────────────────────────────
app.get('/api/tracker/summary', async (req, res) => {
  try {
    const minEv = req.query.minEV != null ? parseFloat(req.query.minEV) : undefined;
    res.json(await tracker.summary({ sport: req.query.sport, since: req.query.since, minEv }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/tracker/picks', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 200, 1000);
    let picks = await tracker.list({ status: req.query.status, sport: req.query.sport, limit });
    // picks that haven't been graded are today's board: Pro only
    if (!hasPro(req)) picks = picks.map(p => (p.status === 'open' || p.status === 'locked')
      ? { ...p, signalSide: null, signalLine: null, signalEv: null, signalProb: null, closeSide: null, closeLine: null, closeEv: null, closeProb: null, modelPred: null, rawPred: null, locked: true }
      : p);
    res.json({ picks });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// body: { id, result }  or  { id, void: true, note }
app.post('/api/tracker/grade', requireAdmin, async (req, res) => {
  try {
    const row = await tracker.manualGrade(req.body.id, req.body);
    if (!row) return res.status(404).json({ error: 'No tracked pick with that id' });
    res.json({ ok: true, pick: row });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/tracker/run', requireAdmin, async (req, res) => {
  const locked = await tracker.lockStarted();
  res.json({ locked, ...(await tracker.gradeDue({ limit: 100 })) });
});

app.get('/api/status', (req, res) => { const pro = hasPro(req); res.json({
  version: '3.40.0',
  modelWeight: MODEL_WEIGHT,
  prizepicks: { count: cache.prizepicks.data?.length||0, updated: cache.prizepicks.updated, blocked: Date.now() < ppFail.until, lastError: dfsError.prizepicks },
  underdog: { count: cache.underdog.data?.length||0, updated: cache.underdog.updated, sports: cache.udSportLabels, lastError: dfsError.underdog },
  esports: {
    picks: esportsCache.picks.length,
    updated: esportsCache.lastUpdated,
    ppEsportsLines: (cache.prizepicks.data||[]).filter(l => isEsports(l.sport)).length,
    udEsportsLines: (cache.underdog.data||[]).filter(l => isEsports(l.sport)).length,
  },
  lolData: { players: Object.keys(lolStats.players).length, teams: Object.keys(lolStats.teams).length, games: lolStats.games, updated: lolStats.updated, state: lolStats.state, error: lolStats.lastError, source: lolStats.source },
  implausibleLines: esportsCache.implausible || [],
  spanInferredCount: esportsCache.spanInferred || 0,
  priceMismatchCount: esportsCache.priceMismatches || 0,
  warmer: { filled: warmer.done, misses: warmer.misses, queued: warmer.queueSize, lastRun: warmer.lastRun },
  valData: { players: Object.keys(vlrTable.players).length, regions: vlrTable.regions, updated: vlrTable.updated, error: vlrTable.lastError },
  dotaData: { indexed: dotaCache.proPlayers ? Object.keys(dotaCache.proPlayers).length : 0, profiles: Object.values(dotaCache.players).filter(p => !p.failed).length, error: dotaCache.lastError },
  bo3: { profiles: bo3Health.profiles, predsAccepted: bo3Health.predsAccepted, predsRejected: bo3Health.predsRejected, lastRejected: bo3Health.lastRejected, lastError: bo3Health.lastError },
  tracker: trackerHealth,
  sharp: sharpTracker.state(),
  exchanges: { markets: exchangeState.rows.length, updated: exchangeState.updated, errors: exchangeState.errors.slice(0, 5) },
  ev: { rows: evCache.rows.length, computedAt: evCache.at ? new Date(evCache.at).toISOString() : null, feeds: evCache.feeds },
  // free: counts and timestamps only (see publicTailState)
  tail: pro ? { ...tailEngine.state(), record: tailTracker.state(), jobs: tailJobs, routing: tailRouting, stream: tailStream.stats(), polymarketUs: polymarketUs?.state() ?? null } : { ...publicTailState(tailEngine.state()), record: tailTracker.state(), jobs: publicJobs(tailJobs), routing: tailRouting, stream: tailStream.stats() },
  whales: pro ? whaleWatcher.state() : publicWhaleState(whaleWatcher.state()),
  xarb: { arbs: xarbState.arbs.length, updated: xarbState.updated, durationMs: xarbState.durationMs, running: xarbState.running, counts: xarbState.counts, errors: xarbState.errors.slice(0, 5),
    venueMarkets: xarbState.venues?.size ?? 0, gameSweep: kalshiGameSweep ? kalshiGameSweep.stats() : null },
  region: TAIL_REGION,
  licence: licenceState(req),
  upstream: upstream.stats(),
  live: { listeners: liveListeners.size, webhook: !!process.env.ALERT_WEBHOOK_URL && process.env.TAIL_WEBHOOK !== 'off' },
  accounts: { paywall: PAYWALL, billing: billing.configured(), authSecretSet: !!process.env.AUTH_SECRET, webhookSecretSet: !!process.env.STRIPE_WEBHOOK_SECRET },
  alerts: { recent: alerter.recent(200).length, liveListeners: alerter.listenerCount(), webhook: !!process.env.ALERT_WEBHOOK_URL },
  feeds: { pandascore: feedState.pandascore.enabled, pinnacle: feedState.pinnacle.enabled, pinnacleMatches: feedState.pinnacle.loaded },
  matchContext: { ratings: ratingsState.meta, picks: esportsCache.contextCounts || {}, manualMatches: oddsBook.list().length },
  sharpMoves: cache.sharpMoves.length,
  owls: owlsDisabled() ? 'DISABLED — dead key (repeated 403s)' : 'active',
  oddsApiQuotaRemaining: cache.quotaRemaining,
  oddsApiBudget: oddsBudget.state(),
  owlsProps: Object.entries(cache.owlsProps).map(([k,v])=>`${k}:${Array.isArray(v.data)?v.data.length:0}`).join(', ') || 'none',
  oddsApiProps: Object.entries(cache.oddsApiProps).map(([k,v])=>`${k}:${Array.isArray(v.data)?v.data.length:0}`).join(', ') || 'none',
}); });

// ─── CRON JOBS ────────────────────────────────────────────────────────────────
// Team ratings for match context, every 6 hours.
cron.schedule('40 */6 * * *', () => refreshRatings(axios, ratingsState, console, ratingsOpts).catch(() => {}));

// Tracker: freeze started picks, then look for results (one sweep at a time).
const trackerHealth = { lastRun: null, last: null, error: null };
let trackerRunning = false;
cron.schedule('*/5 * * * *', async () => {
  if (trackerRunning) return;
  trackerRunning = true;
  try {
    const locked = await tracker.lockStarted();
    trackerHealth.last = { locked, ...(await tracker.gradeDue()) };
    trackerHealth.lastRun = new Date().toISOString();
    trackerHealth.error = null;
  } catch (e) { trackerHealth.error = e.message; }
  finally { trackerRunning = false; }
});
// PP/UD scrapes (PP self-backs-off when blocked)
cron.schedule('*/2 * * * *', async () => { await Promise.all([scrapePrizePicks(), scrapeUnderdog()]); });

// Owls — fully skipped once the breaker trips
cron.schedule('15 * * * * *', () => refreshExchanges().catch(e => console.warn('Exchanges:', e.message)));
cron.schedule('*/30 * * * * *', async () => {
  if (!owlsDisabled()) await Promise.all(['nba','mlb','nhl','nfl','mma'].map(s => fetchOwlsOdds(s)));
  try { runEvScreen(true); } catch (e) { console.warn('EV screen failed:', e.message); }
});
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
// Esports match prices and schedules a minute before picks rebuild.
cron.schedule('4-59/5 * * * *', () => refreshMatchFeeds().catch(e => console.warn('Feeds:', e.message)));
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

// Sharp tail, whale flow and exchange arbs. The seconds offsets keep them off
// the jobs above (which start on :00, :15 and :30), and every request they
// make waits its turn in the polite per-host queue (UPSTREAM_GAP_MS).
// Big trades on both exchanges every 30s: one shared read of Polymarket's trades page.
cron.schedule('10,40 * * * * *', () => Promise.all([runTailJob('whales', pollWhales), runTailJob('signals', pollTail)]));
// A few wallets scored a minute (3+ requests each)
cron.schedule('25 * * * * *', () => runTailJob('score', () => tailEngine.scoreBatch()));
// Every open Kalshi and Polymarket event, once a minute (skipped while one is still running)
cron.schedule('50 * * * * *', () => runTailJob('xarb', scanXarbs));
cron.schedule('5 */2 * * * *', () => runTailJob('board', watchBoard));
// Grade tracked signals whose markets resolved, every 10 minutes
cron.schedule('20 7-59/10 * * * *', () => runTailJob('record', async () => { await tailTracker.check(); await freshTracker.check(); }));
// New leaderboard wallets to score, every 6 hours (and once at startup)
cron.schedule('35 25 */6 * * *', () => runTailJob('candidates', () => tailEngine.refreshCandidates()));

// ─── START ────────────────────────────────────────────────────────────────────
if (require.main === module) {
  app.listen(PORT, async () => {
    console.log(`Line Reaper v3.40.0 on port ${PORT}`);
    if (tailStreamOn) tailStream.start();
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
    // team ratings for match context, then rebuild picks with them
    setTimeout(() => refreshMatchFeeds()
      .then(() => refreshRatings(axios, ratingsState, console, ratingsOpts)).then(() => generateEsportsPicks()).catch(()=>{}), 25000);
    // sharp tail: leaderboard wallets to score (the crons take it from there)
    setTimeout(() => runTailJob('candidates', () => tailEngine.refreshCandidates()), 30000);
    console.log('Startup complete');
  });
}

module.exports = {
  app, cache, oddsBudget, esportsCache, feedState, refreshMatchFeeds, lolStats, tracker, ratingsState, oddsBook, alerter, auth, billing, exchangeState, runEvScreen, evScreen, evTracker, sharpTracker, ingestSharp,
  parseUnderdogPayload, normalizeName, normalizeMarket, isEsports,
  calcBookEV, calcEsportsEV, predictEsportsSide, generateEsportsPicks,
  getVarianceMultiplier, parseMapCount, parseMapSpan, lineIsPlausible, inSeasonSports, anchorToMarket, MODEL_WEIGHT,
  parseCsvLine, createOEAggregator, predictLoLKills, predictLoLStat, refreshLoLStats,
  aggregateLPRows, refreshLoLFromLeaguepedia,
  vlrIngestSegments, vlrTable, vlrKey, fetchVLRPlayerStats, dotaCache, warmCsProfiles, warmer,
  inferMapSpan, describePlayer, udPricing, relabelMarket,
  predictKillsFromStats, autoPredAcceptable, bo3Pick, bo3FirstObject, bo3ExtractProfile,
  tailEngine, tailTracker, polymarketUs, routeTail, freshTracker, freshSignal, publishFresh, describeFresh, whaleWatcher, xarbState, upstream, createPoliteHttp, liveListeners, tailJobs,
  pollTail, streamTail, tailStream, watchBoard, describeBoardAlert, pollWhales, scanXarbs, runTailJob, maskTrader, maskSignal, maskWhale, describeTail, describeArb,
  routeSignal, tailPings, venueFor, venueLine, licenceFor, licenceState, stripPolymarketLinks, TAIL_REGION, evListeners,
};
