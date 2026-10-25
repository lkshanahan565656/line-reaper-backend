require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;
// health, event-loop stalls, slow requests and the boot timeline (ops.js)
const ops = require('./ops').createOps();
ops.start();
app.use(ops.middleware);
// Answered before anything else is mounted, and from memory only: Railway's
// health check and the uptime probe get an answer while feeds are still warming.
app.get('/api/health', (req, res) => {
  const o = ops.state();
  res.set('Cache-Control', 'no-store').json({
    ok: true, version: require('./package.json').version, uptimeS: o.uptimeS,
    listening: o.boot.some(b => b.mark === 'listening'), boot: o.boot,
    stalls: { count: o.stalls.count, worstMs: o.stalls.worstMs, last: o.stalls.recent[0] || null },
    inFlight: o.requests.inFlight, memory: o.memory,
    backup: typeof resultsBackup !== 'undefined' ? resultsBackup.status().state : 'loading',
    stores: require('./jsonstore').storeStats(),
  });
});
app.get('/api/ops', (req, res) => res.set('Cache-Control', 'no-store').json({ ...ops.state(), stores: require('./jsonstore').storeStats() }));
const profiler = require('./ops').createProfiler();
app.get('/api/ops/profile', async (req, res) => {
  try { res.set('Cache-Control', 'no-store').json(await profiler.profile(parseFloat(req.query.s) || 20)); }
  catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

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
  sleeperSports: { data: [], updated: null },
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
const { createCreditBudget, oddsCost, pickPollSport } = require('./quota');
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
// PP answers 403/429 when pushed: back off from the first one (see the catch
// in scrapePrizePicks). Esports keeps running on Underdog and Sleeper.
let ppFail = { count: 0, until: 0, limited: 0 };
const PP_BACKOFF_MS = 4 * 60 * 1000, PP_BACKOFF_MAX_MS = 2 * 60 * 60 * 1000;
// the last failure of each DFS scrape, for /api/status (cleared on success)
const dfsError = { prizepicks: null, underdog: null, sleeper: null };
const noteDfsError = (book, e) => { dfsError[book] = { status: e?.response?.status ?? null, message: String(e?.message || e).slice(0, 200), at: new Date().toISOString() }; };

const { parsePrizePicksPayload, parseSleeperLines, sleeperSportKeys, sleeperSport, slimPlayers, sleeperPricing } = require('./pickem');
const esmatch = require('./esmatch');
const propsBoard = require('./propsboard');
const venues = require('./venues');
const LICENCE_PAUSED = { status: null, message: 'paused: waiting on data permission' };
// partner-api answers from Railway where api.prizepicks.com 403s (probed
// 2026-10-13). The whole board is about 19k lines and 23 MB, so it's pulled
// every 20 minutes; between those, one esports league (ids learned from the
// whole board) is re-pulled each 2-minute cycle, in turn.
const PRIZEPICKS_URL = process.env.PRIZEPICKS_URL || 'https://partner-api.prizepicks.com/projections';
const PP_FULL_MS = 20 * 60 * 1000;
// fullAt: last full try; fullOkAt and leagueOkAt[id]: last pulls that answered
const ppState = { fullAt: 0, esportsLeagues: [], next: 0, fullOkAt: 0, leagueOkAt: {} };
const PP_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Accept': 'application/json', 'Origin': 'https://app.prizepicks.com', 'Referer': 'https://app.prizepicks.com/',
};
async function scrapePrizePicks() {
  if (!licences.isOn('prizepicks')) { dfsError.prizepicks = { ...LICENCE_PAUSED, at: new Date().toISOString() }; return; }
  if (Date.now() < ppFail.until) return;
  try {
    const full = Date.now() - ppState.fullAt > PP_FULL_MS || !ppState.esportsLeagues.length;
    let allLines, league = null;
    if (full) {
      ppState.fullAt = Date.now();
      const res = await axios.get(PRIZEPICKS_URL, { params: { per_page: 10000, single_stat: true }, headers: PP_HEADERS, timeout: 30000, maxContentLength: 80e6 });
      const { lines, leagues } = parsePrizePicksPayload(res.data);
      allLines = lines;
      ppState.esportsLeagues = Object.entries(leagues).filter(([, name]) => isEsports(name)).map(([id]) => id);
      if (!ppState.esportsLeagues.length) ppState.esportsLeagues = [...new Set(lines.filter(l => isEsports(l.sport) && l.leagueId).map(l => l.leagueId))];
    } else {
      // one esports league a cycle, in turn: Cloudflare 429s a few requests
      // inside a minute (probed 10-14: the third of three 5 s apart), and a
      // cycle that pulled all four 3 s apart failed every time and kept none
      league = ppState.esportsLeagues[ppState.next++ % ppState.esportsLeagues.length];
      const res = await axios.get(PRIZEPICKS_URL, { params: { league_id: league, per_page: 1000, single_stat: true }, headers: PP_HEADERS, timeout: 15000 });
      const fresh = parsePrizePicksPayload(res.data).lines;
      allLines = [...(cache.prizepicks.data || []).filter(l => String(l.leagueId) !== String(league)), ...fresh];
    }
    const t = Date.now();
    if (full) { ppState.fullOkAt = t; for (const id of ppState.esportsLeagues) ppState.leagueOkAt[id] = t; }
    else ppState.leagueOkAt[league] = t;
    ppFail = { count: 0, until: 0, limited: 0 };
    dfsError.prizepicks = null;
    if (allLines.length > 0) {
      cache.prizepicks = { data: allLines, updated: new Date(t).toISOString() };
      cache.ppLeagueLabels = [...new Set(allLines.map(l => l.sport))].slice(0, 20);
      console.log(`PP${full ? '' : ' league ' + league}: ${allLines.length} lines (${allLines.filter(l => isEsports(l.sport)).length} esports) · leagues: ${cache.ppLeagueLabels.slice(0, 12).join(', ')}`);
    }
  } catch(e) {
    const s = e.response?.status;
    noteDfsError('prizepicks', e);
    ppFail.count++;
    if (s === 403 || s === 429) {
      // A 429 is a rate limit: every request inside it extends it. Back off
      // from the first one, longer each time, and never sooner than its
      // Retry-After. (10-14: retrying each cycle kept the block up for hours.)
      ppFail.limited = (ppFail.limited || 0) + 1;
      const wait = Math.max(ppRetryAfterMs(e.response?.headers), Math.min(PP_BACKOFF_MAX_MS, PP_BACKOFF_MS * 2 ** (ppFail.limited - 1)));
      ppFail.until = Date.now() + wait;
      console.warn(`PP blocked (${s}): next try in ${Math.round(wait / 60000)} min; esports keeps running on Underdog and Sleeper`);
    } else {
      console.error('PP error:', e.message, s);
    }
  }
}
// Retry-After: seconds, or an HTTP date
function ppRetryAfterMs(headers) {
  const v = headers?.['retry-after'] ?? headers?.get?.('retry-after');
  if (v == null || v === '') return 0;
  const n = Number(v);
  if (Number.isFinite(n)) return Math.max(0, n * 1000);
  const t = Date.parse(v);
  return Number.isFinite(t) ? Math.max(0, t - Date.now()) : 0;
}
// PrizePicks lines the board may still price: a book that stops answering
// leaves its last lines cached, and lines that old may no longer be on the
// app. Each esports league refreshes about every 8 min, the rest every 20,
// so about two missed pulls and they're out.
const PP_ES_STALE_MS = 18 * 60 * 1000, PP_SPORT_STALE_MS = 45 * 60 * 1000;
function ppLinesNow(now = Date.now()) {
  if (!ppState.fullOkAt) return cache.prizepicks.data || [];   // never pulled: nothing cached but a test's
  const sportOk = now - ppState.fullOkAt <= PP_SPORT_STALE_MS;
  return (cache.prizepicks.data || []).filter(l => (isEsports(l.sport)
    ? now - (ppState.leagueOkAt[l.leagueId] || ppState.fullOkAt) <= PP_ES_STALE_MS : sportOk));
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
    games[g.id] = { sport: g.sport_id || g.sport || '', startTime: g.scheduled_at || '', title: g.title || g.full_team_names_title || g.abbreviated_title || '',
      fullTitle: g.full_team_names_title || g.title || '', home: g.home_team_id || null, away: g.away_team_id || null };
  }
  if (Array.isArray(data.solo_games)) for (const g of data.solo_games) {
    soloGames[g.id] = { sport: g.sport_id || g.sport || '', startTime: g.scheduled_at || '', title: g.title || g.full_team_names_title || g.abbreviated_title || '' };
  }
  if (Array.isArray(data.appearances)) for (const a of data.appearances) {
    appearances[a.id] = { player_id: a.player_id, match_id: a.match_id || a.solo_game_id || null, team_id: a.team_id || null };
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

    // A pulled or suspended line can't be bet at all
    if (line.status && line.status !== 'active') continue;

    // per-side payout multipliers. UD lists one option per side it takes, so a
    // line with only a Higher option can't be played Lower (and vice versa); a
    // suspended option is closed too. No options listed at all: both assumed.
    let overMult = 1.00, underMult = 1.00, overOpen = true, underOpen = true;
    const opts = Array.isArray(line.options) ? line.options.filter(Boolean) : [];
    if (opts.length) {
      overOpen = underOpen = false;
      for (const opt of opts) {
        const open = !opt.status || opt.status === 'active';
        const m = parseFloat(opt.payout_multiplier || opt.multiplier || 1);
        if (opt.choice === 'higher' || opt.choice_display === 'Higher') { overMult = m; overOpen = open; }
        else if (opt.choice === 'lower' || opt.choice_display === 'Lower') { underMult = m; underOpen = open; }
      }
      if (!overOpen && !underOpen) continue;
    }

    // Esports players carry no team name. The appearance names the player's
    // team id, the game names its home and away ids, and its title reads
    // "Away vs Home", the US order (checked on vlr.gg 2026-10-12: leaf, valyn
    // and trent, home in "100 Thieves vs G2 Esports", all play for G2).
    let team = player.team || '';
    const teamId = appearance?.team_id || null;
    if (!team && teamId && (game.home || game.away)) {
      const sides = splitMatchTitle(game.fullTitle);
      if (sides) team = teamId === game.home ? sides[1] : teamId === game.away ? sides[0] : '';
    }

    lines.push({
      book: 'underdog',
      sport,
      player: player.name || '',
      team,
      market: appStat.display_stat || ou.title || '',
      line: parseFloat(line.stat_value || 0),
      startTime: game.startTime || '',
      matchTitle: game.title || '',
      gameId: matchId,
      overMultiplier: overOpen ? overMult : null,
      underMultiplier: underOpen ? underMult : null,
      overOpen, underOpen,
      multiplier: Math.max(overOpen ? overMult : 0, underOpen ? underMult : 0),
    });
  }
  return lines;
}

const UNDERDOG_URL = process.env.UNDERDOG_URL || 'https://api.underdogfantasy.com/v1/over_under_lines';
async function scrapeUnderdog() {
  if (!licences.isOn('underdog')) { dfsError.underdog = { ...LICENCE_PAUSED, at: new Date().toISOString() }; return; }
  try {
    // beta/v5 and v6 answer 426 (upgrade required) since 2026-10; v1 serves the same payload
    const res = await axios.get(UNDERDOG_URL, {
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

// Sleeper: player lines with a payout per side, esports and sports. Player
// names come from /players/{sport} (0.2 to 6 MB a sport, slimmed to name and
// team), refreshed every 6 hours. cache.sleeper keeps the esports lines the
// esports board reads; cache.sleeperSports the rest, for the props board.
const { createSleeperSchedule, attachGames: attachSleeperGames } = require('./sleepersched');
const sleeperSchedule = createSleeperSchedule(axios);
const SLEEPER_LINES_URL = 'https://api.sleeper.app/lines/available?dynamic=true&include_preseason=true&eg=15.control';
const sleeperPlayers = { bySport: {}, at: {} };
let sleeperRunning = false;
async function scrapeSleeper() {
  if (!licences.isOn('sleeper')) { dfsError.sleeper = { ...LICENCE_PAUSED, at: new Date().toISOString() }; return; }
  if (sleeperRunning) return;   // the first run fetches every player table; the next tick waits
  sleeperRunning = true;
  try {
    const res = await axios.get(SLEEPER_LINES_URL, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }, timeout: 20000, maxContentLength: 40e6 });
    const rows = Array.isArray(res.data) ? res.data : [];
    for (const sport of sleeperSportKeys(rows)) {
      if (Date.now() - (sleeperPlayers.at[sport] || 0) < 6 * 3600 * 1000) continue;
      try {
        const pr = await axios.get(`https://api.sleeper.app/players/${encodeURIComponent(sport)}`, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 30000, maxContentLength: 40e6 });
        if (pr.data && typeof pr.data === 'object') { sleeperPlayers.bySport[sport] = slimPlayers(pr.data); sleeperPlayers.at[sport] = Date.now(); }
      } catch (e) { console.warn(`Sleeper players ${sport}:`, e.response?.status, e.message); }
    }
    const lines = parseSleeperLines(rows, sleeperPlayers.bySport);
    const now = new Date().toISOString();
    cache.sleeper = { data: lines, updated: now, rows: rows.length };
    let sports = parseSleeperLines(rows, sleeperPlayers.bySport, { sports: true }).filter(l => !isEsports(l.sport));
    try {
      const { games, starts } = await sleeperSchedule.refresh(rows, k => { const sp = sleeperSport(k); return sp && !isEsports(sp) ? sp : null; });
      sports = attachSleeperGames(sports, games, starts);
    } catch (e) { console.warn('Sleeper schedule:', e.message); }
    cache.sleeperSports = { data: sports, updated: now };
    dfsError.sleeper = null;
    console.log(`Sleeper: ${lines.length} esports and ${sports.length} sports lines from ${rows.length} rows`);
  } catch (e) { noteDfsError('sleeper', e); console.error('Sleeper error:', e.message, e.response?.status); }
  finally { sleeperRunning = false; }
}

// DraftKings Pick6 (pick6.js): its board from the loader data its site uses,
// no login, one sport a 2-minute tick. A lead: off unless PICK6=on, never in
// Best Plays or alerts, its legs in the record under kinds of their own
// (p6-sharp, p6-ev, p6-gap) until about 50 graded legs say whether it beats the close.
const { createPick6Reader } = require('./pick6');
const PICK6_ON = /^(on|1|true|yes)$/i.test(String(process.env.PICK6 || '').trim());
// DraftKings blocks Railway, so while it does the board comes from the
// pick6-data branch, read on GitHub's servers (relay/pick6.js)
const PICK6_RELAY_REPO = process.env.RAILWAY_GIT_REPO_OWNER && process.env.RAILWAY_GIT_REPO_NAME ? `${process.env.RAILWAY_GIT_REPO_OWNER}/${process.env.RAILWAY_GIT_REPO_NAME}` : 'lkshanahan565656/line-reaper-backend';
const PICK6_RELAY_URL = process.env.PICK6_RELAY_URL || `https://raw.githubusercontent.com/${PICK6_RELAY_REPO}/pick6-data/pick6.json`;
const pick6 = createPick6Reader(axios, { enabled: PICK6_ON, relayUrl: /^off$/i.test(PICK6_RELAY_URL) ? null : PICK6_RELAY_URL });
async function scrapePick6() {
  if (!PICK6_ON) return;
  if (!licences.isOn('pick6')) { pick6.state.lastError = { ...LICENCE_PAUSED, at: new Date().toISOString() }; return; }
  await pick6.tick();
  // its own payout table, as the last read showed it
  if (pick6.state.payouts) sportProps.setPick6Payouts(pick6.state.payouts);
}
const P6_KIND = k => `p6-${k}`;
const baseSportKind = k => String(k || '').replace(/^p6-/, '');

// Every book's sports prop lines in one list, PrizePicks' half and quarter
// leagues folded into their sport, Sleeper given start times from the others
function sportsPropLines() {
  const ud = (cache.underdog.data || []).filter(l => !isEsports(l.sport));
  const pp = ppLinesNow().filter(l => !isEsports(l.sport));
  const sl = propsBoard.borrowStarts(cache.sleeperSports.data || [], [...ud, ...pp]);
  const p6 = pick6.lines().filter(l => !isEsports(l.sport));
  return [...ud, ...pp, ...sl, ...p6].map(propsBoard.normLine).filter(l => !l.esports);
}

// ─── OWLS FETCHERS (with dead-key circuit breaker) ────────────────────────────
// After 3 consecutive auth failures (401/403), Owls fetching disables itself
// entirely — no more log spam, no wasted CPU/egress on a lapsed key.
// Set a valid OWLS_API_KEY env var on Railway and restart to re-enable.
let owlsAuthFails = 0;
const owlsDisabled = () => owlsAuthFails >= 3 || !licences.isOn('owls');
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
    // Fitted to LCSLarry's PrizePicks LoL rows (Maps 1-3 kills: 10.5 vs 12.6
    // reads 59%, 15 vs 16.7 reads 58%), which put the variance near 6.5x the mean
    return 6.5;
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
// A boost can run past 1.35 on a lopsided line (Higher 1.48x, Lower 0.70x on a
// tight end's 14.5 receiving yards, 2026-10-14): when the other side pays
// under 1x, the pair is a boost and a discount, never a decimal payout.
//
// Then a reality check: every payout implies a probability. If our fair is
// more than 10 points ABOVE the book's implied number, the "edge" is almost
// always our error, so it gets no EV and a flag instead of a fantasy edge.
// Below it is just a bad price on that book: the (negative) EV is shown. The
// check runs at the book's own line, so a book hanging 3.5 where PrizePicks
// hangs 1.5 is compared against our chance at 3.5, not at 1.5.
const UD_DECIMAL_THRESHOLD = 1.35;
// Was 0.15 — two legs at a 14-point gap still slipped through and compounded
// into an "+88% EV" 2-leg slip. On a single prop, a 10-point disagreement with
// a live market is already a strong sign the error is ours.
const MAX_PROB_DISAGREEMENT = 0.10;

function udPricing(prob, mult, otherMult = null) {
  const p = prob > 1 ? prob / 100 : prob;
  const m = parseFloat(mult) || 1.00;
  const o = parseFloat(otherMult);
  const decimal = m > UD_DECIMAL_THRESHOLD && !(o > 0 && o < 1);
  const implied = decimal ? 1 / m : UD_IMPLIED / m;
  const ev = decimal ? (p * m - 1) * 100 : (p * m / UD_IMPLIED - 1) * 100;
  const gap = p - implied;
  const flag = gap > MAX_PROB_DISAGREEMENT ? 'price-mismatch' : null;
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
  matchContext, describeContext, opponentFrom, createOddsBook, teamsMatch, teamCode, sportKey, splitMatchTitle, spanScenarios, pMapPlayed,
} = require('./context');
const { refreshRatings } = require('./ratings');
const { fetchGolPlayers, golSeason, createVlrStats, headToHead, nameKey } = require('./propstats');
const { propProb } = require('./dist');
const { sportKey: trackerSportKey, statKind: trackerStatKind, clvKind } = require('./tracker');
const escal = require('./escal');
const esmarket = require('./esmarket');
const esgaps = require('./esgaps');
const sportProps = require('./sportprops');
const { createSportTracker, legDecimal: sportTrackLegDecimal } = require('./sporttrack');
const { createSportsGrader } = require('./sportgrade');
const { priceAll, bestSlips, PAYOUTS } = require('./slip');
const { createAlerter } = require('./alerts');
// ALERT_WEBHOOK_URL: ntfy (phone push), Telegram, Slack or Discord, comma-separated for several
const webhookOnly = require('./webhook').createWebhook({ urls: process.env.ALERT_WEBHOOK_URL });
// Every track record is backed up to the repo's results-data branch and
// restored on boot, so deploys don't wipe them (backup.js).
const { createBackup, axiosFetchJson } = require('./backup');
const resultsBackup = createBackup({ fetchJson: axiosFetchJson(axios) });
// Installed-app push (push.js): every webhook alert also goes to the phones that turned alerts on.
// The push store rides the encrypted results backup, so a deploy keeps the phones and the key.
const pushStore = require('./evtrack').createStoreFromEnv(process.env, { table: 'push_subs', fileVar: 'PUSH_FILE', file: 'push-subs.json' });
const push = require('./push').createPush({ store: process.env.DATABASE_URL ? pushStore : resultsBackup.wrap('push', pushStore, { appendOnly: false }) });
const webhook = require('./push').withPush(webhookOnly, push);
const { createAuth, createUserStoreFromEnv, publicUser, isPro } = require('./auth');
const { createLicences, hideWallets, hiddenWallets, mentions } = require('./licences');
const legal = require('./legal');
const { createBilling, verifyWebhook } = require('./billing');
const evScreen = require('./ev');
const bigMoney = require('./bigmoney');
const altLines = require('./altlines');
const exchanges = require('./exchanges');
const { createEvTracker, createStoreFromEnv: createEvStoreFromEnv } = require('./evtrack');
// Every flagged +EV price is logged and graded on closing-line value.
const evTracker = createEvTracker({ freshCloseOnly: true, store: resultsBackup.wrap('ev', createEvStoreFromEnv()), minEv: process.env.TRACK_EV_MIN != null ? parseFloat(process.env.TRACK_EV_MIN) : 2 });
// FanDuel's and BetRivers' ladders and alternate lines (altlines.js), graded
// the same way in a record of their own: the main-line record (and the books
// it proves for the webhook) stays the main lines'
const altTracker = createEvTracker({ freshCloseOnly: true, store: resultsBackup.wrap('evAlt', createEvStoreFromEnv(process.env, { table: 'ev_alt_bets', fileVar: 'EV_ALT_TRACK_FILE', file: 'ev-alt-bets.json' })), minEv: process.env.TRACK_EV_MIN != null ? parseFloat(process.env.TRACK_EV_MIN) : 2 });
// BetRivers' esports lines (esbooks.js), priced off Pinnacle and Kalshi: a record of their own too
const esBookTracker = createEvTracker({ freshCloseOnly: true, store: resultsBackup.wrap('evEsports', createEvStoreFromEnv(process.env, { table: 'ev_es_bets', fileVar: 'EV_ES_TRACK_FILE', file: 'ev-es-bets.json' })), minEv: process.env.TRACK_EV_MIN != null ? parseFloat(process.env.TRACK_EV_MIN) : 2 });
// FanDuel and BetRivers still on the number Pinnacle just left (stalelines.js): a record of their own
const staleTracker = createEvTracker({ freshCloseOnly: true, store: resultsBackup.wrap('evStale', createEvStoreFromEnv(process.env, { table: 'ev_stale_bets', fileVar: 'EV_STALE_TRACK_FILE', file: 'ev-stale-bets.json' })), minEv: process.env.TRACK_EV_MIN != null ? parseFloat(process.env.TRACK_EV_MIN) : 2 });
// Sports pick'em props flagged off the books' consensus and Kalshi, graded on
// ESPN box scores; tennis, UFC, NASCAR and soccer on ESPN's tennis and UFC
// scoreboards and Kalshi's settled markets (extragrade.js, EXTRA_RESULTS=off stops them)
const extraGrade = require('./extragrade');
const EXTRA_RESULTS_ON = !/^(off|0|false|no)$/i.test(String(process.env.EXTRA_RESULTS || '').trim());
const sportGrader = extraGrade.combineGraders(createSportsGrader({ http: axios }),
  EXTRA_RESULTS_ON ? extraGrade.createExtraGrader({ http: axios }) : { canGrade: () => false, grade: async () => null });
const sportTracker = createSportTracker({
  store: resultsBackup.wrap('sportProps', createEvStoreFromEnv(process.env, { table: 'sport_props', fileVar: 'SPORT_PROPS_FILE', file: 'sport-props.json' })),
  grader: sportGrader,
});
sportTracker.ready().catch(e => console.error('Sports props tracker: store failed to initialise:', e.message));
// MY SLIPS (slips.js, sliplog.js): the legs of users' own slips, followed to the
// close and graded like the props record, in a record of their own. Legs only:
// stakes and payouts stay in the user's browser.
const slipLegTracker = createSportTracker({
  store: resultsBackup.wrap('slipLegs', createEvStoreFromEnv(process.env, { table: 'slip_legs', fileVar: 'SLIP_LEGS_FILE', file: 'slip-legs.json' })),
  grader: createSportsGrader({ http: axios }),
});
slipLegTracker.ready().catch(e => console.error('Slip log: store failed to initialise:', e.message));
// SHOP (appshop.js): the softest number across the apps and the middles
// between two apps, followed to the close and graded like the props record
const shopTracker = createSportTracker({
  store: resultsBackup.wrap('shopLegs', createEvStoreFromEnv(process.env, { table: 'shop_legs', fileVar: 'SHOP_LEGS_FILE', file: 'shop-legs.json' })),
  grader: sportGrader,
});
shopTracker.ready().catch(e => console.error('Shop tracker: store failed to initialise:', e.message));
const slipLog = require('./sliplog').createSlipLog({ tracker: slipLegTracker });
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
  if (ping.length && webhook.enabled && process.env.SHARP_WEBHOOK !== 'off') {
    webhook.send(ping.slice(0, 10).map(e => '' + describeSharp(e)).join('\n'), 'Sharp alerts');
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
const auth = createAuth({ store: createUserStoreFromEnv(), secret: AUTH_SECRET, termsVersion: legal.TERMS_VERSION, minAge: legal.MIN_AGE });
const billing = createBilling({
  http: axios, secretKey: process.env.STRIPE_SECRET_KEY, priceId: process.env.STRIPE_PRICE_ID,
  store: auth.store, trialDays: parseInt(process.env.STRIPE_TRIAL_DAYS) || 0,
});
// PAYWALL=on turns the gates on. Off by default so a deploy never locks you out.
const PAYWALL = /^(1|on|true|yes)$/i.test(process.env.PAYWALL || '');
// Feeds whose terms don't cover a paid product stop being fetched while the
// paywall is on, each until its own *_DATA_OK setting is on (licences.js).
const licences = createLicences({ paywall: () => PAYWALL, extraHosts: { underdog: [(() => { try { return new URL(UNDERDOG_URL).hostname; } catch { return ''; } })()].filter(Boolean) } });
licences.install(axios);
if (PAYWALL && licences.state().paused.length) console.log(`Licences: paused while PAYWALL is on: ${licences.state().paused.join(', ')}`);

// New edges and line moves, pushed to the app (server-sent events) and, when
// ALERT_WEBHOOK_URL is set, to the webhook.
const alerter = createAlerter({
  minEv: process.env.ALERT_MIN_EV != null ? parseFloat(process.env.ALERT_MIN_EV) : undefined,
  send: webhook.enabled ? body => webhook.send(body.content, 'Alerts') : null,
});

function calcEsportsEV(ppLine, modelPred, side, sport, propText, opts = {}) {
  if (!ppLine || !modelPred || modelPred <= 0) return null;
  let k = getVarianceMultiplier(sport, propText);

  // Adaptive variance for low-volume props (DOTA, LOL kills)
  const s = (sport || '').toUpperCase();
  // A k below 1 claims kills are steadier than a Poisson count with a known
  // mean, which no player is: it priced a 4.0 projection at 88% over 2.5, where
  // even a perfectly known Poisson mean gives 76%. Low lines floor at 1.5.
  if (s.includes('DOTA')) {
    if (modelPred >= 15) k = 4.0;
    else if (modelPred >= 10) k = 2.8;
    else k = 1.5;
  }
  // Low LoL lines (supports, 1.5 to 2.5 kills) are priced on the count curve,
  // where a big k piles mass on zero and turns every one into a 65% under.
  // Close to Poisson is what a support's kills actually look like.
  if (s.includes('LOL') && modelPred < 5) {
    k = 2.0;
  }

  // Counts are priced as counts (negative binomial); fantasy points and any
  // case the count model can't represent fall back to the normal curve.
  // modelPred is the expected total over the span (per-map rate × expMaps), so
  // the per-map mean divides it back out, but only when the scenarios used are
  // the context's own; with no scenarios the whole projection is one 'map'.
  const sc = opts.context?.scenarios;
  const useCtx = !!(sc && sc.length && opts.context.expMaps > 0);
  const scenarios = useCtx ? sc : [{ maps: 1, weight: 1 }];
  const meanPerMap = useCtx ? modelPred / opts.context.expMaps : modelPred;
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

// The books' consensus chance (0-1) that `side` wins at `line`, on the board's
// own curve: the consensus mean (marketPred, before any model nudge) with the
// curve's skew taken out, exactly as esmarket prices each quote. The tracker
// prices a pick's signal ticket with it at signal and again at lock (market CLV).
const pickCtx = new WeakMap();
const CLV_WARN_N = parseInt(process.env.CLV_WARN_N || '20');
const MATCHUP_PROVEN_N = parseInt(process.env.MATCHUP_PROVEN_N || '20');
// points of win chance a line gap must be worth on our side (esgaps.js)
const GAP_MIN_PTS = parseFloat(process.env.GAP_MIN_PTS || String(esgaps.DEFAULTS.minProbPts));
const CLV_WARN_SHARE = parseFloat(process.env.CLV_WARN_SHARE || '0.4');
function marketFairProb(p, line, side, ctx) {
  if (!p || p.marketPred == null || !(line > 0) || (side !== 'OVER' && side !== 'UNDER')) return null;
  const opts = ctx || pickCtx.get(p) || { context: null };
  const r = calcEsportsEV(line, p.marketPred, side, p.sport, p.market, opts);
  if (!r) return null;
  const skew = lineSkew(line, p.sport, p.market, opts);
  return Math.max(0.001, Math.min(0.999, (r.prob + (side === 'OVER' ? skew : -skew)) / 100));
}

// Points the curve's shape alone takes off the over when the projection sits
// exactly on the line (0 for symmetric curves, up to ~12 on support kill lines).
function lineSkew(line, sport, propText, opts = {}) {
  const z = calcEsportsEV(line, line, 'OVER', sport, propText, opts);
  return z ? 50 - z.prob : 0;
}

function predictEsportsSide(ppLine, modelPred, sport, propText, opts = {}) {
  if (!ppLine || !modelPred) return null;
  const side = modelPred < ppLine ? 'UNDER' : modelPred > ppLine ? 'OVER' : null;
  if (!side) return null;
  const r = calcEsportsEV(ppLine, modelPred, side, sport, propText, opts);
  if (!r) return null;
  return { ...r, side, ppLine, modelPred, ev: calcBookEV(r.prob, 'prizepicks') };
}

const { parseMapSpan, normalizeName, normalizeMarket } = require('./esmarkets');

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
  // No rating bonus on top: a rating is built mostly from kills per round, so
  // scaling KPR-based kills by it again counted the same skill twice.
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

// The vlrggapi mirror behind the table answers 402 now, so a player it
// doesn't have is read from vlr.gg itself (search, then the player's 60-day
// agent table), cached 12 hours. See propstats.js.
const vlrStats = createVlrStats({ http: axios });

async function fetchVLRPlayerStats(playerName, team = '') {
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
  if (!hit) return vlrStats.lookup(playerName, team);
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
    // lobby_type 1 is tournament lobbies, where pro props are played. A pro's
    // public ranked games run hotter and would skew every line to the over;
    // fall back to them only when a player has too few pro games on record.
    const get = (extra) => axios.get(`https://api.opendota.com/api/players/${accountId}/matches`, {
      params: { limit: 40, significant: 1, ...extra }, timeout: 20000,
    }).then(r => (Array.isArray(r.data) ? r.data : []).filter(m => m && isFinite(m.kills)));
    let ms = await get({ lobby_type: 1 });
    let pro = true;
    if (ms.length < 5) { ms = await get({}); pro = false; }
    if (ms.length < 5) {
      dotaCache.players[key] = { failed: true, lastUpdate: Date.now() };
      return null;
    }
    const kills = ms.reduce((s, m) => s + m.kills, 0) / ms.length;
    const assists = ms.reduce((s, m) => s + (m.assists || 0), 0) / ms.length;
    const stats = {
      name: playerName, accountId, avgKillsPerMap: kills, avgAssistsPerMap: assists,
      mapsPlayed: ms.length, pro, lastUpdate: Date.now(), source: 'opendota',
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
function bo3HeadshotPct(acc) {
  const rows = Array.isArray(acc) ? acc : Array.isArray(acc?.data) ? acc.data : Array.isArray(acc?.results) ? acc.results : null;
  if (!rows) return null;
  let head = 0, all = 0;
  for (const r of rows) {
    const k = parseFloat(r?.kills_sum);
    if (!isFinite(k)) continue;
    all += k;
    if (/^head$/i.test(r.hit_group || '')) head += k;
  }
  return all >= 50 ? head / all * 100 : null;   // too few kills to trust a rate
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
  // bo3 calls a map a "game": games_count is maps, matches_count is series.
  // Reading matches_count as maps put donk at 48.7 kills a map.
  const mapsPlayed = bo3Pick(g, ['games_count', 'maps', 'maps_count', 'maps_played'])
    ?? bo3Pick(m, ['maps_count', 'count', 'total']) ?? bo3Pick(g, ['matches_count']);
  const rating = bo3Pick(g, ['rating', 'player_rating', 'hltv_rating', 'rating_avg']);
  // accuracy_stats is one row per hit group; headshot rate is Head kills over
  // all kills. Without it every headshot prop was priced at a flat 45%.
  let hsPercent = bo3HeadshotPct(acc)
    ?? bo3Pick(g, ['headshots_percentage', 'hs_percent', 'headshot_percent']);

  const stats = { name: playerName, lastUpdate: Date.now(), source: 'bo3' };
  if (kpr) stats.kpr = kpr;
  else if (kills && rounds) stats.kpr = kills / rounds;
  if (kills && mapsPlayed) stats.avgKillsPerMap = kills / mapsPlayed;
  if (rounds && mapsPlayed) stats.roundsPerMap = rounds / mapsPlayed;
  if (mapsPlayed) stats.mapsPlayed = mapsPlayed;
  // how often his team wins a map against the opponents behind these averages,
  // so tonight's matchup is read relative to his usual one (context.js)
  const mapsWon = bo3Pick(g, ['games_won_count', 'games_won']);
  if (mapsWon != null && mapsPlayed) stats.mapWinRate = mapsWon / mapsPlayed;
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
  esPicksRebuild().catch(() => {});
}

// gol.gg's season table: every pro's games and per-game kills/assists on one
// page. Tried first now that Oracle's Elixir is gone and Leaguepedia
// rate-limits datacenter IPs.
async function refreshLoLFromGol() {
  const rows = await fetchGolPlayers(axios);
  const players = {};
  for (const r of Object.values(rows)) players[r.name.toLowerCase()] = { kpg: r.kpg, apg: r.apg, dpg: r.dpg, kp: r.kp, games: r.games };
  Object.assign(lolStats, { players, teams: {}, games: Object.values(rows).reduce((a, r) => a + r.games, 0) / 5 | 0, updated: new Date().toISOString(), state: 'ready', lastError: null, source: 'gol.gg' });
  console.log(`gol.gg: ${Object.keys(players).length} LoL players (${golSeason()})`);
  esPicksRebuild().catch(() => {});
}

async function refreshLoLStats(windowDays = 120) {
  if (lolStats.state === 'downloading') return;
  lolStats.state = 'downloading';
  const errors = [];
  try { await refreshLoLFromGol(); return; } catch (e) { errors.push(`gol.gg → ${e.response?.status || e.message}`); }
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
      esPicksRebuild().catch(() => {});
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
function lolPlayer(playerName) {
  const p = lolStats.players[(playerName || '').toLowerCase()];
  if (p) return p;
  const key = nameKey(playerName);
  if (!key) return null;
  const hit = Object.keys(lolStats.players).find(k => nameKey(k) === key);
  return hit ? lolStats.players[hit] : null;
}
function predictLoLStat(playerName, mapCount, stat = 'kills') {
  const p = lolPlayer(playerName);
  if (!p || !p.games || p.games < 4) return null;
  let perGame, share, teamPg;
  if (stat === 'assists') { perGame = p.apg; share = p.assistShare; teamPg = p.teamApg; }
  else { perGame = p.kpg; share = p.killShare; teamPg = p.teamKpg; }
  if (!perGame) return null;
  if (share && teamPg) perGame = 0.5 * perGame + 0.5 * (share * teamPg);
  return perGame * (mapCount || 1);
}
function predictLoLKills(playerName, mapCount) { return predictLoLStat(playerName, mapCount, 'kills'); }

// ─── MATCH CONTEXT STATE ──────────────────────────────────────────────────────
// Elo per sport from recent results (refreshed every 6h) + odds entered by hand.
const ratingsState = { elo: {}, meta: {} };
const oddsBook = createOddsBook();

// ── EXTRA DATA FEEDS (feeds.js) ──
// PandaScore: CS2/CoD/Valorant ratings, best-of schedule, CS2/VAL/CoD grading.
// Pinnacle guest API: sharp esports match prices for context (check its terms
// before charging for a product built on it).
const { createPandaScoreClient, fetchPinnacleEsports, loadMatchPrices } = require('./feeds');
// One switch for every Pinnacle read (esports match prices and player props):
// PINNACLE=on. The guest feed needs no key; PINNACLE_GUEST_KEY, when set, is
// sent with each request and turns it on too.
const PINNACLE_ON = !!process.env.PINNACLE_GUEST_KEY || /^(on|1|true|yes)$/i.test(String(process.env.PINNACLE || '').trim());
const panda = process.env.PANDASCORE_TOKEN ? createPandaScoreClient(axios, process.env.PANDASCORE_TOKEN) : null;
const feedState = {
  pandascore: { enabled: !!panda, schedules: {}, updated: null, errors: {} },
  pinnacle: { enabled: PINNACLE_ON, matches: 0, loaded: 0, updated: null, error: null },
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

function evenContext(maps, opponent = null) {
  const bestOf = Math.max(...maps) >= 4 ? 5 : 3;
  const scenarios = spanScenarios(maps, 0.5, bestOf);
  return {
    source: 'even', opponent, pMap: 0.5, bestOf, pTypical: 0.5,
    pLastMap: pMapPlayed(Math.max(...maps), 0.5, bestOf),
    scenarios, expMaps: scenarios.reduce((a, sc) => a + sc.maps * sc.weight, 0), factor: 1,
  };
}

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
  const ppLines = ppLinesNow();
  const udLines = cache.underdog.data || [];

  // a started match's lines can't be played; a blocked book's cache keeps them
  const t0 = Date.now(), open = l => !(Date.parse(l.startTime || '') <= t0);
  const ppEsports = ppLines.filter(l => isEsports(l.sport) && open(l));
  const udEsports = udLines.filter(l => isEsports(l.sport) && open(l));

  // Each line's match (esmatch.js): a CS player in two or three Bo1s a day has
  // a "Kills on Map 1" per match, so lines are keyed by player, stat and match.
  // Sleeper lines take their start and title from an Underdog or PrizePicks line
  // against the same opponent (both teams' Sleeper lines share a game id).
  const slTeams = esmatch.sleeperTeams(cache.sleeper.data || []);
  const slEsports = [];
  for (const l of cache.sleeper.data || []) {
    const b = esmatch.borrowMatch(l, [...udEsports, ...ppEsports], { slOpp: slTeams, sportOf: x => trackerSportKey(x.sport), now: t0 });
    if (b) slEsports.push(b);
  }
  const tags = esmatch.matchTags([...ppEsports, ...udEsports, ...slEsports], { playerOf: l => normalizeName(l.player), sportOf: l => trackerSportKey(l.sport) });
  const lineKey = l => `${normalizeName(l.player)}|${normalizeMarket(l.market)}|${tags.get(l)}`;
  let unplaced = 0;
  const placed = l => { if (tags.get(l) == null) { unplaced++; return false; } return true; };

  // UD lookup, side-aware multipliers
  const udMap = {};
  for (const l of udEsports) {
    if (!l.player || l.line == null || !placed(l)) continue;
    udMap[lineKey(l)] = {
      line: l.line, overMultiplier: l.overMultiplier || 1.00, underMultiplier: l.underMultiplier || 1.00,
      overOpen: l.overOpen !== false, underOpen: l.underOpen !== false,
      market: l.market, sport: l.sport, player: l.player, team: l.team || '', startTime: l.startTime || '',
      matchTitle: l.matchTitle || '',
      gameId: l.gameId || null, matchTag: tags.get(l),
      matched: false,
    };
  }
  const slMap = {};
  for (const l of slEsports) if (placed(l)) slMap[lineKey(l)] = { ...l, matchTag: tags.get(l), matched: false };
  esportsCache.matchSplit = { players: new Set([...tags].filter(([, t]) => t != null).map(([l, t]) => `${normalizeName(l.player)}|${t}`)).size, unplaced };
  console.log(`Esports: PP=${ppEsports.length} UD=${udEsports.length} SL=${slEsports.length}/${(cache.sleeper.data || []).length} udMap=${Object.keys(udMap).length}`);

  // Limit fresh stat lookups per cycle so pick generation stays fast;
  // cached players are free and refresh hourly.
  let freshLookups = 0;
  const MAX_FRESH_LOOKUPS = 40;
  const implausibleLines = [];
  const spanCounts = { inferred: 0 };
  let priceMismatches = 0, closedSides = 0;
  const contextCounts = {};

  // What the record says so far: kinds of pick that keep losing get their
  // probability pulled down, kinds that keep winning get a little more (escal.js)
  // The market price (esmarket.js) is the default: the books' own lines and
  // payouts set the number, and our projection only nudges it by what the
  // record says it's worth. ESPORTS_MARKET=off goes back to model-first pricing.
  const marketOn = process.env.ESPORTS_MARKET !== 'off';
  let calib = null, weights = esmarket.modelWeights([]);
  let graded = [];
  try { graded = await tracker.list({ status: 'graded', limit: 100000 }); } catch (e) { console.warn('Esports: graded record unavailable:', e.message); }
  weights = esmarket.modelWeights(graded);
  const biases = esmarket.lineBias(graded);
  const matchupW = esmarket.matchupWeights(graded);
  if (process.env.ESPORTS_CALIBRATION !== 'off') {
    try {
      const prior = parseFloat(process.env.ESPORTS_CAL_PRIOR);
      // calibrate on picks priced the way the board prices now: the model-first
      // record says how wrong that model was, not how the market price does
      const rows = marketOn ? graded.filter(r => r.fair === 'market') : graded.filter(r => r.fair !== 'market');
      calib = escal.calibrate(rows, Number.isFinite(prior) && prior > 0 ? { prior } : {});
    } catch (e) { console.warn('Esports: calibration skipped:', e.message); }
  }
  esportsCache.calibration = calib ? { prior: calib.prior, buckets: Object.values(calib.buckets), at: new Date().toISOString() } : null;
  esportsCache.modelWeights = { market: marketOn, weights: Object.values(weights.table), lineBias: Object.values(biases.table), matchup: Object.values(matchupW.table), at: new Date().toISOString() };
  const marketCounts = { priced: 0, marketOnly: 0, multiBook: 0, dropped: 0 };

  // Where the books put this player, and the number the board prices with.
  // quotes: [{ book, line, over, under, overOpen, underOpen }]
  function marketize(base, g, quotes) {
    if (!marketOn || g.predSource === 'manual') return g;
    const statKind = normalizeMarket(base.market).split('|')[0];
    if (!['k', 'hs', 'ast'].includes(statKind)) return g;
    const ctxOpts = { context: g.context || null };
    const skews = new Map();
    const skewOf = ln => { if (!skews.has(ln)) skews.set(ln, lineSkew(ln, base.sport, base.market, ctxOpts)); return skews.get(ln); };
    const overFair = (ln, m) => {
      const r = calcEsportsEV(ln, m, 'OVER', base.sport, base.market, ctxOpts);
      return r ? Math.max(0.001, Math.min(0.999, (r.prob + skewOf(ln)) / 100)) : null;
    };
    const sk = trackerSportKey(base.sport), st = trackerStatKind(base.market);
    const cons = esmarket.consensus(quotes.filter(Boolean).map(q => ({ ...q, bias: biases.bias(sk, st, q.book) })), overFair);
    if (!cons) return g;
    const raw = g.predSource === 'auto' ? g.rawPred : null;
    let w = weights.weight(sk, st);
    if (g.sampleSize != null) w *= Math.min(1, Math.max(0.25, g.sampleSize / 40));
    // Matchup: the market's number moved by how favoured the player's team is
    // tonight against its usual opponent (context.js killFactor), at the weight
    // the graded record gives it (esmarket.matchupWeights)
    const mu = g.matchup && g.matchup.factor > 0 ? g.matchup : null;
    const muW = mu ? matchupW.weight(sk) : 0;
    const muAdj = mu ? 1 + muW * (mu.factor - 1) : 1;
    const mean = esmarket.blend(cons.mean, raw, w) * muAdj;
    const kept = cons.quotes.filter(q => !q.dropped);
    marketCounts.priced++;
    if (raw == null) marketCounts.marketOnly++;
    if (kept.length > 1) marketCounts.multiBook++;
    marketCounts.dropped += cons.quotes.length - kept.length;
    const fmtQ = q => `${q.book} ${q.line}${q.book === 'PP' ? '' : ` ${Math.round(q.pOver * 100)}% over`}${q.bias ? `, runs ${q.bias > 0 ? 'low' : 'high'} ${Math.abs(q.bias * 100).toFixed(0)}%` : ''}${q.dropped ? ' (left out)' : ''}`;
    const note = `market ${cons.mean.toFixed(1)} (${cons.quotes.map(fmtQ).join(', ')})${raw != null ? ` · model ${raw.toFixed(1)} at ${Math.round(w * 100)}% weight` : ''}${mu && Math.abs(muAdj - 1) >= 0.005 ? ` · matchup ×${muAdj.toFixed(3)} (${describeContext(mu)}, at ${Math.round(muW * 100)}% weight)` : ''}`;
    return {
      ...g, modelPred: mean, predSource: raw != null ? 'auto' : 'market', fair: 'market',
      market: { mean: cons.mean, quotes: cons.quotes, modelWeight: +w.toFixed(3), raw: raw != null ? +raw.toFixed(2) : null },
      matchupInfo: mu ? { source: mu.source, opponent: mu.opponent, pMap: +mu.pMap.toFixed(3), factor: +mu.factor.toFixed(4), weight: +muW.toFixed(3), adj: +muAdj.toFixed(4), baseMean: +esmarket.blend(cons.mean, raw, w).toFixed(3), h2h: mu.h2h || null } : null,
      statLine: [g.statLine, note].filter(Boolean).join(' · '),
    };
  }
  const udQuote = udm => udm && { book: 'UD', line: udm.line, over: udm.overMultiplier, under: udm.underMultiplier, overOpen: udm.overOpen, underOpen: udm.underOpen };
  const slQuote = slm => slm && { book: 'SL', line: slm.line, over: slm.overMultiplier, under: slm.underMultiplier, overOpen: slm.overOpen, underOpen: slm.underOpen };

  // Manual predictions are stored under the exact 'player|market' string the user
  // clicked on — but the same pick reads "MAPS 1-2 Kills" on PP and
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

    // only kills, headshots, assists and fantasy are modelled; a first-blood
    // line priced as kills would read as a huge under
    const statKind = normalizeMarket(lineObj.market).split('|')[0];
    if (modelPred == null && !['k', 'hs', 'ast', 'fp'].includes(statKind)) {
      return { modelPred: null, predSource: null, manualKey, rawPred, sampleSize, spanInferred, statLine, context };
    }
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

      let autoPred = null, usualWin = null;
      if (sportKey === 'LOL') {
        // Oracle's Elixir aggregates are in memory — no lookup budget needed
        const mk = (lineObj.market || '').toLowerCase();
        if (mk.includes('fantasy')) autoPred = null;   // FP needs the book's scoring formula — manual for now
        else autoPred = predictLoLStat(lineObj.player, mapCount, mk.includes('assist') ? 'assists' : 'kills');
        const lp = lolPlayer(lineObj.player);
        sampleSize = lp?.games ?? null;
        if (lp) statLine = `${lp.kpg.toFixed(1)} k/game · ${(lp.apg ?? 0).toFixed(1)} a/game · ${(lp.killShare != null ? (lp.killShare * 100).toFixed(0) + '% of team kills · ' : lp.kp ? Math.round(lp.kp * 100) + '% kill participation · ' : '')}${lp.games} games`;
      } else if (sportKey === 'VAL') {
        // the bulk table is free; a vlr.gg page lookup spends the per-cycle budget
        let player = null;
        const known = !!vlrTable.players[vlrKey(lineObj.player)] || vlrStats.cache.has(nameKey(lineObj.player));
        if (known || freshLookups < MAX_FRESH_LOOKUPS) {
          if (!known) freshLookups++;
          player = await fetchVLRPlayerStats(lineObj.player, lineObj.team);
        }
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
            // fantasy points need the book's scoring table, which we can't verify yet
            const per = mk.includes('fantasy') ? null : mk.includes('assist') ? player.avgAssistsPerMap : player.avgKillsPerMap;
            if (per) autoPred = per * mapCount;
            sampleSize = player.mapsPlayed ?? null;
            statLine = `${player.avgKillsPerMap.toFixed(1)} k/game · ${player.avgAssistsPerMap.toFixed(1)} a/game · ${player.mapsPlayed} ${player.pro === false ? 'public' : 'pro'} games`;
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
          // shrunk toward 50% by 10 maps, so a hot 6-map run doesn't read as his norm
          if (player.mapWinRate != null && player.mapsPlayed) {
            usualWin = (player.mapWinRate * player.mapsPlayed + 5) / (player.mapsPlayed + 10);
          }
        }
      }
      rawPred = autoPred;

      // A line far above the player's own per-map rate for the labelled span
      // ("Maps 1+2" priced like three maps) used to be rescaled to a longer
      // span. Underdog settles on its label, so the tracker graded those on a
      // span the book never used. Now the line is left unpriced: when the book
      // and our rate disagree by a whole map, the error is almost always ours.
      if (autoPred && sportKey !== 'LOL' && inferMapSpan(lineObj.line, autoPred, mapCount)) {
        spanCounts.inferred++;
        autoPred = null;
        rawPred = null;
      }

      // MATCH CONTEXT — scale per-map rate by the matchup and price the span
      // by how many maps are actually likely to be played.
      if (autoPred && plausible) {
        const spanMaps = spanInferred ? spanInferred : mapCount;
        const label = spanInferred ? `1-${spanInferred}` : parseMapSpan(lineObj.market).label;
        const maps = spanToMapList(label, spanMaps);
        // PrizePicks names the opponent in "ENCE MAP 1": without it a team in
        // three Bo1s a day was priced on whichever of its matches came up first
        const opponent = opponentFrom(lineObj.team, lineObj.matchTitle, null)
          || (lineObj.book !== 'sleeper' ? esmatch.lineOpponent({ ...lineObj, book: 'x' }) : null)
          || (lineObj.matchTitle && !splitMatchTitle(lineObj.matchTitle) && !/\d|map|game/i.test(lineObj.matchTitle) && !teamsMatch(lineObj.team, lineObj.matchTitle) ? lineObj.matchTitle : null);
        // the title's own name for the player's side, when it differs from the
        // roster name ("Team WE" vs "Xi'an Team WE"): the match prices use it
        const sides = splitMatchTitle(lineObj.matchTitle);
        const titleTeam = sides && opponent ? (sides[0] === opponent ? sides[1] : sides[1] === opponent ? sides[0] : null) : null;
        const ctxArgs = { sport: sportU, opponent, maps, usual: usualWin }, ctxDeps = { oddsBook, elo: ratingsState.elo };
        context = (titleTeam && titleTeam !== lineObj.team && matchContext({ ...ctxArgs, team: titleTeam }, ctxDeps))
          || matchContext({ ...ctxArgs, team: lineObj.team }, ctxDeps);
        // No price and no rating, but the span runs past the maps a Bo3 always
        // plays ("Maps 1+2+3"): a deciding map happens about half the time, not
        // always, so price it as an even matchup rather than a sure 3 maps.
        if (!context && Math.max(...maps) > 2) context = evenContext(maps, opponent);
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
    // The matchup (who's favoured, by the exchanges or ratings, plus head-to-head)
    // for the market price: read for every line, not only ones our model priced.
    let matchup = predSource === 'auto' ? context : null;
    if (!matchup && predSource !== 'manual' && ['k', 'hs', 'ast'].includes(statKind)) matchup = lineMatchup(lineObj);
    if (predSource !== 'auto') context = null;   // manual numbers are the user's own model
    if (context) statLine = [statLine, describeContext(context)].filter(Boolean).join(' · ');
    return { modelPred, predSource, manualKey, rawPred, sampleSize, spanInferred, statLine, context, matchup };
  }
  function lineMatchup(lineObj) {
    try {
      const span = parseMapSpan(lineObj.market);
      const maps = spanToMapList(span.label, span.count);
      // PrizePicks titles a line by the opponent's code and the span: "BFX MAPS 1-3"
      const ppOpp = /^(\S+)\s+MAPS?\s/i.exec(String(lineObj.matchTitle || ''))?.[1] || null;
      const opponent = opponentFrom(lineObj.team, lineObj.matchTitle, null) || ppOpp;
      const sides = splitMatchTitle(lineObj.matchTitle);
      const titleTeam = sides && opponent ? (sides[0] === opponent ? sides[1] : sides[1] === opponent ? sides[0] : null) : null;
      const ctxArgs = { sport: (lineObj.sport || '').toUpperCase(), opponent, maps }, ctxDeps = { oddsBook, elo: ratingsState.elo };
      return (titleTeam && titleTeam !== lineObj.team && matchContext({ ...ctxArgs, team: titleTeam }, ctxDeps))
        || matchContext({ ...ctxArgs, team: lineObj.team }, ctxDeps);
    } catch { return null; }
  }

  // Build one pick object. Only books that ACTUALLY carry the line get an EV —
  // no more fabricated Betr/ParlayPlay/Sleeper numbers with default multipliers.
  function assemble(base, modelPred, predSource, manualKey, udm, lineSource, g = {}, slm = null) {
    const lineVal = base.line;
    const pick = {
      sport: base.sport, player: base.player, team: base.team || '', matchTitle: base.matchTitle || '', market: base.market,
      ppLine: lineVal, startTime: base.startTime || '', lineSource,
      modelPred: modelPred != null ? parseFloat(modelPred.toFixed(2)) : null,
      predSource: modelPred != null ? predSource : null,
      rawPred: (predSource === 'auto' && g.rawPred != null) ? parseFloat(g.rawPred.toFixed(2)) : null,
      fairSource: modelPred != null ? (g.fair || 'model') : null,
      marketPred: g.market ? g.market.mean : null,
      matchup: g.matchupInfo || null,
      marketQuotes: g.market ? g.market.quotes : null,
      modelWeight: g.market ? g.market.modelWeight : null,
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
      udMultiplier: null, sleeperMultiplier: null, udLine: udm ? udm.line : null, sleeperLine: slm ? slm.line : null, sleeperFlag: null,
      // both sides' payouts and which are open, for pricing either side (sharemodel.js)
      udSides: udm ? { over: udm.overMultiplier ?? null, under: udm.underMultiplier ?? null, overOpen: udm.overOpen !== false, underOpen: udm.underOpen !== false } : null,
      slSides: slm ? { over: slm.overMultiplier ?? null, under: slm.underMultiplier ?? null, overOpen: slm.overOpen !== false, underOpen: slm.underOpen !== false } : null,
      udRegime: null, udImplied: null, udFlag: null,
      bestBook: null, bestEv: null, bookEdge: null, confidence: null, varianceK: null,
      model: null, pushProb: 0, gameId: base.gameId ?? null,
      // the match this line is for (esmatch.js): one player, two Bo1s, two picks
      matchTag: base.matchTag ?? tags.get(base) ?? null,
      pricing: null,
    };
    if (modelPred == null || !lineVal) return pick;   // no model yet — still listed for input

    const ctxOpts = { context: g.context || null };
    pickCtx.set(pick, ctxOpts);   // the tracker prices CLV on the same curve
    // The book hangs its line where it sees 50/50, the median. Kill counts are
    // right-skewed, so a projection sitting right on the line still prices the
    // under at 55 to 62%: a lean that comes from the curve's shape, not from
    // anything we know. The skew is measured at the line and taken back out.
    // Auto projections only: they're anchored toward the line, which treats the
    // line as the book's mean. A hand-entered number is the user's own mean.
    const skewAt = ln => (predSource === 'auto' || predSource === 'market') ? lineSkew(ln, base.sport, base.market, ctxOpts) : 0;
    const skew = skewAt(lineVal);
    const over = calcEsportsEV(lineVal, modelPred, 'OVER', base.sport, base.market, ctxOpts);
    if (!over) return pick;
    const overFair = over.prob + skew;
    const side = overFair > 50.05 ? 'OVER' : overFair < 49.95 ? 'UNDER' : null;
    if (!side) return pick;
    // Only a side the book actually takes is a pick. UD-only lines with the
    // model's side closed stay listed with the projection but no side, so they
    // never reach Best Plays, entries, alerts or the tracked record.
    const onlyBook = lineSource === 'ud' ? udm : lineSource === 'sl' ? slm : null;
    if (onlyBook && (side === 'OVER' ? !onlyBook.overOpen : !onlyBook.underOpen)) {
      pick.sideClosed = side;
      const bookName = lineSource === 'sl' ? 'Sleeper' : 'Underdog';
      pick.statLine = [pick.statLine, `model leans ${side === 'OVER' ? 'Higher' : 'Lower'}, ${bookName} only offers ${side === 'OVER' ? 'Lower' : 'Higher'} on this line`].filter(Boolean).join(' · ');
      closedSides++;
      return pick;
    }
    const r = calcEsportsEV(lineVal, modelPred, side, base.sport, base.market, ctxOpts);
    if (!r) return pick;
    const sideSkew = side === 'OVER' ? skew : -skew;
    r.prob = escal.adjustPct(r.prob, sideSkew / 100);
    pick.skewPts = parseFloat(sideSkew.toFixed(2));

    // calibrate on the record: same shift on every line this pick is priced at
    const calShift = calib ? calib.shift(trackerSportKey(base.sport), trackerStatKind(base.market), side) : 0;
    pick.rawProb = parseFloat(r.prob.toFixed(2));
    pick.calShift = calShift || 0;
    if (calShift) {
      r.prob = escal.adjustPct(r.prob, calShift);
      r.confidence = r.prob > 62 ? 'HIGH' : r.prob > 56 ? 'MED' : 'LOW';
      const b = calib.bucket(trackerSportKey(base.sport), trackerStatKind(base.market), side);
      const rec = `${b.wins}-${b.losses} on ${b.sport} ${b.stat} ${side === 'OVER' ? 'overs' : 'unders'}`;
      pick.statLine = [pick.statLine, `record ${rec}: ${calShift > 0 ? '+' : ''}${(calShift * 100).toFixed(1)} pts`].filter(Boolean).join(' · ');
    }

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
      shift: (calShift || 0) + sideSkew / 100,
    };

    // each book's own line, probability and payout, for slips built on that book (slipbuild.js)
    const bookLegs = {};
    if (lineSource === 'pp') {
      pick.ppEv = parseFloat(calcBookEV(r.prob, 'prizepicks').toFixed(2));
      bookLegs.PP = { line: lineVal, shift: pick.pricing.shift, prob: r.prob / 100 };
    }
    pick.pricing.books = bookLegs;

    // Underdog listing the player isn't Underdog taking this side: a Higher-only
    // line gets no UD price on a Lower pick (it used to be priced at 1x and
    // could win best book on a PrizePicks-sourced pick).
    const udOpen = udm && (side === 'OVER' ? udm.overOpen !== false : udm.underOpen !== false);
    if (udm && !udOpen) pick.udClosed = true;
    if (udOpen) {
      const udSideMult = side === 'OVER' ? (udm.overMultiplier || 1.00) : (udm.underMultiplier || 1.00);
      let udShift = pick.pricing.shift;
      // UD's line can differ from PP's — price UD against ITS OWN line
      let udProb = r.prob;
      if (udm.line != null && udm.line !== lineVal) {
        const r2 = calcEsportsEV(udm.line, modelPred, side, base.sport, base.market, ctxOpts);
        const s2 = skewAt(udm.line);
        if (r2) udProb = escal.adjustPct(r2.prob, calShift + (side === 'OVER' ? s2 : -s2) / 100);
        udShift = calShift + (side === 'OVER' ? s2 : -s2) / 100;
      }
      const udP = udPricing(udProb, udSideMult, side === 'OVER' ? udm.underMultiplier : udm.overMultiplier);
      if (udP.ev != null) {
        bookLegs.UD = { line: udm.line ?? lineVal, shift: udShift, prob: udProb / 100, mult: udSideMult, decimal: udP.regime === 'decimal' };
      }
      pick.udEv = udP.ev != null ? parseFloat(udP.ev.toFixed(2)) : null;
      pick.udMultiplier = udSideMult;
      pick.udRegime = udP.regime;
      pick.udImplied = parseFloat(udP.implied.toFixed(1));
      pick.udProb = parseFloat(udProb.toFixed(2));   // our chance at Underdog's own line
      pick.udFlag = udP.flag;
      if (udP.flag) priceMismatches++;
    }

    if (slm) {
      const slMult = side === 'OVER' ? slm.overMultiplier : slm.underMultiplier;
      if (slMult) {
        let slProb = r.prob, slShift = pick.pricing.shift;
        if (slm.line !== lineVal) {
          const r3 = calcEsportsEV(slm.line, modelPred, side, base.sport, base.market, ctxOpts);
          const s3 = skewAt(slm.line);
          if (r3) slProb = escal.adjustPct(r3.prob, calShift + (side === 'OVER' ? s3 : -s3) / 100);
          slShift = calShift + (side === 'OVER' ? s3 : -s3) / 100;
        }
        const slP = sleeperPricing(slProb, slMult, side === 'OVER' ? slm.underMultiplier : slm.overMultiplier);
        if (slP.ev != null) bookLegs.SL = { line: slm.line, shift: slShift, prob: slProb / 100, mult: slMult };
        pick.sleeperEv = slP.ev != null ? parseFloat(slP.ev.toFixed(2)) : null;
        pick.sleeperMultiplier = slMult;
        pick.sleeperImplied = parseFloat(slP.implied.toFixed(1));
        pick.sleeperProb = parseFloat(slProb.toFixed(2));
        pick.sleeperFlag = slP.flag;
        if (slP.flag) priceMismatches++;
      }
    }

    const books = [['PP', pick.ppEv], ['UD', pick.udEv], ['SL', pick.sleeperEv]].filter(b => b[1] != null);
    if (books.length) {
      const best = books.reduce((a, b) => (b[1] > a[1] ? b : a));
      pick.bestBook = best[0];
      pick.bestEv = best[1];
      pick.ev = pick.ppEv ?? pick.udEv ?? pick.sleeperEv;
      // book-vs-book EV gap — under its own name so it can't clobber pick.edge,
      // which is our projection's distance from the line
      pick.bookEdge = parseFloat((best[1] - (pick.ppEv ?? best[1])).toFixed(2));
    }
    return pick;
  }

  const picks = [];

  // PP lines first (when PP is alive) — cross-matched to UD
  for (const line of ppEsports) {
    if (!line.player || line.line == null || !placed(line)) continue;
    const key = lineKey(line);
    const udm = udMap[key] || null, slm = slMap[key] || null;
    if (udm) udm.matched = true;
    if (slm) slm.matched = true;
    const g = marketize(line, await getModelPred(line), [{ book: 'PP', line: line.line }, udQuote(udm), slQuote(slm)]);
    picks.push(assemble(line, g.modelPred, g.predSource, g.manualKey, udm, 'pp', g, slm));
  }

  // UD lines with no PP counterpart — the board stays full even when PP is blocked
  for (const udm of Object.values(udMap)) {
    if (udm.matched) continue;
    const base = { sport: udm.sport, player: udm.player, team: udm.team, market: udm.market, line: udm.line, startTime: udm.startTime, matchTitle: udm.matchTitle, gameId: udm.gameId, matchTag: udm.matchTag };
    const slm = slMap[`${normalizeName(udm.player)}|${normalizeMarket(udm.market)}|${udm.matchTag}`] || null;
    if (slm) slm.matched = true;
    const g = marketize(base, await getModelPred(base), [udQuote(udm), slQuote(slm)]);
    picks.push(assemble(base, g.modelPred, g.predSource, g.manualKey, udm, 'ud', g, slm));
  }

  // Sleeper lines neither PP nor UD carries
  for (const slm of Object.values(slMap)) {
    if (slm.matched) continue;
    const base = { sport: slm.sport, player: slm.player, team: slm.team, market: slm.market, line: slm.line, startTime: slm.startTime, matchTitle: slm.matchTitle, gameId: slm.gameId, matchTag: slm.matchTag };
    const g = marketize(base, await getModelPred(base), [slQuote(slm)]);
    picks.push(assemble(base, g.modelPred, g.predSource, g.manualKey, null, 'sl', g, slm));
  }

  if (implausibleLines.length) {
    esportsCache.implausible = implausibleLines.slice(0, 20);
    console.warn(`Esports: ${implausibleLines.length} lines skipped as implausible (market string may be parsed wrong) e.g. ${implausibleLines[0]}`);
  } else esportsCache.implausible = [];
  esportsCache.spanInferred = spanCounts.inferred;
  esportsCache.contextCounts = contextCounts;
  esportsCache.priceMismatches = priceMismatches;
  esportsCache.closedSides = closedSides;
  esportsCache.marketCounts = marketCounts;
  if (priceMismatches) console.log(`Esports: ${priceMismatches} book prices withheld — our fair sat more than 10 points above the book's implied chance`);
  if (spanCounts.inferred) console.log(`Esports: ${spanCounts.inferred} picks rescaled — line implied a longer map span than the market label claimed`);

  // Pinnacle's team kills against the books' five players (esmarket.teamKillBudget):
  // measured and tracked (byPinTeam), not priced until the record says so
  esportsCache.pinTeams = 0;
  try {
    const pinMatches = (esportsBoard.state.matches || []).filter(m => m.pinTeamKills && !m.live);
    const fam = p => { const s = trackerSportKey(p.sport); return s === 'LOL' || s === 'DOTA' ? s : null; };
    const sides = new Map();
    const sideOf = p => {
      if (sides.has(p)) return sides.get(p);
      // the pick's own match: its opponent (PrizePicks' "ENCE MAP 1" too), or the nearest start (esmatch.js)
      const g = fam(p);
      const hit = g ? esmatch.sideFor(pinMatches.filter(m => m.game === g), p) : null;
      sides.set(p, hit);
      return hit;
    };
    if (pinMatches.length) {
      esportsCache.pinTeams = esmarket.teamKillBudget(picks, {
        perMap: p => (fam(p) && normalizeMarket(p.market).split('|')[0] === 'k' && p.marketPred != null ? (p.matchup?.baseMean ?? p.marketPred) / parseMapCount(p.market) : null),
        teamOf: p => { const s = sideOf(p); return s ? `${s.m.id}|${s.i}` : null; },
        pinFor: p => {
          const s = sideOf(p);
          const v = spanToMapList(parseMapSpan(p.market).label, parseMapCount(p.market)).map(n => s?.m.pinTeamKills[n]?.[s.i]).filter(x => x > 0);
          return v.length ? v.reduce((a, x) => a + x, 0) / v.length : null;
        },
      });
      const gaps = pingap.gapPlays(picks, { mapsOf: p => spanToMapList(parseMapSpan(p.market).label, parseMapCount(p.market)) });
      esportsCache.pinGapPlays = gaps.length;
      if (gaps.length) pinGapTracker.recordBoard(gaps).catch(e => console.warn('Pin gap tracker:', e.message));
      priceKillShares(picks, { fam, sideOf });
      for (const p of picks) if (p.pinTeam) {
        const f = p.pinTeam.factor;
        p.statLine = [p.statLine, `Pinnacle team kills ${p.pinTeam.pin.toFixed(1)} a map vs the books' ${p.pinTeam.books.toFixed(1)} (x${f.toFixed(2)})`].filter(Boolean).join(' · ');
      }
    }
  } catch (e) { console.warn('Esports: Pinnacle team kills skipped:', e.message); }
  try { priceRoundKills(picks); } catch (e) { console.warn('Esports: round model skipped:', e.message); }
  try { priceH2HKills(picks); } catch (e) { console.warn('Esports: head-to-head model skipped:', e.message); }
  try { attachLinesFair(picks); } catch (e) { console.warn('Esports: Lines fair for slips skipped:', e.message); }

  // Line gaps: the book a pick is played at sits on the soft side of another
  // book's line (PP Over 1.5 where Underdog and Sleeper hang 3.5). Worth
  // GAP_MIN_PTS points of win chance on the consensus or it's just noise.
  for (const p of picks) {
    if (!p.side || p.bestBook == null || p.marketPred == null) continue;
    const g = esgaps.lineGap(p, l => marketFairProb(p, l, p.side, pickCtx.get(p)), { minProbPts: GAP_MIN_PTS });
    if (g) p.lineGap = g;
  }

  // Matchup-led plays: +EV only because the matchup moved the number. The
  // matchup's weight is a prior until graded picks set it, so these stay on
  // the board (and in the record, BY MATCHUP) but leave Best Plays and alerts
  // until matchup-moved picks beat the close: MATCHUP_PROVEN_N moves, half or
  // more our way.
  let matchupProven = false, gapRecord = null;
  try {
    const sum = await tracker.summary();
    const mm = sum.byMatchup?.['matchup-led (no edge without it)'];
    matchupProven = !!mm && mm.mktMoved >= MATCHUP_PROVEN_N && mm.mktBeatShare >= 0.5;
    gapRecord = sum.byGap?.['line gap'] || null;
  } catch { /* unproven */ }
  esportsCache.matchupProven = matchupProven;
  for (const p of picks) {
    const m = p.matchup;
    if (!m || m.baseMean == null || !p.side || !(p.bestEv > 0) || !(p.prob > 0) || p.ppLine == null) continue;
    const at = mean => marketFairProb({ ...p, marketPred: mean }, p.ppLine, p.side, pickCtx.get(p));
    const withMu = at(p.modelPred), without = at(m.baseMean);
    if (withMu == null || without == null) continue;
    const d = (p.bestEv / 100 + 1) / (p.prob / 100);
    const evWithout = p.bestEv - (withMu - without) * d * 100;
    if (evWithout <= 0) { p.matchupLed = +evWithout.toFixed(2); if (!matchupProven) p.clvWarn = true; }
  }

  // Closing-line value by kind of pick (sport, stat, book, side): each play
  // carries how its kind's signals have done against the close. A kind whose
  // signals keep losing the close (CLV_WARN_N moves, under CLV_WARN_SHARE our
  // way) stays on the board but leaves Best Plays and alerts.
  try {
    const kinds = await tracker.clvByKind();
    for (const p of picks) {
      if (!p.side) continue;
      // a line gap is judged on the gaps' own record against the close, not
      // on its sport and stat's: a book off the others is a different bet
      if (p.lineGap) {
        const k = gapRecord;
        if (k && k.mktClvSample) {
          p.clvRecord = { n: k.mktClvSample, moved: k.mktMoved, beat: k.mktBeat, share: k.mktBeatShare, closeEv: k.closeEvAvg, gap: true };
          if (k.mktMoved >= CLV_WARN_N && k.mktBeatShare < CLV_WARN_SHARE) p.clvWarn = true;
        }
        continue;
      }
      const k = kinds[clvKind(p)];
      if (!k || !k.mktClvSample) continue;
      p.clvRecord = { n: k.mktClvSample, moved: k.mktMoved, beat: k.mktBeat, share: k.mktBeatShare, closeEv: k.closeEvAvg };
      if (k.mktMoved >= CLV_WARN_N && k.mktBeatShare < CLV_WARN_SHARE) p.clvWarn = true;
    }
  } catch (e) { console.warn('Esports: CLV by kind unavailable:', e.message); }

  picks.sort((a, b) => (b.bestEv ?? -999) - (a.bestEv ?? -999));
  esportsCache.picks = picks;
  esportsCache.lastUpdated = new Date().toISOString();
  esSlipLog.follow(picks).catch(e => console.warn('Esports slip legs:', e.message));
  try { observeEsStale(picks); } catch (e) { esStaleState.errors = [e.message, ...esStaleState.errors].slice(0, 5); console.warn('Esports stale lines:', e.message); }
  tracker.recordBoard(picks).catch(e => console.warn('Tracker: recordBoard failed:', e.message));
  try { const built = autoSlips(picks, pick6SlipOpts(picks)); slipTracker.record([...built.slips, ...(built.stacks || [])]).catch(e => console.warn('Slip tracker: record failed:', e.message)); }
  catch (e) { console.warn('Slip tracker: build failed:', e.message); }
  slipTracker.follow(stackLegLookup(picks)).catch(e => console.warn('Slip tracker: follow failed:', e.message));
  alerter.onBoard(picks.filter(p => !p.clvWarn)).catch(e => console.warn('Alerts: failed:', e.message));
  console.log(`Esports: generated ${picks.length} picks (${picks.filter(p => p.lineSource === 'ud').length} UD-sourced, ${picks.filter(p => p.lineSource === 'sl').length} Sleeper-sourced, ${picks.filter(p => p.sleeperEv != null).length} Sleeper-priced, ${picks.filter(p => p.predSource === 'manual').length} manual, ${picks.filter(p => p.modelPred == null).length} need model input)`);
  return picks;
}

// ─── KILL-SHARE MODEL (sharemodel.js) ─────────────────────────────────────────
// Each LoL and Dota kills line where Pinnacle prices the team's kills on the
// maps it covers: the player's mean is Pinnacle's team total × his share of
// the team's kills (his kills a game over the five board players'), priced at
// every app's own line and payout. Rows show on the PROPS Lines table as the
// model line; cleared plays go to their own record (esportsShare).
const sharemodel = require('./sharemodel');
const SHARE_OPTS = { minEv: parseFloat(process.env.SHARE_MIN_EV || String(sharemodel.DEFAULTS.minEv)), agreePts: parseFloat(process.env.SHARE_AGREE_PTS || String(sharemodel.DEFAULTS.agreePts)) };
const SHARE_ON = !/^(off|0|false|no)$/i.test(String(process.env.ESPORTS_SHARE || '').trim());
// a player's kills a game and games behind it, from the stats we already pull
function shareRate(p, game) {
  if (game === 'LOL') { const lp = lolPlayer(p.player); return lp ? { rate: lp.kpg, games: lp.games } : null; }
  const c = dotaCache.players[vlrKey(p.player)];
  return c && !c.failed && c.pro !== false ? { rate: c.avgKillsPerMap, games: c.mapsPlayed } : null;
}
// A series' length for a pick: the sharp board's match (Pinnacle or the
// exchanges named it) first, then the pick's context unless that was a guess.
// null when nobody says, which prices only the maps every series plays.
function seriesBestOf(m, p) {
  if (m?.bestOf > 0) return m.bestOf;
  return p.context && p.context.source !== 'even' ? p.context.bestOf || null : null;
}
function priceKillShares(picks, { fam, sideOf }) {
  const st = { teams: 0, unknownLineup: 0, priced: 0, clear: 0, byGame: {} };
  esportsCache.share = st;
  if (!SHARE_ON) return st;
  const kills = picks.filter(p => fam(p) && normalizeMarket(p.market).split('|')[0] === 'k' && sideOf(p));
  const teams = new Map();
  for (const p of kills) {
    const s = sideOf(p), tk = `${s.m.id}|${s.i}`, nk = String(p.player || '').toLowerCase();
    const g = teams.get(tk) || teams.set(tk, new Map()).get(tk);
    if (!g.has(nk)) { const r = shareRate(p, fam(p)); g.set(nk, { key: nk, rate: r?.rate || 0, games: r?.games || 0 }); }
  }
  const shares = new Map();
  for (const [tk, g] of teams) {
    const sh = sharemodel.teamShares([...g.values()]);
    if (sh) { shares.set(tk, sh); st.teams++; } else st.unknownLineup++;
  }
  const plays = [];
  for (const p of kills) {
    const s = sideOf(p), game = fam(p);
    const sh = shares.get(`${s.m.id}|${s.i}`)?.get(String(p.player || '').toLowerCase());
    const maps = spanToMapList(parseMapSpan(p.market).label, parseMapCount(p.market));
    // the series length: Pinnacle's (a map-4 price or a 3.5-map total means a
    // Bo5) over the pick's own context, which guesses Bo3 when no match price
    // names the opponent ("C9 | KC MAPS 1-3" is a Bo5 at Worlds)
    const bestOf = seriesBestOf(s.m, p);
    if (!sh || !pingap.spanIsCertain(maps, bestOf)) continue;
    if (game === 'LOL' && sh.share < sharemodel.DEFAULTS.lolMinShare) { st.supports = (st.supports || 0) + 1; continue; }
    const have = maps.map(n => s.m.pinTeamKills[n]?.[s.i]).filter(x => x > 0);
    if (!have.length) continue;
    // a map Pinnacle hasn't posted yet takes the average of the ones it has
    const avg = have.reduce((a, x) => a + x, 0) / have.length;
    const pinPerMap = maps.map(n => s.m.pinTeamKills[n]?.[s.i] > 0 ? s.m.pinTeamKills[n][s.i] : avg);
    const mean = sharemodel.shareMean(pinPerMap, sh.share);
    if (!mean) continue;
    const base = p.matchup?.baseMean ?? p.marketPred;
    p.share = { mean, pinMean: p.pinTeam && base > 0 ? +(base * p.pinTeam.factor).toFixed(2) : null, share: sh.share, raw: sh.raw, games: sh.games,
      pinPerMap: pinPerMap.map(x => +x.toFixed(1)), maps: maps.length, game, bestOf };
    // the team kill spread: fitted from Pinnacle's graded totals once there are enough, else assumed
    const sd = fittedTeamSd(game);
    const ctx = { game, share: sh.share, maps: maps.length, ...(sd ? { o: { teamSd: sd } } : {}) };
    const fairAt = (m, line, side) => sharemodel.shareProb(m, line, side, ctx);
    const priced = sharemodel.priceShare(p, { fairAt, books: appBooksFor(p), o: SHARE_OPTS });
    if (!priced) continue;
    p.share.priced = priced;
    st.priced++;
    st.byGame[game] = (st.byGame[game] || 0) + 1;
    if (priced.clears) st.clear++;
    const play = sharemodel.sharePlay(p, priced);
    if (play) plays.push(play);
  }
  // each player's share, for BetRivers' per-map player kill ladders (runEsBooksScreen)
  const index = new Map();
  for (const p of kills) {
    const s = sideOf(p), game = fam(p);
    const sh = shares.get(`${s.m.id}|${s.i}`)?.get(String(p.player || '').toLowerCase());
    const k = `${game}|${normalizeName(p.player)}`;
    if (!sh || (game === 'LOL' && sh.share < sharemodel.DEFAULTS.lolMinShare)) continue;
    const e = index.get(k) || { share: sh.share, teamName: s.m.teams[s.i], start: Date.parse(s.m.start) || null,
      pinByMap: Object.fromEntries(Object.entries(s.m.pinTeamKills).map(([n, v]) => [n, v?.[s.i]]).filter(([, v]) => v > 0)), booksPerMap: null };
    const base = p.matchup?.baseMean ?? p.marketPred;
    if (e.booksPerMap == null && p.pinTeam && base > 0) e.booksPerMap = +(base / parseMapCount(p.market) * p.pinTeam.factor).toFixed(2);
    index.set(k, e);
  }
  esportsCache.shareIndex = index;
  if (plays.length) shareTracker.recordBoard(plays).catch(e => console.warn('Share tracker:', e.message));
  if (st.priced) console.log(`Kill share: ${st.teams} teams, ${st.priced} lines priced, ${st.clear} clear (${st.unknownLineup} teams with an unknown lineup)`);
  return st;
}

// ─── ROUND MODEL (roundmodel.js) ──────────────────────────────────────────────
// CS2 and Valorant kills lines where Pinnacle prices the rounds on the maps a
// line covers: the player's kills a round (bo3.gg, vlr.gg) on Pinnacle's
// rounds for each map, priced at every app's own line and payout. Same PIN
// tag on the PROPS Lines table; cleared plays go to their own record
// (esportsRounds). ESPORTS_ROUNDS=off stops it.
const roundmodel = require('./roundmodel');
const ROUNDS_OPTS = { minEv: parseFloat(process.env.ROUNDS_MIN_EV || String(roundmodel.DEFAULTS.minEv)), agreePts: parseFloat(process.env.ROUNDS_AGREE_PTS || String(roundmodel.DEFAULTS.agreePts)) };
const ROUNDS_ON = !/^(off|0|false|no)$/i.test(String(process.env.ESPORTS_ROUNDS || '').trim());
// a player's kills a round and maps behind it, from the profiles we already pull
function roundRate(p, game) {
  if (game === 'CS2') {
    const c = esportsCache.hltvPlayers[String(p.player || '').toLowerCase()];
    // bo3's maps counter can be a match counter; the kills a round can't be wrong
    return c && !c.failed && c.kpr ? { raw: c.kpr, maps: c.mapsPlayed || 0 } : null;
  }
  const t = vlrTable.players[vlrKey(p.player)] || vlrTable.players[vlrKey(String(p.player || '').split(/\s+/).pop())];
  if (t?.kpr) return { raw: t.kpr, maps: t.rounds ? Math.round(t.rounds / 22) : 0 };
  const v = vlrStats.cache.get(nameKey(p.player))?.stats;
  return v?.kpr ? { raw: v.kpr, maps: v.maps || 0 } : null;
}
function priceRoundKills(picks) {
  const st = { matches: 0, teams: 0, unknownLineup: 0, priced: 0, clear: 0, byGame: {}, noRounds: 0, fits: [] };
  esportsCache.rounds = st;
  if (!ROUNDS_ON) return st;
  const pin = esBooksState.pin || [];
  const fam = p => { const g = roundmodel.gameOf(trackerSportKey(p.sport)); return g && normalizeMarket(p.market).split('|')[0] === 'k' ? g : null; };
  const cands = picks.filter(fam);
  if (!cands.length || !pin.length) return st;
  const sides = new Map();
  const sideOf = p => {
    if (sides.has(p)) return sides.get(p);
    const g = fam(p);
    const hit = esmatch.sideFor(pin.filter(m => m.game === g), p, { startOf: m => m.start || NaN });
    sides.set(p, hit);
    return hit;
  };
  // each Pinnacle match's maps: team 0's q0 and expected rounds off its round ladders
  const fits = new Map();
  const fitOf = m => {
    if (fits.has(m.id)) return fits.get(m.id);
    const f = {};
    const k = fittedKappa(m.game), ro = k ? { ...roundmodel.DEFAULTS, kappa: { ...roundmodel.DEFAULTS.kappa, [m.game]: k } } : roundmodel.DEFAULTS;
    for (let n = 1; n <= 5; n++) { const x = roundmodel.fitMap(m.ladders, n, m.game, ro); if (x) f[n] = x; }
    fits.set(m.id, f);
    if (Object.keys(f).length) st.fits.push({ match: `${m.teams[0]} vs ${m.teams[1]}`, game: m.game, maps: f });
    return f;
  };
  // a team's lineup is known when five of its players on the board have a rate
  const teams = new Map();
  for (const p of cands) {
    const s = sideOf(p);
    if (!s) continue;
    const tk = `${s.m.id}|${s.i}`, nk = String(p.player || '').toLowerCase();
    const g = teams.get(tk) || teams.set(tk, new Map()).get(tk);
    if (!g.has(nk)) { const r = roundRate(p, fam(p)); g.set(nk, r ? roundmodel.playerRate(r.raw, r.maps, fam(p)) : null); }
  }
  for (const g of teams.values()) { if ([...g.values()].filter(Boolean).length >= roundmodel.DEFAULTS.need) st.teams++; else st.unknownLineup++; }
  // with both lineups known, the ten rates are scaled to the game's kills a round
  const scaleOf = new Map();
  const rates = tk => [...(teams.get(tk)?.values() || [])].filter(Boolean).map(r => r.kpr);
  const scaleFor = (m, game) => {
    if (!scaleOf.has(m.id)) scaleOf.set(m.id, roundmodel.matchScale(rates(`${m.id}|0`), rates(`${m.id}|1`), game));
    return scaleOf.get(m.id);
  };
  const plays = [];
  for (const p of cands) {
    const s = sideOf(p), game = fam(p);
    if (!s) continue;
    const rate = teams.get(`${s.m.id}|${s.i}`)?.get(String(p.player || '').toLowerCase());
    const maps = spanToMapList(parseMapSpan(p.market).label, parseMapCount(p.market));
    if (!rate || !pingap.spanIsCertain(maps, seriesBestOf(s.m, p))) continue;
    const f = fitOf(s.m);
    const have = Object.values(f);
    if (!have.length) { st.noRounds++; continue; }
    // a map Pinnacle hasn't posted rounds for takes the average of the ones it has
    const avgQ = have.reduce((a, x) => a + x.q, 0) / have.length;
    const q0 = maps.map(n => f[n]?.q ?? avgQ);
    const qs = q0.map(q => +(s.i === 0 ? q : 1 - q).toFixed(4));
    const scale = scaleFor(s.m, game);
    const kap = fittedKappa(game);
    const ctx = { game, kpr: +(rate.kpr * (scale ?? 1)).toFixed(4), qs, ...(kap ? { kappa: kap } : {}) };
    const mean = +roundmodel.pmfMean(roundmodel.killsPmf(ctx)).toFixed(2);
    const base = p.matchup?.baseMean ?? p.marketPred;
    const avgR = roundmodel.DEFAULTS.avgRounds[game];
    // known only when both teams are: the scale needs all ten
    const lineup = scale != null ? 'known' : 'unknown';
    p.rounds = { mean, ctx, lineup, kpr: ctx.kpr, raw: rate.raw, maps: rate.maps, scale, game,
      roundsPerMap: maps.map(n => f[n]?.rounds ?? +(have.reduce((a, x) => a + x.rounds, 0) / have.length).toFixed(1)),
      pinCtx: base > 0 ? { game, kpr: +(base / (avgR * maps.length)).toFixed(4), qs, ...(kap ? { kappa: kap } : {}) } : null };
    p.rounds.pinMean = p.rounds.pinCtx ? +roundmodel.pmfMean(roundmodel.killsPmf(p.rounds.pinCtx)).toFixed(2) : null;
    const lines = esgaps.bookLines(p);
    const ud = p.udSides || {}, sl = p.slSides || {};
    const books = [];
    if (lines.PP != null) books.push({ book: 'PP', line: lines.PP, evAt: prob => calcBookEV(prob, 'pp') });
    if (lines.UD != null) books.push({ book: 'UD', line: lines.UD, open: { OVER: ud.overOpen !== false, UNDER: ud.underOpen !== false },
      evAt: (prob, side) => udPricing(prob, (side === 'OVER' ? ud.over : ud.under) || 1, side === 'OVER' ? ud.under : ud.over).ev });
    if (lines.SL != null && (sl.over || sl.under)) books.push({ book: 'SL', line: lines.SL, open: { OVER: sl.overOpen !== false && !!sl.over, UNDER: sl.underOpen !== false && !!sl.under },
      evAt: (prob, side) => sleeperPricing(prob, side === 'OVER' ? sl.over : sl.under, side === 'OVER' ? sl.under : sl.over).ev });
    const priced = roundmodel.priceRounds(p, { books, o: ROUNDS_OPTS });
    if (!priced) continue;
    p.rounds.priced = priced;
    st.priced++;
    st.byGame[game] = (st.byGame[game] || 0) + 1;
    if (priced.clears) st.clear++;
    const play = roundmodel.roundsPlay(p, priced);
    if (play) plays.push(play);
  }
  st.matches = fits.size;
  st.fits = st.fits.slice(0, 30);
  if (plays.length) roundsTracker.recordBoard(plays).catch(e => console.warn('Rounds tracker:', e.message));
  if (st.priced) console.log(`Round model: ${st.matches} matches, ${st.priced} lines priced, ${st.clear} clear (${st.unknownLineup} teams with an unknown lineup)`);
  return st;
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
      esPicksRebuild().catch(() => {});
    }
  } finally { warmer.running = false; }
}

// ─── PICK TRACKER ─────────────────────────────────────────────────────────────
// Every signaled pick is recorded, frozen at kickoff, and graded from results.
// Storage: Postgres when DATABASE_URL is set (use this on Railway), otherwise
// a JSON file at TRACKER_FILE (default ./data/esports-picks.json).
const { createTracker, createStoreFromEnv } = require('./tracker');
const { autoSlips, priceOnBooks, bookLeg: slipBookLeg, stackLegLookup } = require('./slipbuild');
// DK Pick6's esports cells for the Best Slips builder: the props board's Pick6 cell
// for each esports pick it prices (a Pinnacle-based twin cell on the same number,
// at Pick6's own payout). Empty unless PICK6=on and Pick6's esports lines are read,
// so with Pick6 off the builder has three books and nothing on the page changes.
function pick6SlipOpts(picks) {
  if (!PICK6_ON) return {};
  try {
    const { rows } = propsBoardRows();
    const byKey = new Map(rows.filter(r => r.esports && r.books.pick6?.ev).map(r => [r.key, r.books.pick6]));
    const cells = new Map();
    for (const p of picks || []) {
      const sport = propsBoard.boardSport(p.sport).sport;
      const c = byKey.get(`${sport}|${evScreen.canonName(p.player)}|${normalizeMarket(p.market)}${p.matchTag ? `|${p.matchTag}` : ''}`);
      if (c) cells.set(p, c);
    }
    return cells.size ? { pick6: cells, pick6Table: pick6.state.payouts || null } : {};
  } catch (e) { console.warn('Best slips: Pick6 cells skipped:', e.message); return {}; }
}
const { createLoLGrader, createLoLesportsGrader, createLoLGraderChain, createDotaGrader, createCsGrader, createValGrader } = require('./graders');

async function dotaAccountId(playerName) {
  const dir = await dotaLoadProPlayers();
  return dir[vlrKey(playerName)] || dir[vlrKey((playerName || '').split(/\s+/).pop())] || null;
}

const tracker = createTracker({
  store: resultsBackup.wrap('esportsPicks', createStoreFromEnv()),
  graders: {
    LOL: createLoLGraderChain(createLoLesportsGrader(axios), createLoLGrader(axios)), DOTA: createDotaGrader(axios, dotaAccountId), CS: createCsGrader(axios),
    // Valorant from vlr.gg's match pages, PandaScore after it when a token is set
    VAL: createLoLGraderChain(createValGrader(axios), ...(panda ? [panda.grader('VAL')] : [])),
    ...(panda ? { COD: panda.grader('COD') } : {}),
  },
  normalizeName, normalizeMarket, parseMapSpan, fairProb: marketFairProb,
});
// every +EV Best Slip, graded from the same match stats (sliptrack.js)
const slipTracker = require('./sliptrack').createSlipTracker({
  store: resultsBackup.wrap('esportsSlips', createEvStoreFromEnv(process.env, { table: 'esports_slips', fileVar: 'SLIP_TRACK_FILE', file: 'esports-slips.json' })),
  graders: tracker.graders, parseMapSpan,
  keyFor: leg => tracker.pickId(leg),
  lookup: async () => new Map((await tracker.list({ status: 'graded', limit: 1e6 })).filter(r => r.result != null).map(r => [r.id, r.result])),
});
slipTracker.ready().catch(e => console.error('Slip tracker: store failed to initialise:', e.message));
// Pinnacle team kill gaps (pingap.js): every player on a team where Pinnacle's
// team kills and the books' five players part by 3%+, played on Pinnacle's
// side and graded in their own record. Tested, not priced or alerted.
const pingap = require('./pingap');
const { createFileStore: createPickFileStore } = require('./tracker');
// ─── HEAD-TO-HEAD KILL MODEL (h2hmodel.js, h2hdata.js) ───────────────────────
// Our own fair for every LoL, Dota, CS2 and Valorant kills line, no Pinnacle
// number needed: his share of his team's kills × the kills his team makes
// against this opponent (each team's pace for and against, from gol.gg's
// season tables, OpenDota's pro and qualifier games, bo3.gg's maps down to
// tier c and vlr.gg's match pages), over the maps the line covers. A leg clears only where a Pinnacle-based fair (the kill-share model)
// puts the same side past the app's break-even too; the rest show the model's
// fair on the PROPS Lines table and go to their own record, never a play.
// ESPORTS_H2H=off turns it off; it's never alerted.
const h2hmodel = require('./h2hmodel');
const h2hdata = require('./h2hdata');
const H2H_ON = !/^(off|0|false|no)$/i.test(String(process.env.ESPORTS_H2H || '').trim());
const H2H_OPTS = { minEv: parseFloat(process.env.H2H_MIN_EV || String(h2hmodel.DEFAULTS.minEv)), agreePts: parseFloat(process.env.H2H_AGREE_PTS || String(h2hmodel.DEFAULTS.agreePts)) };
const H2H_DIR = process.env.LR_DATA_DIR || path.join(__dirname, 'data');
// v: the seed's data version. v2 added bo3.gg's tier c (CS2), OpenDota's
// qualifier leagues (Dota) and Valorant, so a saved state from v1 gives way
const H2H_STORES = { CS: { hl: 30, unit: 'round', pace: 3.4, v: 2 }, DOTA: { hl: 40, unit: 'game', pace: 28, v: 2 }, VAL: { hl: 30, unit: 'round', pace: 3.47, rounds: 21, v: 2 } };
const h2hState = { stores: {}, gol: null, golAt: null, refreshedAt: {}, added: {}, errors: {}, running: false };
for (const [title, c] of Object.entries(H2H_STORES)) {
  const file = n => path.join(n, `h2h-${title.toLowerCase()}.json.gz`);
  // the saved state or the seed that ships with the code: the higher data
  // version, then the newer
  const saved = h2hdata.loadStore(file(H2H_DIR)), seed = h2hdata.loadStore(file(path.join(__dirname, 'seeds')));
  h2hState.stores[title] = [saved, seed].filter(Boolean).sort((a, b) => (b.state.v || 1) - (a.state.v || 1) || b.state.lastT - a.state.lastT)[0]
    || h2hdata.createStore({ title, hl: c.hl, unit: c.unit, pace0: c.pace, rounds: c.rounds, v: c.v });
}
// new games since each store's last one (bo3.gg, OpenDota, vlr.gg) and
// gol.gg's team table; every 30 minutes, the team table every 6 hours
async function refreshH2H({ http = axios, now = Date.now() } = {}) {
  if (!H2H_ON || h2hState.running) return h2hState;
  h2hState.running = true;
  try {
    for (const [title, fetch] of [['CS', h2hdata.fetchCsMaps], ['DOTA', h2hdata.fetchDotaMaps], ['VAL', h2hdata.fetchValMaps]]) {
      const store = h2hState.stores[title];
      try {
        const maps = await fetch(http, { since: store.state.lastT, seen: store.state.seen });
        let n = 0;
        for (const m of maps) if (store.ingest(m)) n++;
        if (n) { store.prune(150); h2hdata.saveStore(store, path.join(H2H_DIR, `h2h-${title.toLowerCase()}.json.gz`)); }
        h2hState.added[title] = n;
        h2hState.refreshedAt[title] = new Date(now).toISOString();
        h2hState.errors[title] = null;
      } catch (e) { h2hState.errors[title] = e.response?.status ? `HTTP ${e.response.status}` : e.message; }
    }
    if (!h2hState.golAt || now - Date.parse(h2hState.golAt) > 6 * 3600e3) {
      try { h2hState.gol = await h2hdata.fetchGolTeams(http, { season: golSeason(now) }); h2hState.golAt = new Date(now).toISOString(); h2hState.errors.LOL = null; }
      catch (e) { h2hState.errors.LOL = e.response?.status ? `HTTP ${e.response.status}` : e.message; }
    }
  } finally { h2hState.running = false; }
  return h2hState;
}
// the other team: the board's matchup, the "A vs B" title, or PrizePicks'
// "OPP MAPS 1-3"
function h2hOpponent(p) {
  return p.context?.opponent || opponentFrom(p.team, p.matchTitle, null) || /^(.+?)\s+MAPS?\s/i.exec(String(p.matchTitle || ''))?.[1]?.trim() || null;
}
// each app's line on a pick, with its payouts, for pricing either side
function appBooksFor(p) {
  const lines = esgaps.bookLines(p);
  const ud = p.udSides || {}, sl = p.slSides || {};
  const books = [];
  if (lines.PP != null) books.push({ book: 'PP', line: lines.PP, evAt: prob => calcBookEV(prob, 'pp') });
  if (lines.UD != null) books.push({ book: 'UD', line: lines.UD, open: { OVER: ud.overOpen !== false, UNDER: ud.underOpen !== false },
    evAt: (prob, side) => udPricing(prob, (side === 'OVER' ? ud.over : ud.under) || 1, side === 'OVER' ? ud.under : ud.over).ev });
  if (lines.SL != null && (sl.over || sl.under)) books.push({ book: 'SL', line: lines.SL, open: { OVER: sl.overOpen !== false && !!sl.over, UNDER: sl.underOpen !== false && !!sl.under },
    evAt: (prob, side) => sleeperPricing(prob, side === 'OVER' ? sl.over : sl.under, side === 'OVER' ? sl.under : sl.over).ev });
  return books;
}
// PrizePicks names teams by code ("MVK", "BRO"), which can fit the wrong team
// ("MVK" is MVK Esports, not Movistar KOI). Another app's "A vs B" title for
// the same match, within two hours, gives both full names.
function h2hTitles(picks) {
  const out = [];
  for (const p of picks) {
    const sides = splitMatchTitle(p.matchTitle);
    if (sides) out.push({ sport: trackerSportKey(p.sport), sides, t: Date.parse(p.startTime || '') || 0 });
  }
  return out;
}
function h2hFullNames(game, team, opp, t, titles) {
  const fits = (full, n) => teamsMatch(full, n) || teamCode(full, n) || h2hdata.nameTier(full, n) > 0;
  for (const x of titles) {
    if (x.sport !== game || (t && x.t && Math.abs(x.t - t) > 2 * 3600e3)) continue;
    for (const [a, b] of [x.sides, [x.sides[1], x.sides[0]]]) if (fits(a, team) && fits(b, opp)) return [a, b];
  }
  return [team, opp];
}
// The model's inputs for one pick → p.h2h, or why not (counted in st.why)
function h2hInputs(p, game, team, opp) {
  if (game === 'LOL') {
    if (!h2hState.gol) return { why: 'no gol.gg table' };
    const lp = lolPlayer(p.player);
    const inp = h2hdata.golInputs(h2hState.gol, lp ? { kpg: lp.kpg, games: lp.games } : null, team, opp);
    if (inp.why) return inp;
    const sh = h2hmodel.playerShare('LOL', inp.rate, inp.games, inp.teamKpg);
    if (!sh) return { why: 'share' };
    if (sh.share < h2hmodel.TITLES.LOL.minShare) return { why: 'support' };
    return { ...inp, share: sh.share };
  }
  const store = h2hState.stores[game];
  return store ? store.inputs(p.player, team, opp, { shareGames: h2hmodel.TITLES[game].shareGames }) : { why: 'title' };
}
function priceH2HKills(picks) {
  const st = { priced: 0, clear: 0, modelOnly: 0, byGame: {}, why: {}, stores: {}, coverage: {} };
  for (const [t, s] of Object.entries(h2hState.stores)) st.stores[t] = { maps: s.state.maps, players: Object.keys(s.state.players).length, through: s.state.lastT ? new Date(s.state.lastT).toISOString() : null };
  st.gol = h2hState.gol ? { teams: Object.keys(h2hState.gol).length, at: h2hState.golAt } : null;
  esportsCache.h2h = st;
  if (!H2H_ON) return st;
  const plays = [];
  // coverage: every app kill line by title and app, priced by this model, by
  // a Pinnacle-based one only (kill share, rounds) or by neither, and why not
  let why = null;
  const miss = w => { why = w; st.why[w] = (st.why[w] || 0) + 1; };
  const count = (p, game) => {
    const c = st.coverage[game] ||= { lines: 0, h2h: 0, pinOnly: 0, none: 0, apps: {}, why: {} };
    const h = !!p.h2h?.priced, pin = !!(p.share?.priced || p.rounds?.priced);
    for (const b of Object.keys(esgaps.bookLines(p))) {
      const a = c.apps[b] ||= { lines: 0, h2h: 0, pinOnly: 0, none: 0 };
      a.lines++; if (h) a.h2h++; else if (pin) a.pinOnly++; else a.none++;
    }
    c.lines++; if (h) c.h2h++; else if (pin) c.pinOnly++; else c.none++;
    if (why) c.why[why] = (c.why[why] || 0) + 1;
  };
  const titles = h2hTitles(picks);
  for (const p of picks) {
    const game = trackerSportKey(p.sport);
    if (!['LOL', 'DOTA', 'CS', 'VAL'].includes(game) || normalizeMarket(p.market).split('|')[0] !== 'k') continue;
    if (Date.parse(p.startTime || '') <= Date.now()) continue;
    why = null;
    priceH2HOne(p, game);
    count(p, game);
  }
  function priceH2HOne(p, game) {
    const opp = h2hOpponent(p);
    if (!opp) { miss('opponent'); return; }
    const [team, vs] = h2hFullNames(game, p.team, opp, Date.parse(p.startTime || ''), titles);
    const inp = h2hInputs(p, game, team, vs);
    if (inp.why) { miss(inp.why); return; }
    const maps = spanToMapList(parseMapSpan(p.market).label, parseMapCount(p.market));
    // the series length only from a real match price; a guessed one ('even')
    // prices maps 1-2 and nothing past them
    const bestOf = p.share?.bestOf || (p.context && p.context.source !== 'even' ? p.context.bestOf : (Math.max(...maps) <= 2 ? 3 : null));
    const scenarios = h2hmodel.scenariosFor(maps, bestOf, p.context?.pMap);
    if (!scenarios) { miss('maps'); return; }
    const teamKills = h2hmodel.teamKills(game, inp.pace, inp.team, inp.opp);
    const perMap = h2hmodel.mapMean(game, { share: inp.share, teamKillsPerMap: teamKills, own: inp.own, rounds: inp.rounds });
    if (!(perMap > 0)) { miss('mean'); return; }
    const expMaps = scenarios.reduce((a, x) => a + x.maps * x.weight, 0);
    p.h2h = { game, perMap: +perMap.toFixed(3), mean: +(perMap * expMaps).toFixed(2), scenarios, share: +inp.share.toFixed(4), own: +(inp.own * expMaps).toFixed(2),
      teamKills: +(teamKills * (inp.rounds || 1)).toFixed(2), team: inp.teamKey, opp: inp.oppKey, games: inp.games };
    // a Pinnacle-based fair at the same line: the kill-share model's (LoL,
    // Dota) or the round model's (CS2, Valorant)
    const sharp = p.share?.mean > 0 ? (line, side) => {
      const prob = sharemodel.shareProb(p.share.mean, line, side, { game: p.share.game, share: p.share.share, maps: p.share.maps });
      return prob > 0 ? { src: 'pinnacle kill share', prob } : null;
    } : p.rounds?.ctx ? (line, side) => {
      const prob = roundmodel.sideProb(p.rounds.ctx, line, side);
      return prob > 0 ? { src: 'pinnacle rounds', prob } : null;
    } : null;
    const priced = h2hmodel.priceH2H(p, { books: appBooksFor(p), sharp, o: H2H_OPTS });
    if (!priced) { miss('no line'); return; }
    p.h2h.priced = priced;
    st.priced++;
    st.byGame[game] = (st.byGame[game] || 0) + 1;
    if (priced.clears) st.clear++;
    else if (priced.ev >= H2H_OPTS.minEv) st.modelOnly++;
    const play = h2hmodel.h2hPlay(p, priced, H2H_OPTS);
    if (play) plays.push(play);
  }
  if (plays.length) h2hTracker.recordBoard(plays).catch(e => console.warn('H2H tracker:', e.message));
  if (st.priced) console.log(`H2H kills: ${st.priced} lines priced (${JSON.stringify(st.byGame)}), ${st.clear} clear with a sharp price, ${st.modelOnly} model-only at +${H2H_OPTS.minEv}%`);
  return st;
}

// The fair the PROPS Lines table shows at each app's line (propsboard.priceRows):
// kill share or rounds where they price the pick, the head-to-head model over
// them for the books it prices. Best Slips and the slip bar build on it
// (slipbuild.bookLeg), so a slip never takes a side the Lines table argues
// against. Both sides are kept: a half line's other side is 1 - p.
function attachLinesFair(picks) {
  const rnd = x => Math.round(x * 100) / 100;
  for (const p of picks) {
    if (!p.pricing) continue;
    const pin = p.share?.priced?.cells || p.rounds?.priced?.cells || null;
    const h2h = p.h2h?.priced?.cells || null;
    if (!pin && !h2h) continue;
    const ud = p.udSides || {}, sl = p.slSides || {};
    const books = {};
    for (const b of appBooksFor(p)) {
      const cell = h2h?.[b.book] || pin?.[b.book];
      if (!cell) continue;
      const src = h2h?.[b.book] ? 'h2h' : p.share?.priced ? 'share' : 'rounds';
      const sides = {};
      for (const side of ['OVER', 'UNDER']) {
        if (b.open && b.open[side] === false) continue;
        const prob = side === cell.side ? cell.prob / 100 : Math.abs(cell.line % 1) === 0.5 ? 1 - cell.prob / 100 : null;
        if (!(prob > 0 && prob < 1)) continue;
        const ev = side === cell.side ? cell.ev : b.evAt(prob, side);
        if (ev == null || !Number.isFinite(ev)) continue;
        const q = { prob, ev: rnd(ev) };
        if (b.book === 'UD') {
          const m = parseFloat(side === 'OVER' ? ud.over : ud.under) || 1, o = parseFloat(side === 'OVER' ? ud.under : ud.over);
          q.mult = m;
          q.decimal = m > UD_DECIMAL_THRESHOLD && !(o > 0 && o < 1);
        } else if (b.book === 'SL') q.mult = side === 'OVER' ? sl.over : sl.under;
        sides[side] = q;
      }
      books[b.book] = { src, line: cell.line, side: cell.side, clears: !!cell.clears, sides };
    }
    // the Lines table shows no market price on a row kill share or rounds took
    p.pricing.lines = { books, marketOk: !pin };
  }
}

const pinGapTracker = createTracker({
  store: resultsBackup.wrap('esportsPinGaps', createPickFileStore(process.env.PIN_GAP_FILE || path.join(process.env.LR_DATA_DIR || path.join(__dirname, 'data'), 'esports-pin-gaps.json'))),
  graders: tracker.graders, normalizeName, normalizeMarket, parseMapSpan,
});
pinGapTracker.ready().catch(e => console.error('Pin gap tracker: store failed to initialise:', e.message));
// Kill-share plays (sharemodel.js): Pinnacle's team kills × the player's share,
// graded in their own record, the close priced on the share at lock
const shareTracker = createTracker({
  store: resultsBackup.wrap('esportsShare', createPickFileStore(process.env.SHARE_FILE || path.join(process.env.LR_DATA_DIR || path.join(__dirname, 'data'), 'esports-share.json'))),
  graders: tracker.graders, normalizeName, normalizeMarket, parseMapSpan, minEv: 0,
  fairProb: (p, line, side) => (p.shareCtx && p.marketPred > 0 ? sharemodel.shareProb(p.marketPred, line, side, p.shareCtx) : null),
});
shareTracker.ready().catch(e => console.error('Share tracker: store failed to initialise:', e.message));
// Round-model plays (roundmodel.js): the player's kills a round on Pinnacle's
// rounds, graded in their own record, the close priced on the same model at lock
const roundsTracker = createTracker({
  store: resultsBackup.wrap('esportsRounds', createPickFileStore(process.env.ROUNDS_FILE || path.join(process.env.LR_DATA_DIR || path.join(__dirname, 'data'), 'esports-rounds.json'))),
  graders: tracker.graders, normalizeName, normalizeMarket, parseMapSpan, minEv: 0,
  fairProb: (p, line, side) => (p.roundsCtx ? roundmodel.sideProb(p.roundsCtx, line, side) : null),
});
roundsTracker.ready().catch(e => console.error('Rounds tracker: store failed to initialise:', e.message));
// Head-to-head plays (h2hmodel.js): every leg the model puts past minEv, the
// ones a sharp price backed marked fair 'h2h-sharp'; the close priced on the model
const h2hTracker = createTracker({
  store: resultsBackup.wrap('esportsH2H', createPickFileStore(process.env.H2H_FILE || path.join(process.env.LR_DATA_DIR || path.join(__dirname, 'data'), 'esports-h2h.json'))),
  graders: tracker.graders, normalizeName, normalizeMarket, parseMapSpan, minEv: 0,
  fairProb: (p, line, side) => (p.h2hCtx && p.marketPred > 0 ? h2hmodel.h2hProb(p.h2hCtx.game, p.marketPred, line, side, p.h2hCtx.scenarios) : null),
});
h2hTracker.ready().catch(e => console.error('H2H tracker: store failed to initialise:', e.message));

// ── ESPORTS STALE LINES (esstale.js) ──
// Esports kill props have no Pinnacle player line, so the leader is whichever
// pick'em app moves first: when Underdog moves a player's line and PrizePicks
// or Sleeper is still on the old number, the unmoved app is stale. Fed after
// every esports board build, one app at a time at the time that app was read.
// No model prices a row: its fair is the leader's new number on the board's
// curve. Legs at 2%+ go in their own record (esports-stale.json), graded on
// the result like any esports pick, the close on the follower's own line.
// No alerts. ES_STALE=off stops it.
const esstale = require('./esstale');
const esStaleState = { enabled: !/^(off|0|false|no)$/i.test(String(process.env.ES_STALE || '').trim()),
  engine: esstale.createEsStale(), rows: [], screenedAt: null, errors: [], fedAt: {} };
const ES_STALE_TRACK_MIN = parseFloat(process.env.ES_STALE_TRACK_MIN || '2');
const esStaleTracker = createTracker({
  store: resultsBackup.wrap('esportsStale', createPickFileStore(process.env.ES_STALE_FILE || path.join(process.env.LR_DATA_DIR || path.join(__dirname, 'data'), 'esports-stale.json'))),
  graders: tracker.graders, normalizeName, normalizeMarket, parseMapSpan, minEv: ES_STALE_TRACK_MIN,
  fairProb: (p, line, side) => marketFairProb(p, line, side, pickCtx.get(p)),
});
esStaleTracker.ready().catch(e => console.error('Esports stale tracker: store failed to initialise:', e.message));

// ── MY SLIPS, ESPORTS LEGS (esslips.js) ──
// A user's esports kill, headshot and assist legs, matched to the board's pick
// for that player and match, followed to the start on the books' consensus at
// the leg's own line and graded from the match stats like the esports record.
// Its own record (esports-slip-legs.json): legs only, no stakes, no people.
const esSlipTracker = createTracker({
  store: resultsBackup.wrap('esportsSlipLegs', createPickFileStore(process.env.ES_SLIP_LEGS_FILE || path.join(process.env.LR_DATA_DIR || path.join(__dirname, 'data'), 'esports-slip-legs.json'))),
  graders: tracker.graders, normalizeName, normalizeMarket, parseMapSpan, minEv: -1000,
  fairProb: (p, line, side) => marketFairProb(p, line, side, pickCtx.get(p)),
  idSuffix: p => p.slipKey,
});
esSlipTracker.ready().catch(e => console.error('Esports slip legs: store failed to initialise:', e.message));
const esSlipLog = require('./esslips').createEsSlipLog({
  tracker: esSlipTracker, normalizeName, parseMapSpan,
  prepare: (sp, orig) => { const c = pickCtx.get(orig); if (c) pickCtx.set(sp, c); },
});

// ── SAME-DAY MATCHES CHECK (v3.135.0, esmatch.js) ──
// Until v3.135.0 the board keyed an app's line by player and stat alone, so a
// player in two or three Bo1s a day was priced against whichever listing came
// up first (PrizePicks' line for one opponent next to Underdog's for another),
// and the CS grader took the nearest of the team's matches. This counts the
// record rows from 10-13 on, made before the fix (no matchTag), on a team the
// records show in more than one match that day. A dry run: it changes nothing
// unless SAME_DAY_REPAIR=void, which voids them with the reason, undoably
// (voidedFrom keeps what each row was).
const SAME_DAY_FROM = Date.parse('2026-10-13T00:00:00Z');
const SAME_DAY_NOTE = 'Same-day matches: the team played more than one match that day and the board priced (or graded) this line off whichever listing came first; fixed in v3.135.0';
const SAME_DAY_MODE = String(process.env.SAME_DAY_REPAIR || '').trim().toLowerCase() === 'void' ? 'void' : 'count';
const sameDayCheck = { mode: SAME_DAY_MODE, at: null, exposed: {}, graded: {}, voided: {}, error: null };
async function checkSameDayRows() {
  const recs = { esports: tracker, pinGaps: pinGapTracker, share: shareTracker, rounds: roundsTracker, h2h: h2hTracker, esStale: esStaleTracker };
  const all = [];
  for (const [name, t] of Object.entries(recs)) {
    for (const r of await t.list({ limit: 1e7 })) if (Date.parse(r.startTime || '') >= SAME_DAY_FROM) all.push({ name, r });
  }
  const exposed = esmatch.multiMatchRows(all.map(x => x.r));
  const hit = all.filter(x => exposed.has(x.r) && !x.r.matchTag && x.r.status !== 'void');
  const ids = new Set(hit.map(x => `${x.name}|${x.r.id}`));
  for (const name of Object.keys(recs)) {
    const mine = hit.filter(x => x.name === name);
    sameDayCheck.exposed[name] = mine.length;
    sameDayCheck.graded[name] = mine.filter(x => x.r.status === 'graded').length;
  }
  if (SAME_DAY_MODE === 'void') {
    for (const [name, t] of Object.entries(recs)) sameDayCheck.voided[name] = await t.voidWhere(r => ids.has(`${name}|${r.id}`), SAME_DAY_NOTE);
  }
  sameDayCheck.at = new Date().toISOString();
  return sameDayCheck;
}
if (require.main === module) setTimeout(() => checkSameDayRows().catch(e => { sameDayCheck.error = e.message; }), 45e3);
// each app's payout cell on a pick, as stalelines prices the sports apps
function esStaleCell(p, book) {
  if (book === 'UD') return p.udSides || { over: p.udMultiplier ?? 1, under: p.udMultiplier ?? 1, overOpen: true, underOpen: true };
  if (book === 'SL') return p.slSides || null;
  return { overOpen: true, underOpen: true };
}
function esStalePrice(app, fair, cell, side) {
  if (!cell) return null;
  if (cell[side === 'Over' ? 'overOpen' : 'underOpen'] === false) return null;   // that side is shut at the app
  if (app === 'sleeper' && !(cell.over > 1 && cell.under > 1)) return null;
  return stalePriceApp(app, fair, cell, side);
}
// the app's last good read: PrizePicks' newest esports league, Underdog's and Sleeper's boards
function esStaleReadAt() {
  return { prizepicks: Math.max(0, ...Object.values(ppState.leagueOkAt || {})), underdog: Date.parse(cache.underdog.updated || '') || 0, sleeper: Date.parse(cache.sleeper.updated || '') || 0 };
}
const esStalePicks = new Map();     // tracked stale legs by pick id, until the match starts
const esStaleBooks = new Map();     // every open row's app (PP, UD, SL) by pick id
esStaleTracker.ready().then(async () => { for (const r of await esStaleTracker.list({ status: 'open', limit: 1e6 })) esStaleBooks.set(r.id, r.signalBook); }).catch(() => {});
function observeEsStale(picks) {
  if (!esStaleState.enabled) return;
  const t = Date.now();
  const probAt = (pk, m, x) => marketFairProb({ ...pk, marketPred: m }, x, 'OVER', pickCtx.get(pk));
  // a player in two matches on one day (round-robin Bo1s) shows as one board
  // pick whose match swaps between reads: those players sit out
  const twoMatches = esstale.multiMatchPlayers([...(cache.underdog.data || []), ...ppLinesNow(), ...(cache.sleeper.data || [])].filter(l => isEsports(l.sport)), normalizeName);
  const quotes = picks.filter(p => !twoMatches.has(esstale.playerDay(p, normalizeName))).flatMap(p => esstale.pickQuotes(p, { probAt, cellOf: esStaleCell }));
  esStaleState.twoMatchPlayers = twoMatches.size;
  const readAt = esStaleReadAt();
  // apps in the order they were read, each only when it has been read again
  for (const app of esstale.APPS.slice().sort((a, b) => readAt[a] - readAt[b])) {
    const r = readAt[app];
    if (!(r > 0) || r <= (esStaleState.fedAt[app] || 0)) continue;
    esStaleState.engine.observe(app, quotes.filter(q => q.app === app), r);
    esStaleState.fedAt[app] = r;
  }
  esStaleState.engine.step(t);
  const rows = esStaleState.engine.rows(t, { priceApp: esStalePrice });
  esStaleState.rows = rows;
  esStaleState.screenedAt = new Date(t).toISOString();
  // the record: each subject's first 2%+ stale leg, as a pick at the follower app
  const byKey = new Map(picks.map(p => [esstale.subjectKey(p), p]));
  const BOOK = { prizepicks: 'PP', underdog: 'UD', sleeper: 'SL' };
  for (const r of rows) {
    if (!(r.ev >= ES_STALE_TRACK_MIN)) continue;
    const p = byKey.get(r.key);
    if (!p) continue;
    const id = esStaleTracker.pickId(p);
    if (esStalePicks.has(id)) continue;
    const book = BOOK[r.app];
    esStaleBooks.set(id, book);
    esStalePicks.set(id, { start: Date.parse(p.startTime || ''), ctx: pickCtx.get(p), p: {
      ...p, side: r.side.toUpperCase(), bestBook: book, bestEv: r.ev, prob: r.fairProb, lineGap: null, matchupLed: null,
      ...(book === 'PP' ? { ppLine: r.line, lineSource: 'pp' } : book === 'UD' ? { udLine: r.line, udImplied: r.decimal ? 100 / r.decimal : undefined } : { sleeperLine: r.line, sleeperMultiplier: r.decimal ?? undefined }),
      trackExtra: { staleLeader: BOOK[r.leader], staleLeadPre: r.leadPre, staleLeadPost: r.leadPost, staleMoveAt: r.moveAt, staleMins: r.mins, staleDPts: r.dPts, staleFair: r.fairProb, stalePreFair: r.preFair },
    } });
  }
  for (const [id, v] of esStalePicks) if (v.start <= t) esStalePicks.delete(id);
  // new stale legs first (they open the row), then every board pick (with no
  // side of its own) so open rows follow their app's line to the start
  const withCtx = (x, ctx) => { if (ctx) pickCtx.set(x, ctx); return x; };
  const fresh = [...esStalePicks.values()].map(v => withCtx(v.p, v.ctx));
  // a tracked row only follows its own app's line: a PrizePicks row whose
  // PrizePicks line is gone mustn't close on Underdog's number
  const plain = [];
  for (const p of picks) {
    const book = esStaleBooks.get(esStaleTracker.pickId(p));
    if (!book || (book === 'PP' && p.lineSource !== 'pp') || (book === 'UD' && p.udLine == null) || (book === 'SL' && p.sleeperLine == null)) continue;
    plain.push(withCtx({ ...p, side: null, bestEv: null }, pickCtx.get(p)));
  }
  esStaleTracker.recordBoard([...fresh, ...plain]).catch(e => console.warn('Esports stale tracker:', e.message));
}
// Pinnacle's per-map totals (rounds for CS2/Valorant, team kills for LoL/Dota)
// at signal and close, graded against the maps played (pintotals.js). Once a
// title has enough graded maps its fitted spread replaces the kill models'
// assumed one.
const pintotals = require('./pintotals');
const pinTotals = { rows: new Map(), store: resultsBackup.wrap('esportsPinTotals', createPickFileStore(process.env.PIN_TOTALS_FILE || path.join(process.env.LR_DATA_DIR || path.join(__dirname, 'data'), 'esports-pin-totals.json'))),
  fit: pintotals.fitted([]), find: pintotals.createSources(axios), lastTry: new Map(), last: null, ready: null };
pinTotals.ready = pinTotals.store.init().then(async () => {
  for (const r of await pinTotals.store.all()) pinTotals.rows.set(r.id, r);
  pinTotals.fit = pintotals.fitted([...pinTotals.rows.values()]);
}).catch(e => console.error('Pinnacle totals: store failed to initialise:', e.message));
async function observePinTotals(pin) {
  await pinTotals.ready;
  const changed = pintotals.observe(pinTotals.rows, pin);
  if (changed.length) await pinTotals.store.putMany(changed);
}
async function gradePinTotals() {
  await pinTotals.ready;
  const res = await pintotals.gradeDue([...pinTotals.rows.values()], pinTotals.find, { lastTry: pinTotals.lastTry });
  if (res.changed.length) await pinTotals.store.putMany(res.changed);
  pinTotals.fit = pintotals.fitted([...pinTotals.rows.values()]);
  const { changed, ...rest } = res;
  pinTotals.last = { ...rest, at: new Date().toISOString() };
  return pinTotals.last;
}
// what the kill models use: the fitted spread once a title has enough graded maps
const fittedTeamSd = game => (pinTotals.fit[game]?.source === 'fitted' ? pinTotals.fit[game].teamSd : null);
const fittedKappa = game => (pinTotals.fit[game]?.source === 'fitted' ? pinTotals.fit[game].kappa : null);
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
// ── KALSHI PLAYER PROPS ──
// Kalshi's player stat ladders are the free sharp line for Underdog's sports
// props (kprops.js). Refreshed every 5 minutes, ahead of the EV screen.
const kprops = require('./kprops');
const kpropsState = { games: [], updated: null, counts: null, errors: [] };
let kpropsRunning = false;
async function refreshKalshiProps() {
  if (kpropsRunning) return;
  kpropsRunning = true;
  try {
    const { events, errors } = await kprops.fetchEvents(upstream);
    // every book's line gets its own rung price, not only Underdog's
    const { games, counts } = kprops.buildGames(events, sportsPropLines());
    Object.assign(kpropsState, { games, counts: { events: events.length, ...counts }, errors: errors.slice(0, 5), updated: new Date().toISOString() });
    // every rung by ticker, for BIG MONEY (a print on a rung is a bet on that player's line)
    if (events.length) kpropsState.rungs = bigMoney.rungIndex(events, { canonMarket: evScreen.canonMarket, parseRung: kprops.parseRung });
  } catch (e) { kpropsState.errors = [e.message]; }
  finally { kpropsRunning = false; }
  await refreshKalshiExtra();
}
// Kalshi's UFC (method, round, distance), NASCAR (top N) and tennis total-games
// markets, read as pick'em fairs at the lines they sit on (kxextra.js). Behind
// the kalshi licence like the ladders; refreshed with them.
const kxextra = require('./kxextra');
const kxExtraState = { quotes: 0, bySport: {}, events: 0, updated: null, errors: [] };
let kxExtraIndex = new Map();
async function refreshKalshiExtra() {
  if (!licences.isOn('kalshi')) return;
  try {
    const { events, errors } = await kxextra.fetchEvents(upstream);
    const quotes = kxextra.quotesFromEvents(events);
    if (quotes.length || !errors.length) kxExtraIndex = kxextra.indexQuotes(quotes);
    const bySport = {};
    for (const x of quotes) bySport[`${x.sport} ${x.mkey}`] = (bySport[`${x.sport} ${x.mkey}`] || 0) + 1;
    Object.assign(kxExtraState, { quotes: quotes.length, bySport, events: events.length, errors: errors.slice(0, 5), updated: new Date().toISOString() });
  } catch (e) { kxExtraState.errors = [e.message]; }
}
const kalshiExtraAt = (row, line) => kxextra.quoteAt(kxExtraIndex, { key: `${row.sport}|${evScreen.canonName(row.player)}|${row.mkey}`, startTime: row.startTime }, line)?.pOver ?? null;

// One pick'em leg's EV. Sleeper prices each side, so its vig comes out and a
// price far from fair is withheld (pickem.js sleeperPricing), as on esports.
function dfsLegEv(p, book, mult, line, side) {
  const other = line ? (side === 'Over' ? line.underMultiplier : line.overMultiplier) : null;
  if (book === 'sleeper' && line) return sleeperPricing(p, mult, other || null).ev;
  if (book === 'underdog' && other != null) return udPricing(p, mult, other).ev;
  if (book === 'pick6') return sportProps.fixedLeg('pick6', p > 1 ? p / 100 : p, mult)?.ev ?? null;
  return calcBookEV(p, book, mult);
}

function evFeeds() {
  const feeds = [];
  const add = (sport, label, c) => {
    if (!Array.isArray(c?.data) || !c.data.length) return;
    // game-line feeds get the exchange books attached
    const games = /odds$/.test(label) && exchangeState.rows.length ? exchanges.attachExchanges(c.data, exchangeState.rows, { ...EXCHANGE_OPTS, league: sport }) : c.data;
    feeds.push({ sport, label, games, updated: c.updated || null });
  };
  // Kalshi player ladders price the pick'em lines (kprops.js); sport comes per game
  if (kpropsState.games.length) feeds.push({ sport: null, label: 'kalshi-props', games: kpropsState.games, updated: kpropsState.updated });
  // Pinnacle + FanDuel + BetRivers game lines (refreshFreeBooks)
  // the last good read only: a Pinnacle outage keeps the old games, which go
  // off the board once they're FREE_BOOKS_MAX_AGE_MS old
  if (Date.now() - Date.parse(freeBooksState.gamesAt || 0) < FREE_BOOKS_MAX_AGE_MS)
    for (const [s, games] of Object.entries(freeBooksState.games)) add(s, 'free-odds', { data: games, updated: freeBooksState.gamesAt });
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
// Books whose record has earned the webhook: the close scoreboard's own
// proven mark (closeboard.alertBooks: one kind on one book read direct, 50
// graded games, CLV t of 2) and EV_PROVEN_CLV % still beaten at the price two
// minutes on. Refreshed every 5 minutes; empty until a book proves out. Until
// 10-18 this counted raw lines per book, so Action Network's copies posted too.
const EV_PROVEN_CLV = parseFloat(process.env.EV_PROVEN_CLV) || 1;
// leads with their own record (Gemini, Polymarket US): never an alert, never
// in Best Plays, whatever the board says, until a raw re-check backs them
const EV_LEAD_BOOKS = new Set(['gemini', 'polymarketus']);
let evBookProven = new Set();
async function refreshEvProof() {
  evBookProven = closeBoard.alertBooks(await closeBoardFor(), { minExecClv: EV_PROVEN_CLV });
}
const EV_WEIGHTS = { ...evScreen.SHARP_WEIGHTS, ...(Number.isFinite(parseFloat(process.env.EV_KALSHI_WEIGHT)) ? { kalshi_mid: parseFloat(process.env.EV_KALSHI_WEIGHT) } : {}) };
function runEvScreen(force = false) {
  if (!force && Date.now() - evCache.at < 30000) return evCache;
  // game lines take Kalshi's mids as a second sharp source next to Pinnacle's
  // (only here: the exchange scans read evFeeds too and must not see a no-vig book)
  const kmid = Date.now() - kalshiGameRows.at < KALSHI_MID_MAX_AGE_MS ? kalshiGameRows.rows : [];
  const feeds = evFeeds().map(f => (/odds$/.test(f.label) && kmid.length ? { ...f, games: pingames.withKalshiMid(f.games, kmid) } : f));
  const dfsLines = sportsPropLines();
  const fairs = new Map(), costs = new Map(), pinFairs = new Map();
  const rows = evScreen.screen({ feeds, dfsLines, dfsEv: dfsLegEv, minEv: 0, method: process.env.EV_DEVIG || 'power', fairs, costs, pinFairs, weights: EV_WEIGHTS });
  const prev = evCache.at ? evCache.rows : null;
  const alt = runAltScreen(kmid);
  evCache = { at: Date.now(), rows, alt: alt.rows, altSummary: alt.summary, feeds: feeds.map(f => ({ sport: f.sport, source: f.label, games: f.games.length, updated: f.updated })) };
  // Pinnacle's own price at each number rides along: the exchanges' rows close on it
  evTracker.recordBoard(rows, fairs, { costs, pinFairs }).catch(e => console.warn('EV tracker:', e.message));
  // the first screen after a restart only primes the diff
  if (prev) {
    // DK Pick6 is a lead: on the board and in the record, never an alert
    const fresh = evScreen.diffEv(prev, rows, { minEv: EV_ALERT_MIN, seen: evSeen }).filter(r => r.book !== 'pick6');
    if (fresh.length) {
      evRecent = [...fresh, ...evRecent].slice(0, 200);
      for (const fn of evListeners) { try { fn(fresh); } catch { /* keep going */ } }
      // the webhook can reach other people: it gets what the public may see
      // and only from a book (or pick'em app) the scoreboard marks proven (evBookProven)
      const posted = fresh.filter(evRowOk(webhookLicence())).filter(r => evBookProven.has(r.book) && !EV_LEAD_BOOKS.has(r.book));
      if (webhook.enabled && posted.length) {
        const lines = posted.slice(0, 10).map(evScreen.describeEv);
        if (posted.length > 10) lines.push(`…and ${posted.length - 10} more`);
        webhook.send(lines.join('\n'), 'EV alerts');
      }
    }
  } else {
    for (const r of rows) if (r.ev >= EV_ALERT_MIN) evSeen.set(evScreen.rowKey(r), Date.now());
  }
  return evCache;
}
// Ladders and alternate lines off Pinnacle's ladder and Kalshi's exact lines
// (altlines.js). Kept out of evCache.rows, so they never alert, never reach
// Best Plays and never count toward a book's proof: until their own record
// beats the close over 50 bets they're a board to watch.
function runAltScreen(kmid = []) {
  if (Date.now() - Date.parse(freeBooksState.gamesAt || 0) >= FREE_BOOKS_MAX_AGE_MS) return { rows: [], summary: null };
  try {
    const fairs = new Map(), costs = new Map();
    const kalshiGame = kmid.length ? pingames.kalshiMidBooks(kmid, Object.values(freeBooksState.games).flat()) : new Map();
    const rows = altLines.screen({ gamesBySport: freeBooksState.games, kalshiGame, kalshiRungs: kpropsState.rungs || null,
      leagueOf: s => freebooks.LEAGUES[s]?.props || s.toUpperCase(), fairs, costs });
    altTracker.recordBoard(rows, fairs, { costs }).catch(e => console.warn('Alt tracker:', e.message));
    return { rows, summary: altLines.summarize(freeBooksState.games, rows, fairs) };
  } catch (e) { console.warn('Alt lines:', e.message); return { rows: [], summary: { error: e.message } }; }
}
function redactEv(rows) {
  return rows.map(r => ({ sport: r.sport, event: r.event, start: r.start, market: r.market, dfs: !!r.dfs, prop: !!r.player,
    source: r.source, sharpBooks: r.sharpBooks, agree: !!r.agree, locked: true }));
}
// +EV rows a viewer may see: a Kalshi book needs the Kalshi licence; a
// Polymarket book needs its licence and never shows in US mode
const evRowOk = lic => r => (r?.book !== 'kalshi' || lic.kalshi) && (r?.book !== 'polymarket' || (lic.polymarket && TAIL_REGION !== 'us'))
  && (!(r?.sharpBooks || []).some(b => b === 'kalshi_props' || b === 'kalshi_mid') || lic.kalshi);   // priced off Kalshi's own data
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
  if (!env.DATABASE_URL) return createDocFileStore(env.TAIL_TRADERS_FILE || path.join(process.env.LR_DATA_DIR || path.join(__dirname, 'data'), 'tail-traders.json'));
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
const tailEngine = tail.createTailEngine({ http: upstream, store: resultsBackup.wrap('tailTraders', createTraderStoreFromEnv(), { appendOnly: false }), opts: tail.optionsFromEnv() });
// TAIL_STREAM=off: poll only
const tailStream = createTradeStream({ onTrades: trades => runTailJob('stream', () => streamTail(trades)) });
const tailStreamOn = !/^(off|0|false|no)$/i.test(String(process.env.TAIL_STREAM || '').trim());
const tailTracker = createTailTracker({ store: resultsBackup.wrap('tail', createTailStoreFromEnv()), http: upstream });
tailTracker.ready().catch(e => console.error('Tail tracker: store failed to initialise:', e.message));
// the fresh-wallet radar's own record: its alerts as flat 1u bets
const freshTracker = createTailTracker({ store: resultsBackup.wrap('fresh', createFreshStoreFromEnv()), http: upstream });
freshTracker.ready().catch(e => console.error('Fresh tracker: store failed to initialise:', e.message));

// Polymarket US: the same game market a US follower can buy (POLYMARKET_US=off: not quoted)
const polymarketUs = pmus.enabledFromEnv() ? pmus.createPolymarketUs({ http: upstream }) : null;
const TAIL_REGION = xarb.regionFromEnv();   // 'us' | 'intl'
const XARB_OPTS = xarb.optsFromEnv();          // carries the region too
const XARB_ALERT_MIN = Number.isFinite(parseFloat(process.env.XARB_ALERT_MIN)) ? parseFloat(process.env.XARB_ALERT_MIN) : 1;
// sets of more bets than this stay in the app, off the phone alerts (XARB_ALERT_MAX_LEGS)
const XARB_ALERT_MAX_LEGS = Number.isFinite(parseInt(process.env.XARB_ALERT_MAX_LEGS)) ? parseInt(process.env.XARB_ALERT_MAX_LEGS) : 4;
const XARB_REALERT_MS = 30 * 60e3;   // an arb gone this long that comes back is news again
// Kalshi vs Polymarket US arbs: the Polymarket US leagues read each scan
// (XARB_PMUS_LEAGUES; off = none) and at most this many of its live books
// read to confirm what clears (XARB_PMUS_BOOKS_PER_SCAN)
const XARB_PMUS_LEAGUES = pmus.arbLeaguesFromEnv();
const XARB_PMUS_BOOKS = Number.isFinite(parseInt(process.env.XARB_PMUS_BOOKS_PER_SCAN)) ? Math.max(0, parseInt(process.env.XARB_PMUS_BOOKS_PER_SCAN)) : 40;
const xarbState = { arbs: [], near: [], bids: [], middles: [], screen: [], errors: [], counts: null, updated: null, durationMs: null, running: false, primed: { kalshi: false, polymarket: false, polymarketus: false }, kalshiTitles: new Map(),
  venues: null };   // the last scan's rows, indexed for routing signals (xarb.venueIndex)
const xarbSeen = new Map();          // arb id → last scan it showed up in (ms)
// middles worth a phone alert (EV %), and how long before the same one alerts again
const MIDDLE_ALERT_MIN = Number.isFinite(parseFloat(process.env.MIDDLE_ALERT_MIN)) ? parseFloat(process.env.MIDDLE_ALERT_MIN) : 4;
const MIDDLE_REALERT_MS = 6 * 3600e3;
const middleSeen = new Map();
// every Kalshi GAME/MATCH series read on its own, a slice a scan, so games
// the capped open-events list misses can still be tailed (XARB_GAME_SERIES_PER_SCAN, default 40; 0 = off)
const KALSHI_GAME_SWEEP_PER_SCAN = Number.isFinite(parseInt(process.env.XARB_GAME_SERIES_PER_SCAN)) ? parseInt(process.env.XARB_GAME_SERIES_PER_SCAN) : 40;
const kalshiGameSweep = KALSHI_GAME_SWEEP_PER_SCAN > 0 ? xarb.createKalshiGameSweep({ http: upstream, perScan: KALSHI_GAME_SWEEP_PER_SCAN }) : null;
// Kalshi's open events past the scan's first 6,000 (everything settling
// soonest), this many pages a scan, kept 30 minutes (XARB_KALSHI_TAIL_PAGES, default 6; 0 = off)
const KALSHI_TAIL_PAGES = Number.isFinite(parseInt(process.env.XARB_KALSHI_TAIL_PAGES)) ? Math.max(0, parseInt(process.env.XARB_KALSHI_TAIL_PAGES)) : 6;
const kalshiTailSweep = KALSHI_TAIL_PAGES > 0 ? xarb.createKalshiTailSweep({ http: upstream, perScan: KALSHI_TAIL_PAGES }) : null;

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
  const hidden = hiddenWallets();
  if (hidden.length && mentions(data, hidden)) return;
  for (const fn of liveListeners) { try { fn(type, data); } catch { /* keep going */ } }
}
// One post of up to 10 lines. TAIL_WEBHOOK=off stops these.
function postAlert(lines, what) {
  if (!lines.length || !webhook.enabled || process.env.TAIL_WEBHOOK === 'off') return null;
  const out = lines.slice(0, 10);
  if (lines.length > 10) out.push(`…and ${lines.length - 10} more`);
  return webhook.send(out.join('\n'), what);
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
const regionSafe = x => hideWallets(TAIL_REGION === 'us' ? stripPolymarketLinks(x) : x);

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
      z = tail.sizeAt({ q, price: v.price, feePerContract: v.fee || 0, grade: s.grade, consensus: Array.isArray(s.consensus) && s.consensus.length ? s.consensus : 1, days: s.days ?? 0, opts: tailEngine.settings() });
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
// When no venue sizes a take, the best resting bid (tail.limitPlan): makers
// pay no fee on Polymarket, and on Kalshi and Polymarket US we assume a
// quarter of the taker fee at most (Kalshi's maker fee, where a market has
// one, is 1.75% × p(1 − p) against 7%). Sportsbooks take no orders. Same
// deductions as a take: a top-up only adds above what was told, and the
// game's room caps it. A price that ran past the chase limit gets none: the
// market has already moved on the sharp's news. The pick: most units, then
// the higher bid (likelier to fill).
const MAKER_SHARE = { polymarket: 0, kalshi: 0.25, polymarketus: 0.25 };
function limitFor(s, v) {
  if (!v || !(v.key in MAKER_SHARE) || v.book || !(v.price > 0 && v.price < 1)) return null;
  const q = Number(s.q ?? s.prob);
  const spread = v.price * (1 - v.price);
  const rate = spread > 0 ? Math.max(0, Number(v.fee) || 0) / spread : 0;
  let plan = null;
  try {
    plan = tail.limitPlan({ q, ask: v.price, bid: v.bid ?? null, makerFee: p => MAKER_SHARE[v.key] * rate * p * (1 - p),
      grade: s.grade, consensus: Array.isArray(s.consensus) && s.consensus.length ? s.consensus : 1, days: s.days ?? 0, opts: tailEngine.settings() });
  } catch (e) { console.warn('Tail limit sizing:', e.message); }
  if (!plan) return null;
  let units = plan.units;
  const before = Number(s.priorUnits) > 0 ? Number(s.priorUnits) : 0;
  if (before > 0) units = Math.max(0, r2u(units - before));
  if (Number.isFinite(s.eventRoom)) units = Math.max(0, Math.min(units, s.eventRoom));
  if (!(units > 0)) return null;
  return { key: v.key, name: v.name, price: plan.price, fee: plan.fee, cost: plan.cost, units, kelly: plan.kelly, ask: v.price, bid: v.bid ?? null,
    pick: v.pick ?? null, ...(v.buy ? { buy: v.buy } : {}), ...(v.side ? { side: v.side } : {}), url: v.url || null, until: s.gameStartTime || null,
    ...(v.warning ? { warning: v.warning } : {}) };
}
function limitOf(s, venues) {
  const chase = tailEngine.settings().chaseMax;
  if (s.blocked || takeUnits(s) > 0 || (Number.isFinite(s.slippage) && Number.isFinite(chase) && s.slippage > chase + 1e-9)) return null;
  const plans = venues.map(v => limitFor(s, v)).filter(Boolean);
  plans.sort((a, b) => (b.units - a.units) || (b.price - a.price));
  return plans[0] || null;
}
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
  s.limit = limitOf(s, venues);
  if (s.id) {
    routedSignals.delete(s.id);
    routedSignals.set(s.id, { venue: s.venue, venues: s.venues, limit: s.limit });
    while (routedSignals.size > 2000) routedSignals.delete(routedSignals.keys().next().value);
  }
  return s;
}
// A viewer without the Kalshi licence gets the best venue that isn't Kalshi.
function venueFor(sig, lic) {
  const s = sig && !('venue' in sig) && routedSignals.has(sig.id) ? { ...sig, ...routedSignals.get(sig.id) } : sig;
  if (s?.type !== 'entry' || lic.kalshi || !Array.isArray(s.venues) || !s.venues.some(v => v.key === 'kalshi')) return s;
  const venues = s.venues.filter(v => v.key !== 'kalshi');
  return { ...s, venues, venue: xarb.pickVenue(venues), ...(s.limit?.key === 'kalshi' ? { limit: null } : {}), venueNote: `Kalshi prices: ${LICENCE_NOTE}` };
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
// "Bid at Kalshi: YES New York K 54¢ limit · 0.5u · fills only if it trades down to you · cancel at the start"
function limitLine(l) {
  return `Bid at ${l.name}${l.buy ? `: ${l.buy}` : ''} ${cents(l.price)} limit · ${l.units}u · fills only if it trades down to you${l.until ? ' · cancel at the start' : ''}`;
}
// <url> stops Discord unfurling a preview card under every line. US mode
// links the venue, never polymarket.com.
function describeTail(s) {
  const who = `${s.grade}-grade ${s.name || shortWallet(s.wallet)}`;
  const where = `${s.outcome || '?'} on "${s.market}" at ${cents(s.theirPrice)} (${dollars(s.theirNotional)})`;
  const to = s.limit && !(takeUnits(s) > 0) ? s.limit : s.venue;
  const url = TAIL_REGION === 'us' ? (to?.url && !PM_LINK.test(to.url) ? to.url : null) : s.url;
  const link = url ? ` <${url}>` : '';
  if (s.type === 'exit') return describeExit(s, who);
  const size = s.limit && !(takeUnits(s) > 0) ? limitLine(s.limit) : s.units > 0 || s.venue ? venueLine(s) : `0u: ${s.reason}`;
  return `${who} bought ${where} · ${size}${s.isConsensus ? ` · consensus ×${s.consensus.length}` : ''}${link}`;
}
// "Exit: A-grade X sold 80% of Yes on "…" at 62¢ ($4,000), bought at 41¢ · we tailed it 1.2u at Kalshi: YES … <url>"
// The venue is where the entry was sent, so followers know where to sell.
function describeExit(s, who) {
  const share = s.soldShare != null && s.soldShare < 0.995 ? `${Math.round(s.soldShare * 100)}% of ` : '';
  const paid = s.boughtAt != null ? `, bought at ${cents(s.boughtAt)}` : '';
  const r = s.tailed?.id ? routedSignals.get(s.tailed.id) : null;
  let v = r ? (Number(r.venue?.units) > 0 || !r.limit ? r.venue : r.limit) : null;
  if (v?.key === 'kalshi' && !webhookLicence().kalshi) v = null;
  const bid = v && r && v === r.limit ? ' with a bid (cancel it if it hasn\'t filled)' : '';
  const ours = s.tailed ? ` · we tailed it ${s.tailed.units}u${v ? ` at ${v.name}${v.buy ? `: ${v.buy}` : ''}${bid}` : ''}` : '';
  const url = TAIL_REGION === 'us' ? (v?.url && !PM_LINK.test(v.url) ? v.url : null) : (v?.url || s.url);
  return `Exit: ${who} sold ${share}${s.outcome || '?'} on "${s.market}" at ${cents(s.theirPrice)} (${dollars(s.theirNotional)})${paid}${ours}${url ? ` <${url}>` : ''}`;
}
const VENUE_NAMES = { kalshi: 'Kalshi', polymarket: 'Polymarket', polymarketus: 'Polymarket US' };
function describeMiddle(m) {
  const lo = Math.floor(m.low) + 1, hi = Math.ceil(m.high) - 1;
  const legs = (m.legs || []).map(l => `${VENUE_NAMES[l.venue] || l.venue} ${l.pick} ${cents(l.price)}`).join(' + ');
  return `Middle +${m.evPct}% EV: ${m.title} · ${legs} · both pay at ${lo === hi ? lo : `${lo} to ${hi}`} (about ${Math.round(m.hitProb * 100)}%), a miss costs ${Math.abs(m.missPct)}%`;
}
function describeArb(a) {
  const legs = (a.legs || []).map(l => `${l.venueTitle || VENUE_NAMES[l.venue] || l.venue} ${l.pick} ${l.price != null ? cents(l.price) : l.american > 0 ? `+${l.american}` : l.american}`).join(' + ');
  return `Arb +${a.profitPct}%: ${a.title} · ${legs}${a.warnings?.length ? ` · ${a.warnings.join('; ')}` : ''}`;
}

// Each cron job's last run and error, for /api/status.
const tailJobs = {};
async function runTailJob(name, fn) {
  const j = tailJobs[name] ||= { lastRun: null, ms: null, error: null };
  const t0 = Date.now();
  try { const out = await ops.job(`tail:${name}`, fn)(); j.error = null; return out; }
  catch (e) { j.error = e?.message || String(e); console.warn(`Tail ${name}:`, j.error); return null; }
  finally { j.lastRun = new Date().toISOString(); j.ms = Date.now() - t0; }
}

// How long the event loop stalls, over the last 10 minutes. A job that holds it
// past another job's start second makes that one run late (see CRON JOBS).
const loopDelay = require('perf_hooks').monitorEventLoopDelay({ resolution: 20 });
loopDelay.enable();
const loopNow = () => ({ p50Ms: Math.round(loopDelay.percentile(50) / 1e6), p99Ms: Math.round(loopDelay.percentile(99) / 1e6), maxMs: Math.round(loopDelay.max / 1e6) });
let loopWindow = null;
setInterval(() => { loopWindow = { ...loopNow(), until: new Date().toISOString() }; loopDelay.reset(); }, 600000).unref();

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
// A resting bid (s.limit) counts when nothing sizes a take.
const takeUnits = s => (s.venue && Number(s.venue.price) > 0 && Number(s.venue.price) < 1 ? Number(s.venue.units) || 0 : Number(s.units) || 0);
const tailUnits = s => takeUnits(s) || (Number(s?.limit?.units) > 0 ? Number(s.limit.units) : 0);
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
// "Second chance: 3 sharps (2A 1B) hold Yes on "…" at 41¢ avg; it's 39¢ now · Kalshi 40¢ <url>"
function describeBoardAlert(a) {
  const mix = [a.A ? `${a.A}A` : '', a.B ? `${a.B}B` : ''].filter(Boolean).join(' ');
  const v = (a.venues || [])[0];
  const where = v ? ` · ${v.name}${v.buy ? `: ${v.buy}` : ''} ${v.american != null ? american(v.american) : cents(v.price)}` : ` · ${NO_VENUE}`;
  const url = v?.url && !(TAIL_REGION === 'us' && PM_LINK.test(v.url)) ? ` <${v.url}>` : '';
  return `Second chance: ${a.wallets} sharp${a.wallets === 1 ? '' : 's'} (${mix}) hold ${a.outcome || '?'} on "${a.title}" at ${cents(a.avgEntry)} avg; it's ${cents(a.price)} now${where}${url}`;
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
// Texas-placeable venues for a fresh buy (no sportsbooks, never polymarket.com)
const FRESH_TEXAS_KEYS = new Set(['kalshi', 'polymarketus']);
async function freshSignal(e, { now = Date.now() } = {}) {
  let quotes = [];
  try { quotes = xarb.venueQuotes(e, xarbState.venues, { ...XARB_OPTS, now }); } catch (err) { console.warn('Fresh venues:', err.message); }
  const view = () => {
    quotes.sort((a, b) => (a.cost - b.cost) || (a.price - b.price));
    e.venues = quotes.map(v => venueView({ ...v, units: FRESH_UNITS }));
    e.venue = e.venues[0] || null;
  };
  view();
  const o = tailEngine.settings();
  let market = null;
  try { market = e.conditionId ? await tail.fetchMarket(upstream, e.conditionId) : null; } catch (err) { console.warn('Fresh market:', err.message); }
  if (!market || market.closed || market.active === false) return null;
  // the same bet on Polymarket US (a Texas venue), matched by event slug
  if (polymarketUs) {
    try {
      const q = await polymarketUs.quoteFor({ market: market.question || e.title, sportsMarketType: market.sportsMarketType, line: market.line,
        outcome: e.outcome, outcomes: market.outcomes, eventSlug: e.eventSlug || market.eventSlug });
      if (q && q.cost > 0 && q.cost < 1) quotes.push(q);
    } catch (err) { console.warn('Fresh Polymarket US:', err.message); }
  }
  view();
  const tx = quotes.find(v => FRESH_TEXAS_KEYS.has(v.key)) || null;
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
    texas: tx ? { key: tx.key, name: tx.name, price: tx.price, fee: tx.fee } : null,
  };
}
// 10-24 backtest from raw Polymarket data (Sep 24 - Oct 24, 61,977 pregame
// $1k+ buys on 60,665 sports and esports markets, one bet per game at the
// price 2 min after the buy plus a Kalshi-size fee): fresh wallets as a whole
// broke even; first-bet wallets were the one kind ahead, not proven (t < 2).
const FRESH_BACKTEST = {
  window: '2026-09-24 to 2026-10-24', buys: 61977, markets: 60665,
  fresh: { games: 359, won: 209, expected: 204.1, units: 2.0, roi: 0.005, t: 0.12 },
  firstBet: { games: 147, won: 91, expected: 82.4, units: 20.5, roi: 0.139, t: 1.78 },
  otherFresh: { games: 271, won: 154, expected: 154.9, units: -8.9, roi: -0.033, t: -0.62 },
  oldWallets: { games: 2912, won: 1733, expected: 1753.3, units: -52.4, roi: -0.018, t: -1.41 },
  // 10-24 out-of-sample test, pre-registered before the pull (Apr 1 to Sep 23,
  // 385,758 pregame $1k+ buys on 196,010 markets): the first-bet rule lost.
  firstBetOos: { window: '2026-04-01 to 2026-09-23', games: 760, won: 433.7, expected: 434.6, units: -12.2, roi: -0.016, t: -0.49, verdict: 'killed' },
  note: 'Following fresh wallets as a whole broke even. First-bet wallets looked ahead on Sep 24 to Oct 24 (147 games, +20.5u), but six months they were not fitted on (Apr to Sep, 760 games) went -12.2u, t -0.5: no edge. The FIRST BET record keeps counting as a check, not a bet.',
};
// Fresh-wallet webhook pings: off until the radar's record is proven (FRESH_ALERTS=on)
const FRESH_ALERTS = /^(on|1|true|yes)$/i.test(String(process.env.FRESH_ALERTS || '').trim());
async function publishFresh(e) {
  const sig = await freshSignal(e);
  if (!sig || !(await freshTracker.record(sig))) return false;
  const lic = webhookLicence();
  if (FRESH_ALERTS && lic.polymarket) postAlert([describeFresh(e, lic)], 'Fresh wallet alerts');
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
// xarb.findUnderrounds). → { arbs, rows, games, matches, screened, rowList, matchList }
// (the rows and their Kalshi pairs, for the watchlist)
async function polymarketUsArbs(kalshi, now) {
  const none = { arbs: [], rows: 0, games: 0, matches: 0, screened: 0, rowList: [], matchList: [] };
  if (!polymarketUs || !XARB_PMUS_LEAGUES.length) return none;
  const rows = await polymarketUs.arbRows({ leagues: XARB_PMUS_LEAGUES });
  if (!rows.length) return none;
  const o = { ...XARB_OPTS, now };
  const matches = await xarb.matchMarketsAsync(kalshi, rows, o);
  const screened = xarb.findUsArbs(kalshi, rows, { ...o, matches });
  // per league (the slug's first word): games listed, and games with a Kalshi pair
  const byLeague = {};
  const lg = r => String(r.gameSlug || '').split('-')[0] || '?';
  const paired = new Set(matches.map(m => m.polymarket.eventKey));
  for (const [key, r] of new Map(rows.map(x => [x.eventKey, x]))) {
    const l = lg(r);
    byLeague[l] ||= { games: 0, paired: 0 };
    byLeague[l].games++;
    if (paired.has(key)) byLeague[l].paired++;
  }
  const counts = { rows: rows.length, games: new Set(rows.map(r => r.eventKey)).size, matches: matches.length, screened: screened.length, byLeague, rowList: rows, matchList: matches };
  if (!screened.length || XARB_PMUS_BOOKS <= 0) return { ...none, ...counts };
  const ids = new Set(screened.flatMap(a => a.legs.filter(l => l.venue === 'polymarketus').map(l => l.marketId)));
  const live = await polymarketUs.reprice(rows.filter(r => ids.has(r.id)), { maxBooks: XARB_PMUS_BOOKS });
  const liveRows = [...live.values()].filter(Boolean);
  const byId = new Map(liveRows.map(r => [r.id, r]));
  const liveMatches = matches.filter(m => byId.has(m.polymarket.id)).map(m => ({ ...m, polymarket: byId.get(m.polymarket.id) }));
  return { ...counts, arbs: xarb.findUsArbs(kalshi, liveRows, { ...o, matches: liveMatches }) };
}

// ── exchange value (xvalue.js) ──
// Kalshi and Polymarket US asks under Polymarket's mid, fee included. Gamma's
// quotes only pick what to check: each candidate's Polymarket price comes from
// its live CLOB book (XVALUE_BOOKS_PER_SCAN, default 30), and so does the
// close of every tracked bet still open. Every edge is graded on CLV at the
// start, like the esports edges.
const xvalue = require('./xvalue');
const movers = require('./movers');
const XVALUE_OPTS = xvalue.optsFromEnv();
const XVALUE_BOOKS = Number.isFinite(parseInt(process.env.XVALUE_BOOKS_PER_SCAN)) ? Math.max(0, parseInt(process.env.XVALUE_BOOKS_PER_SCAN)) : 30;
const XVALUE_ALERT_MIN = Number.isFinite(parseFloat(process.env.XVALUE_ALERT_MIN)) ? parseFloat(process.env.XVALUE_ALERT_MIN) : 0.03;
const XVALUE_REALERT_MS = 6 * 3600e3;
// steam (steam.js): Polymarket just moved and the US venue hasn't followed
const steamWatch = require('./steam').createSteamWatch(require('./steam').optsFromEnv());
// its history rides the results backup through a deploy (non-append: it's state, not a record)
// (the restore adds only ids it doesn't have, so until it's done the store
// reads empty: a scan that beat it to the first quotes doesn't block a side)
let steamBooted = false;
const steamStore = resultsBackup.wrap('steamHistory', {
  init: async () => {}, all: async () => steamBooted ? steamWatch.dump() : [],
  put: async d => { steamWatch.load([d]); }, putMany: async ds => { steamWatch.load(ds); },
}, { appendOnly: false });
steamStore.init().catch(e => console.warn('Steam history: restore failed:', e.message)).finally(() => { steamBooted = true; });
const STEAM_ALERT_MIN = Number.isFinite(parseFloat(process.env.STEAM_ALERT_MIN)) ? parseFloat(process.env.STEAM_ALERT_MIN) : 0.02;
const xvalueState = { edges: [], movers: [], moverBets: [], updated: null, counts: null, primed: false };
// line movers are bets once their book is read; their alerts wait on the record
const MOVER_ALERT_MIN = Number.isFinite(parseFloat(process.env.MOVER_ALERT_MIN)) ? parseFloat(process.env.MOVER_ALERT_MIN) : 0.02;
// executable (execcheck.js): an alert needs XVALUE_MIN_DEPTH_USD resting on
// the venue's book (Kalshi or Polymarket US) at the alerted price, and every bet is also graded at the
// price a subscriber got 2 minutes after the flag
const execcheck = require('./execcheck');
const XVALUE_MIN_DEPTH = Number.isFinite(parseFloat(process.env.XVALUE_MIN_DEPTH_USD)) ? parseFloat(process.env.XVALUE_MIN_DEPTH_USD) : execcheck.DEFAULTS.minUsd;
const depthCheck = execcheck.createDepthCheck({ http: upstream, pmus: polymarketUs });
const envNum = (k, d) => Number.isFinite(parseFloat(process.env[k])) ? parseFloat(process.env[k]) : d;
const XVALUE_EXEC = { minN: envNum('XVALUE_EXEC_MIN_N', execcheck.DEFAULTS.alertMinN), minClv: envNum('XVALUE_EXEC_MIN_CLV', execcheck.DEFAULTS.alertMinClv) };
const xvalueSeen = new Map();     // edge id → last alert (ms)
const xvalueBookCache = new Map();  // ref id → { book, at }: a read counts for XVALUE_BOOK_TTL_MS
const XVALUE_BOOK_TTL_MS = 4 * 60e3;
const xvalueRefs = new Map();     // tracked group → { refId, token, start }: its close keeps coming from the book
const xvalueTracker = createEvTracker({
  store: resultsBackup.wrap('exchangeValue', createEvStoreFromEnv(process.env, { table: 'exchange_value', fileVar: 'XVALUE_TRACK_FILE', file: 'exchange-value.json' })),
  minEv: 0,
});
xvalueTracker.ready().catch(e => console.error('Exchange value tracker: store failed to initialise:', e.message));
// US mode bets Kalshi and Polymarket US; elsewhere Polymarket itself is open,
// so only Kalshi trailing it is news
const XVALUE_VENUES = TAIL_REGION === 'us' ? ['kalshi', 'polymarketus'] : ['kalshi'];
async function scanValue({ kalshi, polymarket, matches, usRows, usMatches }, now = Date.now()) {
  const input = { matches, kalshi, usRows, polymarket, usMatches };
  const o = { ...XVALUE_OPTS, kalshiFeeRate: XARB_OPTS.kalshiFeeRate ?? xvalue.DEFAULTS.kalshiFeeRate, venues: XVALUE_VENUES, now };
  // what to read: the screen's best first, then the open bets' refs
  const want = new Map();
  const scr = xvalue.screen(input, o);
  // steaming sides first: a move is minutes old and the book read confirms it
  const steaming = steamWatch.candidates(scr.quotes, now);
  try { xvalueState.movers = movers.findMovers(scr.quotes, polymarket); } catch (e) { console.warn('Line movers:', e.message); }
  steamWatch.observe(scr.quotes, now);
  for (const q of steaming) if (q.refToken && !want.has(q.refId)) want.set(q.refId, q.refToken);
  for (const e of scr.edges) if (e.refToken && !want.has(e.refId)) want.set(e.refId, e.refToken);
  for (const m of xvalueState.movers) if (m.refToken && !want.has(String(m.refId))) want.set(String(m.refId), m.refToken);
  for (const [g, r] of xvalueRefs) {
    if (Date.parse(r.start) <= now - 3600e3) { xvalueRefs.delete(g); continue; }
    if (!want.has(r.refId)) want.set(r.refId, r.token);
  }
  // books read in the last few scans still count, so the reads rotate
  // through every candidate; a steaming side's is always read fresh
  const reads = xvalue.planReads({ urgent: steaming.map(q => q.refId), rest: [...want.keys()], cache: xvalueBookCache, now, max: XVALUE_BOOKS });
  let read = 0;
  for (const id of reads) {
    try { const b = await tail.fetchBook(upstream, want.get(id)); if (b) { xvalueBookCache.set(id, { book: b, at: now }); read++; } } catch { /* a missing book: no edge */ }
  }
  // an older read only counts while Gamma's quote still agrees with it
  const gammaMid = new Map();
  for (const p of polymarket) if (want.has(String(p.id)) && p.yesAsk != null && p.noAsk != null) gammaMid.set(String(p.id), (p.yesAsk + 1 - p.noAsk) / 2);
  const books = new Map();
  for (const [id, c] of xvalueBookCache) {
    if (now - c.at > XVALUE_BOOK_TTL_MS) { xvalueBookCache.delete(id); continue; }
    if (!want.has(id)) continue;
    const g = gammaMid.get(id), mid = c.book.ask != null && c.book.bid != null ? (c.book.ask + c.book.bid) / 2 : null;
    if (c.at < now && (g == null || mid == null || Math.abs(g - mid) > 0.015)) continue;
    books.set(id, c.book);
  }
  const found = xvalue.findValue(input, { ...o, books, requireBook: true, steam: steamWatch, steamMinEv: steamWatch.opts.minEv });
  const { fairs, pairs, kalshiPriced } = found, edges = xvalue.dedupeEdges(found.edges);
  edges.sort((a, b) => (b.steam ? 1 : 0) - (a.steam ? 1 : 0) || b.ev - a.ev);
  // the day's big moves, followed at a US venue still at or under the book's fair
  let moverBets = [];
  try { moverBets = movers.moverBets(xvalueState.movers, { fairs, edges, maxEv: o.maxEv }); } catch (e) { console.warn('Line movers: bets:', e.message); }
  for (const e of [...edges, ...moverBets]) if (e.refToken) xvalueRefs.set(e.group, { refId: e.refId, token: e.refToken, start: e.start });
  let depthReads = 0;
  try { depthReads = await depthCheck.check([...edges, ...moverBets]); } catch (e) { console.warn('Exchange value: depth:', e.message); }
  // bets due their +2 min grade also get it at $100 through a fresh book read
  let sized = null;
  try { sized = await depthCheck.sized(await xvalueTracker.dueForExec(), { kalshiFeeRate: o.kalshiFeeRate, pmusFeeRate: pmus.FEE_RATE }); } catch (e) { console.warn('Exchange value: sized grade:', e.message); }
  await xvalueTracker.recordBoard(xvalue.trackRows([...edges, ...moverBets]), fairs, { costs: xvalue.costsOf(scr.quotes), sized }).catch(err => console.warn('Exchange value tracker:', err.message));
  Object.assign(xvalueState, { edges, moverBets, books, updated: new Date(now).toISOString(), counts: { pairs, kalshiPriced, screened: want.size, books: books.size, read, edges: edges.length, steaming: steaming.length, steam: edges.filter(e => e.steam).length, watched: steamWatch.size(), steamPoints: steamWatch.points(), steamRestored: steamWatch.restored(), moverBets: moverBets.length, depthReads, depthChecked: [...edges, ...moverBets].reduce((a, e) => (e.depth ? { ...a, [e.venue]: (a[e.venue] || 0) + 1 } : a), {}), executable: [...edges, ...moverBets].filter(e => execcheck.executable(e, XVALUE_MIN_DEPTH)).length } });
  const lic = webhookLicence();
  // alerts follow the record the way Best Plays does: a signal, league or
  // market the results call "avoid" (standing price gaps, -0.6% CLV over 32
  // on 10-13) stays on the ARBS tab but doesn't ping anyone
  let plays = [];
  try { ({ plays } = results.scoreboard({ exchangeValue: await xvalueTracker.list({ limit: 1e9 }) })); } catch (e) { console.warn('Exchange value: record:', e.message); }
  const bp = require('./bestplays'), verdict = bp.verdictIndex(plays);
  const avoided = e => !!verdict('exchangeValue', { signal: bp.valueSignal(e), sport: e.league || e.category, book: e.venue, market: e.market }).avoid;
  // executable: size on the book now, and the signal's own record graded at
  // the price 2 minutes after each alert beats the close
  const execOf = e => execcheck.execPasses(plays, bp.valueSignal(e), XVALUE_EXEC);
  const canFill = e => execcheck.executable(e, XVALUE_MIN_DEPTH) && execOf(e).pass;
  const fresh = edges.filter(e => e.ev >= (e.steam ? STEAM_ALERT_MIN : XVALUE_ALERT_MIN) && canFill(e) && valueOk(lic)(e) && !avoided(e) && (!xvalueSeen.has(e.id) || now - xvalueSeen.get(e.id) > XVALUE_REALERT_MS));
  // a line mover alerts only once its own record is proven, at that record's CLV
  if (moverBets.length) {
    try {
      const rec = plays.find(p => p.source === 'exchangeValue' && p.by === 'signal' && p.play === 'line mover');
      if (rec && rec.verdict === 'proven' && (rec.sizedN >= 8 ? rec.sizedClv : rec.execClv ?? rec.avgClv) >= MOVER_ALERT_MIN) {
        fresh.push(...moverBets.filter(e => canFill(e) && valueOk(lic)(e) && !avoided(e) && (!xvalueSeen.has(e.id) || now - xvalueSeen.get(e.id) > XVALUE_REALERT_MS)));
      }
    } catch (e) { console.warn('Line movers: record:', e.message); }
  }
  for (const e of fresh) xvalueSeen.set(e.id, now);
  for (const [id, at] of xvalueSeen) if (now - at > 2 * 86400e3) xvalueSeen.delete(id);
  // the first scan after a restart only primes
  if (fresh.length && xvalueState.primed) {
    broadcast('xvalue', fresh);
    const steamy = fresh.filter(e => e.steam), moved = fresh.filter(e => e.mover), plain = fresh.filter(e => !e.steam && !e.mover);
    // each alert leads with its signal's record, graded where a subscriber gets filled
    const withRec = (list, sig) => [execcheck.recordLine(sig, execOf(list[0]).rec), ...list.map(xvalue.describe)].filter(Boolean);
    if (steamy.length) postAlert(withRec(steamy, 'steam'), 'Steam');
    if (moved.length) postAlert(withRec(moved, 'line mover'), 'Line mover');
    for (const sig of ['price gap', 'Kalshi price']) {
      const list = plain.filter(e => bp.valueSignal(e) === sig);
      if (list.length) postAlert(withRec(list, sig), 'Exchange value');
    }
  }
  xvalueState.primed = true;
  return edges;
}

// One scan: every open Kalshi and Polymarket event, plus the game lines the
// backend already holds (sportsbooks, with the exchange books attached).
// bid-then-hedge plans, followed to a fill, a cancel or the start (bidtrack.js)
const bidTracker = require('./bidtrack').createBidTracker({
  store: resultsBackup.wrap('bidArbs', createEvStoreFromEnv(process.env, { table: 'bid_arbs', fileVar: 'BIDARB_TRACK_FILE', file: 'bid-arbs.json' })),
  fees: XARB_OPTS,
});
bidTracker.ready().catch(e => console.error('Bid tracker: store failed to initialise:', e.message));
// every middle, graded from Kalshi's settled ladder once its game is over (middletrack.js)
const middleTracker = require('./middletrack').createMiddleTracker({
  store: resultsBackup.wrap('middles', createEvStoreFromEnv(process.env, { table: 'exchange_middles', fileVar: 'MIDDLE_TRACK_FILE', file: 'middles.json' })),
  http: upstream,
});
middleTracker.ready().catch(e => console.error('Middle tracker: store failed to initialise:', e.message));
// Gas locks (gaslocks.js): Kalshi's daily state gas markets, the favourite at
// 90-98¢ the evening before, logged and graded from the result. GAS_LOCKS=off
// stops the scans; GAS_LOCK_ALERTS=off keeps them out of the webhook.
const gaslocks = require('./gaslocks');
const gasTracker = gaslocks.createGasTracker({
  store: resultsBackup.wrap('gasLocks', createEvStoreFromEnv(process.env, { table: 'gas_locks', fileVar: 'GAS_LOCK_FILE', file: 'gas-locks.json' })),
  http: upstream,
});
gasTracker.ready().catch(e => console.error('Gas locks: store failed to initialise:', e.message));
const gasState = { plays: [], counts: null, errors: [], updated: null };
async function scanGasLocks() {
  if (process.env.GAS_LOCKS === 'off') return [];
  const logged = new Set((await gasTracker.list()).map(r => r.id));
  const out = await gaslocks.scan(upstream, { skip: logged });
  const fresh = await gasTracker.record(out.plays);
  await gasTracker.mark(out.rows);
  await gasTracker.grade();
  Object.assign(gasState, { plays: out.plays, counts: out.counts, errors: out.errors.slice(0, 5), updated: new Date().toISOString() });
  if (fresh.length && process.env.GAS_LOCK_ALERTS !== 'off') postAlert(fresh.map(gaslocks.describe), 'Gas locks');
  return fresh;
}
// Live esports maps on Kalshi (esinplay.js): our live win probability (CS2
// round score, LoL gold/towers/dragons/barons, Dota net worth) against
// Kalshi's in-play ask, fee in, every 20 s. Records only, no alerts; judged at
// 50 graded (the first flag per map). ESPORTS_INPLAY=off stops it.
const esinplay = require('./esinplay');
const inplayTracker = esinplay.createInplayTracker({
  store: resultsBackup.wrap('esportsInplay', createEvStoreFromEnv(process.env, { table: 'esports_inplay', fileVar: 'ESPORTS_INPLAY_FILE', file: 'esports-inplay.json' })),
  http: upstream,
});
inplayTracker.ready().catch(e => console.error('In-play: store failed to initialise:', e.message));
const inplayLive = esinplay.createInplay({ http: upstream, tracker: inplayTracker });
let inplayBusy = false, inplayGradedAt = 0;
async function scanInplay() {
  if (process.env.ESPORTS_INPLAY === 'off' || inplayBusy) return [];
  inplayBusy = true;
  try {
    const fresh = await inplayLive.tick();
    if (Date.now() - inplayGradedAt > 5 * 60e3) { inplayGradedAt = Date.now(); await inplayTracker.grade(); }
    return fresh;
  } finally { inplayBusy = false; }
}
let middleGradedAt = 0;
let kalshiGameRows = { rows: [], at: 0 };
const KALSHI_MID_MAX_AGE_MS = 10 * 60e3;
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
    for (const r of swept) if (!listed.has(r.id)) { kalshi.push(r); listed.add(r.id); sweptIn++; }
    // and the events past the main list's last page
    let tailIn = 0;
    if (kalshiTailSweep && k.truncated) {
      let tail = [];
      try { tail = await kalshiTailSweep.step(k.cursor); } catch (e) { console.warn('Kalshi tail sweep:', e.message); }
      for (const r of tail) if (!listed.has(r.id)) { kalshi.push(r); listed.add(r.id); tailIn++; }
    }
    // Kalshi's game contracts, kept for the +EV fair (pingames.kalshiMidBooks)
    kalshiGameRows = { rows: kalshi.filter(r => r.category === 'sports' && r.tradable && (r.kind === 'teams' || r.kind === 'total' || r.kind === 'spread')), at: Date.now() };
    let games = [];
    try { games = evFeeds().filter(f => /odds$/.test(f.label)).flatMap(f => f.games); }
    catch (e) { console.warn('Exchange arbs: game feeds:', e.message); }
    const now = Date.now();
    // matched once: the cross-exchange arbs (intl) and signal routing both use it
    // in slices of about 20 ms, so pages and other jobs aren't held up for the
    // 2 s a full Kalshi list takes to match
    const matchStats = {};
    const matches = await xarb.matchMarketsAsync(kalshi, polymarket, { ...XARB_OPTS, now, games, stats: matchStats });
    let us = { arbs: [], rows: 0, games: 0, matches: 0, screened: 0, rowList: [], matchList: [] };
    try { us = await polymarketUsArbs(kalshi, now); } catch (e) { console.warn('Exchange arbs: Polymarket US:', e.message); }
    const arbs = dedupeArbs([...xarb.findArbs({ kalshi, polymarket, games }, { ...XARB_OPTS, now, matches }), ...us.arbs]);
    // the watchlist: what's closest to paying, on the venues this region can use
    const intl = TAIL_REGION === 'intl';
    let near = [];
    try {
      near = xarb.findNearArbs({ matches: [...(intl ? matches : []), ...us.matchList], rows: [...kalshi, ...(intl ? polymarket : []), ...us.rowList] }, { ...XARB_OPTS, now });
    } catch (e) { console.warn('Exchange arbs: watchlist:', e.message); }
    // bid on one venue, hedge on the other: the pairs a maker can lock when a taker can't
    let bids = [];
    try { bids = xarb.findBidArbs([...(intl ? matches : []), ...us.matchList], { ...XARB_OPTS, now }); }
    catch (e) { console.warn('Exchange arbs: bid plans:', e.message); }
    // the same game's total or spread at two lines on two venues
    let middles = [];
    try { middles = xarb.findMiddles(kalshi, [...us.rowList, ...(intl ? polymarket : [])], [...(intl ? matches : []), ...us.matchList], { ...XARB_OPTS, now }); }
    catch (e) { console.warn('Exchange arbs: middles:', e.message); }
    // the exchanges' odds screen: each paired line's sides, all-in, cheaper venue marked
    let screen = [];
    try { screen = xarb.exchangeScreen([...(intl ? matches : []), ...us.matchList], { ...XARB_OPTS, now }); }
    catch (e) { console.warn('Exchange arbs: price screen:', e.message); }
    await middleTracker.record(middles).catch(e => console.warn('Middle tracker:', e.message));
    if (now - middleGradedAt > 10 * 60e3) { middleGradedAt = now; middleTracker.grade().catch(e => console.warn('Middle tracker:', e.message)); }
    await bidTracker.record(bids, [...kalshi, ...us.rowList, ...(intl ? polymarket : [])]).catch(e => console.warn('Bid tracker:', e.message));
    if (polymarket.length) {
      try { await scanValue({ kalshi, polymarket, matches, usRows: us.rowList, usMatches: us.matchList }, now); } catch (e) { console.warn('Exchange value:', e.message); }
    }
    // the screen's fair column: Polymarket's mid (its live book where this scan read one)
    if (polymarket.length) {
      try { screen = xvalue.screenFairs(screen, { usRows: us.rowList, polymarket, books: xvalueState.books, usMatches: us.matchList }); } catch (e) { console.warn('Exchange price screen fairs:', e.message); }
    }
    if (polymarket.length) xarbState.venues = xarb.venueIndex({ kalshi, polymarket, matches, games }, { ...XARB_OPTS, now });
    // every row this scan read, for BIG MONEY's line shop (pingames.matchRows)
    xarbState.rows = { kalshi: kalshi.length ? kalshi : xarbState.rows?.kalshi || [], polymarket: polymarket.length ? polymarket : xarbState.rows?.polymarket || [], us: us.rowList?.length ? us.rowList : xarbState.rows?.us || [], at: now };
    if (kalshi.length) {
      xarbState.kalshiTitles = new Map(kalshi.map(r => [r.id, {
        title: r.outcomeLabel && !r.title.toLowerCase().includes(r.outcomeLabel.toLowerCase()) ? `${r.title} · ${r.outcomeLabel}` : r.title,
        eventTicker: r.eventKey.replace(/^kalshi:/, ''), url: r.url,
      }]));
    }
    Object.assign(xarbState, {
      arbs, near, bids, middles, screen, errors: [...k.errors, ...p.errors], updated: new Date(now).toISOString(), durationMs: Date.now() - t0,
      counts: { kalshiEvents: k.count, kalshiPages: k.pages, kalshiTruncated: k.truncated, kalshiMarkets: kalshi.length,
        polymarketEvents: p.count, polymarketPages: p.pages, polymarketTruncated: p.truncated, polymarketMarkets: polymarket.length, games: games.length, arbs: arbs.length,
        kalshiSwept: sweptIn, kalshiTail: tailIn, matches: matches.length, matchesBy: countBy(matches, m => m.by), matchStats,
        polymarketUs: { rows: us.rows, games: us.games, matches: us.matches, screened: us.screened, arbs: us.arbs.length, byLeague: us.byLeague || null }, near: near.length, bids: bids.length, middles: middles.length },
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
    // the best middles go to the webhook too, once per 6 hours each, after both venues are primed
    const mFresh = middles.filter(m => m.evPct >= MIDDLE_ALERT_MIN && (!middleSeen.has(m.id) || now - middleSeen.get(m.id) > MIDDLE_REALERT_MS));
    for (const m of mFresh) middleSeen.set(m.id, now);
    for (const [id, at] of middleSeen) if (now - at > 2 * 86400e3) middleSeen.delete(id);
    const mNews = mFresh.filter(m => (m.legs || []).every(l => !(l.venue in before) || before[l.venue]));
    if (mNews.length) postAlert(mNews.filter(arbOk(webhookLicence())).map(describeMiddle), 'Exchange middles');
    if (news.length) {
      broadcast('xarb', news);
      // the webhook only gets legs the public may see
      const ok = arbOk(webhookLicence());
      postAlert(news.filter(a => a.profitPct >= XARB_ALERT_MIN && (a.legs || []).length <= XARB_ALERT_MAX_LEGS && ok(a)).map(describeArb), 'Exchange arbs');
    }
    return news;
  } finally { xarbState.running = false; }
}

// ── ESPORTS MATCH BOARD ──
// Every esports match on Kalshi and Polymarket, priced against each other and
// a sportsbook (CS2), with the team-rating model alongside (esboard.js).
const esboard = require('./esboard');
const ESPORTS_OPTS = {
  ...(process.env.ESPORTS_EDGE_MIN ? { edgeMin: parseFloat(process.env.ESPORTS_EDGE_MIN) } : {}),
  ...(process.env.ESPORTS_MAX_SPREAD ? { maxSpread: parseFloat(process.env.ESPORTS_MAX_SPREAD) } : {}),
};
const ESPORTS_ALERT_MIN = parseFloat(process.env.ESPORTS_ALERT_MIN || '0.04');
const ESPORTS_REALERT_MS = 6 * 3600e3;
// Pinnacle's no-vig price is the board's fair where it lists the market (PINNACLE=on).
const esportsBoard = esboard.createEsportsBoard({ http: upstream, ratings: () => ratingsState.elo, opts: ESPORTS_OPTS, pinnacle: () => ({ on: PINNACLE_ON, key: process.env.PINNACLE_GUEST_KEY || '' }) });
const esportsEdgeSeen = new Map();
// LoL head-to-head matchup engine (esmatchup.js, esmatchupdata.js): our own
// team ratings and series math for every upcoming LoL series, next to
// Kalshi's price. A model view: the backtest says Kalshi's price is better.
// ESPORTS_MATCHUPS=off turns it off.
const esmatchupdata = require('./esmatchupdata');
const MATCHUPS_ON = !/^(off|0|false|no)$/i.test(String(process.env.ESPORTS_MATCHUPS || '').trim());
// CS2 and VALORANT run on the same engine (esgames.js): the venues list the
// matches, the ratings refresh's bo3.gg / vlr.gg reads give the results.
// ESPORTS_MATCHUPS_GAMES picks the games (default LOL,CS2,VAL).
const matchupStore = MATCHUPS_ON ? resultsBackup.wrap('esportsMatchups', createPickFileStore(process.env.MATCHUPS_FILE || path.join(process.env.LR_DATA_DIR || path.join(__dirname, 'data'), 'esports-matchups.json'))) : null;
const MATCHUP_GAMES = String(process.env.ESPORTS_MATCHUPS_GAMES || 'LOL,CS2,VAL').toUpperCase().split(/[\s,]+/).filter(g => ['LOL', 'CS2', 'VAL'].includes(g));
const RAW_OF = { CS2: 'CS', VAL: 'VAL' };
const matchupEngines = Object.fromEntries((MATCHUPS_ON ? MATCHUP_GAMES : []).map(game => [game, esmatchupdata.createMatchupEngine({
  game, http: upstream, board: () => esportsBoard.state.matches, pmusOn: pmus.enabledFromEnv(), store: matchupStore,
  results: RAW_OF[game] ? () => ratingsState.raw?.[RAW_OF[game]] || null : null,
})]));
const matchupEngine = matchupEngines.LOL || null;
// Every board edge is logged and graded on closing-line value like the +EV
// screener: the close is the all-source fair price at the match's start.
const esportsEdgeTracker = createEvTracker({
  store: resultsBackup.wrap('esportsEdges', createEvStoreFromEnv(process.env, { table: 'esports_edges', fileVar: 'ESPORTS_EDGE_TRACK_FILE', file: 'esports-edges.json' })),
  minEv: 0,
});
esportsEdgeTracker.ready().catch(e => console.error('Esports edge tracker: store failed to initialise:', e.message));
// board → evtrack rows (ev and fair in percent), the fair of every outcome and
// what each venue's side costs now, so every edge is also graded at the price
// a subscriber got 2 minutes after the flag (execClv, like exchange value)
function esportsEdgeRows(matches, venueOk = () => true) {
  const rows = [], fairs = new Map(), costs = new Map();
  for (const m of matches) {
    if (!m.start || m.live) continue;
    // An edge is flagged against the fair price from the OTHER sources, so the
    // close is read the same way, per venue. Closing on the all-source fair
    // folded the venue's own mid back in and cut every CLV toward zero.
    for (const mk of m.markets) for (const oc of mk.outcomes) for (const v of ['kalshi', 'polymarket']) {
      const ref = oc.quotes?.[v]?.ref, cost = oc.quotes?.[v]?.cost;
      if (ref != null) fairs.set(`${m.id}|${mk.key}|${v}|${oc.name}`, ref * 100);
      if (cost > 0 && cost < 1) costs.set(`${m.id}|${mk.key}|${v}|${oc.name}|${v}`, cost);
    }
    for (const e of m.edges) {
      if (!venueOk(e.venue) || !(e.cost > 0 && e.cost < 1) || e.fair == null) continue;
      rows.push({
        group: `${m.id}|${e.market}|${e.venue}`, side: e.outcome, book: e.venue, start: m.start, sport: m.game, event: m.label,
        market: e.kind, price: e.cost, decimal: 1 / e.cost, ev: e.ev * 100, fairProb: e.fair * 100, source: e.refSource === 'pinnacle' ? 'esboard-pin' : 'esboard',
      });
    }
  }
  return { rows, fairs, costs };
}
// US mode: Polymarket International can't be traded from the US (and Polymarket
// US lists no esports), so its prices stay as a reference but its edges and
// arb legs go.
const tradableVenue = v => v === 'kalshi' || (v === 'polymarket' && TAIL_REGION !== 'us');
// Limit bids the board suggests, by market side, until the match starts. A bid
// counts as a bet only once it would have filled: the venue's ask came down to
// the bid's price before the start (a seller crossed to it, and a bid that
// improved the best bid was first in line). Filled bids are graded on CLV like
// edges, as their own book ("kalshi-bid") so their record stands alone.
const esportsBidLedger = new Map();
function esportsBidFills(matches, venueOk = () => true, now = Date.now()) {
  const rows = [];
  const seen = new Set();
  for (const m of matches) {
    const started = !m.start || m.live || Date.parse(m.start) <= now;
    for (const b of m.bids || []) {
      if (started || !venueOk(b.venue)) continue;
      const key = `${m.id}|${b.market}|${b.venue}|${b.outcome}`;
      seen.add(key);
      const had = esportsBidLedger.get(key);
      // keep the highest price suggested: a bid someone placed earlier stays up
      if (!had || b.price > had.price) esportsBidLedger.set(key, { ...b, matchId: m.id, start: m.start, sport: m.game, event: m.label });
    }
    for (const mk of m.markets || []) for (const oc of mk.outcomes) for (const v of ['kalshi', 'polymarket']) {
      const key = `${m.id}|${mk.key}|${v}|${oc.name}`;
      const b = esportsBidLedger.get(key);
      if (!b) continue;
      if (Date.parse(b.start) <= now) { esportsBidLedger.delete(key); continue; }
      const ask = oc.quotes?.[v]?.ask;
      if (ask != null && ask <= b.price + 1e-9) {
        rows.push({
          group: `${m.id}|${mk.key}|${v}`, side: oc.name, book: `${v}-bid`, start: b.start, sport: b.sport, event: b.event,
          market: b.kind, price: b.cost, decimal: 1 / b.cost, ev: b.ev * 100, fairProb: b.fair * 100, source: 'esboard-bid',
        });
        esportsBidLedger.delete(key);
      }
    }
  }
  for (const [key, b] of esportsBidLedger) if (Date.parse(b.start) <= now) esportsBidLedger.delete(key);
  return rows;
}
async function scanEsportsBoard() {
  const st = await esportsBoard.scan();
  const now = Date.now();
  const { rows: edgeRows, fairs: edgeFairs, costs: edgeCosts } = esportsEdgeRows(st.matches, tradableVenue);
  edgeRows.push(...esportsBidFills(st.matches, tradableVenue, now));
  esportsEdgeTracker.recordBoard(edgeRows, edgeFairs, { costs: edgeCosts }).catch(e => console.warn('Esports edge tracker:', e.message));
  // the exchanges' match prices are the match context for player props
  for (const m of st.matches) {
    const main = m.markets.find(mk => mk.kind === 'match');
    const sport = sportKey(m.game);
    if (!main || main.outcomes[0].fair == null || !['CS', 'VAL', 'LOL', 'DOTA', 'COD'].includes(sport) || m.live) continue;
    try {
      oddsBook.set({ sport, teamA: m.teams[0], teamB: m.teams[1], pA: main.outcomes[0].fair, bestOf: m.bestOf || 3, source: 'exchanges', start: m.start, ...(m.bestOf === 1 ? { perMap: true } : {}) });
    } catch { /* a 0 or 1 price: skip */ }
  }
  const lic = webhookLicence();
  const want = [];
  for (const m of st.matches) {
    for (const e of m.edges) {
      if (!tradableVenue(e.venue) || !lic[e.venue] || e.ev < ESPORTS_ALERT_MIN) continue;
      const key = `${m.id}|${e.market}|${e.outcome}|${e.venue}`;
      if (esportsEdgeSeen.has(key) && now - esportsEdgeSeen.get(key) < ESPORTS_REALERT_MS) continue;
      want.push({ m, e, key });
    }
  }
  // like exchange value, a Kalshi edge alerts only with XVALUE_MIN_DEPTH_USD
  // resting at its price (the book is read when the edge is flagged)
  const probes = want.map(({ m, e }) => {
    const q = m.markets.find(mk => mk.key === e.market)?.outcomes.find(oc => oc.name === e.outcome)?.quotes?.[e.venue];
    return { venue: e.venue, marketId: q?.ticker || null, side: q?.side || 'yes', price: q?.ask };
  });
  try { await depthCheck.check(probes.filter(p => p.marketId && p.price > 0)); } catch (err) { console.warn('Esports edges: depth:', err.message); }
  const fresh = [];
  want.forEach(({ m, e, key }, i) => {
    if (e.venue === 'kalshi' && !execcheck.executable(probes[i], XVALUE_MIN_DEPTH)) return;
    if (probes[i].depth) e.depth = probes[i].depth;
    esportsEdgeSeen.set(key, now);
    fresh.push({ m, e });
  });
  for (const [k, at] of esportsEdgeSeen) if (now - at > 2 * 86400e3) esportsEdgeSeen.delete(k);
  // the first scan after a restart only primes (every edge would look new)
  if (fresh.length && esportsBoard.primed) {
    broadcast('esports-edge', fresh.map(({ m, e }) => ({ match: m.id, ...e })));
    postAlert(fresh.map(({ m, e }) => describeEsportsEdge(m, e)), 'Esports edges');
  }
  esportsBoard.primed = true;
  return st;
}
// "CS2 · Spirit vs MOUZ (Bo3, 1:00 PM ET): MOUZ to win on Kalshi at 42¢, fair 45.1¢ (+7.4%) <link>"
function describeEsportsEdge(m, e) {
  const mk = m.markets.find(x => x.key === e.market);
  const what = e.kind === 'map' ? `${e.outcome} to win map ${mk?.n}` : e.kind === 'total' ? `${e.outcome} ${mk?.line} maps` : e.kind === 'spread' ? `${e.outcome} maps` : `${e.outcome} to win`;
  const when = m.start ? new Date(m.start).toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: '2-digit' }) + ' ET' : 'time TBD';
  const link = e.venue === 'kalshi' ? m.links.kalshi : TAIL_REGION === 'us' ? null : m.links.polymarket;
  return `${m.label} · ${m.teams.join(' vs ')} (${m.bestOf ? `Bo${m.bestOf}, ` : ''}${when}): ${what} on ${e.venue === 'kalshi' ? 'Kalshi' : 'Polymarket'} at ${cents(e.cost)}, fair ${cents(e.fair)} (+${(e.ev * 100).toFixed(1)}%)${e.depth ? `, $${e.depth.usd.toLocaleString('en-US')} on the book at that price` : ''}${link ? ` <${link}>` : ''}`;
}
// What one viewer may see of the board: venues they're licensed for, edges
// only on venues they can trade, and Pro for the edges themselves.
function esportsBoardFor(req) {
  const lic = licenceOf(req), pro = hasPro(req);
  const sharpBy = new Map();
  if (lic.polymarket && pro) {
    for (const sig of tailEngine.signals({ limit: 500, type: 'entry' })) {
      if (!sig.conditionId) continue;
      if (!sharpBy.has(sig.conditionId)) sharpBy.set(sig.conditionId, []);
      sharpBy.get(sig.conditionId).push(sig);
    }
  }
  const strip = q => (q ? { ...q } : q);
  return esportsBoard.state.matches.map(m => {
    const links = { ...(lic.kalshi ? { kalshi: m.links.kalshi } : {}), ...(lic.polymarket && TAIL_REGION !== 'us' ? { polymarket: m.links.polymarket } : {}) };
    const sharps = [];
    const markets = m.markets.map(mk => ({
      ...mk,
      arb: mk.arb && mk.arb.legs.every(l => tradableVenue(l.venue) && lic[l.venue]) && pro ? mk.arb : null,
      outcomes: mk.outcomes.map(oc => {
        const quotes = {};
        for (const [v, q] of Object.entries(oc.quotes)) {
          if ((v === 'kalshi' || v === 'polymarket') && !lic[v]) continue;
          const c = strip(q);
          if (!pro || !tradableVenue(v)) { delete c.edge; delete c.bidPlan; if (!pro) { c.ev = null; c.ref = null; } }
          quotes[v] = c;
        }
        const pmq = oc.quotes.polymarket;
        if (pmq?.conditionId && sharpBy.has(pmq.conditionId)) {
          for (const sig of sharpBy.get(pmq.conditionId)) {
            if (sig.outcome && sig.outcome !== oc.name && !esboard.sameTeam(sig.outcome, oc.name)) continue;
            sharps.push({ market: mk.key, outcome: oc.name, name: sig.name || null, wallet: sig.wallet, grade: sig.grade, price: sig.theirPrice ?? sig.price ?? null, units: sig.units ?? null, at: sig.at });
          }
        }
        return { ...oc, quotes, best: oc.best && tradableVenue(oc.best.venue) && lic[oc.best.venue] ? { ...oc.best, ev: pro ? oc.best.ev : null } : null };
      }),
    }));
    const edges = pro ? m.edges.filter(e => tradableVenue(e.venue) && lic[e.venue]) : [];
    const bids = pro ? (m.bids || []).filter(e => tradableVenue(e.venue) && lic[e.venue]) : [];
    return { ...m, links, markets, edges, bids, arbs: pro ? markets.filter(mk => mk.arb).map(mk => ({ market: mk.key, ...mk.arb })) : [], sharps, locked: !pro && m.edges.length > 0, h2h: matchHistory(m) };
  });
}
// Team-vs-team: last meetings and each side's recent form, from the same map
// results the ratings use. Cached per match until the ratings refresh.
const h2hCache = new Map();
function matchHistory(m) {
  const index = ratingsState.games?.[esboard.GAMES[m.game]?.elo];
  if (!index) return null;
  const key = `${m.id}|${m.teams.join('|')}`;
  const hit = h2hCache.get(key);
  if (hit && hit.index === index) return hit.h2h;
  const h2h = headToHead(index, m.teams[0], m.teams[1]);
  if (h2hCache.size > 2000) h2hCache.clear();
  h2hCache.set(key, { index, h2h });
  return h2h;
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
// exchange value: priced off Polymarket, bet on Kalshi or Polymarket US
const valueOk = lic => e => lic.polymarket && (e.venue !== 'kalshi' || lic.kalshi);
const whaleOk = lic => e => !e || (e.exchange === 'kalshi' ? lic.kalshi : e.exchange === 'polymarket' ? lic.polymarket : true);
const withheldOf = (lic, sources) => sources.filter(x => !lic[x]);
// live events for one stream listener
function liveFor(type, data, lic) {
  if (!Array.isArray(data)) return [];
  const out = type === 'tail' ? (lic.polymarket ? data.map(s => venueFor(s, lic)) : [])
    : type === 'whale' ? data.filter(whaleOk(lic)).map(kalshiVenuesOk(lic))
    : type === 'xarb' ? data.filter(arbOk(lic))
    : type === 'xvalue' ? data.filter(valueOk(lic))
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
      .replace(/const BACKEND_URL = '[^']*';/, 'const BACKEND_URL = location.origin;')
      .replace("'__TERMS_VERSION__'", `'${legal.TERMS_VERSION}'`);
  } catch { appHtml = null; }
  return appHtml;
}
legal.mount(app);
// The Learn pages (learn.js): no-vig, EV, CLV, hold and arbs, middles, Kelly,
// exchange fees, pick'em break-evens and how the record decides "proven". Each
// worked example runs through the app's own math when the page renders.
const learn = require('./learn');
const learnCache = new Map();
app.get(['/learn', '/learn/:slug'], (req, res) => {
  const slug = String(req.params.slug || '').toLowerCase().slice(0, 60);
  const canon = slug ? learn.canonicalOf(slug) : '';
  if (canon == null) return res.status(404).type('html').send(learn.render('', { origin: siteOrigin(req) }).replace('<h1>', '<p class="note">That guide does not exist. Here are all of them.</p><h1>'));
  if (slug && canon !== slug) return res.redirect(301, `/learn/${canon}`);
  const o = siteOrigin(req), k = `${o}|${canon}`;
  if (!learnCache.has(k)) { if (learnCache.size > 50) learnCache.clear(); learnCache.set(k, learn.render(canon, { origin: o })); }
  res.set('Cache-Control', 'public, max-age=600').type('html').send(learnCache.get(k));
});
// Installable app: manifest, service worker (root scope) and icons, then the push routes.
const PUB = path.join(__dirname, 'public');
app.get('/manifest.webmanifest', (req, res) => res.set('Cache-Control', 'public, max-age=3600').type('application/manifest+json').sendFile(path.join(PUB, 'manifest.webmanifest')));
app.get('/sw.js', (req, res) => res.set({ 'Cache-Control': 'no-cache', 'Service-Worker-Allowed': '/' }).type('application/javascript').sendFile(path.join(PUB, 'sw.js')));
app.get('/icons/:name', (req, res) => {
  if (!/^[a-z0-9-]+\.png$/.test(req.params.name)) return res.sendStatus(404);
  res.set('Cache-Control', 'public, max-age=86400').sendFile(path.join(PUB, 'icons', req.params.name), e => { if (e && !res.headersSent) res.sendStatus(404); });
});
app.get('/api/push/key', async (req, res) => {
  const key = await push.publicKey();
  if (!key) return res.status(503).json({ error: 'Push is not available right now' });
  res.json({ key, devices: push.devices() });
});
// the alert kinds a device can choose (Settings → Phone app)
app.get('/api/push/kinds', (req, res) => res.json({ kinds: require('./push').KINDS.map(({ key, label }) => ({ key, label })) }));
app.post('/api/push/subscribe', (req, res, next) => (hasPro(req) ? next() : requirePro(req, res, next)), async (req, res) => {
  try { res.json(await push.subscribe(req.body?.subscription, { ua: req.get('user-agent'), kinds: req.body?.kinds })); } catch (e) { sendErr(res, e); }
});
app.post('/api/push/unsubscribe', async (req, res) => {
  try { res.json(await push.unsubscribe(req.body?.endpoint)); } catch (e) { sendErr(res, e); }
});
// this device's own state and choices: only the device knows its endpoint
app.post('/api/push/device', async (req, res) => {
  try { res.json(await push.device(String(req.body?.endpoint || ''))); } catch (e) { sendErr(res, e); }
});
app.post('/api/push/kinds', async (req, res) => {
  try { res.json(await push.setKinds(String(req.body?.endpoint || ''), req.body?.kinds)); } catch (e) { sendErr(res, e); }
});
// "Send me a test": a real push to this one device; the service worker acks once it is on screen
app.post('/api/push/test', async (req, res) => {
  try { res.json(await push.test(String(req.body?.endpoint || ''))); } catch (e) { sendErr(res, e); }
});
app.post('/api/push/ack', (req, res) => res.json(push.ack(req.body?.nonce)));
app.get('/api/push/test/:nonce', (req, res) => {
  const t = push.testStatus(req.params.nonce);
  if (!t) return res.status(404).json({ error: 'No such test' });
  res.json(t);
});
// What is set up, what isn't, and the last deliveries. No endpoints, no keys.
app.get('/api/push/selftest', async (req, res) => {
  try {
    const persistent = process.env.DATABASE_URL ? true : resultsBackup.status().state !== 'off';
    res.json({ ...(await push.selfTest({ persistent })), backup: process.env.DATABASE_URL ? 'postgres' : resultsBackup.status().state });
  } catch (e) { sendErr(res, e); }
});
app.get('/api/push/log', (req, res) => res.json({ deliveries: push.log(Math.min(200, parseInt(req.query.n) || 50)) }));
app.get('/app', (req, res) => {
  const html = loadApp();
  if (!html) return res.status(404).send('App not bundled with this deploy');
  res.set('Cache-Control', 'no-cache').type('html').send(html);
});
// The calculator math the TOOLS tab runs in the browser (the same file the
// tests check), so the page and the tests can't drift apart.
app.get('/calc.js', (req, res) => {
  res.set('Cache-Control', 'public, max-age=300').type('application/javascript').sendFile(path.join(__dirname, 'calc.js'));
});
// MY SLIPS parsing and math (slips.js, window.LRSlips).
app.get('/slips.js', (req, res) => {
  res.set('Cache-Control', 'public, max-age=300').type('application/javascript').sendFile(path.join(__dirname, 'slips.js'));
});
// MY BETS math, the same way (bets.js, window.LRBets; it needs /calc.js first).
app.get('/bets.js', (req, res) => {
  res.set('Cache-Control', 'public, max-age=300').type('application/javascript').sendFile(path.join(__dirname, 'bets.js'));
});
// The public sales page. Prices come from Railway variables so they can change
// without a deploy: PRICE_MONTHLY (default 79), PRICE_INTRO (default 49, 0 hides
// it) for the first INTRO_SEATS members (default 100). While PAYWALL is off the
// page says Pro is free in early access.
// The footer links to /terms, /privacy and /refunds.
const LANDING_FILE = path.join(__dirname, 'public', 'landing.html');
let landingSrc = null;
function landingHtml({ paywall = PAYWALL, env = process.env, origin = '' } = {}) {
  if (landingSrc == null) { try { landingSrc = fs.readFileSync(LANDING_FILE, 'utf8'); } catch { return null; } }
  const num = (v, d) => { const n = parseFloat(v); return Number.isFinite(n) && n >= 0 ? n : d; };
  const money = n => (Number.isInteger(n) ? String(n) : n.toFixed(2));
  const price = num(env.PRICE_MONTHLY, 79), intro = num(env.PRICE_INTRO, 49), seats = Math.round(num(env.INTRO_SEATS, 100));
  const vals = {
    PRICE: money(price), INTRO_PRICE: money(intro), INTRO_SEATS: String(seats),
    INTRO_VISIBILITY: intro > 0 && intro < price && seats > 0 ? 'visible' : 'hidden',
    EARLY_DISPLAY: paywall ? 'none' : 'block',
    // without AUTH_SECRET there are no accounts yet, so the buttons just open the app
    SIGNUP_LABEL: env.AUTH_SECRET ? 'Create a free account' : 'Start free',
    LOGIN_DISPLAY: env.AUTH_SECRET ? 'inline-flex' : 'none',
    CONTACT_HREF: String(env.LEGAL_EMAIL || '').trim() ? `mailto:${String(env.LEGAL_EMAIL).trim().replace(/[^\w.+@-]/g, '')}` : '/legal#contact',
    ORIGIN: String(origin).replace(/[^\w.:/-]/g, ''),
  };
  return landingSrc.replace(/\{\{([A-Z_]+)\}\}/g, (m, k) => (k in vals ? vals[k] : m));
}
// PUBLIC_URL (e.g. https://linereaper.com) wins once a domain is set up
const siteOrigin = req => String(process.env.PUBLIC_URL || `https://${req.get('host')}`).replace(/\/+$/, '');
// the share card, and what search engines may crawl: the sales page and the
// legal pages, not the API
app.get('/og.png', (req, res) => res.set('Cache-Control', 'public, max-age=86400').sendFile(path.join(__dirname, 'public', 'og.png')));
app.get('/robots.txt', (req, res) => res.type('text/plain').send(`User-agent: *\nAllow: /$\nAllow: /app\nAllow: /learn\nDisallow: /api/\nSitemap: ${siteOrigin(req)}/sitemap.xml\n`));
app.get('/sitemap.xml', (req, res) => {
  const o = siteOrigin(req);
  const urls = ['/', '/app', '/learn', ...learn.ORDER.map(k => `/learn/${k}`), ...legal.ORDER.map(k => `/${k}`)];
  res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map(u => `  <url><loc>${o}${u}</loc></url>`).join('\n')}\n</urlset>\n`);
});
// Browsers opening the bare URL get the sales page; API clients (and the app's
// own health check, which sends Accept: */*) still get the JSON status.
app.get('/', (req, res) => {
  if (req.accepts(['json', 'html']) === 'html' && /text\/html/.test(req.get('accept') || '')) {
    const html = landingHtml({ origin: siteOrigin(req) });
    if (html) return res.set('Cache-Control', 'no-cache').type('html').send(html);
    if (loadApp()) return res.redirect('/app');
  }
  res.json({ status: 'Line Reaper backend running', version: '3.166.1', updated: new Date().toISOString() });
});

// ── ACCOUNTS + BILLING ────────────────────────────────────────────────────────
const sendErr = (res, e) => res.status(e.status || 500).json({ error: e.status ? e.message : 'Something went wrong' });

app.post('/api/auth/signup', async (req, res) => {
  try {
    const consent = { terms: req.body?.acceptTerms === true, age: req.body?.confirmAge === true, version: req.body?.termsVersion, ip: (req.get('x-forwarded-for') || '').split(',')[0].trim() || req.ip };
    res.status(201).json(await auth.signup(req.body?.email, req.body?.password, consent));
  }
  catch (e) { sendErr(res, e); }
});
app.post('/api/auth/login', async (req, res) => {
  try { res.json(await auth.login(req.body?.email, req.body?.password)); }
  catch (e) { sendErr(res, e); }
});
// Delete your own account (privacy rights). Needs the password, and a paid
// subscription has to be cancelled first so nobody is billed for a deleted account.
app.post('/api/auth/delete', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Log in first' });
  try { res.json(await auth.deleteAccount(req.user, req.body?.password)); }
  catch (e) { sendErr(res, e); }
});
// the terms version the app asks people to accept
app.get('/api/legal', (req, res) => res.json({ termsVersion: legal.TERMS_VERSION, minAge: legal.MIN_AGE, pages: legal.ORDER.map(k => ({ slug: k, path: `/${k}`, title: legal.PAGES[k].title })) }));
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
    const origin = `${(req.get('x-forwarded-proto') || req.protocol).split(',')[0].trim()}://${req.get('host')}`;
    res.json(await billing.checkout(req.user, { successUrl: `${back}${sep}upgraded=1`, cancelUrl: back, legalUrl: origin }));
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
  // ?state=TX: only venues a resident of that state can use (venues.js)
  const inState = venues.rowLegalIn(req.query.state);
  const rows = all.filter(evRowOk(licenceOf(req))).filter(inState);
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
    (!q.source || r.source === q.source) &&
    (q.agree !== '1' || r.agree));
  const total = out.length;
  // the bar: +2% with two sharp sources agreeing (sportsbook rows; the
  // pick'em legs have their own consensus on the PROPS board)
  const clear = rows.filter(r => !r.dfs && r.ev >= 2);
  const counts = { clear2: clear.length, agree2: clear.filter(r => r.agree).length,
    agree2Lines: clear.filter(r => r.agree && !r.player).length, agree2Props: clear.filter(r => r.agree && r.player).length };
  out = out.slice(0, Math.min(parseInt(q.limit) || 200, 1000));
  // ladders and alternate lines: their own list (clearing rungs first)
  const alt = (runEvScreen().alt || []).filter(evRowOk(licenceOf(req))).filter(inState).filter(r => !q.sport || r.sport === q.sport);
  counts.alt = alt.length; counts.altClear = alt.filter(r => r.clears).length;
  const altOut = alt.slice(0, 300);
  // BetRivers' esports lines: their own list too (esbooks.js)
  const es = (esBooksState.rows || []).filter(evRowOk(licenceOf(req))).filter(inState).filter(r => !q.sport || r.sport === q.sport);
  counts.esports = es.length; counts.esportsClear = es.filter(r => r.clears).length;
  const esOut = es.slice(0, 300);
  // books and apps still on the number Pinnacle just left (stalelines.js)
  const stale = (staleState.rows || []).filter(evRowOk(licenceOf(req))).filter(inState).filter(r => !q.sport || r.sport === q.sport);
  counts.stale = stale.length; counts.staleClear = stale.filter(r => r.clears).length;
  const staleOut = stale.slice(0, 300);
  // esports: one pick'em app moved a kill line, another hasn't (esstale.js)
  const esStale = (esStaleState.rows || []).filter(r => !q.sport || r.sport === q.sport).map(r => ({ ...r, es: true, book: r.app, marketLabel: r.market })).filter(inState);
  counts.esStale = esStale.length; counts.esStaleClear = esStale.filter(r => r.clears).length;
  const esStaleOut = esStale.slice(0, 200);
  res.json({ rows: pro ? out : redactEv(out), alt: pro ? altOut : redactEv(altOut).map(r => ({ ...r, alt: true })),
    esports: pro ? esOut : redactEv(esOut).map(r => ({ ...r, esports: true })), esportsAt: esBooksState.screenedAt,
    // free users see a lock per row the Pro view shows at its default floor (+1%)
    stale: pro ? staleOut : redactEv(staleOut.filter(r => r.ev >= 1)).map(r => ({ ...r, stale: true })), staleAt: staleState.screenedAt, staleLag: staleState.enabled ? staleState.engine.lagSummary() : null,
    esStale: pro ? esStaleOut : redactEv(esStaleOut.filter(r => r.ev >= 1)).map(r => ({ ...r, es: true, stale: true })), esStaleAt: esStaleState.screenedAt, esStaleLag: esStaleState.enabled ? esStaleState.engine.lagSummary() : null,
    count: total, counts, pro, updated: new Date(at).toISOString(), feeds, state: venues.stateInfo(req.query.state) });
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
  const inState = venues.legalIn(q.state);
  if (out?.byBook) out.byBook = Object.fromEntries(Object.entries(out.byBook).filter(([book]) => ok({ book }) && inState(book)));
  out.state = venues.stateInfo(q.state);
  // the ladders' and alternate lines' record, apart from the main lines'
  out.alt = await altTracker.summary({ sport: q.sport, book: q.book, source: q.source, sinceDays: parseFloat(q.days) || undefined });
  out.esports = await esBookTracker.summary({ sport: q.sport, book: q.book, source: q.source, sinceDays: parseFloat(q.days) || undefined });
  // stale lines: the books' rows here, the apps' legs from the props record
  out.stale = await staleTracker.summary({ sport: q.sport, book: q.book, source: q.source, sinceDays: parseFloat(q.days) || undefined });
  // the props record has no sport cut: with one asked for, the apps' lines stay off
  const kinds = q.sport ? {} : (await sportTracker.summary({ sinceDays: parseFloat(q.days) || undefined })).byKind || {};
  out.staleApps = q.sport ? null : { stale: kinds.stale || null, single: kinds['stale-single'] || null };
  // esports: legs at an app another app had just moved away from, graded on the result
  try { const es = await esStaleTracker.summary(); out.esStale = { overall: es.overall, byBook: es.byBook, open: es.counts.open + es.counts.locked, mkt: es.overall }; }
  catch { out.esStale = null; }
  res.json(out);
});
// Every book and every kind against the close (closeboard.js): graded toward
// 50, beat-the-close rate, CLV and the tracker's own mark. Free: it's the
// record. A Kalshi or Polymarket row needs its licence, as on /api/ev/record.
const closeBoard = require('./closeboard');
const closeBoardCache = new Map();   // key → { at, body }
// the scoreboard for a viewer's licences (the webhook's when none), cached a minute
// state (venues.js): only the venues a resident there can use, every total
// re-pooled from those; none for the alert gate, which is the same for everyone
async function closeBoardFor(lic = webhookLicence(), days = 0, state = null) {
  const inState = venues.rowLegalIn(state);
  const ok = r => evRowOk(lic)(r) && inState(r);
  const key = `${JSON.stringify(lic)}|${days}|${venues.stateOf(state) || ''}`;
  const hit = closeBoardCache.get(key);
  if (!hit || Date.now() - hit.at > 60e3) {
    const all = { status: undefined, limit: 1e9 };
    const [ev, alt, stale, esports, props, bigMoney] = await Promise.all([evTracker.list(all), altTracker.list(all), staleTracker.list(all),
      esBookTracker.list(all), sportTracker.list({ limit: 1e9 }), bigTracker.list()]);
    const body = closeBoard.scoreboard({ ev: ev.filter(ok), alt: alt.filter(ok), stale: stale.filter(ok), esports: esports.filter(ok),
      props: props.filter(r => venues.legalIn(state)(closeBoard.propsVenue(r))), bigMoney: bigMoney.filter(inState) },
      { since: days > 0 ? Date.now() - days * 86400e3 : 0 });
    closeBoardCache.set(key, { at: Date.now(), body: { ...body, state: venues.stateInfo(state), at: new Date().toISOString() } });
  }
  return closeBoardCache.get(key).body;
}
app.get('/api/ev/scoreboard', async (req, res) => {
  try {
    res.json(await closeBoardFor(licenceOf(req), parseFloat(req.query.days) || 0, req.query.state));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/ev/record/bets', async (req, res) => {
  // open bets are today's live edges, so only closed ones are free
  const status = hasPro(req) ? req.query.status : 'closed';
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  // ?book=fanduel&source=alt&sport=nhl narrow the list; ?before=<flaggedAt> pages back
  const q = k => (typeof req.query[k] === 'string' && req.query[k]) || undefined;
  const bets = (await (req.query.alt === '1' ? altTracker : req.query.es === '1' ? esBookTracker : req.query.stale === '1' ? staleTracker : evTracker)
    .list({ status, limit: limit * 2, book: q('book'), source: q('source'), sport: q('sport'), before: q('before') })).filter(evRowOk(licenceOf(req))).slice(0, limit);
  res.json({ bets });
});
// one subject's line history on every source (stale lines), e.g. ?key=pin-123|spread
app.get('/api/stale/history', requirePro, (req, res) => {
  const h = staleState.engine.history(String(req.query.key || ''));
  if (!h) return res.json({ error: 'no such subject' });
  // Kalshi's prices need its licence, as on /api/ev
  if (!licenceOf(req).kalshi) delete h.sources.kalshi;
  res.json(h);
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
  if (hiddenWallets().includes(String(req.params.wallet).toLowerCase())) return res.status(404).json({ error: 'That wallet has not been scored yet' });
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
  try { const r = await freshTracker.summary({}); freshRecord = { overall: r.overall, clustered: r.clustered, texas: r.texas, firstBet: r.firstBet, firstBetTexas: r.firstBetTexas, backtest: FRESH_BACKTEST, open: r.open }; } catch { /* store down */ }
  res.json(regionSafe({
    freshRecord,
    events: pro ? events : events.map(e => maskWhale(e, t)),
    flow: pro ? flow : flow.map(f => ({ ...f, largest: maskWhale(f.largest, t) })),
    pro, minUsd: whaleWatcher.settings().minUsd, windowMs: whaleWatcher.settings().windowMs, state: pro ? whaleWatcher.state() : publicWhaleState(whaleWatcher.state()),
    ...withheldBody(withheldOf(lic, ['kalshi', 'polymarket'])),
  }));
});
// Exchange arbs, best first, and `near`: the watchlist of pairs and sets just
// short of one (xarb.findNearArbs). ?type=cross|multi|book&category=sports&minPct=1.
// `bids`: pairs a limit bid on one venue and a take on the other would lock
// (xarb.findBidArbs). `middles`: a total or spread at two lines on two venues
// (xarb.findMiddles).
// Stakes are the same for everyone: each leg's `pct` of the total (and the
// $100 reference split in `stakes`). US mode only has Kalshi and US
// sportsbook legs. Free: count and profit % only.
app.get('/api/xarbs', async (req, res) => {
  const pro = hasPro(req), lic = licenceOf(req);
  const q = req.query;
  const minPct = parseFloat(q.minPct);
  const arbs = xarbState.arbs.filter(arbOk(lic))
    .filter(a => (!q.type || a.type === q.type) && (!q.category || a.category === q.category) && (!Number.isFinite(minPct) || a.profitPct >= minPct));
  const near = (xarbState.near || []).filter(arbOk(lic)).filter(a => !q.category || a.category === q.category);
  const bids = (xarbState.bids || []).filter(arbOk(lic)).filter(a => !q.category || a.category === q.category);
  const middles = (xarbState.middles || []).filter(arbOk(lic));
  let bidRecord = null, middleRecord = null;
  let bookRecord = null;
  try { [bidRecord, middleRecord, bookRecord] = await Promise.all([bidTracker.summary(), middleTracker.summary(), bookArbTracker.summary()]); } catch { /* store down */ }
  // sportsbook pairs (bookarbs.js): FanDuel, BetRivers, Kalshi, Polymarket US
  const bookArbList = bookArbState.arbs.filter(arbOk(lic)), bookMiddleList = bookArbState.middles.filter(arbOk(lic));
  const books = { arbCount: bookArbList.length, middleCount: bookMiddleList.length, updated: bookArbState.updated, record: bookRecord };
  const base = { count: arbs.length, nearCount: near.length, bidCount: bids.length, middleCount: middles.length, bidRecord, middleRecord, updated: xarbState.updated, pro, region: TAIL_REGION, ...withheldBody(withheldOf(lic, TAIL_REGION === 'us' ? ['kalshi'] : ['kalshi', 'polymarket'])) };
  if (!pro) return res.json({ ...base, books: { ...books, arbs: bookArbList.map(a => ({ profitPct: a.profitPct, locked: true })) }, arbs: arbs.map(a => ({ profitPct: a.profitPct, locked: true })) });
  res.json(regionSafe({
    ...base, books: { ...books, arbs: bookArbList, middles: bookMiddleList.slice(0, 60), counts: bookArbState.counts },
    arbs: arbs.slice(0, Math.min(parseInt(q.limit) || 200, 1000)), near, bids, middles,
    minPct: XARB_OPTS.minPct ?? xarb.DEFAULTS.minPct, counts: xarbState.counts, errors: xarbState.errors.slice(0, 5),
  }));
});
// Book arbs' fill record (bookarbtrack.js): each row and its +2 min check. ?limit=200
app.get('/api/book-arbs/record', async (req, res) => {
  try {
    const summary = await bookArbTracker.summary();
    if (!hasPro(req)) return res.json({ summary });
    res.json({ summary, rows: await bookArbTracker.list({ limit: Math.min(parseInt(req.query.limit) || 200, 2000) }) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// The exchanges' odds screen (xarb.exchangeScreen): games in the next 36
// hours, each side's all-in price on Kalshi and Polymarket US. Free: the count.
app.get('/api/xscreen', (req, res) => {
  const pro = hasPro(req), lic = licenceOf(req);
  // without Kalshi's data licence its prices are left out, not the games
  // without Polymarket's, the fair column (its mid) is
  const rows = (xarbState.screen || [])
    .map(r => (lic.kalshi ? r : { ...r, sides: r.sides.map(x => ({ ...x, kalshi: null, kalshiUrl: null, best: x.other != null ? r.venue : null, gap: null, ev: x.fair != null && x.other != null ? Math.round((x.fair / x.other - 1) * 1e4) / 1e4 : null })) }))
    .map(r => (lic.polymarket ? r : { ...r, maxEv: null, sides: r.sides.map(x => ({ ...x, fair: null, ev: null })) }))
    .map(r => { const evs = r.sides.map(x => x.ev).filter(e => e != null); return { ...r, maxEv: evs.length ? Math.max(...evs) : null }; });
  const base = { count: rows.length, updated: xarbState.updated, pro, region: TAIL_REGION };
  if (!pro) return res.json(base);
  res.json(regionSafe({ ...base, rows }));
});
// Gas locks (gaslocks.js): tonight's plays, the record and the backtest.
// Free: the count and the record; the plays are Pro, and need Kalshi's licence.
app.get('/api/gas-locks', async (req, res) => {
  try {
    const pro = hasPro(req), lic = licenceOf(req);
    const record = await gasTracker.summary();
    const recent = (await gasTracker.list()).filter(r => r.status === 'graded').sort((a, b) => (b.gradedAt || '').localeCompare(a.gradedAt || '')).slice(0, 50);
    const plays = lic.kalshi ? gasState.plays : [];
    const base = { count: plays.length, updated: gasState.updated, pro, record, backtest: gaslocks.BACKTEST,
      rule: { states: gaslocks.DEFAULTS.states, minPrice: gaslocks.DEFAULTS.minPrice, maxPrice: gaslocks.DEFAULTS.maxPrice, maxSpread: gaslocks.DEFAULTS.maxSpread, fromHours: gaslocks.DEFAULTS.fromHours, toHours: gaslocks.DEFAULTS.toHours, minDepthUsd: gaslocks.DEFAULTS.minDepthUsd },
      off: process.env.GAS_LOCKS === 'off', ...withheldBody(withheldOf(lic, ['kalshi'])) };
    if (!pro) return res.json({ ...base, recent });
    res.json({ ...base, plays, recent, counts: gasState.counts, errors: gasState.errors });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Live esports maps (esinplay.js): the record (free), the live board and the flags (Pro, Kalshi licence).
app.get('/api/esports/inplay', async (req, res) => {
  try {
    const pro = hasPro(req), lic = licenceOf(req);
    const rows = await inplayTracker.list();
    const summary = esinplay.summarize(rows);
    const recent = rows.filter(r => r.status === 'graded').sort((a, b) => (b.flaggedAt || '').localeCompare(a.flaggedAt || '')).slice(0, 40);
    const base = { updated: inplayLive.state.updated, pro, summary, rule: esinplay.DEFAULTS, models: Object.fromEntries(Object.entries(esinplay.MODELS).map(([g, m]) => [g, m ? m.kind : null])),
      fit: esinplay.INPLAY_FITS, counts: inplayLive.state.counts, off: process.env.ESPORTS_INPLAY === 'off',
      note: 'Our live win probability against Kalshi\'s in-play ask, fee included, with the size resting there. Records only: nothing alerts, nothing trades. Counted toward 50 graded: the first flag per map and team.',
      ...withheldBody(withheldOf(lic, ['kalshi'])) };
    if (!pro || !lic.kalshi) return res.json({ ...base, recent });
    const open = rows.filter(r => r.status === 'open').sort((a, b) => (b.flaggedAt || '').localeCompare(a.flaggedAt || '')).slice(0, 40);
    res.json({ ...base, recent, open, live: inplayLive.state.live, errors: inplayLive.state.errors });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// BIG MONEY (bigmoney.js): big exchange prints and the same bet at every
// venue. ?minUsd=2500 &mm=1 (market makers too) &kind=prop|game. Free: the count only.
app.get('/api/big-money', async (req, res) => {
  try {
    const pro = hasPro(req), lic = licenceOf(req), q = req.query;
    const record = await bigTracker.summary();
    const recent = (await bigTracker.list()).filter(r => r.status === 'graded').sort((a, b) => (b.gradedAt || '').localeCompare(a.gradedAt || '')).slice(0, 40)
      .map(({ why, prop, game, ...r }) => r);
    const minUsd = Number.isFinite(parseFloat(q.minUsd)) ? parseFloat(q.minUsd) : BIG_OPTS.minUsd;
    const shown = p => (p.money.exchanges || [p.money.exchange]).every(x => (x === 'kalshi' ? lic.kalshi : x === 'polymarket' ? lic.polymarket : true));
    let plays = bigState.plays.filter(p => shown(p) && p.money.usd >= minUsd - 1e-6 && (!q.kind || p.kind === q.kind));
    const hiddenMm = plays.filter(p => p.flow === 'market maker').length;
    if (!/^(1|true|on)$/i.test(String(q.mm || ''))) plays = plays.filter(p => p.flow !== 'market maker');
    plays = plays.map(({ money: { wallets, ...m }, ...p }) => ({ ...p, money: { ...m, wallets: wallets?.length || 0 } }));
    const base = { count: plays.length, flagged: plays.filter(p => p.flagged).length, hiddenMarketMakers: hiddenMm, updated: bigState.updated, pro, record,
      settings: { minUsd: BIG_OPTS.minUsd, minEv: BIG_OPTS.minEv, twoWayShare: BIG_OPTS.twoWayShare, flowWindowMs: BIG_OPTS.flowWindowMs },
      backtest: bigMoney.BACKTEST, off: process.env.BIG_MONEY === 'off', ...withheldBody(withheldOf(lic, ['kalshi', 'polymarket'])) };
    if (!pro) return res.json({ ...base, recent });
    res.json({ ...base, plays, recent, counts: bigState.counts, errors: bigState.errors });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Exchange value (xvalue.js): Kalshi and Polymarket US asks under Polymarket's
// live mid, best first, plus how the flagged prices did against the close.
// Free: the count and the edges' sizes only.
app.get('/api/exchange-value', async (req, res) => {
  try {
    const pro = hasPro(req), lic = licenceOf(req);
    const edges = xvalueState.edges.filter(valueOk(lic));
    const record = await xvalueTracker.summary({ sinceDays: parseFloat(req.query.days) || undefined });
    const moved = !lic.polymarket ? [] : (xvalueState.movers || []).map(m => ({ ...m, venues: m.venues.filter(v => v.venue !== 'kalshi' || lic.kalshi) }))
      .filter(m => m.venues.length).map(m => ({ ...m, best: m.venues[0] }));
    const base = { count: edges.length, steamCount: edges.filter(e => e.steam).length, moverCount: moved.length, updated: xvalueState.updated, pro, region: TAIL_REGION, venues: XVALUE_VENUES, record,
      ...withheldBody(withheldOf(lic, ['polymarket', 'kalshi'])) };
    if (!pro) return res.json({ ...base, edges: edges.map(e => ({ ev: e.ev, locked: true })) });
    res.json(regionSafe({ ...base, edges: edges.slice(0, Math.min(parseInt(req.query.limit) || 200, 500)), movers: moved, counts: xvalueState.counts,
      settings: { ...xvalue.DEFAULTS, ...XVALUE_OPTS, alertMin: XVALUE_ALERT_MIN, booksPerScan: XVALUE_BOOKS, steam: { ...steamWatch.opts, alertMin: STEAM_ALERT_MIN }, executable: { minDepthUsd: XVALUE_MIN_DEPTH, ...XVALUE_EXEC, lagMin: 2 } } }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Each tracked exchange value bet with its grades (at the alert, at the best
// price 2 min later, and at $100 through the book then), newest first. Open
// bets are live edges, so only closed ones are free.
app.get('/api/exchange-value/bets', async (req, res) => {
  try {
    const status = hasPro(req) ? req.query.status : 'closed';
    const limit = Math.min(parseInt(req.query.limit) || 100, 1000);
    const ok = valueOk(licenceOf(req));
    const bets = (await xvalueTracker.list({ status, limit: 1e9 })).filter(b => ok({ venue: b.book }))
      .sort((a, b) => Date.parse(b.flaggedAt) - Date.parse(a.flaggedAt)).slice(0, limit);
    res.json(regionSafe({ bets }));
  } catch (e) { res.status(500).json({ error: e.message }); }
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
// The match board. ?game=CS2&edges=1 (only matches with an edge)&live=0 (pre-match only)
app.get('/api/esports/matches', (req, res) => {
  let matches = esportsBoardFor(req);
  const game = String(req.query.game || '').toUpperCase();
  if (game && game !== 'ALL') matches = matches.filter(m => m.game === game);
  if (req.query.edges === '1') matches = matches.filter(m => m.edges.length || m.arbs.length);
  if (req.query.live === '0') matches = matches.filter(m => !m.live);
  const st = esportsBoard.state;
  res.json({
    matches, count: matches.length, updated: st.updated, counts: st.counts, calibration: st.calibration, errors: st.errors.slice(0, 5), pro: hasPro(req), region: TAIL_REGION,
    games: Object.fromEntries(Object.entries(esboard.GAMES).map(([k, g]) => [k, g.label])),
    rules: { edgeMin: esboard.DEFAULTS.edgeMin, ...ESPORTS_OPTS, alertMin: ESPORTS_ALERT_MIN },
  });
});
// ── matchups (head-to-head engine): LoL, CS2, VALORANT ──
const GAME_WORD = { LOL: 'LoL', CS2: 'CS2', VAL: 'VALORANT' };
const matchupNote = game => `Our own model: team ratings from every finished ${GAME_WORD[game] || game} series, a series-shape adjustment and a small head-to-head term. It is a model, not a proven edge: in the walk-forward backtest Kalshi's price beat it, and betting its side lost after fees.`;
// ?game= picks the engine (default LoL); null when that game is off
const engineFor = req => matchupEngines[String(req.query.game || 'LOL').toUpperCase()] || null;
function matchupBacktestSummary(engine = matchupEngine) {
  const b = engine?.state.backtest;
  if (!b) return null;
  const k = b.kalshi?.['T-60'], k30 = b.kalshi?.['T-30'];
  return {
    generated: b.generated, verdict: b.verdict, data: b.data,
    allSeries: { test: b.allSeries?.test, coinFlip: b.allSeries?.coinFlip },
    kalshi: k ? { n: k.n, logLoss: k.logLoss, brier: k.brier, t: k.llGapT, sides5: k.bets?.find(x => x.edgePts === 5) || null, major: k.major?.logLoss, other: k.other?.logLoss } : null,
    kalshi30: k30 ? { n: k30.n, logLoss: k30.logLoss } : null,
  };
}
const matchupOff = (res, req) => res.status(503).json({ error: MATCHUPS_ON ? `No matchup engine for ${String(req?.query?.game || 'LOL').toUpperCase()} (ESPORTS_MATCHUPS_GAMES=${MATCHUP_GAMES.join(',')}).` : 'Matchups are off (ESPORTS_MATCHUPS=off).', games: Object.keys(matchupEngines) });
app.get('/api/esports/matchups', (req, res) => {
  const E = engineFor(req);
  if (!E) return matchupOff(res, req);
  const game = E.status().game;
  const days = Math.min(14, Math.max(1, parseInt(req.query.days, 10) || 8));
  const league = req.query.league ? String(req.query.league) : null;
  const matchups = E.list({ days, league, board: esportsBoardFor(req) });
  res.json({
    game, label: 'model', note: matchupNote(game), games: Object.keys(matchupEngines), status: E.status(), count: matchups.length,
    priced: matchups.filter(m => m.model.priced).length, withKalshi: matchups.filter(m => m.markets?.kalshi).length,
    leagues: [...new Set(matchups.map(u => u.league).filter(Boolean))].sort(),
    matchups, backtest: matchupBacktestSummary(E), record: E.record().summary, licence: licenceState(req),
  });
});
app.get('/api/esports/matchups/backtest', (req, res) => {
  const E = engineFor(req);
  if (!E) return matchupOff(res, req);
  res.json(E.state.backtest || { error: `No backtest file for ${E.status().game}.` });
});
app.get('/api/esports/matchups/record', (req, res) => {
  const E = engineFor(req);
  if (!E) return matchupOff(res, req);
  res.json({ note: `Model number frozen 10-45 minutes before each ${GAME_WORD[E.status().game]} series with a Kalshi price, Kalshi followed to the start, graded on the result. Model view, not a bet.`, ...E.record() });
});
app.get('/api/esports/matchups/ratings', (req, res) => {
  const E = engineFor(req);
  if (!E) return matchupOff(res, req);
  const R = E.ratings();
  const league = req.query.league ? String(req.query.league) : null;
  res.json({ game: E.status().game, label: 'model', leagues: R.leagues(), teams: R.table({ league }).slice(0, 300), opts: R.opts });
});
app.get('/api/esports/matchups/team/:name', (req, res) => {
  const E = engineFor(req);
  if (!E) return matchupOff(res, req);
  const R = E.ratings();
  const tm = R.find(req.params.name);
  if (!tm) return res.status(404).json({ error: `No such team in our ${GAME_WORD[E.status().game]} data.` });
  res.json({ game: E.status().game, label: 'model', team: R.teamView(tm) });
});
app.get('/api/esports/matchups/:id', (req, res) => {
  const E = engineFor(req);
  if (!E) return matchupOff(res, req);
  const m = E.get(req.params.id, { board: esportsBoardFor(req) });
  if (!m) return res.status(404).json({ error: `No upcoming ${GAME_WORD[E.status().game]} series with that id.` });
  res.json({ game: E.status().game, label: 'model', note: matchupNote(E.status().game), matchup: m });
});
// one build at a time: a page load and a refresh share a run in flight.
// Two builds at once (new stats landing during a lines rebuild) could finish
// out of order and leave the older board up, and both would log and alert.
let esPicksRun = null, esPicksAgain = false;
function esPicksOnce() {
  if (!esPicksRun) esPicksRun = generateEsportsPicks().finally(() => {
    esPicksRun = null;
    if (esPicksAgain) { esPicksAgain = false; esPicksOnce().catch(() => {}); }
  });
  return esPicksRun;
}
// new data landed: build now, or once more when the build in flight is done
function esPicksRebuild() {
  if (esPicksRun) { esPicksAgain = true; return esPicksRun; }
  return esPicksOnce();
}
// Pinnacle team kill gaps: the record by gap size, and the plays (pingap.js)
app.get('/api/esports/pingaps', async (req, res) => {
  try {
    const rows = await pinGapTracker.list({ limit: 5000 });
    res.json({ note: 'Plays on Pinnacle\'s side where its team kills and the books\' five players part by 3%+. Tracked to test the gap; not priced or alerted.',
      teamsNow: esportsCache.pinTeams || 0, playsNow: esportsCache.pinGapPlays || 0,
      record: pingap.gapRecord(rows), totals: pinTotalsSummary(), rows: rows.slice(0, +req.query.limit || 500) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Pinnacle's map totals against the maps played (pintotals.js): the scoreboard
// by title, what the kill models use now (fitted or assumed), and the rows
function pinTotalsSummary() {
  const rows = [...pinTotals.rows.values()];
  return { graded: rows.filter(r => r.status === 'graded').length, open: rows.filter(r => r.status === 'open').length,
    close: pintotals.scoreboard(rows), signal: pintotals.scoreboard(rows, { snap: 'signal' }), fit: pinTotals.fit, minMaps: pintotals.DEFAULTS.minMaps, last: pinTotals.last };
}
app.get('/api/esports/pintotals', async (req, res) => {
  try {
    await pinTotals.ready;
    const rows = [...pinTotals.rows.values()].sort((a, b) => String(b.start).localeCompare(String(a.start)));
    const status = req.query.status;
    res.json({ note: `Pinnacle's pregame totals on each map (rounds for CS2 and Valorant, team kills for LoL and Dota) against the maps played. err = actual - Pinnacle's 50/50 point; over = how often the over at its main line hit, next to the chance Pinnacle gave it. The kill models use a title's fitted spread once it has ${pintotals.DEFAULTS.minMaps} graded maps; until then the assumed one.`,
      ...pinTotalsSummary(), rows: rows.filter(r => !status || r.status === status).slice(0, Math.min(+req.query.limit || 300, 3000)) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Kill-share plays: the record (sharemodel.js) and today's priced lines
app.get('/api/esports/share', async (req, res) => {
  try {
    const rows = await shareTracker.list({ limit: 5000 });
    const priced = (esportsCache.picks || []).filter(p => p.share?.priced).map(p => ({ player: p.player, team: p.team, sport: p.sport, market: p.market, startTime: p.startTime,
      share: p.share.share, raw: p.share.raw, games: p.share.games, pinPerMap: p.share.pinPerMap, mean: p.share.mean, pinMean: p.share.pinMean, marketPred: p.marketPred,
      lines: esgaps.bookLines(p), best: p.share.priced }));
    const graded = rows.filter(r => r.status === 'graded').length;
    res.json({ note: `Pinnacle's team kills x each player's share of his team's kills. ${graded ? `${graded} graded` : 'Not graded yet'}; tracked, not alerted.`,
      now: esportsCache.share || null, minEv: SHARE_OPTS.minEv, agreePts: SHARE_OPTS.agreePts,
      record: sharemodel.shareRecord(rows), priced: hasPro(req) ? priced : priced.length, rows: hasPro(req) ? rows.slice(0, +req.query.limit || 500) : rows.filter(r => r.status === 'graded').slice(0, 500) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Head-to-head plays: the record (h2hmodel.js), today's priced lines and the
// data behind them
app.get('/api/esports/h2h', async (req, res) => {
  try {
    const rows = await h2hTracker.list({ limit: 5000 });
    const priced = (esportsCache.picks || []).filter(p => p.h2h?.priced).map(p => ({ player: p.player, team: p.team, sport: p.sport, market: p.market, startTime: p.startTime,
      game: p.h2h.game, mean: p.h2h.mean, perMap: p.h2h.perMap, own: p.h2h.own, share: p.h2h.share, teamKills: p.h2h.teamKills, vs: p.h2h.opp, scenarios: p.h2h.scenarios,
      shareMean: p.share?.mean ?? null, marketPred: p.marketPred, lines: esgaps.bookLines(p), best: p.h2h.priced }));
    const graded = rows.filter(r => r.status === 'graded').length;
    res.json({ note: `Our matchup model: each player's share of his team's kills x the kills his team makes against this opponent. A leg is a play only where Pinnacle's kill-share fair agrees. ${graded ? `${graded} graded` : 'Not graded yet'}; tracked, not alerted.`,
      on: H2H_ON, now: esportsCache.h2h || null, minEv: H2H_OPTS.minEv, agreePts: H2H_OPTS.agreePts,
      data: { refreshedAt: h2hState.refreshedAt, added: h2hState.added, errors: h2hState.errors, golAt: h2hState.golAt },
      params: h2hmodel.TITLES,
      record: h2hmodel.h2hRecord(rows), priced: hasPro(req) ? priced : priced.length, rows: hasPro(req) ? rows.slice(0, +req.query.limit || 500) : rows.filter(r => r.status === 'graded').slice(0, 500) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Round-model plays: the record (roundmodel.js) and today's priced lines
app.get('/api/esports/rounds', async (req, res) => {
  try {
    const rows = await roundsTracker.list({ limit: 5000 });
    const priced = (esportsCache.picks || []).filter(p => p.rounds?.priced).map(p => ({ player: p.player, team: p.team, sport: p.sport, market: p.market, startTime: p.startTime,
      kpr: p.rounds.kpr, raw: p.rounds.raw, maps: p.rounds.maps, scale: p.rounds.scale, lineup: p.rounds.lineup, roundsPerMap: p.rounds.roundsPerMap, qs: p.rounds.ctx.qs,
      mean: p.rounds.mean, pinMean: p.rounds.pinMean, marketPred: p.marketPred, lines: esgaps.bookLines(p), best: p.rounds.priced }));
    const graded = rows.filter(r => r.status === 'graded').length;
    res.json({ note: `Pinnacle's rounds on each map x the player's kills a round (CS2, Valorant). ${graded ? `${graded} graded` : 'Not graded yet'}; tracked, not alerted.`,
      now: esportsCache.rounds || null, minEv: ROUNDS_OPTS.minEv, agreePts: ROUNDS_OPTS.agreePts, books: esBooksState.summary?.roundModel || null,
      record: roundmodel.roundsRecord(rows), priced: hasPro(req) ? priced : priced.length, rows: hasPro(req) ? rows.slice(0, +req.query.limit || 500) : rows.filter(r => r.status === 'graded').slice(0, 500) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── ESPORTS MODEL REPORT CARD (esmodels.js, v3.145.0) ──
// Every esports record against the break-even its payouts set, at the
// 50-graded bar, and the same-match stacks' sweeps against the payout the
// app must show. Rebuilt at most every 5 minutes; the Lines table reads the
// verdicts (a failed model's legs stop showing as plays).
const esmodels = require('./esmodels');
const esModelsState = { at: 0, cards: null, stacks: null, error: null };
async function esModelCards(force = false) {
  if (!force && esModelsState.cards && Date.now() - esModelsState.at < 5 * 60e3) return esModelsState;
  try {
    const recs = { esports: tracker, h2h: h2hTracker, rounds: roundsTracker, share: shareTracker, esStale: esStaleTracker };
    const rows = {};
    for (const [k, t] of Object.entries(recs)) rows[k] = await t.list({ limit: 1e6 });
    Object.assign(esModelsState, { at: Date.now(), cards: esmodels.modelCards(rows), stacks: esmodels.stackCards(await slipTracker.list()), error: null });
  } catch (e) { esModelsState.error = e.message; }
  return esModelsState;
}
if (require.main === module) setTimeout(() => esModelCards(true).catch(() => {}), 90e3);
app.get('/api/esports/models', async (req, res) => {
  try {
    const s = await esModelCards();
    if (!s.cards) return res.status(503).json({ error: s.error || 'not ready' });
    res.json({ note: `Each esports record against the hit rate its payouts need, at ${esmodels.MIN_N} graded. failed = 2+ standard errors under break-even; beats = 2+ over, which still needs an independent re-check before anyone bets it. Rows from days a team played twice and priced before the match tag existed are left out. Stacks: the payout an all-legs-win entry needs for the record so far to have broken even.`,
      at: new Date(s.at).toISOString(), minN: esmodels.MIN_N, models: s.cards, stacks: s.stacks });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/esports/picks', async (req, res) => {
  const fresh = esportsCache.lastUpdated &&
    (Date.now() - new Date(esportsCache.lastUpdated).getTime()) < 300000;
  // a cold cache waits for the first build; a stale one answers at once and
  // rebuilds behind, so the board never hangs on a slow stats lookup
  if (!(esportsCache.picks || []).length) await esPicksOnce();
  else if (!fresh) esPicksOnce().catch(() => {});
  const pro = hasPro(req);
  // an EV filter would let a free user find each locked pick's EV by bisection
  const minEV = pro ? (parseFloat(req.query.minEV) || -100) : -100;
  const sport = req.query.sport;
  // the board rebuilds every few minutes, and a book that stops answering
  // (PrizePicks 429s) leaves its last lines in place: a line whose match has
  // started can't be played, so it leaves the board the minute it starts
  const now = Date.now();
  let picks = (esportsCache.picks || []).filter(p => !(Date.parse(p.startTime || '') <= now));
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
  await esPicksOnce();
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
  else if (sport.toLowerCase().includes('lol')) stats = lolPlayer(name);
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
    if (l.overOpen === false) B.lowerOnly = (B.lowerOnly || 0) + 1;
    if (l.underOpen === false) B.higherOnly = (B.higherOnly || 0) + 1;
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
      higherOnly: B.higherOnly || 0, lowerOnly: B.lowerOnly || 0,
      samplePlayers: B.samplePlayers,
    };
  }).sort((a, b) => b.count - a.count);
  res.json({ totalEsportsLines: rows.length, markets: out });
});

// Which pick'em books answer from Railway (bookprobe.js)
require('./bookprobe').mountBookProbe(app, axios);

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

app.get('/api/sleeper', (req, res) => res.json({ data: [...(cache.sleeper.data || []), ...(cache.sleeperSports.data || [])] }));

// ── PROPS BOARD: every book's player lines side by side (propsboard.js) ──────
// Underdog, PrizePicks and Sleeper, sports and esports. Sports lines are priced
// off Kalshi's player ladders at each book's own line; esports off our model.
// Rebuilt at most once a minute. ?sport=NFL|ESPORTS|SPORTS &book=underdog
// &q=name &sort=ev|gap|books|start|player &multi=1 (2+ books) &priced=1
let propsBoardCache = { at: 0, rows: [] };
function propsBoardRows() {
  if (Date.now() - propsBoardCache.at < 60000) return propsBoardCache;
  const es = l => isEsports(l.sport);
  const now = Date.now(), open = l => !(Date.parse(l.startTime || '') <= now);
  const esRaw = [...(cache.underdog.data || []).filter(es), ...ppLinesNow().filter(es), ...(cache.sleeper.data || []), ...pick6.lines().filter(es)].filter(open);
  // one row per match: tagged as the esports board tags them (esmatch.js)
  const esTags = esmatch.matchTags(esRaw, { playerOf: l => normalizeName(l.player), sportOf: l => trackerSportKey(l.sport) });
  const esLines = esRaw.map(l => ({ ...l, matchTag: esTags.get(l) ?? null }));
  const esKey = (sport, market) => normalizeMarket(market);
  const rows = propsBoard.buildRows([...sportsPropLines(), ...esLines], { esKey });
  const esPicks = new Map();
  for (const p of esportsCache.picks || []) {
    const sport = propsBoard.boardSport(p.sport).sport;
    esPicks.set(`${sport}|${evScreen.canonName(p.player)}|${esKey(sport, p.market)}${p.matchTag ? `|${p.matchTag}` : ''}`, p);
  }
  propsBoard.priceRows(rows, { kalshi: propsBoard.kalshiFairIndex(kpropsState.games), kalshiAt: kalshiExtraAt, esPicks, dfsEv: dfsLegEv, fixedEv: (book, fair, mult) => sportProps.fixedLeg(book, fair, mult)?.ev ?? null });
  const sportPlays = priceSportRows(rows);
  observeStaleApps(rows);
  propsBoardCache = { at: Date.now(), rows, coverage: propsBoard.coverage(rows), counts: { ...propsBoard.counts(rows), gaps: sportPlays.filter(x => x.kind === 'gap').length, sharp3: sportPlays.filter(x => x.kind === 'sharp3').length, combo: sportPlays.filter(x => x.kind === 'combo').length, sharp: sportPlays.filter(x => x.kind === 'sharp').length, consensus: rows.filter(r => r.consensus).length, researchGaps: sportPlays.filter(x => x.kind === 'gap-odd').length }, sportPlays };
  return propsBoardCache;
}

// ── SPORTS PROPS: the other books and Kalshi as the fair (sportprops.js) ──
// Kalshi's price alone was the fair before; now each book's line is priced on
// every other source on the row, Kalshi counting as two books. A play is
// flagged only where something says more than two books' noise: Kalshi's own
// price at that line ('ev'), or the book sitting off two or more others that
// agree ('gap'). Flagged plays are tracked (sporttrack.js) and graded off
// ESPN's box scores (sportgrade.js).
const SPORT_OPTS = { ...sportProps.DEFAULTS,
  minEv: process.env.SPORT_PROPS_MIN_EV != null ? parseFloat(process.env.SPORT_PROPS_MIN_EV) : sportProps.DEFAULTS.minEv,
  minProbPts: process.env.SPORT_GAP_MIN_PTS != null ? parseFloat(process.env.SPORT_GAP_MIN_PTS) : sportProps.DEFAULTS.minProbPts };
// Kalshi's P(over) at each book line on the row, from priceRows' c.fair
const rowKalshi = row => new Map(Object.values(row.books).filter(c => c.fair != null).map(c => [c.line, c.fair / 100]));
function sportSharpAt(row, line) {
  const f = sportProps.consensusFor(row, line, { sharp: sharpQuotes(row), kalshi: rowKalshi(row), o: SHARP_OPTS });
  return f && sportProps.sharpBacked(f) ? f.p : null;
}
// Pinnacle's own number on a stale leg's subject now ({ x, p: P(over) }), the raw close
function stalePinAt(row) {
  if (!staleState.enabled) return null;
  return staleState.engine.pinMain(staleLines.propKey(row.sport, row.player, row.mkey, row.startTime));
}
function sportFairAt(row, book, line, kind) {
  kind = baseSportKind(kind);
  // a three-sharps leg closes on Pinnacle's own price at its number, never a curve
  if (kind === 'sharp3') return sportProps.threeSharpClose(row, line, sharpQuotes(row), THREE_SHARP_OPTS);
  // a combo leg closes on the same books and Pinnacle's parts at its own number
  if (kind === 'combo') return sportProps.comboClose(row, line, { sharp: comboQuotes(row), parts: pinParts(row), o: COMBO_OPTS })?.p ?? null;
  if (kind === 'sharp') { const f = sportProps.consensusFor(row, line, { sharp: sharpQuotes(row), kalshi: rowKalshi(row), o: SHARP_OPTS }); return f ? f.p : null; }
  // a book-fair leg closes on the books' own fair at its line (and on
  // Pinnacle's or Kalshi's, sportSharpAt, when one appears before the start)
  // a book-consensus leg closes on the same three-plus books at its own line
  if (kind === 'book-consensus') { const f = sportProps.bookConsensusAt(bookLineQuotes(row), line); return f ? f.p : null; }
  if (kind === 'book-fair' || kind === 'book-fair-single') { const f = sportProps.consensusFor(row, line, { sharp: sharpQuotes(row).filter(q => BOOK_FAIR_BOOKS.includes(q.book)), o: BOOK_FAIR_OPTS }); return f ? f.p : null; }
  // a stale-line leg closes on what it was flagged on: Pinnacle's own fair at its line
  if (kind === 'stale' || kind === 'stale-single') return staleState.engine.fairAt(staleLines.propKey(row.sport, row.player, row.mkey, row.startTime), line);
  const f = sportProps.fairFor(row, book, line, { kalshi: rowKalshi(row), pin: pinprops.quotesForGame(pinPropsIndex, row), o: SPORT_OPTS });
  return f ? f.p : null;
}
// The sharp consensus (sportprops.consensusFor): Pinnacle's prop, FanDuel's
// and BetRivers' props for the same game, and Kalshi's ladder. Kind 'sharp'
// in the record; it takes the leg over the older kinds when both flag it.
const SHARP_OPTS = { ...sportProps.CONSENSUS, weights: sportProps.parseWeights(process.env.SPORT_SHARP_WEIGHTS),
  minEv: process.env.SPORT_SHARP_MIN_EV != null ? parseFloat(process.env.SPORT_SHARP_MIN_EV) : sportProps.CONSENSUS.minEv };
// a shadow book (DraftKings, BetMGM, … via Action Network) joins the consensus
// once its own graded legs score at least as well as FanDuel's (promoteShadows);
// SPORT_SHARP_WEIGHTS still sets the rest. Checked every 10 minutes.
const SHARP_BASE_WEIGHTS = { ...SHARP_OPTS.weights };
let sharpPromoted = [];
async function refreshSharpPromotions() {
  const { bySource } = await sportTracker.summary();
  const { weights, promoted } = sportProps.promoteShadows(bySource, { ...SHARP_OPTS, weights: SHARP_BASE_WEIGHTS });
  SHARP_OPTS.weights = weights; sharpPromoted = promoted;
}
const consensusMoves = sportProps.createMoveTracker();
let bookPropsIndex = new Map();
function refreshBookPropsIndex() {
  const sportOf = s => freebooks.LEAGUES[s]?.props || null;
  bookPropsIndex = pinprops.indexProps(sportProps.bookPropQuotes(freeBooksState.games, sportOf, evScreen.canonName));
}
function sharpQuotes(row) {
  const out = [];
  // every line Pinnacle hangs for this game; consensusFor takes the one nearest each app's line
  for (const pin of pinprops.quotesForGame(pinPropsIndex, row) || []) out.push({ book: 'pinnacle', line: pin.line, pOver: pin.pOver });
  // the books' props only while their read is fresh, like the +EV screen's
  if (Date.now() - Date.parse(freeBooksState.gamesAt || 0) < FREE_BOOKS_MAX_AGE_MS) out.push(...sportProps.quotesFor(bookPropsIndex, row));
  return out;
}
// ── BOOK FAIR: FanDuel and BetRivers alone, where nothing sharp prices a leg ──
// (sportprops.bookFairPlays) Kinds 'book-fair' (both books) and
// 'book-fair-single' (one, shown, not counted). Grey on PROPS, never in Best
// Plays or alerts, its own record judged on the books' own close: it measures
// the apps' margin against the soft books until about 50 graded legs say
// otherwise. Action Network's second-hand books never price it (they make no
// play without a sharp price). BOOK_FAIR=off turns it off.
const BOOK_FAIR_OPTS = { ...sportProps.BOOK_FAIR, minEv: SHARP_OPTS.minEv, maxSpreadPts: SHARP_OPTS.maxSpreadPts,
  ...(process.env.BOOK_FAIR_MAX_OFF_PTS != null ? { maxOffPts: parseFloat(process.env.BOOK_FAIR_MAX_OFF_PTS) } : {}) };
const BOOK_FAIR_BOOKS = Object.keys(BOOK_FAIR_OPTS.weights);
const BOOK_FAIR_ON = !/^(off|0|false|no)$/i.test(String(process.env.BOOK_FAIR || '').trim());
const bookFairKind = sportProps.bookFairKind;
const bookFairLineDiffers = (row, sharp) => (BOOK_FAIR_ON ? sportProps.bookFairLineDiffers(row, sharp, { dfsEv: dfsLegEv, o: BOOK_FAIR_OPTS }) : null);
const bookFairPlays = (row, sharp) => (BOOK_FAIR_ON ? sportProps.bookFairPlays(row, sharp, { dfsEv: dfsLegEv, o: BOOK_FAIR_OPTS }) : []);
// ── BOOK CONSENSUS: three or more sportsbooks at the app's own number ──
// (sportprops.bookConsensusPlays) Where nothing sharp prices a leg, every book
// we read (FanDuel, BetRivers and Action Network's seven) that posts the same
// stat at the same line, the outliers dropped. Kind 'book-consensus': grey on
// PROPS, never in Best Plays or alerts, its own record judged on the same
// consensus at the close, until about 50 graded legs say whether it is an edge.
// BOOK_CONSENSUS=off turns it off.
const BOOK_CONS_ON = !/^(off|0|false|no)$/i.test(String(process.env.BOOK_CONSENSUS || '').trim());
// ── THREE SHARPS: Pinnacle and two of FanDuel, BetRivers and Kalshi at the app's own number ──
// (sportprops.threeSharpPlays) every source on its own price past the app's
// break-even; kind 'sharp3' (Pick6 'p6-sharp3'), its close Pinnacle's own
// price at that number. A lead: grey on PROPS, never in Best Plays or alerts,
// judged at 50 graded. THREE_SHARP=off turns it off.
const THREE_SHARP_ON = !/^(off|0|false|no)$/i.test(String(process.env.THREE_SHARP || '').trim());
const THREE_SHARP_OPTS = { ...sportProps.THREE_SHARP, ...(process.env.THREE_SHARP_MIN_EV != null ? { minEv: parseFloat(process.env.THREE_SHARP_MIN_EV) } : {}) };
// ── COMBOS: points + rebounds and the rest off FanDuel, BetRivers and Pinnacle's parts ──
// (sportprops.comboPlays) two or more sources at the app's own number, one a
// book read direct, each past the app's break-even on its own price. Kind
// 'combo' (Pick6 'p6-combo'), its close the same sources, each stored. A lead:
// grey on PROPS, never in Best Plays or alerts, judged at 50 graded. COMBOS=off turns it off.
const COMBO_ON = !/^(off|0|false|no)$/i.test(String(process.env.COMBOS || '').trim());
const COMBO_OPTS = { ...sportProps.COMBO, ...(process.env.COMBO_MIN_EV != null ? { minEv: parseFloat(process.env.COMBO_MIN_EV) } : {}) };
// Pinnacle's quotes for each part of a combo row, same game: { points: [...], rebounds: [...] }
function pinParts(row) {
  const want = sportProps.COMBO_PARTS[row?.mkey];
  if (!want) return null;
  const out = {};
  for (const m of want) out[m] = pinprops.quotesForGame(pinPropsIndex, { ...row, key: String(row.key).replace(/\|[^|]*$/, `|${m}`) }) || [];
  return out;
}
// Pinnacle's own combo quotes and the books' at every line they hang
const comboQuotes = row => [...(pinprops.quotesForGame(pinPropsIndex, row) || []).map(q => ({ book: 'pinnacle', line: q.line, pOver: q.pOver })), ...bookLineQuotes(row)];
const comboSourcesAt = (row, line, kind) => (baseSportKind(kind) === 'combo' ? sportProps.comboClose(row, line, { sharp: comboQuotes(row), parts: pinParts(row), o: COMBO_OPTS })?.sources ?? null : null);
// every book quote on the row's player and stat in the same game, at every line it hangs
function bookLineQuotes(row, slackMs = 3 * 3600e3) {
  if (!(Date.now() - Date.parse(freeBooksState.gamesAt || 0) < FREE_BOOKS_MAX_AGE_MS)) return [];
  const t = Date.parse(row?.startTime || '');
  return (bookPropsIndex.get(row?.key) || []).filter(q => t && Math.abs(Date.parse(q.start) - t) <= slackMs);
}
const bookConsensusPlays = row => (BOOK_CONS_ON ? sportProps.bookConsensusPlays(row, bookLineQuotes(row), { dfsEv: dfsLegEv }) : []);
function priceSportRows(rows) {
  const flagged = [];
  for (const row of rows) {
    if (row.esports) continue;
    const kalshi = rowKalshi(row);
    const pinAll = pinprops.quotesForGame(pinPropsIndex, row);
    const pin = pinprops.quoteFor(pinPropsIndex, row);
    if (pin) row.pinnacle = { line: pin.line, over: pin.over ?? null, under: pin.under ?? null, pOver: +(pin.pOver * 100).toFixed(1), ...(pin.rounds ? { rounds: pin.rounds } : {}) };
    const plays = sportProps.rowPlays(row, { kalshi, pin: pinAll, dfsEv: dfsLegEv, o: SPORT_OPTS });
    // the sharp consensus first: Pinnacle, FanDuel, BetRivers and Kalshi together
    const sharp = sharpQuotes(row);
    const books = [...new Set(sharp.map(x => x.book).filter(b => b !== 'pinnacle'))];
    if (books.length) row.sharpBooks = books; else delete row.sharpBooks;
    // a consensus of FanDuel and BetRivers alone isn't sharp: it's the book fair below
    const cplays = (sharp.length + (kalshi.size ? 1 : 0) >= SHARP_OPTS.minSources ? sportProps.consensusPlays(row, { sharp, kalshi, dfsEv: dfsLegEv, o: SHARP_OPTS }) : [])
      .filter(sportProps.sharpBacked);
    const bfPlays = cplays.length || pin || kalshi.size ? [] : bookFairPlays(row, sharp);
    if (bfPlays.length) row.bookFair = { n: bfPlays[0].n, mean: bfPlays[0].mean, spreadPts: bfPlays[0].spreadPts, sources: bfPlays[0].sources.map(({ book, line, p }) => ({ book, line, p })) };
    else delete row.bookFair;
    // three or more books at the app's own number: a lead of its own, recorded at +2%
    const bcPlays = cplays.length || pin || kalshi.size ? [] : bookConsensusPlays(row);
    if (bcPlays.length) row.bookConsensus = { n: bcPlays[0].n, line: bcPlays[0].line, mean: bcPlays[0].mean, sources: bcPlays[0].sources };
    else delete row.bookConsensus;
    for (const p of bcPlays) if (p.ev >= SHARP_OPTS.minEv) flagged.push({ row, play: p, kind: 'book-consensus' });
    // both books: the +2% plays; one book alone: every leg's better side, so a
    // FanDuel-only price can be judged on its close (recorded, never a play)
    const bfSeen = new Set();
    for (const p of bfPlays) {
      const single = bookFairKind(p) === 'book-fair-single';
      if (single ? p.ev > 0 && !bfSeen.has(p.book) : p.ev >= SHARP_OPTS.minEv) { flagged.push({ row, play: p, kind: bookFairKind(p) }); bfSeen.add(p.book); }
    }
    if (cplays.length) {
      consensusMoves.observe(row, cplays[0].mean);
      row.consensus = { n: cplays[0].n, mean: cplays[0].mean, spreadPts: cplays[0].spreadPts, sources: cplays[0].sources.map(({ book, line, p, shadow }) => ({ book, line, p, ...(shadow ? { shadow } : {}) })) };
    } else consensusMoves.observe(row, null);
    // every source on its own price at the app's number: a lead of its own
    const s3 = THREE_SHARP_ON ? sportProps.threeSharpPlays(row, { sharp, kalshi, dfsEv: dfsLegEv, o: THREE_SHARP_OPTS }) : [];
    if (s3.length) row.threeSharp = { book: s3[0].book, side: s3[0].side, line: s3[0].line, ev: s3[0].ev, evMin: s3[0].evMin, entries: s3[0].entries, sources: s3[0].sources, plays: s3.map(p => ({ book: p.book, side: p.side, line: p.line, ev: p.ev, evMin: p.evMin })) };
    else delete row.threeSharp;
    for (const p of s3) flagged.push({ row, play: p, kind: 'sharp3' });
    // combos: the books at the app's number and Pinnacle's parts added up
    const cb = COMBO_ON && sportProps.isCombo(row.mkey) ? sportProps.comboPlays(row, { sharp: comboQuotes(row), parts: pinParts(row), dfsEv: dfsLegEv, o: COMBO_OPTS }) : [];
    if (cb.length) row.combo = { book: cb[0].book, side: cb[0].side, line: cb[0].line, ev: cb[0].ev, evMin: cb[0].evMin, entries: cb[0].entries, sources: cb[0].sources, parts: cb[0].parts, plays: cb.map(p => ({ book: p.book, side: p.side, line: p.line, ev: p.ev, evMin: p.evMin })) };
    else delete row.combo;
    for (const p of cb) flagged.push({ row, play: p, kind: 'combo' });
    const sharpTaken = new Set();
    let sharpBest = null;
    for (const p of cplays) {
      const st = consensusMoves.stale(row, p.book, p.line, p.side);
      if (st && st.pts >= 1) p.stale = st;
      if (p.ev < SHARP_OPTS.minEv) continue;
      flagged.push({ row, play: p, kind: 'sharp' });
      sharpTaken.add(`${p.book}|${p.side}`);
      if (!sharpBest) sharpBest = p;
    }
    // lines apart but the payouts even it out (UD 249.5 at Higher 1.29x vs
    // PP 223.5): every book reads as the same median within a few points
    const means = Object.entries(row.books).map(([b, c]) => sportProps.meanFor(row.mkey, row.sport, c.line, sportProps.bookPOver(b, c) ?? NaN)).filter(m => m > 0);
    if (row.gap > 0 && means.length > 1) {
      const lo = Math.min(...means), hi = Math.max(...means);
      row.medianGap = +(hi - lo).toFixed(2);
      row.gapPriced = sportProps.pOver(row.mkey, row.sport, hi, lo) - 0.5 < SPORT_OPTS.minProbPts / 100;
    }
    // a cell keeps a price only where a sharp price backs it or it's a gap
    for (const [book, c] of Object.entries(row.books)) {
      const cons = cplays.filter(p => p.book === book);
      const mine = cons.length ? cons : plays.filter(p => p.book === book && p.sharpEv != null);   // a Pinnacle or Kalshi price within reach of this line
      // the books' consensus at this app's own number before FanDuel or BetRivers read along a curve
      const bc = mine.length ? null : bcPlays.find(p => p.book === book);
      const bf = mine.length || bc ? null : bfPlays.find(p => p.book === book);
      // without a consensus the cell shows the sharp prices' own number (the
      // other apps' lines left out of it) where there is one
      const sh = cons.length ? null : mine.filter(p => p.sharpEv != null).sort((x, y) => y.sharpEv - x.sharpEv)[0];
      if (sh) c.ev = { side: sh.side, ev: sh.sharpEv, fair: +(sh.sharpFair * 100).toFixed(1) };
      else if (mine.length) c.ev = { side: mine[0].side, ev: mine[0].ev, fair: +(mine[0].fair * 100).toFixed(1), ...(cons.length ? { consensus: true } : {}) };
      else if (bc) c.ev = { side: bc.side, ev: bc.ev, fair: +(bc.fair * 100).toFixed(1), bookFair: 'consensus', n: bc.n, mean: bc.mean, books: bc.sources };
      else if (bf) c.ev = { side: bf.side, ev: bf.ev, fair: +(bf.fair * 100).toFixed(1), bookFair: bf.n >= 2 ? 'both' : 'single' };
      else if (c.fair == null) delete c.ev;
      // the books post this prop at another number than the app's: no price, and the row says so
      if (!c.ev && !cplays.length && !pin && !kalshi.size && !bc) {
        const d = bookFairLineDiffers({ ...row, books: { [book]: c } }, sharp);
        if (d) c.lineDiffers = d; else delete c.lineDiffers;
      } else delete c.lineDiffers;
    }
    let best = null;
    for (const p of plays) {
      const kind = sportProps.playKind(p, SPORT_OPTS);
      if (!kind || sharpTaken.has(`${p.book}|${p.side}`)) continue;
      flagged.push({ row, play: p, kind });
      if (!best) best = { p, kind };
    }
    // a gap with no sharp price: both directions go in the record, neither on the board
    if (!best && !sharpBest) for (const x of sportProps.researchGap(plays, SPORT_OPTS)) flagged.push({ row, ...x, research: true });
    if (sharpBest) {
      const p = sharpBest;
      row.best = { book: p.book, side: p.side, ev: p.ev, fair: +(p.fair * 100).toFixed(1), line: p.line, source: 'consensus', kind: 'sharp', n: p.n, mean: p.mean,
        sources: p.sources, ...(p.entry ? { entry: p.entry, entries: p.entries } : {}), ...(p.stale ? { stale: p.stale } : {}) };
    } else if (cplays.length && !best) {
      const p = cplays[0];
      row.best = { book: p.book, side: p.side, ev: p.ev, fair: +(p.fair * 100).toFixed(1), line: p.line, source: 'consensus', kind: null, n: p.n, sources: p.sources };
    } else if (best) {
      const { p, kind } = best;
      row.best = { book: p.book, side: p.side, ev: p.ev, fair: +(p.fair * 100).toFixed(1), line: p.line, source: p.sources.some(x => x.book === 'pinnacle') ? 'pinnacle' : p.sources.some(x => x.book === 'kalshi') ? 'kalshi' : 'gap', kind,
        n: p.n, mean: p.mean, ...(p.gap ? { gap: p.gap } : {}) };
    } else if (bcPlays.length && !pin && !(row.best && row.best.source === 'kalshi')) {
      // three or more books' price only: grey, never green, its own kind
      const p = bcPlays[0];
      row.best = { book: p.book, side: p.side, ev: p.ev, fair: +(p.fair * 100).toFixed(1), line: p.line, source: 'books', kind: p.ev >= SHARP_OPTS.minEv ? 'book-consensus' : null,
        n: p.n, mean: p.mean, sources: p.sources, ...(p.entry ? { entry: p.entry, entries: p.entries } : {}) };
    } else if (bfPlays.length && !pin && !(row.best && row.best.source === 'kalshi')) {
      // the books' fair only: grey, never green, its own kind
      const p = bfPlays[0];
      row.best = { book: p.book, side: p.side, ev: p.ev, fair: +(p.fair * 100).toFixed(1), line: p.line, source: 'books', kind: p.ev >= SHARP_OPTS.minEv ? bookFairKind(p) : null,
        n: p.n, mean: p.mean, sources: p.sources, ...(p.entry ? { entry: p.entry, entries: p.entries } : {}) };
    } else if (pin || (row.best && row.best.source === 'kalshi')) {
      // a sharp price, blended with the other books: the row's best, +EV or not
      const top = plays.find(p => pin || row.books[p.book]?.fair != null);
      row.best = top ? { book: top.book, side: top.side, ev: top.sharpEv ?? top.ev, fair: +((top.sharpEv != null ? top.sharpFair : top.fair) * 100).toFixed(1), line: top.line, source: pin ? 'pinnacle' : 'kalshi', kind: null, n: top.n } : null;
    }
  }
  return flagged;
}
// Free game lines (freebooks.js): Pinnacle's no-vig fair plus FanDuel's and
// BetRivers' prices for NFL, college football, NBA, WNBA, NHL and MLB, in the
// Odds API's shape, so the +EV screener and its CLV tracker run without an
// Odds API key (the exchanges attach to them like any game-line feed). On with
// PINNACLE=on; FREE_BOOKS=off turns the books off. Every minute.
const pingames = require('./pingames');
const freebooks = require('./freebooks');
const FREE_BOOK_PIN_SPORTS = { football: pingames.SPORTS.football, basketball: pingames.SPORTS.basketball, hockey: pingames.SPORTS.hockey, baseball: pingames.SPORTS.baseball };
const FREE_BOOKS_MAX_AGE_MS = 5 * 60e3;
const freeBooksState = { enabled: PINNACLE_ON && !/^(off|0|false|no)$/i.test(String(process.env.FREE_BOOKS || '').trim()), games: {}, counts: {}, errors: [], updated: null, ms: null };
let freeBooksRunning = false;
let freeBooksPropsAt = 0;
const freeBooksPropCache = new Map(), freeBooksLadderCache = new Map();
// More books beside FanDuel and BetRivers (xbooks.js): Action Network's US
// books (DraftKings, BetMGM, Caesars, bet365, Fanatics, Hard Rock, theScore)
// as venues and comparison columns, Matchbook's exchange as a sharp source.
// Read every other minute inside refreshFreeBooks. XBOOKS=off turns both off;
// ACTION_NETWORK=off or MATCHBOOK=off one of them.
const xbooks = require('./xbooks');
const envOff = k => /^(off|0|false|no)$/i.test(String(process.env[k] || '').trim());
const xbooksState = { enabled: !envOff('XBOOKS'), action: !envOff('ACTION_NETWORK'), matchbook: !envOff('MATCHBOOK'), books: {}, counts: {}, errors: [], at: 0, updated: null, ms: null };
const XBOOKS_EVERY_MS = 110e3, XBOOKS_MAX_AGE_MS = 6 * 60e3;
async function refreshExtraBooks() {
  if (!xbooksState.enabled || Date.now() - xbooksState.at < XBOOKS_EVERY_MS) return;
  const t0 = Date.now();
  try {
    const { books, counts, errors } = await xbooks.fetchExtraBooks(axios, { action: xbooksState.action && licences.isOn('actionnetwork'), matchbook: xbooksState.matchbook && licences.isOn('matchbook') });
    if (counts.action + counts.matchbook > 0) Object.assign(xbooksState, { books, at: Date.now() });
    Object.assign(xbooksState, { counts, errors: errors.slice(0, 8), updated: new Date().toISOString(), ms: Date.now() - t0 });
  } catch (e) { xbooksState.errors = [e.message]; }
}
// Gemini Predictions' game lines (geminibooks.js), a CFTC exchange a Texan
// can trade: moneyline, and spread and total rungs at Pinnacle's own main
// number, priced off Pinnacle like FanDuel and BetRivers and graded in the
// main-lines record as book 'gemini'. A lead: no alerts (closeboard only
// alerts what it marks proven) and kept out of Best Plays. Every other
// minute; GEMINI=off stops it.
const geminibooks = require('./geminibooks');
const geminiState = { enabled: !envOff('GEMINI'), books: {}, events: 0, at: 0, errors: [], updated: null, ms: null };
const GEMINI_EVERY_MS = 50e3, GEMINI_MAX_AGE_MS = 6 * 60e3;
async function refreshGemini() {
  if (!geminiState.enabled || Date.now() - geminiState.at < GEMINI_EVERY_MS) return;
  const t0 = Date.now();
  try {
    const { books, events, errors, skipped } = await geminibooks.fetchGemini(axios);
    if (events > 0) Object.assign(geminiState, { books, events, skipped, at: Date.now() });
    Object.assign(geminiState, { errors: errors.slice(0, 5), updated: new Date().toISOString(), ms: Date.now() - t0 });
  } catch (e) { geminiState.errors = [e.message]; }
}
// Polymarket US's game lines as a book (pmusbooks.js): the same CFTC
// exchange a Texan trades, never polymarket.com. Moneylines for every league
// Pinnacle prices, spreads and totals for games inside 36 hours, merged and
// graded like Gemini's. Every other minute; POLYMARKET_US_BOOK=off stops it.
const pmusbooks = require('./pmusbooks');
const pmusBooksState = { enabled: pmusbooks.enabledFromEnv(), books: {}, at: 0, games: 0, withLines: 0, slugReads: 0, counts: {}, errors: [], updated: null, ms: null };
const pmusBooksReader = pmusBooksState.enabled ? pmusbooks.createPolymarketUsBooks({ http: upstream }) : null;
const PMUS_BOOKS_EVERY_MS = 50e3;
async function refreshPmusBooks() {
  if (!pmusBooksReader || Date.now() - pmusBooksState.at < PMUS_BOOKS_EVERY_MS) return;
  const t0 = Date.now();
  try {
    const r = await pmusBooksReader.read();
    if (r.games > 0) Object.assign(pmusBooksState, { books: r.books, at: Date.now() });
    Object.assign(pmusBooksState, { games: r.games, withLines: r.withLines, slugReads: r.slugReads, counts: r.counts, errors: r.errors.slice(0, 5), updated: new Date().toISOString(), ms: Date.now() - t0 });
  } catch (e) { pmusBooksState.errors = [e.message]; }
}
// Pinnacle's soccer, tennis and UFC for the exchange-only leagues
// (freebooks.EXCHANGE_LEAGUES): soccer league by league (the whole sport is
// 80+ MB), every other minute, only while an exchange book is on.
const PIN_EXTRA_GAMES_EVERY_MS = 110e3, PIN_EXTRA_GAMES_MAX_AGE_MS = 6 * 60e3;
const pinExtraGames = { games: [], at: 0, tried: 0, errors: [] };
async function refreshPinExtraGames() {
  if (!(geminiState.enabled || pmusBooksState.enabled) || Date.now() - pinExtraGames.tried < PIN_EXTRA_GAMES_EVERY_MS) return;
  pinExtraGames.tried = Date.now();
  const r = await pingames.fetchPinnacleGames(axios, { key: process.env.PINNACLE_GUEST_KEY || '', sports: { tennis: pingames.SPORTS.tennis, mma: pingames.SPORTS.mma },
    leagues: { soccer: freebooks.PIN_SOCCER_LEAGUES } });
  if (r.games.length) Object.assign(pinExtraGames, { games: r.games, at: Date.now() });
  pinExtraGames.errors = r.errors.slice(0, 5);
}
async function refreshFreeBooks() {
  if (!freeBooksState.enabled || freeBooksRunning || !licences.isOn('pinnacle')) return;
  freeBooksRunning = true;
  const t0 = Date.now();
  try {
    const pin = await pingames.fetchPinnacleGames(axios, { key: process.env.PINNACLE_GUEST_KEY || '', sports: FREE_BOOK_PIN_SPORTS });
    // FanDuel's prop pages every other minute; Pinnacle's props come from refreshPinnacleProps
    const fdProps = Date.now() - freeBooksPropsAt > 110e3;
    await refreshExtraBooks();
    await Promise.all([refreshGemini(), refreshPmusBooks(), refreshPinExtraGames().catch(e => { pinExtraGames.errors = [e.message]; })]);
    const extra = { ...(Date.now() - xbooksState.at < XBOOKS_MAX_AGE_MS ? xbooksState.books : {}) };
    if (Date.now() - geminiState.at < GEMINI_MAX_AGE_MS) for (const [s, gs] of Object.entries(geminiState.books)) extra[s] = [...(extra[s] || []), ...gs];
    if (Date.now() - pmusBooksState.at < GEMINI_MAX_AGE_MS) for (const [s, gs] of Object.entries(pmusBooksState.books)) extra[s] = [...(extra[s] || []), ...gs];
    const pinAll = Date.now() - pinExtraGames.at < PIN_EXTRA_GAMES_MAX_AGE_MS ? [...pin.games, ...pinExtraGames.games] : pin.games;
    const read = await freebooks.fetchFreeBooks(axios, pinAll, { pinProps: [...pinPropsIndex.values()].flat(), fdProps, propCache: freeBooksPropCache, ladderCache: freeBooksLadderCache, extra });
    // the exchanges' rungs only at Pinnacle's main number: the close is Pinnacle's own price there
    const games = geminibooks.mainLinesOnly(read.games, pinAll, ['gemini', 'polymarketus']), { counts, errors } = read;
    if (fdProps) freeBooksPropsAt = Date.now();
    // the stale-lines engine watches the sportsbooks' leagues only
    const bookLeagues = Object.fromEntries(Object.entries(games).filter(([k]) => freebooks.LEAGUES[k]));
    if (pin.games.length) { Object.assign(freeBooksState, { games, pinGames: pinAll, gamesAt: new Date().toISOString() }); refreshBookPropsIndex(); observeStaleBooks(bookLeagues, fdProps, !pin.errors.length); }
    Object.assign(freeBooksState, { counts, errors: [...pin.errors.map(e => `pinnacle ${e}`), ...errors].slice(0, 8), updated: new Date().toISOString(), ms: Date.now() - t0 });
  } catch (e) { freeBooksState.errors = [e.message]; }
  finally { freeBooksRunning = false; }
}
// Pinnacle's player props (pinprops.js): on with PINNACLE=on (PINNACLE_ON),
// behind the pinnacle licence like its esports prices. Every other minute.
const pinprops = require('./pinprops');
const pinPropsState = { enabled: PINNACLE_ON, props: 0, bySport: {}, updated: null, errors: [] };
let pinPropsIndex = new Map(), pinPropsAt = 0;
const PIN_PROPS_MAX_AGE_MS = 10 * 60e3;
// Pinnacle's tennis and UFC match markets read as pick'em props (pinextra.js):
// a bigger pull (every tennis match), so every sixth minute; the last read is
// kept up to PIN_PROPS_MAX_AGE_MS, never longer.
const pinextra = require('./pinextra');
const PIN_EXTRA_EVERY_MS = 350e3;
let pinExtra = { props: [], at: 0, tried: 0, bySport: {}, errors: [] };
async function refreshPinnacleExtra() {
  if (Date.now() - pinExtra.tried < PIN_EXTRA_EVERY_MS) return;
  pinExtra.tried = Date.now();
  const { props, errors } = await pinextra.fetchPinnacleExtra(axios, process.env.PINNACLE_GUEST_KEY);
  const bySport = {};
  for (const p of props) bySport[`${p.sport} ${p.mkey}`] = (bySport[`${p.sport} ${p.mkey}`] || 0) + 1;
  if (props.length || !errors.length) Object.assign(pinExtra, { props, at: Date.now() });
  Object.assign(pinExtra, { bySport, errors: errors.slice(0, 5) });
}
async function refreshPinnacleProps() {
  if (!pinPropsState.enabled || !licences.isOn('pinnacle')) return;
  try { await refreshPinnacleExtra(); } catch (e) { pinExtra.errors = [e.message]; }
  const extra = Date.now() - pinExtra.at < PIN_PROPS_MAX_AGE_MS ? pinExtra.props : [];
  const { props, errors } = await pinprops.fetchPinnacleProps(axios, process.env.PINNACLE_GUEST_KEY);
  // the stale engine watches Pinnacle's tennis and UFC lines too (read as props,
  // every sixth minute), so the apps' tennis and UFC legs can go stale at its number
  if (props.length || !errors.length) { pinPropsIndex = pinprops.indexProps([...props, ...extra]); pinPropsAt = Date.now(); observeStale(staleLines.pinPropQuotes([...props, ...extra]), pinPropsAt, 'pinnacle-props', true, errors.length ? [] : ['pinnacle|prop']); }
  // an outage keeps the last read a while, never as the fair for long
  else if (Date.now() - pinPropsAt > PIN_PROPS_MAX_AGE_MS) pinPropsIndex = new Map();
  const bySport = {};
  for (const p of props) bySport[p.sport] = (bySport[p.sport] || 0) + 1;
  Object.assign(pinPropsState, { props: props.length, bySport, extra: { props: extra.length, bySport: pinExtra.bySport, errors: pinExtra.errors }, errors: errors.slice(0, 5), updated: new Date().toISOString() });
}
// ── ESPORTS AT BETRIVERS (esbooks.js) ──
// BetRivers' esports lines (Kambi: match, maps, map handicap, total maps and
// per-map kill and round lines) priced at their own numbers off Pinnacle's
// esports feed and the esports board's Kalshi mids. Every two minutes, then
// re-priced each minute against the newest Kalshi. Shown on the +EV tab
// (ESPORTS) and graded against Pinnacle's close in their own record. No
// alerts. ESPORTS_BOOKS=off stops it.
const esbooks = require('./esbooks');
const BOVADA_ESPORTS = /^(on|1|true|yes)$/i.test(String(process.env.BOVADA_ESPORTS || '').trim());
const esBooksState = { enabled: PINNACLE_ON && !/^(off|0|false|no)$/i.test(String(process.env.ESPORTS_BOOKS || '').trim()),
  books: [], pin: [], rows: [], summary: null, errors: [], updated: null, screenedAt: null, ms: null };
let esBooksRunning = false;
async function refreshEsBooks() {
  if (!esBooksState.enabled || esBooksRunning || !licences.isOn('pinnacle')) return;
  esBooksRunning = true;
  const t0 = Date.now(), errors = [];
  try {
    const [kb, pin, bv] = await Promise.all([
      esbooks.fetchKambi(axios).catch(e => { errors.push(`betrivers ${e.message}`); return null; }),
      esbooks.fetchPinnacle(axios, process.env.PINNACLE_GUEST_KEY || '').catch(e => { errors.push(`pinnacle ${e.message}`); return null; }),
      // Bovada's esports (offshore: off unless BOVADA_ESPORTS=on) reach past tier one
      BOVADA_ESPORTS && licences.isOn('bovada') ? esbooks.fetchBovada(axios).catch(e => { errors.push(`bovada ${e.message}`); return null; }) : null,
    ]);
    if (kb) { esBooksState.books = [...kb.events, ...(bv?.events || [])]; errors.push(...kb.errors.map(e => `betrivers ${e}`)); }
    if (bv) errors.push(...bv.errors.slice(0, 3).map(e => `bovada ${e}`));
    if (pin) {
      esBooksState.pin = pin;
      observePinTotals(pin).catch(e => console.warn('Pinnacle totals:', e.message));
    }
    Object.assign(esBooksState, { errors: errors.slice(0, 8), updated: new Date().toISOString(), ms: Date.now() - t0 });
    runEsBooksScreen();
  } finally { esBooksRunning = false; }
}
function runEsBooksScreen() {
  if (!esBooksState.enabled) return;
  try {
    const fairs = new Map(), costs = new Map();
    const kalshi = esbooks.kalshiLadders(esportsBoard.state.matches || []);
    const poly = esbooks.kalshiLadders(esportsBoard.state.matches || [], esbooks.DEFAULTS, 'polymarket');
    const res = esbooks.screen({ books: esBooksState.books, pin: esBooksState.pin, kalshi, poly, fairs, costs });
    // BetRivers' player kill ladders on the kill-share model (sharemodel.js)
    let shareSum = null;
    if (SHARE_ON && esportsCache.shareIndex?.size) {
      const sr = sharemodel.priceBookPlayers(esBooksState.books, esportsCache.shareIndex, { nameKey: normalizeName, sameTeam: (a, b) => teamsMatch(esbooks.cleanTeam(a), esbooks.cleanTeam(b)) || !!teamCode(a, b),
        toDecimal: evScreen.americanToDecimal, fairs, costs, o: SHARE_OPTS });
      res.rows.push(...sr.rows);
      res.rows.sort((a, b) => (b.clears - a.clears) || b.ev - a.ev);
      shareSum = { priced: sr.priced, shown: sr.rows.length, clear: sr.rows.filter(r => r.clears).length, teams: sr.teams };
    }
    Object.assign(esBooksState, { rows: res.rows, summary: { ...esbooks.summarize(esBooksState.books, res, fairs), killShare: shareSum,
      roundModel: { shown: res.rows.filter(r => r.rounds).length, clear: res.rows.filter(r => r.source === 'esbook-rounds').length, bothSources: res.rows.filter(r => r.rounds && r.sources.length > 1).length } }, screenedAt: new Date().toISOString() });
    esBookTracker.recordBoard(res.rows, fairs, { costs }).catch(e => console.warn('Esports books tracker:', e.message));
  } catch (e) { esBooksState.errors = [`screen ${e.message}`, ...esBooksState.errors].slice(0, 8); }
}

// ── STALE LINES (stalelines.js) ──
// A rolling history of Pinnacle's game lines and player props next to
// FanDuel's, BetRivers', Kalshi's and the pick'em apps', read as each feed
// lands. When Pinnacle moves (2 points of win chance at its old number, or
// half a point with a point of chance), every venue still on its pre-move
// quote is a STALE row, priced against Pinnacle's post-move fair at the
// venue's own number. A row clears at +2% when Kalshi, FanDuel or BetRivers
// moved the same way too; a Pinnacle-only move is single-source. Books grade
// in their own +EV record (ev-stale-bets), apps in the props record (kinds
// 'stale' and 'stale-single'). No alerts. STALE_LINES=off stops it.
const staleLines = require('./stalelines');
// rows carry the +EV tab's sport keys ('nfl', 'ncaaf'); props come in as the board's ('NFL', 'CFB')
const STALE_SPORT = Object.fromEntries(Object.entries(freebooks.LEAGUES).map(([k, l]) => [l.props, k]));
const staleState = { enabled: PINNACLE_ON && !/^(off|0|false|no)$/i.test(String(process.env.STALE_LINES || '').trim()),
  engine: staleLines.createStaleLines({ sportKey: x => STALE_SPORT[x] || String(x || '').toLowerCase() }), rows: [], screenedAt: null, errors: [] };
// every bet the books' stale record holds (by bet id), so each keeps a close
// and a +2 min price until its game starts; reloaded from the record on a restart
const staleBets = new Map();
const STALE_TRACK_MIN = process.env.TRACK_EV_MIN != null ? parseFloat(process.env.TRACK_EV_MIN) : 2;
staleTracker.ready().then(async () => {
  for (const b of await staleTracker.list({ status: 'open', limit: 1e6 })) {
    // group = `${source}|${subject key}|${number or 'ml'}`
    const parts = String(b.group || '').split('|');
    if (parts.length < 3 || staleBets.has(b.id)) continue;
    const xs = parts[parts.length - 1];
    staleBets.set(b.id, { group: b.group, key: parts.slice(1, -1).join('|'), x: xs === 'ml' ? null : Number(xs), venue: b.book, at: Date.parse(b.flaggedAt), start: Date.parse(b.start || '') });
  }
}).catch(e => console.warn('Stale lines tracker:', e.message));
// the apps' stale legs at 2%+ from the read they first showed on, until the
// props record takes them: a leg the app fixes at its next read still goes in
// (and fails its exec check) instead of never being logged
const staleAppPending = new Map();
let staleBoardByKey = new Map();
// done: what the read covered in full ('fanduel|game|<game id>', 'pinnacle|prop'),
// so a subject it left out counts as taken down, not as still on offer
function observeStale(quotes, t, kind, screen = true, done = []) {
  if (!staleState.enabled || !quotes?.length) return;
  try { staleState.engine.observe(quotes, t, kind, done); if (screen) runStaleScreen(); }
  catch (e) { staleState.errors = [`${kind} ${e.message}`, ...staleState.errors].slice(0, 5); }
}
// Pinnacle's, FanDuel's and BetRivers' game lines (one pass, Pinnacle read
// first), Kalshi's mids on the same games, and the books' props (FanDuel's
// only on the passes that read its prop pages)
function observeStaleBooks(gamesBySport, fdPropsRead, pinOk = true) {
  if (!staleState.enabled) return;
  const t = Date.now(), quotes = [], done = pinOk ? ['pinnacle|game'] : [];
  // a book's read of a game is complete when its event came back (even with
  // everything suspended): a market missing from it is suspended or pulled.
  // FanDuel's props only on the passes that read every one of its prop tabs.
  for (const g of Object.values(gamesBySport).flat()) {
    const r = g.read || {};
    if (r.betrivers) done.push(`betrivers|game|${g.id}`, `betrivers|prop|${g.id}`);
    if (r.fanduel) { done.push(`fanduel|game|${g.id}`); if (fdPropsRead && r.fanduel.props) done.push(`fanduel|prop|${g.id}`); }
  }
  const kmid = Date.now() - kalshiGameRows.at < KALSHI_MID_MAX_AGE_MS ? kalshiGameRows.rows : [];
  let kbooks = new Map();
  try { if (kmid.length) kbooks = pingames.kalshiMidBooks(kmid, Object.values(gamesBySport).flat()); }
  catch (e) { staleState.errors = [`kalshi mids ${e.message}`, ...staleState.errors].slice(0, 5); }
  for (const [s, games] of Object.entries(gamesBySport)) {
    const withK = games.map(g => (kbooks.has(g.id) ? { ...g, bookmakers: [...g.bookmakers, kbooks.get(g.id)] } : g));
    quotes.push(...staleLines.gameQuotes(withK, s));
    quotes.push(...staleLines.bookPropQuotes(games, s, x => freebooks.LEAGUES[x]?.props || null, { books: fdPropsRead ? ['fanduel', 'betrivers'] : ['betrivers'] }));
  }
  observeStale(quotes, t, 'books', true, done);
}
// the apps' lines at the time each app was last read, and Kalshi's ladder
function observeStaleApps(rows) {
  if (!staleState.enabled) return;
  const sports = rows.filter(r => !r.esports);
  staleBoardByKey = new Map(sports.map(r => [r.key, r]));
  // PrizePicks' sports lines come with its whole board, every 20 minutes
  const readAt = { prizepicks: ppState.fullOkAt, underdog: Date.parse(cache.underdog.updated || ''), sleeper: Date.parse(cache.sleeperSports.updated || '') };
  const all = staleLines.appQuotes(sports, { pOverOf: sportProps.bookPOver, kalshiOf: rowKalshi });
  // each app's read covers the board rows the engine can key (a start time
  // and one stat): a row there without the app's line means the app dropped it
  const keyed = sports.filter(r => r.mkey && !String(r.mkey).includes('|') && r.startTime);
  for (const book of staleLines.APP_VENUES) {
    if (book === 'pick6') continue;
    const t = readAt[book];
    if (Number.isFinite(t) && t > 0) observeStale(all.filter(q => q.source === book), t, book, false, keyed.map(r => `${book}|prop|row:${r.key}`));
  }
  // DK Pick6 reads one sport at a time (through the relay): each sport at its own read time
  for (const [k, iso] of Object.entries(pick6.readTimes())) {
    const sport = k.slice('pick6|'.length), t = Date.parse(iso || '');
    if (!Number.isFinite(t)) continue;
    observeStale(all.filter(q => q.source === 'pick6' && q.meta.sport === sport), t, 'pick6', false, keyed.filter(r => r.sport === sport).map(r => `pick6|prop|row:${r.key}`));
  }
  const kt = Date.parse(kpropsState.updated || '');
  if (Number.isFinite(kt)) observeStale(all.filter(q => q.source === 'kalshi'), kt, 'kalshi-props', false);
  try { runStaleScreen(); } catch (e) { staleState.errors = [`screen ${e.message}`, ...staleState.errors].slice(0, 5); }
}
// an app leg at the post-move fair: PrizePicks at the 3-pick power it's graded
// on, Underdog and Sleeper at their own payouts (as the sharp consensus does)
function stalePriceApp(book, fair, c, side) {
  if (book === 'prizepicks') {
    const be = sportProps.PP_GRADE.be;
    return { ev: (fair / be - 1) * 100, decimal: 1 / be, entry: sportProps.PP_GRADE.name, entries: sportProps.PP_ENTRIES.filter(e => fair > e.be).map(e => e.name) };
  }
  const mult = (side === 'Over' ? c.over : c.under) ?? 1;
  // DK Pick6: its table times the pick's own multiplier, graded at the 3-pick entry
  if (book === 'pick6') {
    const fx = sportProps.fixedLeg('pick6', fair, mult);
    return fx ? { ev: fx.ev, decimal: fx.decimal, entry: fx.entry, entries: fx.entries } : null;
  }
  const ev = dfsLegEv(fair, book, mult, { overMultiplier: c.over, underMultiplier: c.under }, side);
  return ev == null ? null : { ev, decimal: sportTrackLegDecimal(book, mult) };
}
function runStaleScreen() {
  if (!staleState.enabled) return;
  const t = Date.now();
  staleState.engine.step(t);
  const rows = staleState.engine.rows(t, { priceApp: stalePriceApp });
  staleState.rows = rows;
  staleState.screenedAt = new Date(t).toISOString();
  // the books' rows go in their own +EV record (its minEv keeps the 2%+ ones)
  const books = rows.filter(r => !r.app);
  for (const r of books) {
    const id = `${r.group}|${r.side}|${r.venue}`;
    if (r.ev >= STALE_TRACK_MIN && !staleBets.has(id)) staleBets.set(id, { group: r.group, key: r.key, x: r.x, venue: r.venue, at: t, start: Date.parse(r.start || '') });
  }
  for (const [id, v] of staleBets) if (Number.isFinite(v.start) ? t > v.start + 3600e3 : t - v.at > 8 * 86400e3) staleBets.delete(id);
  for (const r of rows) {
    if (!r.app || !(r.ev >= 2) || !r.rowKey) continue;
    const id = `${r.group}|${r.side}|${r.venue}`;
    if (!staleAppPending.has(id)) staleAppPending.set(id, { r, at: t, row: staleBoardByKey.get(r.rowKey) || null });
  }
  for (const [id, v] of staleAppPending) if (t - v.at > 6 * 3600e3) staleAppPending.delete(id);
  const { fairs, costs } = staleState.engine.marks(staleBets, t);
  staleTracker.recordBoard(books, fairs, { costs }).catch(e => console.warn('Stale lines tracker:', e.message));
}
// the apps' stale legs since the last call as props-record legs (kinds
// 'stale' and 'stale-single'), as priced when each first showed
function staleAppPlays(boardRows) {
  if (!staleState.enabled) return [];
  const byKey = new Map(boardRows.map(r => [r.key, r]));
  const out = [];
  for (const { r, at, row } of staleAppPending.values()) {
    const br = byKey.get(r.rowKey) || row;
    if (!br) continue;
    out.push({ row: br, kind: r.source,
      play: { book: r.venue, side: r.side, line: r.point, mult: r.mult, fair: r.fairProb / 100, ev: r.ev, decimal: r.decimal, entry: r.entry, entries: r.entries, signalAt: at,
        sources: [{ book: 'pinnacle', line: null, p: r.fairProb }],
        stale: { mins: r.mins, dPts: r.dPts, pinPre: r.pinPre, pinPost: r.pinPost, pinNow: r.pinNow, pinX: r.pinX ?? null, confirmedBy: r.confirmedBy, moveAt: r.moveAt } } });
  }
  staleAppPending.clear();
  return out;
}

// ── BIG MONEY (bigmoney.js) ──
// Big taker prints on Kalshi and Polymarket, the bet each one backed, and
// that bet's price at the pick'em apps, FanDuel, BetRivers and the US
// exchanges, with Pinnacle's no-vig price beside it. Prints come from the
// whale watcher's polls; every minute the plays are rebuilt, the ones a
// venue prices minEv under the money are logged, and the record is marked
// and graded. No alerts (BIG_MONEY=off stops it all).
const BIG_OPTS = { ...bigMoney.DEFAULTS, ...bigMoney.optsFromEnv() };
const BIG_LEAGUE = { nfl: 'NFL', ncaaf: 'CFB', nba: 'NBA', wnba: 'WNBA', nhl: 'NHL', mlb: 'MLB' };
const bigGrader = createSportsGrader({ http: axios });
// Main-line results from ESPN finals (10-24): every closed game line in the
// +EV record (moneyline, spread, total) gets its outcome and 1u result at the
// flagged price and at the +2 min price, so the scoreboard can check the close
// against what happened (results.resultsShortfall). Leagues ESPN doesn't
// score (tennis, UFC, KHL, KBO …) keep CLV only.
const EV_RESULT_LEAGUE = { ...BIG_LEAGUE, ncaab: 'CBB', epl: 'EPL', laliga: 'LALIGA', bundesliga: 'BUNDESLIGA', seriea: 'SERIEA', ligue1: 'LIGUE1',
  mls: 'MLS', ligamx: 'LIGAMX', eredivisie: 'EREDIVISIE', brasileirao: 'BRASILEIRAO', ucl: 'UCL', uel: 'UEL' };
const evResultsState = { runs: 0, graded: 0, lastRun: null, lastGraded: 0, pending: 0, notFound: 0, errors: [] };
let evResultsRunning = false;
async function gradeEvResults() {
  if (evResultsRunning) return;
  evResultsRunning = true;
  try {
    const due = await evTracker.ungraded({ limit: 80, sports: new Set(Object.keys(EV_RESULT_LEAGUE)) });
    const done = [];
    let graded = 0, pending = 0, notFound = 0;
    for (const b of due) {
      const [away, home] = String(b.event || '').split(' @ ');
      let sc = null;
      try { sc = await bigGrader.gradeGame({ league: EV_RESULT_LEAGUE[b.sport], home, away, start: b.start }); }
      catch (e) { evResultsState.errors = [`${b.sport}: ${e.response?.status || e.message}`, ...evResultsState.errors].slice(0, 5); continue; }
      if (sc?.pending) { pending++; continue; }
      if (!sc) notFound++;
      if (await evTracker.setResult(b, sc, { save: false })) graded++;
      done.push(b);
    }
    if (done.length) await evTracker.saveMany(done);
    Object.assign(evResultsState, { runs: evResultsState.runs + 1, graded: evResultsState.graded + graded, lastGraded: graded, pending, notFound, lastRun: new Date().toISOString() });
  } catch (e) { evResultsState.errors = [e.message, ...evResultsState.errors].slice(0, 5); }
  finally { evResultsRunning = false; }
}
// ─── EXCHANGE LINES AT REAL SIZE (xsize.js) ───────────────────────────────────
// Kalshi, Gemini and Polymarket US game lines at the price $50, $200 and
// $1,000 actually fill at (the book walked, fee in) against Pinnacle's no-vig
// at the same line, each venue and size its own record, graded on Pinnacle's
// close and the ESPN final. A record only: no alerts, not in Best Plays.
// EXCHANGE_SIZE=off stops it.
const xsize = require('./xsize');
// the books behind the shopper's exchange prices (depthbook.js): every book the
// size record reads, plus a few of the shopper's own a minute. SHOP_DEPTH=off stops the shopper's reads.
const depthBook = require('./depthbook');
const shopDepthOn = () => !/^(off|0|false|no)$/i.test(String(process.env.SHOP_DEPTH || '').trim());
const shopDepth = depthBook.createDepthBook({ readAsks: ref => xsize.readAsks({ get: (url, cfg) => axios.get(url, cfg) }, ref) });
const xsizeOn = () => !/^(off|0|false|no)$/i.test(String(process.env.EXCHANGE_SIZE || '').trim());
const xsizeTracker = xsize.createSizeTracker({
  store: resultsBackup.wrap('xsize', createEvStoreFromEnv(process.env, { table: 'xsize_bets', fileVar: 'XSIZE_FILE', file: 'xsize-bets.json' })),
  // straight to the venues, not the polite queue: there a book read waited
  // behind the exchange scans' thousands of Kalshi calls, so a minute's pass
  // took ten (2 passes in the first 10 minutes live, 10-24). At most ~70 reads a minute.
  http: { get: (url, cfg) => axios.get(url, cfg) },
  onBook: (ref, book, t) => shopDepth.fromRecord(ref, book, t),
});
xsizeTracker.ready().catch(e => console.error('Exchange size: store failed to initialise:', e.message));
let xsizeRunning = false;
async function scanExchangeSize() {
  if (!xsizeOn() || xsizeRunning || Date.now() - Date.parse(freeBooksState.gamesAt || 0) > FREE_BOOKS_MAX_AGE_MS) return;
  xsizeRunning = true;
  try {
    const kalshiRows = Date.now() - kalshiGameRows.at < KALSHI_MID_MAX_AGE_MS && licences.isOn('kalshi') ? kalshiGameRows.rows : [];
    await xsizeTracker.scan({ games: freeBooksState.games, pinGames: freeBooksState.pinGames || [], kalshiRows });
  } catch (e) { xsizeTracker.state.errors = [e.message, ...xsizeTracker.state.errors].slice(0, 5); }
  finally { xsizeRunning = false; }
}
async function gradeExchangeSize() {
  if (!xsizeOn()) return;
  try { xsizeTracker.state.results = await xsizeTracker.gradeResults(bigGrader, s => EV_RESULT_LEAGUE[s] || null); }
  catch (e) { xsizeTracker.state.errors = [e.message, ...xsizeTracker.state.errors].slice(0, 5); }
}
// the record, per venue and size; closed bets free, open ones Pro
app.get('/api/exchange-size', async (req, res) => {
  try {
    const lic = licenceOf(req);
    const ok = b => b.venue !== 'kalshi' || lic.kalshi;
    const all = (await xsizeTracker.list()).filter(ok);
    const bets = all.filter(b => hasPro(req) || b.status === 'closed').sort((a, b) => Date.parse(b.flaggedAt) - Date.parse(a.flaggedAt))
      .slice(0, Math.min(parseInt(req.query.limit) || 200, 2000));
    res.json({ venues: xsize.VENUES, tiers: require('./depthfill').TIERS, summary: xsize.summarize(all),
      open: all.filter(b => b.status === 'open').length, state: xsizeTracker.state, bets,
      note: 'A record, not a tip sheet: no alerts until a venue and size passes at 50 graded (checks/xsize-2026-10-24/PREREGISTERED.md).' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
const bigTracker = bigMoney.createBigMoneyTracker({
  store: resultsBackup.wrap('bigMoney', createEvStoreFromEnv(process.env, { table: 'big_money', fileVar: 'BIG_MONEY_FILE', file: 'big-money.json' })),
  propGrader: bigGrader,
  gameGrader: async (game, key) => { const sc = await bigGrader.gradeGame(game); return !sc || sc.pending ? sc : bigMoney.gameOutcome(key, sc); },
});
bigTracker.ready().catch(e => console.error('Big money: store failed to initialise:', e.message));
const bigState = { store: new Map(), plays: [], updated: null, counts: null, errors: [], games: null, gamesKey: null };
// the line shop's game index, rebuilt when the exchange scan or the books move
function bigGames() {
  const key = `${xarbState.rows?.at || 0}|${freeBooksState.gamesAt || ''}`;
  if (bigState.gamesKey === key && bigState.games) return bigState.games;
  const r = xarbState.rows || {};
  // Polymarket's spreads and totals sit in a "-more-markets" event of their own: one game key
  const pm = (r.polymarket || []).filter(x => x.category === 'sports').map(x => ({ ...x, eventKey: x.gameSlug ? `polymarket:${x.gameSlug}` : x.eventKey }));
  let matches = [];
  try { matches = pingames.matchRows([...(r.kalshi || []).filter(x => x.gameKey), ...pm, ...(r.us || [])], freeBooksState.pinGames || []); }
  catch (e) { console.warn('Big money: game match:', e.message); }
  bigState.games = bigMoney.gameIndex(matches, Date.now() - Date.parse(freeBooksState.gamesAt || 0) < FREE_BOOKS_MAX_AGE_MS ? freeBooksState.games : {});
  bigState.gamesKey = key;
  return bigState.games;
}
// ─── ODDS SCREEN ──────────────────────────────────────────────────────────────
// Every venue we price on one row per side (oddsscreen.js): Pinnacle's no-vig
// fair, the US exchanges, FanDuel and BetRivers, Matchbook, Action Network's
// copies. ?league=nfl&state=TX&q=cowboys. Free: prices; Pro: fair and EV.
// The line history behind each row's chart rides the results backup.
const oddsScreen = require('./oddsscreen');
const oddsHistory = oddsScreen.createHistory();
let oddsHistoryBooted = false;
const oddsHistoryStore = resultsBackup.wrap('oddsHistory', {
  init: async () => {}, all: async () => (oddsHistoryBooted ? oddsHistory.dump() : []),
  put: async d => { oddsHistory.load([d]); }, putMany: async ds => { oddsHistory.load(ds); },
}, { appendOnly: false });
oddsHistoryStore.init().catch(e => console.warn('Odds history: restore failed:', e.message)).finally(() => { oddsHistoryBooted = true; });
const oddsScreenState = { at: 0, observedAt: null, errors: [] };
function oddsScreenFor({ league = null, state = null, q = '', kalshiOk = true } = {}) {
  const fresh = Date.now() - Date.parse(freeBooksState.gamesAt || 0) < FREE_BOOKS_MAX_AGE_MS;
  let kalshi = null;
  try { kalshi = kalshiOk ? bigGames().bets : null; } catch (e) { oddsScreenState.errors = [e.message]; }
  const screen = oddsScreen.build(freeBooksState.games || {}, { kalshi, league, state, q });
  return { ...screen, updated: freeBooksState.gamesAt || null, stale: !fresh };
}
function observeOddsHistory() {
  if (!freeBooksState.gamesAt || Date.now() - Date.parse(freeBooksState.gamesAt) >= FREE_BOOKS_MAX_AGE_MS) return;
  try { oddsHistory.observe(oddsScreenFor({ kalshiOk: true })); oddsScreenState.observedAt = new Date().toISOString(); }
  catch (e) { oddsScreenState.errors = [e.message]; }
  lineBets.observe(freeBooksState.games || {}).catch(e => console.warn('Line bets: observe:', e.message));
}
// MY BETS' game-line bets (linebets.js): a moneyline, spread or total logged
// from the odds screen is followed on Pinnacle's no-vig price at its exact
// number to the start, then graded from ESPN's final. Rows hold the line, never
// the user, the price or the stake.
const lineBets = require('./linebets').createLineBets({
  store: resultsBackup.wrap('lineBets', createEvStoreFromEnv(process.env, { table: 'line_bets', fileVar: 'LINE_BETS_FILE', file: 'line-bets.json' })),
});
lineBets.ready().catch(e => console.error('Line bets: store failed to initialise:', e.message));
async function gradeLineBets() {
  try { await lineBets.grade(bigGrader, lg => EV_RESULT_LEAGUE[lg] || null); } catch (e) { console.warn('Line bets: grade:', e.message); }
}
app.get('/api/odds-screen', (req, res) => {
  const pro = hasPro(req), lic = licenceOf(req);
  const league = /^[a-z0-9]+$/.test(String(req.query.league || '')) ? String(req.query.league) : null;
  const state = venues.stateOf(req.query.state);
  const screen = oddsScreenFor({ league, state, q: String(req.query.q || '').slice(0, 60), kalshiOk: !!lic.kalshi });
  const body = { ...(pro ? screen : oddsScreen.stripPro(screen)), pro, state, stateInfo: state ? venues.stateInfo(state) : null };
  res.json(regionSafe(body));
});
// one game's line history: every side's fair and venue prices over time
app.get('/api/odds-screen/history/:id', (req, res) => {
  const id = String(req.params.id || '').slice(0, 80);
  const lic = licenceOf(req), pro = hasPro(req);
  const series = oddsHistory.forGame(id).map(x => ({ ...x, pts: x.pts.map(([t, point, fair, px]) => [t, point, pro ? fair : null,
    lic.kalshi ? px : Object.fromEntries(Object.entries(px).filter(([k]) => k !== 'kalshi'))]) }));
  res.json({ id, series, pro });
});
// ─── EXCHANGE SHOPPER ─────────────────────────────────────────────────────────
// Every venue's price for the same bet on one row (shopper.js), built from
// what the reads above left in memory: no extra requests. Quotes are rebuilt
// only when a feed has a newer read. Kalshi needs its data licence.
const oddsSchema = require('./oddsschema');
const oddsProviders = require('./oddsproviders');
const shopper = require('./shopper');
const oddsEngine = require('./oddsengine');
const shopState = { key: null, free: { quotes: [], stats: {} }, kalshi: { quotes: [], stats: {} }, builtAt: null, ms: null };
const iso = t => (t ? new Date(t).toISOString() : null);
function shopReadAt() {
  const at = freeBooksState.gamesAt || null;
  const xb = xbooksState.at ? iso(xbooksState.at) : at;
  return { default: at, pinnacle: at, fanduel: at, betrivers: at, matchbook: xb, draftkings: xb, betmgm: xb, caesars: xb, bet365: xb, fanatics: xb, hardrock: xb, thescore: xb,
    gemini: geminiState.at ? iso(geminiState.at) : at, polymarketus: pmusBooksState.at ? iso(pmusBooksState.at) : at, kalshi: xarbState.rows?.at ? iso(xarbState.rows.at) : null };
}
const shopKey = () => `${Date.now() - Date.parse(freeBooksState.gamesAt || 0) < FREE_BOOKS_MAX_AGE_MS ? freeBooksState.gamesAt : ''}|${xarbState.rows?.at || 0}`;
// After each free-books read (the 40-second chain): the quotes are rebuilt one
// league at a time with a yield between, so no request waits on a long block.
async function prebuildShopQuotes() {
  const key = shopKey();
  if (shopState.key === key || !freeBooksState.gamesAt) return;
  const t0 = Date.now();
  const readAt = shopReadAt();
  const fresh = !key.startsWith('|');
  const out = { quotes: [], stats: {} };
  try {
    for (const [lg, games] of fresh ? Object.entries(freeBooksState.games || {}) : []) {
      const r = oddsProviders.fromFreeGames({ [lg]: games }, { readAt });
      for (const q of r.quotes) out.quotes.push(q);
      for (const [k, v] of Object.entries(r.stats)) { const a = out.stats[k] || (out.stats[k] = { events: 0, quotes: 0 }); a.events += v.events; a.quotes += v.quotes; }
      await new Promise(r2 => setImmediate(r2));
    }
  } catch (e) { console.warn('Shopper free books:', e.message); out.error = e.message; }
  let kal = { quotes: [], stats: {} };
  try { if (fresh && xarbState.rows?.at) kal = oddsProviders.fromKalshiBets(bigGames().bets, { readAt: readAt.kalshi }); }
  catch (e) { console.warn('Shopper Kalshi:', e.message); kal = { quotes: [], stats: {}, error: e.message }; }
  Object.assign(shopState, { key, free: out, kalshi: kal, builtAt: new Date().toISOString(), ms: Date.now() - t0, views: new Map() });
}
function shopQuotes() {
  const key = shopKey();
  const fresh = !key.startsWith('|');
  if (shopState.key !== key && !(shopState.key && Date.now() - Date.parse(shopState.builtAt || 0) < 90e3)) {
    const t0 = Date.now();
    const readAt = shopReadAt();
    try { shopState.free = fresh ? oddsProviders.fromFreeGames(freeBooksState.games, { readAt }) : { quotes: [], stats: {} }; }
    catch (e) { console.warn('Shopper free books:', e.message); shopState.free = { quotes: [], stats: {}, error: e.message }; }
    try { shopState.kalshi = fresh && xarbState.rows?.at ? oddsProviders.fromKalshiBets(bigGames().bets, { readAt: readAt.kalshi }) : { quotes: [], stats: {} }; }
    catch (e) { console.warn('Shopper Kalshi:', e.message); shopState.kalshi = { quotes: [], stats: {}, error: e.message }; }
    Object.assign(shopState, { key, builtAt: new Date().toISOString(), ms: Date.now() - t0, views: new Map() });
  }
  return shopState;
}
function shopHealth() {
  const st = shopQuotes();
  const errors = [...(freeBooksState.errors || []), ...(xbooksState.errors || []).map(e => (/^(action|matchbook)/i.test(e) ? e : `action ${e}`)),
    ...(geminiState.errors || []).map(e => `gemini ${e}`), ...(pmusBooksState.errors || []).map(e => `polymarketus ${e}`), ...(st.free.error ? [`pinnacle ${st.free.error}`] : []),
    ...((xarbState.errors || []).filter(e => /kalshi/i.test(String(e))).map(e => `kalshi ${e}`)), ...(st.kalshi.error ? [`kalshi ${st.kalshi.error}`] : [])];
  const enabled = { pinnacle: freeBooksState.enabled, fanduel: freeBooksState.enabled, betrivers: freeBooksState.enabled, gemini: geminiState.enabled, polymarketus: pmusBooksState.enabled,
    matchbook: xbooksState.enabled && xbooksState.matchbook, kalshi: true,
    ...Object.fromEntries(['draftkings', 'betmgm', 'caesars', 'bet365', 'fanatics', 'hardrock', 'thescore'].map(k => [k, xbooksState.enabled && xbooksState.action])) };
  return oddsProviders.health({ stats: { ...st.free.stats, ...st.kalshi.stats }, errors, readAt: shopReadAt(), enabled });
}
const shopList = v => (v ? String(v).toLowerCase().split(',').map(x => x.trim()).filter(Boolean) : null);
const shopNum = v => (v == null || v === '' ? null : Number.isFinite(parseFloat(v)) ? parseFloat(v) : null);
// GET /api/shopper?sport=&league=&q=&markets=moneyline,spread,total,player_prop
// &providers=&exclude=&state=TX&hours=48&minEv=1 (percent)&minEdge= (points)
// &minLiquidity=&minSize= (dollars every shown exchange price must fill, fee in)&maxAge= (seconds)&priced=1&arbs=1&sort=ev|start|hold|gap|venues
// &stake=100&method=power|multiplicative|additive|shin&limit=200
app.get('/api/shopper', (req, res) => {
  const q = req.query;
  const st = shopQuotes();
  const lic = licenceOf(req);
  const pro = hasPro(req);
  // the same question within 30 s of the same read is answered from memory
  const vkey = `${lic.kalshi ? 1 : 0}|${pro ? 1 : 0}|${Object.keys(q).sort().map(k => `${k}=${q[k]}`).join('&')}`;
  const hit = st.views?.get(vkey);
  if (hit && Date.now() - hit.at < 30e3) return res.type('json').send(hit.body);
  const quotes = lic.kalshi ? [...st.free.quotes, ...st.kalshi.quotes] : st.free.quotes;
  const hours = shopNum(q.hours);
  const minEv = shopNum(q.minEv);
  const view = shopper.build(quotes, {
    sport: q.sport || null, league: q.league || null, q: q.q || '', marketTypes: shopList(q.markets), providers: shopList(q.providers), exclude: shopList(q.exclude),
    state: q.state || null, toMs: hours != null && hours > 0 ? Date.now() + Math.min(hours, 24 * 14) * 3600e3 : undefined,
    minEv: minEv == null ? undefined : minEv / 100, minEdgePts: shopNum(q.minEdge) ?? undefined, minLiquidity: shopNum(q.minLiquidity) ?? undefined,
    maxAgeSec: shopNum(q.maxAge) ?? undefined, pricedOnly: q.priced === '1', arbsOnly: q.arbs === '1', sort: q.sort || 'ev', stake: shopNum(q.stake) || 100,
    method: q.method, limit: parseInt(q.limit) || 200, proven: evBookProven,
    depth: shopDepth.forQuote, minSize: Math.min(Math.max(shopNum(q.minSize) || 0, 0), 100000) || null,
  });
  const body = JSON.stringify({ ...(pro ? view : shopper.stripPro(view)), pro, builtAt: st.builtAt, buildMs: st.ms, providers: shopHealth(), formats: oddsSchema.FORMATS,
    devigMethods: oddsEngine.DEVIG_METHODS, stateInfo: venues.stateInfo(q.state),
    note: 'Prices are what each feed showed at its last read. Nothing here is a proven edge unless its label says proven; check the price in the app before you bet.' });
  if (st.views) { if (st.views.size > 40) st.views.clear(); st.views.set(vkey, { at: Date.now(), body }); }
  res.type('json').send(body);
});
// Line history for player props (shopper.createLineHistory): after a quote
// rebuild, at most every 3 minutes, each prop market's fair and venue prices
// are noted, a few hundred markets at a time with a yield between. Rides the
// results backup like the odds screen's game-line history.
const propHistory = shopper.createLineHistory();
let propHistoryBooted = false;
const propHistoryStore = resultsBackup.wrap('propHistory', {
  init: async () => {}, all: async () => (propHistoryBooted ? propHistory.dump() : []),
  put: async d => { propHistory.load([d]); }, putMany: async ds => { propHistory.load(ds); },
}, { appendOnly: false });
propHistoryStore.init().catch(e => console.warn('Prop history: restore failed:', e.message)).finally(() => { propHistoryBooted = true; });
const propHistoryState = { at: 0, observedAt: null, markets: 0, ms: null, error: null };
async function observePropHistory() {
  const st = shopState;
  if (!st.builtAt || Date.now() - propHistoryState.at < 3 * 60e3) return;
  propHistoryState.at = Date.now();
  const t0 = Date.now();
  try {
    const props = [...st.free.quotes, ...st.kalshi.quotes].filter(q => q.marketType === 'player_prop' && q.marketStatus === 'open' && q.available !== false && Date.parse(q.startUtc) > Date.now() - 5 * 60e3);
    const grouped = [...shopper.groupMarkets(props).values()];
    const filter = shopper.providerFilter({});
    let views = [];
    for (let i = 0; i < grouped.length; i++) {
      const v = shopper.viewMarket(grouped[i], { filter, stake: 100, now: Date.now(), method: 'power' });
      if (v) views.push(v);
      if (i % 300 === 299) { propHistory.observe(views); views = []; await new Promise(r => setImmediate(r)); }
    }
    propHistory.observe(views);
    Object.assign(propHistoryState, { observedAt: new Date().toISOString(), markets: grouped.length, ms: Date.now() - t0, error: null });
  } catch (e) { propHistoryState.error = e.message; console.warn('Prop history:', e.message); }
}
// The shopper's own book reads: exchange prices on markets with a fair, near
// or above it, and arb legs, read a few a minute per venue (depthbook.READ_BUDGET)
// on top of the size record's reads; each book kept 5 minutes.
let shopDepthRunning = false;
async function readShopDepth() {
  if (!shopDepthOn() || shopDepthRunning || !shopState.builtAt) return;
  shopDepthRunning = true;
  try {
    const t = Date.now();
    const all = [...shopState.free.quotes, ...shopState.kalshi.quotes].filter(q => q.marketType !== 'player_prop' && q.marketStatus === 'open' && q.available !== false
      && Date.parse(q.startUtc) > t && Date.parse(q.startUtc) < t + 48 * 3600e3);
    const keys = new Set(all.filter(q => depthBook.EXCHANGES.has(q.providerId)).map(q => shopper.groupOf(q)?.key).filter(Boolean));
    const grouped = [...shopper.groupMarkets(all.filter(q => keys.has(shopper.groupOf(q)?.key))).values()];
    const filter = shopper.providerFilter({});
    const views = [];
    for (let i = 0; i < grouped.length; i++) {
      const v = shopper.viewMarket(grouped[i], { filter, stake: 100, now: t, method: 'power' });
      if (v && v.fair) views.push(v);
      if (i % 300 === 299) await new Promise(r => setImmediate(r));
    }
    await shopDepth.readPass(depthBook.candidates(views));
  } catch (e) { shopDepth.state.errors = [e.message, ...shopDepth.state.errors].slice(0, 5); }
  finally { shopDepthRunning = false; }
}
// one prop market's history: GET /api/shopper/history?key=<market key>.
// Free viewers get prices without the fair; Kalshi needs its data licence.
app.get('/api/shopper/history', (req, res) => {
  const key = String(req.query.key || '').slice(0, 300);
  const lic = licenceOf(req), pro = hasPro(req);
  const h = key ? propHistory.forMarket(key) : null;
  if (!h) return res.json({ key, series: [], pro, note: 'No saved prices for this market yet: prop prices are saved every few minutes from when a market first shows up.' });
  res.json({ ...h, pro, series: h.series.map(x => ({ ...x, pts: x.pts.map(([t, line, fair, px]) => [t, line, pro ? fair : null,
    lic.kalshi ? px : Object.fromEntries(Object.entries(px).filter(([k]) => k !== 'kalshi'))]) })) });
});
// which optional feeds this server has, for the app's tab bar: without an
// Odds API key the LINES, LINE SHOP and CLV tabs have nothing to show, so the
// app hides them (the ODDS SCREEN covers them from the free feeds)
app.get('/api/features', (req, res) => res.set('Cache-Control', 'public, max-age=300').json({ oddsApi: !!ODDS_API_KEY }));
// provider health on its own (status, last read, errors, fee handling)
app.get('/api/providers', (req, res) => res.json({ providers: shopHealth(), builtAt: shopQuotes().builtAt }));
// ─── BOOK ARBS AND MIDDLES ────────────────────────────────────────────────────
// FanDuel's and BetRivers' main and alternate lines and player props against
// each other and against Kalshi and Polymarket US (bookarbs.js). Each exchange
// leg's book is read for the size resting at the price; every row is logged
// and both legs checked again two minutes on (bookarbtrack.js). No alerts
// until bookArbTracker.summary().proven (50 rows with both legs fillable).
const bookArbs = require('./bookarbs');
const bookArbTracker = require('./bookarbtrack').createBookArbTracker({
  store: resultsBackup.wrap('bookArbs', createEvStoreFromEnv(process.env, { table: 'book_arbs', fileVar: 'BOOKARB_TRACK_FILE', file: 'book-arbs.json' })),
});
bookArbTracker.ready().catch(e => console.error('Book arbs: store failed to initialise:', e.message));
const bookArbState = { arbs: [], middles: [], counts: null, updated: null, dataAt: null, errors: [], reads: 0 };
const bookArbBooks = new Map();   // `${venue}:${marketId}` → { at, payload }
async function bookArbRead(leg, t, budget) {
  const k = `${leg.venue}:${leg.marketId}`;
  const c = bookArbBooks.get(k);
  if (c && t - c.at < 45e3) return c.payload;
  if (budget.left <= 0) return undefined;
  budget.left--;
  try {
    const payload = leg.venue === 'kalshi' ? (await upstream.get(execcheck.KALSHI_BOOK_URL(leg.marketId), { timeout: 10000 }))?.data
      : polymarketUs ? await polymarketUs.book(leg.marketId) : null;
    if (payload == null) return undefined;
    bookArbBooks.set(k, { at: t, payload });
    return payload;
  } catch { return undefined; }
}
function bookArbAsks(leg, payload) {
  if (leg.venue === 'kalshi') return execcheck.kalshiAsks(payload, leg.side);
  if (payload?.open === false || !(leg.yesSide === 'long' || leg.yesSide === 'short')) return [];
  return execcheck.pmusAsks(payload, leg.side === 'yes' ? leg.yesSide : leg.yesSide === 'long' ? 'short' : 'long');
}
async function scanBookArbs() {
  const dataAt = freeBooksState.gamesAt;
  if (!dataAt || Date.now() - Date.parse(dataAt) >= FREE_BOOKS_MAX_AGE_MS) return;
  const t = Date.now(), budget = { left: 30 };
  const collected = bookArbs.collect({ gamesBySport: freeBooksState.games, exchangeRows: bigGames().rows, kalshiRungs: kpropsState.rungs || null,
    leagueOf: s => freebooks.LEAGUES[s]?.props || s.toUpperCase(), now: t });
  const found = bookArbs.find(collected, { now: t });
  // the size behind each exchange leg, best rows first; a leg whose book no
  // longer holds the price at all takes its row off the list
  const rows = [...found.arbs, ...found.middles];
  for (const leg of bookArbs.legsToRead(rows, 20)) await bookArbRead(leg, t, budget);
  const gone = new Set();
  for (const r of rows) for (const l of r.legs) {
    if (!bookArbs.EXCHANGES.has(l.venue)) continue;
    const c = bookArbBooks.get(`${l.venue}:${l.marketId}`);
    if (!c || t - c.at > 60e3) continue;
    l.fill = bookArbs.fillable(r, l, bookArbAsks(l, c.payload));
    // under $10 of size isn't a bet anyone can place: off the list
    if (r.type === 'arb' ? !(l.fill.maxStake >= 10) : !(l.fill.atPrice >= 10)) gone.add(r.id);
  }
  for (const r of rows) {
    const fills = r.legs.filter(l => l.fill).map(l => l.fill);
    r.maxStake = r.type === 'arb' && fills.length ? Math.min(...fills.map(f => f.maxStake)) : null;
  }
  const keep = r => !gone.has(r.id);
  // two minutes on: re-read the due rows' exchange books, then check both legs
  const due = await bookArbTracker.due(dataAt);
  for (const r of due) for (const l of r.legs) if (bookArbs.EXCHANGES.has(l.venue)) await bookArbRead(l, t, budget);
  const fillAt = l => {
    const c = bookArbBooks.get(`${l.venue}:${l.marketId}`);
    if (!c || t - c.at > 60e3) return null;
    // contracts resting at or under the leg's shown all-in cost
    return Math.floor(bookArbAsks(l, c.payload).reduce((a, [p, n]) => a + (bookArbs.exchangeCost(l.venue, p) <= l.cost + 1e-4 ? n : 0), 0));
  };
  await bookArbTracker.check(bookArbs.quoteIndex(collected), fillAt, dataAt).catch(e => console.warn('Book arb tracker:', e.message));
  const arbs = found.arbs.filter(keep), middles = found.middles.filter(keep);
  await bookArbTracker.record([...arbs, ...middles], dataAt).catch(e => console.warn('Book arb tracker:', e.message));
  Object.assign(bookArbState, { arbs, middles, dataAt, updated: new Date(t).toISOString(), reads: 30 - budget.left,
    counts: { ...bookArbs.summarize({ arbs, middles, counts: found.counts }), stale: gone.size } });
}
const bigRungMid = rung => (rung && rung.yesBid > 0 && rung.yesAsk < 1 && rung.yesAsk > rung.yesBid ? (rung.yesBid + rung.yesAsk) / 2 : null);
const ladderKey = rung => `${rung.eventTicker}|${evScreen.canonName(rung.player)}|${rung.mkey}`;
// a stored print → the bet it backed
function bigResolve(p, games) {
  if (p.exchange === 'kalshi') {
    const rung = kpropsState.rungs?.get(p.market);
    if (rung) {
      const side = p.yes ? 'Over' : 'Under';
      return { kind: 'prop', betKey: `prop|${rung.league}|${evScreen.canonName(rung.player)}|${rung.mkey}|${rung.line}|${side}`, sport: rung.league, player: rung.player,
        mkey: rung.mkey, stat: rung.stat, line: rung.line, side, start: rung.start, ladder: ladderKey(rung), rung, title: `${rung.player} ${side} ${rung.line} ${rung.stat}`, backsRowYes: p.yes };
    }
  }
  const id = p.exchange === 'polymarket' ? p.conditionId || p.market : p.market;
  const g = games.rows.get(`${p.exchange}:${id}`);
  if (!g) return null;
  const rowYes = p.exchange === 'polymarket' ? (p.yes ? 0 : 1) === (g.row.yesIndex ?? 0) : p.yes;
  const key = rowYes ? g.yes : g.no;
  const b = key && games.bets.get(key);
  if (!b || !g.league || !BIG_LEAGUE[g.league]) return null;
  return { kind: 'game', betKey: key, sport: BIG_LEAGUE[g.league], title: b.label, matchup: `${g.game.away} @ ${g.game.home}`, side: key.split('|').pop(), start: g.game.start,
    game: { league: BIG_LEAGUE[g.league], home: g.game.home, away: g.game.away, start: g.game.start }, backsRowYes: rowYes, row: g.row };
}
// the props board row for a player and stat, nearest the start
function bigBoardRow(rows, sport, player, mkey, start) {
  const t = Date.parse(start || '');
  let best = null;
  for (const r of rows.get(`${sport}|${evScreen.canonName(player)}|${mkey}`) || []) {
    const d = Math.abs(Date.parse(r.startTime || '') - t);
    if (Number.isFinite(d) && d <= 6 * 3600e3 && (!best || d < best.d)) best = { r, d };
  }
  return best?.r || null;
}
let bigBookProps = { at: null, idx: new Map() };
function bigBookPropsFor(key, start) {
  if (bigBookProps.at !== freeBooksState.gamesAt) bigBookProps = { at: freeBooksState.gamesAt, idx: bigMoney.bookPropIndex(freeBooksState.games, s => freebooks.LEAGUES[s]?.props || null) };
  if (Date.now() - Date.parse(freeBooksState.gamesAt || 0) >= FREE_BOOKS_MAX_AGE_MS) return [];
  const t = Date.parse(start || '');
  return (bigBookProps.idx.get(key) || []).filter(q => Math.abs(Date.parse(q.start) - t) <= 3 * 3600e3);
}
// a side's chance at a line from a P(over) quoted at another line
const sideAt = (mkey, sport, fromLine, pOverAt, line, side) => { const p = bigMoney.atLine(mkey, sport, fromLine, pOverAt, line); return p == null ? null : side === 'Over' ? p : 1 - p; };
// one grouped play → priced, with venues, best, Pinnacle and the flow label
function bigPrice(play, ctx) {
  const { games, boardRows, byMarket, byLadder } = ctx;
  const fair = play.money.price;
  let venues = [], pin = null, now = null, sharp = null, url = null;
  if (play.kind === 'prop') {
    const row = bigBoardRow(boardRows, play.sport, play.player, play.mkey, play.start);
    const key = `${play.sport}|${evScreen.canonName(play.player)}|${play.mkey}`;
    venues = bigMoney.propVenues({ sport: play.sport, mkey: play.mkey, line: play.line, side: play.side, fair }, { board: row, books: bigBookPropsFor(key, play.start), dfsEv: dfsLegEv, o: BIG_OPTS });
    const rung = play.rung, mid = bigRungMid(rung);
    if (mid != null) now = play.side === 'Over' ? mid : 1 - mid;
    // Kalshi's own ask for the side now (the money's market)
    const ask = play.side === 'Over' ? rung.yesAsk : rung.yesBid > 0 ? 1 - rung.yesBid : null;
    const cost = ask > 0 && ask < 1 ? bigMoney.exchangeCost({ exchange: 'kalshi' }, ask) : null;
    if (cost) venues.push({ venue: 'kalshi', name: 'Kalshi', line: play.line, sameLine: true, fair, implied: cost, decimal: +(1 / cost).toFixed(4), price: ask, american: bigMoney.american(cost), ev: +((fair / cost - 1) * 100).toFixed(2), own: true });
    const pq = row || { key, startTime: play.start };
    const pinQ = pinprops.quoteFor(pinPropsIndex, { ...pq, key });
    if (pinQ) pin = sideAt(play.mkey, play.sport, pinQ.line, pinQ.pOver, play.line, play.side);
    for (const v of venues) {
      const pv = pinQ ? sideAt(play.mkey, play.sport, pinQ.line, pinQ.pOver, v.line, play.side) : null;
      if (pv != null) { v.pin = +pv.toFixed(4); v.evPin = +((pv * v.decimal - 1) * 100).toFixed(2); }
    }
    if (row) {
      const c = sportProps.consensusFor(row, play.line, { sharp: sharpQuotes(row), kalshi: rowKalshi(row), o: SHARP_OPTS });
      if (c) sharp = play.side === 'Over' ? c.p : 1 - c.p;
    }
    url = rung.url;
    play.prop = { sport: play.sport, player: play.player, mkey: play.mkey, startTime: play.start, team: row?.team || '', matchTitle: row?.matchTitle || '' };
  } else {
    const b = games.bets.get(play.betKey);
    pin = b?.pin ?? null;
    sharp = pin;
    for (const v of b?.venues || []) {
      const own = v.venue === play.money.exchange && String(v.marketId) === String(play.money.market);
      venues.push({ ...v, line: null, sameLine: true, fair, ev: +((fair * v.decimal - 1) * 100).toFixed(2), ...(own ? { own: true } : {}),
        ...(pin != null ? { pin, evPin: +((pin * v.decimal - 1) * 100).toFixed(2) } : {}) });
    }
    const m = play.row ? (play.row.yesAsk > 0 && play.row.noAsk > 0 ? (play.row.yesAsk + 1 - play.row.noAsk) / 2 : null) : null;
    if (m != null) now = play.backsRowYes ? m : 1 - m;
    url = play.money.exchange === 'kalshi' ? play.row?.url || null : null;   // never a polymarket.com link
  }
  venues.sort((a, b) => b.ev - a.ev);
  const best = bigMoney.pickBest(venues, BIG_OPTS);
  const flow = bigMoney.flowOf({ ...play.money }, { market: byMarket.get(`${play.money.exchange}|${play.money.market}`) || [], ladder: play.ladder ? byLadder.get(play.ladder) || [] : [],
    side: play.kind === 'prop' ? play.side : null, isMaker: w => !!tailEngine.trader(w)?.marketMaker, o: BIG_OPTS });
  const { rung, row, ...rest } = play;
  return { ...rest, id: play.betKey, url, venues, best, pinFair: pin == null ? null : +pin.toFixed(4), sharpFair: sharp == null ? null : +sharp.toFixed(4), now: now == null ? null : +now.toFixed(4),
    flow: flow.flow, why: flow.why, minEv: BIG_OPTS.minEv, flagged: !!(best && best.ev >= BIG_OPTS.minEv) };
}
async function scanBigMoney() {
  if (process.env.BIG_MONEY === 'off') return;
  const t = Date.now();
  for (const p of whaleWatcher.prints({ since: t - BIG_OPTS.keepMs, minUsd: BIG_OPTS.floorUsd })) {
    const n = bigMoney.normPrint(p);
    if (n) bigState.store.set(n.key, n);
  }
  for (const [k, p] of bigState.store) if (p.at < t - BIG_OPTS.keepMs) bigState.store.delete(k);
  const store = [...bigState.store.values()].sort((a, b) => a.at - b.at);
  const games = bigGames();
  // prints by market, and Kalshi props by player ladder (the flow label reads these)
  const byMarket = new Map(), byLadder = new Map();
  for (const p of store) {
    const k = `${p.exchange}|${p.market}`;
    if (!byMarket.has(k)) byMarket.set(k, []);
    byMarket.get(k).push(p);
    const rung = p.exchange === 'kalshi' ? kpropsState.rungs?.get(p.market) : null;
    if (rung) { const l = ladderKey(rung); if (!byLadder.has(l)) byLadder.set(l, []); byLadder.get(l).push(p); }
  }
  const boardRows = new Map();
  for (const r of propsBoardRows().rows || []) {
    if (r.esports) continue;
    const k = r.key.replace(/\|\d{4}-\d{2}-\d{2}$/, '');
    if (!boardRows.has(k)) boardRows.set(k, []);
    boardRows.get(k).push(r);
  }
  const grouped = bigMoney.groupMoney(store, p => bigResolve(p, games), { now: t, o: BIG_OPTS });
  const plays = [];
  for (const g of grouped.slice(0, BIG_OPTS.maxPlays)) {
    try { plays.push(bigPrice(g, { games, boardRows, byMarket, byLadder })); } catch (e) { bigState.errors = [e.message, ...bigState.errors].slice(0, 5); }
  }
  bigState.plays = plays;
  bigState.updated = new Date(t).toISOString();
  bigState.counts = { prints: store.length, big: store.filter(p => p.usd >= BIG_OPTS.minUsd && !p.block).length, plays: plays.length, flagged: plays.filter(p => p.flagged).length,
    marketMaker: plays.filter(p => p.flow === 'market maker').length, props: plays.filter(p => p.kind === 'prop').length, games: plays.filter(p => p.kind === 'game').length,
    rungs: kpropsState.rungs?.size || 0, gameRows: games.rows.size, bets: games.bets.size };
  await bigTracker.record(plays.filter(p => p.flagged));
  await bigTracker.mark(r => bigMarkLookup(r, { games, boardRows }));
  if (t - (bigState.gradedAt || 0) > 10 * 60e3) { bigState.gradedAt = t; await bigTracker.grade(); }
}
// a logged row → the venue's price now, the money's market and the sharp fair at our line
function bigMarkLookup(r, { games, boardRows }) {
  if (r.kind === 'prop') {
    const rung = kpropsState.rungs?.get(r.moneyMarket);
    const row = bigBoardRow(boardRows, r.sport, r.prop?.player, r.prop?.mkey, r.start);
    const mid = bigRungMid(rung);
    const close = mid == null ? null : sideAt(r.prop.mkey, r.sport, r.moneyLine, mid, r.line, r.side);
    let sharp = null, venue = null;
    if (row) {
      const c = sportProps.consensusFor(row, r.line, { sharp: sharpQuotes(row), kalshi: rowKalshi(row), o: SHARP_OPTS });
      if (c) sharp = r.side === 'Over' ? c.p : 1 - c.p;
      const cell = row.books[r.venue];
      if (cell && (r.side === 'Over' ? cell.overOpen : cell.underOpen)) { const pr = bigMoney.appPrice(r.venue, cell, r.side, r.fair, dfsLegEv); if (pr) venue = { line: cell.line, decimal: pr.decimal }; }
    }
    if (!venue && (r.venue === 'fanduel' || r.venue === 'betrivers')) {
      const q = bigBookPropsFor(`${r.sport}|${evScreen.canonName(r.prop.player)}|${r.prop.mkey}`, r.start).find(x => x.book === r.venue && x.line === r.line);
      const a = q && (r.side === 'Over' ? q.over : q.under);
      if (a) venue = { line: q.line, decimal: a > 0 ? 1 + a / 100 : 1 + 100 / -a };
    }
    return { venue, close, sharp };
  }
  const b = games.bets.get(r.betKey);
  const v = b?.venues.find(x => x.venue === r.venue);
  const g = r.moneyExchange === 'polymarket' ? games.rows.get(`polymarket:${r.moneyMarket}`) : games.rows.get(`${r.moneyExchange}:${r.moneyMarket}`);
  const row = g?.row;
  const m = row && row.yesAsk > 0 && row.noAsk > 0 ? (row.yesAsk + 1 - row.noAsk) / 2 : null;
  const yesKey = g?.yes;
  return { venue: v ? { line: null, decimal: v.decimal } : null, close: m == null ? null : yesKey === r.betKey ? m : 1 - m, sharp: b?.pin ?? null };
}

// Every two minutes after the scrapes: flag, check two minutes on, keep the close
let sportTrackRunning = false;
async function trackSportProps() {
  if (sportTrackRunning) return;
  sportTrackRunning = true;
  try {
    propsBoardCache.at = 0;
    const { rows, sportPlays } = propsBoardRows();
    // when each app's lines were last read (a PrizePicks pull that failed read nothing)
    const updated = { prizepicks: ppState.fullOkAt ? new Date(ppState.fullOkAt).toISOString() : null, underdog: cache.underdog.updated, sleeper: cache.sleeperSports.updated, ...pick6.readTimes() };
    // a Pick6 leg goes in under a kind of its own, so its record stands apart
    const flagged = [...sportPlays.filter(x => x.research || x.kind === 'sharp' || x.kind === 'sharp3' || x.kind === 'combo' || x.play.ev >= SPORT_OPTS.minEv), ...staleAppPlays(rows)]
      .map(x => (x.play.book === 'pick6' && !x.research ? { ...x, kind: P6_KIND(x.kind) } : x));   // research rows stay research

    await sportTracker.record({ rows: rows.filter(r => !r.esports), flagged, fairAt: sportFairAt, sharpAt: sportSharpAt, pinAt: stalePinAt, sourcesAt: comboSourcesAt, updated });
    // the slip log's legs keep their close on the same reads, on the sharp consensus
    await slipLegTracker.record({ rows: rows.filter(r => !r.esports), flagged: [], fairAt: slipFairAt, updated });
    // the softest number across the apps (appshop.js): kinds shop-any, shop-pp,
    // shop-p6 and shop-mid in a record of their own (own store, own grading
    // budget), never plays or alerts
    if (APP_SHOP_RECORD) {
      const byKey = new Map(rows.map(r => [r.key, r]));
      const shopFlags = [];
      for (const x of appShop.recordLegs(shopBoard())) { const row = byKey.get(x.rowKey); if (row) shopFlags.push({ row, play: x.play, kind: x.kind, research: true }); }
      await shopTracker.record({ rows: rows.filter(r => !r.esports), flagged: shopFlags, fairAt: sportFairAt, updated });
    }
  } catch (e) { console.warn('Sports props record:', e.message); }
  finally { sportTrackRunning = false; }
}
app.get('/api/props/board', (req, res) => {
  const { rows, counts } = propsBoardRows();
  const pro = hasPro(req);
  // Kalshi's prices back the sports fair; without its licence those stay hidden
  const kalshiOk = licenceOf(req).kalshi;
  const book = propsBoard.BOOKS.includes(req.query.book) ? req.query.book : '';
  const sort = pro ? String(req.query.sort || 'ev') : (req.query.sort === 'ev' || !req.query.sort ? 'books' : String(req.query.sort));
  const qo = { sport: req.query.sport, book, q: req.query.q, sort, multi: req.query.multi === '1', priced: pro && req.query.priced === '1', gaps: req.query.gaps === '1', sharp: req.query.sharp === '1', sharp3: req.query.sharp3 === '1', combo: req.query.combo === '1' };
  const market = String(req.query.market || '').slice(0, 80);
  const hits = propsBoard.queryRows(rows, { ...qo, market });
  // the Lines view: one app's lines, with the header count and the prop filter
  let lines = null;
  if (book && req.query.facets === '1') {
    const f = propsBoard.lineFacets(market ? propsBoard.queryRows(rows, qo) : hits, book, SHARP_OPTS.minEv);
    lines = { markets: f.markets, bettable: pro ? propsBoard.lineFacets(hits, book, SHARP_OPTS.minEv).bettable : null, minEv: SHARP_OPTS.minEv };
  }
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit) || 150));
  const offset = Math.max(0, parseInt(req.query.offset) || 0);
  let page = hits.slice(offset, offset + limit);
  if (!pro) page = page.map(propsBoard.redactRow);
  else if (!kalshiOk) page = page.map(r => (r.esports ? r : propsBoard.redactRow(r)));
  res.json({
    rows: page, total: hits.length, offset, limit, pro, counts, ...(lines ? { lines } : {}),
    // the esports models' verdicts (esmodels.js): a failed one's legs are not plays
    esModels: esModelsState.cards ? Object.fromEntries(esModelsState.cards.map(c => [c.key, { verdict: c.verdict, graded: c.graded, wins: c.wins, losses: c.losses, hitPct: c.hitPct, breakEvenPct: c.breakEvenPct, units: c.units }])) : null,
    coverage: propsBoardCache.coverage ? { leagues: propsBoardCache.coverage.leagues, byApp: propsBoardCache.coverage.byApp } : null,
    updated: { underdog: cache.underdog.updated, prizepicks: cache.prizepicks.updated, sleeper: cache.sleeper.updated, kalshi: kpropsState.updated, esports: esportsCache.lastUpdated },
  });
});

// ── SHOP: the softest number across the apps (appshop.js) ──
// Every player stat two or more apps hang at different numbers: the softest
// app per side (lowest line for an Over, highest for an Under), the gap to the
// nearest other app, the sharp price at that number where Pinnacle, Kalshi or
// the books post one, the leg's EV at its own app's payout, and the middles
// between two apps worth more than zero on the stat's curve. A research view:
// the backtest (checks/app-shop-2026-10-25) found the softest number short of
// every break-even, so nothing here is a play or an alert.
const appShop = require('./appshop');
// APP_SHOP_RECORD=off stops recording the shop legs (on by default: alerts are off either way)
const APP_SHOP_RECORD = String(process.env.APP_SHOP_RECORD || 'on').toLowerCase() !== 'off';
let shopCache = { at: 0, src: null, rows: [] };
function shopBoard() {
  const { rows } = propsBoardRows();
  if (shopCache.src === rows && Date.now() - shopCache.at < 60000) return shopCache.rows;
  const sharpAt = (row, line) => {
    const f = sportProps.consensusFor(row, line, { sharp: sharpQuotes(row), kalshi: rowKalshi(row), o: SHARP_OPTS });
    if (!f) return null;
    const names = [...new Set((f.sources || []).filter(s => !s.shadow).map(s => s.book))];
    return { p: f.p, source: sportProps.sharpBacked(f) ? 'sharp' : 'books', books: names };
  };
  const evOf = (p, app, side, cell, mult) => dfsLegEv(p, app, mult ?? 1, { overMultiplier: cell.over, underMultiplier: cell.under }, side);
  const out = appShop.shopRows(rows, { sharpAt, evOf });
  shopCache = { at: Date.now(), src: rows, rows: out };
  return out;
}
app.get('/api/props/shop', (req, res) => {
  let rows = shopBoard();
  const pro = hasPro(req), kalshiOk = licenceOf(req).kalshi;
  const sport = String(req.query.sport || 'ALL').toUpperCase();
  if (sport !== 'ALL' && sport !== 'SPORTS') rows = rows.filter(r => r.sport === sport);
  const q = String(req.query.q || '').toLowerCase().slice(0, 60);
  if (q) rows = rows.filter(r => `${r.player} ${r.team} ${r.market} ${r.matchTitle}`.toLowerCase().includes(q));
  const minGap = Math.max(appShop.MIN_GAP, parseFloat(req.query.minGap) || 0);
  rows = rows.filter(r => r.gap >= minGap);
  if (req.query.middles === '1') rows = rows.filter(r => r.middles.length);
  const sort = String(req.query.sort || 'gap');
  if (pro && sort === 'ev') rows = [...rows].sort((a, b) => (b.bestEv ?? -1e9) - (a.bestEv ?? -1e9) || b.gap - a.gap);
  else if (pro && sort === 'middle') rows = [...rows].sort((a, b) => (b.middles[0]?.expUnits ?? -1e9) - (a.middles[0]?.expUnits ?? -1e9));
  else if (sort === 'start') rows = [...rows].sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime));
  const sports = {};
  for (const r of shopBoard()) sports[r.sport] = (sports[r.sport] || 0) + 1;
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit) || 150));
  const offset = Math.max(0, parseInt(req.query.offset) || 0);
  let page = rows.slice(offset, offset + limit);
  // the fair, EV and middles are Pro, and a Kalshi-backed fair needs its licence
  if (!pro || !kalshiOk) page = page.map(appShop.redactShop);
  res.json({ rows: page, total: rows.length, offset, limit, pro, counts: { sports, rows: shopBoard().length, books: {} },
    middles: rows.filter(r => r.middles.length).length, minGap, updated: new Date(shopCache.at).toISOString(),
    note: 'Research: on the recorded boards the softest number won 52.6% at PrizePicks (589 legs) vs its 55.0% break-even. Not a play until its own record clears 50 graded live.' });
});

// the shop's own record: P1-P3 and the middles (appshop.recordSummary), free
let shopRecordCache = { at: 0, body: null };
app.get('/api/props/shop/record', async (req, res) => {
  try {
    if (!shopRecordCache.body || Date.now() - shopRecordCache.at > 60e3) shopRecordCache = { at: Date.now(), body: appShop.recordSummary(await shopTracker.list({ limit: 1e6 })) };
    res.json({ ...shopRecordCache.body, recording: APP_SHOP_RECORD, preregistered: 'checks/app-shop-2026-10-25/PREREGISTERED.md' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── COVERAGE: how many pick'em legs carry a sharp price (propsboard.coverage) ──
// By app, league and stat: legs priced off Pinnacle, off Kalshi, a sportsbook
// alone, the other apps only, or nothing; `never` marks stats no sharp market
// lists. Counts only, free. ?sport=MMA narrows the markets list.
app.get('/api/props/coverage', (req, res) => {
  const { coverage } = propsBoardRows();
  const sport = String(req.query.sport || '').toUpperCase();
  res.json({ ...coverage, markets: sport ? coverage.markets.filter(m => m.sport === sport) : coverage.markets,
    sources: { pinnacleProps: pinPropsState.props, pinnacleExtra: pinPropsState.extra || null, kalshiExtra: kxExtraState, kalshiLadders: kpropsState.counts },
    updated: new Date(propsBoardCache.at).toISOString() });
});

// The Lines view's "Used?" boxes, kept on the account so they follow the
// person between devices (the page keeps them in localStorage without one).
// key → when ticked; a week on, the game is long over.
const USED_KEEP_MS = 7 * 86400e3, USED_MAX = 2000;
function usedOf(user) {
  const now = Date.now(), out = {};
  for (const [k, t] of Object.entries(user.used || {})) if (now - t < USED_KEEP_MS) out[k] = t;
  return out;
}
app.get('/api/me/used', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Log in first' });
  res.json({ used: Object.keys(usedOf(req.user)) });
});
app.post('/api/me/used', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Log in first' });
  const keys = (Array.isArray(req.body?.keys) ? req.body.keys : [req.body?.key]).filter(k => typeof k === 'string' && k && k.length <= 200).slice(0, 200);
  if (!keys.length) return res.status(400).json({ error: 'key needed' });
  const used = usedOf(req.user);
  for (const k of keys) { if (req.body?.used === false) delete used[k]; else used[k] = Date.now(); }
  const trimmed = Object.fromEntries(Object.entries(used).sort((a, b) => b[1] - a[1]).slice(0, USED_MAX));
  try {
    const fresh = (await auth.store.get(req.user.id)) || req.user;
    await auth.store.put({ ...fresh, used: trimmed });
    res.json({ used: Object.keys(trimmed) });
  }
  catch (e) { sendErr(res, e); }
});

// MY SLIPS: a user's pick'em legs (no stakes) → each leg against the close.
// A leg is matched to its props-board row and followed from first sight on the
// sharp consensus at its own line (sliplog.js); a leg whose game started
// before it reached us says 'no line history'. Free, like the records.
// The fair is the props record's sharp consensus, down to one source: a leg
// Pinnacle or Kalshi alone prices still gets a close (weights put Pinnacle first).
const SLIP_FAIR_OPTS = { ...SHARP_OPTS, minSources: 1 };
const slipFairAt = (row, book, line) => {
  const f = sportProps.consensusFor(row, line, { sharp: sharpQuotes(row), kalshi: rowKalshi(row), o: { ...SLIP_FAIR_OPTS, weights: SHARP_OPTS.weights } });
  return f ? f.p : null;
};
app.post('/api/slips/grade', async (req, res) => {
  const legs = Array.isArray(req.body?.legs) ? req.body.legs.slice(0, 300) : null;
  if (!legs) return res.status(400).json({ error: 'legs needed' });
  try {
    const { rows } = propsBoardRows();
    // esports legs (a league tag of CS, LoL, Valorant, Dota) go to the esports slip record
    const esMod = require('./esslips');
    const esLegs = legs.filter(esMod.isEsportsLeg);
    const rest = legs.filter(l => !esMod.isEsportsLeg(l));
    const out = await slipLog.grade(rest, { rows: rows.filter(r => !r.esports), fairAt: slipFairAt });
    // a leg with no league tag that no sports board lists may be an esports player
    const maybe = rest.filter(l => !l.sport && out.results[String(l.id || '').slice(0, 200)]?.reason === 'player');
    const esTry = [...esLegs, ...maybe];
    if (esTry.length) {
      if (!(esportsCache.picks || []).length) await esPicksOnce().catch(() => {});
      const es = await esSlipLog.grade(esTry, { picks: esportsCache.picks || [] });
      for (const l of esTry) {
        const id = String(l.id || '').slice(0, 200), g = es.results[id];
        // an untagged leg keeps its sports answer unless an esports line lists the player
        if (g && (esLegs.includes(l) || g.reason !== 'player')) out.results[id] = g;
      }
    }
    res.json(out);
  } catch (e) { sendErr(res, e); }
});
app.get('/api/slips/record', async (req, res) => {
  res.json({ ...(await slipLegTracker.summary({ sinceDays: parseFloat(req.query.days) || undefined })), esports: await esSlipTracker.summary() });
});

// The sports props record: free to see, like every other record. Open legs
// are today's plays, so only finished ones are free.
app.get('/api/props/record', async (req, res) => {
  res.json({ ...(await sportTracker.summary({ sinceDays: parseFloat(req.query.days) || undefined })), minEv: SPORT_OPTS.minEv, gapMinPts: SPORT_OPTS.minProbPts });
});
app.get('/api/props/record/picks', async (req, res) => {
  const status = hasPro(req) ? req.query.status : (['locked', 'graded'].includes(req.query.status) ? req.query.status : 'graded');
  // ?kind=stale-single narrows the list; ?before=<signalAt> pages back
  const q = k => (typeof req.query[k] === 'string' && req.query[k]) || undefined;
  res.json({ picks: await sportTracker.list({ status, kind: q('kind'), before: q('before'), limit: Math.min(parseInt(req.query.limit) || 100, 1000) }) });
});

// Pick'em stale at Pinnacle's own number (staleexact.js): the daily check on
// the one pick'em kind still standing, live legs apart from the 10-24 backfit.
// Free, like the record; today's open legs only with Pro.
const staleExact = require('./staleexact');
app.get('/api/props/stale-exact', async (req, res) => {
  try {
    const legs = await sportTracker.list({ limit: 1e9 });
    res.json(staleExact.report(legs, { showOpen: hasPro(req) }));
  } catch (e) { sendErr(res, e); }
});

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
    const ppLines = ppLinesNow().filter(l =>
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
// One billed Odds API odds pull for a sport, shared by the app's feed and the
// sportsbook poller. Concurrent callers wait on the same request; the credit
// budget can refuse it ({ budget: { waitMs } } is thrown then).
// Low-usage mode skips totals: on the free plan that stretches 500 credits a
// month to about 8 board refreshes a day instead of 5.
const feedMarkets = () => (oddsBudget.active() ? 'h2h,spreads' : 'h2h,spreads,totals');
async function pullOddsFeed(sport, regions) {
  const key = `${sport}|${regions}`;
  if (!oddsFeedInflight.has(key)) {
    const markets = feedMarkets();
    const budget = oddsBudget.take(oddsCost(markets, regions));
    if (!budget.ok) throw Object.assign(new Error('budget'), { budget });
    oddsFeedInflight.set(key, axios.get(`https://api.the-odds-api.com/v4/sports/${sport}/odds/`, {
      params: { apiKey: ODDS_API_KEY, regions, markets, oddsFormat: 'american', ...(regions !== 'us' ? { includeLinks: true } : {}) }, timeout: 12000,
    }).then(r => {
      noteQuota(r);
      oddsFeedCache.set(key, { at: Date.now(), data: r.data });
      // the screener and sharp tracker read game lines from here too
      if (regions === 'us') cache.odds[sport] = { data: r.data, updated: new Date().toISOString() };
      ingestSharp(sport, r.data);
      return r.data;
    }).finally(() => oddsFeedInflight.delete(key)));
  }
  return oddsFeedInflight.get(key);
}

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
  const regions = wide ? 'us,us2,us_ex' : 'us';
  const key = `${sport}|${regions}`;
  const trim = data => (Array.isArray(data) ? data.map(g => ({ ...g, bookmakers: (g.bookmakers || []).map(b => ({ ...b, markets: (b.markets || []).filter(m => wanted.has(m.key)) })) })) : data);
  res.set('Access-Control-Expose-Headers', 'x-requests-remaining, x-cache');
  const hit = oddsFeedCache.get(key);
  // low-usage mode: whatever the poller last pulled is as fresh as it gets
  if (hit && (Date.now() - hit.at < ODDS_FEED_TTL_MS || (oddsBudget.active() && !oddsBudget.check(oddsCost(feedMarkets(), regions)).ok))) {
    if (cache.quotaRemaining != null) res.set('x-requests-remaining', String(cache.quotaRemaining));
    res.set('x-cache', 'hit');
    return res.json(trim(hit.data));
  }
  try {
    const data = await pullOddsFeed(sport, regions);
    if (cache.quotaRemaining != null) res.set('x-requests-remaining', String(cache.quotaRemaining));
    res.set('x-cache', 'miss');
    res.json(trim(data));
  } catch (e) {
    if (e.budget) {
      const mins = Math.ceil(e.budget.waitMs / 60000);
      res.set('x-cache', 'budget');
      if (hit) return res.json(trim(hit.data));
      return res.status(503).json({ error: `Saving Odds API credits: next refresh in about ${mins} min`, lowUsage: true, retryInMs: e.budget.waitMs });
    }
    const status = e.response?.status || 502;
    if (hit) { res.set('x-cache', 'stale'); return res.json(trim(hit.data)); }   // better old odds than none
    res.status(status).json({ error: status === 429 ? 'Odds API quota used up' : status === 401 ? 'Odds API key rejected' : `Odds API error ${status}` });
  }
});

// ─── SPORTSBOOK POLLER ────────────────────────────────────────────────────────
// With a key set, the server pulls the sportsbooks' game lines itself, so the
// +EV screen and Best Plays have book prices even when nobody has the Lines tab
// open. One sport per tick, and only when the credit budget allows a pull. The
// pull goes to the sport with the most games starting in the next 12 hours,
// weighted by how long since its last pull. Event lists are free to read.
const oddsEventTimes = {};   // sport → { at, starts: [ms] }
const bookPoll = { lastSport: null, lastAt: null, pulls: 0, skipped: 0, error: null };
async function upcomingGames(sport, now) {
  let c = oddsEventTimes[sport];
  if (!c || now - c.at > 3600e3) {
    const r = await axios.get(`https://api.the-odds-api.com/v4/sports/${sport}/events`, { params: { apiKey: ODDS_API_KEY }, timeout: 10000 });
    noteQuota(r);
    c = oddsEventTimes[sport] = { at: now, starts: (r.data || []).map(e => Date.parse(e.commence_time)).filter(Number.isFinite) };
  }
  return c.starts.filter(t => t > now && t - now < 12 * 3600e3).length;
}
async function pollSportsbooks() {
  if (!ODDS_API_KEY) return;
  if (!oddsBudget.check(oddsCost(feedMarkets(), 'us')).ok) { bookPoll.skipped++; return; }
  const now = Date.now();
  try {
    const candidates = [];
    for (const sport of inSeasonSports()) {
      const last = oddsFeedCache.get(`${sport}|us`);
      candidates.push({ sport, games: await upcomingGames(sport, now), lastAt: last ? last.at : null });
    }
    // a pull from the app inside the TTL already counts as fresh
    const sport = pickPollSport(candidates.filter(c => !c.lastAt || now - c.lastAt >= ODDS_FEED_TTL_MS), now);
    if (!sport) return;
    await pullOddsFeed(sport, 'us');
    Object.assign(bookPoll, { lastSport: sport, lastAt: new Date().toISOString(), pulls: bookPoll.pulls + 1, error: null });
    runEvScreen(true);
  } catch (e) {
    if (e.budget) bookPoll.skipped++;
    else bookPoll.error = e.response?.status ? `Odds API ${e.response.status}` : e.message;
  }
}

// Regex path: works on both Express 4 and Express 5 (string '*' wildcards break on v5)
app.get(/^\/api\/owls\/(.*)$/, async (req, res) => {
  if (!licences.isOn('owls')) return res.status(503).json({ error: 'Owls paused: waiting on data permission' });
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
    if (spec.pricing || spec.prob != null) {
      // a hand-built leg: probability in percent or as a fraction, and the
      // pricing block flattened so the slip can re-price it per scenario
      const pr = spec.pricing || {};
      const prob = spec.prob != null ? (Number(spec.prob) > 1 ? Number(spec.prob) / 100 : Number(spec.prob)) : null;
      const leg = { ...spec, prob, line: spec.line ?? pr.line, side: spec.side ?? pr.side, meanPerMap: spec.meanPerMap ?? pr.meanPerMap, k: spec.k ?? pr.k, stat: spec.stat ?? pr.stat, scenarios: spec.scenarios ?? pr.scenarios };
      if (leg.prob == null && leg.meanPerMap != null && leg.k != null && leg.line != null && leg.side) {
        leg.prob = propProb(leg.line, leg.side, { meanPerMap: leg.meanPerMap, k: leg.k, stat: leg.stat, scenarios: leg.scenarios || undefined }).effective;
      }
      return Number.isFinite(leg.prob) ? leg : null;
    }
    const hit = board.find(p =>
      normalizeName(p.player) === normalizeName(spec.player) &&
      (!spec.market || normalizeMarket(p.market) === normalizeMarket(spec.market)));
    if (!hit) return null;
    // the fair the Lines table shows, on the side picked (slipbuild.bookLeg)
    const side = spec.side === 'OVER' || spec.side === 'UNDER' ? spec.side : null;
    const lf = ['PP', 'UD', 'SL'].map(b => slipBookLeg(hit, b, { side })).find(Boolean);
    if (lf) return lf;
    if (hit.prob == null) return null;
    return {
      player: hit.player, team: hit.team, gameId: hit.gameId, stat: hit.pricing?.stat,
      side: hit.side, line: hit.pricing?.line, prob: hit.prob / 100,
      meanPerMap: hit.pricing?.meanPerMap, k: hit.pricing?.k, scenarios: hit.pricing?.scenarios,
      shift: hit.pricing?.shift || 0, ev: hit.bestEv,
    };
  });
}

app.post('/api/esports/slip', requirePro, (req, res) => {
  const legs = legsFromBoard(req.body?.legs);
  const missing = (req.body?.legs || []).filter((_, i) => !legs[i]);
  if (missing.length) return res.status(400).json({ error: 'Not on the board or not priced yet', missing: missing.map(m => m.player) });
  if (legs.length < 2) return res.status(400).json({ error: 'A slip needs at least 2 legs' });
  // the same slip on each book's own lines and payouts (slipbuild.js)
  const board = esportsCache.picks || [];
  const picks = (req.body?.legs || []).map(spec => board.find(p =>
    normalizeName(p.player) === normalizeName(spec.player) &&
    (!spec.market || normalizeMarket(p.market) === normalizeMarket(spec.market))) || null);
  res.json({ legs: legs.length, prices: priceAll(legs), payoutTables: Object.keys(PAYOUTS), books: priceOnBooks(picks, (req.body?.legs || []).map(l => (l?.side === 'OVER' || l?.side === 'UNDER' ? l.side : null))) });
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
      shift: p.pricing.shift || 0,
    }));
  if (pool.length < 2) return res.json({ slips: [], pool: pool.length });
  const slips = bestSlips(pool, { maxLegs }).map(s => ({
    ...s,
    picks: s.picks.map(p => ({ player: p.player, sport: p.sport, market: p.market, side: p.side, line: p.line, prob: +(p.prob * 100).toFixed(1), ev: p.ev })),
  }));
  res.json({ slips, pool: pool.length });
});

// The best entry each pick'em book takes right now (slipbuild.js): every leg at
// that book's own line and payout, same-series legs priced together. When no
// slip clears break-even the closest one is listed, marked 'near'.
let autoSlipMemo = { at: null, data: null };
app.get('/api/esports/auto-slips', requirePro, async (req, res) => {
  if (!(esportsCache.picks || []).length) await esPicksOnce().catch(() => {});
  const at = esportsCache.lastUpdated || null;
  // the board rebuilds every few minutes; the search only reruns when it does,
  // or when a match has started since (its legs drop out)
  if (!autoSlipMemo.data || autoSlipMemo.at !== at || Date.now() - autoSlipMemo.built > 120000) {
    autoSlipMemo = { at, built: Date.now(), data: autoSlips(esportsCache.picks || [], pick6SlipOpts(esportsCache.picks || [])) };
  }
  res.json({ ...autoSlipMemo.data, updated: at, record: await slipTracker.summary().catch(() => null),
    // per app and size: the payout a sweep needs for the stack record so far to break even
    stackNeeds: (await esModelCards().catch(() => null))?.stacks || null });
});

// ── MATCH CONTEXT ─────────────────────────────────────────────────────────────
// Enter a match price (e.g. from Pinnacle) so CS2/Valorant picks get context.
// body: { sport, teamA, teamB, priceA, priceB, bestOf? }  American or decimal prices
//    or { sport, teamA, teamB, pA, bestOf? }               series win prob for teamA
// add perMap: true when the price is for a single map rather than the series.
app.post('/api/esports/match-odds', requireAdmin, async (req, res) => {
  try {
    const row = oddsBook.set(req.body || {});
    esPicksRebuild().catch(() => {});
    res.json({ ok: true, match: row });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.get('/api/esports/match-odds', (req, res) => res.json({ matches: oddsBook.list() }));
// What the pick record has taught the board: per sport, stat and side, how
// often it hit against what the model said, and the shift now applied.
app.get('/api/esports/calibration', (req, res) => res.json({
  ...(esportsCache.calibration || { buckets: [], off: process.env.ESPORTS_CALIBRATION === 'off' }),
  modelWeights: esportsCache.modelWeights || null, marketCounts: esportsCache.marketCounts || null,
}));
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
// What's winning: every track record scored and cut into plays (results.js).
// ?days=30 limits it to records from the last 30 days.
const results = require('./results');
// The scoreboard reads every record (50,000+ rows) and runs synchronously, so
// each visit used to hold the event loop while it built. Records change on
// 10-minute grading passes; one build per 30 s is shared by every visitor.
const scoreboardMemo = require('./ops').createMemo({ ttlMs: 30e3 });
app.get('/api/results', async (req, res) => {
  try {
    const days = parseFloat(req.query.days);
    const all = { limit: 1e9 };
    const board = await scoreboardMemo(`results|${days > 0 ? days : 0}`, async () => {
      const [tail, fresh, ev, esportsEdges, esportsPicks, exchangeValue, bidArbs, middles, gasLocks, sportsProps, bigMoneyRows] = await Promise.all([
        tailTracker.list(all), freshTracker.list(all), evTracker.list(all), esportsEdgeTracker.list(all), tracker.list(all), xvalueTracker.list(all), bidTracker.list(), middleTracker.list(), gasTracker.list(), sportTracker.list(all), bigTracker.list()]);
      return results.scoreboard({ tail, fresh, ev, esportsEdges, esportsPicks, exchangeValue, bidArbs, middles, gasLocks, sportsProps, bigMoney: bigMoneyRows }, { sinceMs: days > 0 ? Date.now() - days * 86400e3 : 0 });
    });
    res.json({ ...board, days: days > 0 ? days : null, backup: resultsBackup.status() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Best plays right now across the app, ranked by what the results say is
// working (bestplays.js). Each source goes through its own licence and region
// gates first. The rows are what's being sold, so free users get the counts.
const bestplays = require('./bestplays');
// venues with a record of their own and nothing proven: never in Best Plays
const BEST_PLAYS_LEADS = new Set(['pick6', 'gemini', 'polymarketus']);
const BEST_FREE_PREVIEW = 3;
app.get('/api/best', async (req, res) => {
  try {
    const pro = hasPro(req), lic = licenceOf(req);
    const all = { limit: 1e9 };
    const { plays } = await scoreboardMemo('best', async () => {
      const [tail, fresh, ev, esportsEdges, esportsPicks, exchangeValue, bidArbs, middles, sportsProps] = await Promise.all([
        tailTracker.list(all), freshTracker.list(all), evTracker.list(all), esportsEdgeTracker.list(all), tracker.list(all), xvalueTracker.list(all), bidTracker.list(), middleTracker.list(), sportTracker.list(all)]);
      return results.scoreboard({ tail, fresh, ev, esportsEdges, esportsPicks, exchangeValue, bidArbs, middles, sportsProps });
    });
    const out = bestplays.bestPlays({
      signals: lic.polymarket ? tailEngine.signals({ limit: 500 }).map(s => venueFor(s, lic)) : [],
      matches: esportsBoardFor(req),
      picks: pro ? esportsCache.picks || [] : [],
      props: pro ? runEvScreen().rows.filter(r => r.dfs && r.book !== 'pick6').filter(evRowOk(lic)) : [],
      // the PROPS board's flagged sports plays; one priced on Kalshi needs its licence
      // Pick6 is a lead with a record of its own: not in Best Plays until it's proven
      sportProps: pro ? (propsBoardRows().sportPlays || []).filter(x => !x.research && x.play.book !== 'pick6' && (lic.kalshi || !x.play.sources.some(s => s.book === 'kalshi'))) : [],
      // so is Gemini (geminibooks.js): its own record first
      lines: pro ? runEvScreen().rows.filter(r => !r.dfs && !BEST_PLAYS_LEADS.has(r.book)).filter(evRowOk(lic)) : [],
      arbs: xarbState.arbs.filter(arbOk(lic)),
      value: [...xvalueState.edges, ...(xvalueState.moverBets || [])].filter(valueOk(lic)),
      middles: (xarbState.middles || []).filter(arbOk(lic)),
      plays,
    // ?state=TX: only plays at venues a resident there can use (venues.js)
    }, { limit: Math.min(parseInt(req.query.limit) || 300, 500), venueOk: venues.stateOf(req.query.state) ? venues.legalIn(req.query.state) : null });
    const body = { counts: out.counts, total: out.total, dropped: out.dropped.length, pro, updated: new Date().toISOString(), region: TAIL_REGION,
      state: venues.stateInfo(req.query.state), outOfState: out.outOfState };
    // free preview: everyone sees the same top plays (the alert is the same for all), Pro sees the whole list
    const preview = out.rows.slice(0, BEST_FREE_PREVIEW);
    res.json(regionSafe(pro ? { ...body, rows: out.rows, droppedPlays: out.dropped.slice(0, 20) } : { ...body, rows: preview, locked: out.total - preview.length }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// MY BETS (bets.js): a bet a user logged from a tracked play settles from the
// trackers' own grading. The bets stay in the user's browser; this only says
// what happened to the outcomes. body: { bets: [{ id, track }] }, 200 at most.
const betsLib = require('./bets');
const { sportKey: pickSportKey, outcomeFor: pickOutcomeFor } = require('./tracker');
app.post('/api/bets/settle', async (req, res) => {
  try {
    const list = (Array.isArray(req.body?.bets) ? req.body.bets : []).slice(0, 200).filter(b => b && typeof b === 'object');
    const lic = licenceOf(req), all = { limit: 1e9 };
    const wants = k => list.some(b => b.track?.kind === k);
    const [tail, picks, lines] = await Promise.all([
      wants('tail') && lic.polymarket ? tailTracker.list(all) : [],
      wants('prop') ? tracker.list(all) : [],
      // game lines from the odds screen: logged on first sight, graded on Pinnacle's close and the final
      wants('line') ? lineBets.settle(list.filter(b => b.track?.kind === 'line'), { games: freeBooksState.games || {} }) : {}]);
    res.set('Cache-Control', 'no-store').json({ results: { ...betsLib.matchTracked(list, { tail, picks, sportKey: pickSportKey, outcomeFor: pickOutcomeFor }), ...lines } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// The encrypted snapshot the results-backup Action keeps (backup.js).
app.get('/api/results/backup', async (req, res) => {
  try { res.set('Cache-Control', 'no-store').json(await resultsBackup.exportSnapshot()); }
  catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

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
  version: '3.166.1',
  modelWeight: MODEL_WEIGHT,
  prizepicks: { count: cache.prizepicks.data?.length||0, updated: cache.prizepicks.updated, blocked: Date.now() < ppFail.until, retryAt: ppFail.until > Date.now() ? new Date(ppFail.until).toISOString() : null, inUse: ppLinesNow().length, lastError: dfsError.prizepicks },
  underdog: { count: cache.underdog.data?.length||0, updated: cache.underdog.updated, sports: cache.udSportLabels, lastError: dfsError.underdog },
  sleeper: { count: cache.sleeper.data?.length||0, sports: cache.sleeperSports.data?.length||0, rows: cache.sleeper.rows || 0, updated: cache.sleeper.updated || null, lastError: dfsError.sleeper },
  pick6: pick6.status(),
  exchangeSize: { on: xsizeOn(), ...xsizeTracker.state },
  shopDepth: { on: shopDepthOn(), ...shopDepth.state, budget: depthBook.READ_BUDGET },
  resultsBackup: resultsBackup.status(),
  kalshiProps: { updated: kpropsState.updated, counts: kpropsState.counts, errors: kpropsState.errors },
  kalshiExtra: kxExtraState,
  bigMoney: { updated: bigState.updated, counts: bigState.counts, errors: bigState.errors },
  oddsScreen: { series: oddsHistory.size(), points: oddsHistory.points(), observedAt: oddsScreenState.observedAt, errors: oddsScreenState.errors },
  lineBets: lineBets.counts(),
  propHistory: { series: propHistory.size(), points: propHistory.points(), observedAt: propHistoryState.observedAt, markets: propHistoryState.markets, ms: propHistoryState.ms, error: propHistoryState.error },
  bookArbs: { updated: bookArbState.updated, dataAt: bookArbState.dataAt, reads: bookArbState.reads, counts: bookArbState.counts },
  pinnacleProps: pinPropsState,
  freeBooks: { enabled: freeBooksState.enabled, counts: freeBooksState.counts, errors: freeBooksState.errors, updated: freeBooksState.updated, gamesAt: freeBooksState.gamesAt || null, ms: freeBooksState.ms },
  // Gemini Predictions (geminibooks.js): events read, games per sport, how many sit on Pinnacle's games after the main-line cut
  gemini: { enabled: geminiState.enabled, events: geminiState.events, errors: geminiState.errors, updated: geminiState.updated, ms: geminiState.ms,
    games: Object.fromEntries(Object.entries(geminiState.books).map(([k, v]) => [k, v.length])),
    paired: Object.fromEntries(Object.entries(freeBooksState.games || {}).map(([k, v]) => [k, v.filter(g => g.bookmakers.some(b => b.key === 'gemini')).length]).filter(([, n]) => n)),
    skipped: geminiState.skipped || {} },
  // Polymarket US's game lines as a book (pmusbooks.js): games listed per league, with lines, paired to Pinnacle
  polymarketUsBooks: { enabled: pmusBooksState.enabled, games: pmusBooksState.games, withLines: pmusBooksState.withLines, slugReads: pmusBooksState.slugReads,
    byLeague: pmusBooksState.counts, errors: pmusBooksState.errors, updated: pmusBooksState.updated, ms: pmusBooksState.ms,
    paired: Object.fromEntries(Object.entries(freeBooksState.games || {}).map(([k, v]) => [k, v.filter(g => g.bookmakers.some(b => b.key === 'polymarketus')).length]).filter(([, n]) => n)) },
  pinnacleExtraGames: { games: pinExtraGames.games.length, at: pinExtraGames.at ? new Date(pinExtraGames.at).toISOString() : null, errors: pinExtraGames.errors },
  evResults: evResultsState,
  moreBooks: { sharpPromoted, enabled: xbooksState.enabled, action: xbooksState.action, matchbook: xbooksState.matchbook, counts: xbooksState.counts, errors: xbooksState.errors, updated: xbooksState.updated, ms: xbooksState.ms },
  propsBoard: propsBoardCache.counts || null,
  esportsBoard: { updated: esportsBoard.state.updated, durationMs: esportsBoard.state.durationMs, counts: esportsBoard.state.counts, calibration: esportsBoard.state.calibration, errors: esportsBoard.state.errors.slice(0, 5) },
  esports: {
    picks: esportsCache.picks.length,
    updated: esportsCache.lastUpdated,
    ppEsportsLines: ppLinesNow().filter(l => isEsports(l.sport)).length,
    udEsportsLines: (cache.underdog.data||[]).filter(l => isEsports(l.sport)).length,
    sleeperEsportsLines: (cache.sleeper.data||[]).length,
    ppEsportsLeagues: ppState.esportsLeagues,
  },
  lolData: { players: Object.keys(lolStats.players).length, teams: Object.keys(lolStats.teams).length, games: lolStats.games, updated: lolStats.updated, state: lolStats.state, error: lolStats.lastError, source: lolStats.source },
  implausibleLines: esportsCache.implausible || [],
  spanInferredCount: esportsCache.spanInferred || 0,
  priceMismatchCount: esportsCache.priceMismatches || 0,
  killShare: esportsCache.share || null,
  roundModel: esportsCache.rounds ? { ...esportsCache.rounds, fits: undefined } : null,
  h2h: { on: H2H_ON, ...(esportsCache.h2h || {}), refreshedAt: h2hState.refreshedAt, errors: h2hState.errors },
  warmer: { filled: warmer.done, misses: warmer.misses, queued: warmer.queueSize, lastRun: warmer.lastRun },
  valData: { players: Object.keys(vlrTable.players).length, regions: vlrTable.regions, updated: vlrTable.updated, error: vlrTable.lastError, vlrPages: { ...vlrStats.health, cached: vlrStats.cache.size } },
  dotaData: { indexed: dotaCache.proPlayers ? Object.keys(dotaCache.proPlayers).length : 0, profiles: Object.values(dotaCache.players).filter(p => !p.failed).length, error: dotaCache.lastError },
  bo3: { profiles: bo3Health.profiles, predsAccepted: bo3Health.predsAccepted, predsRejected: bo3Health.predsRejected, lastRejected: bo3Health.lastRejected, lastError: bo3Health.lastError },
  tracker: trackerHealth,
  // one row per match for players in several a day (esmatch.js), and the old rows that weren't
  sameDay: { split: esportsCache.matchSplit || null, record: sameDayCheck },
  sharp: sharpTracker.state(),
  exchanges: { markets: exchangeState.rows.length, updated: exchangeState.updated, errors: exchangeState.errors.slice(0, 5) },
  ev: { rows: evCache.rows.length, computedAt: evCache.at ? new Date(evCache.at).toISOString() : null, feeds: evCache.feeds, alt: evCache.altSummary || null,
    esports: { enabled: esBooksState.enabled, updated: esBooksState.updated, screenedAt: esBooksState.screenedAt, ms: esBooksState.ms, summary: esBooksState.summary, errors: esBooksState.errors.slice(0, 5) },
    stale: { enabled: staleState.enabled, screenedAt: staleState.screenedAt, rows: staleState.rows.length, clear: staleState.rows.filter(r => r.clears).length, errors: staleState.errors.slice(0, 5),
      lag: staleState.enabled ? staleState.engine.lagSummary() : null },
    esStale: { enabled: esStaleState.enabled, screenedAt: esStaleState.screenedAt, rows: esStaleState.rows.length, clear: esStaleState.rows.filter(r => r.clears).length, errors: esStaleState.errors.slice(0, 5),
      twoMatchPlayers: esStaleState.twoMatchPlayers ?? null, engine: esStaleState.engine.state(), lag: esStaleState.enabled ? esStaleState.engine.lagSummary() : null } },
  // free: counts and timestamps only (see publicTailState)
  tail: pro ? { ...tailEngine.state(), record: tailTracker.state(), jobs: tailJobs, routing: tailRouting, stream: tailStream.stats(), polymarketUs: polymarketUs?.state() ?? null } : { ...publicTailState(tailEngine.state()), record: tailTracker.state(), jobs: publicJobs(tailJobs), routing: tailRouting, stream: tailStream.stats() },
  whales: pro ? whaleWatcher.state() : publicWhaleState(whaleWatcher.state()),
  xarb: { arbs: xarbState.arbs.length, updated: xarbState.updated, durationMs: xarbState.durationMs, running: xarbState.running, counts: xarbState.counts, errors: xarbState.errors.slice(0, 5),
    venueMarkets: xarbState.venues?.size ?? 0, gameSweep: kalshiGameSweep ? kalshiGameSweep.stats() : null, tailSweep: kalshiTailSweep ? kalshiTailSweep.stats() : null },
  region: TAIL_REGION,
  eventLoop: loopWindow || loopNow(),
  licence: licenceState(req),
  dataLicences: (!PAYWALL || isAdmin(req)) ? licences.state() : licences.publicState(),
  upstream: upstream.stats(),
  live: { listeners: liveListeners.size, webhook: webhook.enabled && process.env.TAIL_WEBHOOK !== 'off', webhookKinds: webhook.kinds, webhookStats: webhook.stats(), push: push.stats() },
  accounts: { paywall: PAYWALL, billing: billing.configured(), authSecretSet: !!process.env.AUTH_SECRET, webhookSecretSet: !!process.env.STRIPE_WEBHOOK_SECRET },
  alerts: { recent: alerter.recent(200).length, liveListeners: alerter.listenerCount(), webhook: webhook.enabled },
  feeds: { pandascore: feedState.pandascore.enabled, pinnacle: feedState.pinnacle.enabled, pinnacleMatches: feedState.pinnacle.loaded },
  matchups: matchupEngine ? matchupEngine.status() : { off: true },
  matchupGames: Object.fromEntries(Object.entries(matchupEngines).map(([g, E]) => { const st = E.status(); return [g, { ready: st.ready, series: st.series, teams: st.teams, upcoming: st.upcoming, updated: st.updated, error: st.error, pmus: st.pmus }]; })),
  matchContext: { ratings: ratingsState.meta, picks: esportsCache.contextCounts || {}, manualMatches: oddsBook.list().length },
  sharpMoves: cache.sharpMoves.length,
  owls: !licences.isOn('owls') ? 'paused: waiting on data permission' : owlsDisabled() ? 'DISABLED — dead key (repeated 403s)' : 'active',
  oddsApiQuotaRemaining: cache.quotaRemaining,
  oddsApiBudget: oddsBudget.state(),
  sportsbookPoll: bookPoll,
  owlsProps: Object.entries(cache.owlsProps).map(([k,v])=>`${k}:${Array.isArray(v.data)?v.data.length:0}`).join(', ') || 'none',
  oddsApiProps: Object.entries(cache.oddsApiProps).map(([k,v])=>`${k}:${Array.isArray(v.data)?v.data.length:0}`).join(', ') || 'none',
}); });

// ─── CRON JOBS ────────────────────────────────────────────────────────────────
// node-cron looks at the clock about once a second, and by default a job whose
// second it didn't land on is dropped, not run late. A busy event loop at that
// second (the xarb scan starts at :50 and takes ~30s, so it finishes right
// around :20) made the 10-minute settle job miss every slot from 06:50 to
// 18:20 on 10-10. Every job here runs late instead. (node-cron 3 also gets a
// stepped range wrong: '7-59/10' runs at 10,20,…,50, so minutes are listed.)
// each job is named in /api/ops (and in a stall's report) by its first line of code
const jobLabel = (expr, fn) => `${expr} ${String(fn).replace(/^\s*(async\s*)?\(\)\s*=>\s*/, '').replace(/\s+/g, ' ').slice(0, 60)}`;
const schedule = (expr, fn) => cron.schedule(expr, ops.job(jobLabel(expr, fn), fn), { recoverMissedExecutions: true });

// LoL matchups: schedule, results and the forward record, every 10 minutes.
for (const E of Object.values(matchupEngines)) schedule('3,13,23,33,43,53 * * * *', () => E.refresh().catch(() => {}));
// Team ratings for match context, every 6 hours.
schedule('40 */6 * * *', () => refreshRatings(axios, ratingsState, console, ratingsOpts).catch(() => {}));

// Tracker: freeze started picks, then look for results (one sweep at a time).
const trackerHealth = { lastRun: null, last: null, error: null };
let trackerRunning = false;
schedule('*/5 * * * *', async () => {
  if (trackerRunning) return;
  trackerRunning = true;
  try {
    const locked = await tracker.lockStarted();
    trackerHealth.last = { locked, ...(await tracker.gradeDue()), slips: await slipTracker.grade().catch(e => ({ error: e.message })) };
    trackerHealth.pinGaps = { locked: await pinGapTracker.lockStarted(), ...(await pinGapTracker.gradeDue()) };
    trackerHealth.share = { locked: await shareTracker.lockStarted(), ...(await shareTracker.gradeDue()) };
    trackerHealth.rounds = { locked: await roundsTracker.lockStarted(), ...(await roundsTracker.gradeDue()) };
    trackerHealth.h2h = { locked: await h2hTracker.lockStarted(), ...(await h2hTracker.gradeDue()) };
    trackerHealth.esStale = { locked: await esStaleTracker.lockStarted(), ...(await esStaleTracker.gradeDue()) };
    trackerHealth.esSlipLegs = { locked: await esSlipTracker.lockStarted(), ...(await esSlipTracker.gradeDue()) };
    trackerHealth.pinTotals = await gradePinTotals().catch(e => ({ error: e.message }));
    trackerHealth.lastRun = new Date().toISOString();
    trackerHealth.error = null;
  } catch (e) { trackerHealth.error = e.message; }
  finally { trackerRunning = false; }
});
// Sports props record: grade locked legs off ESPN box scores
schedule('3,13,23,33,43,53 * * * *', () => sportTracker.grade().catch(e => console.warn('Sports grader:', e.message)));
schedule('8,18,28,38,48,58 * * * *', () => gradeEvResults());
schedule('4,14,24,34,44,54 * * * *', () => gradeExchangeSize());
schedule('6,26,46 * * * *', () => gradeLineBets());
schedule('5,15,25,35,45,55 * * * *', () => slipLegTracker.grade().catch(e => console.warn('Slip log grader:', e.message)));
schedule('7,17,27,37,47,57 * * * *', () => shopTracker.grade().catch(e => console.warn('Shop grader:', e.message)));
schedule('40 * * * * *', () => refreshFreeBooks().then(() => scanExchangeSize()).catch(() => {}).then(() => observeOddsHistory()).finally(() => prebuildShopQuotes().catch(e => console.warn('Shopper prebuild:', e.message)).then(() => observePropHistory()).then(() => readShopDepth())));
schedule('4,9,14,19,24,29,34,39,44,49,54,59 * * * *', () => refreshEvProof().catch(() => {}));
// every other minute: the book props it prices move that often (a 5-minute
// read let Pinnacle's fair lag the books' by 3.5 points, 2026-10-14)
schedule('20 */2 * * * *', () => refreshPinnacleProps().catch(e => { pinPropsState.errors = [e.message]; }));
// read every other minute; between reads, re-price against the newest Kalshi
// mids, so the record gets its +2 min price
schedule('50 * * * * *', () => (new Date().getMinutes() % 2 ? refreshEsBooks().catch(e => { esBooksState.errors = [e.message]; }) : runEsBooksScreen()));
schedule('40 */10 * * * *', () => consensusMoves.prune());
// Kalshi player ladders for the pick'em props, a minute after the UD scrape
schedule('1,6,11,16,21,26,31,36,41,46,51,56 * * * *', () => refreshKalshiProps().catch(() => {}));
// PP/UD scrapes (PP self-backs-off when blocked)
// When an esports line moved, the board rebuilds right away rather than on its
// five-minute tick: a line gap closes when the odd book fixes its number.
let esLinesSig = '';
function esportsLinesSig() {
  const sig = l => `${l.book}|${l.player}|${l.market}|${l.line}|${l.overMultiplier ?? ''}|${l.underMultiplier ?? ''}|${l.overOpen !== false ? 1 : 0}${l.underOpen !== false ? 1 : 0}`;
  return [...ppLinesNow(), ...(cache.underdog.data || []), ...(cache.sleeper.data || [])]
    .filter(l => isEsports(l.sport)).map(sig).sort().join('\n');
}
schedule('*/2 * * * *', async () => {
  await Promise.all([scrapePrizePicks(), scrapeUnderdog(), scrapeSleeper(), scrapePick6()]);
  trackSportProps().catch(() => {});
  const sig = esportsLinesSig();
  if (esLinesSig && sig !== esLinesSig) esPicksRebuild().catch(() => {});
  esLinesSig = sig;
});

// Owls — fully skipped once the breaker trips
schedule('15 * * * * *', () => refreshExchanges().catch(e => console.warn('Exchanges:', e.message)));
schedule('*/30 * * * * *', async () => {
  if (!owlsDisabled()) await Promise.all(['nba','mlb','nhl','nfl','mma'].map(s => fetchOwlsOdds(s)));
  try { runEvScreen(true); } catch (e) { console.warn('EV screen failed:', e.message); }
});
schedule('*/5 * * * *', async () => { if (!owlsDisabled()) for (const s of ['nba','mlb','nhl','nfl','mma']) fetchOwlsProps(s); });

// Odds API props — 30-min staggered, in-season only (the guard inside skips off-season sports)
schedule('0,30 * * * *', () => fetchOddsApiProps('basketball_nba'));
schedule('3,33 * * * *', () => fetchOddsApiProps('baseball_mlb'));
schedule('6,36 * * * *', () => fetchOddsApiProps('icehockey_nhl'));
schedule('9,39 * * * *', () => fetchOddsApiProps('americanfootball_nfl'));

// Sportsbook game lines, one sport per tick when the credit budget allows
schedule('7,17,27,37,47,57 * * * *', () => pollSportsbooks());

// REMOVED: the */3 fetchOddsForSport cron. It cost 4 sports x 3 markets every
// 3 minutes = ~5,700 Odds API credits per DAY, and nothing consumed it — the
// frontend fetches its own odds. /api/odds/:sport still works on demand.

// Esports: refresh picks every 5 min (runs off UD, PP joins when unblocked)
// Esports match prices and schedules a minute before picks rebuild.
schedule('4,9,14,19,24,29,34,39,44,49,54,59 * * * *', () => refreshMatchFeeds().catch(e => console.warn('Feeds:', e.message)));
schedule('*/5 * * * *', () => esPicksOnce().catch(()=>{}));
// the esports model report card (Lines reads its verdicts), every 10 min
schedule('2,12,22,32,42,52 * * * *', () => esModelCards(true).catch(() => {}));

// Profile warmer: every minute, fill a few more players' stats until the whole
// board is priced. Self-limiting — it stops when the queue empties.
schedule('* * * * *', () => warmCsProfiles().catch(()=>{}));

// Valorant table refresh (cheap, 7 regions)
schedule('20 * * * *', () => refreshVLRTable().catch(()=>{}));

// LoL stats: Oracle's Elixir updates once per day — no value in more
schedule('10 7 * * *', () => refreshLoLStats().catch(()=>{}));
// ...but until the FIRST successful load, retry every 30 min (covers boot
// failures, timeouts, and transient S3 hiccups without any manual poking)
schedule('*/30 * * * *', () => { if (lolStats.state !== 'ready') refreshLoLStats().catch(()=>{}); });

// Sharp tail, whale flow and exchange arbs. The seconds offsets keep them off
// the jobs above (which start on :00, :15 and :30), and every request they
// make waits its turn in the polite per-host queue (UPSTREAM_GAP_MS).
// Big trades on both exchanges every 30s: one shared read of Polymarket's trades page.
schedule('10,40 * * * * *', () => Promise.all([runTailJob('whales', pollWhales), runTailJob('signals', pollTail)]));
// A few wallets scored a minute (3+ requests each)
schedule('25 * * * * *', () => runTailJob('score', () => tailEngine.scoreBatch()));
// Every open Kalshi and Polymarket event, once a minute (skipped while one is still running)
schedule('50 * * * * *', () => runTailJob('xarb', scanXarbs));
// Kalshi's daily gas markets every 10 minutes (plays only exist the evening before expiry)
schedule('35 3,13,23,33,43,53 * * * *', () => runTailJob('gas', scanGasLocks));
// Big money: the last minute's prints, every venue's price for each bet, the record
schedule('45 * * * * *', () => runTailJob('bigMoney', scanBigMoney));
// book arbs and middles: after the free books' refresh at :40 lands
schedule('55 * * * * *', () => runTailJob('bookArbs', scanBookArbs));
schedule('15 */10 * * * *', () => refreshSharpPromotions().catch(() => {}));
// Esports matches on Kalshi, Polymarket and bo3.gg, every 2 minutes
schedule('25 */2 * * * *', () => runTailJob('esports', scanEsportsBoard));
// Live esports maps on Kalshi every 20 s (skipped while one is still running)
schedule('5,25,45 * * * * *', () => runTailJob('inplay', scanInplay));
// Head-to-head kill model's data (bo3.gg maps, OpenDota games, gol.gg teams), every 30 minutes
schedule('40 13,43 * * * *', () => refreshH2H().then(() => esPicksRebuild()).catch(e => console.warn('H2H refresh:', e.message)));
schedule('5 */2 * * * *', () => runTailJob('board', watchBoard));
// Grade tracked signals whose markets resolved, every 10 minutes
schedule('20 7,17,27,37,47,57 * * * *', () => runTailJob('record', async () => { await tailTracker.check(); await freshTracker.check(); }));
// New leaderboard wallets to score, every 6 hours (and once at startup)
schedule('35 25 */6 * * *', () => runTailJob('candidates', () => tailEngine.refreshCandidates()));

// ─── START ────────────────────────────────────────────────────────────────────
if (require.main === module || process.env.LR_DESKTOP) {
  ops.mark('modules loaded');
  resultsBackup.load().then(() => ops.mark('backup read'), () => {});
  const server = app.listen(PORT, async () => {
    ops.mark('listening');
    console.log(`Line Reaper v${require('./package.json').version} on port ${PORT} (${ops.state().boot.map(b => `${b.mark} ${b.ms} ms`).join(', ')})`);
    // one line per deploy, so a new webhook (or phone) knows it's wired up
    if (webhookOnly.enabled && !/^(off|0|false|no)$/i.test(String(process.env.ALERT_STARTUP || '').trim())) {
      webhook.send(`Line Reaper v${require('./package.json').version} is live. Sharp Tail alerts will come here.`, 'Startup');
    }
    if (tailStreamOn) tailStream.start();
    await Promise.all([scrapePrizePicks(), scrapeUnderdog(), scrapeSleeper()]);
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
    setTimeout(() => pollSportsbooks(), 6000);
    setTimeout(() => refreshPinnacleProps().catch(() => {}), 9000);
    // Generate esports picks once UD is loaded
    setTimeout(() => esPicksRebuild().catch(()=>{}), 5000);
    // LoL dataset download (~1 min); regenerates picks when done
    setTimeout(() => refreshLoLStats().catch(()=>{}), 8000);
    // Valorant table (all regions) + Dota pro directory
    setTimeout(() => refreshVLRTable().catch(()=>{}), 12000);
    setTimeout(() => dotaLoadProPlayers().catch(()=>{}), 16000);
    // start filling CS profiles right away after a redeploy wipes the cache
    setTimeout(() => warmCsProfiles(20).catch(()=>{}), 20000);
    // team ratings for match context, then rebuild picks with them
    setTimeout(() => refreshMatchFeeds()
      .then(() => refreshRatings(axios, ratingsState, console, ratingsOpts)).then(() => esPicksRebuild()).catch(()=>{}), 25000);
    setTimeout(() => runTailJob('esports', scanEsportsBoard), 10000);
    setTimeout(() => refreshH2H().then(() => esPicksRebuild()).catch(() => {}), 35000);
    for (const E of Object.values(matchupEngines)) setTimeout(() => E.refresh().catch(() => {}), 40000);
    // sharp tail: leaderboard wallets to score (the crons take it from there)
    setTimeout(() => runTailJob('candidates', () => tailEngine.refreshCandidates()), 30000);
    console.log('Startup complete');
  });
  // Railway stops the old container with SIGTERM: stop taking requests, put
  // pending record writes on disk (jsonstore.js), then exit.
  let stopping = false;
  const shutdown = sig => {
    if (stopping) return;
    stopping = true;
    console.log(`${sig}: shutting down`);
    server.close();
    setTimeout(() => process.exit(0), 8000).unref();
    require('./jsonstore').flushAll().catch(() => {}).finally(() => process.exit(0));
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}

module.exports = {
  app, matchupEngine, matchupEngines, slipTracker, cache, ppState, checkSameDayRows, sameDayCheck, pinGapTracker, shareTracker, roundsTracker, h2hTracker, esStaleTracker, esSlipTracker, esSlipLog, ppLinesNow, ppRetryAfterMs, scrapePrizePicks, ppFailState: () => ppFail, oddsBudget, pollSportsbooks, bookPoll, esportsCache, feedState, refreshMatchFeeds, lolStats, tracker, ratingsState, oddsBook, alerter, auth, billing, exchangeState, runEvScreen, evScreen, evTracker, sharpTracker, ingestSharp,
  parseUnderdogPayload, normalizeName, normalizeMarket, isEsports,
  calcBookEV, calcEsportsEV, lineSkew, predictEsportsSide, generateEsportsPicks, legsFromBoard,
  getVarianceMultiplier, parseMapCount, parseMapSpan, lineIsPlausible, inSeasonSports, anchorToMarket, MODEL_WEIGHT,
  parseCsvLine, createOEAggregator, predictLoLKills, predictLoLStat, refreshLoLStats,
  aggregateLPRows, refreshLoLFromLeaguepedia,
  vlrIngestSegments, vlrTable, vlrKey, fetchVLRPlayerStats, dotaCache, warmCsProfiles, warmer,
  inferMapSpan, describePlayer, udPricing, relabelMarket,
  predictKillsFromStats, autoPredAcceptable, bo3Pick, bo3FirstObject, bo3ExtractProfile, bo3HeadshotPct,
  tailEngine, tailTracker, polymarketUs, routeTail, freshTracker, freshSignal, publishFresh, describeFresh, whaleWatcher, xarbState, upstream, createPoliteHttp, liveListeners, tailJobs,
  pollTail, streamTail, tailStream, watchBoard, describeBoardAlert, pollWhales, scanXarbs, scanGasLocks, gasTracker, scanInplay, inplayTracker, inplayLive, runTailJob, maskTrader, maskSignal, maskWhale, describeTail, describeArb, describeMiddle,
  routeSignal, tailPings, venueFor, venueLine, licenceFor, licenceState, stripPolymarketLinks, TAIL_REGION, evListeners,
  esportsBoard, scanEsportsBoard, esportsBoardFor, describeEsportsEdge, esportsEdgeTracker, esportsEdgeRows, resultsBackup, landingHtml, push,
  scanBookArbs, bookArbState, bookArbTracker, freeBooksState, kpropsState, shopState, propHistory, propHistoryState, observePropHistory, shopDepth, readShopDepth,
};
