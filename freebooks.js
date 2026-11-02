// ─── FREE SPORTSBOOK LINES, PRICED OFF PINNACLE ──────────────────────────────
// The +EV screener (ev.js) needs a sharp price and the books people bet at.
// Without an Odds API key it had neither. Three free feeds fill both:
//
//   Pinnacle    the guest feed (pingames.js): the sharp, no-vig fair
//   FanDuel     the public page JSON its site reads (sbapi.nj.sportsbook.
//               fanduel.com content-managed-page, one page a league)
//   BetRivers   Kambi's offering API (rsiusnj): a league's event list, then
//               each game's bet offers
//
// DraftKings, BetMGM, Caesars, Fanatics and Hard Rock block these reads
// (checked from GitHub's runners 2026-10-14). Full game only: moneyline,
// spread (run line, puck line) and total, alternate lines included.
//
// Player props too: FanDuel's event pages (a few tabs a league, games in the
// next 36 hours, every other refresh) and the Over / Under player offers in
// BetRivers' bet offers, each priced against Pinnacle's prop at the same line
// (pinprops.js). A prop only scores where Pinnacle has the player at that line.
//
// Each book's game pairs with Pinnacle's by both team names and a start
// within 3 hours, and takes Pinnacle's names, so ev.screen merges the three
// into one market. Games Pinnacle doesn't price are left out: there is no fair
// to score them against. Output is the Odds API's games shape.

const { sameTeam } = require('./pingames');
const { canonMarket, canonName } = require('./ev');
const { resolveMatchbookNames } = require('./xbooks');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
const FD_EVENT_URL = (id, tab) => `https://sbapi.nj.sportsbook.fanduel.com/api/event-page?_ak=FhMFpcPWXMeyZxOx&eventId=${id}${tab ? `&tab=${tab}` : ''}`;
const FD_URL = page => `https://sbapi.nj.sportsbook.fanduel.com/api/content-managed-page?page=CUSTOM&customPageId=${page}&pbHorizontal=false&_ak=FhMFpcPWXMeyZxOx&timezone=America%2FNew_York`;
const KAMBI = 'https://eu-offering-api.kambicdn.com/offering/v2018/rsiusnj';
// board sport → FanDuel page, Kambi league path, Pinnacle sport and league names
const LEAGUES = {
  // 'popular' carries the alternate spreads and totals; the props tabs carry
  // the "100+ Yards" ladders next to each player's line (altlines.js)
  nfl: { fd: 'nfl', kambi: 'american_football/nfl', pin: 'football', league: /^NFL$/i, props: 'NFL', fdTabs: ['passing-props', 'receiving-props', 'rushing-props', 'td-scorer-props', 'popular'] },
  ncaaf: { fd: 'ncaaf', kambi: 'american_football/ncaaf', pin: 'football', league: /^NCAA$/i, props: 'CFB', fdTabs: ['passing-props', 'receiving-props', 'rushing-props', 'td-scorer-props', 'popular'] },
  // NBA: FanDuel posts no player tabs for preseason games, so these wait on opening night
  nba: { fd: 'nba', kambi: 'basketball/nba', pin: 'basketball', league: /^NBA$/i, props: 'NBA', fdTabs: ['', 'player-points', 'player-rebounds', 'player-assists', 'player-threes', 'player-combos', 'player-defense'] },
  wnba: { fd: 'wnba', kambi: 'basketball/wnba', pin: 'basketball', league: /^WNBA$/i, props: 'WNBA', fdTabs: ['', 'player-points', 'player-rebounds', 'player-assists', 'player-threes'] },
  // FanDuel tab slugs are each tab's title, dashed (checked 2026-10-14). NHL
  // points and assists are one-sided "1+ Points" ladders there, not a price;
  // MLB batters' over/unders sit under Hits/Runs, pitchers' outs in ODDS pairs.
  nhl: { fd: 'nhl', kambi: 'ice_hockey/nhl', pin: 'hockey', league: /^NHL$/i, props: 'NHL', fdTabs: ['shots', 'goals', 'goalies', 'points-assists', 'popular'] },
  mlb: { fd: 'mlb', kambi: 'baseball/mlb', pin: 'baseball', league: /^MLB$/i, props: 'MLB', fdTabs: ['pitcher-props', 'hits-runs', 'popular'] },
};
// Leagues only the exchanges a Texan trades (Gemini, Polymarket US) are read
// in, priced off Pinnacle like the rest (10-24): no FanDuel or BetRivers read
// for them, and a game is kept only when an exchange lists it. pin is
// Pinnacle's sport (soccer leagues come from their own league reads,
// pinLeague), league its name there.
const EXCHANGE_LEAGUES = {
  ncaab: { pin: 'basketball', league: /^NCAA$/i },
  epl: { pin: 'soccer', league: /^England - Premier League$/i, pinLeague: 1980 },
  laliga: { pin: 'soccer', league: /^Spain - La Liga$/i, pinLeague: 2196 },
  bundesliga: { pin: 'soccer', league: /^Germany - Bundesliga$/i, pinLeague: 1842 },
  seriea: { pin: 'soccer', league: /^Italy - Serie A$/i, pinLeague: 2436 },
  ligue1: { pin: 'soccer', league: /^France - Ligue 1$/i, pinLeague: 2036 },
  mls: { pin: 'soccer', league: /^USA - Major League Soccer$/i, pinLeague: 2663 },
  ligamx: { pin: 'soccer', league: /^Mexico - Liga MX$/i, pinLeague: 2242 },
  eredivisie: { pin: 'soccer', league: /^Netherlands - Eredivisie$/i, pinLeague: 1928 },
  brasileirao: { pin: 'soccer', league: /^Brazil - Serie A$/i, pinLeague: 1834 },
  ucl: { pin: 'soccer', league: /^UEFA - Champions League$/i, pinLeague: 2627 },
  uel: { pin: 'soccer', league: /^UEFA - Europa League$/i, pinLeague: 2630 },
  // singles only: a doubles league names pairs
  tennis: { pin: 'tennis', league: /^(ATP|WTA)\b(?!.*doubles)/i },
  ufc: { pin: 'mma', league: /^UFC$/i },
  khl: { pin: 'hockey', league: /^Russia - Kontinental Hockey League$/i },
  ahl: { pin: 'hockey', league: /^USA - American Hockey League$/i },
  shl: { pin: 'hockey', league: /^Sweden - SHL$/i },
  kbo: { pin: 'baseball', league: /^Korea Professional Baseball$/i },
  npb: { pin: 'baseball', league: /^Nippon Professional Baseball$/i },
};
const PIN_SOCCER_LEAGUES = [...new Set(Object.values(EXCHANGE_LEAGUES).map(l => l.pinLeague).filter(Boolean))];
const TITLES = { pinnacle: 'Pinnacle', fanduel: 'FanDuel', betrivers: 'BetRivers', ...require('./xbooks').TITLES };

