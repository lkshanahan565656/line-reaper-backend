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

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
const FD_EVENT_URL = (id, tab) => `https://sbapi.nj.sportsbook.fanduel.com/api/event-page?_ak=FhMFpcPWXMeyZxOx&eventId=${id}${tab ? `&tab=${tab}` : ''}`;
const FD_URL = page => `https://sbapi.nj.sportsbook.fanduel.com/api/content-managed-page?page=CUSTOM&customPageId=${page}&pbHorizontal=false&_ak=FhMFpcPWXMeyZxOx&timezone=America%2FNew_York`;
const KAMBI = 'https://eu-offering-api.kambicdn.com/offering/v2018/rsiusnj';
// board sport → FanDuel page, Kambi league path, Pinnacle sport and league names
const LEAGUES = {
  nfl: { fd: 'nfl', kambi: 'american_football/nfl', pin: 'football', league: /^NFL$/i, props: 'NFL', fdTabs: ['passing-props', 'receiving-props', 'rushing-props'] },
  ncaaf: { fd: 'ncaaf', kambi: 'american_football/ncaaf', pin: 'football', league: /^NCAA$/i },
  nba: { fd: 'nba', kambi: 'basketball/nba', pin: 'basketball', league: /^NBA$/i, props: 'NBA', fdTabs: ['', 'player-points', 'player-rebounds', 'player-assists', 'player-threes'] },
  wnba: { fd: 'wnba', kambi: 'basketball/wnba', pin: 'basketball', league: /^WNBA$/i, props: 'WNBA', fdTabs: ['', 'player-points', 'player-rebounds', 'player-assists', 'player-threes'] },
  nhl: { fd: 'nhl', kambi: 'ice_hockey/nhl', pin: 'hockey', league: /^NHL$/i, props: 'NHL', fdTabs: ['shots', 'points-assists', 'goals'] },
  mlb: { fd: 'mlb', kambi: 'baseball/mlb', pin: 'baseball', league: /^MLB$/i, props: 'MLB', fdTabs: ['pitcher-props', 'batter-props'] },
};
const TITLES = { pinnacle: 'Pinnacle', fanduel: 'FanDuel', betrivers: 'BetRivers' };

