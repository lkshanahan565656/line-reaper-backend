// ─── POLYMARKET US ────────────────────────────────────────────────────────────
// Where a US follower can tail a Polymarket International game bet on the
// same market. Polymarket US (a CFTC-regulated exchange) lists the same games
// under the same event slug ("nfl-cle-nyj-2026-10-11"), and its public gateway
// needs no key (20 requests/s an IP for public endpoints).
//
//   GET /v1/events/slug/{eventSlug}      the game and every market in it
//   GET /v1/markets/{marketSlug}/book    that market's live book
//
// A market's book is its LONG side's: buy long at the best offer, buy the
// short side at 1 − the best bid (the event's bestBidQuote / bestAskQuote are
// the same two prices, from a snapshot; a side's `price` there is not a buy
// price). Full-game markets, told apart by sportsMarketType (the docs say not
// to parse slugs):
//
//   …full_game_winner   moneyline: each side is a team (team.ordering away/home)
//   …full_game_spread   one market a line, all with the same long team; the
//                       line is signed from the long team's side ("cover −1.5")
//   …full_game_total    long = Over; the line is unsigned
//
// A Polymarket International bet becomes a team to win, a team at a signed
// line (−17.5: win by 18 or more; +17.5: lose by 17 or less, or win), or
// Over/Under a line, and is matched to the market and side asking exactly
// that. Soccer's three-way markets and every other kind are left out.
//
// Taker fee: the market's feeCoefficient × p(1 − p) a contract (0.0695 on
// every market seen, and in fees.md from 2026-10-07).
//
// Parsers and matchers are pure; createPolymarketUs caches events (a minute)
// and books (10 s) over an axios-style `http`.

const { nameMatch } = require('./xarb');
const { teamMatches } = require('./exchanges');

const GATEWAY = 'https://gateway.polymarket.us';
const SITE = 'https://polymarket.us';
const FEE_RATE = 0.0695;
const TIMEOUT = 4000;
const EPS = 1e-9;

const num = v => (v == null || v === '' || typeof v === 'boolean' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const round = (x, n) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** n) / 10 ** n);
const norm = s => String(s || '').trim().toLowerCase();
const amount = v => num(v && typeof v === 'object' ? v.value : v);   // { value, currency } or a bare number
const inUnit = p => (p > 0 && p < 1 ? p : null);
// taker fee a contract at p: the market's own feeCoefficient when it gives one
const fee = (p, rate = FEE_RATE) => (inUnit(p) ? round((rate ?? FEE_RATE) * p * (1 - p), 6) : 0);

// a Polymarket US market's kind from its sportsMarketType: "football_team_
// full_game_total" is the game's total, "football_team_points_full_game_total"
// one team's points (left out, like halves and quarters)
const KIND_RE = /^[a-z]+_team_full_game_(winner|spread|total)$/;
const KINDS = { winner: 'moneyline', spread: 'spread', total: 'total' };
function kindOf(m) {
  const k = KIND_RE.exec(norm(m?.sportsMarketType))?.[1];
  return k ? KINDS[k] : null;
}

const feeRateOf = m => { const r = num(m?.feeCoefficient); return r != null && r >= 0 && r < 1 ? r : FEE_RATE; };
// one market → { slug, kind, line, long, short, bid, ask, open, question, feeRate } | null.
// long / short: { team, aliases } for teams, { over: bool } for totals.
function parseMarket(m) {
  if (!m || typeof m !== 'object') return null;
  const kind = kindOf(m);
  const slug = m.slug || m.marketSlug || null;
  if (!kind || !slug) return null;
  const sides = Array.isArray(m.marketSides) ? m.marketSides : [];
  const longSide = sides.find(s => s?.long === true || s?.long === 'true');
  const shortSide = sides.find(s => s && s !== longSide && (s.long === false || s.long === 'false'));
  const team = s => {
    const t = s?.team;
    const names = [t?.name, s?.description, t?.alias, t?.abbreviation].filter(x => x && typeof x === 'string');
    return names.length ? { team: names[0], aliases: names } : null;
  };
  let long = null, short = null;
  if (kind === 'total') { long = { over: true }; short = { over: false }; }
  else { long = team(longSide); short = team(shortSide); if (!long || !short) return null; }
  const status = norm(m.status);
  return {
    slug, kind, line: num(m.line), long, short, question: m.question || m.title || '',
    feeRate: feeRateOf(m),
    bid: inUnit(amount(m.bestBidQuote)), ask: inUnit(amount(m.bestAskQuote)),
    open: m.closed !== true && m.closed !== 'true' && m.active !== false && (!status || status === 'market_status_open'),
  };
}

