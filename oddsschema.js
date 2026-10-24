// ─── ONE SHAPE FOR EVERY PRICE: PROVIDERS, QUOTES, ODDS FORMATS ──────────────
// Every venue the server reads (sportsbooks read direct, exchanges, prediction
// markets, Action Network's copies) is turned into the same quote record, so
// the shopper, the ranking and the esports matchup engine compare like with
// like. Decimal odds are canonical; American, fractional, Hong Kong,
// Indonesian, Malay and probability are display formats only.
//
// PROVIDERS says what each venue is and how its price should be read: its
// type, whether we read it direct or second-hand, its fee and whether the
// fee is already in the price the feed gives us, and whether a Texan can use
// it (venues.js). A venue missing from it is never invented here: an adapter
// for it must be written against its real API first.
//
// Pure functions, no I/O.

const venues = require('./venues');

const TYPES = ['sportsbook', 'exchange', 'prediction_market', 'aggregator'];
const MARKET_TYPES = ['moneyline', 'spread', 'total', 'player_prop'];

// fee: how the feed's price relates to what the bettor gets.
//   included    the adapter already priced the fee in (Kalshi, Gemini and
//               Polymarket US asks carry their taker fee: pmusbooks, geminibooks,
//               bigmoney.exchangeCost)
//   commission  a cut of net winnings, not in the feed's price
//   none        a sportsbook: the vig is the price
// commission rates are left null where the venue publishes none we can cite;
// the shopper then shows the raw price and says the cut is unknown.
const PROVIDERS = {
  pinnacle: { name: 'Pinnacle', type: 'sportsbook', access: 'direct', feed: 'guest.api.arcadia.pinnacle.com', sharp: true, fee: { type: 'none' }, reference: true,
    note: 'Sharp reference: its no-vig price is the fair. Not available to US bettors.' },
  matchbook: { name: 'Matchbook', type: 'exchange', access: 'direct', feed: 'api.matchbook.com', sharp: true, companion: true, fee: { type: 'commission', rate: null }, reference: true,
    note: "Best back price with $20+ waiting. Commission isn't in the feed, so its price is shown raw. Counts toward the fair only beside Pinnacle." },
  fanduel: { name: 'FanDuel', type: 'sportsbook', access: 'direct', feed: 'sbapi.*.sportsbook.fanduel.com', fee: { type: 'none' } },
  betrivers: { name: 'BetRivers', type: 'sportsbook', access: 'direct', feed: 'eu-offering-api.kambicdn.com', fee: { type: 'none' } },
  kalshi: { name: 'Kalshi', type: 'prediction_market', access: 'direct', feed: 'api.elections.kalshi.com', fee: { type: 'included', rate: 0.07, roundCents: true },
    note: 'Ask plus the taker fee (0.07 × p × (1 − p), rounded up to the cent).' },
  gemini: { name: 'Gemini', type: 'prediction_market', access: 'direct', feed: 'api.gemini.com', fee: { type: 'included', rate: 0.07, roundCents: true },
    note: 'Ask plus the taker fee.' },
  polymarketus: { name: 'Polymarket US', type: 'prediction_market', access: 'direct', feed: 'gateway.polymarket.us', fee: { type: 'included' },
    note: 'Ask plus the taker fee.' },
  draftkings: { name: 'DraftKings', type: 'sportsbook', access: 'second_hand', feed: 'api.actionnetwork.com', fee: { type: 'none' } },
  betmgm: { name: 'BetMGM', type: 'sportsbook', access: 'second_hand', feed: 'api.actionnetwork.com', fee: { type: 'none' } },
  caesars: { name: 'Caesars', type: 'sportsbook', access: 'second_hand', feed: 'api.actionnetwork.com', fee: { type: 'none' } },
  bet365: { name: 'bet365', type: 'sportsbook', access: 'second_hand', feed: 'api.actionnetwork.com', fee: { type: 'none' } },
  fanatics: { name: 'Fanatics', type: 'sportsbook', access: 'second_hand', feed: 'api.actionnetwork.com', fee: { type: 'none' } },
  hardrock: { name: 'Hard Rock', type: 'sportsbook', access: 'second_hand', feed: 'api.actionnetwork.com', fee: { type: 'none' } },
  thescore: { name: 'theScore Bet', type: 'sportsbook', access: 'second_hand', feed: 'api.actionnetwork.com', fee: { type: 'none' } },
};
const SECOND_HAND_NOTE = "Read second-hand from Action Network: it can be minutes old, so it is never a play on its own.";
for (const p of Object.values(PROVIDERS)) if (p.access === 'second_hand') p.note = SECOND_HAND_NOTE;
const TX_OK = venues.legalIn('TX');
function provider(id) {
  const p = PROVIDERS[id];
  if (!p) return null;
  return { id, ...p, texas: TX_OK(id) };
}
const providerList = () => Object.keys(PROVIDERS).map(provider);

