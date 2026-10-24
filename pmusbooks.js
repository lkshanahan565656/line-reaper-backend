// ─── POLYMARKET US: GAME LINES A TEXAN CAN TRADE, AS A BOOK ──────────────────
// Polymarket US (a CFTC-regulated exchange, open in Texas; never
// polymarket.com, which US users may not use) lists the games Pinnacle prices
// as $1 contracts. Read here as one more book, 'polymarketus', merged onto
// Pinnacle's games beside FanDuel, BetRivers and Gemini, so the +EV screen
// prices it against Pinnacle's no-vig and the main-lines record grades it on
// Pinnacle's own close at its exact number (evtrack pinClose).
//
//   GET /v2/leagues/{league}/events?limit=50&offset=…   each game with its
//       winner market(s) and their snapshot quotes (bestBidQuote/bestAskQuote)
//   GET /v1/events/slug/{slug}                           every market of one
//       game: the spreads and totals (read for games starting soon, cached)
//
// Prices: the long side buys at the best ask, the short side at 1 − the best
// bid, plus the taker fee (feeCoefficient × p(1 − p)), as American odds.
//
//   winner (two teams, two players, two fighters) → a two-way moneyline,
//            home and away from each side's team.ordering
//   soccer's full-time result (a YES/NO market per team and the draw) → a
//            three-way moneyline, each outcome's YES
//   spread / total (pmus.parseMarket) → a rung each, kept only at
//            Pinnacle's main number (geminibooks.mainLinesOnly)
//
// A lead, not a claim: no alerts, not in Best Plays, its own row on the
// record until 50 graded games vs Pinnacle's close. A documented public API
// (not a scrape), read like Gemini's; POLYMARKET_US=off or
// POLYMARKET_US_BOOK=off stops it.

const pmus = require('./pmus');

const GATEWAY = pmus.GATEWAY;
// Polymarket US league → the free-books sport (freebooks LEAGUES or EXCHANGE_LEAGUES)
const LEAGUES = {
  nfl: 'nfl', cfb: 'ncaaf', nba: 'nba', wnba: 'wnba', nhl: 'nhl', mlb: 'mlb', cbb: 'ncaab',
  epl: 'epl', lal: 'laliga', bun: 'bundesliga', sea: 'seriea', fl1: 'ligue1', mls: 'mls', ere: 'eredivisie', bra: 'brasileirao', ucl: 'ucl',
  atp: 'tennis', wta: 'tennis', ufc: 'ufc', khl: 'khl', ahl: 'ahl', shl: 'shl', kbo: 'kbo', npb: 'npb',
};
const SOCCER_RESULT = /^soccer_team_full_time_winner$/;
// a two-sided winner: "football_team_full_game_winner", "tennis_match_winner", "ufc_fight_winner"
const WINNER = /^([a-z]+_team_full_game_winner|tennis_match_winner|ufc_fight_winner|[a-z]+_fight_winner)$/;
const LINE = /^([a-z]+)_team_full_(?:game|time)_(spread|total)$/;