// GET /v1/events/slug payload → { slug, title, league, markets } | null
function parseEvent(payload) {
  const e = payload?.event || payload;
  if (!e || typeof e !== 'object' || !e.slug) return null;
  const markets = (Array.isArray(e.markets) ? e.markets : []).map(parseMarket).filter(Boolean);
  return { slug: e.slug, title: e.title || '', league: String(e.slug).split('-')[0] || null, markets };
}

// GET /v1/markets/{slug}/book payload → { bid, ask, bidSize, askSize, open } | null
function parseBook(payload) {
  const d = payload?.marketData || payload;
  if (!d || typeof d !== 'object' || (!Array.isArray(d.bids) && !Array.isArray(d.offers))) return null;
  const px = l => amount(l?.px ?? l?.price);
  const bids = (d.bids || []).filter(l => inUnit(px(l))).sort((a, b) => px(b) - px(a));
  const offers = (d.offers || d.asks || []).filter(l => inUnit(px(l))).sort((a, b) => px(a) - px(b));
  const state = norm(d.state);
  return {
    bid: bids.length ? px(bids[0]) : null, ask: offers.length ? px(offers[0]) : null,
    bidSize: bids.length ? num(bids[0].qty) : null, askSize: offers.length ? num(offers[0].qty) : null,
    open: !state || state === 'market_state_open',
  };
}

// ── what the Polymarket bet was ──
const TOTAL_RE = /(?:^|:\s*)o\/u\s+(\d+(?:\.\d+)?)\s*$/i;
const SPREAD_RE = /^spread:\s*(.+?)\s*\(([+-]\d+(?:\.\d+)?)\)\s*$/i;
const NOT_TEAM = /^(yes|no|over|under|draw|tie)$/i;
// a signal (market question, outcome, outcomes, sportsMarketType, line) →
// { kind: 'moneyline', team, teams } | { kind: 'spread', team, line, teams }
// (line signed from that team's side) | { kind: 'total', over, line } | null
function betOf(s) {
  if (!s) return null;
  const q = String(s.market || s.question || '').trim(), type = norm(s.sportsMarketType);
  const outcome = String(s.outcome || '').trim();
  const outcomes = (Array.isArray(s.outcomes) ? s.outcomes : []).map(String);
  if (type === 'totals' || (!type && TOTAL_RE.test(q))) {
    const t = q.match(TOTAL_RE);
    const line = Math.abs(num(s.line) ?? num(t?.[1]) ?? NaN);
    if (!Number.isFinite(line) || !/^(over|under)$/i.test(outcome)) return null;
    return { kind: 'total', over: /^over$/i.test(outcome), line };
  }
  if (type === 'spreads' || (!type && SPREAD_RE.test(q))) {
    const sp = q.match(SPREAD_RE);
    const named = sp?.[1], signed = num(s.line) ?? num(sp?.[2]);
    if (!named || signed == null || outcomes.length !== 2 || !outcome) return null;
    const i = outcomes.findIndex(o => norm(o) === norm(named));
    const j = outcomes.findIndex(o => norm(o) === norm(outcome));
    if (i < 0 || j < 0) return null;
    return { kind: 'spread', team: outcomes[j], line: j === i ? signed : -signed, teams: outcomes };
  }
  // a two-team game: "A vs. B", outcomes are the teams
  const moneyline = type === 'moneyline' || (!type && / vs\.? /i.test(q) && !/:/.test(q));
  if (moneyline && outcomes.length === 2 && outcomes.every(o => o && !NOT_TEAM.test(o)) && outcomes.some(o => norm(o) === norm(outcome))) {
    return { kind: 'moneyline', team: outcomes.find(o => norm(o) === norm(outcome)), teams: outcomes };
  }
  return null;
}

// does a Polymarket team name (say "Browns", "Utah State") name this side?
const sameTeam = (name, side) => (side?.aliases || []).some(a => norm(a) === norm(name) || nameMatch(name, a) || teamMatches(name, a) || teamMatches(a, name));
// both of the bet's teams pair with the market's long and short sides one way
// round only → the side the bet's team is on, else null
function sideOf(bet, m) {
  const [a, b] = bet.teams || [];
  if (!a || !b) return null;
  const direct = sameTeam(a, m.long) && sameTeam(b, m.short);
  const swap = sameTeam(a, m.short) && sameTeam(b, m.long);
  if (direct === swap) return null;
  const longTeam = direct ? a : b;
  return norm(bet.team) === norm(longTeam) ? 'long' : 'short';
}

