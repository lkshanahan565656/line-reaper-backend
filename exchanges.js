// ─── EXCHANGES ────────────────────────────────────────────────────────────────
// Prediction-market exchanges (Kalshi, Polymarket) list game winners as $1
// contracts. Buying YES at the ask is a moneyline bet: pay ask + fee, collect
// $1 if it wins, so decimal odds = 1 / (ask + fee). Their prices often sit away
// from the sportsbooks, so we turn them into ordinary `bookmakers` entries on
// the odds-feed games and let the +EV screener score them like any other book.
//
//   1. parse each exchange's market list into rows: one row per team contract
//      { exchange, id, eventId, title, team, yesAsk, ..., start, url },
//   2. match an exchange event to a feed game when both of its teams match the
//      game's teams (exchanges label teams "Boston", "BOS", "Los Angeles L")
//      and the start times are close,
//   3. emit an h2h bookmaker only when both teams got a price.
//
// Everything is pure except the two fetch wrappers, which take an axios-style
// `http` so they can be tested without the network.

const { decimalToAmerican } = require('./ev');

const KALSHI_URL = 'https://api.elections.kalshi.com/trade-api/v2/markets';
const POLYMARKET_URL = 'https://gamma-api.polymarket.com/events';
const KALSHI_SERIES = ['KXNBAGAME', 'KXNFLGAME', 'KXMLBGAME', 'KXNHLGAME', 'KXNCAAFGAME'];
const POLYMARKET_TAGS = ['nba', 'nfl', 'mlb', 'nhl'];

// ── fees and prices ──
// Kalshi taker fee is charged per order and rounded UP to the cent.
function kalshiFee(price, contracts = 1, rate = 0.07) {
  const p = Number(price);
  if (!(p > 0 && p < 1) || !(contracts > 0)) return 0;
  // the epsilon keeps float noise (0.0175000001) from adding a cent
  return Math.max(0, Math.ceil(rate * contracts * p * (1 - p) * 100 - 1e-9) / 100);
}

function effectiveAmerican(askDollars, feePerContract = 0) {
  const ask = Number(askDollars);
  if (!(ask > 0 && ask < 1)) return null;
  const cost = ask + (Number(feePerContract) || 0);
  if (!(cost < 1)) return null;
  return decimalToAmerican(1 / cost);
}

const num = v => (v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);

// ── Kalshi ──
// Newer responses carry `yes_ask_dollars: "0.5600"`; older ones integer cents.
function kalshiPrice(m, field) {
  const d = num(m[`${field}_dollars`]);
  if (d != null) return d;
  const c = num(m[field]);
  return c == null ? null : c / 100;
}

// "KXNHLGAME-25OCT08BOSTOR-BOS" → 'nhl'. Rows carry their league so a
// Bruins–Leafs market can't attach to a Celtics–Raptors game.
const KALSHI_LEAGUE_RE = /KX(NCAAF|NCAAB|WNBA|NBA|NFL|MLB|NHL|MLS)/i;
function kalshiLeague(...tickers) {
  for (const t of tickers) {
    const m = String(t || '').match(KALSHI_LEAGUE_RE);
    if (m) return m[1].toLowerCase();
  }
  return null;
}

function parseKalshiMarkets(payload, seriesTicker = null) {
  const out = [];
  for (const m of payload?.markets || []) {
    if (!['open', 'active'].includes(String(m.status || '').toLowerCase()) || !m.yes_sub_title) continue;
    out.push({
      exchange: 'kalshi', id: m.ticker, eventId: m.event_ticker, title: m.title || '',
      league: kalshiLeague(m.series_ticker, m.event_ticker, m.ticker, seriesTicker),
      team: m.yes_sub_title,
      yesAsk: kalshiPrice(m, 'yes_ask'), noAsk: kalshiPrice(m, 'no_ask'),
      yesBid: kalshiPrice(m, 'yes_bid'), noBid: kalshiPrice(m, 'no_bid'),
      start: m.expected_expiration_time || m.close_time || null,
      volume: num(m.volume),
      url: `https://kalshi.com/markets/${String(m.event_ticker || '').toLowerCase()}`,
    });
  }
  return out;
}

// ── Polymarket ──
const jsonList = v => {
  if (Array.isArray(v)) return v;
  try { const x = JSON.parse(v); return Array.isArray(x) ? x : null; } catch { return null; }
};
const NOT_TEAMS = new Set(['yes', 'no', 'over', 'under', 'draw', 'tie']);

