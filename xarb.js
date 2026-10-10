// ─── EXCHANGE ARBS ────────────────────────────────────────────────────────────
// Kalshi and Polymarket both list $1 contracts: pay the ask (plus a fee) and
// collect $1 if the contract wins. When every way a question can end can be
// bought for less than $1 in total, the difference is locked in whatever
// happens. Four kinds are found:
//
//   1. cross-exchange: the same yes/no question on both exchanges. YES on one
//      plus NO on the other always pays $1. Sports games are matched by their
//      two teams (exchanges.teamMatches), the same game number (doubleheaders)
//      and start times within 4h (Kalshi's start is estimated from its expected
//      expiration), nearest game only. Outside the built-in leagues (tennis,
//      esports, soccer clubs) names match by their words (nameMatch) and the
//      start can be anywhere on the Kalshi ticker's date. Games that can end
//      level (soccer) pair Kalshi's team and tie markets with Polymarket's
//      "Will A win on <date>?" and "end in a draw?" markets, outcome by
//      outcome (by: 'teams3'). Once a game pairs, its totals and spreads do
//      too (by: 'line'): Kalshi's TOTAL/SPREAD events share the game's ticker
//      tail, Polymarket's sit in the game's event or its "-more-markets" one;
//      the same half line, and for a spread the same team. Everything else is
//      matched by title:
//      the same words (Jaccard ≥ 0.6 once filler words go), exactly the same
//      numbers, dates and direction words ("above", "below", "not"), the same
//      subject (outcome label, and every name-like capitalised word on one side
//      found on the other, in the same order), close dates within 3 days, and
//      one-to-one: each market pairs only with its own unique best match. Two
//      titles can still resolve differently, so those carry a "check both
//      rules" flag.
//   2. underround: an event where exactly one outcome wins (Kalshi
//      `mutually_exclusive`, Polymarket `negRisk`). YES on every outcome pays
//      $1, so YES asks summing under $1 is an arb, but only if the listed
//      outcomes cover every result. That's only taken as shown when there's a
//      catch-all outcome ("Other", "Someone else", "Tie"), open-ended range
//      buckets at both ends, or a no-tie game; otherwise the arb is listed with
//      exhaustive: false and a warning, and never alerted. Every outcome needs
//      a live quote, or the set isn't complete.
//   3. exchange vs sportsbook: the exchange h2h books exchanges.attachExchanges
//      puts on Odds API games (fees already in the price) against the best
//      sportsbook price on the other side: 1/decA + 1/decB < 1. A Polymarket
//      book is only used when this scan saw a real bid and ask on that market
//      (attachExchanges falls back to mids, which can't be traded).
//   4. Kalshi vs Polymarket US: pmus.js reads Polymarket US's games league by
//      league as rows in the same shape as Polymarket's (team, total and
//      spread markets, soccer's three result markets), and they pair with
//      Kalshi's the same way (1.) does; its soccer result sets are
//      underrounds (2.) on their own. Both are US venues, so these count in
//      US mode (findUsArbs).
//
// Size: the exchanges' `liquidity` figures are totals over every price level,
// not what sits at the quoted ask, so no executable size is claimed
// (maxContracts / maxStake are null): check the order books before sizing up.
//
// Every leg of an exchange arb buys the same number of contracts, so it pays
// the same whichever way it lands. Costs include fees: Kalshi's taker fee on
// the real contract count (rounded up to the cent per order), and Polymarket's
// taker fee from each market's own schedule: shares × rate × (p(1 − p))^e
// (Gamma `feeSchedule: { rate, exponent }`, sports 0.05, most other markets
// free; makers pay nothing, and every leg here takes). profit % = (payout −
// cost) / cost. Stakes are also given as each leg's share of the total, which
// is the same for everyone whatever they put in.
//
// US mode (region 'us', the default): a US person can't trade on Polymarket
// International, so only legs on Kalshi and US sportsbooks count. Kalshi vs
// Polymarket and Polymarket-only arbs are dropped, and so are offshore books.
// region 'intl' keeps every venue.
//
// Where to tail (venueIndex / venueQuotes / pickVenue): a sharp's Polymarket
// bet is the same proposition as a Kalshi side the matcher pairs with that
// market (a team's YES, or NO on its opponent; YES/NO on a title match), and,
// for a two-team game, that team's moneyline at every sportsbook in the odds
// feeds (implied price 1/decimal, no fee). Each quote carries its all-in cost
// per contract; the caller sizes them and pickVenue takes the most units.
//
// Parsers and matchers are pure. The fetchers take an axios-style `http` so
// all of it can be tested without the network.

const { kalshiFee, teamMatches, kalshiLeague, gammaStale } = require('./exchanges');
const { americanToDecimal } = require('./ev');

const KALSHI_EVENTS_URL = 'https://api.elections.kalshi.com/trade-api/v2/events';
const POLYMARKET_EVENTS_URL = 'https://gamma-api.polymarket.com/events';
const EXCHANGE_BOOKS = new Set(['kalshi', 'polymarket']);
const RULES_WARNING = 'check both rules: resolution wording can differ';
const COVER_WARNING = 'check the listed outcomes cover every result';
const NOT_EXHAUSTIVE_WARNING = 'not proven exhaustive: no catch-all outcome, so if an unlisted result wins every leg loses';
const DAY = 86400e3;

const DEFAULTS = {
  minPct: 0.5, kalshiFeeRate: 0.07, polymarketFeeRate: 0, bankroll: 100, region: 'us',
  sportsWindowMs: 4 * 3600e3, titleWindowMs: 3 * DAY, minSimilarity: 0.6,
};
// undefined in opts keeps the default
function withDefaults(opts = {}) {
  const o = { ...DEFAULTS };
  for (const [k, v] of Object.entries(opts || {})) if (v !== undefined) o[k] = v;
  o.now = typeof o.now === 'function' ? o.now() : o.now ?? Date.now();
  return o;
}

// TAIL_REGION=intl restores every venue; anything else (or nothing) is US mode
const regionFromEnv = (env = process.env) => (/^intl$/i.test(String(env.TAIL_REGION || '').trim()) ? 'intl' : 'us');
function optsFromEnv(env = process.env) {
  const f = k => (env[k] == null || env[k] === '' || !Number.isFinite(parseFloat(env[k])) ? undefined : parseFloat(env[k]));
  return { minPct: f('XARB_MIN_PCT'), polymarketFeeRate: f('POLYMARKET_FEE_RATE'), kalshiFeeRate: f('KALSHI_FEE_RATE'), region: regionFromEnv(env) };
}

// ── small helpers ──
const num = v => (v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const round = (x, n) => Math.round(x * 10 ** n) / 10 ** n;
const r2 = x => round(x, 2);
const sum = xs => xs.reduce((a, b) => a + b, 0);
// a real quote is strictly between $0 and $1
const quote = v => { const x = num(v); return x != null && x > 0 && x < 1 ? round(x, 6) : null; };
const ms = s => { const t = s ? Date.parse(s) : NaN; return Number.isFinite(t) ? t : null; };
const clip = (s, n = 500) => (s ? String(s).slice(0, n) : null);
const jsonList = v => {
  if (Array.isArray(v)) return v;
  try { const x = JSON.parse(v); return Array.isArray(x) ? x : null; } catch { return null; }
};
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, ' ').trim();
const push = (map, key, v) => { if (!map.has(key)) map.set(key, []); map.get(key).push(v); };
const later = (...ts) => ts.filter(Boolean).sort((a, b) => (ms(b) ?? 0) - (ms(a) ?? 0))[0] || null;

// ── categories ──
// Labels are tried in order (the exchange's own category first, then tags),
// and the first one that names a category wins.
const CATEGORIES = [
  ['sports', /sport|world cup|\b(nba|nfl|mlb|nhl|wnba|ncaa|mls|ufc|mma|f1|epl)\b|soccer|football|basketball|baseball|hockey|tennis|golf|boxing|racing|cricket|esports/],
  ['crypto', /crypto|bitcoin|ethereum|solana|\b(btc|eth|xrp|doge)\b/],
  ['econ', /econ|financ|\bfed\b|interest rate|inflation|\bcpi\b|\bgdp\b|jobs|recession|stock|compan|business|commodit/],
  ['politics', /politic|election|world|government|geopolit|congress|senate|president|trump/],
  ['culture', /entertain|culture|pop|music|movie|film|award|oscar|grammy|celebr|social|mention|\btv\b/],
];
function normalizeCategory(...labels) {
  for (const l of labels.flat()) {
    const text = String((l && typeof l === 'object' ? l.label || l.slug : l) || '').toLowerCase();
    if (!text) continue;
    for (const [key, re] of CATEGORIES) if (re.test(text)) return key;
  }
  return 'other';
}

// "nba-nyk-bos-2026-10-08", tag slug "nba" → 'nba'
const LEAGUES = { nba: 'nba', nfl: 'nfl', mlb: 'mlb', nhl: 'nhl', wnba: 'wnba', ncaaf: 'ncaaf', cfb: 'ncaaf', ncaab: 'ncaab', cbb: 'ncaab', mls: 'mls' };
function polymarketLeague(ev, m) {
  const cands = [ev?.seriesSlug, ...(ev?.series || []).map(s => s?.slug), ...(ev?.tags || []).map(t => t?.slug || t?.label), ev?.slug, m?.slug];
  for (const c of cands) {
    const first = String(c || '').toLowerCase().split(/[-_\s]/)[0];
    if (LEAGUES[first]) return LEAGUES[first];
  }
  return null;
}

// ── Kalshi ──
// Newer responses carry `yes_ask_dollars: "0.5600"`, older ones integer cents.
function kalshiPrice(m, field) {
  const d = num(m?.[`${field}_dollars`]);
  if (d != null) return quote(d);
  const c = num(m?.[field]);
  return c == null ? null : quote(c / 100);
}
// liquidity: dollars of resting offers (`liquidity` is in cents)
function kalshiLiquidity(m) {
  const d = num(m.liquidity_dollars);
  if (d != null) return d;
  const c = num(m.liquidity);
  return c == null ? null : c / 100;
}

const KALSHI_LIVE = new Set(['open', 'active']);
const KALSHI_DONE = new Set(['settled', 'determined', 'finalized']);
const DRAW_RE = /^(tie|draw)$/i;
// a line, not a team: "Over 2.5", "+1.5", "3+ goals". Digits alone are fine
// (Cloud9, G2, T1, Mainz 05, Schalke 04).
const NOT_TEAM_RE = /\d\.\d|[+-]\s?\d|\d\s?\+|spread|total|\bover\b|\bunder\b|points?\b|goals?\b|runs?\b|wins? by|^(yes|no)$/i;

