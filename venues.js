// ─── WHERE A PLAY CAN BE PLACED: VENUES BY STATE ─────────────────────────────
// A record or a play is only worth something to a subscriber who can bet it.
// Texas has no legal sportsbook, so FanDuel's and BetRivers' prices, and
// every copied book, are another state's edge there; the pick'em apps and the
// CFTC exchanges are what a Texan can use. With a state picked, the record,
// the +EV board and Best Plays show only that state's venues. No state shows
// everything, as before. Alerts are never cut: they're identical for everyone.
//
// Sources (read 2026-10-19; availability moves, so each list carries its date):
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
// state → { venues: keys a resident can use, readable: those we price, asOf }
const STATES = {
  TX: {
    name: 'Texas', asOf: '2026-10-19',
    venues: ['prizepicks', 'underdog', 'sleeper', 'pick6', 'betr', 'chalkboard', 'parlayplay', 'dabble',
      'kalshi', 'polymarketus', 'gemini', 'novig', 'fanduel_predicts', 'draftkings_predictions', 'crypto_com', 'robinhood'],
    // legal there but not priced here, and why (shown so nobody wonders)
    unread: {
      betr: 'needs a login to read its board', chalkboard: 'app only, no web board', parlayplay: 'not read yet', dabble: 'not read yet',
      novig: 'its web API refuses outside queries', fanduel_predicts: 'no public price feed', draftkings_predictions: 'blocks plain reads (403)',
      crypto_com: 'no public price feed found', robinhood: "routes Kalshi's markets (priced as Kalshi)",
    },
    note: 'No sportsbook is legal in Texas. Pick\'em apps and CFTC exchanges are.',
  },
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
const stateOf = s => { const k = String(s || '').trim().toUpperCase(); return STATES[k] ? k : null; };

// state → predicate on a venue (key, code or display name; "A + B" needs
// both). No state (or one we have no list for): everything passes.
function legalIn(state) {
  const st = STATES[stateOf(state)];
  if (!st) return () => true;
  const ok = new Set(st.venues);
  return v => {
    const parts = String(v || '').split(/\s+\+\s+/).map(keyOf).filter(Boolean);
    return parts.length > 0 && parts.every(k => ok.has(k));
  };
}
// a record row or play → the venue it was offered at
const venueOf = r => r?.book ?? r?.venue ?? r?.app ?? r?.signalBook ?? r?.exchange ?? null;
const rowLegalIn = state => { const ok = legalIn(state); return r => ok(venueOf(r)); };

// what the app shows when a state is picked
function stateInfo(state) {
  const k = stateOf(state);
  if (!k) return null;
  const st = STATES[k];
  return { state: k, name: st.name, asOf: st.asOf, note: st.note, venues: st.venues.map(v => ({ key: v, name: NAMES[v] || v, read: !st.unread[v], why: st.unread[v] || null })) };
}
const statesList = () => Object.entries(STATES).map(([k, s]) => ({ state: k, name: s.name, asOf: s.asOf }));

module.exports = { NAMES, ALIAS, STATES, keyOf, stateOf, legalIn, venueOf, rowLegalIn, stateInfo, statesList };