// tagSlug: the tag the events were fetched with ('nba', 'nhl', ...) → row.league
// Gamma's prices for a market can sit weeks behind its order book (seen live
// on a market Gamma last updated a month before): a market Gamma hasn't
// touched for this long has no price worth showing.
const GAMMA_STALE_MS = 3600e3;
const gammaStale = (m, now) => { const u = Date.parse(m?.updatedAt); return Number.isFinite(u) && now - u > GAMMA_STALE_MS; };

function parsePolymarketEvents(payload, tagSlug = null, now = Date.now()) {
  const league = tagSlug ? String(tagSlug).toLowerCase() : null;
  const events = Array.isArray(payload) ? payload : payload?.events || payload?.data || [];
  const out = [];
  for (const ev of events) {
    for (const m of ev.markets || []) {
      if (m.active === false || m.closed === true || gammaStale(m, now)) continue;
      if (m.sportsMarketType != null && m.sportsMarketType !== 'moneyline') continue;
      const outcomes = jsonList(m.outcomes);
      if (!outcomes || outcomes.length !== 2 || outcomes.some(o => NOT_TEAMS.has(String(o).trim().toLowerCase()))) continue;
      // without a market type, a spread ("Celtics (-5.5)") also has team outcomes
      if (m.sportsMarketType == null && /spread|\(\s*[+-]?\d|o\/u|total/i.test(m.question || '')) continue;
      const mids = (jsonList(m.outcomePrices) || []).map(num);
      // bestAsk/bestBid quote the FIRST outcome; buying the second = selling the first
      const ask0 = num(m.bestAsk), bid0 = num(m.bestBid);
      const asks = [ask0 ?? mids[0] ?? null, bid0 != null ? round(1 - bid0, 6) : mids[1] ?? null];
      outcomes.forEach((team, i) => out.push({
        exchange: 'polymarket', id: `${m.id}:${i}`, eventId: ev.id, title: ev.title || '', league,
        team, yesAsk: asks[i], start: m.gameStartTime || ev.startDate || null,
        volume: num(m.volume), url: `https://polymarket.com/event/${ev.slug}`,
      }));
    }
  }
  return out;
}

// ── team names ──
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, ' ').trim();

const TWO_WORD_NICKNAMES = new Set(['red sox', 'white sox', 'blue jays', 'maple leafs', 'golden knights', 'trail blazers', 'blue jackets', 'red wings']);
const NICK_ALIASES = { sixers: '76ers', niners: '49ers', blazers: 'trail blazers', dbacks: 'diamondbacks', 'd backs': 'diamondbacks', habs: 'canadiens' };
const CITY_ALIASES = { okc: 'oklahoma city', nola: 'new orleans', philly: 'philadelphia', vegas: 'las vegas' };
// Two teams share these cities, so the city alone names nobody.
const AMBIGUOUS_CITIES = new Set(['los angeles', 'new york', 'la', 'ny']);