// ── Kalshi ticker times ──
// Event tickers carry the scheduled date, in US Eastern time, and for some
// sports the start too: "KXLOLGAME-26OCT091200KOIATLN" is Oct 9 2026 12:00
// ET, "KXATPMATCH-26OCT05BELMUL" just Oct 5. → { day (ms, ET midnight),
// start (ms or null) } | null
const MONTH_NO = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
const nthSunday = (y, month, n) => 1 + ((7 - new Date(Date.UTC(y, month, 1)).getUTCDay()) % 7) + (n - 1) * 7;
// US Eastern wall-clock time → UTC ms (EDT from the 2nd Sunday of March 2am to the 1st Sunday of November 2am)
function easternToUtc(y, month, d, h = 0, mi = 0) {
  const est = Date.UTC(y, month, d, h + 5, mi);
  const dstStart = Date.UTC(y, 2, nthSunday(y, 2, 2), 7), dstEnd = Date.UTC(y, 10, nthSunday(y, 10, 1), 6);
  return est >= dstStart && est < dstEnd ? est - 3600e3 : est;
}
function kalshiTickerTime(ticker) {
  const m = String(ticker || '').match(/-(\d{2})([A-Z]{3})(\d{2})(?:(\d{2})(\d{2})(?=[A-Z]))?/);
  if (!m || !(m[2] in MONTH_NO)) return null;
  const y = 2000 + Number(m[1]), month = MONTH_NO[m[2]], d = Number(m[3]);
  if (d < 1 || d > 31) return null;
  const h = m[4] == null ? null : Number(m[4]), mi = m[5] == null ? null : Number(m[5]);
  return { day: easternToUtc(y, month, d), start: h != null && h < 24 && mi < 60 ? easternToUtc(y, month, d, h, mi) : null };
}

// "New York K at Boston Winner?" → ['New York K', 'Boston']
function titleTeams(title) {
  const parts = String(title || '').replace(/\s*(winner|to win)\??\s*$/i, '').split(/\s+(?:at|vs\.?|v\.?|@)\s+/i);
  return parts.length === 2 && parts.every(p => p.trim()) ? parts.map(s => s.trim()) : null;
}