const { num } = require('./mathutil');
const ms = t => { const x = Date.parse(t || ''); return Number.isFinite(x) ? x : null; };
const american = v => { const a = num(v); return a != null && Math.abs(a) >= 100 ? a : null; };

// ── FanDuel ──
// attachments.events: { name "Away @ Home", openDate }; attachments.markets:
// MONEY_LINE, MATCH_HANDICAP_(2-WAY), TOTAL_POINTS_(OVER/UNDER) (alternate
// lines are their own ALTERNATE_… types), runners with result.type HOME /
// AWAY / OVER / UNDER, handicap and winRunnerOdds.americanDisplayOdds.
const FD_KIND = { MONEY_LINE: 'h2h', 'MATCH_HANDICAP_(2-WAY)': 'spreads', 'TOTAL_POINTS_(OVER/UNDER)': 'totals' };
function parseFanDuel(payload, now = Date.now()) {
  const a = payload?.attachments || {};
  const games = new Map();
  for (const e of Object.values(a.events || {})) {
    const m = /^(.+?)\s+@\s+(.+)$/.exec(String(e?.name || ''));
    const start = ms(e?.openDate);
    if (!m || !(start > now)) continue;
    // MLB names carry the listed pitcher: "Milwaukee Brewers (R Gasser)"
    const team = x => x.replace(/\s*\([^)]*\)\s*$/, '').trim();
    games.set(String(e.eventId), { book: 'fanduel', eventId: e.eventId, props: [], ladders: [], alts: [], away: team(m[1]), home: team(m[2]), start: new Date(start).toISOString(), h2h: [], spreads: [], totals: [] });
  }
  for (const mk of Object.values(a.markets || {})) {
    const kind = FD_KIND[mk?.marketType];
    const g = kind && games.get(String(mk.eventId));
    if (!g || mk.marketStatus !== 'OPEN' || mk.inPlay) continue;
    const rs = (mk.runners || []).filter(r => r.runnerStatus === 'ACTIVE');
    if (rs.length !== 2) continue;
    const px = r => american(r.winRunnerOdds?.americanDisplayOdds?.americanOddsInt ?? r.winRunnerOdds?.americanDisplayOdds?.americanOdds);
    const out = rs.map(r => {
      const type = r.result?.type, price = px(r);
      if (price == null) return null;
      if (kind === 'totals') return /^(OVER|UNDER)$/.test(type) ? { name: type === 'OVER' ? 'Over' : 'Under', price, point: Math.abs(num(r.handicap)) } : null;
      const name = type === 'HOME' ? g.home : type === 'AWAY' ? g.away : null;
      return name ? { name, price, ...(kind === 'spreads' ? { point: num(r.handicap) } : {}) } : null;
    });
    if (out.some(o => !o)) continue;
    if (kind === 'totals' && out[0].point !== out[1].point) continue;
    if (kind === 'spreads' && !(out[0].point === -out[1].point && out[0].point !== 0)) continue;
    g[kind].push(...out);
  }
  return [...games.values()];
}

