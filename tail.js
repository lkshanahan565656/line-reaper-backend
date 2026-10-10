// ─── SHARP TAIL ───────────────────────────────────────────────────────────────
// Polymarket trades settle on-chain, so every bet has a wallet behind it and
// every wallet has a public history. This module decides which wallets have a
// real, provable edge and turns their new bets into sized "tail" signals.
//
// Data comes from Polymarket's data API v2 (v1 is retired 2026-10-24): every
// response is { data, pagination: { has_more, next_cursor } }, fields are
// snake_case, and lists page by passing next_cursor back as `cursor` (up to a
// page cap; hitting it sets `truncated`). Parsers still read v1 camelCase.
//
// Scoring one wallet from its settled positions: status CLOSED, plus
// REDEEMABLE (won, never claimed) and REDEEMABLE_LOST (lost, never claimed:
// the hidden losers a record leaves out if it only reads closed ones):
//   risked   avg price × shares bought (v2's avg_price has the fees in;
//            a closed row's total_cost_usdc is only the fees), else the
//            stated cost; pnl = total_pnl (else realized_pnl), net of fees
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
//   round trips  closed positions bought at 5¢ or less and out near $1 a day
//            before their market ended: split/merge, not bets. Left out of
//            the record; over 10% of settled positions = a market maker.
//   forward  bets resolved after the wallet was picked (leaderboards surface
//            the lucky too). Once there are 30, losing money there ungrades it.
//   edge     shrunk: P&L / (risked + $20k of zero-edge prior) × 0.5, so a
//            small sample can't claim a big edge and past ROI is discounted.
//   CLV      closing-line value, the part of a record luck can't fake. For
//            up to 25 of the most recent settled bets: (close − entry) / entry
//            on the token held, where the close is the last price before the
//            game started (Gamma gameStartTime) or, for other markets, the
//            last one before the price first reached 97¢+ or 3¢- (the outcome
//            getting out) or the market ended. Stake-weighted, with a hit rate
//            (share of bets that beat the close). Only measured for wallets
//            that already pass B without it, so hopeless ones cost nothing;
//            each token's close and each market lookup is cached.
//   in-play  of those sampled bets on games with a known start, the share
//            first bought after it. Over half (of 8+) is a live bettor: its
//            edge is speed a follower doesn't have, so it isn't graded (in
//            sports; its other categories still can be).
//   grades   A (elite) / B (sharp) from sample, distinct events, money risked,
//            ROI, z, concentration, two-sided share and recent activity; A
//            also needs 15+ measured CLV bets averaging +2%, B +0.5% once 15
//            are measured. Fewer than 15: at most B. Also per category:
//            elections skill says nothing about the NBA.
//   B by the close  a record in profit that fails only z or B's ROI still
//            grades B (via 'clv') when 15+ measured bets beat the close by
//            3%+ on average and 55%+ of them beat it: P&L needs thousands of
//            bets to prove a small edge, closing lines show it sooner. Its
//            edge for sizing is the larger of the P&L one and CLV × n/(n+25)
//            × 0.5. Closing lines are measured for these wallets too.
//
// Sizing at any venue (sizeAt), for a probability q at price c with a fee f
// per contract:
//   cost  = c + f;  Kelly = (q − cost) / (1 − cost)
//   units = ¼ Kelly × 100 (1u = 1% of bankroll), capped 2u (A) / 1u (B),
//           × 1.5 (so up to 3u for A, 1.5u for B) when 2+ graded wallets
//           bought that side within 24h. Kelly ≤ 0 → 0u.
//   maxPrice  the highest price, to the cent, with Kelly still above 0 once
//           the fee is paid (c + f < q), the fee taken as fixed.
// Units are the same for everyone: nothing here knows anyone's bankroll.
//
// A tail when a graded wallet BUYs at p and we can buy now at c on Polymarket:
//   q     our estimate of the true probability: the edge is an ROI at the
//         wallet's average price, carried to p as a shift in the odds (a 95¢
//         favourite can't return more than 5%), at most 0.99. It goes on the
//         signal so the same bet can be sized at other venues.
//   f     Polymarket's taker fee: rate × (c(1 − c))^exponent a share from the
//         market's feeSchedule (sports 0.05, most others none)
//   units sizeAt(q, c, f) at OUR price, not theirs
//   c more than 3¢ above p, or Kelly ≤ 0 → 0u: the price ran, don't chase.
//   Bought after the game started (Gamma gameStartTime), or at 95¢+ → 0u at
//   every venue (`blocked`): live prices move faster than an alert, and a
//   95¢ favourite has 5¢ to win and 95 to lose. TAIL_SIZE_IN_PLAY=1 and
//   TAIL_MAX_ENTRY_PRICE change these.
//   A wallet buying more of what it already bought tops the tail up to the new
//   size; it isn't a second full-size bet.
//   Graded wallets on the other side of the same market (as many as on this
//   side, or this wallet itself: a hedge) → 0u everywhere (`blocked` 'split').
//   One game or event takes at most 3u across all its markets and wallets in
//   24h (TAIL_MAX_EVENT_UNITS): its winner, spread and total move together.
//
// ROI, edge, Kelly and shares are fractions (0.08 = 8%); prices are dollars
// per share (0–1). Times on returned objects are ISO strings.
//
// Pure scoring and parsing, fetchers that take an axios-style `http`, and one
// engine (createTailEngine) that keeps candidates, scores, seen trades and
// signals in memory so a few crons can drive it.

const DATA_API = 'https://data-api.polymarket.com';
const GAMMA_API = 'https://gamma-api.polymarket.com';
const CLOB_API = 'https://clob.polymarket.com';
// v2 takes these lowercase; source keys stay upper case ("POLITICS:WEEK")
const LEADERBOARD_CATEGORIES = ['OVERALL', 'POLITICS', 'SPORTS', 'ESPORTS', 'CRYPTO', 'CULTURE', 'ECONOMICS', 'TECH', 'FINANCE'];
const LEADERBOARD_PERIODS = ['DAY', 'WEEK', 'MONTH', 'ALL'];
const SETTLED_STATUSES = ['CLOSED', 'REDEEMABLE', 'REDEEMABLE_LOST'];
const PAGE_MAX = 1000;   // the v2 lists' largest page
const CATEGORIES = ['sports', 'politics', 'crypto', 'econ', 'culture', 'other'];
const DAY = 86400e3;
const EPS = 1e-9;   // thresholds like 0.08 must survive float noise

// Bumped when the grading rules change. Scores from older rules are rescored
// first. Until then, round 2's are capped at B (no closing-line value, no
// unclaimed losers) and anything older than round 3 is not graded at all:
// those counted only the fees as the stake on closed bets that paid fees, so
// their ROI and luck test can be many times too high. Round 3's aren't graded
// either: they counted split/merge round trips as near-certain winners.
const RULES_VERSION = 4;
const STAKE_FIX_VERSION = 3;
const ROUND_TRIP_VERSION = 4;

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
  maxEntryPrice: 0.95,           // buys at this or more (theirs or ours) → 0u: a few cents to win, everything to lose (TAIL_MAX_ENTRY_PRICE)
  sizeInPlay: 0,                 // 1: also size bets placed after the game started (TAIL_SIZE_IN_PLAY); live prices move faster than a follow
  kellyFraction: 0.25,
  bankrollUnits: 100,            // 1 unit = 1% of bankroll
  maxProb: 0.99,
  consensusMin: 2,               // distinct graded wallets on the same side...
  consensusWindowMs: 24 * 3600e3, // ...within this window
  consensusMult: 1.5,
  maxUnits: 3,
  maxEventUnits: 3,              // units told across one game or event in consensusWindowMs, whoever bought (TAIL_MAX_EVENT_UNITS, 0 = no cap)
  forwardMinN: 30,               // bets resolved since the wallet was picked before they count
  batchSize: 60,                 // wallets scored per scoreBatch call, at most...
  scoreBudgetMs: 40e3,           // ...and no new wallet started after this long (the job runs every minute)
  scoreConcurrency: 4,           // wallets scored at once (each waits on its own requests; the polite queue paces the hosts)
  rescoreMs: 12 * 3600e3,
  retryMs: 30 * 60e3,            // after a failed fetch
  tradeCandidateMin: 5000,       // $ for one trade to queue an unknown wallet (or 2 trades over minTrade)
  maxCandidates: 50000,          // memory caps: trade-sourced wallets stop being queued...
  maxTraders: 20000,             // ...and the oldest untailable scores are forgotten
  closedPageSize: 500,           // settled positions a page (v2 allows up to 1000)...
  closedMaxPages: 4,             // ...and pages per status (CLOSED, REDEEMABLE, REDEEMABLE_LOST)
  openMaxPages: 2,               // open positions, 500 a page
  walletTradeLimit: 500,
  watchPerPoll: 2,               // graded wallets whose own trades each poll also reads
  quoteTtlMs: 20e3,
  gammaStaleMs: 3600e3,          // a Gamma price not updated for this long is no price (the order book is the live one)
  maxSignals: 500,
  holdingsMax: 50,               // open positions kept per graded wallet, for the Sharp Board
  boardMinCost: 100,             // $ in a position before it counts on the Sharp Board
  clvSample: 25,                 // recent settled bets whose closing line is measured (TAIL_CLV_SAMPLE)
  clvMinN: 15,                   // measured bets before CLV counts, and before A is possible
  clvPath: 1,                    // 0: B only from the record. 1: a profitable record that fails only the luck test or B's ROI...
  clvPathMin: 0.03,              // ...grades B when its measured bets beat the close by this much on average (TAIL_CLV_PATH_MIN)...
  clvPathHitRate: 0.55,          // ...and this share of them beat it (TAIL_CLV_PATH_HIT_RATE)
  clvWindowDays: 7,              // price history read up to the close...
  clvBucketSeconds: 300,         // ...in 5-minute buckets, one call a token...
  clvPointLimit: 1000,           // ...so the window shrinks to fit this many points
  clvMaxGapMs: 24 * 3600e3,      // a game's last price must be this close to its start
  clvCacheMax: 50000,            // tokens' closes and markets kept in memory
  maxInPlay: 0.5,                // over this share of sampled game bets placed after the start = a live bettor (TAIL_MAX_IN_PLAY)...
  inPlayMinGames: 8,             // ...once at least this many sampled bets were on games with a known start
  roundTripEntry: 0.05,          // a closed position bought at this or less (TAIL_ROUND_TRIP_ENTRY)...
  roundTripExit: 0.95,           // ...and out at this or more a day before its market's end date is a split/merge round trip, not a bet (TAIL_ROUND_TRIP_EXIT)
  maxRoundTrips: 0.1,            // over this share of settled positions as round trips = a market maker (TAIL_MAX_ROUND_TRIPS)...
  roundTripMinN: 5,              // ...once there are at least this many
  grades: {
    A: { label: 'elite', minN: 100, minEvents: 30, minRisked: 50000, minRoi: 0.08, minZ: 3, maxConcentration: 0.35, activeDays: 30, minRecentRoi: -0.10, minClv: 0.02, requireClv: 1, capUnits: 2 },
    B: { label: 'sharp', minN: 50, minEvents: 15, minRisked: 20000, minRoi: 0.04, minZ: 2, maxConcentration: 0.4, activeDays: 45, minRecentRoi: null, minClv: 0.005, requireClv: 0, capUnits: 1 },
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
// 1%; TAIL_B_MIN_CLV's 0.5% is 0.005, since 0.5 would read as 50%),
// TAIL_CHASE_MAX takes cents or dollars (1 is 1¢), and the factors
// (regression, Kelly fraction, max probability) take 0.25 or 25 (1 is 1.0).
const PERCENT_KEYS = new Set(['maxTwoSided', 'minRoi', 'minRecentRoi', 'maxConcentration', 'chaseMax', 'minClv', 'maxEntryPrice', 'maxInPlay', 'clvPathMin', 'clvPathHitRate', 'roundTripEntry', 'roundTripExit', 'maxRoundTrips']);
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
// first value that is there (v2 snake_case names first, then v1 camelCase)
const pick = (...vs) => { for (const v of vs) if (v != null && v !== '') return v; return null; };
// arrays come bare or wrapped, depending on the endpoint and its age; v2's
// `{ data: null }` is an empty list
const ROW_KEYS = ['data', 'positions', 'trades', 'leaderboard', 'markets', 'results'];
const emptyData = payload => payload != null && typeof payload === 'object' && !Array.isArray(payload) && 'data' in payload && payload.data == null;
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
  if (emptyData(payload)) return [];
  throw new Error(`${what}: unexpected response (${payload === null ? 'null' : typeof payload})`);
}
// v2 paging: the cursor for the next page, or null when this was the last
const nextCursor = payload => {
  const pg = payload?.pagination;
  if (!pg || typeof pg !== 'object' || pg.has_more === false || pg.has_more === 'false') return null;
  return pg.next_cursor != null && pg.next_cursor !== '' ? String(pg.next_cursor) : null;
};
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
    [input.eventSlug ?? input.event_slug, input.slug, ev?.slug].filter(Boolean).join(' '),
  ];
  for (const s of sources) {
    const cat = scoreText(s);
    if (cat) return cat;
  }
  // no keyword: Polymarket's game markets still have a shape. "Will Croatia
  // win on 2026-10-09?", "... end in a draw?", "Spread: Iceland (-1.5)",
  // "Croatia vs. Iceland: O/U 2.5", "Game 2 Winner", and game slugs like
  // "bun-dor-wer-2026-10-09" (league-team-team-date)
  if (SPORTS_TITLE_RE.test(sources[1]) || SPORTS_SLUG_RE.test(sources[2])) return 'sports';
  return 'other';
}
const SPORTS_TITLE_RE = /\bwin on \d{4}-\d{2}-\d{2}\b|\bend in a draw\b|^spread:|\bo\/u \d|\b(?:game|map) \d+ winner\b|\bboth teams to score\b/i;
const SPORTS_SLUG_RE = /(?:^|\s)[a-z0-9]{2,6}-[a-z0-9]{2,6}-[a-z0-9]{2,6}-\d{4}-\d{2}-\d{2}(?:-|\s|$)/i;