// Doubleheaders: "KXMLBGAME-26OCT08NYYBOSG2", "mlb-nyy-bos-2026-10-08-game-2",
// "Yankees vs. Red Sox (Game 2)" → 2. null when nothing says.
function gameNumber(...texts) {
  for (const t of texts) {
    const s = String(t || '');
    const m = s.match(/[-\s(]game[-\s]?(\d)\b/i) || s.match(/^KX[A-Z0-9]*GAME-\w*?[A-Z]G(\d)$/i);
    if (m) return Number(m[1]);
  }
  return null;
}

// A game's events share one ticker tail across series: KXBUNDESLIGAGAME-,
// KXBUNDESLIGATOTAL- and KXBUNDESLIGASPREAD-26OCT09BVBSVW are the same game.
// → 'KXBUNDESLIGA|26OCT09BVBSVW' | null
const GAME_SUFFIX_RE = /(GAME|MATCH|TOTAL|SPREAD)$/i;
const LINE_SERIES_RE = /(TOTAL|SPREAD)$/i;
function kalshiGameKey(series, eventTicker) {
  const sr = String(series || '').toUpperCase(), et = String(eventTicker || '').toUpperCase();
  if (!GAME_SUFFIX_RE.test(sr) || !et.startsWith(`${sr}-`)) return null;
  return `${sr.replace(GAME_SUFFIX_RE, '')}|${et.slice(sr.length + 1)}`;
}
// Half lines only: a whole one can push, and the two exchanges needn't settle a push alike.
const halfLine = x => Number.isFinite(x) && x > 0 && Math.abs((x * 2) % 2 - 1) < 1e-9;
function kalshiLine(series, m, label) {
  const strike = num(m.floor_strike) ?? num(String(label).match(/(?:over|more than)\s+(\d+(?:\.\d+)?)/i)?.[1]);
  if (!halfLine(strike) || (m.strike_type && m.strike_type !== 'greater')) return null;
  if (series === 'TOTAL') return /^over\b/i.test(label) ? { kind: 'total', line: strike } : null;
  const team = String(label).match(/^(.+?)\s+wins?\s+by\b/i)?.[1]?.trim();
  return team ? { kind: 'spread', line: strike, team } : null;
}

// One row per unresolved market. Untradable ones (paused, not yet open) stay
// in with no quote, so an underround can tell its outcome set is incomplete.
function parseKalshiBinaries(payload) {
  const events = Array.isArray(payload) ? payload : payload?.events || payload?.data || [];
  const out = [];
  for (const ev of events) {
    if (!ev || !Array.isArray(ev.markets)) continue;
    const result = m => String(m.result || '').toLowerCase();
    const resolved = m => KALSHI_DONE.has(String(m.status || '').toLowerCase()) || ['yes', 'no'].includes(result(m));
    const markets = ev.markets.filter(m => m && m.ticker);
    const live = markets.filter(m => !resolved(m));
    const decided = markets.some(m => result(m) === 'yes');
    const league = kalshiLeague(ev.series_ticker, ev.event_ticker, ...live.map(m => m.ticker));
    const category = league ? 'sports' : normalizeCategory(ev.category);
    // a game: two team contracts (and maybe a tie), named in yes_sub_title
    const labels = live.map(m => String(m.yes_sub_title || '').trim()).filter(Boolean);
    const hasDraw = labels.some(l => DRAW_RE.test(l));
    const sides = [...new Set(labels.filter(l => !DRAW_RE.test(l)))];
    // only head-to-head events ("X at Y", ...GAME tickers): an MVP race with two names left is not a game
    const gameLike = /GAME|MATCH/i.test(`${ev.series_ticker || ''} ${ev.event_ticker || ''}`) || titleTeams(ev.title) != null;
    let teams = null;
    if (category === 'sports' && gameLike && ev.mutually_exclusive !== false) {
      teams = sides.length === 2 ? sides : sides.length === 1 ? titleTeams(ev.title || live[0]?.title) : null;
      if (teams && teams.some(t => NOT_TEAM_RE.test(t))) teams = null;
    }
    const when = kalshiTickerTime(ev.event_ticker || live[0]?.event_ticker);
    const gameKey = category === 'sports' ? kalshiGameKey(ev.series_ticker, ev.event_ticker || live[0]?.event_ticker) : null;
    const lineSeries = gameKey && LINE_SERIES_RE.exec(String(ev.series_ticker || ''))?.[1]?.toUpperCase();
    for (const m of live) {
      const tradable = KALSHI_LIVE.has(String(m.status || '').toLowerCase());
      const label = String(m.yes_sub_title || m.subtitle || '').trim();
      let kind = 'yesno', noLabel = null, game3 = null;
      const i = teams && label ? teams.findIndex(t => norm(t) === norm(label)) : -1;
      // with a tie possible, NO on a team is not the other team winning
      if (i >= 0) { kind = 'teams'; noLabel = hasDraw ? null : teams[1 - i]; }
      if (teams && hasDraw && (i >= 0 || DRAW_RE.test(label))) game3 = { teams, pick: i >= 0 ? i : 'draw' };
      // a total ("Over 2.5 goals scored") or spread ("Dortmund wins by more than 1.5 goals") of a game
      const line = lineSeries && kind === 'yesno' ? kalshiLine(lineSeries, m, label) : null;
      if (line) kind = line.kind;
      const game = kind === 'teams' || game3 != null;
      out.push({
        exchange: 'kalshi', id: m.ticker, eventKey: `kalshi:${ev.event_ticker || m.event_ticker}`, eventTitle: ev.title || '',
        title: m.title || ev.title || '', outcomeLabel: label, noLabel, kind, ...(game3 ? { game3 } : {}),
        ...(gameKey ? { gameKey } : {}), ...(line ? { line: line.line, ...(line.team ? { lineTeam: line.team } : {}) } : {}),
        yesAsk: tradable ? kalshiPrice(m, 'yes_ask') : null, noAsk: tradable ? kalshiPrice(m, 'no_ask') : null,
        closeTime: m.expected_expiration_time || m.close_time || null,
        startTime: game && when?.start != null ? new Date(when.start).toISOString() : null, gameDay: game && when ? when.day : null,
        expectedExpiration: m.expected_expiration_time || null, gameNo: kind === 'teams' ? gameNumber(ev.event_ticker, ev.title, m.title) : null,
        url: `https://kalshi.com/markets/${String(ev.event_ticker || m.event_ticker || '').toLowerCase()}`,
        category, league, liquidity: kalshiLiquidity(m), volume: num(m.volume),
        mutuallyExclusive: ev.mutually_exclusive === true, hasDraw, tradable, eventDecided: decided, eventComplete: true,
        rules: clip(m.rules_primary),
      });
    }
  }
  return out;
}

// ── Polymarket ──
// Taker fee schedule of a Gamma market: `feeSchedule` (an object, or the same
// as a JSON string) with `rate` and `exponent`. A sports market
// (`feeType: "sports_fees_v2"`) that comes without its schedule is taken at
// the published 0.05 rather than free, so a fee can't make up a fake arb.
// Anything else with no schedule pays nothing. → { rate, exponent } | null
const SPORTS_FEE_RATE = 0.05;
function polymarketFeeSchedule(m) {
  let sched = m?.feeSchedule ?? m?.fee_schedule ?? null;
  if (typeof sched === 'string') { try { sched = JSON.parse(sched); } catch { sched = null; } }
  const rate = num(sched?.rate);
  const type = m?.feeType ?? m?.fee_type ?? null;
  if (rate != null && rate >= 0) {
    const e = num(sched.exponent);
    return rate > 0 ? { rate, exponent: e != null && e > 0 ? e : 1, type } : null;
  }
  return /sports_fees/i.test(type || '') ? { rate: SPORTS_FEE_RATE, exponent: 1, type } : null;
}
// dollars of taker fee on `shares` bought at `price`
function polymarketFee(price, shares, sched) {
  const p = num(price), n = num(shares);
  if (!sched || !(p > 0 && p < 1) || !(n > 0)) return 0;
  return n * sched.rate * (p * (1 - p)) ** (sched.exponent || 1);
}

// bestAsk/bestBid quote the FIRST outcome. Buying the second outcome is
// selling the first, so its ask is 1 − bestBid. Mids (outcomePrices) are not
// tradable prices and are never used here.
const NOT_TEAMS = new Set(['yes', 'no', 'over', 'under', 'draw', 'tie', 'up', 'down', 'odd', 'even']);
const isMoneyline = m => (m.sportsMarketType == null || m.sportsMarketType === 'moneyline')
  && !(m.sportsMarketType == null && /spread|\(\s*[+-]?\d|o\/u|total/i.test(m.question || ''));
function yesWon(m) {
  const outs = (jsonList(m.outcomes) || []).map(o => String(o).trim().toLowerCase());
  const px = jsonList(m.outcomePrices) || [];
  const yi = outs.indexOf('yes');
  return yi >= 0 && num(px[yi]) >= 0.99;
}

// Soccer-style games on Polymarket are one negRisk event, "A vs. B", with a
// YES/NO moneyline market per team ("Will A win on 2026-10-09?",
// groupItemTitle "A") and one for the draw ("Will A vs. B end in a draw?",
// groupItemTitle "Draw (A vs. B)"). → { teams, pick: 0 | 1 | 'draw' } | null
const isDrawMarket = m => /^draw\b/i.test(String(m?.groupItemTitle || '').trim()) || /\bend in a draw\b/i.test(String(m?.question || ''));
function game3Of(m, teams) {
  const moneyline = m.sportsMarketType === 'moneyline'
    || (m.sportsMarketType == null && (/\bwin on \d{4}-\d{2}-\d{2}\b/i.test(m.question || '') || isDrawMarket(m)));
  if (!moneyline) return null;
  if (isDrawMarket(m)) return { teams, pick: 'draw' };
  const label = norm(m.groupItemTitle);
  const i = label ? teams.findIndex(t => norm(t) === label) : -1;
  return i >= 0 ? { teams, pick: i } : null;
}

// A game's total or spread, half lines only: "A vs. B: O/U 2.5" (not a
// team's "A vs. B: A O/U 0.5", nor a half's), "Spread: A (-1.5)". A spread's
// YES side is the one that has to win by more than the line. Spreads and
// totals of a soccer game sit in a separate "<slug>-more-markets" event; the
// row's gameSlug drops that tail so both point at the same game.
// → { kind: 'total' | 'spread', line, yesIndex, team? } | null
const POLY_TOTAL_RE = /(?:^|:\s*)o\/u\s+(\d+(?:\.\d+)?)\s*$/i;
const POLY_SPREAD_RE = /^spread:\s*(.+?)\s*\(([+-]\d+(?:\.\d+)?)\)\s*$/i;
function polymarketLine(m, names) {
  const q = String(m.question || '').trim(), type = m.sportsMarketType ?? null;
  const lower = names.map(x => x.toLowerCase());
  if (type === 'totals' || (type == null && POLY_TOTAL_RE.test(q))) {
    const t = q.match(POLY_TOTAL_RE), over = lower.indexOf('over');
    if (!t || over < 0 || !lower.includes('under')) return null;
    const line = Math.abs(num(m.line) ?? Number(t[1]));
    return halfLine(line) ? { kind: 'total', line, yesIndex: over } : null;
  }
  if (type === 'spreads' || (type == null && POLY_SPREAD_RE.test(q))) {
    const sp = q.match(POLY_SPREAD_RE);
    if (!sp) return null;
    const signed = num(m.line) ?? Number(sp[2]), i = names.findIndex(n => norm(n) === norm(sp[1]));
    if (i < 0 || !halfLine(Math.abs(signed))) return null;
    const yesIndex = signed < 0 ? i : 1 - i;
    return { kind: 'spread', line: Math.abs(signed), yesIndex, team: names[yesIndex] };
  }
  return null;
}

// A market whose Gamma record is over an hour old has stale prices (see
// exchanges.gammaStale): no legs from it.
function parsePolymarketBinaries(payload, { now = Date.now() } = {}) {
  const events = Array.isArray(payload) ? payload : payload?.events || payload?.data || [];
  const out = [];
  for (const ev of events) {
    if (!ev || !Array.isArray(ev.markets)) continue;
    const markets = ev.markets.filter(Boolean);
    const negRisk = ev.negRisk === true || ev.enableNegRisk === true || markets.some(m => m.negRisk === true);
    const decided = markets.some(m => m.closed === true && yesWon(m));
    const tags = (ev.tags || []).map(t => t?.label || t?.slug);
    const open = markets.filter(m => m.closed !== true);
    // a game that can end level ("A vs. B": YES/NO on each team, and on the draw)
    const evTeams = negRisk && open.some(isDrawMarket) ? titleTeams(ev.title) : null;
    const rows = [];
    for (const m of open) {
      const names = (jsonList(m.outcomes) || []).map(o => String(o).trim());
      if (names.length !== 2) continue;
      const lower = names.map(s => s.toLowerCase());
      const tradable = m.active !== false && m.acceptingOrders !== false && m.archived !== true && !gammaStale(m, now);
      const ask0 = tradable ? quote(m.bestAsk) : null;
      const bid0 = tradable ? quote(m.bestBid) : null;
      const ask1 = bid0 == null ? null : round(1 - bid0, 6);
      let kind, yesAsk, noAsk, outcomeLabel, noLabel = null, yesIndex = 0, line = null;
      const yi = lower.indexOf('yes');
      if (yi >= 0 && lower.includes('no')) {
        kind = 'yesno';
        yesIndex = yi;
        [yesAsk, noAsk] = yi === 0 ? [ask0, ask1] : [ask1, ask0];
        outcomeLabel = String(m.groupItemTitle || '').trim() || 'Yes';
      } else if (!lower.some(o => NOT_TEAMS.has(o)) && isMoneyline(m)) {
        kind = 'teams';
        [outcomeLabel, noLabel] = names;
        [yesAsk, noAsk] = [ask0, ask1];
      } else if ((line = polymarketLine(m, names))) {
        // YES is Over, or the side that has to win by more than the line
        kind = line.kind;
        yesIndex = line.yesIndex;
        [outcomeLabel, noLabel] = [names[yesIndex], names[1 - yesIndex]];
        [yesAsk, noAsk] = yesIndex === 0 ? [ask0, ask1] : [ask1, ask0];
      } else continue;
      const league = polymarketLeague(ev, m);
      const sportsHint = m.sportsMarketType != null || m.gameStartTime != null ? 'sports' : null;
      const game3 = kind === 'yesno' && evTeams ? game3Of(m, evTeams) : null;
      rows.push({
        exchange: 'polymarket', id: String(m.id), eventKey: `polymarket:${ev.id ?? ev.slug}`, eventTitle: ev.title || '',
        title: m.question || ev.title || '', outcomeLabel, noLabel, kind, ...(game3 ? { game3 } : {}), yesAsk, noAsk,
        ...(line ? { line: line.line, ...(line.team ? { lineTeam: line.team } : {}) } : {}),
        gameSlug: String(ev.slug || '').replace(/-more-markets$/, '') || null,
        closeTime: m.endDate || ev.endDate || null, startTime: m.gameStartTime || null,
        gameNo: kind === 'teams' ? gameNumber(ev.slug, m.slug, ev.title, m.question) : null,
        url: `https://polymarket.com/event/${ev.slug || m.slug || ''}`,
        category: league ? 'sports' : normalizeCategory(ev.category, m.category, ...tags, sportsHint),
        league, liquidity: num(m.liquidityClob) ?? num(m.liquidityNum) ?? num(m.liquidity), volume: num(m.volume),
        mutuallyExclusive: negRisk && kind === 'yesno', hasDraw: false, tradable, eventDecided: decided,
        eventComplete: true, conditionId: m.conditionId || null, rules: clip(m.description || ev.description),
        yesIndex, tokenIds: (jsonList(m.clobTokenIds) || []).map(String), feeSchedule: polymarketFeeSchedule(m),
      });
    }
    // an open market we couldn't read leaves the outcome set incomplete
    const complete = rows.length === open.length && (!negRisk || rows.every(r => r.kind === 'yesno'));
    for (const r of rows) { r.eventComplete = complete; out.push(r); }
  }
  return out;
}

// ── title matching ──
// A title becomes: content words (for Jaccard), plus a signature that must be
// identical on both sides: its numbers, months and direction words.
const STOPWORDS = new Set(('a an the will be is are was were been being of in on at to for by before and or with from as '
  + 'this that these those it its his her their there who whom what which when where how does do did has have had than '
  + 'then into any vs versus market price').split(' '));
const POLARITY = {
  above: 'gt', over: 'gt', exceed: 'gt', exceeds: 'gt', exceeding: 'gt', greater: 'gt', more: 'gt', gt: 'gt',
  below: 'lt', under: 'lt', less: 'lt', fewer: 'lt', lt: 'lt', gte: 'gte', lte: 'lte',
  higher: 'up', increase: 'up', increases: 'up', rise: 'up', rises: 'up', raise: 'up', raises: 'up', hike: 'up', hikes: 'up', up: 'up',
  lower: 'down', decrease: 'down', decreases: 'down', cut: 'down', cuts: 'down', fall: 'down', falls: 'down',
  drop: 'down', drops: 'down', decline: 'down', declines: 'down', reduce: 'down', down: 'down',
  hold: 'hold', unchanged: 'hold', pause: 'hold', not: 'not', no: 'not', never: 'not', without: 'not',
  after: 'after', following: 'after', between: 'between', exactly: 'exactly',
};
const PHRASES = [
  [/\bu\.s\.(?:a\.)?/g, 'us'],
  [/n't\b/g, ' not'],
  [/(\d)\s*\+/g, '$1 gte '],
  [/\bat least\b|\bor (?:more|higher|above|greater|over)\b|≥/g, ' gte '],
  [/\bat most\b|\bor (?:less|fewer|lower|below|under)\b|≤/g, ' lte '],
  [/\b(?:more|greater|higher) than\b|>/g, ' gt '],
  [/\b(?:less|fewer|lower) than\b|</g, ' lt '],
  [/\bno change\b|\bstay the same\b/g, ' hold '],
];
const MONTHS = {
  jan: 'jan', january: 'jan', feb: 'feb', february: 'feb', mar: 'mar', march: 'mar', apr: 'apr', april: 'apr', may: 'may',
  jun: 'jun', june: 'jun', jul: 'jul', july: 'jul', aug: 'aug', august: 'aug', sep: 'sep', sept: 'sep', september: 'sep',
  oct: 'oct', october: 'oct', nov: 'nov', november: 'nov', dec: 'dec', december: 'dec',
};
const NUM_RE = /(\d[\d,]*)(?:\.(\d+))?(?:(st|nd|rd|th)\b|\s*(thousand|million|billion|trillion)\b|(k|m|bn|b|t)\b)?/g;
const MULT = { k: 1e3, thousand: 1e3, m: 1e6, million: 1e6, b: 1e9, bn: 1e9, billion: 1e9, t: 1e12, trillion: 1e12 };
const stem = w => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);

function titleKey(text) {
  let s = String(text || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  for (const [re, to] of PHRASES) s = s.replace(re, to);
  const nums = new Set(), years = new Set();
  // "$100,000" → 100000, "3.00%" → 3, "100k" → 100000, "1st" → 1; numbers leave a '#' marker
  s = s.replace(NUM_RE, (m, int, frac, ord, word, unit) => {
    const v = Number(`${int.replace(/,/g, '')}${frac ? `.${frac}` : ''}`) * (MULT[word || unit] || 1);
    if (!Number.isFinite(v)) return ' ';
    const plain = !frac && !ord && !word && !unit && !int.replace(/,$/, '').includes(',');
    if (plain && v >= 1900 && v <= 2100) years.add(String(v)); else nums.add(String(Number(v.toPrecision(12))));
    return ' # ';
  });
  const toks = s.split(/[^a-z0-9#]+/).filter(Boolean);
  const words = new Set(), months = new Set(), polarity = new Set();
  toks.forEach((t, i) => {
    if (t === '#') return;
    // "may" is a month only next to a number ("May 5", "5 May")
    if (MONTHS[t] && (t !== 'may' || toks[i - 1] === '#' || toks[i + 1] === '#')) return void months.add(MONTHS[t]);
    if (POLARITY[t]) return void polarity.add(POLARITY[t]);
    if (t.length < 2 || STOPWORDS.has(t)) return;
    words.add(stem(t));
  });
  const sorted = set => [...set].sort().join(',');
  return { words, nums, years, months, polarity, sig: `${sorted(nums)}|${sorted(months)}|${sorted(polarity)}` };
}

// Jaccard of the content words, or null when a number, month, direction or
// year differs. A year only counts when both titles state one (the close-date
// check already pins the year).
function titleSimilarity(a, b) {
  const x = typeof a === 'string' ? titleKey(a) : a, y = typeof b === 'string' ? titleKey(b) : b;
  if (x.sig !== y.sig) return null;
  if (x.years.size && y.years.size && [...x.years].sort().join() !== [...y.years].sort().join()) return null;
  if (!x.words.size || !y.words.size) return null;
  let inter = 0;
  for (const w of x.words) if (y.words.has(w)) inter++;
  return inter / (x.words.size + y.words.size - inter);
}

// The question a row asks: its title, plus the outcome label when the title
// doesn't already say it ("Fed rate after Dec meeting?" + "Above 3.75%").
function proposition(r) {
  const t = r.title || r.eventTitle || '';
  const l = r.outcomeLabel && !/^yes$/i.test(r.outcomeLabel) ? r.outcomeLabel : '';
  return l && !norm(t).includes(norm(l)) ? `${t} ${l}` : t;
}

// ── subjects ──
// Jaccard alone pairs "Will the Yankees win the World Series?" with the Mets
// one, "Donald Trump" with "Donald Trump Jr." and "Israel strike Iran" with
// "Iran strike Israel". So the subject has to agree too: the outcome labels
// (when both have one) word for word, every name-like word (capitalised, not a
// filler word) on either side present on the other, and the names both sides
// share in the same order. Capitals only mean something in a sentence-case
// title; a Title Case one contributes no names of its own.
const isYes = l => /^yes$/i.test(l || '');
const ALIASES = { democratic: 'democrat', dem: 'democrat', gop: 'republican' };
const LABEL_FILLER = new Set(['party']);
const subjectWord = t => { const w = stem(t.toLowerCase()); return ALIASES[w] || w; };
const isFiller = t => { const l = t.toLowerCase(); return l.length < 2 || STOPWORDS.has(l) || !!MONTHS[l] || !!POLARITY[l] || !/^[a-z]/i.test(t); };
function subjectTokens(text) {
  return String(text || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\b(?:[A-Za-z]\.){2,}/g, m => m.replace(/\./g, ''))   // J.D. → JD, U.S. → US
    .split(/[^A-Za-z0-9]+|(?<=\d)(?=[A-Za-z])|(?<=[A-Za-z])(?=\d)/).filter(Boolean);
}
function subjectKey(r) {
  const toks = subjectTokens(proposition(r));
  const content = toks.filter(t => !isFiller(t));
  const sentence = content.some(t => /^[a-z]/.test(t));
  const names = [];
  if (sentence) for (const t of content) if (/^[A-Z]/.test(t) && !names.includes(subjectWord(t))) names.push(subjectWord(t));
  const raw = r.outcomeLabel && !isYes(r.outcomeLabel) ? subjectTokens(r.outcomeLabel).filter(t => !isFiller(t)).map(subjectWord).filter(w => !LABEL_FILLER.has(w)) : [];
  return { all: new Set(toks.map(subjectWord)), names, label: raw.length ? new Set(raw) : null };
}
function sameSubject(a, b) {
  if (a.label && b.label && (a.label.size !== b.label.size || [...a.label].some(w => !b.label.has(w)))) return false;
  for (const w of a.label || []) if (!b.all.has(w)) return false;
  for (const w of b.label || []) if (!a.all.has(w)) return false;
  if (a.names.some(w => !b.all.has(w)) || b.names.some(w => !a.all.has(w))) return false;
  // the shared names, outside the labels, in the same order
  const bn = new Set(b.names), an = new Set(a.names), inLabel = w => a.label?.has(w) || b.label?.has(w);
  const x = a.names.filter(w => bn.has(w) && !inLabel(w)), y = b.names.filter(w => an.has(w) && !inLabel(w));
  return x.join(' ') === y.join(' ');
}

// ── team matching ──
// Kalshi says "Boston", Polymarket says "Celtics": neither is a full name, so
// both are resolved against full team names (the league's, plus any Odds API
// games passed in) and match when they land on the same team.
const TEAM_NAMES = {
  nba: 'Atlanta Hawks|Boston Celtics|Brooklyn Nets|Charlotte Hornets|Chicago Bulls|Cleveland Cavaliers|Dallas Mavericks|Denver Nuggets|'
    + 'Detroit Pistons|Golden State Warriors|Houston Rockets|Indiana Pacers|Los Angeles Clippers|Los Angeles Lakers|Memphis Grizzlies|'
    + 'Miami Heat|Milwaukee Bucks|Minnesota Timberwolves|New Orleans Pelicans|New York Knicks|Oklahoma City Thunder|Orlando Magic|'
    + 'Philadelphia 76ers|Phoenix Suns|Portland Trail Blazers|Sacramento Kings|San Antonio Spurs|Toronto Raptors|Utah Jazz|Washington Wizards',
  nfl: 'Arizona Cardinals|Atlanta Falcons|Baltimore Ravens|Buffalo Bills|Carolina Panthers|Chicago Bears|Cincinnati Bengals|Cleveland Browns|'
    + 'Dallas Cowboys|Denver Broncos|Detroit Lions|Green Bay Packers|Houston Texans|Indianapolis Colts|Jacksonville Jaguars|Kansas City Chiefs|'
    + 'Las Vegas Raiders|Los Angeles Chargers|Los Angeles Rams|Miami Dolphins|Minnesota Vikings|New England Patriots|New Orleans Saints|'
    + 'New York Giants|New York Jets|Philadelphia Eagles|Pittsburgh Steelers|San Francisco 49ers|Seattle Seahawks|Tampa Bay Buccaneers|'
    + 'Tennessee Titans|Washington Commanders',
  mlb: 'Arizona Diamondbacks|Atlanta Braves|Baltimore Orioles|Boston Red Sox|Chicago Cubs|Chicago White Sox|Cincinnati Reds|Cleveland Guardians|'
    + 'Colorado Rockies|Detroit Tigers|Houston Astros|Kansas City Royals|Los Angeles Angels|Los Angeles Dodgers|Miami Marlins|Milwaukee Brewers|'
    + 'Minnesota Twins|New York Mets|New York Yankees|Athletics|Philadelphia Phillies|Pittsburgh Pirates|San Diego Padres|San Francisco Giants|'
    + 'Seattle Mariners|St. Louis Cardinals|Tampa Bay Rays|Texas Rangers|Toronto Blue Jays|Washington Nationals',
  nhl: 'Anaheim Ducks|Boston Bruins|Buffalo Sabres|Calgary Flames|Carolina Hurricanes|Chicago Blackhawks|Colorado Avalanche|Columbus Blue Jackets|'
    + 'Dallas Stars|Detroit Red Wings|Edmonton Oilers|Florida Panthers|Los Angeles Kings|Minnesota Wild|Montreal Canadiens|Nashville Predators|'
    + 'New Jersey Devils|New York Islanders|New York Rangers|Ottawa Senators|Philadelphia Flyers|Pittsburgh Penguins|San Jose Sharks|'
    + 'Seattle Kraken|St Louis Blues|Tampa Bay Lightning|Toronto Maple Leafs|Utah Mammoth|Vancouver Canucks|Vegas Golden Knights|'
    + 'Washington Capitals|Winnipeg Jets',
};

function teamContext(games = []) {
  const byLeague = new Map(Object.entries(TEAM_NAMES).map(([k, v]) => [k, new Set(v.split('|'))]));
  const loose = new Set();
  for (const g of games || []) {
    const lg = String(g?.sport_key || '').match(/_(nba|nfl|mlb|nhl|wnba|ncaaf|ncaab|mls)$/)?.[1];
    if (lg && !byLeague.has(lg)) byLeague.set(lg, new Set());
    for (const n of [g?.home_team, g?.away_team]) if (n) (lg ? byLeague.get(lg) : loose).add(n);
  }
  const all = [...new Set([...[...byLeague.values()].flatMap(s => [...s]), ...loose])];
  const names = new Map();
  const namesFor = league => {
    if (!league || !byLeague.has(league)) return all;
    if (!names.has(league)) names.set(league, [...new Set([...byLeague.get(league), ...loose])]);
    return names.get(league);
  };
  const cache = new Map();
  const resolve = (label, league) => {
    const key = `${league || '*'}|${label}`;
    if (!cache.has(key)) cache.set(key, new Set(namesFor(league).filter(full => teamMatches(label, full)).map(norm)));
    return cache.get(key);
  };
  function same(a, b, league = null) {
    const x = norm(a), y = norm(b);
    if (!x || !y || stateTwin(a, b)) return false;
    if (x === y || teamMatches(a, b) || teamMatches(b, a)) return true;
    const ys = resolve(b, league);
    for (const n of resolve(a, league)) if (ys.has(n)) return true;
    return false;
  }
  return { same };
}

// [a1, a2] vs [b1, b2] → 'same' (a1 is b1), 'flipped' (a1 is b2), or null
// when either side is missing or it fits both ways round.
function pairSides(a, b, same) {
  const direct = same(a[0], b[0]) && same(a[1], b[1]);
  const swap = same(a[0], b[1]) && same(a[1], b[0]);
  return direct === swap ? null : direct ? 'same' : 'flipped';
}

// Clubs, players and esports teams outside the built-in leagues: Kalshi says
// "Dortmund", Polymarket "BV Borussia 09 Dortmund"; "C. Alcaraz" is "Carlos
// Alcaraz". Names match when one's words (club letters and numbers dropped)
// are all in the other's, or two people share a surname and first initial.
const NAME_FILLER = new Set(['fc', 'cf', 'sc', 'sv', 'afc', 'bv', 'ac', 'as', 'ss', 'us', 'cd', 'ud', 'rc', 'rcd', 'sd', 'fk', 'sk', 'nk',
  'if', 'bk', 'ik', 'tsg', 'vfb', 'vfl', 'rb', 'club', 'de', 'del', 'la', 'the', 'team', 'esports', 'gaming', 'e', 'sports']);
const NAME_ALIAS = { munchen: 'munich', koln: 'cologne', utd: 'united', man: 'manchester', saint: 'st' };
// A last "St." is State: Kalshi's "Ohio St." is Polymarket's "Ohio State"
// (a first one is Saint: "St. Louis"). Apostrophes go: "Hawai'i", "St. John's".
const nameWords = s => {
  const words = norm(String(s || '').replace(/['’]/g, '')).split(' ').filter(Boolean);
  return words.map((t, i) => (t === 'st' && i > 0 && i === words.length - 1 ? 'state' : NAME_ALIAS[t] || t))
    .filter(t => t && !NAME_FILLER.has(t) && !/^\d+$/.test(t));
};
const endsState = w => w[w.length - 1] === 'state';
// "Ohio" and "Ohio St." are two schools, whatever the city rules say
function stateTwin(a, b) {
  const x = nameWords(a), y = nameWords(b);
  if (endsState(x) === endsState(y)) return false;
  const [st, plain] = endsState(x) ? [x, y] : [y, x];
  return st.slice(0, -1).join(' ') === plain.join(' ');
}
function nameMatch(a, b) {
  const x = nameWords(a), y = nameWords(b);
  if (!x.length || !y.length) return false;
  // Ohio State isn't Ohio, nor Iowa State Iowa (Golden State is the Golden State Warriors)
  if (endsState(x) !== endsState(y) && !(x.includes('state') && y.includes('state'))) return false;
  const [s, l] = x.length <= y.length ? [x, y] : [y, x];
  if (s.every(t => l.includes(t)) && s.some(t => t.length >= 3)) return true;
  const last = s[s.length - 1];
  return s.length > 1 && last.length >= 3 && last === l[l.length - 1] && s[0][0] === l[0][0];
}
// Both teams of two games: strict names first (the built-in leagues know
// "New York K" is the Knicks), then strict or nameMatch.
// → { pol: 'same' | 'flipped', strong } | null
function pairTeams(a, b, teams, league) {
  const strict = (x, y) => teams.same(x, y, league);
  const pol = pairSides(a, b, strict);
  if (pol) return { pol, strong: true };
  const loose = pairSides(a, b, (x, y) => strict(x, y) || nameMatch(x, y));
  return loose ? { pol: loose, strong: false } : null;
}

// Kalshi row × Polymarket row pairs that ask the same question. `same` says
// whether YES on one is YES on the other (false: YES on Kalshi is the
// Polymarket NO side, e.g. Kalshi "Boston" vs Polymarket "Knicks" first).
// Kalshi doesn't give a start time: its expected expiration is about 3h after
// the start, so that's the estimate (else its close time as is).
const KALSHI_GAME_HOURS = 3;
const kalshiGameMs = k => (ms(k.startTime) ?? (ms(k.expectedExpiration) != null ? ms(k.expectedExpiration) - KALSHI_GAME_HOURS * 3600e3 : ms(k.closeTime)));
// Where a Kalshi game's start can be: within the sports window of its start
// (the ticker's, else the estimate). Outside the built-in leagues (tennis,
// soccer, esports) Kalshi's expected expiration can be a day out, so anywhere
// on the ticker's date counts too (Eastern midnight − 6h to + 30h, for time
// zones). Football's is often a placeholder: 20:00 UTC on the ticker's date
// for a night kick-off, or a Friday ticker at 23:00 Eastern for a Saturday
// game whose time isn't set. The same two football teams never meet twice in
// a few days, so there the ticker's date and the two days after count.
// → { t, lo, hi } | null
const DAY_SLOP_MS = 6 * 3600e3;
const FOOTBALL = new Set(['nfl', 'ncaaf']);
function kalshiWindow(k, o) {
  const t = kalshiGameMs(k);
  if (t == null) return null;
  let lo = t - o.sportsWindowMs, hi = t + o.sportsWindowMs;
  if (k.gameDay != null && (!k.league || FOOTBALL.has(k.league))) {
    const days = k.league ? 3 : 1;
    lo = Math.min(lo, k.gameDay - DAY_SLOP_MS); hi = Math.max(hi, k.gameDay + days * DAY + DAY_SLOP_MS);
  }
  return { t, lo, hi };
}
// index of the first { t } at or after `t` in a list sorted by t
function firstAtOrAfter(list, t) {
  let lo = 0, hi = list.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (list[mid].t < t) lo = mid + 1; else hi = mid; }
  return lo;
}

// A game match → both sides' game keys and teams, in the same order:
// { kGame, pGame, kTeams: [a, b], pTeams: [a', b'] } | null
function gamePair(m) {
  const k = m.kalshi, p = m.polymarket;
  if (!k?.gameKey || !p?.gameSlug) return null;
  if (m.by === 'teams') {
    const kTeams = [k.outcomeLabel, k.noLabel], pTeams = m.same ? [p.outcomeLabel, p.noLabel] : [p.noLabel, p.outcomeLabel];
    return { kGame: k.gameKey, pGame: p.gameSlug, kTeams, pTeams };
  }
  if (m.by === 'teams3' && typeof k.game3?.pick === 'number' && typeof p.game3?.pick === 'number') {
    // this pair's picks say which way round the two team lists go
    const flip = k.game3.pick !== p.game3.pick;
    return { kGame: k.gameKey, pGame: p.gameSlug, kTeams: k.game3.teams, pTeams: flip ? [...p.game3.teams].reverse() : p.game3.teams };
  }
  return null;
}

// edges → the ones where each side is the other's unique best (higher score
// wins: similarity, or minus the time gap). A tie for best means no match.
// Several edges between the same two keys (a Kalshi game's two team markets)
// all stay.
function mutualBest(edges, keyA, keyB) {
  const bestBy = (keyOf, otherOf) => {
    const m = new Map();
    for (const e of edges) {
      const k = keyOf(e), cur = m.get(k);
      if (!cur || e.score > cur.score) m.set(k, { score: e.score, other: otherOf(e), tie: false });
      else if (e.score === cur.score && otherOf(e) !== cur.other) cur.tie = true;
    }
    return m;
  };
  const ba = bestBy(keyA, keyB), bb = bestBy(keyB, keyA);
  return edges.filter(e => {
    const x = ba.get(keyA(e)), y = bb.get(keyB(e));
    return !x.tie && !y.tie && x.other === keyB(e) && y.other === keyA(e) && x.score === e.score && y.score === e.score;
  });
}

function matchMarkets(kalshiRows, polyRows, opts = {}) {
  const o = withDefaults(opts);
  const teams = teamContext(o.games);
  const out = [];

  // sports games: both teams line up, the same game number when both say,
  // start times within 4h (any time on the ticker's date for sports outside
  // the built-in leagues), and only the nearest game on each side
  const pm = (polyRows || []).filter(r => r.kind === 'teams' && ms(r.startTime || r.closeTime) != null)
    .map(r => ({ r, t: ms(r.startTime || r.closeTime) })).sort((a, b) => a.t - b.t);
  const games = [];
  for (const k of kalshiRows || []) {
    if (k.kind !== 'teams' || k.hasDraw || !k.noLabel) continue;
    const w = kalshiWindow(k, o);
    if (!w) continue;
    for (let i = firstAtOrAfter(pm, w.lo); i < pm.length && pm[i].t <= w.hi; i++) {
      const p = pm[i].r;
      if (k.league && p.league && k.league !== p.league) continue;
      if (k.gameNo != null && p.gameNo != null && k.gameNo !== p.gameNo) continue;
      const pair = pairTeams([k.outcomeLabel, k.noLabel], [p.outcomeLabel, p.noLabel], teams, k.league || p.league);
      // a strict name match beats a loose one at the same distance
      if (pair) games.push({ m: { kalshi: k, polymarket: p, same: pair.pol === 'same', by: 'teams' }, score: -Math.abs(pm[i].t - w.t) - (pair.strong ? 0 : 1) });
    }
  }
  // a Kalshi game is one event with a market per team: pick per event
  for (const e of mutualBest(games, e => e.m.kalshi.eventKey, e => e.m.polymarket.id)) out.push(e.m);

  // games that can end level (soccer): Kalshi's team and tie markets against
  // Polymarket's "Will A win?" / "end in a draw?" markets, paired per event
  // the same way, then outcome by outcome (YES A is YES A; the tie is the draw)
  const events3 = rows => {
    const m = new Map();
    for (const r of rows || []) if (r.game3?.teams?.length === 2) push(m, r.eventKey, r);
    return [...m.values()];
  };
  const pm3 = events3(polyRows).map(rs => ({ rs, t: ms(rs[0].startTime || rs[0].closeTime) })).filter(e => e.t != null).sort((a, b) => a.t - b.t);
  const pairs3 = [];
  for (const ks of events3(kalshiRows)) {
    const w = kalshiWindow(ks[0], o);
    if (!w) continue;
    for (let i = firstAtOrAfter(pm3, w.lo); i < pm3.length && pm3[i].t <= w.hi; i++) {
      const ps = pm3[i].rs;
      if (ks[0].league && ps[0].league && ks[0].league !== ps[0].league) continue;
      const pair = pairTeams(ks[0].game3.teams, ps[0].game3.teams, teams, ks[0].league || ps[0].league);
      if (pair) pairs3.push({ ks, ps, pol: pair.pol, score: -Math.abs(pm3[i].t - w.t) - (pair.strong ? 0 : 1) });
    }
  }
  for (const e of mutualBest(pairs3, e => e.ks[0].eventKey, e => e.ps[0].eventKey)) {
    for (const k of e.ks) {
      const pick = k.game3.pick, want = pick === 'draw' ? 'draw' : e.pol === 'same' ? pick : 1 - pick;
      const p = e.ps.find(r => r.game3.pick === want);
      if (p) out.push({ kalshi: k, polymarket: p, same: true, by: 'teams3' });
    }
  }

  // a paired game's totals and spreads: Kalshi's lines (found by the game's
  // ticker tail) against Polymarket's (by the game's slug), the same number,
  // and for a spread the same team (YES Over is YES Over; YES "Dortmund wins
  // by more than 1.5" is Polymarket's Dortmund (-1.5))
  const kLines = new Map(), pLines = new Map();
  for (const k of kalshiRows || []) if ((k.kind === 'total' || k.kind === 'spread') && k.gameKey) push(kLines, k.gameKey, k);
  for (const p of polyRows || []) if ((p.kind === 'total' || p.kind === 'spread') && p.gameSlug) push(pLines, p.gameSlug, p);
  if (kLines.size && pLines.size) {
    const seen = new Set();
    for (const g of out.map(gamePair).filter(Boolean)) {
      const key = `${g.kGame}|${g.pGame}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const ps = pLines.get(g.pGame) || [];
      for (const k of kLines.get(g.kGame) || []) {
        let p;
        if (k.kind === 'total') p = ps.find(r => r.kind === 'total' && r.line === k.line);
        else {
          const i = g.kTeams.findIndex(t => norm(t) === norm(k.lineTeam) || nameMatch(t, k.lineTeam));
          const team = i >= 0 && g.kTeams.filter(t => norm(t) === norm(k.lineTeam) || nameMatch(t, k.lineTeam)).length === 1 ? g.pTeams[i] : null;
          p = team && ps.find(r => r.kind === 'spread' && r.line === k.line && (norm(r.lineTeam) === norm(team) || nameMatch(r.lineTeam, team)));
        }
        if (p) out.push({ kalshi: k, polymarket: p, same: true, by: 'line' });
      }
    }
  }

  // everything else: identical numbers/dates/directions, similar words, the
  // same subject, close dates within 3 days, each side's unique best match.
  // Bucketed by signature and close day, so each Kalshi market only meets a
  // handful of candidates.
  const index = new Map();
  for (const p of polyRows || []) {
    const t = ms(p.closeTime);
    if (p.kind !== 'yesno' || p.game3 || t == null) continue;
    const key = titleKey(proposition(p));
    if (key.words.size) push(index, `${key.sig}|${Math.floor(t / DAY)}`, { r: p, key, t, subject: null });
  }
  const span = Math.ceil(o.titleWindowMs / DAY);
  const titled = [];
  for (const k of kalshiRows || []) {
    const t = ms(k.closeTime);
    if (k.kind !== 'yesno' || k.game3 || t == null) continue;
    const key = titleKey(proposition(k));
    if (!key.words.size) continue;
    let subject = null;
    const day = Math.floor(t / DAY);
    for (let d = day - span; d <= day + span; d++) {
      for (const c of index.get(`${key.sig}|${d}`) || []) {
        if (Math.abs(c.t - t) > o.titleWindowMs) continue;
        const sim = titleSimilarity(key, c.key);
        if (sim == null || sim < o.minSimilarity) continue;
        subject ||= subjectKey(k);
        c.subject ||= subjectKey(c.r);
        if (!sameSubject(subject, c.subject)) continue;
        titled.push({ m: { kalshi: k, polymarket: c.r, same: true, by: 'title', similarity: round(sim, 2) }, score: sim });
      }
    }
  }
  for (const e of mutualBest(titled, e => e.m.kalshi.id, e => e.m.polymarket.id)) out.push(e.m);
  return out;
}

// ── pricing ──
// Cost of n contracts on one leg, fee included. Kalshi's fee is per order,
// on the whole count, rounded up to the cent. A Polymarket leg pays its
// market's schedule, or the flat POLYMARKET_FEE_RATE (default 0) on markets
// without one.
function legCost(l, n, o) {
  const base = l.price * n;
  const fee = l.venue === 'kalshi' ? kalshiFee(l.price, n, o.kalshiFeeRate)
    : l.feeSchedule ? polymarketFee(l.price, n, l.feeSchedule) : base * (o.polymarketFeeRate || 0);
  return { base, fee, total: base + fee };
}
const setCost = (legs, n, o) => sum(legs.map(l => legCost(l, n, o).total));
// the most contracts per leg the budget buys (cost only grows with n)
function maxSets(legs, budget, o) {
  let lo = 0, hi = Math.max(0, Math.floor(budget / sum(legs.map(l => l.price)) + 1e-9));
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (setCost(legs, mid, o) <= budget + 1e-9) lo = mid; else hi = mid - 1;
  }
  return lo;
}

// Stakes for a bankroll, split so every outcome pays the same. Exchange arbs:
// the same whole number of contracts on every leg. Sportsbook arbs: stake on
// each leg ∝ 1/decimal. Each leg's `pct` is its share of the total stake, the
// same split whatever the total (what the app shows, so nobody's bankroll
// goes into it).
const pctOf = (part, whole) => (whole > 0 ? round((part / whole) * 100, 1) : null);
function stakeArb(arb, bankroll, opts = {}) {
  const o = withDefaults({ ...arb?.fees, ...opts });   // the fee rates the arb was found with, unless overridden
  const B = Number(bankroll);
  if (!arb || !(B > 0)) return null;
  if (arb.type === 'book') {
    const inv = arb.legs.map(l => 1 / l.decimal), S = sum(inv);
    const legs = arb.legs.map((l, i) => {
      const stake = r2(B * inv[i] / S);
      return { venue: l.venue, pick: l.pick, decimal: l.decimal, stake, payout: r2(stake * l.decimal), pct: pctOf(inv[i], S) };
    });
    const cost = r2(sum(legs.map(l => l.stake))), payout = Math.min(...legs.map(l => l.payout));
    return { bankroll: B, legs, cost, payout, profit: r2(payout - cost), profitPct: r2(((payout - cost) / cost) * 100), capped: false };
  }
  let n = maxSets(arb.legs, B, o);
  const capped = arb.maxContracts != null && n > arb.maxContracts;
  if (capped) n = arb.maxContracts;
  const cost = setCost(arb.legs, n, o);
  const legs = arb.legs.map(l => {
    const c = legCost(l, n, o);
    return { venue: l.venue, marketId: l.marketId, side: l.side, pick: l.pick, price: l.price, contracts: n, stake: r2(c.total), fee: r2(c.fee), pct: pctOf(c.total, cost) };
  });
  return { bankroll: B, contracts: n, legs, cost: r2(cost), payout: n, profit: r2(n - cost), profitPct: cost > 0 ? r2(((n - cost) / cost) * 100) : 0, capped };
}

const arbId = (type, legs) => `${type}:${legs.map(l => `${l.venue}:${l.marketId ?? ''}:${l.side || l.pick}`).join('+')}`;

function leg(r, side) {
  const label = r.outcomeLabel && !isYes(r.outcomeLabel) ? r.outcomeLabel : '';
  return {
    venue: r.exchange, marketId: r.id, side,
    pick: side === 'yes' ? label || 'YES' : r.noLabel || (label ? `NO ${label}` : 'NO'),
    price: side === 'yes' ? r.yesAsk : r.noAsk,
    title: r.title, url: r.url, liquidity: r.liquidity, closeTime: r.closeTime, rules: r.rules || null,
    ...(r.exchange !== 'kalshi' ? { feeSchedule: r.feeSchedule || null } : {}),
    ...((side === 'yes' ? r.yesDepth : r.noDepth) != null ? { depth: side === 'yes' ? r.yesDepth : r.noDepth } : {}),
  };
}

// Price a set of contract legs at the reference bankroll; null unless it profits.
function contractArb(fields, legs, o) {
  if (legs.some(l => l.price == null) || sum(legs.map(l => l.price)) >= 1) return null;   // fees only add
  // depth at the ask is mostly unknown: the exchanges' liquidity figures are
  // totals over the whole book, so they say nothing about size at this price.
  // A leg priced off a read order book (Polymarket US) knows its own.
  const depths = legs.map(l => l.depth).filter(d => d != null && d >= 0);
  const maxContracts = depths.length ? Math.floor(Math.min(...depths)) : null;
  if (maxContracts === 0) return null;
  const n = Math.max(1, Math.min(maxSets(legs, o.bankroll, o), maxContracts ?? Infinity));
  const cost = setCost(legs, n, o);
  if (!(cost < n)) return null;
  const arb = {
    id: arbId(fields.type, legs), ...fields, legs,
    totalCost: round(cost / n, 4), profitPct: r2(((n - cost) / cost) * 100),
    maxContracts, maxStake: null, exhaustive: fields.exhaustive ?? true,
    warnings: [...(fields.warnings || [])], fees: { kalshiFeeRate: o.kalshiFeeRate, polymarketFeeRate: o.polymarketFeeRate },
    at: new Date(o.now).toISOString(),
  };
  arb.stakes = stakeArb(arb, o.bankroll, o);
  return arb;
}

const expired = (r, now) => { const t = ms(r.closeTime); return t != null && t <= now; };

// 1. YES on one exchange + the opposite side on the other, both directions
function crossArbs(match, o) {
  const { kalshi: k, polymarket: p, same } = match;
  if (!k.tradable || !p.tradable || expired(k, o.now) || expired(p, o.now)) return [];
  const fields = {
    type: 'cross', category: k.category !== 'other' ? k.category : p.category,
    title: match.by !== 'title' ? k.eventTitle || k.title : k.title, closeTime: later(k.closeTime, p.closeTime),
    match: { by: match.by, ...(match.similarity != null ? { similarity: match.similarity } : {}) },
    warnings: [...(match.by === 'title' ? [RULES_WARNING] : []), ...(p.warnings || [])],
  };
  return [
    [leg(k, 'yes'), leg(p, same ? 'no' : 'yes')],
    [leg(k, 'no'), leg(p, same ? 'yes' : 'no')],
  ].map(legs => contractArb(fields, legs, o)).filter(Boolean);
}

// opts.matches: matchMarkets output already computed for these rows
function findCrossArbs(kalshiRows, polyRows, opts = {}) {
  const o = withDefaults(opts);
  // a game shows up once per Kalshi team market; keep its best direction
  const best = new Map();
  for (const m of o.matches || matchMarkets(kalshiRows, polyRows, o)) {
    const key = m.by === 'teams' ? `${m.kalshi.eventKey}|${m.polymarket.id}` : `${m.kalshi.id}|${m.polymarket.id}`;
    for (const a of crossArbs(m, o)) if (!best.has(key) || best.get(key).profitPct < a.profitPct) best.set(key, a);
  }
  return [...best.values()];
}

// 2. YES on every outcome of a one-winner event
// "Mutually exclusive" says at most one wins, not that one of them must. The
// set is taken as covering every result only when it visibly does: a
// catch-all outcome, range buckets open at both ends, or a game whose sport
// can't tie.
const CATCH_ALL_RE = /\b(other|others|another|any other|field|someone else|somebody else|anyone else|none|no one|nobody|neither|not listed|tie|draw)\b/i;
const OPEN_HIGH_RE = /\bor (?:more|higher|above|greater|over)\b|\+\s*$|^\s*(?:above|over|more than|greater than|at least|>|≥)/i;
const OPEN_LOW_RE = /\bor (?:less|lower|below|under|fewer)\b|^\s*(?:below|under|less than|fewer than|at most|<|≤)/i;
const NO_TIE_LEAGUES = new Set(['nba', 'wnba', 'ncaab', 'mlb', 'nhl']);
function exhaustiveSet(g) {
  const labels = g.map(r => (r.outcomeLabel && !isYes(r.outcomeLabel) ? r.outcomeLabel : r.title || ''));
  if (labels.some(l => CATCH_ALL_RE.test(l))) return true;
  if (labels.some(l => OPEN_HIGH_RE.test(l)) && labels.some(l => OPEN_LOW_RE.test(l))) return true;
  return g.length === 2 && g.every(r => r.kind === 'teams' && !r.hasDraw) && NO_TIE_LEAGUES.has(g[0].league);
}
// a game that can end level is both teams and the draw, or it's missing one
// (and its draw would pass for a catch-all)
const game3Whole = g => !g.some(r => r.game3) || (g.length === 3 && g.every(r => r.game3) && new Set(g.map(r => r.game3.pick)).size === 3);
function findUnderrounds(rows, opts = {}) {
  const o = withDefaults(opts);
  const groups = new Map();
  for (const r of rows || []) if (r.mutuallyExclusive) push(groups, r.eventKey, r);
  const out = [];
  for (const g of groups.values()) {
    if (g.length < 2 || !game3Whole(g) || g.some(r => !r.tradable || r.yesAsk == null || r.eventDecided || r.eventComplete === false || expired(r, o.now))) continue;
    const exhaustive = exhaustiveSet(g);
    const arb = contractArb({
      type: 'multi', category: g[0].category, title: g[0].eventTitle || g[0].title, exchange: g[0].exchange,
      eventKey: g[0].eventKey, outcomes: g.length, closeTime: later(...g.map(r => r.closeTime)),
      exhaustive, warnings: [exhaustive ? COVER_WARNING : NOT_EXHAUSTIVE_WARNING],
    }, g.map(r => leg(r, 'yes')), o);
    if (arb) out.push(arb);
  }
  return out;
}

// 4. Kalshi vs Polymarket US (pmus.arbRowsOf rows), plus Polymarket US's own
// result sets; at least minPct, best first. opts.matches as findCrossArbs.
function findUsArbs(kalshiRows, usRows, opts = {}) {
  const o = withDefaults(opts);
  return [...findCrossArbs(kalshiRows, usRows, o), ...findUnderrounds(usRows, o)]
    .filter(a => a.profitPct >= o.minPct).sort((a, b) => b.profitPct - a.profitPct);
}

// ── US venues ──
// Polymarket International is closed to US persons, and offshore / non-US
// books that turn up in the odds feeds aren't US sportsbooks either. Kalshi,
// Novig, ProphetX and the state-licensed books are.
const NOT_US_BOOKS = new Set(['polymarket', 'pinnacle', 'ps3838', 'bovada', 'betonlineag', 'betonline', 'lowvig', 'mybookieag', 'betus',
  'everygame', 'gtbets', 'intertops', 'betanysports', 'matchbook', 'smarkets', 'marathonbet', 'onexbet', 'nordicbet', 'coolbet', 'betsson',
  'sport888', 'williamhill', 'unibet', 'unibet_eu', 'unibet_uk', 'unibet_se', 'unibet_nl', 'unibet_it', 'unibet_fr', 'betclic', 'betway',
  'paddypower', 'skybet', 'ladbrokes', 'ladbrokes_uk', 'ladbrokes_au', 'coral', 'livescorebet', 'livescorebet_eu', 'virginbet', 'boylesports',
  'casumo', 'leovegas', 'leovegas_se', 'betvictor', 'grosvenor', 'tipico_de', 'sportsbet', 'tab', 'neds', 'pointsbetau', 'unibet_au', 'betr_au',
  'playup', 'topsport', 'suprabets', 'winamax_fr', 'winamax_de', 'parionssport_fr', 'pmu_fr', 'codere_it']);
const isUsVenue = key => { const k = String(key || '').toLowerCase(); return !!k && !NOT_US_BOOKS.has(k) && !k.startsWith('betfair'); };
// every leg can be placed from the US
const usPlaceable = arb => (arb?.legs || []).length > 0 && arb.legs.every(l => isUsVenue(l.venue));

// 3. exchange price on one side of a game, best sportsbook on the other
function bookLeg(b, outcome, d) {
  return { venue: b.key, venueTitle: b.title || b.key, pick: outcome.name, american: num(outcome.price), decimal: round(d, 6), url: outcome.link || b.link || null };
}
// polymarketRows (this scan's parsePolymarketBinaries rows), when given:
// a Polymarket book only counts if its market showed a real bid and ask here.
function polymarketBacked(rows) {
  if (!rows) return () => true;
  const byUrl = new Map();
  for (const r of rows) if (r.kind === 'teams') push(byUrl, r.url, r);
  return url => { const rs = byUrl.get(url); return !!rs && rs.every(r => r.yesAsk != null && r.noAsk != null); };
}
// US mode: only the Kalshi book and US sportsbooks
function findBookArbs(games, opts = {}) {
  const o = withDefaults(opts);
  const us = o.region === 'us';
  const backed = polymarketBacked(o.polymarketRows);
  const out = [];
  for (const g of games || []) {
    const t0 = ms(g?.commence_time);
    if (t0 != null && t0 <= o.now) continue;
    const h2h = (g.bookmakers || []).map(b => ({ b, outs: (b.markets || []).find(m => m.key === 'h2h')?.outcomes }))
      .filter(x => x.b && Array.isArray(x.outs) && x.outs.length === 2 && (!us || isUsVenue(x.b.key)));
    const books = h2h.filter(x => !EXCHANGE_BOOKS.has(x.b.key));
    for (const e of h2h.filter(x => EXCHANGE_BOOKS.has(x.b.key))) {
      if (e.b.key === 'polymarket' && !e.outs.every(x => backed(x.link || e.b.link))) continue;
      for (const mine of e.outs) {
        const dA = americanToDecimal(mine.price);
        const other = e.outs.find(x => x !== mine)?.name;
        if (!dA || !other) continue;
        let best = null;
        for (const s of books) {
          const q = s.outs.find(x => x.name === other);
          const d = q && americanToDecimal(q.price);
          if (d && (!best || d > best.d)) best = { b: s.b, q, d };
        }
        if (!best) continue;
        const S = 1 / dA + 1 / best.d;
        if (!(S < 1)) continue;
        const legs = [bookLeg(e.b, mine, dA), bookLeg(best.b, best.q, best.d)];
        const arb = {
          id: arbId('book', legs.map(l => ({ ...l, marketId: g.id }))), type: 'book', category: 'sports', sport: g.sport_key || null,
          gameId: g.id ?? null, title: `${g.away_team} @ ${g.home_team}`, closeTime: g.commence_time || null, legs,
          totalCost: round(S, 4), profitPct: r2(((1 - S) / S) * 100), maxContracts: null, maxStake: null, exhaustive: true, warnings: [],
          at: new Date(o.now).toISOString(),
        };
        arb.stakes = stakeArb(arb, o.bankroll, o);
        out.push(arb);
      }
    }
  }
  return out;
}

// All three kinds over parsed rows (+ Odds API games), at least minPct, best
// first. US mode: no Kalshi-vs-Polymarket or Polymarket-only arbs, and every
// leg on a venue a US person can use.
function findArbs({ kalshi = [], polymarket = [], games = [] } = {}, opts = {}) {
  const o = withDefaults({ ...opts, games });
  const us = o.region === 'us';
  return [
    ...(us ? [] : findCrossArbs(kalshi, polymarket, o)),
    ...findUnderrounds(us ? kalshi : [...kalshi, ...polymarket], o),
    ...findBookArbs(games, { ...o, polymarketRows: polymarket }),
  ].filter(a => a.profitPct >= o.minPct && (!us || usPlaceable(a))).sort((a, b) => b.profitPct - a.profitPct);
}

// ── where to tail ──
// The arb scan's rows, indexed so a tail signal (a Polymarket bet, known by
// its conditionId or token) can find the same proposition elsewhere.
// matches: matchMarkets(kalshi, polymarket) from the same scan; games: Odds
// API-shaped game lines (any exchange books on them are ignored here).
const KALSHI_FEE_LOT = 100;   // per-contract Kalshi fee quoted on a 100-contract order (the fee rounds up per order)
const BOOK_SAME_GAME_MS = 30 * 60e3;   // two feeds' copies of one game start within this of each other
function venueIndex({ kalshi = [], polymarket = [], matches = null, games = [] } = {}, opts = {}) {
  const o = withDefaults({ ...opts, games });
  const byCondition = new Map(), byToken = new Map();
  for (const r of polymarket || []) {
    const entry = { row: r, matches: [] };
    if (r.conditionId) byCondition.set(String(r.conditionId).toLowerCase(), entry);
    for (const t of r.tokenIds || []) byToken.set(t, entry);
  }
  for (const m of matches || matchMarkets(kalshi, polymarket, o)) {
    const e = m.polymarket?.conditionId ? byCondition.get(String(m.polymarket.conditionId).toLowerCase()) : null;
    if (e) e.matches.push(m);
  }
  return { byCondition, byToken, games: games || [], teams: teamContext(games), size: byCondition.size };
}

// Did the bet back the row's YES side? (outcome index first, then the label)
function boughtYesOf(row, s) {
  const i = num(s?.outcomeIndex);
  if (i === 0 || i === 1) return i === (row.yesIndex ?? 0);
  const l = norm(s?.outcome);
  if (!l) return null;
  if (row.kind === 'yesno') return l === 'yes' ? true : l === 'no' ? false : null;
  return l === norm(row.outcomeLabel) ? true : l === norm(row.noLabel) ? false : null;
}
const gameLeague = g => String(g?.sport_key || '').match(/_(nba|nfl|mlb|nhl|wnba|ncaaf|ncaab|mls)$/)?.[1] || null;

// signal → venue quotes for the outcome the sharp bought: [{ key, name, price,
// fee (per contract), cost, american?, url, pick, ... }]. Kalshi from the
// matched markets, sportsbooks for a two-team game, and Polymarket itself
// (its own ask) outside US mode. Nothing found → [].
function venueQuotes(signal, index, opts = {}) {
  const o = withDefaults(opts);
  const us = o.region === 'us';
  if (!signal) return [];
  const entry = (signal.conditionId && index?.byCondition?.get(String(signal.conditionId).toLowerCase()))
    || (signal.asset != null && index?.byToken?.get(String(signal.asset))) || null;
  const row = entry?.row || null;
  const yes = row ? boughtYesOf(row, signal) : null;
  const out = [];
  const add = q => { if (q.price > 0 && q.price < 1) out.push({ ...q, price: round(q.price, 6), fee: round(q.fee || 0, 6), cost: round(q.price + (q.fee || 0), 6) }); };

  if (row && yes != null) {
    // Kalshi: the matched side asking the same question
    for (const m of entry.matches) {
      const k = m.kalshi;
      if (!k?.tradable || expired(k, o.now)) continue;
      const side = yes === m.same ? 'yes' : 'no';
      const price = side === 'yes' ? k.yesAsk : k.noAsk;
      if (price == null) continue;
      add({
        key: 'kalshi', name: 'Kalshi', price, fee: kalshiFee(price, KALSHI_FEE_LOT, o.kalshiFeeRate) / KALSHI_FEE_LOT,
        marketId: k.id, side, pick: leg(k, side).pick, buy: `${side.toUpperCase()} ${k.outcomeLabel || k.title}`, title: k.title, url: k.url, match: m.by,
        ...(m.by === 'title' ? { warning: RULES_WARNING } : {}),
      });
    }
    // sportsbooks: that team's moneyline in the same game
    const t0 = ms(row.startTime || row.closeTime);
    if (row.kind === 'teams' && t0 != null && row.noLabel) {
      const found = [];
      for (const g of index?.games || []) {
        const tg = ms(g?.commence_time);
        if (tg == null || tg <= o.now || Math.abs(tg - t0) > o.sportsWindowMs) continue;
        const lg = gameLeague(g);
        if (row.league && lg && row.league !== lg) continue;
        const pol = pairSides([row.outcomeLabel, row.noLabel], [g.home_team, g.away_team], (a, b) => index.teams.same(a, b, row.league || lg));
        if (pol) found.push({ g, tg, name: (pol === 'same') === yes ? g.home_team : g.away_team });
      }
      const nearest = found.reduce((a, b) => (!a || Math.abs(b.tg - t0) < Math.abs(a.tg - t0) ? b : a), null);
      const best = new Map();   // book → its best price for the team
      for (const f of found) {
        if (Math.abs(f.tg - nearest.tg) > BOOK_SAME_GAME_MS) continue;   // a doubleheader's other game
        for (const b of f.g.bookmakers || []) {
          if (!b?.key || EXCHANGE_BOOKS.has(b.key) || (us && !isUsVenue(b.key))) continue;
          const outs = (b.markets || []).find(m => m.key === 'h2h')?.outcomes;
          if (!Array.isArray(outs) || outs.length !== 2) continue;   // a three-way line isn't the same bet
          const q = outs.find(x => x.name === f.name);
          const d = q && americanToDecimal(q.price);
          if (d && d > 1 && (!best.has(b.key) || d > best.get(b.key).d)) best.set(b.key, { b, q, d });
        }
      }
      for (const { b, q, d } of best.values()) {
        add({ key: b.key, name: b.title || b.key, price: 1 / d, fee: 0, american: num(q.price), decimal: round(d, 6), pick: q.name, buy: q.name, url: q.link || b.link || null, book: true });
      }
    }
  }
  // Polymarket's own price, never in US mode
  if (!us) {
    const own = quote(signal.currentPrice);
    const price = own ?? (row && yes != null ? (yes ? row.yesAsk : row.noAsk) : null);
    if (price != null) {
      // the signal's own fee came from that market's schedule at that price
      const fee = own != null && Number.isFinite(signal.fee) ? signal.fee
        : row?.feeSchedule ? polymarketFee(price, 1, row.feeSchedule) : price * (o.polymarketFeeRate || 0);
      add({ key: 'polymarket', name: 'Polymarket', price, fee, pick: signal.outcome ?? null, url: signal.url || row?.url || null });
    }
  }
  return out;
}

// sized quotes ({ units, cost, price }) → the one with the most units; ties
// go to the cheaper all-in cost, then the lower price. null when none.
function pickVenue(quotes) {
  const list = (quotes || []).filter(q => q && Number.isFinite(q.price));
  if (!list.length) return null;
  return [...list].sort((a, b) => ((b.units || 0) - (a.units || 0)) || ((a.cost ?? a.price) - (b.cost ?? b.price)) || (a.price - b.price))[0];
}

// ── fetching ──
// Pages until the exchange runs out or maxPages; a failed page keeps what
// came before. onPage(events) takes each page as it lands (parse it and let
// the raw JSON go) instead of holding every page; events then stays empty and
// `count` says how many there were. truncated: the page cap cut the list short.
async function fetchKalshiEvents(http, { maxPages = 30, limit = 200, onPage = null, seriesTicker = null } = {}) {
  const events = [], errors = [];
  let cursor = null, pages = 0, count = 0, truncated = false;
  try {
    while (pages < maxPages) {
      const params = { status: 'open', with_nested_markets: true, limit };
      if (seriesTicker) params.series_ticker = seriesTicker;
      if (cursor) params.cursor = cursor;
      const res = await http.get(KALSHI_EVENTS_URL, { params, timeout: 15000 });
      const page = res?.data?.events || [];
      if (onPage) onPage(page); else events.push(...page);
      count += page.length;
      pages++;
      cursor = res?.data?.cursor || null;
      if (!cursor || !page.length) break;
      truncated = pages >= maxPages;
    }
  } catch (e) { errors.push({ exchange: 'kalshi', key: `events page ${pages + 1}`, message: e?.message || String(e) }); }
  return { events, errors, pages, count, truncated };
}

// busiest first (24h volume), so a page cap drops the quiet events, not a
// random slice. Gamma serves at most 100 events a page whatever the limit
// asks, so a page shorter than that ends the list, not one shorter than the
// limit (asking for 200 cut every scan to the first 100 events).
const GAMMA_PAGE_MAX = 100;
async function fetchPolymarketEvents(http, { maxPages = 15, limit = GAMMA_PAGE_MAX, onPage = null } = {}) {
  const events = [], errors = [];
  let pages = 0, count = 0, truncated = false;
  try {
    while (pages < maxPages) {
      const res = await http.get(POLYMARKET_EVENTS_URL, { params: { active: true, closed: false, order: 'volume24hr', ascending: false, limit, offset: count }, timeout: 15000 });
      const d = res?.data;
      const page = Array.isArray(d) ? d : d?.events || d?.data || [];
      if (onPage) onPage(page); else events.push(...page);
      count += page.length;
      pages++;
      if (page.length < Math.min(limit, GAMMA_PAGE_MAX)) break;
      truncated = pages >= maxPages;
    }
  } catch (e) { errors.push({ exchange: 'polymarket', key: `events page ${pages + 1}`, message: e?.message || String(e) }); }
  return { events, errors, pages, count, truncated };
}

// ── Kalshi game listings ──
// Kalshi's open-events list runs to tens of thousands and the scan's page cap
// cuts it, so a game can be missing from it. So every sports series whose
// ticker ends in GAME or MATCH (KXEPLGAME, KXATPMATCH, KXLOLGAME, ...), and
// its TOTAL and SPREAD siblings, is also read on its own, perScan series a
// scan, least recently read first:
// series with open games take most of the slots, and a few go to the quiet
// ones so a new game there turns up too. The series list is Kalshi's Sports
// category (refreshed every 6h; a failed read retries in 10 min), plus a
// built-in list.
const KALSHI_SERIES_URL = 'https://api.elections.kalshi.com/trade-api/v2/series';
const GAME_SERIES_RE = /(GAME|MATCH)$/i;
const SEED_GAME_SERIES = ['KXNFLGAME', 'KXNBAGAME', 'KXMLBGAME', 'KXNHLGAME', 'KXWNBAGAME', 'KXNCAAFGAME', 'KXNCAAMBGAME', 'KXMLSGAME',
  'KXEPLGAME', 'KXLALIGAGAME', 'KXSERIEAGAME', 'KXBUNDESLIGAGAME', 'KXLIGUE1GAME', 'KXUCLGAME', 'KXATPMATCH', 'KXWTAMATCH', 'KXLOLGAME', 'KXCS2GAME'];
// the game series, plus each one's TOTAL and SPREAD siblings (KXBUNDESLIGAGAME → KXBUNDESLIGATOTAL, KXBUNDESLIGASPREAD)
async function fetchKalshiGameSeries(http) {
  const res = await http.get(KALSHI_SERIES_URL, { params: { category: 'Sports' }, timeout: 20000 });
  const list = res?.data?.series;
  if (!Array.isArray(list)) throw new Error('no series in the response');
  const tickers = [...new Set(list.map(x => String(x?.ticker || '').toUpperCase()).filter(Boolean))];
  const roots = new Set(tickers.filter(t => GAME_SERIES_RE.test(t)).map(t => t.replace(GAME_SERIES_RE, '')));
  return tickers.filter(t => GAME_SERIES_RE.test(t) || (LINE_SERIES_RE.test(t) && roots.has(t.replace(LINE_SERIES_RE, ''))));
}
function createKalshiGameSweep({ http, perScan = 40, quietSlots = 5, refreshMs = 6 * 3600e3, retryMs = 10 * 60e3, keepMs = 30 * 60e3,
  seeds = SEED_GAME_SERIES, now = () => Date.now() } = {}) {
  let series = [...seeds], nextList = 0;
  const cache = new Map();      // series → { rows, at }: its open games' rows
  const readAt = new Map();     // series → last read (ms)
  const stats = { series: series.length, listed: 'built-in', reads: 0, failed: 0, rows: 0, lastError: null };
  async function refreshList(t) {
    if (t < nextList) return;
    try {
      const listed = await fetchKalshiGameSeries(http);
      series = [...new Set([...listed, ...seeds])];
      stats.listed = 'kalshi';
      nextList = t + refreshMs;
    } catch (e) {
      stats.lastError = `series list: ${e?.message || e}`;
      nextList = t + retryMs;
    }
    stats.series = series.length;
  }
  // → every cached game row (this scan's reads plus the ones still fresh)
  async function step() {
    const t = now();
    await refreshList(t);
    const due = [...series].sort((a, b) => (readAt.get(a) ?? -1) - (readAt.get(b) ?? -1));
    const busy = due.filter(x => cache.has(x)), quiet = due.filter(x => !cache.has(x));
    const q = Math.min(quietSlots, quiet.length);
    const pick = [...busy.slice(0, perScan - q), ...quiet.slice(0, q)];
    for (const x of quiet.slice(q)) if (pick.length < perScan) pick.push(x);
    await Promise.all(pick.map(async x => {
      const rows = [];
      const r = await fetchKalshiEvents(http, { seriesTicker: x, maxPages: 5, onPage: page => rows.push(...parseKalshiBinaries(page)) });
      readAt.set(x, t);
      if (r.errors.length) { stats.failed++; stats.lastError = `${x}: ${r.errors[0].message}`; return; }   // its old rows stand until keepMs
      stats.reads++;
      if (rows.length) cache.set(x, { rows, at: t }); else cache.delete(x);
    }));
    const out = [];
    for (const [x, c] of cache) { if (t - c.at > keepMs) cache.delete(x); else out.push(...c.rows); }
    stats.rows = out.length;
    return out;
  }
  return { step, stats: () => ({ ...stats, withGames: cache.size }) };
}

// One full scan: fetch both exchanges, parse, find every arb.
async function scanExchanges(http, { games = [], kalshiMaxPages, polymarketMaxPages, ...opts } = {}) {
  const o = withDefaults(opts);
  const kalshi = [], polymarket = [];
  const [k, p] = await Promise.all([
    fetchKalshiEvents(http, { maxPages: kalshiMaxPages, onPage: page => kalshi.push(...parseKalshiBinaries(page)) }),
    fetchPolymarketEvents(http, { maxPages: polymarketMaxPages, onPage: page => polymarket.push(...parsePolymarketBinaries(page)) }),
  ]);
  const arbs = findArbs({ kalshi, polymarket, games }, o);
  return {
    arbs, errors: [...k.errors, ...p.errors], updated: new Date(o.now).toISOString(),
    counts: { kalshiEvents: k.count, polymarketEvents: p.count, kalshiMarkets: kalshi.length, polymarketMarkets: polymarket.length, arbs: arbs.length,
      kalshiTruncated: k.truncated, polymarketTruncated: p.truncated },
  };
}

module.exports = {
  parseKalshiBinaries, parsePolymarketBinaries, normalizeCategory, titleKey, titleSimilarity, matchMarkets,
  findCrossArbs, findUnderrounds, findUsArbs, findBookArbs, findArbs, stakeArb, fetchKalshiEvents, fetchPolymarketEvents, scanExchanges,
  fetchKalshiGameSeries, createKalshiGameSweep, kalshiTickerTime, nameMatch, SEED_GAME_SERIES, KALSHI_SERIES_URL,
  polymarketFeeSchedule, polymarketFee, isUsVenue, usPlaceable, venueIndex, venueQuotes, pickVenue, regionFromEnv,
  optsFromEnv, DEFAULTS, RULES_WARNING, COVER_WARNING, NOT_EXHAUSTIVE_WARNING, KALSHI_EVENTS_URL, POLYMARKET_EVENTS_URL, KALSHI_FEE_LOT,
};