// ── BetRivers (Kambi) ──
// betoffer/event/{id}: events[0] (englishName "Home - Away", start, state)
// and betOffers, each a criterion ("Moneyline - Including Overtime", "Point
// Spread - …", "Puck Line - Including Overtime and Penalty Shootout", "Total
// Runs - Including Extra Innings") with outcomes OT_ONE (home) / OT_TWO (away)
// / OT_OVER / OT_UNDER, line in thousandths and oddsAmerican.
const KB_KIND = [[/^moneyline\b/i, 'h2h'], [/^(point spread|puck line|run line)\b/i, 'spreads'], [/^total (points|goals|runs)\s+-/i, 'totals']];
const KB_FULL = /-\s+including (overtime|extra innings)/i;
function parseKambiEvent(payload, now = Date.now()) {
  const e = payload?.events?.[0];
  const start = ms(e?.start);
  if (!e || e.state !== 'NOT_STARTED' || !(start > now)) return null;
  const names = String(e.englishName || '').split(' - ');
  if (names.length !== 2) return null;
  const g = { book: 'betrivers', props: kambiProps(payload), ladders: kambiLadders(payload), alts: [], home: names[0].trim(), away: names[1].trim(), start: new Date(start).toISOString(), h2h: [], spreads: [], totals: [] };
  for (const b of payload.betOffers || []) {
    const label = String(b?.criterion?.englishLabel || '');
    // "Total Points - 2nd Half - Including Overtime" is a half, not the game
    const kind = KB_FULL.test(label) && !PART_GAME.test(label.replace(/\s*-\s*including\b.*$/i, '')) && KB_KIND.find(([re]) => re.test(label))?.[1];
    if (!kind || b.suspended) continue;
    const os = (b.outcomes || []).filter(o => o.status === 'OPEN');
    if (os.length !== 2) continue;
    const out = os.map(o => {
      const price = american(o.oddsAmerican), line = num(o.line) != null ? num(o.line) / 1000 : null;
      if (price == null) return null;
      if (kind === 'totals') return /^OT_(OVER|UNDER)$/.test(o.type) && line != null ? { name: o.type === 'OT_OVER' ? 'Over' : 'Under', price, point: line } : null;
      const name = o.type === 'OT_ONE' ? g.home : o.type === 'OT_TWO' ? g.away : null;
      if (!name) return null;
      return kind === 'spreads' ? (line != null ? { name, price, point: line } : null) : { name, price };
    });
    if (out.some(o => !o)) continue;
    if (kind === 'totals' && out[0].point !== out[1].point) continue;
    if (kind === 'spreads' && !(out[0].point === -out[1].point && out[0].point !== 0)) continue;
    g[kind].push(...out);
  }
  return g;
}
// listView payload → the ids of games not yet started, soonest first
function kambiEventIds(payload, { now = Date.now(), withinMs = 8 * 86400e3 } = {}) {
  return (payload?.events || []).map(x => x.event).filter(e => e && e.state === 'NOT_STARTED' && ms(e.start) > now && ms(e.start) - now < withinMs)
    .sort((a, b) => ms(a.start) - ms(b.start)).map(e => e.id);
}

// ── player props ──
// The books' stat words → the keys pinprops uses (canonMarket's own keys,
// except combos and a few names)
const STAT_FIX = { 'pts_+_ast': 'pts_asts', 'pts_+_reb_+_ast': 'pra', 'pts_+_reb': 'pts_rebs', 'reb_+_ast': 'rebs_asts', touchdown_passes: 'pass_tds',
  touchdown_passes_thrown: 'pass_tds', made_threes: 'threes', 'rushing_+_receiving_yards': 'rush_rec_yds', outs_recorded: 'pitcher_outs',
  bases: 'total_bases', total_receptions: 'receptions', interceptions_thrown: 'pass_ints', pitcher_strikeouts: 'strikeouts', 'rushing_&_receiving_yards': 'rush_rec_yds',
  'passing_&_rushing_yards': 'pass_rush_yds', touchdowns: 'anytime_td', shots: 'shots_on_goal',
  // FanDuel's NHL "Total Goals" / "Total Saves" ...: the apps say goals, saves
  total_goals: 'goals', total_saves: 'saves', total_assists: 'assists', total_shots_on_goal: 'shots_on_goal' };
const statKey = words => { const k = canonMarket(words); return STAT_FIX[k] || k; };
const PART_GAME = /\b(1st|2nd|3rd|4th|first|second|third|half|quarter|period|inning|innings|alt|alternate)\b/i;