// event × bet → { market, side: 'long' | 'short' } | null: the open market
// asking exactly that (the same line; a spread from whichever team is long)
function matchBet(event, bet) {
  if (!event || !bet) return null;
  for (const m of event.markets) {
    if (!m.open || m.kind !== bet.kind) continue;
    if (bet.kind === 'total') {
      if (m.line != null && Math.abs(Math.abs(m.line) - bet.line) < EPS) return { market: m, side: bet.over ? 'long' : 'short' };
      continue;
    }
    const side = sideOf(bet, m);
    if (!side) continue;
    if (bet.kind === 'moneyline') return { market: m, side };
    if (m.line != null && Math.abs((side === 'long' ? m.line : -m.line) - bet.line) < EPS) return { market: m, side };
  }
  return null;
}

// the price to buy a side from a { bid, ask } of the long side's book
const buyPrice = (q, side) => inUnit(side === 'long' ? q?.ask : q?.bid != null ? round(1 - q.bid, 6) : null);
// "Browns", "BYU -17.5", "Over 45.5": what to buy
function pickOf(m, side) {
  const s = side === 'long' ? m.long : m.short;
  if (m.kind === 'total') return `${s.over ? 'Over' : 'Under'} ${Math.abs(m.line)}`;
  if (m.kind === 'spread') { const l = side === 'long' ? m.line : -m.line; return `${s.team} ${l > 0 ? '+' : ''}${l}`; }
  return s.team;
}
const eventUrl = event => (event?.league ? `${SITE}/sports/${event.league}/${event.slug}` : null);

// event slug for a Polymarket International signal: a soccer game's spreads
// and totals sit in "<slug>-more-markets"
const usSlugOf = s => (s?.eventSlug ? String(s.eventSlug).replace(/-more-markets$/, '') : null);

// ── Polymarket US's games as arb rows ──
// GET /v2/leagues/{league}/events (type sport, 50 a page) lists a league's
// games with every market and its snapshot quotes. Each full-game market
// becomes a row shaped like xarb.parsePolymarketBinaries' Polymarket rows
// (YES first), so Kalshi's games pair with them the way they pair with
// Polymarket's (xarb.matchMarkets):
//   winner   → kind 'teams': YES = the long team
//   total    → kind 'total': YES = Over, the long side
//   spread   → kind 'spread': YES = the team giving points (lineTeam): the
//              long team when its line is negative, else the short team
//   soccer's full-time result (a YES/NO market each for team A, the draw
//   and team B) → kind 'yesno' with game3 { teams, pick }, one event of
//   three outcomes (mutuallyExclusive: buying all three YES is an arb when
//   they add up to under $1)
// Half lines only, as on Kalshi. A row remembers which side its YES is
// (yesSide), so the live book can re-price it (repriceRow).
const ARB_LEAGUES = ['nfl', 'cfb', 'nba', 'nhl', 'mlb', 'wnba', 'cbb', 'wcbb', 'mls', 'epl', 'ucl', 'uefa', 'lal', 'bun', 'sea', 'fl1', 'lol', 'cs2', 'valorant', 'cod'];
const XARB_LEAGUE = { nfl: 'nfl', cfb: 'ncaaf', nba: 'nba', nhl: 'nhl', mlb: 'mlb', wnba: 'wnba', cbb: 'ncaab', mls: 'mls' };
const RULES_NOTE = 'a postponed or canceled game settles by each exchange\'s own rules';
const RESULT_RE = /^soccer_team_full_time_winner$/;
const halfLine = x => Number.isFinite(x) && x > 0 && Math.abs(((x * 2) % 2) - 1) < 1e-9;
const other = side => (side === 'long' ? 'short' : 'long');
const isoOf = v => { const t = Date.parse(v || ''); return Number.isFinite(t) && t > 0 ? new Date(t).toISOString() : null; };