// ── parsing: data API ──
// Dollars into a position, fees included. The live v2 avg_price already
// carries the fees (one wallet's fills of $1,230.36 plus $8.31 of fees on
// 1,820.46 shares read avg_price 0.6804) and total_pnl is net of them, so
// shares bought × avg_price is the stake. total_cost_usdc is only what is
// still held plus fees: on a closed position it is the fees alone, which
// once made a $22,372 bet read as $145 risked. It's the fallback for rows
// with no share count.
function stakeOf(r) {
  const price = num(pick(r.avg_price, r.avgPrice)), shares = num(pick(r.total_size, r.totalBought, r.totalSize));
  if (price > 0 && price < 1 && shares > 0) return price * shares;
  return costOf(r);
}
// What the row says it cost (still-held cost plus fees on v2), or null.
function costOf(r) {
  const total = num(pick(r.total_cost_usdc, r.totalCostUsdc));
  if (total > 0) return total;
  const entry = num(pick(r.entry_cost_usdc, r.entryCostUsdc));
  if (entry > 0) return entry + Math.max(0, num(pick(r.entry_fees_usdc, r.entryFeesUsdc)) ?? 0);
  return null;
}
// what every position and trade row says about its market, either naming style
function marketRef(r) {
  const asset = pick(r.token_id, r.asset, r.tokenId);
  return {
    wallet: lower(pick(r.proxy_wallet, r.proxyWallet, r.wallet)) || null, conditionId: pick(r.condition_id, r.conditionId),
    asset: asset == null ? null : String(asset), outcome: r.outcome ?? null, outcomeIndex: num(pick(r.outcome_index, r.outcomeIndex)),
    title: r.title || '', slug: r.slug || '', eventSlug: pick(r.event_slug, r.eventSlug) || '',
  };
}
const latest = (...ts) => { let m = null; for (const t of ts) if (t != null) m = Math.max(m ?? t, t); return m; };

// Settled positions: v2 rows of status CLOSED, REDEEMABLE or REDEEMABLE_LOST
// (v1 closed-positions rows read as CLOSED). A never-claimed one has no close
// time of its own: it is dated by its market's end, unless that end is still
// to come (it resolved early), and then it has no date. activeAt is the
// wallet's own last move on it (a close, its first entry), never a market date.
const UNCLAIMED = new Set(['REDEEMABLE', 'REDEEMABLE_LOST']);
function parseClosedPositions(payload, { now = Date.now() } = {}) {
  const out = [];
  for (const r of rowsOf(payload)) {
    if (!r || typeof r !== 'object') continue;
    const status = String(r.status || 'CLOSED').trim().toUpperCase();
    if (!SETTLED_STATUSES.includes(status)) continue;
    const price = num(pick(r.avg_price, r.avgPrice)), shares = num(pick(r.total_size, r.totalBought, r.totalSize));
    const cur = num(pick(r.current_price, r.curPrice));
    if (!(price > 0 && price < 1)) continue;
    const risked = stakeOf(r);
    if (!(risked > 0)) continue;
    const realized = num(pick(r.realized_pnl, r.realizedPnl));
    let pnl = num(pick(r.total_pnl, r.totalPnl));
    if (pnl == null && UNCLAIMED.has(status)) {
      // still held at settlement: worth $1 (won), $0 (lost) or what it settled at
      const held = num(pick(r.current_size, r.size)) ?? shares;
      const value = cur != null && cur >= 0 && cur <= 1 ? cur : status === 'REDEEMABLE' ? 1 : 0;
      if (held != null) pnl = (realized ?? 0) + held * ((status === 'REDEEMABLE_LOST' ? 0 : value) - price);
    }
    if (pnl == null) pnl = realized ?? (cur != null && shares > 0 ? shares * (cur - price) : null);
    if (pnl == null) continue;
    const end = toMs(pick(r.end_date, r.endDate));
    const unclaimed = UNCLAIMED.has(status);
    const at = unclaimed ? (end != null && end <= now ? end : null) : toMs(pick(r.last_event_at, r.lastEventAt, r.timestamp)) ?? end;
    const enteredAt = toMs(pick(r.first_entry_at, r.firstEntryAt));
    const fees = num(pick(r.entry_fees_usdc, r.entryFeesUsdc));
    out.push({
      ...marketRef(r), status, price, risked, pnl, fees: fees > 0 ? fees : 0,
      // what it came out at per share (sold, merged or paid out)
      exit: shares > 0 ? round((pnl + risked) / shares, 6) : null,
      won: status === 'REDEEMABLE_LOST' ? false : cur != null ? cur >= 0.99 : status === 'REDEEMABLE' || pnl > 0,
      at, endAt: end, enteredAt, activeAt: latest(unclaimed ? null : at, enteredAt),
      category: classify(r), source: status === 'REDEEMABLE' ? 'redeemable' : status === 'REDEEMABLE_LOST' ? 'lost' : 'closed',
    });
  }
  return out;
}

function parseOpenPositions(payload) {
  const out = [];
  for (const r of rowsOf(payload)) {
    if (!r || typeof r !== 'object') continue;
    const ref = marketRef(r);
    if (!ref.conditionId && ref.asset == null) continue;
    const status = r.status != null ? String(r.status).trim().toUpperCase() : null;
    const enteredAt = toMs(pick(r.first_entry_at, r.firstEntryAt));
    out.push({
      ...ref, status,
      size: num(pick(r.current_size, r.size)), price: num(pick(r.avg_price, r.avgPrice)), curPrice: num(pick(r.current_price, r.curPrice)),
      totalBought: num(pick(r.total_size, r.totalBought)), cost: costOf(r), stake: stakeOf(r),
      initialValue: num(r.initialValue), currentValue: num(pick(r.current_value, r.currentValue)),
      cashPnl: num(pick(r.unrealized_pnl, r.cashPnl)), realizedPnl: num(pick(r.realized_pnl, r.realizedPnl)), totalPnl: num(pick(r.total_pnl, r.totalPnl)),
      redeemable: bool(r.redeemable) || (status != null && UNCLAIMED.has(status)), endDate: pick(r.end_date, r.endDate),
      enteredAt, activeAt: latest(toMs(pick(r.last_event_at, r.lastEventAt)), enteredAt), category: classify(r),
    });
  }
  return out;
}

// Open positions in markets that already resolved (redeemable at $1 or $0).
// Losers are rarely redeemed, so without these a wallet's record only grows.
// (v2 lists them under REDEEMABLE / REDEEMABLE_LOST; this catches any that an
// open read still carries.) Their time is the market's scheduled end, which
// can be in the future for a market that resolved early: then it has no time
// (it isn't recent form).
const settledOpen = r => r.redeemable && r.curPrice != null && (r.curPrice >= 0.99 || r.curPrice <= 0.01);
function resolvedFromOpen(openRows, now = Date.now()) {
  const out = [];
  for (const r of openRows || []) {
    if (!settledOpen(r)) continue;
    const cur = r.curPrice;
    const shares = r.totalBought ?? r.size;
    if (!(r.price > 0 && r.price < 1) || !(shares > 0) || !(r.size >= 0)) continue;
    const settle = cur >= 0.99 ? 1 : 0;
    const pnl = r.totalPnl ?? (r.cashPnl ?? r.size * (settle - r.price)) + (r.realizedPnl ?? 0);
    const end = toMs(r.endDate);
    out.push({
      wallet: r.wallet, conditionId: r.conditionId, asset: r.asset, outcome: r.outcome, outcomeIndex: r.outcomeIndex,
      title: r.title, slug: r.slug, eventSlug: r.eventSlug, status: settle ? 'REDEEMABLE' : 'REDEEMABLE_LOST',
      price: r.price, risked: r.stake > 0 ? r.stake : r.price * shares, pnl, fees: 0, won: settle === 1,
      at: end != null && end <= now ? end : null, endAt: end, enteredAt: r.enteredAt ?? null, activeAt: r.enteredAt ?? null,
      category: r.category, source: 'open',
    });
  }
  return out;
}

// A position still open, at today's price: the dollars in (fees included when
// the row says), and the profit so far (any part already sold plus the
// unrealized rest). null if unpriced.
function markOpen(r) {
  const shares = r.totalBought ?? r.size;
  const risked = r.stake > 0 ? r.stake : r.price > 0 && shares > 0 ? r.price * shares : r.cost > 0 ? r.cost : r.initialValue;
  if (!(risked > 0)) return null;
  if (r.totalPnl != null) return { risked, pnl: r.totalPnl };
  const unreal = r.cashPnl
    ?? (r.currentValue != null && r.initialValue != null ? r.currentValue - r.initialValue
      : r.curPrice != null && r.size != null && r.price != null ? r.size * (r.curPrice - r.price) : null);
  if (unreal == null) return null;
  return { risked, pnl: unreal + (r.realizedPnl ?? 0) };
}

