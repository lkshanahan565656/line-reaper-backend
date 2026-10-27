// ─── WHERE A PLAY CAN BE PLACED: VENUES BY STATE ─────────────────────────────
// A record or a play is only worth something to a subscriber who can bet it.
// Texas has no legal sportsbook, so FanDuel's and BetRivers' prices, and
// every copied book, are another state's edge there; the pick'em apps and the
// CFTC exchanges are what a Texan can use. With a state picked, the record,
// the +EV board and Best Plays show only that state's venues. No state shows
// everything, as before. Alerts are never cut: they're identical for everyone.
//
// Sources: venuestates.js, one per entry with its date. The first Texas list
// (read 2026-10-19) came from:
//   pick'em   bettingusa.com/states/tx/daily-fantasy (09-16: PrizePicks,
//             Underdog, Sleeper, Betr Picks, Dabble, ParlayPlay listed for TX);
//             legalsportsreport DraftKings Pick6 state list (09-18, TX in);
//             mytopsportsbooks TX DFS (06-16: Sleeper, Underdog pick'em, Pick6).
//             Chalkboard: Logan bets it from Texas (his Pikkit record).
//   exchanges defirate.com/prediction-markets/texas (09-28: Kalshi,
//             Polymarket US, Gemini Predictions, FanDuel Predicts, DraftKings
//             Predictions, OG/Crypto.com, Underdog/PrizePicks Predict,
//             Robinhood, Novig); oddsassist Gemini review (10-03: all 50
//             states); next.io Polymarket US Texas page (10-15).
//   books     no state law allows sports betting in Texas (every source above).
// Polymarket's international site is never a US venue (project rule).

// venue key → display name. Keys are the ones the trackers and screens write
// (ev rows' book, closeboard's book, the props record's app codes).
const NAMES = {
  prizepicks: 'PrizePicks', underdog: 'Underdog', sleeper: 'Sleeper', pick6: 'DK Pick6', betr: 'Betr', chalkboard: 'Chalkboard',
  parlayplay: 'ParlayPlay', dabble: 'Dabble',
  kalshi: 'Kalshi', polymarketus: 'Polymarket US', gemini: 'Gemini', novig: 'Novig', fanduel_predicts: 'FanDuel Predicts',
  draftkings_predictions: 'DraftKings Predictions', crypto_com: 'OG (Crypto.com)', robinhood: 'Robinhood',
  fanduel: 'FanDuel', betrivers: 'BetRivers', draftkings: 'DraftKings', betmgm: 'BetMGM', caesars: 'Caesars', bet365: 'bet365',
  fanatics: 'Fanatics', hardrock: 'Hard Rock', thescore: 'theScore', espnbet: 'ESPN Bet', ballybet: 'Bally Bet', betparx: 'BetPARX',
  pinnacle: 'Pinnacle', matchbook: 'Matchbook', polymarket: 'Polymarket', bovada: 'Bovada', circa: 'Circa', prophetx: 'ProphetX',
};
// other spellings → the key
const ALIAS = {
  pp: 'prizepicks', ud: 'underdog', sl: 'sleeper', p6: 'pick6', 'dk pick6': 'pick6', 'draftkings pick6': 'pick6', pick6: 'pick6',
  kalshi_mid: 'kalshi', kalshi_props: 'kalshi', 'polymarket us': 'polymarketus', polymarket_us: 'polymarketus', pmus: 'polymarketus',
  'gemini predictions': 'gemini', williamhill_us: 'caesars', hard_rock_bet: 'hardrock', hardrockbet: 'hardrock', 'hard rock': 'hardrock',
  'thescore bet': 'thescore', 'og (crypto.com)': 'crypto_com',
};
const keyOf = v => {
  const s = String(v || '').trim();
  if (!s) return null;
  const l = s.toLowerCase();
  if (NAMES[l]) return l;
  if (ALIAS[l]) return ALIAS[l];
  const byName = Object.entries(NAMES).find(([, n]) => n.toLowerCase() === l);
  return byName ? byName[0] : l.replace(/\s+/g, '_');
};
// The venue-by-state table, with a source and a date per entry, lives in
// venuestates.js. Texas keeps its own note, and the reasons a legal venue
// isn't priced here, so nobody wonders why it is missing.
const DATA = require('./venuestates');
const UNREAD = {
  betr: 'needs a login to read its board', chalkboard: 'app only, no web board', parlayplay: 'not read yet', dabble: 'not read yet',
  novig: 'its web API refuses outside queries', fanduel_predicts: 'no public price feed', draftkings_predictions: 'blocks plain reads (403)',
  crypto_com: 'no public price feed found', robinhood: "routes Kalshi's markets (priced as Kalshi)",
};
const NOTES = { TX: 'No sportsbook is legal in Texas. Pick\'em apps and CFTC exchanges are.' };
// sportsbooks not in the table: a "no" where the state has no legal sportsbook, else unknown
const BOOKS = new Set(['draftkings', 'betmgm', 'caesars', 'bet365', 'fanatics', 'hardrock', 'thescore', 'espnbet', 'ballybet', 'betparx', 'circa']);
const CHECK = 'Availability moves with court cases and app updates: check with the venue before you deposit.';

