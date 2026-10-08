// ─── SHARP TAIL ───────────────────────────────────────────────────────────────
// Polymarket trades settle on-chain, so every bet has a wallet behind it and
// every wallet has a public history. This module decides which wallets have a
// real, provable edge and turns their new bets into sized "tail" signals.
//
// Scoring one wallet from its resolved positions (closed ones, plus open ones
// that resolved but were never redeemed, so hidden losers still count):
//   risked   avgPrice × totalBought (dollars in); pnl = realizedPnl
//   ROI      (Σpnl + open P&L) / (Σrisked + open risked). Positions still
//            open are marked to market, so selling the winners early and
//            sitting on the losers doesn't look like skill.
//   luck     a position is a binary bet of stake s at price p. If p was the
//            fair price its expected profit is 0 with sd s·√((1 − p)/p).
//            Bets in one event (an election's state markets, every market on
//            one game) are one bet: their sds add before squaring. z =
//            Σpnl / √Σ(event sd)² is how many standard deviations of pure luck
//            the profit would take. z ≥ 3 is very hard to luck into.
//   concentration  the biggest event's share of all winnings, or of one day's
//            markets in one category (election night), whichever is larger.
//            One longshot or one lucky night can make a great ROI and z alone.
//   two-sided  share of markets where the wallet held BOTH outcomes. Market
//            makers and hedgers earn the spread, not predictions (> 30% out).
//   forward  bets resolved after the wallet was picked (leaderboards surface
//            the lucky too). Once there are 30, losing money there ungrades it.
//   edge     shrunk: P&L / (risked + $20k of zero-edge prior) × 0.5, so a
//            small sample can't claim a big edge and past ROI is discounted.
//   grades   A (elite) / B (sharp) from sample, distinct events, money risked,
//            ROI, z, concentration, two-sided share and recent activity. Also
//            per category: elections skill says nothing about the NBA.
//
// Sizing a tail when a graded wallet BUYs at p and we can buy now at c:
//   q     our estimate of the true probability: the edge is an ROI at the
//         wallet's average price, carried to p as a shift in the odds (a 95¢
//         favourite can't return more than 5%), at most 0.99
//   Kelly = (q − c) / (1 − c)           at OUR price, not theirs
//   units = ¼ Kelly × 100 (1u = 1% of bankroll), capped 2u (A) / 1u (B),
//           × 1.5 (so up to 3u for A, 1.5u for B) when 2+ graded wallets
//           bought that side within 24h.
//   c more than 3¢ above p, or Kelly ≤ 0 → 0u: the price ran, don't chase.
//   A wallet buying more of what it already bought tops the tail up to the new
//   size; it isn't a second full-size bet.
//
// ROI, edge, Kelly and shares are fractions (0.08 = 8%); prices are dollars
// per share (0–1). Times on returned objects are ISO strings.
//
// Pure scoring and parsing, fetchers that take an axios-style `http`, and one
// engine (createTailEngine) that keeps candidates, scores, seen trades and
// signals in memory so a few crons can drive it.

const DATA_API = 'https://data-api.polymarket.com';
const GAMMA_API = 'https://gamma-api.polymarket.com';
const LEADERBOARD_CATEGORIES = ['OVERALL', 'POLITICS', 'SPORTS', 'CRYPTO', 'CULTURE', 'ECONOMICS', 'TECH', 'FINANCE'];
const LEADERBOARD_PERIODS = ['DAY', 'WEEK', 'MONTH', 'ALL'];
const CATEGORIES = ['sports', 'politics', 'crypto', 'econ', 'culture', 'other'];
const DAY = 86400e3;
const EPS = 1e-9;   // thresholds like 0.08 must survive float noise

const DEFAULTS = {
  priorRisk: 20000,              // $ of zero-edge betting mixed into the edge estimate
  regression: 0.5,               // then halved: past ROI overstates future ROI
  maxTwoSided: 0.3,              // above this share of two-sided markets = market maker
  recentDays: 30,                // "recent form" window
  catBadMinN: 20,                // a losing category this big blocks the overall grade there
  minTrade: 500,                 // $ notional for a trade to matter (TAIL_MIN_TRADE)
  minCloseMs: 15 * 60e3,         // skip markets resolving sooner than this
  maxTradeAgeMs: 60 * 60e3,      // older trades are history, not signals
  chaseMax: 0.03,                // current price more than this above their fill → 0u
  kellyFraction: 0.25,
  bankrollUnits: 100,            // 1 unit = 1% of bankroll
  maxProb: 0.99,
  consensusMin: 2,               // distinct graded wallets on the same side...
  consensusWindowMs: 24 * 3600e3, // ...within this window
  consensusMult: 1.5,
  maxUnits: 3,
  forwardMinN: 30,               // bets resolved since the wallet was picked before they count
  batchSize: 3,                  // wallets scored per scoreBatch call
  rescoreMs: 12 * 3600e3,
  retryMs: 30 * 60e3,            // after a failed fetch
  tradeCandidateMin: 5000,       // $ for one trade to queue an unknown wallet (or 2 trades over minTrade)
  maxCandidates: 50000,          // memory caps: trade-sourced wallets stop being queued...
  maxTraders: 20000,             // ...and the oldest untailable scores are forgotten
  closedPageSize: 50,            // the data API's largest closed-positions page
  closedMaxPages: 10,
  walletTradeLimit: 500,
  watchPerPoll: 2,               // graded wallets whose own trades each poll also reads
  quoteTtlMs: 20e3,
  maxSignals: 500,
  grades: {
    A: { label: 'elite', minN: 100, minEvents: 30, minRisked: 50000, minRoi: 0.08, minZ: 3, maxConcentration: 0.35, activeDays: 30, minRecentRoi: -0.10, capUnits: 2 },
    B: { label: 'sharp', minN: 50, minEvents: 15, minRisked: 20000, minRoi: 0.04, minZ: 2, maxConcentration: 0.4, activeDays: 45, minRecentRoi: null, capUnits: 1 },
  },
};
const GRADES = ['A', 'B'];

function resolveOptions(opts = {}) {
  const o = { ...DEFAULTS, ...opts, grades: {} };
  for (const g of GRADES) o.grades[g] = { ...DEFAULTS.grades[g], ...(opts.grades?.[g] || {}) };
  return o;
}

// TAIL_PRIOR_RISK, TAIL_MIN_TRADE, TAIL_A_MIN_Z, TAIL_B_MAX_CONCENTRATION, ...:
// every numeric default, snake-cased. Percent keys take 8 or 0.08 (so 1 is
// 1%), TAIL_CHASE_MAX takes cents or dollars (1 is 1¢), and the factors
// (regression, Kelly fraction, max probability) take 0.25 or 25 (1 is 1.0).
const PERCENT_KEYS = new Set(['maxTwoSided', 'minRoi', 'minRecentRoi', 'maxConcentration', 'chaseMax']);
const FACTOR_KEYS = new Set(['regression', 'kellyFraction', 'maxProb']);
const snake = k => k.replace(/[A-Z]/g, c => `_${c}`).toUpperCase();
function optionsFromEnv(env = process.env) {
  const read = (name, key) => {
    if (env[name] == null || String(env[name]).trim() === '') return undefined;
    let v = Number(env[name]);
    if (!Number.isFinite(v)) return undefined;
    if (PERCENT_KEYS.has(key) && Math.abs(v) >= 1) v /= 100;
    else if (FACTOR_KEYS.has(key) && Math.abs(v) > 1) v /= 100;
    return v;
  };
  const out = { grades: { A: {}, B: {} } };
  for (const key of Object.keys(DEFAULTS)) {
    if (key === 'grades') continue;
    const v = read(`TAIL_${snake(key)}`, key);
    if (v !== undefined) out[key] = v;
  }
  for (const g of GRADES) {
    for (const key of Object.keys(DEFAULTS.grades[g])) {
      if (key === 'label') continue;
      const v = read(`TAIL_${g}_${snake(key)}`, key);
      if (v !== undefined) out.grades[g][key] = v;
    }
  }
  return out;
}