function arbRowsOf(payload, { league = null } = {}) {
  const e = payload?.event || payload;
  const ev = parseEvent(e);
  if (!ev || e.closed === true || e.active === false || e.ended === true) return [];
  const raw = Array.isArray(e.markets) ? e.markets : [];
  const start = isoOf(e.startTime) || isoOf(raw.find(m => m?.gameStartTime)?.gameStartTime) || isoOf(e.startDate);
  const base = {
    exchange: 'polymarketus', eventKey: `polymarketus:${ev.slug}`, eventTitle: ev.title, gameSlug: ev.slug, startTime: start,
    closeTime: isoOf(e.endDate), category: 'sports', league: XARB_LEAGUE[league || ev.league] ?? null, url: eventUrl(ev),
    liquidity: null, volume: null, rules: null, gameNo: null, hasDraw: false, eventDecided: false, eventComplete: true,
    mutuallyExclusive: false, warnings: [RULES_NOTE],
  };
  const priced = (m, yesSide) => ({ yesSide, yesAsk: buyPrice(m, yesSide), noAsk: buyPrice(m, other(yesSide)), tradable: m.open, feeSchedule: { rate: m.feeRate, exponent: 1 } });
  const out = [];
  for (const m of ev.markets) {
    if (!m.open) continue;
    const row = { ...base, id: m.slug, title: m.question };
    if (m.kind === 'moneyline') out.push({ ...row, kind: 'teams', outcomeLabel: m.long.team, noLabel: m.short.team, ...priced(m, 'long') });
    else if (m.kind === 'total' && halfLine(Math.abs(m.line))) {
      out.push({ ...row, kind: 'total', line: Math.abs(m.line), outcomeLabel: 'Over', noLabel: 'Under', ...priced(m, 'long') });
    } else if (m.kind === 'spread' && halfLine(Math.abs(m.line))) {
      const giver = m.line < 0 ? 'long' : 'short';
      const team = (giver === 'long' ? m.long : m.short).team, them = (giver === 'long' ? m.short : m.long).team;
      out.push({ ...row, kind: 'spread', line: Math.abs(m.line), lineTeam: team, outcomeLabel: team, noLabel: them, ...priced(m, giver) });
    }
  }
  // soccer: team A, the draw, team B
  const result = raw.filter(m => RESULT_RE.test(norm(m?.sportsMarketType)) && m.slug);
  const teams = (Array.isArray(e.teams) ? e.teams : []).map(t => t?.name).filter(Boolean);
  if (result.length === 3 && teams.length === 2) {
    const rows = [];
    for (const m of result) {
      const longSide = (m.marketSides || []).find(x => x?.long === true || x?.long === 'true');
      const name = longSide?.team?.name;
      const pick = name ? teams.indexOf(name) : 'draw';
      const q = { bid: inUnit(amount(m.bestBidQuote)), ask: inUnit(amount(m.bestAskQuote)), feeRate: feeRateOf(m) };
      const open = m.closed !== true && m.active !== false && (!m.status || norm(m.status) === 'market_status_open');
      if (pick === -1 || !open) break;
      rows.push({ ...base, id: m.slug, title: m.question || '', kind: 'yesno', outcomeLabel: name || 'Draw', noLabel: null,
        game3: { teams, pick }, mutuallyExclusive: true, ...priced({ ...q, open }, 'long') });
    }
    if (rows.length === 3 && new Set(rows.map(r => r.game3.pick)).size === 3) out.push(...rows);
  }
  return out;
}

// a row re-priced on its market's live book (the long side's), with what
// sits at each price (yesDepth / noDepth); null when that book isn't open
function repriceRow(row, book) {
  if (!row || !book || !book.open) return null;
  const yes = row.yesSide, no = other(yes);
  const depth = side => (side === 'long' ? book.askSize : book.bidSize);
  return { ...row, yesAsk: buyPrice(book, yes), noAsk: buyPrice(book, no), yesDepth: depth(yes), noDepth: depth(no), priced: 'book' };
}