// FanDuel event page → [{ player, mkey, line, over, under }]: two-way
// MOVING_HANDICAP markets, runners "<player> Over" / "<player> - Under",
// marketName "<player> - Receiving Yds" (or "<player> Shots on Goal")
function parseFanDuelProps(payload) {
  const out = [], seen = new Set();
  for (const m of Object.values(payload?.attachments?.markets || {})) {
    if (m?.bettingType !== 'MOVING_HANDICAP' || m.marketStatus !== 'OPEN' || m.inPlay) continue;
    const rs = (m.runners || []).filter(r => r.runnerStatus === 'ACTIVE');
    const over = rs.find(r => r.result?.type === 'OVER'), under = rs.find(r => r.result?.type === 'UNDER');
    if (rs.length !== 2 || !over || !under || num(over.handicap) == null || num(over.handicap) !== num(under.handicap)) continue;
    const player = String(over.runnerName || '').replace(/\s*-?\s*over$/i, '').trim();
    const name = String(m.marketName || '');
    if (!player || /^(over|under)$/i.test(player) || !name.toLowerCase().startsWith(player.toLowerCase())) continue;
    const stat = name.slice(player.length).replace(/^\s*-\s*/, '').trim();
    if (!stat || PART_GAME.test(stat)) continue;
    const o = { player, mkey: statKey(stat), line: num(over.handicap), over: fdPx(over), under: fdPx(under) };
    const k = `${canonName(o.player)}|${o.mkey}|${o.line}`;
    if (o.over == null || o.under == null || seen.has(k)) continue;
    seen.add(k); out.push(o);
  }
  // two-way ODDS markets carry the line in the runner: "Blake Snell Outs
  // Recorded" with "Blake Snell Over 14.5" / "Blake Snell Under 14.5"
  for (const m of Object.values(payload?.attachments?.markets || {})) {
    if (m?.bettingType !== 'ODDS' || m.marketStatus !== 'OPEN' || m.inPlay) continue;
    const rs = (m.runners || []).filter(r => r.runnerStatus === 'ACTIVE');
    if (rs.length !== 2) continue;
    const side = r => /^(.+?)\s+-?\s*(over|under)\s+(\d+(?:\.\d+)?)$/i.exec(String(r.runnerName || '').trim());
    const a = side(rs[0]), b = side(rs[1]);
    if (!a || !b || a[1] !== b[1] || a[3] !== b[3] || a[2].toLowerCase() === b[2].toLowerCase()) continue;
    const player = a[1].trim(), name = String(m.marketName || '');
    if (!name.toLowerCase().startsWith(player.toLowerCase())) continue;
    const stat = name.slice(player.length).replace(/^\s*-\s*/, '').trim();
    if (!stat || PART_GAME.test(stat)) continue;
    const [ov, un] = /over/i.test(a[2]) ? rs : [rs[1], rs[0]];
    const o = { player, mkey: statKey(stat), line: Number(a[3]), over: fdPx(ov), under: fdPx(un) };
    const k = `${canonName(o.player)}|${o.mkey}|${o.line}`;
    if (o.over == null || o.under == null || seen.has(k)) continue;
    seen.add(k); out.push(o);
  }
  return out;
}
const fdPx = r => american(r.winRunnerOdds?.americanDisplayOdds?.americanOddsInt ?? r.winRunnerOdds?.americanDisplayOdds?.americanOdds);