const stateOf = s => { const k = String(s || '').trim().toUpperCase(); return DATA.JURISDICTIONS[k] ? k : null; };
const srcOf = id => (id && DATA.SOURCES[id] ? { id, ...DATA.SOURCES[id] } : null);

// one venue in one state → { status: yes | no | unknown, note, source }
function statusIn(state, venue) {
  const st = stateOf(state), k = keyOf(venue);
  if (!st || !k) return { status: 'unknown', note: null, source: null };
  const row = DATA.TABLE[k];
  if (!row) {
    if (BOOKS.has(k) && DATA.NO_BOOKS[st]) return { status: 'no', note: DATA.NO_BOOKS[st].note, source: srcOf(DATA.NO_BOOKS[st].src) };
    return { status: 'unknown', note: 'Not looked up for this state yet', source: null };
  }
  const e = row.states[st] || row.default;
  return { status: e.s, note: e.note || null, source: srcOf(e.src) };
}
// "A + B" (a pair of venues) is only as good as its worse half
const RANK = { yes: 2, unknown: 1, no: 0 };
function statusOf(state, v) {
  const parts = String(v || '').split(/\s+\+\s+/).filter(Boolean);
  if (!parts.length) return 'unknown';
  return parts.map(p => statusIn(state, p).status).sort((a, b) => RANK[a] - RANK[b])[0];
}

// state → predicate on a venue (key, code or display name; "A + B" needs
// both). Only a sourced "yes" passes: unknown is never shown as available.
// No state (or not a US state): everything passes.
function legalIn(state) {
  const st = stateOf(state);
  if (!st) return () => true;
  return v => statusOf(st, v) === 'yes';
}
// a record row or play → the venue it was offered at
const venueOf = r => r?.book ?? r?.venue ?? r?.app ?? r?.signalBook ?? r?.exchange ?? null;
const rowLegalIn = state => { const ok = legalIn(state); return r => ok(venueOf(r)); };

// what the app shows when a state is picked: the venues a resident can use
// (`venues`, as before), the ones no source vouches for (`unknown`) and the
// ones they can't (`notLegal`), each with its source and date
function stateInfo(state) {
  const k = stateOf(state);
  if (!k) return null;
  const rows = Object.keys(DATA.TABLE).map(v => {
    const s = statusIn(k, v), row = DATA.TABLE[v];
    return { key: v, name: NAMES[v] || v, kind: row.kind, product: row.product, status: s.status, note: s.note,
      source: s.source ? { title: s.source.title, url: s.source.url, dated: s.source.dated, read: s.source.read } : null,
      read: !UNREAD[v], why: UNREAD[v] || null };
  });
  // a venue never looked up outside Texas stays off the unknown list: it is not one we price
  const yes = rows.filter(r => r.status === 'yes'), unk = rows.filter(r => r.status === 'unknown' && r.source), no = rows.filter(r => r.status === 'no');
  const books = yes.filter(r => r.kind === 'book').map(r => r.name);
  const note = NOTES[k] || (books.length ? `Sportsbooks we read that take bets here: ${books.join(', ')}.` : 'Neither sportsbook we read (FanDuel, BetRivers) takes bets here.');
  return { state: k, name: DATA.JURISDICTIONS[k], asOf: DATA.READ, note, check: CHECK, noBooks: !!DATA.NO_BOOKS[k], venues: yes, unknown: unk, notLegal: no };
}
const statesList = () => Object.entries(DATA.JURISDICTIONS).map(([k, name]) => {
  const i = stateInfo(k);
  return { state: k, name, asOf: DATA.READ, legal: i.venues.length, unknown: i.unknown.length };
}).sort((a, b) => a.name.localeCompare(b.name));
// the whole table for the public API and the app: venue → state → status
function table() {
  const keys = Object.keys(DATA.TABLE), sts = Object.keys(DATA.JURISDICTIONS);
  return { asOf: DATA.READ, check: CHECK, states: DATA.JURISDICTIONS, names: Object.fromEntries(keys.map(v => [v, NAMES[v] || v])),
    status: Object.fromEntries(keys.map(v => [v, Object.fromEntries(sts.map(st => [st, statusIn(st, v).status]))])),
    sources: Object.fromEntries(Object.entries(DATA.SOURCES).map(([id, s]) => [id, { title: s.title, url: s.url, dated: s.dated, read: s.read }])) };
}
// kept for older callers: Texas as the first list had it
const STATES = { TX: { name: 'Texas', asOf: DATA.READ, get venues() { return stateInfo('TX').venues.map(v => v.key); }, unread: UNREAD, note: NOTES.TX } };

module.exports = { NAMES, ALIAS, STATES, CHECK, keyOf, stateOf, statusIn, statusOf, legalIn, venueOf, rowLegalIn, stateInfo, statesList, table };