// ── small helpers ──
const num = v => (v == null || v === '' || typeof v === 'boolean' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const round = (x, n) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** n) / 10 ** n);
const lower = v => (v == null ? '' : String(v).trim().toLowerCase());
const bool = v => v === true || v === 'true';
const iso = ms => (ms == null || !Number.isFinite(ms) ? null : new Date(ms).toISOString());
const jsonList = v => {
  if (Array.isArray(v)) return v;
  try { const x = JSON.parse(v); return Array.isArray(x) ? x : null; } catch { return null; }
};
// arrays come bare or wrapped, depending on the endpoint and its age
const ROW_KEYS = ['data', 'positions', 'trades', 'leaderboard', 'markets', 'results'];
function rowsOf(payload) {
  if (Array.isArray(payload)) return payload;
  for (const k of ROW_KEYS) if (Array.isArray(payload?.[k])) return payload[k];
  return [];
}
// Fetchers: a 200 that isn't a list (an error object, an HTML page) is a
// failure, not "no rows" (that would wipe a wallet's record on a glitch).
function rowsOrThrow(payload, what) {
  if (Array.isArray(payload)) return payload;
  for (const k of ROW_KEYS) if (Array.isArray(payload?.[k])) return payload[k];
  throw new Error(`${what}: unexpected response (${payload === null ? 'null' : typeof payload})`);
}
// wallets and condition ids out of messages anyone can read (/api/status)
const maskIds = s => String(s).replace(/0x[0-9a-f]{8,}/gi, '0x…');
// unix seconds, unix ms or an ISO string → ms
function toMs(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (Number.isFinite(n)) return n <= 0 ? null : n > 1e12 ? n : n * 1000;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}
const money = x => `${x < 0 ? '-' : ''}$${String(Math.round(Math.abs(x))).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
const pct = (x, d = 1) => `${round(x * 100, d)}%`;
// enough decimals that a near miss doesn't print as the threshold itself
function vs(x, limit, d = 1, scale = 1) {
  let k = d;
  while (k < 4 && round(x * scale, k) === round(limit * scale, k)) k++;
  return round(x * scale, k);
}
const eventUrl = slug => (slug ? `https://polymarket.com/event/${slug}` : null);
const profileUrl = wallet => `https://polymarket.com/profile/${wallet}`;

// ── categories ──
// Whole-word keyword votes; a phrase weighs its word count so "game awards"
// beats "game". Sources are tried in order (tags/category, then the title,
// then the slugs) and the first that says anything wins.
const KEYWORDS = {
  sports: [
    'sports', 'sport', 'nba', 'wnba', 'nfl', 'mlb', 'nhl', 'mls', 'ncaa', 'ncaaf', 'ncaab', 'cfb', 'cbb', 'epl', 'efl', 'uefa', 'fifa', 'ucl',
    'premier league', 'champions league', 'europa league', 'la liga', 'laliga', 'serie a', 'bundesliga', 'ligue 1', 'copa america',
    'world cup', 'super bowl', 'stanley cup', 'world series', 'nba finals', 'march madness', 'final four', 'college football',
    'playoffs', 'playoff', 'ufc', 'mma', 'boxing', 'knockout', 'formula 1', 'f1', 'grand prix', 'nascar', 'indycar', 'pga', 'liv golf',
    'golf', 'the masters', 'ryder cup', 'tennis', 'wimbledon', 'us open', 'french open', 'australian open', 'roland garros', 'atp', 'wta',
    'cricket', 'ipl', 'rugby', 'olympics', 'olympic', 'esports', 'league of legends', 'lol', 'csgo', 'cs2', 'counter strike', 'dota', 'dota 2',
    'valorant', 'overwatch', 'mvp', 'heisman', 'cy young', 'ballon d or', 'touchdown', 'touchdowns', 'home run', 'home runs', 'quarterback',
    'passing yards', 'rushing yards', 'rebounds', 'spread', 'moneyline', 'over under', 'kentucky derby', 'tour de france',
    'celtics', 'knicks', 'lakers', 'clippers', 'warriors', 'nets', '76ers', 'sixers', 'raptors', 'bucks', 'cavaliers', 'cavs', 'pistons',
    'pacers', 'hornets', 'wizards', 'mavericks', 'mavs', 'rockets', 'grizzlies', 'pelicans', 'spurs', 'nuggets', 'timberwolves', 'blazers',
    'trail blazers', 'patriots', 'dolphins', 'ravens', 'steelers', 'bengals', 'browns', 'texans', 'colts', 'jaguars', 'titans', 'chiefs',
    'raiders', 'chargers', 'broncos', 'cowboys', 'eagles', 'commanders', 'packers', 'vikings', 'buccaneers', 'bucs', 'falcons', 'saints',
    '49ers', 'niners', 'seahawks', 'yankees', 'red sox', 'blue jays', 'orioles', 'white sox', 'astros', 'mariners', 'dodgers', 'padres',
    'diamondbacks', 'rockies', 'cubs', 'brewers', 'mets', 'phillies', 'braves', 'marlins', 'bruins', 'maple leafs', 'canadiens', 'sabres',
    'red wings', 'flyers', 'penguins', 'islanders', 'blue jackets', 'blackhawks', 'predators', 'oilers', 'canucks', 'kraken',
    'golden knights', 'real madrid', 'barcelona', 'man city', 'manchester city', 'manchester united', 'man united', 'arsenal', 'chelsea',
    'liverpool', 'tottenham', 'bayern', 'psg', 'juventus', 'inter milan', 'ac milan', 'napoli', 'atletico', 'dortmund',
  ],
  politics: [
    'politics', 'political', 'geopolitics', 'election', 'elections', 'elected', 'reelection', 're election', 'president', 'presidential',
    'presidency', 'senate', 'senator', 'congress', 'congressional', 'house of representatives', 'win the house', 'control the house',
    'speaker', 'governor', 'gubernatorial', 'mayor', 'mayoral', 'primary', 'primaries', 'caucus', 'nominee', 'nomination', 'democrat',
    'democrats', 'democratic', 'republican', 'republicans', 'gop', 'dnc', 'rnc', 'electoral college', 'popular vote', 'ballot', 'referendum',
    'impeach', 'impeached', 'impeachment', 'supreme court', 'scotus', 'white house', 'cabinet', 'secretary of state', 'executive order',
    'veto', 'filibuster', 'government shutdown', 'pardon', 'deportation', 'approval rating', 'polls', 'trump', 'biden', 'harris', 'kamala',
    'vance', 'obama', 'newsom', 'desantis', 'aoc', 'mamdani', 'cuomo', 'prime minister', 'parliament', 'parliamentary', 'chancellor',
    'minister', 'coalition', 'labour', 'tory', 'tories', 'general election', 'putin', 'zelensky', 'zelenskyy', 'netanyahu', 'xi jinping',
    'modi', 'macron', 'starmer', 'trudeau', 'carney', 'milei', 'erdogan', 'ukraine', 'russia', 'israel', 'gaza', 'hamas', 'hezbollah',
    'iran', 'ceasefire', 'nato', 'invasion', 'invade', 'sanctions',
  ],
  crypto: [
    'crypto', 'cryptocurrency', 'bitcoin', 'btc', 'ethereum', 'eth', 'ether', 'solana', 'sol', 'xrp', 'ripple', 'dogecoin', 'cardano',
    'bnb', 'binance', 'coinbase', 'stablecoin', 'usdt', 'usdc', 'tether', 'defi', 'nft', 'nfts', 'blockchain', 'memecoin', 'meme coin',
    'coin', 'token', 'tokens', 'airdrop', 'fdv', 'altcoin', 'satoshi', 'microstrategy', 'saylor', 'hyperliquid', 'pump fun', 'uniswap',
    'chainlink', 'litecoin', 'ltc', 'polkadot', 'avax', 'shib', 'pepe',
  ],
  econ: [
    'economics', 'economy', 'economic', 'business', 'finance', 'financial', 'fed', 'federal reserve', 'fomc', 'powell', 'interest rate',
    'interest rates', 'rate cut', 'rate cuts', 'cut rates', 'rate hike', 'bps', 'basis points', 'inflation', 'cpi', 'pce', 'gdp', 'recession',
    'unemployment', 'jobs report', 'nonfarm', 'payrolls', 'jobless claims', 'treasury', 'yield', 'yields', 's p 500', 'sp500', 'spx', 'nasdaq',
    'dow jones', 'stock', 'stocks', 'stock price', 'earnings', 'ipo', 'tariff', 'tariffs', 'trade deal', 'trade war', 'oil', 'crude',
    'wti', 'brent', 'gold', 'silver', 'ecb', 'bank of england', 'bank of japan', 'boj', 'debt ceiling', 'deficit', 'market cap',
    'largest company', 'nvidia', 'tesla', 'apple', 'microsoft', 'amazon', 'alphabet', 'mortgage rates', 'gas prices', 'bankruptcy', 'merger',
  ],
  culture: [
    'culture', 'pop culture', 'entertainment', 'music', 'movies', 'celebrities', 'awards', 'oscar', 'oscars', 'academy awards', 'best picture',
    'grammy', 'grammys', 'emmy', 'emmys', 'golden globe', 'golden globes', 'box office', 'opening weekend', 'rotten tomatoes', 'movie', 'film',
    'album', 'song', 'billboard', 'hot 100', 'spotify', 'taylor swift', 'kanye', 'drake', 'beyonce', 'kardashian', 'celebrity', 'mrbeast',
    'mr beast', 'youtube', 'tiktok', 'netflix', 'person of the year', 'eurovision', 'pope', 'papal', 'conclave', 'game awards', 'gta',
    'tweet', 'tweets', 'tweet count', 'jeopardy', 'bachelor', 'survivor', 'love island', 'big brother', 'halftime', 'met gala', 'engaged',
    'wedding', 'pregnant', 'divorce', 'snl', 'saturday night live',
  ],
};
const PHRASES = [];
for (const [cat, list] of Object.entries(KEYWORDS)) for (const k of list) PHRASES.push({ cat, phrase: ` ${k} `, weight: k.split(' ').length });
const TIE_ORDER = ['sports', 'crypto', 'econ', 'politics', 'culture'];
const VS_WEIGHT = 0.5;   // "A vs. B" is usually a game, but a name outweighs it