const ABBR = {
  nba: {
    ATL: 'Atlanta Hawks', BOS: 'Boston Celtics', BKN: 'Brooklyn Nets', BRK: 'Brooklyn Nets', CHA: 'Charlotte Hornets',
    CHI: 'Chicago Bulls', CLE: 'Cleveland Cavaliers', DAL: 'Dallas Mavericks', DEN: 'Denver Nuggets', DET: 'Detroit Pistons',
    GSW: 'Golden State Warriors', GS: 'Golden State Warriors', HOU: 'Houston Rockets', IND: 'Indiana Pacers',
    LAC: 'Los Angeles Clippers', LAL: 'Los Angeles Lakers', MEM: 'Memphis Grizzlies', MIA: 'Miami Heat', MIL: 'Milwaukee Bucks',
    MIN: 'Minnesota Timberwolves', NOP: 'New Orleans Pelicans', NO: 'New Orleans Pelicans', NYK: 'New York Knicks',
    OKC: 'Oklahoma City Thunder', ORL: 'Orlando Magic', PHI: 'Philadelphia 76ers', PHX: 'Phoenix Suns', PHO: 'Phoenix Suns',
    POR: 'Portland Trail Blazers', SAC: 'Sacramento Kings', SAS: 'San Antonio Spurs', SA: 'San Antonio Spurs',
    TOR: 'Toronto Raptors', UTA: 'Utah Jazz', WAS: 'Washington Wizards', WSH: 'Washington Wizards',
  },
  nfl: {
    ARI: 'Arizona Cardinals', ATL: 'Atlanta Falcons', BAL: 'Baltimore Ravens', BUF: 'Buffalo Bills', CAR: 'Carolina Panthers',
    CHI: 'Chicago Bears', CIN: 'Cincinnati Bengals', CLE: 'Cleveland Browns', DAL: 'Dallas Cowboys', DEN: 'Denver Broncos',
    DET: 'Detroit Lions', GB: 'Green Bay Packers', HOU: 'Houston Texans', IND: 'Indianapolis Colts', JAX: 'Jacksonville Jaguars',
    JAC: 'Jacksonville Jaguars', KC: 'Kansas City Chiefs', LV: 'Las Vegas Raiders', LAC: 'Los Angeles Chargers',
    LAR: 'Los Angeles Rams', MIA: 'Miami Dolphins', MIN: 'Minnesota Vikings', NE: 'New England Patriots',
    NO: 'New Orleans Saints', NYG: 'New York Giants', NYJ: 'New York Jets', PHI: 'Philadelphia Eagles',
    PIT: 'Pittsburgh Steelers', SEA: 'Seattle Seahawks', SF: 'San Francisco 49ers', TB: 'Tampa Bay Buccaneers',
    TEN: 'Tennessee Titans', WAS: 'Washington Commanders', WSH: 'Washington Commanders',
  },
  mlb: {
    ARI: 'Arizona Diamondbacks', AZ: 'Arizona Diamondbacks', ATL: 'Atlanta Braves', BAL: 'Baltimore Orioles', BOS: 'Boston Red Sox',
    CHC: 'Chicago Cubs', CWS: 'Chicago White Sox', CHW: 'Chicago White Sox', CIN: 'Cincinnati Reds', CLE: 'Cleveland Guardians',
    COL: 'Colorado Rockies', DET: 'Detroit Tigers', HOU: 'Houston Astros', KC: 'Kansas City Royals', LAA: 'Los Angeles Angels',
    LAD: 'Los Angeles Dodgers', MIA: 'Miami Marlins', MIL: 'Milwaukee Brewers', MIN: 'Minnesota Twins', NYM: 'New York Mets',
    NYY: 'New York Yankees', ATH: 'Athletics', OAK: 'Athletics', PHI: 'Philadelphia Phillies', PIT: 'Pittsburgh Pirates',
    SD: 'San Diego Padres', SF: 'San Francisco Giants', SEA: 'Seattle Mariners', STL: 'St. Louis Cardinals', TB: 'Tampa Bay Rays',
    TEX: 'Texas Rangers', TOR: 'Toronto Blue Jays', WSH: 'Washington Nationals', WAS: 'Washington Nationals',
  },
  nhl: {
    ANA: 'Anaheim Ducks', BOS: 'Boston Bruins', BUF: 'Buffalo Sabres', CGY: 'Calgary Flames', CAR: 'Carolina Hurricanes',
    CHI: 'Chicago Blackhawks', COL: 'Colorado Avalanche', CBJ: 'Columbus Blue Jackets', DAL: 'Dallas Stars', DET: 'Detroit Red Wings',
    EDM: 'Edmonton Oilers', FLA: 'Florida Panthers', LAK: 'Los Angeles Kings', MIN: 'Minnesota Wild', MTL: 'Montreal Canadiens',
    NSH: 'Nashville Predators', NJD: 'New Jersey Devils', NYI: 'New York Islanders', NYR: 'New York Rangers', OTT: 'Ottawa Senators',
    PHI: 'Philadelphia Flyers', PIT: 'Pittsburgh Penguins', SJS: 'San Jose Sharks', SEA: 'Seattle Kraken', STL: 'St Louis Blues',
    TBL: 'Tampa Bay Lightning', TOR: 'Toronto Maple Leafs', UTA: 'Utah Mammoth', VAN: 'Vancouver Canucks', VGK: 'Vegas Golden Knights',
    WSH: 'Washington Capitals', WPG: 'Winnipeg Jets',
  },
};
// abbreviation → normalized full names; codes repeat across leagues (BOS)
const ABBR_INDEX = new Map();
for (const league of Object.values(ABBR)) {
  for (const [code, full] of Object.entries(league)) {
    const k = code.toLowerCase();
    if (!ABBR_INDEX.has(k)) ABBR_INDEX.set(k, new Set());
    ABBR_INDEX.get(k).add(norm(full));
  }
}