// ── odds formats ──
const isNum = x => typeof x === 'number' && Number.isFinite(x);
function gcd(a, b) { return b ? gcd(b, a % b) : a; }
// any format → decimal, or null
function toDecimal(value, format = 'decimal') {
  if (value == null || value === '') return null;
  if (format === 'fractional') {
    const m = /^\s*(\d+(?:\.\d+)?)\s*[/-]\s*(\d+(?:\.\d+)?)\s*$/.exec(String(value));
    if (!m || !(Number(m[2]) > 0)) return null;
    const d = 1 + Number(m[1]) / Number(m[2]);
    return d > 1 ? d : null;
  }
  const v = Number(value);
  if (!isNum(v)) return null;
  switch (format) {
    case 'decimal': return v > 1 ? v : null;
    case 'american': return Math.abs(v) >= 100 ? (v > 0 ? 1 + v / 100 : 1 + 100 / -v) : null;
    case 'probability': return v > 0 && v < 1 ? 1 / v : null;
    case 'hongkong': case 'malay_positive': return v > 0 ? 1 + v : null;
    case 'indonesian': return Math.abs(v) >= 1 ? (v > 0 ? 1 + v : 1 + 1 / -v) : null;
    case 'malay': return v > 0 && v <= 1 ? 1 + v : v < 0 && v >= -1 ? 1 + 1 / -v : null;
    default: return null;
  }
}
// decimal → a display format (number, or a string for fractional)
function fromDecimal(d, format = 'decimal') {
  if (!(isNum(d) && d > 1)) return null;
  switch (format) {
    case 'decimal': return Math.round(d * 1000) / 1000;
    case 'american': return d >= 2 ? Math.round((d - 1) * 100) : Math.round(-100 / (d - 1));
    case 'probability': return Math.round(1e4 / d) / 1e4;
    case 'hongkong': return Math.round((d - 1) * 1000) / 1000;
    case 'indonesian': return Math.round((d >= 2 ? d - 1 : -1 / (d - 1)) * 1000) / 1000;
    case 'malay': return Math.round((d <= 2 ? d - 1 : -1 / (d - 1)) * 1000) / 1000;
    case 'fractional': {
      // nearest fraction with a denominator up to 100
      let best = [Math.round(d - 1), 1], err = Infinity;
      for (let den = 1; den <= 100; den++) {
        const nu = Math.round((d - 1) * den);
        const e = Math.abs(nu / den - (d - 1));
        if (nu > 0 && e < err - 1e-12) { err = e; best = [nu, den]; }
      }
      const g = gcd(best[0], best[1]);
      return `${best[0] / g}/${best[1] / g}`;
    }
    default: return null;
  }
}
const FORMATS = ['american', 'decimal', 'fractional', 'probability', 'hongkong', 'indonesian', 'malay'];
function formatOdds(d, format = 'american') {
  const v = fromDecimal(d, format);
  if (v == null) return '—';
  if (format === 'american') return v > 0 ? `+${v}` : String(v);
  if (format === 'probability') return `${(v * 100).toFixed(1)}%`;
  return String(v);
}

