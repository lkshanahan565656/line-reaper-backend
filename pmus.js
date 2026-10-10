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
// Taker fee: 0.0695 × p(1 − p) a contract (fees.md, from 2026-10-07).
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
const fee = p => (inUnit(p) ? round(FEE_RATE * p * (1 - p), 6) : 0);

// a Polymarket US market's kind from its sportsMarketType (or marketType)
function kindOf(m) {
  const t = norm(m?.sportsMarketType);
  if (/full_game_winner$/.test(t)) return 'moneyline';
  if (/full_game_spread$/.test(t)) return 'spread';
  if (/full_game_total$/.test(t)) return 'total';
  return null;
}

// one market → { slug, kind, line, long, short, bid, ask, open, question } | null.
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

function createPolymarketUs({ http, now = () => Date.now(), eventTtlMs = 60e3, bookTtlMs = 10e3, maxEvents = 500, log = console } = {}) {
  const events = new Map(), books = new Map();
  const health = { lookups: 0, matched: 0, quoted: 0, errors: [] };
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
      key: 'polymarketus', name: 'Polymarket US', price, fee: fee(price), cost: round(price + fee(price), 6),
      side: hit.side, pick, buy: pick, marketId: hit.market.slug, title: hit.market.question, url: eventUrl(ev), match: 'slug',
      ...(depth != null ? { depth } : {}),
    };
  }

  const state = () => ({ ...health, events: events.size, errors: health.errors.slice(-5) });
  return { quoteFor, event, book, state };
}

function enabledFromEnv(env = process.env) {
  return !/^(off|0|false|no)$/i.test(String(env.POLYMARKET_US || '').trim());
}

module.exports = {
  GATEWAY, FEE_RATE, kindOf, parseMarket, parseEvent, parseBook, betOf, matchBet, buyPrice, pickOf, usSlugOf, fee,
  createPolymarketUs, enabledFromEnv,
};