// ── ladders and alternate lines ──
// FanDuel's one-way markets, each runner its own bet at its own price:
//   "Parker Washington - Alt Receiving Yds" runners "Parker Washington 50+ Yards"
//   "Jakub Dobes Alt Saves" runners "26+"
//   PLAYER_TO_RECORD_3+_SHOTS_ON_GOAL, PLAYER_TO_SCORE_2+_GOALS,
//   TO_SCORE_2+_TOUCHDOWNS, ANY_TIME_TOUCHDOWN_SCORER, ANY_TIME_GOAL_SCORER:
//   runners are the players
//   ALTERNATE_HANDICAP / ALTERNATE_PUCK_LINE / ALTERNATE_RUN_LINE: "Houston
//   Texans (+28.5)" (result HOME / AWAY); ALTERNATE_TOTAL(_GOALS / _RUNS):
//   "Over (16.5)" or "Over 2.5"
// → { ladders: [{ player, mkey, line, price }] (an "N+" rung is over N − 0.5),
//     alts: [{ kind: 'spreads' | 'totals', type: HOME | AWAY | OVER | UNDER, point, price }] }
// Full game only: period, quarter and half markets are skipped.
const FD_PART = /(^|_)(1ST|2ND|3RD|4TH|FIRST|SECOND|THIRD|HALF|QUARTER|PERIOD|INNING|INNINGS)(_|$)|\b(1st|2nd|3rd|4th|half|quarter|period|inning)\b/i;
const FD_PLAYER_RUNG = [
  [/^PLAYER_TO_RECORD_(\d+)\+_(.+)$/, m => [Number(m[1]), m[2]]],
  [/^PLAYER_TO_SCORE_(\d+)\+_GOALS$/, m => [Number(m[1]), 'GOALS']],
  [/^TO_SCORE_(\d+)\+_TOUCHDOWNS$/, m => [Number(m[1]), 'TOUCHDOWNS']],
  [/^ANY_TIME_TOUCHDOWN_SCORER(_CFB)?$/, () => [1, 'TOUCHDOWNS']],
  [/^ANY_TIME_GOAL_SCORER$/, () => [1, 'GOALS']],
  // NBA: "To Score 20+ Points", "To Record 6+ Rebounds", "3+ Made Threes" (checked 2026-10-15, opening-week games)
  [/^TO_SCORE_(\d+)\+_POINTS$/, m => [Number(m[1]), 'POINTS']],
  [/^TO_RECORD_(\d+)\+_(ASSISTS|REBOUNDS|STEALS|BLOCKS)$/, m => [Number(m[1]), m[2]]],
  // combo rungs ("To Record 40+ Pts + Reb + Ast") and the yes/no markets (every runner a player, priced to record one), checked 2026-10-21
  [/^TO_RECORD_(\d+)\+_((?:PTS_\+_REB_\+_AST|PTS_\+_REB|PTS_\+_AST|REB_\+_AST))$/, m => [Number(m[1]), m[2]]],
  [/^TO_RECORD_A_(DOUBLE|TRIPLE)_DOUBLE$/, m => [1, `${m[1]}_DOUBLE`]],
  [/^(\d+)\+_MADE_THREES$/, m => [Number(m[1]), 'THREES']],
];
const FD_ALT_GAME = [[/^ALTERNATE_(HANDICAP|PUCK_LINE|RUN_LINE)$/, 'spreads'], [/^ALTERNATE_TOTAL(_GOALS|_RUNS|_POINTS)?$/, 'totals']];
function parseFanDuelLadders(payload) {
  const ladders = [], alts = [], seen = new Set();
  const push = o => { const k = `${canonName(o.player)}|${o.mkey}|${o.line}`; if (o.price != null && o.mkey && !seen.has(k)) { seen.add(k); ladders.push(o); } };
  for (const m of Object.values(payload?.attachments?.markets || {})) {
    if (m?.bettingType !== 'ODDS' || m.marketStatus !== 'OPEN' || m.inPlay) continue;
    const type = String(m.marketType || ''), name = String(m.marketName || '');
    if (FD_PART.test(type) || FD_PART.test(name)) continue;
    const rs = (m.runners || []).filter(r => r.runnerStatus === 'ACTIVE');
    const game = FD_ALT_GAME.find(([re]) => re.test(type));
    if (game) {
      for (const r of rs) {
        const t = r.result?.type, pt = /([+-]?\d+(?:\.\d+)?)\)?\s*$/.exec(String(r.runnerName || ''));
        if (!pt || !/^(HOME|AWAY|OVER|UNDER)$/.test(t || '')) continue;
        if ((game[1] === 'totals') !== /^(OVER|UNDER)$/.test(t)) continue;
        alts.push({ kind: game[1], type: t, point: Number(pt[1]), price: fdPx(r) });
      }
      continue;
    }
    const pr = FD_PLAYER_RUNG.find(([re]) => re.test(type));
    if (pr) {
      const [n, stat] = pr[1](pr[0].exec(type));
      for (const r of rs) {
        const player = String(r.runnerName || '').trim();
        if (!player || /^(no\b|none$|yes$)/i.test(player) || /\//.test(player)) continue;
        push({ player, mkey: statKey(stat.replace(/_/g, ' ')), line: n - 0.5, price: fdPx(r) });
      }
      continue;
    }
    const alt = /^(.+?)\s+-?\s*Alt\s+(.+)$/i.exec(name);
    if (alt && /PLAYER/.test(type)) {
      const player = alt[1].trim(), mkey = statKey(alt[2].trim());
      for (const r of rs) {
        const x = /^(.*?)\s*(\d+)\+/.exec(String(r.runnerName || '').trim());
        if (!x || (x[1] && canonName(x[1]) !== canonName(player))) continue;
        push({ player, mkey, line: Number(x[2]) - 0.5, price: fdPx(r) });
      }
    }
  }
  return { ladders, alts: alts.filter(a => a.price != null) };
}
// Kambi's one-way rungs: "25+ Receiving Yards By The Player - Including
// Overtime" and "Touchdown Scorer" (Yes outcomes, one per player)
const KB_RUNG = /^(\d+)\+ (.+?) by the player\b(.*)$/i;
function kambiLadders(payload) {
  const out = [], seen = new Set();
  for (const b of payload?.betOffers || []) {
    if (b.suspended) continue;
    const label = String(b?.criterion?.englishLabel || '');
    let n, mkey, rest = '';
    const m = KB_RUNG.exec(label);
    if (m) { n = Number(m[1]); rest = m[3]; mkey = /^touchdowns? to be scored$/i.test(m[2]) ? 'anytime_td' : statKey(m[2]); }
    else if (/^touchdown scorer$/i.test(label)) { n = 1; mkey = 'anytime_td'; }
    else continue;
    if (PART_GAME.test(String(rest).replace(/\s*-\s*including\b.*$/i, ''))) continue;
    for (const o of b.outcomes || []) {
      if (o.status !== 'OPEN' || o.type !== 'OT_YES' || !o.participant) continue;
      const r = { player: kbName(String(o.participant)), mkey, line: n - 0.5, price: american(o.oddsAmerican) };
      const k = `${canonName(r.player)}|${mkey}|${r.line}`;
      if (r.price != null && !seen.has(k)) { seen.add(k); out.push(r); }
    }
  }
  return out;
}
// Kambi: "Total Receiving Yards by the Player - Including Overtime" with
// OT_OVER / OT_UNDER outcomes for one participant ("Waddle, Jaylen" or
// "Jaylen Waddle") → [{ player, mkey, line, over, under }]
// NHL's are "Player's shots on goal - Including Overtime"; and a Yes / No
// pair on "Player to record at least 1 assists" is the over / under at 0.5
// (most of Kambi's "at least" ladders are Yes only, which isn't a price).
const KB_PROP = /^total (.+?) by the player\b(.*)$/i;
const KB_PLAYERS = /^player'?s (.+?)(\s+-\s+.*)?$/i;
const KB_ATLEAST = /^player to (?:record|score) at least (\d+) (.+?)(\s+-\s+.*)?$/i;
const kbName = p => (p.includes(',') ? p.split(',').map(x => x.trim()).reverse().join(' ') : p.trim());
function kambiProps(payload) {
  const out = [];
  for (const b of payload?.betOffers || []) {
    if (b.suspended) continue;
    const label = String(b?.criterion?.englishLabel || '');
    const os = (b.outcomes || []).filter(o => o.status === 'OPEN');
    const rest = r => PART_GAME.test(String(r || '').replace(/\s*-\s*including\b.*$/i, ''));
    const m = KB_PROP.exec(label) || KB_PLAYERS.exec(label);
    if (m) {
      if (rest(m[2])) continue;
      const over = os.find(o => o.type === 'OT_OVER'), under = os.find(o => o.type === 'OT_UNDER');
      if (os.length !== 2 || !over || !under || num(over.line) == null || over.line !== under.line || !over.participant) continue;
      const o = { player: kbName(String(over.participant)), mkey: statKey(m[1]), line: num(over.line) / 1000, over: american(over.oddsAmerican), under: american(under.oddsAmerican) };
      if (o.over != null && o.under != null) out.push(o);
      continue;
    }
    const a = KB_ATLEAST.exec(label);
    if (a && !rest(a[3]) && !/power play/i.test(a[2])) {
      const yes = os.find(o => o.type === 'OT_YES'), no = os.find(o => o.type === 'OT_NO');
      if (os.length !== 2 || !yes || !no || !yes.participant || yes.participant !== no.participant) continue;
      const o = { player: kbName(String(yes.participant)), mkey: statKey(a[2]), line: Number(a[1]) - 0.5, over: american(yes.oddsAmerican), under: american(no.oddsAmerican) };
      if (o.over != null && o.under != null) out.push(o);
    }
  }
  return out;
}
// props → Odds API player markets, one a stat
function propMarkets(props) {
  const by = new Map();
  for (const p of props || []) {
    if (!by.has(p.mkey)) by.set(p.mkey, []);
    by.get(p.mkey).push({ name: 'Over', description: p.player, price: p.over, point: p.line }, { name: 'Under', description: p.player, price: p.under, point: p.line });
  }
  return [...by].map(([key, outcomes]) => ({ key, outcomes }));
}