// ── freshness ──
// How old a price is when the shopper reads it. Second-hand copies age
// faster in practice, so they get the tighter bar.
const FRESH = { live: 3 * 60e3, recent: 12 * 60e3 };
function freshness(ageMs, { access = 'direct' } = {}) {
  if (!isNum(ageMs) || ageMs < 0) return 'unknown';
  const k = access === 'second_hand' ? 0.5 : 1;
  if (ageMs <= FRESH.live * k) return 'live';
  if (ageMs <= FRESH.recent * k) return 'recent';
  return 'stale';
}

// ── the quote record ──
// Every field the master spec names; null where a source does not supply it
// (limits and liquidity are never guessed).
const FIELDS = ['providerId', 'providerName', 'providerType', 'sport', 'league', 'competition', 'eventId', 'externalEventId', 'home', 'away',
  'startUtc', 'marketId', 'marketType', 'marketName', 'period', 'selectionId', 'selectionName', 'side', 'player', 'line', 'decimal', 'effectiveDecimal',
  'originalFormat', 'originalPrice', 'updatedAt', 'sourceAt', 'marketStatus', 'available', 'liquidity', 'commission', 'maxStake', 'sourceIds', 'provenance', 'oneWay'];
function makeQuote(f) {
  const p = provider(f.providerId);
  const q = {};
  for (const k of FIELDS) q[k] = f[k] === undefined ? null : f[k];
  q.providerName = q.providerName || p?.name || f.providerId;
  q.providerType = q.providerType || p?.type || null;
  if (q.decimal == null && f.originalPrice != null) q.decimal = toDecimal(f.originalPrice, f.originalFormat || 'decimal');
  if (q.effectiveDecimal == null) q.effectiveDecimal = q.decimal;
  q.commission = q.commission || (p ? { ...p.fee } : null);
  q.marketStatus = q.marketStatus || 'open';
  q.available = q.available == null ? q.marketStatus === 'open' : !!q.available;
  q.provenance = { access: p?.access || 'unknown', feed: p?.feed || null, ...(f.provenance || {}) };
  q.oneWay = !!f.oneWay;
  return q;
}
function validateQuote(q) {
  const errors = [];
  if (!q || typeof q !== 'object') return { ok: false, errors: ['not an object'] };
  if (!q.providerId) errors.push('providerId missing');
  else if (!PROVIDERS[q.providerId]) errors.push(`unknown provider ${q.providerId}`);
  if (!q.eventId) errors.push('eventId missing');
  if (!MARKET_TYPES.includes(q.marketType)) errors.push(`marketType ${q.marketType} not one of ${MARKET_TYPES.join(', ')}`);
  if (!q.selectionName) errors.push('selectionName missing');
  if (!(isNum(q.decimal) && q.decimal > 1)) errors.push('decimal odds must be a number above 1');
  if (!(isNum(q.effectiveDecimal) && q.effectiveDecimal > 1)) errors.push('effective decimal must be a number above 1');
  if ((q.marketType === 'spread' || q.marketType === 'total' || q.marketType === 'player_prop') && !isNum(q.line)) errors.push('line missing');
  if (q.marketType === 'player_prop' && !q.player) errors.push('player missing');
  if (q.startUtc && !Number.isFinite(Date.parse(q.startUtc))) errors.push('startUtc not a date');
  if (q.updatedAt && !Number.isFinite(Date.parse(q.updatedAt))) errors.push('updatedAt not a date');
  if (q.liquidity != null && !(isNum(q.liquidity) && q.liquidity >= 0)) errors.push('liquidity must be dollars ≥ 0');
  return { ok: !errors.length, errors };
}

module.exports = { TYPES, MARKET_TYPES, PROVIDERS, provider, providerList, FORMATS, toDecimal, fromDecimal, formatOdds, FRESH, freshness, FIELDS, makeQuote, validateQuote };