const normText = s => ` ${String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim()} `;

function scoreText(text) {
  const t = normText(text);
  if (t.trim() === '') return null;
  const score = {};
  for (const { cat, phrase, weight } of PHRASES) if (t.includes(phrase)) score[cat] = (score[cat] || 0) + weight;
  if (/ (vs|v) /.test(t)) score.sports = (score.sports || 0) + VS_WEIGHT;
  let best = null;
  for (const cat of TIE_ORDER) if ((score[cat] || 0) > 0 && (!best || score[cat] > score[best])) best = cat;
  return best;
}

const tagText = tags => (Array.isArray(tags) ? tags : jsonList(tags) || [])
  .map(t => (typeof t === 'string' ? t : [t?.label, t?.slug].filter(Boolean).join(' '))).join(' | ');

// input: a string, or anything with category / tags / title / question / slug / eventSlug / events
function classify(input) {
  if (input == null) return 'other';
  if (typeof input === 'string') return scoreText(input) || 'other';
  const ev = Array.isArray(input.events) ? input.events[0] : null;
  const sources = [
    [input.category, ev?.category, tagText(input.tags), tagText(ev?.tags)].filter(Boolean).join(' | '),
    [input.title, input.question, ev?.title].filter(Boolean).join(' | '),
    [input.eventSlug, input.slug, ev?.slug].filter(Boolean).join(' '),
  ];
  for (const s of sources) {
    const cat = scoreText(s);
    if (cat) return cat;
  }
  return 'other';
}

// ── parsing: data API ──
function parseClosedPositions(payload) {
  const out = [];
  for (const r of rowsOf(payload)) {
    const price = num(r.avgPrice), shares = num(r.totalBought), cur = num(r.curPrice);
    if (!(price > 0 && price < 1) || !(shares > 0)) continue;
    const pnl = num(r.realizedPnl) ?? (cur != null ? shares * (cur - price) : null);
    if (pnl == null) continue;
    out.push({
      wallet: lower(r.proxyWallet) || null, conditionId: r.conditionId || null, asset: r.asset != null ? String(r.asset) : null,
      outcome: r.outcome ?? null, outcomeIndex: num(r.outcomeIndex),
      title: r.title || '', slug: r.slug || '', eventSlug: r.eventSlug || '',
      price, risked: price * shares, pnl, won: cur != null ? cur >= 0.99 : pnl > 0,
      at: toMs(r.timestamp) ?? toMs(r.endDate), endAt: toMs(r.endDate), category: classify(r), source: 'closed',
    });
  }
  return out;
}

function parseOpenPositions(payload) {
  const out = [];
  for (const r of rowsOf(payload)) {
    if (!r?.conditionId && r?.asset == null) continue;
    out.push({
      wallet: lower(r.proxyWallet) || null, conditionId: r.conditionId || null, asset: r.asset != null ? String(r.asset) : null,
      outcome: r.outcome ?? null, outcomeIndex: num(r.outcomeIndex),
      title: r.title || '', slug: r.slug || '', eventSlug: r.eventSlug || '',
      size: num(r.size), price: num(r.avgPrice), curPrice: num(r.curPrice), totalBought: num(r.totalBought),
      initialValue: num(r.initialValue), currentValue: num(r.currentValue), cashPnl: num(r.cashPnl), realizedPnl: num(r.realizedPnl),
      redeemable: bool(r.redeemable), endDate: r.endDate || null, category: classify(r),
    });
  }
  return out;
}

// Open positions in markets that already resolved (redeemable at $1 or $0).
// Losers are rarely redeemed, so without these a wallet's record only grows.
// Their time is the market's scheduled end, which can be in the future for a
// market that resolved early: then it has no time (it isn't recent form).
const settledOpen = r => r.redeemable && r.curPrice != null && (r.curPrice >= 0.99 || r.curPrice <= 0.01);
function resolvedFromOpen(openRows, now = Date.now()) {
  const out = [];
  for (const r of openRows || []) {
    if (!settledOpen(r)) continue;
    const cur = r.curPrice;
    const shares = r.totalBought ?? r.size;
    if (!(r.price > 0 && r.price < 1) || !(shares > 0) || !(r.size >= 0)) continue;
    const settle = cur >= 0.99 ? 1 : 0;
    const pnl = (r.cashPnl ?? r.size * (settle - r.price)) + (r.realizedPnl ?? 0);
    const end = toMs(r.endDate);
    out.push({
      wallet: r.wallet, conditionId: r.conditionId, asset: r.asset, outcome: r.outcome, outcomeIndex: r.outcomeIndex,
      title: r.title, slug: r.slug, eventSlug: r.eventSlug,
      price: r.price, risked: r.price * shares, pnl, won: settle === 1,
      at: end != null && end <= now ? end : null, endAt: end, category: r.category, source: 'open',
    });
  }
  return out;
}

// A position still open, at today's price: the dollars in, and the profit so
// far (any part already sold plus the unrealized rest). null if unpriced.
function markOpen(r) {
  const shares = r.totalBought ?? r.size;
  const risked = r.price > 0 && shares > 0 ? r.price * shares : r.initialValue;
  if (!(risked > 0)) return null;
  const unreal = r.cashPnl
    ?? (r.currentValue != null && r.initialValue != null ? r.currentValue - r.initialValue
      : r.curPrice != null && r.size != null && r.price != null ? r.size * (r.curPrice - r.price) : null);
  if (unreal == null) return null;
  return { risked, pnl: unreal + (r.realizedPnl ?? 0) };
}

// Trades come back one row per fill; fills of one order share a transaction
// hash, so rows with the same key are merged (size summed, price averaged).
// Also accepts already-parsed trades.
const tradeKey = (txHash, asset, wallet) => `${txHash}:${asset}:${wallet}`;
function parseTrades(payload) {
  const byKey = new Map();
  for (const r of rowsOf(payload)) {
    const wallet = lower(r.proxyWallet ?? r.wallet);
    const side = String(r.side || '').toUpperCase();
    const size = num(r.size), price = num(r.price);
    const asset = r.asset != null ? String(r.asset) : null;
    if (!wallet || !asset || !(size > 0) || !(price > 0 && price < 1)) continue;
    const at = toMs(r.timestamp ?? r.at);
    const txHash = r.transactionHash || r.txHash || null;
    const key = txHash ? tradeKey(txHash, asset, wallet) : `${wallet}:${asset}:${at}:${side}:${size}:${price}`;
    const prev = byKey.get(key);
    if (prev) {
      if (prev.side !== side) continue;
      const notional = prev.notional + size * price;
      prev.size += size;
      prev.notional = notional;
      prev.price = round(notional / prev.size, 6);
      continue;
    }
    byKey.set(key, {
      key, wallet, side, asset, conditionId: r.conditionId || null, size, price, notional: size * price, at,
      title: r.title || '', slug: r.slug || '', eventSlug: r.eventSlug || '', outcome: r.outcome ?? null, outcomeIndex: num(r.outcomeIndex),
      name: r.name || r.pseudonym || null, txHash,
    });
  }
  return [...byKey.values()];
}

function parseLeaderboard(payload, source = null) {
  const out = [];
  for (const r of rowsOf(payload)) {
    const wallet = lower(r.proxyWallet || r.wallet || r.address || r.user);
    if (!wallet) continue;
    out.push({
      wallet, name: r.userName || r.username || r.name || r.pseudonym || null,
      pnl: num(r.pnl ?? r.amount), vol: num(r.vol ?? r.volume), rank: num(r.rank),
      xUsername: r.xUsername || null, verified: bool(r.verifiedBadge), profileImage: r.profileImage || null, source,
    });
  }
  return out;
}