const num = v => (v == null || v === '' || typeof v === 'boolean' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const amount = v => num(v && typeof v === 'object' ? v.value : v);
const unit = p => (p > 0 && p < 1 ? p : null);
const norm = s => String(s || '').trim().toLowerCase();
const isOpen = m => m && m.closed !== true && m.active !== false && (!m.status || norm(m.status) === 'market_status_open');
// a buyable side between 2c and 98c, fee included, as American odds
function priceOf(p, rate = pmus.FEE_RATE) {
  const x = unit(p);
  if (x == null || x < 0.02 || x > 0.98) return null;
  const cost = x + (rate ?? pmus.FEE_RATE) * x * (1 - x);
  if (!(cost > 0 && cost < 1)) return null;
  const d = 1 / cost;
  return d >= 2 ? Math.round((d - 1) * 100) : Math.round(-100 / (d - 1));
}
const feeOf = m => { const r = num(m?.feeCoefficient); return r != null && r >= 0 && r < 1 ? r : pmus.FEE_RATE; };
const longSide = m => (m.marketSides || []).find(s => s?.long === true || s?.long === 'true');
const shortSide = m => (m.marketSides || []).find(s => s && (s.long === false || s.long === 'false'));
const teamName = s => s?.team?.name || s?.description || null;

// the market behind an outcome, so a size check can read its book
// (GET /v1/markets/{slug}/book): long takes the offers, short the bids
const refOf = (m, buy, rate) => (m?.slug ? { ref: { venue: 'polymarketus', id: m.slug, buy, rate } } : {});
// one league event (or a /v1/events/slug payload) → a book game or null
function gameOf(payload, { league = null, now = Date.now() } = {}) {
  const e = payload?.event || payload;
  if (!e || !e.slug || e.closed === true || e.active === false || e.ended === true || e.live === true) return null;
  const start = Date.parse(e.startTime || e.gameStartTime || e.startDate || '');
  if (!(start > now)) return null;
  const lg = league || String(e.slug).split('-')[0];
  const sport = LEAGUES[lg];
  if (!sport) return null;
  const markets = (Array.isArray(e.markets) ? e.markets : []).filter(isOpen);
  const g = { book: 'polymarketus', eventId: `pmus-${e.slug}`, slug: e.slug, league: lg, sport, home: null, away: null, start: new Date(start).toISOString(),
    h2h: [], spreads: [], totals: [], props: [], ladders: [], alts: [] };
  const winner = markets.find(m => WINNER.test(norm(m.sportsMarketType)));
  const result = markets.filter(m => SOCCER_RESULT.test(norm(m.sportsMarketType)));
  if (winner) {
    const L = longSide(winner), S = shortSide(winner);
    const lName = teamName(L), sName = teamName(S);
    if (!lName || !sName) return null;
    // home and away from the teams' ordering; a tennis or UFC event says too, else long is home
    const lHome = norm(L.team?.ordering) === 'away' ? false : norm(S?.team?.ordering) === 'home' ? false : true;
    g.home = lHome ? lName : sName; g.away = lHome ? sName : lName;
    const rate = feeOf(winner);
    const pl = priceOf(amount(winner.bestAskQuote), rate);
    const bid = unit(amount(winner.bestBidQuote));
    const ps = bid != null ? priceOf(1 - bid, rate) : null;
    if (pl != null && ps != null) g.h2h.push({ name: lName, price: pl, ...refOf(winner, 'long', rate) }, { name: sName, price: ps, ...refOf(winner, 'short', rate) });
  } else if (result.length === 3) {
    // three YES/NO markets: each team to win, and the draw (a market without a team)
    const teams = (Array.isArray(e.teams) ? e.teams : []).filter(t => t?.name);
    const home = teams.find(t => norm(t.ordering) === 'home')?.name || teams[0]?.name, away = teams.find(t => norm(t.ordering) === 'away')?.name || teams[1]?.name;
    if (!home || !away || home === away) return null;
    g.home = home; g.away = away;
    const out = {}, refs = {};
    for (const m of result) {
      const name = longSide(m)?.team?.name || null;
      const key = name === home ? 'home' : name === away ? 'away' : name == null ? 'draw' : null;
      if (!key || out[key] !== undefined) return null;
      out[key] = priceOf(amount(m.bestAskQuote), feeOf(m));
      refs[key] = refOf(m, 'long', feeOf(m));
    }
    if (out.home != null && out.away != null && out.draw != null) g.h2h.push({ name: home, price: out.home, ...refs.home }, { name: away, price: out.away, ...refs.away }, { name: 'Draw', price: out.draw, ...refs.draw });
  } else return null;
  // spreads and totals, where the payload carries them (the slug read)
  for (const m of markets) {
    const k = LINE.exec(norm(m.sportsMarketType));
    if (!k) continue;
    const line = num(m.line);
    const rate = feeOf(m);
    const ask = unit(amount(m.bestAskQuote)), bid = unit(amount(m.bestBidQuote));
    const pl = priceOf(ask, rate), ps = bid != null ? priceOf(1 - bid, rate) : null;
    if (line == null || pl == null || ps == null) continue;
    if (k[2] === 'total') {
      const x = Math.abs(line);
      if (!g.totals.some(o => o.point === x)) g.totals.push({ name: 'Over', price: pl, point: x, ...refOf(m, 'long', rate) }, { name: 'Under', price: ps, point: x, ...refOf(m, 'short', rate) });
      continue;
    }
    const lName = teamName(longSide(m)), sName = teamName(shortSide(m));
    if (!lName || !sName) continue;
    // the line is signed from the long team's side ("cover −1.5")
    if (!g.spreads.some(o => o.name === lName && o.point === line)) g.spreads.push({ name: lName, price: pl, point: line, ...refOf(m, 'long', rate) }, { name: sName, price: ps, point: -line, ...refOf(m, 'short', rate) });
  }
  return g.h2h.length || g.spreads.length || g.totals.length ? g : null;
}

// Reads every league each pass and, for games starting within lineWithinMs,
// their slug pages (spreads and totals) at most maxSlugs a pass, each kept
// slugTtlMs. → { read(now) → { books, counts, errors } }
function createPolymarketUsBooks({ http, leagues = Object.keys(LEAGUES), maxPages = 6, lineWithinMs = 36 * 3600e3, maxSlugs = 30, slugTtlMs = 4 * 60e3, timeout = 8000 } = {}) {
  const slugs = new Map();   // slug → { at, game }
  async function read(now = Date.now()) {
    const errors = [], counts = {}, list = [];
    await Promise.all(leagues.map(async lg => {
      let n = 0;
      try {
        for (let page = 0; page < maxPages; page++) {
          const res = await http.get(`${GATEWAY}/v2/leagues/${encodeURIComponent(lg)}/events`, { params: { limit: 50, offset: page * 50 }, timeout });
          const evs = Array.isArray(res?.data?.events) ? res.data.events : [];
          for (const e of evs) { const g = gameOf(e, { league: lg, now }); if (g) { list.push(g); n++; } }
          if (evs.length < 50) break;
        }
      } catch (e) { if (e?.response?.status !== 404) errors.push(`polymarketus ${lg}: ${e?.response?.status || e?.message || e}`); }
      if (n) counts[lg] = n;
    }));
    // the slug pages carry the spreads and totals: soonest first, cached
    const due = list.filter(g => Date.parse(g.start) - now < lineWithinMs && !(now - (slugs.get(g.slug)?.at || 0) < slugTtlMs))
      .sort((a, b) => Date.parse(a.start) - Date.parse(b.start)).slice(0, maxSlugs);
    let slugReads = 0;
    for (let i = 0; i < due.length; i += 5) {
      await Promise.all(due.slice(i, i + 5).map(async g => {
        try {
          const res = await http.get(`${GATEWAY}/v1/events/slug/${encodeURIComponent(g.slug)}`, { timeout });
          slugs.set(g.slug, { at: now, game: gameOf(res?.data, { league: g.league, now }) });
          slugReads++;
        } catch (e) { slugs.set(g.slug, { at: now, game: null }); if (e?.response?.status !== 404) errors.push(`polymarketus slug ${g.slug}: ${e?.response?.status || e?.message || e}`); }
      }));
    }
    for (const [k, v] of slugs) if (now - v.at > 6 * 3600e3) slugs.delete(k);
    const books = {};
    let withLines = 0;
    for (const g of list) {
      // the slug read's lines, kept while its quotes are fresh; the moneyline from this pass
      const s = slugs.get(g.slug);
      const lines = s?.game && now - s.at < 2 * slugTtlMs ? s.game : null;
      const out = lines ? { ...g, spreads: lines.spreads, totals: lines.totals } : g;
      if (out.spreads.length || out.totals.length) withLines++;
      (books[g.sport] ||= []).push(out);
    }
    return { books, counts, errors: errors.slice(0, 8), games: list.length, withLines, slugReads };
  }
  return { read };
}

function enabledFromEnv(env = process.env) {
  return pmus.enabledFromEnv(env) && !/^(off|0|false|no)$/i.test(String(env.POLYMARKET_US_BOOK || '').trim());
}

module.exports = { LEAGUES, WINNER, LINE, priceOf, gameOf, createPolymarketUsBooks, enabledFromEnv };