// Settled and still-open positions out of raw rows: the same token listed
// twice (under two statuses, or on two pages as the list moved) counts once.
function resolvedPositions(closed = [], open = [], now = Date.now()) {
  const seenKeys = new Set();
  const closedRows = parseClosedPositions(closed, { now }).filter(p => {
    if (!p.asset) return true;
    const k = `${p.asset}|${p.enteredAt ?? ''}`;
    if (seenKeys.has(k)) return false;
    seenKeys.add(k);
    return true;
  });
  const openRows = parseOpenPositions(open);
  const settledAssets = new Set(closedRows.map(p => p.asset).filter(Boolean));
  const fromOpen = resolvedFromOpen(openRows, now).filter(p => !p.asset || !settledAssets.has(p.asset));
  const stillOpen = openRows.filter(r => !settledOpen(r) && !(r.asset && settledAssets.has(r.asset)));
  return { closedRows, openRows, resolved: [...closedRows, ...fromOpen], stillOpen };
}

// Trades come back one row per fill; fills of one order share a transaction
// hash, so rows with the same key are merged (size summed, price averaged).
// Also accepts already-parsed trades.
const tradeKey = (txHash, asset, wallet) => `${txHash}:${asset}:${wallet}`;
function parseTrades(payload) {
  const byKey = new Map();
  for (const r of rowsOf(payload)) {
    if (!r || typeof r !== 'object') continue;
    const ref = marketRef(r);
    const { wallet, asset } = ref;
    const side = String(r.side || '').toUpperCase();
    const size = num(r.size), price = num(r.price);
    if (!wallet || !asset || !(size > 0) || !(price > 0 && price < 1)) continue;
    const at = toMs(r.timestamp ?? r.at);
    const txHash = pick(r.transaction_hash, r.transactionHash, r.txHash);
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
      key, wallet, side, asset, conditionId: ref.conditionId, size, price, notional: size * price, at,
      title: ref.title, slug: ref.slug, eventSlug: ref.eventSlug, outcome: ref.outcome, outcomeIndex: ref.outcomeIndex,
      name: r.name || r.pseudonym || null, txHash,
    });
  }
  return [...byKey.values()];
}

// v2 rows: rank, user_id (the wallet), pnl, volume, user_name, x_username, verified
function parseLeaderboard(payload, source = null) {
  const out = [];
  for (const r of rowsOf(payload)) {
    if (!r || typeof r !== 'object') continue;
    const wallet = lower(pick(r.user_id, r.proxy_wallet, r.proxyWallet, r.wallet, r.address, r.user));
    if (!wallet) continue;
    out.push({
      wallet, name: pick(r.user_name, r.userName, r.username, r.name, r.pseudonym),
      pnl: num(r.pnl ?? r.amount), vol: num(pick(r.volume, r.vol)), rank: num(r.rank),
      xUsername: pick(r.x_username, r.xUsername), verified: bool(r.verified) || bool(r.verifiedBadge),
      profileImage: pick(r.profile_image, r.profileImage), source,
    });
  }
  return out;
}

// ── parsing: gamma markets ──
// Taker fee schedule: `feeSchedule` (an object, or the same as a JSON string)
// with `rate` and `exponent`. A sports market (`feeType: "sports_fees_v2"`)
// that comes without one is taken at the published 0.05 (as xarb.js does), so
// a missing field never makes a bet look cheaper. A rate over 1 is a percent.
// → { rate, exponent, type } | null (no fee)
const SPORTS_FEE_RATE = 0.05;
function parseFeeSchedule(m) {
  let sched = m?.feeSchedule ?? m?.fee_schedule ?? null;
  if (typeof sched === 'string') { try { sched = JSON.parse(sched); } catch { sched = null; } }
  const type = m?.feeType ?? m?.fee_type ?? null;
  let rate = num(sched?.rate);
  if (rate != null && rate >= 0) {
    if (rate > 1) rate /= 100;
    const e = num(sched.exponent);
    return rate > 0 ? { rate, exponent: e != null && e > 0 ? e : 1, type } : null;
  }
  return /sports_fees/i.test(type || '') ? { rate: SPORTS_FEE_RATE, exponent: 1, type } : null;
}
// Polymarket's taker fee a share bought at `price`: rate × (p(1 − p))^exponent
function polymarketFee(price, schedule) {
  const p = num(price), rate = num(schedule?.rate);
  if (!(p > 0 && p < 1) || !(rate > 0)) return 0;
  const e = num(schedule.exponent);
  return rate * (p * (1 - p)) ** (e != null && e > 0 ? e : 1);
}