// ── parsing: gamma markets ──
function parseGammaMarket(m) {
  if (!m || typeof m !== 'object') return null;
  const ev = Array.isArray(m.events) ? m.events[0] : null;
  return {
    id: m.id != null ? String(m.id) : null, conditionId: m.conditionId || null, question: m.question || '',
    slug: m.slug || '', eventSlug: ev?.slug || m.eventSlug || '', eventTitle: ev?.title || '',
    category: m.category || ev?.category || null, tags: m.tags || ev?.tags || null,
    outcomes: jsonList(m.outcomes) || [], prices: (jsonList(m.outcomePrices) || []).map(num),
    tokens: (jsonList(m.clobTokenIds) || []).map(String),
    bestBid: num(m.bestBid), bestAsk: num(m.bestAsk), lastTradePrice: num(m.lastTradePrice),
    endDate: m.endDate || m.endDateIso || null, gameStartTime: m.gameStartTime || null,
    active: m.active !== false && m.active !== 'false', closed: bool(m.closed), resolution: m.umaResolutionStatus || null,
    acceptingOrders: m.acceptingOrders == null ? null : bool(m.acceptingOrders),
    negRisk: bool(m.negRisk), volume: num(m.volume), liquidity: num(m.liquidity),
  };
}
const parseGammaMarkets = payload => rowsOf(payload).map(parseGammaMarket).filter(Boolean);

// which outcome a trade/position/signal is on: token id first, then index, then name
function outcomeIndexOf(market, ref = {}) {
  if (!market) return null;
  if (ref.asset != null) {
    const i = market.tokens.indexOf(String(ref.asset));
    if (i >= 0) return i;
  }
  const idx = num(ref.outcomeIndex);
  if (idx != null && idx >= 0 && (!market.outcomes.length || idx < market.outcomes.length)) return idx;
  if (ref.outcome != null) {
    const i = market.outcomes.findIndex(o => lower(o) === lower(ref.outcome));
    if (i >= 0) return i;
  }
  return null;
}

const inUnit = x => (x > 0 && x < 1 ? x : null);
// bestAsk/bestBid quote the FIRST outcome; buying the second = selling the
// first. No book on that side → null: a mid is not a price anyone can buy at.
function askFor(market, ref) {
  const i = outcomeIndexOf(market, ref);
  if (i == null) return null;
  if (i === 0) return inUnit(market.bestAsk);
  if (i === 1 && market.outcomes.length <= 2) return inUnit(market.bestBid) == null ? null : round(1 - market.bestBid, 6);
  return null;
}
// last traded price of that outcome (lastTradePrice quotes the first outcome)
function priceOf(market, ref) {
  const i = outcomeIndexOf(market, ref);
  if (i == null) return null;
  const last = inUnit(market.lastTradePrice);
  if (last != null && i === 0) return last;
  if (last != null && i === 1 && market.outcomes.length <= 2) return round(1 - last, 6);
  return inUnit(market.prices[i]);
}

// null while unresolved; { winner: i } or { void: true } once settled. With a
// UMA status only 'resolved' counts (closed while proposed or disputed can
// still flip); closed with no status needs the exact $1 / $0 (or 50/50) prices.
function resolutionOf(market) {
  if (!market) return null;
  const status = lower(market.resolution);
  if (status ? status !== 'resolved' : !market.closed) return null;
  const prices = market.prices.filter(p => p != null);
  if (!prices.length) return null;
  const tol = status ? 0.01 : 1e-9;
  const winner = market.prices.findIndex(p => p != null && p >= 1 - tol);
  if (winner >= 0) return { winner };
  if (prices.every(p => Math.abs(p - 1 / prices.length) < tol)) return { void: true };
  return null;
}

// ── scoring ──
// Market identity of a holding by each id it carries; a market is two-sided
// when any one id shows two different outcomes (ids are never mixed).
function twoSidedShare(holdings) {
  const markets = new Map();
  for (const h of holdings || []) {
    if (!h?.conditionId) continue;
    if (!markets.has(h.conditionId)) markets.set(h.conditionId, { assets: new Set(), idx: new Set(), names: new Set() });
    const m = markets.get(h.conditionId);
    if (h.asset != null) m.assets.add(String(h.asset));
    if (h.outcomeIndex != null) m.idx.add(h.outcomeIndex);
    if (h.outcome != null && h.outcome !== '') m.names.add(lower(h.outcome));
  }
  let two = 0;
  for (const m of markets.values()) if (m.assets.size > 1 || m.idx.size > 1 || m.names.size > 1) two++;
  return { markets: markets.size, twoSidedMarkets: two, share: markets.size ? two / markets.size : 0 };
}

// Bets on one event move together, and so can one day's markets in one
// category (every state on election night).
const eventOf = (p, i) => p.eventSlug || p.slug || p.conditionId || `#${i}`;
const dayOf = p => { const t = p.endAt ?? p.at; return t == null ? null : `${p.category || 'other'}|${new Date(t).toISOString().slice(0, 10)}`; };
// the biggest group's share of the groups that made money
function topShare(values) {
  let pos = 0, max = 0;
  for (const v of values) if (v > 0) { pos += v; max = Math.max(max, v); }
  return pos > 0 ? max / pos : null;
}

// Raw (unrounded) stats of a list of resolved positions; grading uses these.
// open: positions still open (marked to market into ROI and edge, not the
// luck test); since: when the wallet was picked (ms), for the forward record.
function walletStats(positions, { holdings = positions, open = [], since = null, now = Date.now(), opts = {} } = {}) {
  const o = resolveOptions(opts);
  const cut = now - o.recentDays * DAY;
  let risked = 0, pnl = 0, wins = 0, entrySum = 0, lastAt = null;
  let rRisk = 0, rPnl = 0, rN = 0, fRisk = 0, fPnl = 0, fN = 0;
  const events = new Map(), byDay = new Map(), days = new Set();
  positions.forEach((p, i) => {
    risked += p.risked;
    pnl += p.pnl;
    if (p.won) wins++;
    entrySum += p.price;
    const e = events.get(eventOf(p, i)) || { pnl: 0, sd: 0 };
    e.pnl += p.pnl;
    e.sd += p.risked * Math.sqrt((1 - p.price) / p.price);   // perfectly correlated inside an event
    events.set(eventOf(p, i), e);
    const d = dayOf(p);
    if (d) byDay.set(d, (byDay.get(d) || 0) + p.pnl);
    if (p.at != null) {
      days.add(new Date(p.at).toISOString().slice(0, 10));
      lastAt = Math.max(lastAt ?? 0, p.at);
      if (p.at >= cut) { rRisk += p.risked; rPnl += p.pnl; rN++; }
      if (since != null && p.at > since) { fRisk += p.risked; fPnl += p.pnl; fN++; }
    }
  });
  let varSum = 0;
  for (const e of events.values()) varSum += e.sd ** 2;
  const byEvent = topShare([...events.values()].map(e => e.pnl)), byDate = topShare(byDay.values());
  const concentration = byEvent == null ? byDate : byDate == null ? byEvent : Math.max(byEvent, byDate);
  let openPnl = 0, openRisked = 0;
  for (const r of open || []) {
    const m = markOpen(r);
    if (m) { openPnl += m.pnl; openRisked += m.risked; }
  }
  const allPnl = pnl + openPnl, allRisked = risked + openRisked;
  const n = positions.length;
  const two = twoSidedShare(holdings);
  return {
    n, events: events.size, risked, pnl, openPnl, openRisked, openN: (open || []).length,
    roi: allRisked > 0 ? allPnl / allRisked : null, resolvedRoi: risked > 0 ? pnl / risked : null,
    winRate: n ? wins / n : null, avgEntry: n ? entrySum / n : null,
    z: varSum > 0 ? pnl / Math.sqrt(varSum) : null,
    concentration, concentrationBy: concentration == null ? null : byDate != null && byDate > (byEvent ?? -1) ? 'day' : 'event',
    twoSided: two.share, markets: two.markets, activeDays: days.size, lastAt,
    recentN: rN, recentRoi: rRisk > 0 ? rPnl / rRisk : null,
    forwardN: since == null ? null : fN, forwardPnl: since == null ? null : fPnl, forwardRoi: fRisk > 0 ? fPnl / fRisk : null,
    edge: (allPnl / (allRisked + o.priorRisk)) * o.regression,
  };
}