function splitName(full) {
  const words = norm(full).split(' ').filter(Boolean);
  const two = words.slice(-2).join(' ');
  const nick = words.length > 2 && TWO_WORD_NICKNAMES.has(two) ? two : words[words.length - 1] || '';
  const city = words.slice(0, words.length - nick.split(' ').length).join(' ');
  return { full: words.join(' '), nick, city };
}
const initials = s => s.split(' ').filter(Boolean).map(w => w[0]).join('');
// "la" for Los Angeles, "okc" for Oklahoma City, "st louis" for St. Louis
const cityMatches = (label, city) => !!city && (label === city || label === initials(city) || CITY_ALIASES[label] === city);

function teamMatches(exchangeTeam, fullName) {
  let label = norm(exchangeTeam);
  const { full, nick, city } = splitName(fullName);
  if (!label || !full) return false;
  if (label === full) return true;
  for (const [alias, real] of Object.entries(NICK_ALIASES)) {
    if ((label === alias || label.endsWith(` ${alias}`)) && !label.endsWith(real)) label = label.slice(0, label.length - alias.length) + real;
  }
  if (ABBR_INDEX.get(label)?.has(full)) return true;
  if (label === nick) return true;
  // "Sox" alone could be either Sox; other two-word nicknames are known by their last word
  const last = nick.split(' ').pop();
  if (nick.includes(' ') && last !== 'sox' && label === last) return true;
  // "LA Lakers", "NY Knicks": whatever precedes the nickname has to be the city
  if (label.endsWith(` ${nick}`)) return cityMatches(label.slice(0, -nick.length - 1), city);
  if (cityMatches(label, city)) return !AMBIGUOUS_CITIES.has(label) && !AMBIGUOUS_CITIES.has(city);
  // "Los Angeles L", "New York K", "Chicago WS": city plus the nickname's initial(s)
  const sp = label.lastIndexOf(' ');
  if (sp > 0) {
    const tail = label.slice(sp + 1);
    if (cityMatches(label.slice(0, sp), city) && (tail === nick[0] || tail === initials(nick))) return true;
  }
  return false;
}

// Exchange labels [a, b] → which game team each names. Both must land, on
// different teams, and only one way round.
function assign(labels, home, away) {
  const [a, b] = labels;
  const direct = teamMatches(a, home) && teamMatches(b, away);
  const swap = teamMatches(a, away) && teamMatches(b, home);
  if (direct === swap) return null;
  return direct ? { [home]: a, [away]: b } : { [home]: b, [away]: a };
}

// "Boston at New York K Winner?" → ['Boston', 'New York K']
function titleTeams(title) {
  const parts = String(title || '').replace(/\s*(winner|to win)\??\s*$/i, '').split(/\s+(?:at|vs\.?|v\.?|@)\s+/i);
  return parts.length === 2 ? parts.map(s => s.trim()) : null;
}

// ── attach to games ──
// Rows of one tradable pair: a Kalshi event, or a single Polymarket market.
function pairsOf(rows) {
  const pairs = new Map();
  for (const r of rows || []) {
    const key = r.exchange === 'polymarket' ? `pm|${String(r.id).split(':')[0]}` : `${r.exchange}|${r.eventId}`;
    if (!pairs.has(key)) pairs.set(key, []);
    pairs.get(key).push(r);
  }
  return [...pairs.values()];
}

// owner(r) → the game team a row's YES contract is on, or null
function priceFor(rows, name, owner, opts) {
  const own = rows.find(r => owner(r) === name);
  if (rows[0].exchange === 'kalshi') {
    if (own?.yesAsk != null) {
      const p = effectiveAmerican(own.yesAsk, kalshiFee(own.yesAsk, 1, opts.kalshiFeeRate));
      if (p != null) return { price: p, link: own.url };
    }
    // NO on the other team is the same bet
    const other = rows.find(r => owner(r) && owner(r) !== name && r.noAsk != null);
    if (!other) return null;
    const p = effectiveAmerican(other.noAsk, kalshiFee(other.noAsk, 1, opts.kalshiFeeRate));
    return p == null ? null : { price: p, link: other.url };
  }
  if (!own || own.yesAsk == null) return null;
  const p = effectiveAmerican(own.yesAsk, opts.polymarketFeeRate * own.yesAsk);
  return p == null ? null : { price: p, link: own.url };
}