const num = v => (v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
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
    games.set(String(e.eventId), { book: 'fanduel', eventId: e.eventId, props: [], away: team(m[1]), home: team(m[2]), start: new Date(start).toISOString(), h2h: [], spreads: [], totals: [] });
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
  const g = { book: 'betrivers', props: kambiProps(payload), home: names[0].trim(), away: names[1].trim(), start: new Date(start).toISOString(), h2h: [], spreads: [], totals: [] };
  for (const b of payload.betOffers || []) {
    const label = String(b?.criterion?.englishLabel || '');
    const kind = KB_FULL.test(label) && KB_KIND.find(([re]) => re.test(label))?.[1];
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
  bases: 'total_bases', total_receptions: 'receptions', interceptions_thrown: 'pass_ints', pitcher_strikeouts: 'strikeouts', 'rushing_&_receiving_yards': 'rush_rec_yds' };
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
    const px = r => american(r.winRunnerOdds?.americanDisplayOdds?.americanOddsInt ?? r.winRunnerOdds?.americanDisplayOdds?.americanOdds);
    const o = { player, mkey: statKey(stat), line: num(over.handicap), over: px(over), under: px(under) };
    const k = `${canonName(o.player)}|${o.mkey}|${o.line}`;
    if (o.over == null || o.under == null || seen.has(k)) continue;
    seen.add(k); out.push(o);
  }
  return out;
}
// Kambi: "Total Receiving Yards by the Player - Including Overtime" with
// OT_OVER / OT_UNDER outcomes for one participant ("Waddle, Jaylen" or
// "Jaylen Waddle") → [{ player, mkey, line, over, under }]
const KB_PROP = /^total (.+?) by the player\b(.*)$/i;
function kambiProps(payload) {
  const out = [];
  for (const b of payload?.betOffers || []) {
    const m = KB_PROP.exec(String(b?.criterion?.englishLabel || ''));
    if (!m || PART_GAME.test(m[2].replace(/\s*-\s*including\b.*$/i, '')) || b.suspended) continue;
    const os = (b.outcomes || []).filter(o => o.status === 'OPEN');
    const over = os.find(o => o.type === 'OT_OVER'), under = os.find(o => o.type === 'OT_UNDER');
    if (os.length !== 2 || !over || !under || num(over.line) == null || over.line !== under.line || !over.participant) continue;
    const p = String(over.participant);
    const player = p.includes(',') ? p.split(',').map(x => x.trim()).reverse().join(' ') : p.trim();
    const o = { player, mkey: statKey(m[1]), line: num(over.line) / 1000, over: american(over.oddsAmerican), under: american(under.oddsAmerican) };
    if (o.over != null && o.under != null) out.push(o);
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
  const markets = ['h2h', 'spreads', 'totals'].filter(k => b[k].length).map(k => ({ key: k, outcomes: b[k].map(o => ({ ...o, name: k === 'totals' ? o.name : rename(o.name) })) }));
  markets.push(...propMarkets(b.props));
  return markets.length ? { key: b.book, title: TITLES[b.book] || b.book, markets } : null;
}
// Pinnacle's games in one league + the books' → Odds API games
// pinProps (pinprops rows, this league's): a player the books price in a game
// takes Pinnacle's prop of that player starting within maxGapMs of it
function mergeGames(sport, pinGames, bookGames, { maxGapMs = 3 * 3600e3, pinProps = [] } = {}) {
  const out = [];
  const pinBy = new Map();
  for (const p of pinProps) { const k = canonName(p.player); if (!pinBy.has(k)) pinBy.set(k, []); pinBy.get(k).push(p); }
  for (const pg of pinGames || []) {
    const t = ms(pg.start);
    const bookmakers = [pinnacleBookmaker(pg)];
    for (const book of [...new Set((bookGames || []).map(b => b.book))]) {
      const cands = bookGames.filter(b => b.book === book && Math.abs(ms(b.start) - t) <= maxGapMs)
        .map(b => ({ b, bm: bookmakerFor(b, pg), gap: Math.abs(ms(b.start) - t) })).filter(x => x.bm).sort((x, y) => x.gap - y.gap);
      if (cands.length) bookmakers.push(cands[0].bm);
    }
    const players = new Set(bookmakers.flatMap(bm => bm.markets.flatMap(m => m.outcomes.map(o => o.description).filter(Boolean))).map(canonName));
    const pins = [...players].flatMap(k => (pinBy.get(k) || []).filter(p => Math.abs(ms(p.start) - t) <= maxGapMs))
      .map(p => ({ player: p.player, mkey: p.mkey, line: p.line, over: p.over, under: p.under }));
    bookmakers[0].markets.push(...propMarkets(pins));
    out.push({ id: `pin-${pg.id}`, sport_key: sport, commence_time: pg.start, home_team: pg.home, away_team: pg.away, bookmakers });
  }
  return out;
}
const leagueGames = (pinGames, sport) => (pinGames || []).filter(g => g.sport === LEAGUES[sport].pin && LEAGUES[sport].league.test(g.league || ''));

// ── fetch ──
// http: axios-style. → { games: { nfl: [Odds API games], … }, counts, errors }
// pinProps: pinprops.fetchPinnacleProps rows. fdProps (true on the refreshes
// that read FanDuel's event pages) and propCache (FanDuel event id → props,
// kept between those reads).
async function fetchFreeBooks(http, pinGames, { sports = Object.keys(LEAGUES), maxKambiEvents = 120, now = Date.now(), pinProps = [],
  fdProps = false, propCache = new Map(), propWithinMs = 6 * 86400e3, maxFdEvents = 40 } = {}) {
  const headers = { 'User-Agent': UA, Accept: 'application/json' };
  const errors = [], counts = {};
  const get = url => http.get(url, { headers, timeout: 20000 }).then(r => r?.data);
  const pool = async (items, n, fn) => { let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) await fn(items[i++]); })); };
  const books = Object.fromEntries(sports.map(s => [s, []]));
  await Promise.all(sports.map(async s => {
    try { books[s].push(...parseFanDuel(await get(FD_URL(LEAGUES[s].fd)), now)); } catch (e) { if (e.response?.status !== 404) errors.push(`fanduel ${s}: ${e.response?.status || e.message}`); }
  }));
  // FanDuel player props: only games Pinnacle posts props for, soonest first
  if (fdProps) {
    // a game Pinnacle has props up for (NFL props go up days ahead, so the window is wide)
    const pinTimes = sport => pinProps.filter(p => p.sport === sport).map(p => ms(p.start));
    const want = sports.filter(s => LEAGUES[s].props).flatMap(s => {
      const ts = pinTimes(LEAGUES[s].props);
      return books[s].filter(g => ms(g.start) - now < propWithinMs && ts.some(t => Math.abs(t - ms(g.start)) <= 3 * 3600e3)).map(g => [s, g]);
    })
      .sort((a, b) => ms(a[1].start) - ms(b[1].start)).slice(0, maxFdEvents);
    const fresh = new Map();
    await pool(want, 4, async ([s, g]) => {
      const props = [];
      for (const tab of LEAGUES[s].fdTabs) {
        try { props.push(...parseFanDuelProps(await get(FD_EVENT_URL(g.eventId, tab)))); }
        catch (e) { if (e.response?.status !== 404) errors.push(`fanduel props ${g.eventId}: ${e.response?.status || e.message}`); }
      }
      const seen = new Set();
      fresh.set(String(g.eventId), props.filter(p => { const k = `${canonName(p.player)}|${p.mkey}|${p.line}`; return seen.has(k) ? false : seen.add(k); }));
    });
    propCache.clear();
    for (const [k, v] of fresh) propCache.set(k, v);
  }
  for (const s of sports) for (const g of books[s]) if (g.book === 'fanduel') g.props = propCache.get(String(g.eventId)) || [];
  const ids = [];
  await Promise.all(sports.map(async s => {
    try { ids.push(...kambiEventIds(await get(`${KAMBI}/listView/${LEAGUES[s].kambi}/all/all/matches.json?lang=en_US&market=US`), { now }).map(id => [s, id])); }
    catch (e) { if (e.response?.status !== 404) errors.push(`betrivers ${s}: ${e.response?.status || e.message}`); }
  }));
  await pool(ids.slice(0, maxKambiEvents), 4, async ([s, id]) => {
    try { const g = parseKambiEvent(await get(`${KAMBI}/betoffer/event/${id}.json?lang=en_US&market=US`), now); if (g) books[s].push(g); }
    catch (e) { errors.push(`betrivers ${id}: ${e.response?.status || e.message}`); }
  });
  // book props at Pinnacle's exact line: the ones the screen can price
  const propKeys = bm => new Set((bm?.markets || []).filter(m => !/^(h2h|spreads|totals)$/.test(m.key))
    .flatMap(m => m.outcomes.filter(o => o.name === 'Over').map(o => `${m.key}|${canonName(o.description)}|${o.point}`)));
  const sameLine = (gs, key) => gs.reduce((n, g) => { const pin = propKeys(g.bookmakers[0]); return n + [...propKeys(g.bookmakers.find(b => b.key === key))].filter(k => pin.has(k)).length; }, 0);
  const games = {};
  for (const s of sports) {
    games[s] = mergeGames(s, leagueGames(pinGames, s), books[s], { pinProps: pinProps.filter(p => p.sport === LEAGUES[s].props) });
    const propN = key => games[s].reduce((n, g) => n + (g.bookmakers.find(b => b.key === key)?.markets || []).filter(m => !/^(h2h|spreads|totals)$/.test(m.key)).reduce((a, m) => a + m.outcomes.length / 2, 0), 0);
    counts[s] = { pinnacle: games[s].length, fanduel: games[s].filter(g => g.bookmakers.some(b => b.key === 'fanduel')).length,
      betrivers: games[s].filter(g => g.bookmakers.some(b => b.key === 'betrivers')).length,
      props: { pinnacle: propN('pinnacle'), fanduel: propN('fanduel'), betrivers: propN('betrivers'),
        matched: { fanduel: sameLine(games[s], 'fanduel'), betrivers: sameLine(games[s], 'betrivers') } } };
  }
  return { games, counts, errors };
}

module.exports = { LEAGUES, FD_URL, FD_EVENT_URL, KAMBI, STAT_FIX, parseFanDuelProps, kambiProps, propMarkets, parseFanDuel, parseKambiEvent, kambiEventIds, pinnacleBookmaker, bookmakerFor, mergeGames, leagueGames, fetchFreeBooks };