function presentStats(s) {
  return {
    n: s.n, events: s.events, risked: round(s.risked, 2), pnl: round(s.pnl, 2), roi: round(s.roi, 4),
    openN: s.openN ?? 0, openRisked: round(s.openRisked ?? 0, 2), openPnl: round(s.openPnl ?? 0, 2), resolvedRoi: round(s.resolvedRoi, 4),
    winRate: round(s.winRate, 4), avgEntry: round(s.avgEntry, 4), z: round(s.z, 2), concentration: round(s.concentration, 4),
    concentrationBy: s.concentrationBy ?? null,
    twoSided: round(s.twoSided, 4), markets: s.markets, activeDays: s.activeDays, lastAt: iso(s.lastAt),
    recentN: s.recentN, recentRoi: round(s.recentRoi, 4),
    forwardN: s.forwardN ?? null, forwardRoi: round(s.forwardRoi, 4), edge: round(s.edge, 6),
  };
}

// One tier's checks → [{ code, text }] of what failed. `activeAt` (ms) is the
// wallet's last activity anywhere; defaults to the stats' own lastAt.
function checkTier(s, g, o, now) {
  const f = [];
  const fail = (code, text) => f.push({ code, text });
  if (!(s.n >= g.minN)) fail('n', `only ${s.n} resolved bets (need ${g.minN})`);
  if (!(s.events >= g.minEvents)) fail('events', `only ${s.events} distinct events (need ${g.minEvents})`);
  if (!(s.risked >= g.minRisked - EPS)) fail('risked', `only ${money(Math.floor(s.risked || 0))} risked (need ${money(g.minRisked)})`);
  if (!(s.roi != null && s.roi >= g.minRoi - EPS)) fail('roi', s.roi == null ? 'no ROI yet' : `ROI ${vs(s.roi, g.minRoi, 1, 100)}% (need ${pct(g.minRoi)})`);
  if (!(s.z != null && s.z >= g.minZ - EPS)) fail('z', s.z == null ? 'no luck test possible' : `z-score ${vs(s.z, g.minZ)}: profit could be luck (need ${g.minZ})`);
  if (!(s.concentration != null && s.concentration <= g.maxConcentration + EPS)) {
    const from = s.concentrationBy === 'day' ? "one day's markets" : 'one event';
    fail('concentration', s.concentration == null ? 'no winning bets' : `${vs(s.concentration, g.maxConcentration, 0, 100)}% of profit from ${from} (max ${pct(g.maxConcentration, 0)})`);
  }
  if (s.twoSided > o.maxTwoSided + EPS) fail('twoSided', `market maker: held both sides in ${vs(s.twoSided, o.maxTwoSided, 0, 100)}% of markets (max ${pct(o.maxTwoSided, 0)})`);
  // out of sample: the leaderboards that found it also pick out the lucky
  if (s.forwardN != null && s.forwardN >= o.forwardMinN && !(s.forwardPnl > 0)) {
    fail('forward', `lost money since it was picked: ROI ${pct(s.forwardRoi || 0)} over ${s.forwardN} bets`);
  }
  const at = s.activeAt ?? s.lastAt;
  if (at == null) fail('active', 'no dated bets');
  else if (now - at > g.activeDays * DAY + EPS) fail('active', `inactive ${Math.floor((now - at) / DAY)} days (need a bet in the last ${g.activeDays})`);
  if (g.minRecentRoi != null && s.recentRoi != null && s.recentRoi <= g.minRecentRoi + EPS) {
    fail('recentRoi', `last ${o.recentDays} days ROI ${pct(s.recentRoi)} (must be above ${pct(g.minRecentRoi)})`);
  }
  return f;
}

function gradeStats(s, opts = {}, now = Date.now()) {
  const o = resolveOptions(opts);
  const failA = checkTier(s, o.grades.A, o, now), failB = checkTier(s, o.grades.B, o, now);
  const grade = !failA.length ? 'A' : !failB.length ? 'B' : null;
  const notTailable = grade ? [] : failB;
  return {
    grade, label: grade ? o.grades[grade].label : null, marketMaker: s.twoSided > o.maxTwoSided + EPS,
    reasons: notTailable.map(x => x.text), failed: notTailable.map(x => x.code),
    whyNotA: grade === 'A' ? [] : failA.map(x => x.text), failedA: grade === 'A' ? [] : failA.map(x => x.code),
  };
}

// closed / open: raw data-API rows; trades: raw or parsed (they add activity
// times and two-sided evidence); selectedAt: when the wallet became a
// candidate (bets resolved after it are its forward record). opts may carry `now`.
function scoreWallet({ wallet, name = null, closed = [], open = [], trades = [], selectedAt = null } = {}, { now = Date.now(), ...opts } = {}) {
  const o = resolveOptions(opts);
  const since = toMs(selectedAt);
  const closedRows = parseClosedPositions(closed);
  const openRows = parseOpenPositions(open);
  const closedAssets = new Set(closedRows.map(p => p.asset).filter(Boolean));
  const fromOpen = resolvedFromOpen(openRows, now).filter(p => !p.asset || !closedAssets.has(p.asset));
  const resolved = [...closedRows, ...fromOpen];
  const stillOpen = openRows.filter(r => !settledOpen(r));
  const tradeRows = parseTrades(trades);
  const buys = tradeRows.filter(t => t.side === 'BUY').map(t => ({ ...t, category: classify(t) }));
  const holdings = [...resolved, ...openRows, ...buys];

  // activity is the wallet's own trades and closes, not a market's end date
  let lastAt = null;
  for (const x of [...closedRows, ...tradeRows]) if (x.at != null && x.at <= now) lastAt = Math.max(lastAt ?? 0, x.at);
  const overall = { ...walletStats(resolved, { holdings, open: stillOpen, since, now, opts: o }) };
  overall.lastAt = lastAt;
  const g = gradeStats(overall, o, now);

  const categories = {};
  for (const cat of CATEGORIES) {
    const list = resolved.filter(p => p.category === cat);
    if (!list.length) continue;
    const cs = walletStats(list, { holdings: holdings.filter(h => h.category === cat), open: stillOpen.filter(r => r.category === cat), since, now, opts: o });
    // a market maker is out everywhere; being active anywhere counts as active
    const cg = gradeStats({ ...cs, twoSided: Math.max(cs.twoSided, overall.twoSided), activeAt: lastAt }, o, now);
    categories[cat] = { ...presentStats(cs), grade: cg.grade, label: cg.label, reasons: cg.reasons, failed: cg.failed, whyNotA: cg.whyNotA, failedA: cg.failedA };
  }

  const w = lower(wallet);
  return {
    id: w, wallet: w, name: name || tradeRows.find(t => t.name)?.name || null, url: profileUrl(w),
    grade: g.grade, label: g.label, tailable: !!g.grade, marketMaker: g.marketMaker,
    reasons: g.reasons, failed: g.failed, whyNotA: g.whyNotA, failedA: g.failedA,
    ...presentStats(overall), categories,
    openPositions: stillOpen.length, openValue: round(stillOpen.reduce((a, r) => a + (r.currentValue || 0), 0), 2),
    selectedAt: iso(since), scoredAt: iso(now),
  };
}

// The grade and edge that apply to a trade in `category`: the category's own
// grade when it has one. Otherwise the overall grade, unless a real sample in
// that category shows no edge of its own (losing, or under B's ROI); and the
// edge is the overall one pulled toward what the category's own record shows
// (its P&L plus $20k of betting at the overall rate), never above the overall.
function gradeFor(trader, category, opts = {}) {
  const o = resolveOptions(opts);
  const c = trader?.categories?.[category];
  if (c?.grade) return { grade: c.grade, edge: c.edge, scope: 'category' };
  if (!trader?.grade) return { grade: null, skip: c ? `not graded in ${category}` : 'not graded' };
  if (c && c.n >= o.catBadMinN && !(c.pnl > 0 && c.roi != null && c.roi >= o.grades.B.minRoi - EPS)) {
    return { grade: null, skip: `no edge in ${category} (ROI ${pct(c.roi || 0)} over ${c.n} bets)` };
  }
  let edge = trader.edge;
  const risked = c ? (num(c.risked) ?? NaN) + (num(c.openRisked) ?? 0) : NaN;
  if (Number.isFinite(risked) && risked > 0 && o.regression > 0) {
    const rate = trader.edge / o.regression;
    const blended = (((num(c.pnl) ?? 0) + (num(c.openPnl) ?? 0) + o.priorRisk * rate) / (risked + o.priorRisk)) * o.regression;
    edge = Math.min(edge, blended);
  }
  if (!(edge > 0)) return { grade: null, skip: `no edge in ${category} (ROI ${pct(c?.roi || 0)} over ${c?.n || 0} bets)` };
  return { grade: trader.grade, edge, scope: 'overall' };
}