// ── merge ──
// Pinnacle game (pingames.parseGames) → Odds API bookmaker
function pinnacleBookmaker(g) {
  const markets = [];
  if (g.ml && g.ml.raw.length === 2) markets.push({ key: 'h2h', outcomes: [{ name: g.home, price: g.ml.raw[0] }, { name: g.away, price: g.ml.raw[1] }] });
  // soccer's three-way result: the draw is its own side
  else if (g.ml && g.ml.raw.length === 3) markets.push({ key: 'h2h', outcomes: [{ name: g.home, price: g.ml.raw[0] }, { name: g.away, price: g.ml.raw[1] }, { name: 'Draw', price: g.ml.raw[2] }] });
  const spreads = g.spreads.flatMap(s => [{ name: g.home, price: s.raw[0], point: s.home }, { name: g.away, price: s.raw[1], point: -s.home }]);
  if (spreads.length) markets.push({ key: 'spreads', outcomes: spreads });
  const totals = g.totals.flatMap(t => [{ name: 'Over', price: t.raw[0], point: t.line }, { name: 'Under', price: t.raw[1], point: t.line }]);
  if (totals.length) markets.push({ key: 'totals', outcomes: totals });
  return { key: 'pinnacle', title: TITLES.pinnacle, markets };
}
// a book's game → Odds API bookmaker in Pinnacle's names, or null when its
// teams don't both land on Pinnacle's, one way round
function bookmakerFor(b, pg) {
  const same = sameTeam(b.home, pg.home) && sameTeam(b.away, pg.away);
  const flip = sameTeam(b.home, pg.away) && sameTeam(b.away, pg.home);
  if (same === flip) return null;
  const rename = n => (n === b.home ? (same ? pg.home : pg.away) : n === b.away ? (same ? pg.away : pg.home) : n);
  // a three-way result only beside Pinnacle's three-way, a two-way beside its two-way
  const h2hOk = !b.h2h.length || (b.h2h.length === 3) === (pg.ml?.raw?.length === 3);
  const markets = ['h2h', 'spreads', 'totals'].filter(k => b[k].length && (k !== 'h2h' || h2hOk)).map(k => ({ key: k, outcomes: b[k].map(o => ({ ...o, name: k === 'totals' ? o.name : rename(o.name) })) }));
  markets.push(...propMarkets(b.props));
  // one-way rungs ride beside the markets (ev.screen never reads them):
  // altlines.js prices them. A spread rung takes Pinnacle's team name.
  const homeName = same ? pg.home : pg.away, awayName = same ? pg.away : pg.home;
  const altLines = (b.alts || []).map(a => ({ kind: a.kind, point: a.point, price: a.price,
    name: a.kind === 'totals' ? (a.type === 'OVER' ? 'Over' : 'Under') : a.type === 'HOME' ? homeName : awayName }));
  const extra = { ...((b.ladders || []).length ? { ladders: b.ladders } : {}), ...(altLines.length ? { altLines } : {}) };
  return markets.length || Object.keys(extra).length ? { key: b.book, title: TITLES[b.book] || b.book, markets, ...extra } : null;
}
// Pinnacle's games in one league + the books' → Odds API games
// pinProps (pinprops rows, this league's): a player the books price in a game
// takes Pinnacle's prop of that player starting within maxGapMs of it
// read: the books whose event for the game came back this read, even with
// every market suspended ({ betrivers: { props: true }, fanduel: { props } }),
// so a market missing from it can be told from one we never fetched
const teamsMatch = (b, pg) => (sameTeam(b.home, pg.home) && sameTeam(b.away, pg.away)) !== (sameTeam(b.home, pg.away) && sameTeam(b.away, pg.home));
function mergeGames(sport, pinGames, bookGames, { maxGapMs = 3 * 3600e3, pinProps = [] } = {}) {
  const out = [];
  const pinBy = new Map();
  for (const p of pinProps) { const k = canonName(p.player); if (!pinBy.has(k)) pinBy.set(k, []); pinBy.get(k).push(p); }
  for (const pg of pinGames || []) {
    const t = ms(pg.start);
    const bookmakers = [pinnacleBookmaker(pg)], read = {};
    for (const book of [...new Set((bookGames || []).map(b => b.book))]) {
      const near = bookGames.filter(b => b.book === book && Math.abs(ms(b.start) - t) <= maxGapMs && teamsMatch(b, pg))
        .sort((x, y) => Math.abs(ms(x.start) - t) - Math.abs(ms(y.start) - t));
      if (near.length) read[book] = { props: book === 'betrivers' ? true : !!near[0].propsComplete };
      const cands = near.map(b => ({ b, bm: bookmakerFor(b, pg), gap: Math.abs(ms(b.start) - t) })).filter(x => x.bm);
      if (cands.length) bookmakers.push(cands[0].bm);
    }
    const players = new Set(bookmakers.flatMap(bm => bm.markets.flatMap(m => m.outcomes.map(o => o.description).filter(Boolean))).map(canonName));
    const pins = [...players].flatMap(k => (pinBy.get(k) || []).filter(p => Math.abs(ms(p.start) - t) <= maxGapMs))
      .map(p => ({ player: p.player, mkey: p.mkey, line: p.line, over: p.over, under: p.under }));
    bookmakers[0].markets.push(...propMarkets(pins));
    out.push({ id: `pin-${pg.id}`, sport_key: sport, commence_time: pg.start, home_team: pg.home, away_team: pg.away, bookmakers, read });
  }
  return out;
}
const leagueOf = sport => LEAGUES[sport] || EXCHANGE_LEAGUES[sport];
const leagueGames = (pinGames, sport) => (pinGames || []).filter(g => g.sport === leagueOf(sport).pin && leagueOf(sport).league.test(g.league || ''));