function createPolymarketUs({ http, now = () => Date.now(), eventTtlMs = 60e3, bookTtlMs = 10e3, maxEvents = 500, log = console } = {}) {
  const events = new Map(), books = new Map();
  const health = { lookups: 0, matched: 0, quoted: 0, errors: [], arbs: { scans: 0, rows: 0, games: {}, confirmed: 0, skipped: 0 } };
  const warn = msg => { health.errors.push({ at: new Date(now()).toISOString(), message: String(msg) }); health.errors = health.errors.slice(-10); log?.warn?.(`Polymarket US: ${msg}`); };
  const cached = (map, key, ttl) => { const hit = map.get(key); return hit && now() - hit.at < ttl ? hit : null; };
  const keep = (map, key, value) => { map.delete(key); map.set(key, { at: now(), value }); while (map.size > maxEvents) map.delete(map.keys().next().value); return value; };

  // a missing event (404) is remembered like a found one: most games aren't listed
  async function event(slug) {
    const hit = cached(events, slug, eventTtlMs);
    if (hit) return hit.value;
    try {
      const res = await http.get(`${GATEWAY}/v1/events/slug/${encodeURIComponent(slug)}`, { timeout: TIMEOUT });
      return keep(events, slug, parseEvent(res?.data));
    } catch (e) {
      if (e?.response?.status === 404) return keep(events, slug, null);
      warn(`event ${slug}: ${e?.message || e}`);
      return null;
    }
  }
  async function book(slug) {
    const hit = cached(books, slug, bookTtlMs);
    if (hit) return hit.value;
    try {
      const res = await http.get(`${GATEWAY}/v1/markets/${encodeURIComponent(slug)}/book`, { timeout: TIMEOUT });
      return keep(books, slug, parseBook(res?.data));
    } catch (e) { warn(`book ${slug}: ${e?.message || e}`); return null; }
  }

  // signal → a venue quote ({ key, name, price, fee, cost, side, pick, buy,
  // marketId, title, url, depth }) for the same bet on Polymarket US, or null
  async function quoteFor(signal) {
    const bet = betOf(signal), slug = usSlugOf(signal);
    if (!bet || !slug) return null;
    health.lookups++;
    const ev = await event(slug);
    const hit = matchBet(ev, bet);
    if (!hit) return null;
    health.matched++;
    const b = await book(hit.market.slug);
    if (b && !b.open) return null;
    // the live book when it answers, else the event's snapshot
    const price = buyPrice(b && (b.bid != null || b.ask != null) ? b : hit.market, hit.side);
    if (price == null) return null;
    health.quoted++;
    const pick = pickOf(hit.market, hit.side);
    const depth = b ? (hit.side === 'long' ? b.askSize : b.bidSize) : null;
    return {
      key: 'polymarketus', name: 'Polymarket US', price, fee: fee(price, hit.market.feeRate), cost: round(price + fee(price, hit.market.feeRate), 6),
      side: hit.side, pick, buy: pick, marketId: hit.market.slug, title: hit.market.question, url: eventUrl(ev), match: 'slug',
      ...(depth != null ? { depth } : {}),
    };
  }

  // Every game the leagues list, as arb rows (arbRowsOf), each league read
  // once a scan (at most maxPages pages of 50); the leagues side by side
  async function arbRows({ leagues = ARB_LEAGUES, maxPages = 6 } = {}) {
    const read = async league => {
      const rows = [];
      let n = 0;
      try {
        for (let page = 0; page < maxPages; page++) {
          const res = await http.get(`${GATEWAY}/v2/leagues/${encodeURIComponent(league)}/events`, { params: { limit: 50, offset: page * 50 }, timeout: TIMEOUT });
          const list = Array.isArray(res?.data?.events) ? res.data.events : [];
          for (const e of list) { const r = arbRowsOf(e, { league }); if (r.length) { rows.push(...r); n++; } }
          if (list.length < 50) break;
        }
      } catch (e) { if (e?.response?.status !== 404) warn(`league ${league}: ${e?.message || e}`); }
      return { league, rows, n };
    };
    const done = await Promise.all(leagues.map(read));
    const rows = done.flatMap(d => d.rows);
    const games = Object.fromEntries(done.filter(d => d.n).map(d => [d.league, d.n]));
    Object.assign(health.arbs, { scans: health.arbs.scans + 1, rows: rows.length, games });
    return rows;
  }
  // rows re-priced on their live books (at most maxBooks reads) → Map id →
  // row, or null when its book is closed or can't be read
  async function reprice(rows, { maxBooks = 40 } = {}) {
    const ids = [...new Map(rows.map(r => [r.id, r])).values()];
    const take = ids.slice(0, Math.max(0, maxBooks));
    health.arbs.skipped += ids.length - take.length;
    const live = await Promise.all(take.map(async r => repriceRow(r, await book(r.id))));
    health.arbs.confirmed += live.filter(Boolean).length;
    return new Map(take.map((r, i) => [r.id, live[i]]));
  }

  const state = () => ({ ...health, events: events.size, errors: health.errors.slice(-5) });
  return { quoteFor, event, book, arbRows, reprice, state };
}

function enabledFromEnv(env = process.env) {
  return !/^(off|0|false|no)$/i.test(String(env.POLYMARKET_US || '').trim());
}
// XARB_PMUS_LEAGUES: the Polymarket US leagues the arb scan reads (comma
// list of its league slugs; unset = ARB_LEAGUES, off = none)
function arbLeaguesFromEnv(env = process.env) {
  const v = String(env.XARB_PMUS_LEAGUES || '').trim().toLowerCase();
  if (!v) return ARB_LEAGUES;
  if (/^(off|0|false|no|none)$/.test(v)) return [];
  return [...new Set(v.split(/[\s,]+/).filter(x => /^[a-z0-9-]+$/.test(x)))];
}

module.exports = {
  GATEWAY, FEE_RATE, ARB_LEAGUES, kindOf, parseMarket, parseEvent, parseBook, betOf, matchBet, buyPrice, pickOf, usSlugOf, fee, arbRowsOf, repriceRow,
  createPolymarketUs, enabledFromEnv, arbLeaguesFromEnv,
};