// ── signals ──
// Our probability for a buy at p by a wallet with this edge. The edge is an
// ROI at the wallet's usual prices (pivot: its average entry), so it is turned
// into the shift in odds that gives exactly that ROI at the pivot, and that
// shift is applied at p. At the pivot q = p × (1 + edge); a favourite gains
// far less (a 95¢ bet can't return more than 5%), a longshot a bit more.
function trueProb(p, edge, pivot = 0.5) {
  if (!(p > 0 && p < 1)) return null;
  const a = Math.min(0.95, Math.max(0.05, Number.isFinite(pivot) ? pivot : 0.5));
  const qa = Math.min(0.999, Math.max(0.001, a * (1 + (edge || 0))));
  const odds = ((qa / (1 - qa)) / (a / (1 - a))) * (p / (1 - p));
  return odds / (1 + odds);
}

// trade: a parsed trade; trader: a scoreWallet result; market: a parsed gamma
// market (null when the lookup failed); consensus: other graded wallets that
// bought the same outcome inside the window; prior: { id, units } when we
// already tailed this wallet into this outcome (then only the top-up up to
// the new size is staked). → { signal, skip }
function tradeSignal({ trade, trader, market = null, consensus = [], prior = null, now = Date.now(), opts = {} } = {}) {
  const o = resolveOptions(opts);
  const skip = reason => ({ signal: null, skip: reason });
  if (!trade || !trader) return skip('not graded');
  const category = classify(trade);
  const pick = gradeFor(trader, category, o);
  if (!pick.grade) return skip(pick.skip);
  if (!(trade.notional >= o.minTrade - EPS)) return skip(`under ${money(o.minTrade)}`);
  if (trade.at != null && now - trade.at > o.maxTradeAgeMs) return skip('stale trade');

  const eventSlug = trade.eventSlug || market?.eventSlug || trade.slug || null;
  const base = {
    id: trade.key, wallet: trader.wallet, name: trader.name || trade.name || null, grade: pick.grade, scope: pick.scope, category,
    market: trade.title || market?.question || '', eventSlug, conditionId: trade.conditionId, asset: trade.asset,
    outcome: trade.outcome, outcomeIndex: trade.outcomeIndex,
    theirPrice: trade.price, theirSize: round(trade.size, 4), theirNotional: round(trade.notional, 2),
    at: iso(trade.at ?? now), seenAt: iso(now), url: eventUrl(eventSlug),
  };
  if (trade.side === 'SELL') return { signal: { ...base, type: 'exit' }, skip: null };
  if (trade.side !== 'BUY') return skip('unknown side');
  if (market) {
    if (market.closed || !market.active) return skip('market closed');
    const end = toMs(market.endDate);
    if (end != null && end - now < o.minCloseMs) return skip(`market resolves within ${Math.round(o.minCloseMs / 60e3)} min`);
  }

  const p = trade.price, c = market ? askFor(market, trade) : null;
  const scoped = pick.scope === 'category' ? trader.categories?.[category] : trader;
  const q = Math.min(o.maxProb, trueProb(p, pick.edge, num(scoped?.avgEntry) ?? 0.5));
  const wallets = [...new Set([trader.wallet, ...(consensus || []).map(lower).filter(Boolean)])];
  const isConsensus = wallets.length >= o.consensusMin;
  const cap = o.grades[pick.grade].capUnits;
  let units = 0, kelly = null, reason = null, target = 0;
  if (c == null) reason = 'no live price: check it before following';
  else {
    kelly = (q - c) / (1 - c);
    if (c - p > o.chaseMax + EPS || kelly <= EPS) reason = "price ran, don't chase";
    else {
      units = Math.min(Math.max(o.kellyFraction * kelly * o.bankrollUnits, 0), cap);
      if (isConsensus) units = Math.min(units * o.consensusMult, o.maxUnits);
      units = target = round(units, 2);
      if (!(units > 0)) reason = 'edge too small to size';
    }
  }
  const before = num(prior?.units) > 0 ? num(prior.units) : 0;
  if (before > 0 && target > 0) {
    units = round(Math.max(0, target - before), 2);
    if (!(units > 0)) reason = `already tailed at ${before}u`;
  }
  return {
    signal: {
      ...base, type: 'entry', currentPrice: c, slippage: c == null ? null : round(c - p, 4), edge: round(pick.edge, 4),
      prob: round(q, 4), kelly: round(kelly, 4), units, target, cap: isConsensus ? Math.min(cap * o.consensusMult, o.maxUnits) : cap,
      parentId: before > 0 ? prior.id ?? null : null, topUp: before > 0,
      consensus: wallets, isConsensus, reason,
    },
    skip: null,
  };
}

// ── fetching ──
const TIMEOUT = 10000;

// categories × periods, deduped by wallet; one failing call doesn't sink the rest
async function fetchLeaderboard(http, { categories = LEADERBOARD_CATEGORIES, periods = LEADERBOARD_PERIODS, limit = 50 } = {}) {
  const byWallet = new Map(), errors = [];
  for (const category of categories) {
    for (const timePeriod of periods) {
      const key = `${category}:${timePeriod}`;
      try {
        const res = await http.get(`${DATA_API}/v1/leaderboard`, { params: { category, timePeriod, orderBy: 'PNL', limit }, timeout: TIMEOUT });
        for (const r of parseLeaderboard(rowsOrThrow(res.data, 'leaderboard'), key)) {
          const prev = byWallet.get(r.wallet);
          if (!prev) { byWallet.set(r.wallet, { ...r, sources: [key], source: undefined }); continue; }
          prev.sources.push(key);
          prev.name = prev.name || r.name;
          if (r.pnl != null && (prev.pnl == null || r.pnl > prev.pnl)) prev.pnl = r.pnl;
          if (r.vol != null && (prev.vol == null || r.vol > prev.vol)) prev.vol = r.vol;
          if (r.rank != null && (prev.rank == null || r.rank < prev.rank)) prev.rank = r.rank;
        }
      } catch (e) { errors.push({ key, message: e?.message || String(e) }); }
    }
  }
  const rows = [...byWallet.values()].map(({ source, ...r }) => r);
  return { rows, errors };
}

// Newest first (sorted by time, so a capped history is the recent one rather
// than the biggest winners). The endpoint serves at most 50 rows a page, so
// that's the most asked for; the offset moves by what actually came back,
// and only an empty or short page ends it. → { rows (raw), truncated }
const CLOSED_PAGE_MAX = 50;
async function fetchClosedPositions(http, wallet, { pageSize = DEFAULTS.closedPageSize, maxPages = DEFAULTS.closedMaxPages } = {}) {
  const rows = [];
  const limit = Math.max(1, Math.min(pageSize, CLOSED_PAGE_MAX));
  let size = limit;
  for (let page = 0; page < maxPages; page++) {
    const res = await http.get(`${DATA_API}/closed-positions`, {
      params: { user: wallet, limit, offset: rows.length, sortBy: 'TIMESTAMP', sortDirection: 'DESC' }, timeout: TIMEOUT,
    });
    const got = rowsOrThrow(res.data, 'closed positions');
    rows.push(...got);
    if (!got.length) return { rows, truncated: false };
    // a short first page may be the API's own (smaller) cap: one more page tells
    if (page === 0 && got.length < limit) size = got.length;
    else if (got.length < size) return { rows, truncated: false };
  }
  return { rows, truncated: true };
}

async function fetchOpenPositions(http, wallet, { limit = 500 } = {}) {
  const res = await http.get(`${DATA_API}/positions`, { params: { user: wallet, limit, sizeThreshold: 1 }, timeout: TIMEOUT });
  return rowsOrThrow(res.data, 'positions');
}

// global recent big trades (taker side) → parsed
async function fetchRecentTrades(http, { limit = 500, minCash = DEFAULTS.minTrade } = {}) {
  const res = await http.get(`${DATA_API}/trades`, {
    params: { limit, takerOnly: true, filterType: 'CASH', filterAmount: minCash }, timeout: TIMEOUT,
  });
  return parseTrades(rowsOrThrow(res.data, 'trades'));
}

// one wallet's trades, maker fills included → parsed
async function fetchWalletTrades(http, wallet, { limit = DEFAULTS.walletTradeLimit } = {}) {
  const res = await http.get(`${DATA_API}/trades`, { params: { user: wallet, limit, takerOnly: false }, timeout: TIMEOUT });
  return parseTrades(rowsOrThrow(res.data, 'trades'));
}