// ── fetch ──
// http: axios-style. → { games: { nfl: [Odds API games], … }, counts, errors }
// pinProps: pinprops.fetchPinnacleProps rows. fdProps (true on the refreshes
// that read FanDuel's event pages) and propCache (FanDuel event id → props,
// kept between those reads).
async function fetchFreeBooks(http, pinGames, { sports = Object.keys(LEAGUES), maxKambiEvents = 120, now = Date.now(), pinProps = [],
  fdProps = false, propCache = new Map(), ladderCache = new Map(), propWithinMs = 6 * 86400e3, nearWithinMs = 30 * 3600e3, maxFdEvents = 40, extra = {} } = {}) {
  const headers = { 'User-Agent': UA, Accept: 'application/json' };
  const errors = [], counts = {};
  const get = url => http.get(url, { headers, timeout: 20000 }).then(r => r?.data);
  const pool = async (items, n, fn) => { let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) await fn(items[i++]); })); };
  const books = Object.fromEntries(sports.map(s => [s, []]));
  await Promise.all(sports.map(async s => {
    try { books[s].push(...parseFanDuel(await get(FD_URL(LEAGUES[s].fd)), now)); } catch (e) { if (e.response?.status !== 404) errors.push(`fanduel ${s}: ${e.response?.status || e.message}`); }
  }));
  // FanDuel player props: only games Pinnacle posts props for, soonest first
  const fdComplete = new Set();
  if (fdProps) {
    // a game Pinnacle has props up for (NFL props go up days ahead, so the window is wide)
    const pinTimes = sport => pinProps.filter(p => p.sport === sport).map(p => ms(p.start));
    // and games in the next nearWithinMs Pinnacle has no props for yet: FanDuel
    // and BetRivers together still make two sources (Pinnacle's first, then soonest)
    const want = sports.filter(s => LEAGUES[s].props).flatMap(s => {
      const ts = pinTimes(LEAGUES[s].props);
      return books[s].filter(g => ms(g.start) - now < propWithinMs).map(g => [s, g, ts.some(t => Math.abs(t - ms(g.start)) <= 3 * 3600e3)])
        .filter(([, g, pin]) => pin || ms(g.start) - now < nearWithinMs);
    })
      .sort((a, b) => (b[2] - a[2]) || ms(a[1].start) - ms(b[1].start));
    // every league gets its turn under the cap: the soonest of each sport first,
    // then the second of each, ... (a Saturday's 30 college games took all 40
    // slots and tonight's NBA games, combos and all, went unread; 10-24)
    const rank = new Map(), per = {};
    for (const x of want) rank.set(x, (per[`${x[0]}|${x[2]}`] = (per[`${x[0]}|${x[2]}`] || 0) + 1));
    want.sort((a, b) => (b[2] - a[2]) || rank.get(a) - rank.get(b) || ms(a[1].start) - ms(b[1].start));
    want.splice(maxFdEvents);
    const fresh = new Map(), freshL = new Map();
    await pool(want, 4, async ([s, g]) => {
      const props = [], ladders = [], alts = [];
      let all = true;   // every tab answered (or had nothing): the event's props were read in full
      for (const tab of LEAGUES[s].fdTabs) {
        try {
          const page = await get(FD_EVENT_URL(g.eventId, tab));
          props.push(...parseFanDuelProps(page));
          const l = parseFanDuelLadders(page);
          ladders.push(...l.ladders); alts.push(...l.alts);
        } catch (e) { if (e.response?.status !== 404) { all = false; errors.push(`fanduel props ${g.eventId}: ${e.response?.status || e.message}`); } }
      }
      if (all) fdComplete.add(String(g.eventId));
      const seen = new Set(), seenL = new Set(), seenA = new Set();
      fresh.set(String(g.eventId), props.filter(p => { const k = `${canonName(p.player)}|${p.mkey}|${p.line}`; return seen.has(k) ? false : seen.add(k); }));
      freshL.set(String(g.eventId), {
        ladders: ladders.filter(p => { const k = `${canonName(p.player)}|${p.mkey}|${p.line}`; return seenL.has(k) ? false : seenL.add(k); }),
        alts: alts.filter(a => { const k = `${a.kind}|${a.type}|${a.point}`; return seenA.has(k) ? false : seenA.add(k); }),
      });
    });
    propCache.clear();
    for (const [k, v] of fresh) propCache.set(k, v);
    ladderCache.clear();
    for (const [k, v] of freshL) ladderCache.set(k, v);
  }
  for (const s of sports) for (const g of books[s]) if (g.book === 'fanduel') {
    g.props = propCache.get(String(g.eventId)) || [];
    g.propsComplete = fdProps && fdComplete.has(String(g.eventId));
    const l = ladderCache.get(String(g.eventId));
    if (l) { g.ladders = l.ladders; g.alts = l.alts; }
  }
  const ids = [];
  await Promise.all(sports.map(async s => {
    try { ids.push(...kambiEventIds(await get(`${KAMBI}/listView/${LEAGUES[s].kambi}/all/all/matches.json?lang=en_US&market=US`), { now }).map(id => [s, id])); }
    catch (e) { if (e.response?.status !== 404) errors.push(`betrivers ${s}: ${e.response?.status || e.message}`); }
  }));
  await pool(ids.slice(0, maxKambiEvents), 4, async ([s, id]) => {
    try { const g = parseKambiEvent(await get(`${KAMBI}/betoffer/event/${id}.json?lang=en_US&market=US`), now); if (g) books[s].push(g); }
    catch (e) { errors.push(`betrivers ${id}: ${e.response?.status || e.message}`); }
  });
  // more books (xbooks.js: Action Network's US books, Matchbook), already read
  for (const s of sports) books[s].push(...(extra[s] || []));
  // book props at Pinnacle's exact line: the ones the screen can price
  const propKeys = bm => new Set((bm?.markets || []).filter(m => !/^(h2h|spreads|totals)$/.test(m.key))
    .flatMap(m => m.outcomes.filter(o => o.name === 'Over').map(o => `${m.key}|${canonName(o.description)}|${o.point}`)));
  const sameLine = (gs, key) => gs.reduce((n, g) => { const pin = propKeys(g.bookmakers[0]); return n + [...propKeys(g.bookmakers.find(b => b.key === key))].filter(k => pin.has(k)).length; }, 0);
  const games = {};
  // the exchange-only leagues: Pinnacle's games an exchange lists, nothing else
  for (const s of Object.keys(EXCHANGE_LEAGUES)) {
    if (!(extra[s] || []).length) continue;
    const merged = mergeGames(s, leagueGames(pinGames, s), extra[s]).filter(g => g.bookmakers.length > 1);
    if (!merged.length) continue;
    games[s] = merged;
    counts[s] = { pinnacle: leagueGames(pinGames, s).length, exchangeOnly: true,
      more: Object.fromEntries([...new Set(extra[s].map(b => b.book))].map(k => [k, { listed: extra[s].filter(b => b.book === k).length, games: merged.filter(g => g.bookmakers.some(b => b.key === k)).length }])) };
  }
  for (const s of sports) {
    games[s] = resolveMatchbookNames(mergeGames(s, leagueGames(pinGames, s), books[s], { pinProps: pinProps.filter(p => p.sport === LEAGUES[s].props) }));
    const propN = key => games[s].reduce((n, g) => n + (g.bookmakers.find(b => b.key === key)?.markets || []).filter(m => !/^(h2h|spreads|totals)$/.test(m.key)).reduce((a, m) => a + m.outcomes.length / 2, 0), 0);
    counts[s] = { pinnacle: games[s].length, fanduel: games[s].filter(g => g.bookmakers.some(b => b.key === 'fanduel')).length,
      betrivers: games[s].filter(g => g.bookmakers.some(b => b.key === 'betrivers')).length,
      props: { pinnacle: propN('pinnacle'), fanduel: propN('fanduel'), betrivers: propN('betrivers'),
        matched: { fanduel: sameLine(games[s], 'fanduel'), betrivers: sameLine(games[s], 'betrivers') } },
      // the other books: games paired to Pinnacle's, props, props at Pinnacle's line
      more: Object.fromEntries([...new Set((extra[s] || []).map(b => b.book))].map(k => [k, { games: games[s].filter(g => g.bookmakers.some(b => b.key === k)).length, props: propN(k), matched: sameLine(games[s], k) }])) };
  }
  return { games, counts, errors };
}

module.exports = { LEAGUES, EXCHANGE_LEAGUES, PIN_SOCCER_LEAGUES, leagueOf, FD_URL, FD_EVENT_URL, KAMBI, STAT_FIX, parseFanDuelProps, parseFanDuelLadders, kambiLadders, kambiProps, propMarkets, parseFanDuel, parseKambiEvent, kambiEventIds, pinnacleBookmaker, bookmakerFor, mergeGames, leagueGames, fetchFreeBooks };