function parseGammaMarket(m) {
  if (!m || typeof m !== 'object') return null;
  const ev = Array.isArray(m.events) ? m.events[0] : null;
  return {
    id: m.id != null ? String(m.id) : null, conditionId: m.conditionId || m.condition_id || null, question: m.question || '',
    slug: m.slug || '', eventSlug: ev?.slug || m.eventSlug || '', eventTitle: ev?.title || '',
    category: m.category || ev?.category || null, tags: m.tags || ev?.tags || null,
    outcomes: jsonList(m.outcomes) || [], prices: (jsonList(m.outcomePrices) || []).map(num),
    tokens: (jsonList(m.clobTokenIds) || []).map(String),
    bestBid: num(m.bestBid), bestAsk: num(m.bestAsk), lastTradePrice: num(m.lastTradePrice),
    endDate: m.endDate || m.endDateIso || null, gameStartTime: m.gameStartTime || m.game_start_time || null,
    closedAt: toMs(m.closedTime), sportsMarketType: m.sportsMarketType ?? null,
    active: m.active !== false && m.active !== 'false', closed: bool(m.closed), resolution: m.umaResolutionStatus || null,
    acceptingOrders: m.acceptingOrders == null ? null : bool(m.acceptingOrders),
    negRisk: bool(m.negRisk), volume: num(m.volume), liquidity: num(m.liquidity),
    fee: parseFeeSchedule(m), updatedAt: toMs(m.updatedAt),
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
// ── the live order book ──
// Gamma's bestAsk / lastTradePrice can lag the market by weeks (seen live:
// Gamma 35¢, book 59.6¢), so prices to act on come from the CLOB book of the
// token itself. → { ask, bid, mid, spread, askSize, bidSize, at } or null
function parseBook(payload) {
  if (!payload || typeof payload !== 'object' || (!Array.isArray(payload.asks) && !Array.isArray(payload.bids))) return null;
  const levels = list => (Array.isArray(list) ? list : [])
    .map(l => ({ p: num(Array.isArray(l) ? l[0] : l?.price), s: num(Array.isArray(l) ? l[1] : l?.size) }))
    .filter(l => l.p > 0 && l.p < 1 && l.s > 0);
  const asks = levels(payload.asks).sort((a, b) => a.p - b.p), bids = levels(payload.bids).sort((a, b) => b.p - a.p);
  const ask = asks[0]?.p ?? null, bid = bids[0]?.p ?? null;
  return {
    ask, bid, mid: ask != null && bid != null ? round((ask + bid) / 2, 6) : null,
    spread: ask != null && bid != null ? round(ask - bid, 6) : null,
    askSize: asks[0]?.s ?? null, bidSize: bids[0]?.s ?? null, at: toMs(payload.timestamp),
  };
}
async function fetchBook(http, tokenId) {
  const res = await http.get(`${CLOB_API}/book`, { params: { token_id: String(tokenId) }, timeout: TIMEOUT });
  return parseBook(res?.data);
}
// The price to buy that outcome now: the book's ask when there is a book;
// without one, Gamma's, unless Gamma hasn't been updated for gammaStaleMs.
// → { price, source: 'book' | 'gamma' } (price null when there's none)
function liveAsk(market, book, ref, { now = Date.now(), opts = {} } = {}) {
  if (book) return { price: inUnit(book.ask), source: 'book' };
  if (!market) return { price: null, source: null };
  const o = resolveOptions(opts);
  if (market.updatedAt != null && now - market.updatedAt > o.gammaStaleMs) return { price: null, source: 'gamma' };
  return { price: askFor(market, ref), source: 'gamma' };
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

// ── closing-line value ──
// Price history comes in several shapes (unconfirmed for v2): the points as
// { t, p }, { timestamp, price }, { ts, price } or [t, p], bare or under
// `history` / `data` / `data.history`. → { points: [{ t (ms), p }] oldest
// first, truncated (more pages left) }. strict: a payload with no list in it
// throws (a failed fetch, not "no prices").
const HISTORY_KEYS = ['history', 'points', 'prices', 'data'];
function historyRows(payload, depth = 0) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object' || depth > 2) return null;
  for (const k of HISTORY_KEYS) {
    const v = payload[k];
    if (Array.isArray(v)) return v;
    if (v && typeof v === 'object') { const inner = historyRows(v, depth + 1); if (inner) return inner; }
  }
  return emptyData(payload) ? [] : null;
}
function parsePriceHistory(payload, { strict = false } = {}) {
  const rows = historyRows(payload);
  if (!rows) {
    if (strict) throw new Error(`prices history: unexpected response (${payload === null ? 'null' : typeof payload})`);
    return { points: [], truncated: false };
  }
  const byT = new Map();
  for (const x of rows) {
    // a settled market's last point is its resolution (resolution_seconds 0,
    // price 0 or 1), not a price anyone traded at
    if (x && !Array.isArray(x) && Number(x.resolution_seconds) === 0 && x.resolution_seconds !== null && x.resolution_seconds !== '') continue;
    const t = toMs(Array.isArray(x) ? x[0] : pick(x?.t, x?.timestamp, x?.ts, x?.time));
    const p = num(Array.isArray(x) ? x[1] : pick(x?.p, x?.price, x?.value));
    if (t != null && p != null && p >= 0 && p <= 1) byT.set(t, p);
  }
  const points = [...byT].map(([t, p]) => ({ t, p })).sort((a, b) => a.t - b.t);
  return { points, truncated: nextCursor(payload) != null || nextCursor(payload?.data) != null || payload?.pagination?.has_more === true };
}

// When a settled market's closing line was, for the token held. A game
// (Gamma gameStartTime) closes at its start. Anything else closes when the
// outcome got out (freeze) or at its end: the earliest of the market's close
// time, its end date and now. A game whose start we can't get (no market, or
// a head-to-head with no start time) has no close: its in-play prices aren't
// one. → { start, end, rule: 'game' | 'freeze' } | null. The window is the
// market's own (one cached close a token, whoever held it), at most
// clvWindowDays and at most clvPointLimit buckets long.
const GAME_TITLE = /\s(vs\.?|v\.?|@)\s/i;
function clvWindow(pos, market = null, { now = Date.now(), opts = {} } = {}) {
  const o = resolveOptions(opts);
  if (!pos?.asset) return null;
  const game = toMs(market?.gameStartTime);
  let end, rule;
  if (game != null) { end = game; rule = 'game'; }
  else if (pos.category === 'sports' && (!market || GAME_TITLE.test(` ${market.question || pos.title || ''} `) || market.sportsMarketType)) return null;
  else {
    end = Math.min(now, ...[market?.closedAt, pos.endAt ?? toMs(market?.endDate)].filter(Number.isFinite));
    rule = 'freeze';
  }
  if (!(end <= now)) return null;
  const span = Math.min(o.clvWindowDays * DAY, o.clvPointLimit * o.clvBucketSeconds * 1000);
  return { start: end - span, end, rule };
}

// The closing price inside a window's points (strictly before `closeAt`):
// the last one, or with `freeze` the last one before the price first reached
// 97¢+ or 3¢- (if a cut-off series never gets there, its close is unknown). A
// game's last price must be within maxGapMs of the start. → { price, at, cut }
// | null, `cut` being when the line stopped counting (a bet placed after it
// has no closing line).
const OUTCOME_OUT = p => p >= 0.97 || p <= 0.03;
function closingPrice(points, { closeAt = null, freeze = false, truncated = false, maxGapMs = null } = {}) {
  const list = (points || []).filter(x => Number.isFinite(x?.t) && Number.isFinite(x?.p) && (closeAt == null || x.t < closeAt)).sort((a, b) => a.t - b.t);
  let last = null, cut = closeAt;
  if (freeze) {
    let frozeAt = null;
    for (const x of list) { if (OUTCOME_OUT(x.p)) { frozeAt = x.t; break; } last = x; }
    if (frozeAt == null && truncated) return null;
    if (frozeAt != null) cut = frozeAt;
  } else last = list.at(-1) || null;
  if (!last) return null;
  if (maxGapMs != null && closeAt != null && closeAt - last.t > maxGapMs) return null;
  return { price: last.p, at: last.t, cut: cut ?? last.t };
}

// One position's CLV against its token's close: (close − entry) / entry. null
// when it was bought after the line stopped counting (in play, or after the
// outcome got out).
function clvOf(pos, close) {
  if (!pos || !close || !(pos.price > 0 && pos.price < 1) || !Number.isFinite(close.price)) return null;
  if (pos.enteredAt != null && close.cut != null && pos.enteredAt >= close.cut) return null;
  return {
    asset: pos.asset, conditionId: pos.conditionId || null, category: pos.category || 'other', title: pos.title || '',
    risked: round(pos.risked, 2), entry: round(pos.price, 6), close: close.price, closeAt: iso(close.at), cutAt: iso(close.cut),
    rule: close.rule || null, clv: (close.price - pos.price) / pos.price,
  };
}

// stake-weighted average CLV, the share that beat the close, and how many
function clvStats(samples) {
  const list = (samples || []).filter(x => Number.isFinite(x?.clv));
  if (!list.length) return { n: 0, avg: null, hitRate: null };
  let w = 0, sum = 0;
  for (const x of list) { const r = num(x.risked) > 0 ? num(x.risked) : 0; w += r; sum += r * x.clv; }
  return {
    n: list.length, avg: w > 0 ? sum / w : list.reduce((a, x) => a + x.clv, 0) / list.length,
    hitRate: list.filter(x => x.clv > 0).length / list.length,
  };
}

// the k most recent settled positions with a token and a price, one per token
function clvCandidates(resolved, k = DEFAULTS.clvSample) {
  const when = p => p.at ?? p.endAt ?? p.enteredAt ?? 0;
  const seenAssets = new Set(), out = [];
  // ties broken by token, so the same record always samples the same bets
  const byTime = (a, b) => (when(b) - when(a)) || (a.asset < b.asset ? -1 : a.asset > b.asset ? 1 : 0);
  for (const p of [...(resolved || [])].filter(p => p?.asset && p.price > 0 && p.price < 1).sort(byTime)) {
    if (out.length >= k) break;
    if (seenAssets.has(p.asset)) continue;
    seenAssets.add(p.asset);
    out.push(p);
  }
  return out;
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
function walletStats(positions, { holdings = positions, open = [], since = null, now = Date.now(), clvSamples = null, play = null, opts = {} } = {}) {
  const o = resolveOptions(opts);
  const clv = clvStats(clvSamples);
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
    clv: clv.avg, clvN: clv.n, clvHitRate: clv.hitRate,
    // what the closing lines alone say the edge is, shrunk the same way
    clvEdge: clv.n >= o.clvMinN && clv.avg > 0 ? clv.avg * (clv.n / (clv.n + o.clvSample)) * o.regression : null,
    ...inPlayOf(play, o),
  };
}

// Of the sampled bets on games with a known start, the share whose first fill
// came after it. A wallet that mostly bets live wins on speed a follower
// doesn't have, and its pregame bets have no record of their own.
function inPlayOf(play, o) {
  const games = num(play?.games) > 0 ? num(play.games) : 0, live = num(play?.inPlay) > 0 ? num(play.inPlay) : 0;
  return { inPlayGames: games, inPlayShare: games >= o.inPlayMinGames ? live / games : null };
}

// A split/merge round trip, not a bet: bought for a few cents and out near $1
// a day or more before its market's end date. Splitting $1 into YES + NO and
// selling one side, then merging back, books the cheap side as a sure winner
// that never resolved (v2 lists it CLOSED at ~95× its stake), so a market
// maker doing this all day looks like a 30-z sharp.
const isRoundTrip = (p, o) => p?.status === 'CLOSED' && p.price <= o.roundTripEntry + EPS && p.exit >= o.roundTripExit - EPS
  && p.at != null && p.endAt != null && p.at < p.endAt - DAY;
const roundTripper = (s, o) => s.roundTrips >= o.roundTripMinN && s.roundTripShare > o.maxRoundTrips + EPS;

function presentStats(s) {
  return {
    n: s.n, events: s.events, risked: round(s.risked, 2), pnl: round(s.pnl, 2), roi: round(s.roi, 4),
    openN: s.openN ?? 0, openRisked: round(s.openRisked ?? 0, 2), openPnl: round(s.openPnl ?? 0, 2), resolvedRoi: round(s.resolvedRoi, 4),
    winRate: round(s.winRate, 4), avgEntry: round(s.avgEntry, 4), z: round(s.z, 2), concentration: round(s.concentration, 4),
    concentrationBy: s.concentrationBy ?? null,
    twoSided: round(s.twoSided, 4), markets: s.markets, activeDays: s.activeDays, lastAt: iso(s.lastAt),
    recentN: s.recentN, recentRoi: round(s.recentRoi, 4),
    forwardN: s.forwardN ?? null, forwardRoi: round(s.forwardRoi, 4), edge: round(s.edge, 6),
    clv: round(s.clv, 4), clvN: s.clvN ?? 0, clvHitRate: round(s.clvHitRate, 4),
    inPlayShare: round(s.inPlayShare, 4), inPlayGames: s.inPlayGames ?? 0,
    ...(s.roundTrips != null ? { roundTrips: s.roundTrips, roundTripShare: round(s.roundTripShare, 4) } : {}),
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
  if (s.inPlayShare != null && s.inPlayShare > o.maxInPlay + EPS) {
    fail('inPlay', `live bettor: ${vs(s.inPlayShare, o.maxInPlay, 0, 100)}% of ${s.inPlayGames} sampled game bets came after the start (max ${pct(o.maxInPlay, 0)})`);
  }
  if (s.twoSided > o.maxTwoSided + EPS) fail('twoSided', `market maker: held both sides in ${vs(s.twoSided, o.maxTwoSided, 0, 100)}% of markets (max ${pct(o.maxTwoSided, 0)})`);
  if (roundTripper(s, o)) {
    fail('roundTrips', `market maker: ${s.roundTrips} settled positions (${vs(s.roundTripShare, o.maxRoundTrips, 0, 100)}%) were split/merge round trips, bought at ${Math.round(o.roundTripEntry * 100)}¢ or less and out near $1 before the market ended (max ${pct(o.maxRoundTrips, 0)})`);
  }
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
  // closing-line value: needed for A; once measured on enough bets it can sink B too
  const clvN = s.clvN ?? 0;
  if (clvN === 0 || clvN < o.clvMinN) {
    if (g.requireClv) fail('clv', 'closing-line value not measured yet');
  } else if (g.minClv != null && !(s.clv != null && s.clv >= g.minClv - EPS)) {
    fail('clv', `closing-line value ${signedPct(s.clv ?? 0, g.minClv)} over ${clvN} bets (need ${signedPct(g.minClv, g.minClv)})`);
  }
  return f;
}
const signedPct = (x, limit) => { const v = vs(x, limit, 1, 100); return `${v > 0 ? '+' : ''}${v}%`; };

// The closing line's way to B: a record that fails only the luck test or B's
// ROI bar, but made money and keeps beating the close. A few hundred bets of
// P&L can't prove an edge of a few percent; closing lines show it sooner.
const CLOSE_WAIVES = new Set(['z', 'roi']);
const closeCanGrade = (failed, roi) => failed.length > 0 && failed.every(c => CLOSE_WAIVES.has(c)) && roi > 0;
function byClose(s, failB, o) {
  return !!o.clvPath && closeCanGrade(failB.map(f => f.code), s.roi)
    && s.clvN >= o.clvMinN && s.clv >= o.clvPathMin - EPS && s.clvHitRate >= o.clvPathHitRate - EPS;
}

function gradeStats(s, opts = {}, now = Date.now()) {
  const o = resolveOptions(opts);
  const failA = checkTier(s, o.grades.A, o, now), failB = checkTier(s, o.grades.B, o, now);
  let grade = !failA.length ? 'A' : !failB.length ? 'B' : null, via = grade ? 'record' : null;
  if (!grade && byClose(s, failB, o)) { grade = 'B'; via = 'clv'; }
  const notTailable = grade ? [] : failB;
  return {
    grade, via, label: grade ? o.grades[grade].label : null, marketMaker: s.twoSided > o.maxTwoSided + EPS || roundTripper(s, o),
    // sized on the closing lines' edge when they're what earned the grade
    edge: via === 'clv' ? Math.max(s.edge ?? 0, s.clvEdge ?? 0) : s.edge,
    reasons: notTailable.map(x => x.text), failed: notTailable.map(x => x.code),
    whyNotA: grade === 'A' ? [] : failA.map(x => x.text), failedA: grade === 'A' ? [] : failA.map(x => x.code),
  };
}

// closed: raw settled rows (v2 CLOSED, REDEEMABLE, REDEEMABLE_LOST; v1 closed);
// open: raw open rows; trades: raw or parsed (they add activity times and
// two-sided evidence); selectedAt: when the wallet became a candidate (bets
// resolved after it are its forward record); clv: measured closing-line
// samples (clvOf), or nothing when not measured. A category with clvMinN
// samples of its own is graded on them, otherwise on the wallet's. opts may
// carry `now`.
// A graded wallet's live positions, biggest first: what the Sharp Board adds
// up. Settled or all-but-settled ones (priced 2¢ or less, 98¢ or more) are
// left out: there's nothing left to tail.
function holdingsOf(rows, { max = DEFAULTS.holdingsMax, minCost = 1 } = {}) {
  return (rows || [])
    .filter(r => r && r.conditionId && r.asset != null && r.size > 0 && !r.redeemable
      && !(r.curPrice != null && (r.curPrice <= 0.02 || r.curPrice >= 0.98)))
    .map(r => {
      // what is still held: shares now × average price (a position's total
      // cost also counts shares already sold)
      const cost = r.price != null ? r.size * r.price : r.totalBought > 0 && r.cost != null ? r.cost * (r.size / r.totalBought) : null;
      return {
        conditionId: r.conditionId, asset: String(r.asset), outcome: r.outcome ?? null, outcomeIndex: r.outcomeIndex ?? null,
        title: r.title || '', slug: r.slug || '', eventSlug: r.eventSlug || '', category: r.category || 'other',
        size: round(r.size, 4), price: r.price != null ? round(r.price, 6) : cost != null ? round(cost / r.size, 6) : null,
        cost: cost != null ? round(cost, 2) : null, curPrice: r.curPrice ?? null, endDate: r.endDate ?? null, enteredAt: r.enteredAt ?? null,
      };
    })
    .filter(h => h.cost != null && h.cost >= minCost)
    .sort((a, b) => b.cost - a.cost)
    .slice(0, max);
}

function scoreWallet({ wallet, name = null, closed = [], open = [], trades = [], selectedAt = null, clv = null, play = null } = {}, { now = Date.now(), ...opts } = {}) {
  const o = resolveOptions(opts);
  const since = toMs(selectedAt);
  const { closedRows, openRows, resolved: settled, stillOpen } = resolvedPositions(closed, open, now);
  // round trips aren't bets: out of the record, but counted (and still held both sides)
  const trips = settled.filter(p => isRoundTrip(p, o));
  const resolved = trips.length ? settled.filter(p => !isRoundTrip(p, o)) : settled;
  const tradeRows = parseTrades(trades);
  const buys = tradeRows.filter(t => t.side === 'BUY').map(t => ({ ...t, category: classify(t) }));
  const holdings = [...settled, ...openRows, ...buys];
  const samples = Array.isArray(clv) ? clv.filter(x => Number.isFinite(x?.clv)) : [];

  // activity is the wallet's own trades, closes and entries, not a market's end date
  let lastAt = null;
  for (const x of [...closedRows, ...openRows]) if (x.activeAt != null && x.activeAt <= now) lastAt = Math.max(lastAt ?? 0, x.activeAt);
  for (const x of tradeRows) if (x.at != null && x.at <= now) lastAt = Math.max(lastAt ?? 0, x.at);
  const overall = { ...walletStats(resolved, { holdings, open: stillOpen, since, now, clvSamples: samples, play, opts: o }) };
  overall.lastAt = lastAt;
  overall.roundTrips = trips.length;
  overall.roundTripShare = settled.length ? trips.length / settled.length : 0;
  const g = gradeStats(overall, o, now);
  overall.edge = g.edge;

  const categories = {};
  for (const cat of CATEGORIES) {
    const list = resolved.filter(p => p.category === cat);
    if (!list.length) continue;
    const own = samples.filter(x => x.category === cat);
    const clvScope = own.length >= o.clvMinN ? 'category' : 'wallet';
    const cs = walletStats(list, {
      holdings: holdings.filter(h => h.category === cat), open: stillOpen.filter(r => r.category === cat), since, now,
      clvSamples: clvScope === 'category' ? own : samples, play: cat === 'sports' ? play : null, opts: o,
    });
    // a market maker is out everywhere; being active anywhere counts as active
    const cg = gradeStats({ ...cs, twoSided: Math.max(cs.twoSided, overall.twoSided), roundTrips: overall.roundTrips, roundTripShare: overall.roundTripShare, activeAt: lastAt }, o, now);
    cs.edge = cg.edge;
    categories[cat] = { ...presentStats(cs), clvScope, grade: cg.grade, via: cg.via, label: cg.label, reasons: cg.reasons, failed: cg.failed, whyNotA: cg.whyNotA, failedA: cg.failedA };
  }

  const w = lower(wallet);
  return {
    id: w, wallet: w, name: name || tradeRows.find(t => t.name)?.name || null, url: profileUrl(w),
    grade: g.grade, via: g.via, label: g.label, tailable: !!g.grade, marketMaker: g.marketMaker,
    reasons: g.reasons, failed: g.failed, whyNotA: g.whyNotA, failedA: g.failedA,
    ...presentStats(overall), categories,
    openPositions: stillOpen.length, openValue: round(stillOpen.reduce((a, r) => a + (r.currentValue || 0), 0), 2),
    // only a wallet worth tailing keeps its book (the Sharp Board reads it)
    ...(g.grade || Object.values(categories).some(c => c.grade) ? { holdings: holdingsOf(stillOpen, { max: o.holdingsMax }) } : {}),
    ...(Array.isArray(clv) ? { clvSamples: samples } : {}),
    ...(play ? { play: { games: num(play.games) || 0, inPlay: num(play.inPlay) || 0 } } : {}),
    selectedAt: iso(since), scoredAt: iso(now), rulesVersion: RULES_VERSION,
  };
}

// A stored score from older rules, until it's rescored, overall and per
// category: no grade if it predates the stake fix, else at most B (it has no
// closing-line value).
const STALE_NOTE = 'scored by older rules: rescoring';
const STAKE_NOTE = 'scored before the stake fix: rescoring';
const TRIP_NOTE = 'scored before round trips were left out: rescoring';
function capStale(tr, opts = {}) {
  if (!tr || tr.rulesVersion === RULES_VERSION) return tr;
  const o = resolveOptions(opts);
  const before = !(tr.rulesVersion >= ROUND_TRIP_VERSION);
  const note = tr.rulesVersion >= STAKE_FIX_VERSION ? TRIP_NOTE : STAKE_NOTE;
  const cap = x => (!x?.grade ? x
    : before ? { ...x, grade: null, label: null, reasons: [note, ...(x.reasons || [])], failed: ['stale', ...(x.failed || [])] }
      : x.grade === 'A' ? { ...x, grade: 'B', label: o.grades.B.label, whyNotA: [STALE_NOTE, ...(x.whyNotA || [])] } : x);
  const categories = {};
  for (const [cat, c] of Object.entries(tr.categories || {})) categories[cat] = cap(c);
  const top = cap(tr);
  return { ...top, tailable: !!top.grade, categories, staleRules: true };
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
  const bar = trader.via === 'clv' ? 0 : o.grades.B.minRoi;   // graded by its closing lines: a category only has to be in profit
  if (c && c.n >= o.catBadMinN && !(c.pnl > 0 && c.roi != null && c.roi >= bar - EPS)) {
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

// Units for a bet on an outcome we put at probability q, bought at `price`
// with a fee of feePerContract a contract, from a wallet of `grade`, with
// `consensus` graded wallets (a count, or their list) on the same side.
// The same at every venue and for everyone. → { kelly, units, maxPrice, cost,
// cap }: kelly null when there is no price to buy at; maxPrice the highest
// price (to the cent) still worth paying with that fee, null when none is.
function sizeAt({ q, price, feePerContract = 0, grade, consensus = 1, opts = {} } = {}) {
  const o = resolveOptions(opts);
  const prob = num(q), p = num(price);
  const fee = Math.max(0, num(feePerContract) ?? 0);
  const tier = o.grades[String(grade || '').toUpperCase()] || null;
  const voters = Array.isArray(consensus) ? new Set(consensus.map(lower).filter(Boolean)).size : num(consensus) ?? 1;
  const isConsensus = voters >= o.consensusMin;
  const base = tier ? tier.capUnits : 0;
  const cap = isConsensus ? Math.min(base * o.consensusMult, o.maxUnits) : base;
  const ok = prob > 0 && prob < 1;
  // Kelly > 0 ⇔ price + fee < q: the last whole cent under q − fee
  const top = ok ? (Math.ceil((prob - fee) * 100 - 1e-7) - 1) / 100 : null;
  const maxPrice = top != null && top >= 0.01 ? Math.min(round(top, 2), 0.99) : null;
  if (!ok || !(p > 0 && p < 1) || !(p + fee < 1)) return { kelly: null, units: 0, maxPrice, cost: p > 0 ? p + fee : null, cap };
  const cost = p + fee;
  const kelly = (prob - cost) / (1 - cost);
  let units = 0;
  if (kelly > EPS && tier) {
    units = Math.min(Math.max(o.kellyFraction * kelly * o.bankrollUnits, 0), base);
    if (isConsensus) units = Math.min(units * o.consensusMult, o.maxUnits);
    units = round(units, 2);
  }
  return { kelly, units, maxPrice, cost, cap };
}

// trade: a parsed trade; trader: a scoreWallet result; market: a parsed gamma
// market (null when the lookup failed); book: the bought token's parsed CLOB
// book (null when it couldn't be read: then Gamma's price, if fresh); consensus: other graded wallets that
// bought the same outcome inside the window; prior: { id, units } when we
// already tailed this wallet into this outcome (then only the top-up up to
// the new size is staked); against: graded wallets (this one included) that
// bought another outcome of the same market inside the window; event:
// { key, units } told across this game or event so far. → { signal, skip }. The signal carries q (our
// probability of the outcome bought) and is sized with sizeAt at Polymarket's
// ask plus its taker fee, so the same q sizes it at any other venue.
function tradeSignal({ trade, trader, market = null, book = null, consensus = [], against = [], prior = null, event = null, now = Date.now(), opts = {} } = {}) {
  const o = resolveOptions(opts);
  const skip = reason => ({ signal: null, skip: reason });
  if (!trade || !trader) return skip('not graded');
  const category = classify(trade);
  const tier = gradeFor(trader, category, o);
  if (!tier.grade) return skip(tier.skip);
  if (!(trade.notional >= o.minTrade - EPS)) return skip(`under ${money(o.minTrade)}`);
  if (trade.at != null && now - trade.at > o.maxTradeAgeMs) return skip('stale trade');

  const eventSlug = trade.eventSlug || market?.eventSlug || trade.slug || null;
  const base = {
    id: trade.key, wallet: trader.wallet, name: trader.name || trade.name || null, grade: tier.grade, scope: tier.scope, category,
    market: trade.title || market?.question || '', eventSlug, conditionId: trade.conditionId, asset: trade.asset,
    outcome: trade.outcome, outcomeIndex: trade.outcomeIndex,
    theirPrice: trade.price, theirSize: round(trade.size, 4), theirNotional: round(trade.notional, 2),
    at: iso(trade.at ?? now), seenAt: iso(now), url: eventUrl(eventSlug),
  };
  if (trade.side === 'SELL') return { signal: { ...base, type: 'exit' }, skip: null };
  if (trade.side !== 'BUY') return skip('unknown side');
  if (market) {
    if (market.closed || !market.active) return skip('market closed');
    // a game's end date is its start, and it resolves hours later: a buy
    // minutes before kick-off still counts (one after it is blocked below)
    const end = toMs(market.gameStartTime) == null ? toMs(market.endDate) : null;
    if (end != null && end - now < o.minCloseMs) return skip(`market resolves within ${Math.round(o.minCloseMs / 60e3)} min`);
  }

  const live = liveAsk(market, book, trade, { now, opts: o });
  const p = trade.price, c = live.price;
  // bought after the game started (in-play), or at a price with little left
  // to win: not a tail at any venue (blocked), whatever the edge says
  const started = toMs(market?.gameStartTime);
  const inPlay = started != null && (trade.at ?? now) >= started;
  const wallets = [...new Set([trader.wallet, ...(consensus || []).map(lower).filter(Boolean)])];
  const isConsensus = wallets.length >= o.consensusMin;
  // graded money on the other side of this market, as much as on this one:
  // following both sides pays the spread twice for no edge
  const opposed = [...new Set((against || []).map(lower).filter(Boolean))];
  const split = opposed.length > 0 && opposed.length >= wallets.length;
  const blocked = inPlay && !o.sizeInPlay ? 'in-play' : p >= o.maxEntryPrice - EPS ? 'near-certain' : split ? 'split' : null;
  const scoped = tier.scope === 'category' ? trader.categories?.[category] : trader;
  const q = Math.min(o.maxProb, trueProb(p, tier.edge, num(scoped?.avgEntry) ?? 0.5));
  const fee = c == null ? null : polymarketFee(c, market?.fee);
  const sized = sizeAt({ q, price: c, feePerContract: fee ?? 0, grade: tier.grade, consensus: wallets.length, opts: o });
  let units = 0, reason = null, target = 0;
  const kelly = c == null ? null : sized.kelly;
  if (blocked === 'in-play') reason = 'in-play bet: live prices move faster than anyone can follow';
  else if (blocked === 'split') {
    reason = opposed.includes(lower(trader.wallet)) ? 'it also bought the other side: a hedge, not a pick'
      : `graded sharps split: ${opposed.length} on the other side of this market`;
  } else if (blocked || (c ?? 0) >= o.maxEntryPrice - EPS) reason = `at ${Math.round(o.maxEntryPrice * 100)}¢+ there's little to win and everything to lose`;
  else if (c == null) reason = 'no live price: check it before following';
  else if (c - p > o.chaseMax + EPS || !(kelly > EPS)) reason = "price ran, don't chase";
  else {
    units = target = sized.units;
    if (!(units > 0)) reason = 'edge too small to size';
  }
  const before = num(prior?.units) > 0 ? num(prior.units) : 0;
  if (before > 0 && target > 0) {
    units = round(Math.max(0, target - before), 2);
    if (!(units > 0)) reason = `already tailed at ${before}u`;
  }
  // one game's markets move together (its winner, spread, total): what's
  // told across them is capped, whichever wallets bought
  const told = num(event?.units) > 0 ? num(event.units) : 0;
  const room = o.maxEventUnits > 0 ? round(Math.max(0, o.maxEventUnits - told), 2) : null;
  if (room != null && units > room + EPS) {
    units = room;
    if (!(units > 0)) reason = `already ${round(told, 2)}u on this ${category === 'sports' ? 'game' : 'event'} (max ${o.maxEventUnits}u)`;
  }
  return {
    signal: {
      ...base, type: 'entry', currentPrice: c, priceSource: live.source, slippage: c == null ? null : round(c - p, 4), edge: round(tier.edge, 4),
      inPlay, gameStartTime: started == null ? null : iso(started), blocked,
      q, prob: round(q, 4), fee: fee == null ? null : round(fee, 6), feeRate: market?.fee?.rate ?? 0, maxPrice: sized.maxPrice,
      kelly: round(kelly, 4), units, target, cap: sized.cap,
      parentId: before > 0 ? prior.id ?? null : null, topUp: before > 0, priorUnits: before,
      eventKey: event?.key ?? null, eventUnits: round(told, 2), eventRoom: room,
      consensus: wallets, isConsensus, against: opposed, reason,
    },
    skip: null,
  };
}

// ── fetching ──
// Everything from the data API is v2. Polymarket throttles per IP (v2 800 per
// 10s, trades 300, positions 200, prices history 200); the server's polite
// queue keeps us far under that.
const TIMEOUT = 10000;

// One v2 list: follows pagination.next_cursor (sent back as `cursor`) until
// it runs out, a page comes back empty, or maxPages. A cursor that doesn't
// move ends it too. → { rows (raw), truncated (pages were left), pages }
async function fetchPaged(http, url, params, { what = 'list', maxPages = 1 } = {}) {
  const rows = [];
  let cursor = null;
  for (let page = 0; page < Math.max(1, maxPages); page++) {
    const res = await http.get(url, { params: cursor ? { ...params, cursor } : params, timeout: TIMEOUT });
    const got = rowsOrThrow(res?.data, what);
    rows.push(...got);
    const next = nextCursor(res?.data);
    if (!next || !got.length) return { rows, truncated: false, pages: page + 1 };
    if (next === cursor) return { rows, truncated: true, pages: page + 1 };
    cursor = next;
  }
  return { rows, truncated: true, pages: Math.max(1, maxPages) };
}

// categories × periods, deduped by wallet; one failing call doesn't sink the rest
async function fetchLeaderboard(http, { categories = LEADERBOARD_CATEGORIES, periods = LEADERBOARD_PERIODS, limit = 50 } = {}) {
  const byWallet = new Map(), errors = [];
  for (const category of categories) {
    for (const timePeriod of periods) {
      const key = `${String(category).toUpperCase()}:${String(timePeriod).toUpperCase()}`;
      try {
        const res = await http.get(`${DATA_API}/v2/leaderboard`, {
          params: { category: lower(category), time_period: lower(timePeriod), sort_by: 'PNL', limit: Math.min(limit, PAGE_MAX) }, timeout: TIMEOUT,
        });
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

// One wallet's positions of one status, newest first: sorted by time, since
// CLOSED otherwise sorts by realized P&L and a capped list would keep only
// the biggest winners. Unclaimed lists ask for archived positions too: a
// loss on an archived market is still a loss. (CLOSED with include_archived
// is a 400 from the live API, so it's only sent where it's accepted, and a
// 400 is retried without it.) → { rows (raw), truncated }
const ARCHIVED_OK = new Set(['REDEEMABLE', 'REDEEMABLE_LOST']);
async function fetchPositions(http, wallet, { status = 'OPEN', pageSize = 500, maxPages = 1 } = {}) {
  const params = { user: wallet, status, limit: Math.max(1, Math.min(pageSize, PAGE_MAX)), sort_by: 'TIMESTAMP', sort_direction: 'DESC' };
  if (ARCHIVED_OK.has(status)) params.include_archived = true;
  const what = `${lower(status)} positions`;
  let r;
  try { r = await fetchPaged(http, `${DATA_API}/v2/positions`, params, { what, maxPages }); }
  catch (e) {
    if (e?.response?.status !== 400 || !params.include_archived) throw e;
    const { include_archived, ...plain } = params;
    r = await fetchPaged(http, `${DATA_API}/v2/positions`, plain, { what, maxPages });
  }
  // each row says which list it came from, whether or not the API does
  return { rows: r.rows.map(x => (x && typeof x === 'object' && x.status == null ? { ...x, status } : x)), truncated: r.truncated };
}

// A wallet's settled record: CLOSED, REDEEMABLE and REDEEMABLE_LOST. When a
// list hits its page cap the others are cut to the same stretch of time, so
// a capped list of winners never sits beside a full history of losers.
// → { rows (raw, each with its status), truncated, counts: { status: n } }
const sortTime = r => toMs(pick(r?.last_event_at, r?.lastEventAt, r?.timestamp, r?.first_entry_at, r?.firstEntryAt, r?.end_date, r?.endDate));
async function fetchSettledPositions(http, wallet, { pageSize = DEFAULTS.closedPageSize, maxPages = DEFAULTS.closedMaxPages, statuses = SETTLED_STATUSES } = {}) {
  const lists = [];
  for (const status of statuses) lists.push({ status, ...await fetchPositions(http, wallet, { status, pageSize, maxPages }) });
  let cut = null;
  for (const l of lists) {
    if (!l.truncated) continue;
    const times = l.rows.map(sortTime).filter(t => t != null);
    if (times.length) cut = Math.max(cut ?? -Infinity, Math.min(...times));
  }
  const keep = r => cut == null || sortTime(r) == null || sortTime(r) >= cut;
  const rows = [], counts = {};
  for (const l of lists) {
    const kept = l.rows.filter(keep);
    counts[l.status] = kept.length;
    rows.push(...kept);
  }
  return { rows, truncated: lists.some(l => l.truncated), counts };
}
// round-1 name
const fetchClosedPositions = fetchSettledPositions;

async function fetchOpenPositions(http, wallet, { pageSize = 500, maxPages = DEFAULTS.openMaxPages } = {}) {
  return fetchPositions(http, wallet, { status: 'OPEN', pageSize, maxPages });
}

// Global recent big trades (taker side) → parsed. The bare global feed only
// covers this month and last, and filter_type defaults to TOKENS, so CASH is
// always sent. Same request as whales.js, so the server's queue shares it.
async function fetchRecentTrades(http, { limit = 500, minCash = DEFAULTS.minTrade } = {}) {
  const res = await http.get(`${DATA_API}/v2/trades`, {
    params: { limit: Math.min(limit, PAGE_MAX), taker_only: true, filter_type: 'CASH', filter_amount: minCash }, timeout: TIMEOUT,
  });
  return parseTrades(rowsOrThrow(res.data, 'trades'));
}

// one wallet's trades, maker fills included → parsed
async function fetchWalletTrades(http, wallet, { limit = DEFAULTS.walletTradeLimit } = {}) {
  const res = await http.get(`${DATA_API}/v2/trades`, { params: { user: wallet, limit: Math.min(limit, PAGE_MAX), taker_only: false }, timeout: TIMEOUT });
  return parseTrades(rowsOrThrow(res.data, 'trades'));
}

// one token's prices between start and end (ms), one call → parsePriceHistory
async function fetchPriceHistory(http, tokenId, { start = null, end = null, bucketSeconds = DEFAULTS.clvBucketSeconds, limit = DEFAULTS.clvPointLimit } = {}) {
  const params = { token_id: String(tokenId), bucket_seconds: Math.max(60, Math.min(86400, Math.round(bucketSeconds))), limit };
  if (start != null) params.start = Math.floor(start / 1000);
  if (end != null) params.end = Math.ceil(end / 1000);
  const res = await http.get(`${DATA_API}/v2/prices-history`, { params, timeout: TIMEOUT });
  return parsePriceHistory(res?.data, { strict: true });
}

async function fetchMarket(http, conditionId) {
  const res = await http.get(`${GAMMA_API}/markets`, { params: { condition_ids: conditionId }, timeout: TIMEOUT });
  const list = parseGammaMarkets(rowsOrThrow(res.data, 'markets'));
  // hex ids may differ in case between the data API and Gamma
  return list.find(m => lower(m.conditionId) === lower(conditionId)) || null;
}

// ── engine ──
const GRADE_RANK = { A: 0, B: 1 };
// a Map used as a bounded cache: the oldest entry goes first
function remember(map, key, value, max = Infinity) {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) map.delete(map.keys().next().value);
  return value;
}
const isGraded = tr => !!tr?.grade || Object.values(tr?.categories || {}).some(c => c.grade);
const closeWorthy = tr => [tr, ...Object.values(tr?.categories || {})].some(x => x && !x.grade && closeCanGrade(x.failed || [], x.roi));
const fromLeaderboard = c => (c?.sources || []).some(s => s !== 'trade');
// Scores that matter: graded somewhere, or a real profitable sample that may
// get there. They're kept in full, persisted and rescored first; the rest
// shrink to a summary (the leaderboard still lists them, with reasons).
const nearGraded = (tr, o) => isGraded(tr) || (tr?.n >= o.grades.B.minN && tr?.roi > 0 && !tr?.marketMaker);
const SUMMARY_KEYS = ['id', 'wallet', 'name', 'url', 'grade', 'via', 'label', 'tailable', 'marketMaker', 'reasons', 'failed', 'n', 'events',
  'risked', 'pnl', 'roi', 'z', 'winRate', 'avgEntry', 'concentration', 'twoSided', 'activeDays', 'lastAt', 'recentN', 'recentRoi', 'edge',
  'clv', 'clvN', 'clvHitRate', 'selectedAt', 'scoredAt', 'rulesVersion', 'sources', 'truncated'];
function summaryOf(tr) {
  const out = { compact: true, whyNotA: [], failedA: [], categories: {} };
  for (const k of SUMMARY_KEYS) if (tr[k] !== undefined) out[k] = tr[k];
  for (const [cat, c] of Object.entries(tr.categories || {})) out.categories[cat] = { n: c.n, roi: c.roi, z: c.z, grade: c.grade ?? null, label: c.label ?? null };
  return out;
}

// Second chances, from Sharp Board rows: a side graded sharps still hold
// whose live order-book price is back at or under what they paid on average.
// One alert when it gets there (not one a scan), and again for that side only
// after cooldownMs. Two or more sharps, or an A, before it's worth a ping. The
// first scan after a start only learns where things are (prime).
// state: Map key → { below, alertedAt }. → { alerts, state }
function boardAlerts(rows, state = new Map(), { now = Date.now(), cooldownMs = 6 * 3600e3, minWallets = 2, prime = false } = {}) {
  const alerts = [], next = new Map();
  for (const r of rows || []) {
    const L = r?.lead;
    if (!L?.asset || !r.conditionId) continue;
    const key = `${r.conditionId}|${L.asset}`;
    const prev = state.get(key);
    const below = !!L.belowEntry && L.priceSource === 'book';
    const rec = { below, alertedAt: prev?.alertedAt ?? null };
    const worthy = L.wallets >= minWallets || L.A > 0;
    if (below && worthy && !prime && !prev?.below && (rec.alertedAt == null || now - rec.alertedAt >= cooldownMs)) {
      rec.alertedAt = now;
      alerts.push({
        type: 'entry-price', id: `${key}|${now}`, at: new Date(now).toISOString(), conditionId: r.conditionId, title: r.title, slug: r.slug, eventSlug: r.eventSlug,
        category: r.category, outcome: L.outcome, outcomeIndex: L.outcomeIndex, asset: L.asset, wallets: L.wallets, A: L.A, B: L.B, cost: L.cost,
        avgEntry: L.avgEntry, price: L.price, against: r.against, agreement: r.agreement, list: L.list,
      });
    }
    next.set(key, rec);
  }
  // a side that dropped off the board keeps its cooldown
  for (const [k, v] of state) if (!next.has(k) && v.alertedAt != null && now - v.alertedAt < cooldownMs) next.set(k, { below: false, alertedAt: v.alertedAt });
  return { alerts, state: next };
}

function createTailEngine({ http, store = null, now = () => Date.now(), opts = {}, log = console } = {}) {
  const o = resolveOptions(opts);
  const candidates = new Map();   // wallet → { wallet, name, pnl, vol, sources, fromTrade, addedAt, selectedAt, scoredAt, failedAt }
  const traders = new Map();      // wallet → scoreWallet result (a summary for untailable ones)
  const persisted = new Set();    // wallets with a doc in the store
  const sightings = new Map();    // unknown wallet → big trades seen; enough of them queue it
  const seen = new Map();         // trade key → trade time (ms)
  const buys = new Map();         // asset → [{ wallet, at }] of graded buys, for consensus
  const marketBuys = new Map();   // conditionId → [{ wallet, asset, at }] of graded buys, for splits
  const eventTold = new Map();    // game or event → [{ units, at }] told to followers, for the per-game cap
  const tailed = new Map();       // wallet|asset → { id, units, at }: the size followers were already told
  const quotes = new Map();       // conditionId → { at, market }
  const books = new Map();        // token → { at, book }
  const closes = new Map();       // token → its closing line { price, at, cut, rule }, or null when it has none
  const lookups = new Map();      // conditionId → parsed Gamma market (or null) for CLV: game start, close time
  let feed = [];                  // signals, newest first
  let watchIdx = 0;
  const busy = { refresh: false, score: false, poll: false };
  const health = { lastRefreshAt: null, lastScoreAt: null, lastPollAt: null, lastSignalAt: null, lastClvAt: null, clvRequests: 0, errors: [] };
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
      const stale = tr.rulesVersion !== RULES_VERSION;
      traders.set(tr.wallet, capStale(tr, o));
      persisted.add(tr.wallet);
      // closes measured before the restart don't cost a request again
      for (const x of tr.clvSamples || []) {
        if (x?.asset && Number.isFinite(x.close)) remember(closes, x.asset, { price: x.close, at: toMs(x.closeAt), cut: toMs(x.cutAt), rule: x.rule || null }, o.clvCacheMax);
      }
      // older rules: due now
      const scoredAt = stale ? 0 : Date.parse(tr.scoredAt) || null;
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

  // A market's game start and close time, for closing lines. Settled markets
  // don't change, so one lookup each (a failed one isn't remembered).
  async function lookup(conditionId) {
    if (lookups.has(conditionId)) return lookups.get(conditionId);
    health.clvRequests++;
    return remember(lookups, conditionId, await fetchMarket(http, conditionId), o.clvCacheMax);
  }

  // One position's token's close (→ { price, at, cut, rule } | null), cached,
  // from one price history call. Throws when a lookup fails (tried again next time).
  async function closeFor(p, t) {
    let close = closes.get(p.asset);
    if (close === undefined) {
      const market = p.conditionId ? await lookup(p.conditionId) : null;
      const win = clvWindow(p, market, { now: t, opts: o });
      close = null;
      if (win) {
        health.clvRequests++;
        const h = await fetchPriceHistory(http, p.asset, { start: win.start, end: win.end, bucketSeconds: o.clvBucketSeconds, limit: o.clvPointLimit });
        const c = closingPrice(h.points, { closeAt: win.end, freeze: win.rule === 'freeze', truncated: h.truncated, maxGapMs: win.rule === 'game' ? o.clvMaxGapMs : null });
        if (c) close = { ...c, rule: win.rule };
      }
      remember(closes, p.asset, close, o.clvCacheMax);
    }
    return close;
  }

  // closing-line samples for a wallet's most recent settled bets, and how
  // many of the game bets among them were placed after the start
  async function measureClv(resolved, t) {
    const picks = clvCandidates(resolved, o.clvSample);
    const samples = [], errors = [], play = { games: 0, inPlay: 0 };
    for (const p of picks) {
      try {
        const close = await closeFor(p, t);
        if (close?.rule === 'game' && p.enteredAt != null) {
          play.games++;
          if (p.enteredAt >= close.cut) play.inPlay++;
        }
        const x = clvOf(p, close);
        if (x) samples.push(x);
      } catch (e) { errors.push(e?.message || String(e)); }
    }
    health.lastClvAt = iso(now());
    return { samples, errors, tried: picks.length, play };
  }

  async function scoreOne(c) {
    const [settled, open, trades] = await Promise.all([
      fetchSettledPositions(http, c.wallet, { pageSize: o.closedPageSize, maxPages: o.closedMaxPages }),
      fetchOpenPositions(http, c.wallet, { maxPages: o.openMaxPages }),
      fetchWalletTrades(http, c.wallet, { limit: o.walletTradeLimit }),
    ]);
    const t = now();
    const input = { wallet: c.wallet, name: c.name, closed: settled.rows, open: open.rows, trades, selectedAt: c.selectedAt };
    let score = scoreWallet(input, { ...o, now: t });
    // a history doesn't shrink: far fewer bets than last time is a bad read
    const prev = traders.get(c.wallet);
    if (prev?.n >= 20 && score.n < prev.n / 2) throw new Error(`only ${score.n} resolved bets came back (had ${prev.n}), kept the last score`);
    // closing lines cost a request a bet: only for wallets good enough without
    // them, or that they could grade (in profit, failing only luck or ROI)
    if (isGraded(score) || closeWorthy(score)) {
      const m = await measureClv(resolvedPositions(settled.rows, open.rows, t).resolved.filter(p => !isRoundTrip(p, o)), t);
      if (m.errors.length) warn(`clv ${c.wallet}: ${m.errors.length} of ${m.tried} lookups failed (${m.errors[0]})`);
      score = scoreWallet({ ...input, clv: m.samples, play: m.play }, { ...o, now: t });
    }
    score = { ...score, truncated: settled.truncated || open.truncated, sources: [...c.sources] };
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

  // A few wallets per call (each costs 5+ requests, up to 2 × clvSample more
  // the first time a graded one is scored) so a cron spreads the work.
  async function scoreBatch(n = o.batchSize) {
    await loaded;
    if (busy.score) return { busy: true, scored: 0, wallets: [], pending: pendingCount() };
    busy.score = true;
    try {
      const done = [], t0 = now(), list = queue().slice(0, Math.max(0, n));
      let next = 0;
      // a few wallets at once: each spends most of its time waiting on replies
      const worker = async () => {
        while (next < list.length) {
          if (next && now() - t0 > o.scoreBudgetMs) return;
          const i = next++, c = list[i];
          try { await scoreOne(c); done[i] = c.wallet; }
          catch (e) { c.failedAt = now(); warn(`score ${c.wallet}: ${e?.message || e}`); }
        }
      };
      await Promise.all(Array.from({ length: Math.max(1, Math.min(Math.round(o.scoreConcurrency) || 1, list.length)) }, worker));
      const wallets = done.filter(Boolean);   // in queue order
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

  // A graded wallet's trade after it was scored moves its book: a buy adds to
  // (or opens) the position, a sell takes from it. Trades from before the
  // score are already in the positions it was scored on.
  function noteHolding(trader, tr) {
    if (!Array.isArray(trader.holdings) || !tr.asset || !(tr.size > 0)) return;
    const scored = toMs(trader.scoredAt);
    if (scored != null && tr.at != null && tr.at <= scored) return;
    const i = trader.holdings.findIndex(h => h.asset === String(tr.asset));
    const h = i >= 0 ? trader.holdings[i] : null;
    if (tr.side === 'BUY') {
      if (h) {
        h.size = round(h.size + tr.size, 4);
        h.cost = round((h.cost || 0) + tr.notional, 2);
        h.price = round(h.cost / h.size, 6);
        h.curPrice = tr.price;
      } else {
        trader.holdings.push({
          conditionId: tr.conditionId, asset: String(tr.asset), outcome: tr.outcome ?? null, outcomeIndex: tr.outcomeIndex ?? null,
          title: tr.title || '', slug: tr.slug || '', eventSlug: tr.eventSlug || '', category: classify(tr),
          size: round(tr.size, 4), price: tr.price, cost: round(tr.notional, 2), curPrice: tr.price, endDate: null, enteredAt: tr.at ?? now(),
        });
        if (trader.holdings.length > o.holdingsMax) trader.holdings.sort((a, b) => b.cost - a.cost).length = o.holdingsMax;
      }
    } else if (tr.side === 'SELL' && h) {
      const left = h.size - tr.size;
      if (left <= EPS) trader.holdings.splice(i, 1);
      else { h.cost = round(h.cost * (left / h.size), 2); h.size = round(left, 4); h.curPrice = tr.price; }
    }
  }

  // Where the graded wallets are positioned right now, market by market: the
  // side with the most sharp weight (A counts twice), what they paid, what
  // it costs now, and how much sharp money sits on the other side.
  // → [{ conditionId, title, category, wallets, lead: { outcome, asset, wallets, A, B, cost, avgEntry, price, belowEntry, list }, against, agreement }]
  // livePrice(asset): a fresh order-book ask for that token, when the caller has one
  function sharpBoard({ category = null, limit = 50, minCost = o.boardMinCost, minWallets = 1, livePrice = null } = {}) {
    const t = now();
    const markets = new Map();
    for (const tr of traders.values()) {
      if (tr.marketMaker || !Array.isArray(tr.holdings) || !tr.holdings.length) continue;
      for (const h of tr.holdings) {
        if (!(h.cost >= minCost - EPS) || !h.conditionId) continue;
        const cat = h.category || 'other';
        if (category && cat !== category) continue;
        const g = gradeFor(tr, cat, o);
        if (!g.grade) continue;
        const q = quotes.get(h.conditionId);
        const market = q && t - q.at < 10 * 60e3 ? q.market : null;
        if (market && (market.closed || resolutionOf(market) != null)) continue;
        let m = markets.get(h.conditionId);
        if (!m) markets.set(h.conditionId, m = { conditionId: h.conditionId, title: h.title, slug: h.slug, eventSlug: h.eventSlug, category: cat, endDate: h.endDate, sides: new Map(), market });
        let side = m.sides.get(h.asset);
        if (!side) m.sides.set(h.asset, side = { outcome: h.outcome, outcomeIndex: h.outcomeIndex, asset: h.asset, list: [], cost: 0, size: 0, weight: 0, price: null, priceSeen: null });
        side.list.push({ wallet: tr.wallet, name: tr.name || null, grade: g.grade, edge: g.edge ?? null, cost: h.cost, avgPrice: h.price });
        side.cost += h.cost;
        side.size += h.size;
        side.weight += g.grade === 'A' ? 2 : 1;
        if (h.curPrice != null) side.price = h.curPrice;
      }
    }
    const rows = [];
    for (const m of markets.values()) {
      const sides = [...m.sides.values()].sort((a, b) => (b.weight - a.weight) || (b.cost - a.cost));
      const lead = sides[0];
      const wallets = new Set(sides.flatMap(x => x.list.map(w => w.wallet))).size;
      if (lead.list.length < minWallets) continue;
      const booked = typeof livePrice === 'function' ? inUnit(Number(livePrice(lead.asset))) : null;
      const live = booked ?? (m.market ? liveAsk(m.market, null, lead, { now: t, opts: o }).price : null);
      const price = inUnit(live) ? live : lead.price;
      const avgEntry = lead.size > 0 ? round(lead.cost / lead.size, 4) : null;
      const total = sides.reduce((a, x) => a + x.cost, 0);
      const others = sides.slice(1);
      rows.push({
        conditionId: m.conditionId, title: m.title, slug: m.slug, eventSlug: m.eventSlug, category: m.category, endDate: m.endDate, wallets,
        lead: {
          outcome: lead.outcome, outcomeIndex: lead.outcomeIndex, asset: lead.asset, wallets: lead.list.length,
          A: lead.list.filter(w => w.grade === 'A').length, B: lead.list.filter(w => w.grade === 'B').length,
          cost: round(lead.cost, 2), avgEntry, price: price ?? null, priceSource: booked != null ? 'book' : inUnit(live) ? 'gamma' : 'positions',
          belowEntry: price != null && avgEntry != null && price <= avgEntry + EPS,
          list: lead.list.sort((a, b) => b.cost - a.cost),
        },
        against: { wallets: others.reduce((a, x) => a + x.list.length, 0), cost: round(others.reduce((a, x) => a + x.cost, 0), 2) },
        agreement: total > 0 ? round(lead.cost / total, 4) : null,
        score: round(lead.weight - others.reduce((a, x) => a + x.weight, 0), 2),
      });
    }
    rows.sort((a, b) => (b.score - a.score) || (b.lead.wallets - a.lead.wallets) || (b.lead.cost - a.lead.cost));
    return rows.slice(0, Math.max(0, limit));
  }

  // the token's live book, cached like the market; null when it can't be read
  async function bookFor(asset) {
    if (asset == null) return null;
    const t = now();
    const hit = books.get(String(asset));
    if (hit && t - hit.at < o.quoteTtlMs) return hit.book;
    let book = null;
    try { book = await fetchBook(http, asset); }
    catch (e) { warn(`book ${asset}: ${e?.message || e}`); }
    books.set(String(asset), { at: t, book });
    return book;
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
    for (const m of [marketBuys, eventTold]) {
      for (const [k, list] of m) {
        const keep = list.filter(b => t - b.at <= o.consensusWindowMs);
        if (keep.length) m.set(k, keep); else m.delete(k);
      }
    }
    for (const [cid, q] of quotes) if (t - q.at > o.quoteTtlMs) quotes.delete(cid);
    for (const [k, b] of books) if (t - b.at > o.quoteTtlMs) books.delete(k);
  }

  // A game's markets share one key: its event (a soccer game's spreads and
  // totals sit in "<slug>-more-markets"), else the market.
  const eventKeyOf = tr => String(tr.eventSlug || tr.conditionId || tr.slug || tr.asset || '').replace(/-more-markets$/, '') || null;
  function eventUnits(key, t) {
    let units = 0;
    for (const x of eventTold.get(key) || []) if (t - x.at <= o.consensusWindowMs) units += x.units;
    return round(units, 2);
  }
  function noteEvent(signal, added) {
    const key = signal?.eventKey, u = num(added);
    if (!key || !(u > 0)) return;
    const list = eventTold.get(key) || [];
    list.push({ units: u, at: toMs(signal.at) ?? now() });
    eventTold.set(key, list);
  }

  // What followers were told for an entry: the units before it plus what it
  // added. Nothing at all: forgotten, so the next buy is a fresh signal.
  function noteTailed(signal, added = 0) {
    if (signal?.type !== 'entry' || !signal.wallet || signal.asset == null) return;
    const held = `${signal.wallet}|${signal.asset}`;
    const units = round((num(signal.priorUnits) > 0 ? num(signal.priorUnits) : 0) + Math.max(0, num(added) ?? 0), 2);
    if (units > 0) tailed.set(held, { id: signal.parentId ?? signal.id, units, at: toMs(signal.at) ?? now() });
    else tailed.delete(held);
  }

  // → the new signals (entries and exits) since the last poll, oldest first.
  // route(signal) → units, when given, sizes each entry where followers bet
  // (another venue's price) as it's made; those units are what later buys by
  // the same wallet top up. Without it, the size at Polymarket's ask.
  // The poll and the live stream hand trades to one lane, so a trade is
  // judged once and consensus sees them in order.
  let lane = Promise.resolve();
  function serial(fn) {
    const run = lane.then(fn);
    lane = run.catch(() => {});
    return run;
  }

  async function pollTrades({ route = null } = {}) {
    await loaded;
    if (busy.poll) return [];
    busy.poll = true;
    try {
      const trades = [];
      try { trades.push(...await fetchRecentTrades(http, { minCash: o.minTrade })); }
      catch (e) { warn(`recent trades: ${e?.message || e}`); }
      for (const w of watched(o.watchPerPoll)) {
        try { trades.push(...await fetchWalletTrades(http, w, { limit: 50 })); }
        catch (e) { warn(`trades ${w}: ${e?.message || e}`); }
      }
      return await serial(() => judge(trades, { route, source: 'poll' }));
    } finally { busy.poll = false; }
  }

  // Trades pushed by the live feed (parsed like the poll's): signals within
  // seconds of the fill. Every trade on the exchange arrives here, so only
  // graded or known wallets and trades big enough to queue a wallet count.
  async function ingest(trades, { route = null } = {}) {
    await loaded;
    const keep = (trades || []).filter(tr => tr && (traders.has(tr.wallet) || tr.notional >= o.minTrade - EPS));
    health.streamed = (health.streamed || 0) + keep.length;
    if (!keep.length) return [];
    return serial(() => judge(keep, { route, source: 'stream' }));
  }

  async function judge(trades, { route = null, source = 'poll' } = {}) {
    const t = now();
    trades = [...trades].sort((a, b) => (a.at ?? 0) - (b.at ?? 0));

    const out = [];
    for (const tr of trades) {
      if (seen.has(tr.key)) continue;
      if (!traders.has(tr.wallet) && !(tr.notional >= o.minTrade - EPS)) continue;
      seen.set(tr.key, tr.at ?? t);
      const trader = traders.get(tr.wallet);
      if (!trader) {
        if (tr.notional >= o.minTrade - EPS) sighted(tr);
        continue;
      }
      noteHolding(trader, tr);
      if (!gradeFor(trader, classify(tr), o).grade || !(tr.notional >= o.minTrade - EPS)) continue;
      const age = tr.at == null ? 0 : t - tr.at;
      const held = `${tr.wallet}|${tr.asset}`;
      let consensus = [], against = [];
      const inWindow = b => Math.abs((tr.at ?? t) - b.at) <= o.consensusWindowMs;
      if (tr.side === 'BUY' && age <= o.consensusWindowMs) {
        const list = buys.get(tr.asset) || [];
        consensus = [...new Set(list.filter(b => b.wallet !== tr.wallet && inWindow(b)).map(b => b.wallet))];
        list.push({ wallet: tr.wallet, at: tr.at ?? t });
        buys.set(tr.asset, list);
        if (tr.conditionId) {
          const mlist = marketBuys.get(tr.conditionId) || [];
          against = [...new Set(mlist.filter(b => b.asset !== tr.asset && inWindow(b)).map(b => b.wallet))];
          mlist.push({ wallet: tr.wallet, asset: tr.asset, at: tr.at ?? t });
          marketBuys.set(tr.conditionId, mlist);
        }
      } else if (tr.side === 'SELL') {
        // selling out withdraws that wallet's vote, and ends our tail of it
        if (buys.has(tr.asset)) buys.set(tr.asset, buys.get(tr.asset).filter(b => b.wallet !== tr.wallet));
        if (marketBuys.has(tr.conditionId)) marketBuys.set(tr.conditionId, marketBuys.get(tr.conditionId).filter(b => !(b.wallet === tr.wallet && b.asset === tr.asset)));
        tailed.delete(held);
      }
      if (age > o.maxTradeAgeMs) continue;   // history: counts for consensus, no signal
      const market = tr.side === 'BUY' ? await quote(tr.conditionId) : null;
      const book = tr.side === 'BUY' && market && !market.closed ? await bookFor(tr.asset) : null;
      const prior = tr.side === 'BUY' ? tailed.get(held) || null : null;
      const ek = eventKeyOf(tr);
      const event = tr.side === 'BUY' && ek ? { key: ek, units: eventUnits(ek, t) } : null;
      const { signal } = tradeSignal({ trade: tr, trader, market, book, consensus, against, prior, event, now: t, opts: o });
      if (!signal) continue;
      signal.via = source;
      if (tr.at != null) signal.lagMs = Math.max(0, t - tr.at);
      out.push(signal);
      // scaling in over several orders is one position: later buys top it up
      if (signal.type === 'entry' && typeof route === 'function') {
        let added = 0;
        try { added = route(signal); } catch (e) { warn(`route: ${e?.message || e}`); }
        noteTailed(signal, added);
        noteEvent(signal, added);
      } else if (signal.type === 'entry' && signal.target > 0) {
        tailed.set(held, { id: prior?.id ?? signal.id, units: Math.max(prior?.units ?? 0, signal.target), at: tr.at ?? t });
        noteEvent(signal, signal.units);
      }
    }
    if (out.length) {
      feed = [...out.slice().reverse(), ...feed].slice(0, o.maxSignals);
      health.lastSignalAt = iso(t);
    }
    prune(t);
    if (source === 'poll') health.lastPollAt = iso(t);
    else health.lastStreamAt = iso(t);
    return out;
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
      seenTrades: seen.size, clvCached: closes.size, ...health, errors: health.errors.slice(-5),
    };
  }

  return {
    refreshCandidates, scoreBatch, pollTrades, ingest, sharpBoard, book: bookFor, traders: listTraders, trader: w => traders.get(lower(w)) || null,
    signals, state, settings: () => o, addCandidate, ready: () => loaded,
  };
}

module.exports = {
  DEFAULTS, CATEGORIES, LEADERBOARD_CATEGORIES, LEADERBOARD_PERIODS, SETTLED_STATUSES, DATA_API, GAMMA_API,
  resolveOptions, optionsFromEnv, classify,
  parseClosedPositions, parseOpenPositions, resolvedFromOpen, resolvedPositions, parseTrades, parseLeaderboard, parseGammaMarket, parseGammaMarkets,
  parseFeeSchedule, polymarketFee, parsePriceHistory,
  outcomeIndexOf, askFor, priceOf, resolutionOf, markOpen, holdingsOf, boardAlerts, parseBook, fetchBook, liveAsk, CLOB_API,
  clvWindow, closingPrice, clvOf, clvStats, clvCandidates,
  twoSidedShare, walletStats, gradeStats, scoreWallet, capStale, RULES_VERSION, isRoundTrip, gradeFor, trueProb, sizeAt, tradeSignal,
  fetchPaged, fetchLeaderboard, fetchPositions, fetchSettledPositions, fetchClosedPositions, fetchOpenPositions, fetchRecentTrades, fetchWalletTrades,
  fetchPriceHistory, fetchMarket,
  createTailEngine, toMs, maskIds,
};