async function fetchMarket(http, conditionId) {
  const res = await http.get(`${GAMMA_API}/markets`, { params: { condition_ids: conditionId }, timeout: TIMEOUT });
  const list = parseGammaMarkets(rowsOrThrow(res.data, 'markets'));
  // hex ids may differ in case between the data API and Gamma
  return list.find(m => lower(m.conditionId) === lower(conditionId)) || null;
}

// ── engine ──
const GRADE_RANK = { A: 0, B: 1 };
const isGraded = tr => !!tr?.grade || Object.values(tr?.categories || {}).some(c => c.grade);
const fromLeaderboard = c => (c?.sources || []).some(s => s !== 'trade');
// Scores that matter: graded somewhere, or a real profitable sample that may
// get there. They're kept in full, persisted and rescored first; the rest
// shrink to a summary (the leaderboard still lists them, with reasons).
const nearGraded = (tr, o) => isGraded(tr) || (tr?.n >= o.grades.B.minN && tr?.roi > 0 && !tr?.marketMaker);
const SUMMARY_KEYS = ['id', 'wallet', 'name', 'url', 'grade', 'label', 'tailable', 'marketMaker', 'reasons', 'failed', 'n', 'events',
  'risked', 'pnl', 'roi', 'z', 'winRate', 'avgEntry', 'concentration', 'twoSided', 'activeDays', 'lastAt', 'recentN', 'recentRoi', 'edge',
  'selectedAt', 'scoredAt', 'sources', 'truncated'];
function summaryOf(tr) {
  const out = { compact: true, whyNotA: [], failedA: [], categories: {} };
  for (const k of SUMMARY_KEYS) if (tr[k] !== undefined) out[k] = tr[k];
  for (const [cat, c] of Object.entries(tr.categories || {})) out.categories[cat] = { n: c.n, roi: c.roi, z: c.z, grade: c.grade ?? null, label: c.label ?? null };
  return out;
}