const TITLES = { kalshi: 'Kalshi', polymarket: 'Polymarket' };

// league: the feed's league ('nba', 'nhl', ...). Rows tagged with a different
// league are skipped; untagged rows are still considered.
function attachExchanges(games, exchangeRows, { now = Date.now(), maxStartGapMs = 12 * 3600e3, kalshiFeeRate = 0.07, polymarketFeeRate = 0, league = null } = {}) {
  const opts = { kalshiFeeRate, polymarketFeeRate };
  const want = league ? String(league).toLowerCase() : null;
  const pairs = pairsOf(exchangeRows).filter(rows => !want || !rows[0].league || rows[0].league === want);
  return (games || []).map(g => {
    const out = { ...g, bookmakers: [...(g.bookmakers || [])] };
    const t0 = g.commence_time ? Date.parse(g.commence_time) : NaN;
    if (Number.isFinite(t0) && t0 <= now) return out;
    // per exchange, the matching event whose start is closest to the game's
    const best = new Map();
    for (const rows of pairs) {
      const ex = rows[0].exchange;
      const start = rows.find(r => r.start)?.start;
      const t1 = start ? Date.parse(start) : NaN;
      const gap = Number.isFinite(t0) && Number.isFinite(t1) ? Math.abs(t1 - t0) : Infinity;
      if (gap !== Infinity && gap > maxStartGapMs) continue;
      if (best.has(ex) && best.get(ex).gap <= gap) continue;
      const teams = [...new Set(rows.map(r => r.team))];
      const labels = teams.length === 2 ? teams : titleTeams(rows[0].title);
      const map = labels && assign(labels, g.home_team, g.away_team);
      if (!map) continue;
      const sides = [g.home_team, g.away_team];
      // a lone Kalshi row was paired via the title; find its side by its own label
      const owner = r => {
        const hit = sides.find(n => map[n] === r.team);
        if (hit) return hit;
        const hits = sides.filter(n => teamMatches(r.team, n));
        return hits.length === 1 ? hits[0] : null;
      };
      const outcomes = sides.map(name => {
        const px = priceFor(rows, name, owner, opts);
        return px && { name, price: px.price, link: px.link };
      });
      if (outcomes.some(o => !o)) continue;
      best.set(ex, { gap, bookmaker: { key: ex, title: TITLES[ex] || ex, markets: [{ key: 'h2h', outcomes }] } });
    }
    for (const { bookmaker } of best.values()) out.bookmakers.push(bookmaker);
    return out;
  });
}

const toMarketsList = rows => (rows || []).map(({ exchange, title, team, yesAsk, start, url }) => ({ exchange, title, team, yesAsk, start, url }));

// ── fetching ──
async function collect(exchange, keys, load) {
  const rows = [], errors = [];
  await Promise.all(keys.map(async key => {
    try { rows.push(...await load(key)); } catch (e) { errors.push({ exchange, key, message: e?.message || String(e) }); }
  }));
  return { rows, errors };
}

function fetchKalshi(http, { seriesTickers = KALSHI_SERIES } = {}) {
  return collect('kalshi', seriesTickers, async series_ticker => {
    const res = await http.get(KALSHI_URL, { params: { status: 'open', series_ticker, limit: 200 }, timeout: 10000 });
    return parseKalshiMarkets(res.data, series_ticker);
  });
}

function fetchPolymarket(http, { tags = POLYMARKET_TAGS } = {}) {
  return collect('polymarket', tags, async tag_slug => {
    const res = await http.get(POLYMARKET_URL, { params: { tag_slug, closed: false, limit: 100 }, timeout: 10000 });
    return parsePolymarketEvents(res.data, tag_slug);
  });
}

const round = (x, n) => Math.round(x * 10 ** n) / 10 ** n;

module.exports = { gammaStale, GAMMA_STALE_MS,
  kalshiFee, effectiveAmerican, parseKalshiMarkets, kalshiLeague, parsePolymarketEvents, teamMatches,
  attachExchanges, toMarketsList, fetchKalshi, fetchPolymarket,
  KALSHI_SERIES, POLYMARKET_TAGS,
};