function createTailEngine({ http, store = null, now = () => Date.now(), opts = {}, log = console } = {}) {
  const o = resolveOptions(opts);
  const candidates = new Map();   // wallet → { wallet, name, pnl, vol, sources, fromTrade, addedAt, selectedAt, scoredAt, failedAt }
  const traders = new Map();      // wallet → scoreWallet result (a summary for untailable ones)
  const persisted = new Set();    // wallets with a doc in the store
  const sightings = new Map();    // unknown wallet → big trades seen; enough of them queue it
  const seen = new Map();         // trade key → trade time (ms)
  const buys = new Map();         // asset → [{ wallet, at }] of graded buys, for consensus
  const tailed = new Map();       // wallet|asset → { id, units, at }: the size followers were already told
  const quotes = new Map();       // conditionId → { at, market }
  let feed = [];                  // signals, newest first
  let watchIdx = 0;
  const busy = { refresh: false, score: false, poll: false };
  const health = { lastRefreshAt: null, lastScoreAt: null, lastPollAt: null, lastSignalAt: null, errors: [] };
  // the log gets the whole message; state() (public) gets it without ids
  const warn = msg => { health.errors.push({ at: iso(now()), message: maskIds(msg) }); health.errors = health.errors.slice(-20); log?.warn?.(`Tail: ${msg}`); };

  function addCandidate(wallet, info = {}) {
    const w = lower(wallet);
    if (!w) return false;
    const prev = candidates.get(w);
    if (prev) {
      prev.name = prev.name || info.name || null;
      for (const s of info.sources || []) if (!prev.sources.includes(s)) prev.sources.push(s);
      if (info.pnl != null && (prev.pnl == null || info.pnl > prev.pnl)) prev.pnl = info.pnl;
      if (info.fromTrade) prev.fromTrade = true;
      return false;
    }
    // memory cap: past it, only leaderboard wallets still join
    if (candidates.size >= o.maxCandidates && !fromLeaderboard(info) && info.scoredAt == null) return false;
    const t = now();
    candidates.set(w, {
      wallet: w, name: info.name || null, pnl: info.pnl ?? null, vol: info.vol ?? null, sources: [...(info.sources || [])],
      fromTrade: !!info.fromTrade, addedAt: t, selectedAt: info.selectedAt ?? t, scoredAt: info.scoredAt ?? null, failedAt: null,
    });
    return true;
  }

  const loaded = (async () => {
    if (!store) return;
    await store.init();
    for (const tr of await store.all()) {
      if (!tr?.wallet) continue;
      traders.set(tr.wallet, tr);
      persisted.add(tr.wallet);
      const scoredAt = Date.parse(tr.scoredAt) || null;
      addCandidate(tr.wallet, { name: tr.name, sources: tr.sources, scoredAt, selectedAt: toMs(tr.selectedAt) ?? scoredAt });
    }
  })().catch(e => warn(`store load failed: ${e.message}`));

  async function refreshCandidates({ categories, periods, limit } = {}) {
    await loaded;
    if (busy.refresh) return { busy: true, added: 0, total: candidates.size, errors: [] };
    busy.refresh = true;
    try {
      const { rows, errors } = await fetchLeaderboard(http, { categories, periods, limit });
      let added = 0;
      for (const r of rows) if (addCandidate(r.wallet, r)) added++;
      for (const e of errors) warn(`leaderboard ${e.key}: ${e.message}`);
      health.lastRefreshAt = iso(now());
      return { added, total: candidates.size, errors };
    } finally { busy.refresh = false; }
  }

  // Who to score next, in lanes: graded (or nearly) wallets whose score is
  // due, so a grade never goes stale; new leaderboard wallets, biggest P&L
  // first; wallets seen making big trades; then everyone else's rescore,
  // oldest first. Wallets whose last fetch failed wait retryMs.
  function queue() {
    const t = now();
    const due = [], leaders = [], traded = [], stale = [];
    for (const c of candidates.values()) {
      if (c.failedAt != null && t - c.failedAt < o.retryMs) continue;
      if (c.scoredAt == null) (fromLeaderboard(c) ? leaders : traded).push(c);
      else if (t - c.scoredAt >= o.rescoreMs) (nearGraded(traders.get(c.wallet), o) ? due : stale).push(c);
    }
    const oldest = (a, b) => a.scoredAt - b.scoredAt;
    due.sort(oldest);
    stale.sort(oldest);
    leaders.sort((a, b) => ((b.pnl ?? -Infinity) - (a.pnl ?? -Infinity)) || (a.addedAt - b.addedAt));
    traded.sort((a, b) => a.addedAt - b.addedAt);
    return [...due, ...leaders, ...traded, ...stale];
  }
  function pendingCount() {
    const t = now();
    let n = 0;
    for (const c of candidates.values()) if (c.scoredAt == null && !(c.failedAt != null && t - c.failedAt < o.retryMs)) n++;
    return n;
  }

  // memory cap: the oldest summaries go (trade-sourced ones leave the queue too)
  function evict() {
    if (traders.size <= o.maxTraders) return;
    const goal = Math.floor(o.maxTraders * 0.9);
    const old = [...traders.values()].filter(tr => tr.compact).sort((a, b) => (Date.parse(a.scoredAt) || 0) - (Date.parse(b.scoredAt) || 0));
    for (const tr of old) {
      if (traders.size <= goal) break;
      traders.delete(tr.wallet);
      if (!fromLeaderboard(candidates.get(tr.wallet))) candidates.delete(tr.wallet);
    }
  }

  async function scoreOne(c) {
    const { rows: closed, truncated } = await fetchClosedPositions(http, c.wallet, { pageSize: o.closedPageSize, maxPages: o.closedMaxPages });
    const open = await fetchOpenPositions(http, c.wallet);
    const trades = await fetchWalletTrades(http, c.wallet, { limit: o.walletTradeLimit });
    const t = now();
    const score = {
      ...scoreWallet({ wallet: c.wallet, name: c.name, closed, open, trades, selectedAt: c.selectedAt }, { ...o, now: t }),
      truncated, sources: [...c.sources],
    };
    // a history doesn't shrink: far fewer bets than last time is a bad read
    const prev = traders.get(c.wallet);
    if (prev?.n >= 20 && score.n < prev.n / 2) throw new Error(`only ${score.n} resolved bets came back (had ${prev.n}), kept the last score`);
    const keep = nearGraded(score, o);
    traders.set(c.wallet, keep ? score : summaryOf(score));
    c.scoredAt = t;
    c.failedAt = null;
    // in the store: full scores that matter, summaries of leaderboard wallets
    // (so a restart doesn't refetch them); trade-sourced also-rans stay in memory
    if (store && (keep || fromLeaderboard(c) || persisted.has(c.wallet))) {
      await store.put(keep ? score : summaryOf(score));
      persisted.add(c.wallet);
    }
    evict();
    return score;
  }

  // A few wallets per call (each costs 3+ requests) so a cron spreads the work.
  async function scoreBatch(n = o.batchSize) {
    await loaded;
    if (busy.score) return { busy: true, scored: 0, wallets: [], pending: pendingCount() };
    busy.score = true;
    try {
      const wallets = [];
      for (const c of queue().slice(0, Math.max(0, n))) {
        try { await scoreOne(c); wallets.push(c.wallet); }
        catch (e) { c.failedAt = now(); warn(`score ${c.wallet}: ${e?.message || e}`); }
      }
      health.lastScoreAt = iso(now());
      return { scored: wallets.length, wallets, pending: queue().length };
    } finally { busy.score = false; }
  }

  async function quote(conditionId) {
    if (!conditionId) return null;
    const t = now();
    const hit = quotes.get(conditionId);
    if (hit && t - hit.at < o.quoteTtlMs) return hit.market;
    try {
      const market = await fetchMarket(http, conditionId);
      quotes.set(conditionId, { at: t, market });
      return market;
    } catch (e) {
      warn(`market ${conditionId}: ${e?.message || e}`);
      return null;
    }
  }

  function watched(k) {
    const list = [...traders.values()].filter(isGraded).map(tr => tr.wallet).sort();
    if (!list.length || k <= 0) return [];
    const out = [];
    for (let i = 0; i < Math.min(k, list.length); i++) out.push(list[(watchIdx + i) % list.length]);
    watchIdx = (watchIdx + out.length) % list.length;
    return out;
  }

  // An unknown wallet joins the queue on one trade of tradeCandidateMin or a
  // second one over minTrade, so one-off punters don't crowd out the leaderboard.
  function sighted(tr) {
    if (candidates.has(tr.wallet)) return void addCandidate(tr.wallet, { name: tr.name, fromTrade: true });
    const n = (sightings.get(tr.wallet) || 0) + 1;
    sightings.delete(tr.wallet);
    if (tr.notional >= o.tradeCandidateMin - EPS || n >= 2) addCandidate(tr.wallet, { name: tr.name, fromTrade: true, sources: ['trade'] });
    else {
      sightings.set(tr.wallet, n);
      if (sightings.size > 20000) sightings.delete(sightings.keys().next().value);
    }
  }

  function prune(t) {
    for (const [k, at] of seen) if (t - at > 2 * DAY) seen.delete(k);
    for (const [asset, list] of buys) {
      const keep = list.filter(b => t - b.at <= o.consensusWindowMs);
      if (keep.length) buys.set(asset, keep); else buys.delete(asset);
    }
    for (const [k, v] of tailed) if (t - v.at > o.consensusWindowMs) tailed.delete(k);
    for (const [cid, q] of quotes) if (t - q.at > o.quoteTtlMs) quotes.delete(cid);
  }

  // → the new signals (entries and exits) since the last poll, oldest first
  async function pollTrades() {
    await loaded;
    if (busy.poll) return [];
    busy.poll = true;
    try {
      const t = now();
      const trades = [];
      try { trades.push(...await fetchRecentTrades(http, { minCash: o.minTrade })); }
      catch (e) { warn(`recent trades: ${e?.message || e}`); }
      for (const w of watched(o.watchPerPoll)) {
        try { trades.push(...await fetchWalletTrades(http, w, { limit: 50 })); }
        catch (e) { warn(`trades ${w}: ${e?.message || e}`); }
      }
      trades.sort((a, b) => (a.at ?? 0) - (b.at ?? 0));

      const out = [];
      for (const tr of trades) {
        if (seen.has(tr.key)) continue;
        seen.set(tr.key, tr.at ?? t);
        const trader = traders.get(tr.wallet);
        if (!trader) {
          if (tr.notional >= o.minTrade - EPS) sighted(tr);
          continue;
        }
        if (!gradeFor(trader, classify(tr), o).grade || !(tr.notional >= o.minTrade - EPS)) continue;
        const age = tr.at == null ? 0 : t - tr.at;
        const held = `${tr.wallet}|${tr.asset}`;
        let consensus = [];
        if (tr.side === 'BUY' && age <= o.consensusWindowMs) {
          const list = buys.get(tr.asset) || [];
          consensus = [...new Set(list.filter(b => b.wallet !== tr.wallet && Math.abs((tr.at ?? t) - b.at) <= o.consensusWindowMs).map(b => b.wallet))];
          list.push({ wallet: tr.wallet, at: tr.at ?? t });
          buys.set(tr.asset, list);
        } else if (tr.side === 'SELL') {
          // selling out withdraws that wallet's vote, and ends our tail of it
          if (buys.has(tr.asset)) buys.set(tr.asset, buys.get(tr.asset).filter(b => b.wallet !== tr.wallet));
          tailed.delete(held);
        }
        if (age > o.maxTradeAgeMs) continue;   // history: counts for consensus, no signal
        const market = tr.side === 'BUY' ? await quote(tr.conditionId) : null;
        const prior = tr.side === 'BUY' ? tailed.get(held) || null : null;
        const { signal } = tradeSignal({ trade: tr, trader, market, consensus, prior, now: t, opts: o });
        if (!signal) continue;
        out.push(signal);
        // scaling in over several orders is one position: later buys top it up
        if (signal.type === 'entry' && signal.target > 0) {
          tailed.set(held, { id: prior?.id ?? signal.id, units: Math.max(prior?.units ?? 0, signal.target), at: tr.at ?? t });
        }
      }
      if (out.length) {
        feed = [...out.slice().reverse(), ...feed].slice(0, o.maxSignals);
        health.lastSignalAt = iso(t);
      }
      prune(t);
      health.lastPollAt = iso(t);
      return out;
    } finally { busy.poll = false; }
  }

  // category: grade within that category; grade: 'A' | 'B' | 'graded' (either)
  function listTraders({ category = null, grade = null, limit = 200 } = {}) {
    const want = grade ? String(grade).toUpperCase() : null;
    const gradeOf = tr => (category ? tr.categories?.[category]?.grade ?? null : tr.grade);
    const edgeOf = tr => (category ? tr.categories?.[category]?.edge : tr.edge) ?? -Infinity;
    return [...traders.values()]
      .filter(tr => !category || tr.categories?.[category])
      .filter(tr => !want || (want === 'GRADED' ? gradeOf(tr) != null : gradeOf(tr) === want))
      .sort((a, b) => ((GRADE_RANK[gradeOf(a)] ?? 2) - (GRADE_RANK[gradeOf(b)] ?? 2)) || (edgeOf(b) - edgeOf(a)) || ((b.pnl ?? 0) - (a.pnl ?? 0)))
      .slice(0, limit);
  }

  function signals({ limit = 50, type = null, since = null } = {}) {
    const cut = since == null ? null : toMs(since);
    return feed.filter(s => (!type || s.type === type) && (cut == null || Date.parse(s.seenAt) >= cut)).slice(0, limit);
  }

  function state() {
    const list = [...traders.values()];
    return {
      candidates: candidates.size, scored: list.length, pending: pendingCount(),
      graded: { A: list.filter(t => t.grade === 'A').length, B: list.filter(t => t.grade === 'B').length, anyCategory: list.filter(isGraded).length },
      marketMakers: list.filter(t => t.marketMaker).length, signals: feed.length,
      seenTrades: seen.size, ...health, errors: health.errors.slice(-5),
    };
  }

  return {
    refreshCandidates, scoreBatch, pollTrades, traders: listTraders, trader: w => traders.get(lower(w)) || null,
    signals, state, settings: () => o, addCandidate, ready: () => loaded,
  };
}

module.exports = {
  DEFAULTS, CATEGORIES, LEADERBOARD_CATEGORIES, LEADERBOARD_PERIODS, DATA_API, GAMMA_API,
  resolveOptions, optionsFromEnv, classify,
  parseClosedPositions, parseOpenPositions, resolvedFromOpen, parseTrades, parseLeaderboard, parseGammaMarket, parseGammaMarkets,
  outcomeIndexOf, askFor, priceOf, resolutionOf, markOpen,
  twoSidedShare, walletStats, gradeStats, scoreWallet, gradeFor, trueProb, tradeSignal,
  fetchLeaderboard, fetchClosedPositions, fetchOpenPositions, fetchRecentTrades, fetchWalletTrades, fetchMarket,
  createTailEngine, toMs, maskIds,
};
