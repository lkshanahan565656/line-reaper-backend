// ─── VENUE BY STATE: WHO CAN USE WHICH VENUE ─────────────────────────────────
// Data only (venues.js reads it). One row per venue: a default for every state
// plus the states that differ, each with the source it came from. A status is
//   yes      the source says a resident can use the product we price there
//   no       the source says they can't (or only another product runs there)
//   unknown  no source we trust says either way, or the sources disagree.
// Unknown is never shown as available: the app greys it and says to check with
// the venue. Availability moves with court cases, so every source carries the
// date it was written and the date we read it. Re-read and bump `read` when a
// venue changes its map; never guess a status to fill a gap.

const READ = '2026-10-26';
const SOURCES = {
  cbs: { title: 'CBS Sports, prediction markets: status of Kalshi and Polymarket in all 50 states', url: 'https://www.cbssports.com/prediction/news/prediction-market-legal-states/', dated: '2026-10-23', read: READ },
  ballislife: { title: 'Ballislife, what states is Kalshi legal in (October 2026)', url: 'https://ballislife.com/prediction-markets/kalshi/legal/', dated: '2026-10-12', read: READ },
  casinoorg: { title: 'Casino.org, Gemini Predictions review', url: 'https://www.casino.org/us/predictions/gemini/', dated: '2026-10', read: READ },
  defirate_ct: { title: 'DeFi Rate, Gemini, ProphetX and Webull restrict trading in Connecticut', url: 'https://defirate.com/news/report-says-gemini-prophet-x-webull-have-restricted-trading-in-connecticut/', dated: '2026', read: READ },
  oa_pp: { title: 'OddsAssist, PrizePicks state availability', url: 'https://oddsassist.com/dfs/prizepicks-states/', dated: '2026-08-29', read: READ },
  oa_ud: { title: 'OddsAssist, Underdog states', url: 'https://oddsassist.com/dfs/underdog-states/', dated: '2026-10-25', read: READ },
  busa_sleeper: { title: 'BettingUSA, Sleeper review (Sleeper Picks states)', url: 'https://www.bettingusa.com/reviews/sleeper/', dated: '2026-09-16', read: READ },
  lsr_pick6: { title: 'Legal Sports Report, DraftKings Pick6 guide', url: 'https://www.legalsportsreport.com/dfs-sites/draftkings-pick6/', dated: '2026-10-21', read: READ },
  an_fanduel: { title: 'Action Network, FanDuel legal states', url: 'https://www.actionnetwork.com/online-sports-betting/reviews/fanduel/legal-states', dated: '2025-12', read: READ },
  fw_betrivers: { title: 'Football Whispers, BetRivers legal states', url: 'https://footballwhispers.com/us/blog/betrivers-legal-states/', dated: '2026-02-13', read: READ },
  // the Texas sources behind the first Texas list (venues.js, read 2026-10-19)
  tx_dfs: { title: 'BettingUSA, Texas daily fantasy (PrizePicks, Underdog, Sleeper, Betr Picks, Dabble, ParlayPlay)', url: 'https://www.bettingusa.com/states/tx/daily-fantasy/', dated: '2026-09-16', read: '2026-10-19' },
  tx_pm: { title: 'DeFi Rate, prediction markets in Texas (Kalshi, Polymarket US, Gemini, FanDuel Predicts, DraftKings Predictions, OG, Robinhood, Novig)', url: 'https://defirate.com/prediction-markets/texas/', dated: '2026-09-28', read: '2026-10-19' },
  tx_chalkboard: { title: "Logan's own Pikkit record: Chalkboard bet from Texas", url: null, dated: '2026-10-19', read: '2026-10-19' },
  no_us: { title: 'Project rule: not a US-regulated venue, so never a US venue here', url: null, dated: '2026-10-14', read: READ },
};

// every state plus DC: code → name
const JURISDICTIONS = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware',
  DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa',
  KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota',
  MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico',
  NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island',
  SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington',
  WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
};

// states → { CODE: entry } with the same entry for each
const each = (codes, s, src, note = null) => Object.fromEntries(codes.split(' ').map(c => [c, { s, src, ...(note ? { note } : {}) }]));

const TABLE = {
  // ── CFTC exchanges ──
  kalshi: {
    kind: 'exchange', product: 'sports event contracts',
    default: { s: 'yes', src: 'cbs' },
    states: {
      ...each('NV MI', 'no', 'cbs', 'Sports contracts not live here'),
      ...each('MA WA UT MD NY OH', 'unknown', 'cbs', 'Sources disagree: CBS lists sports live, Ballislife (10-12) lists Kalshi as not available. Court cases are open'),
      ...each('AZ CA CT IL NJ RI TN TX WI', 'yes', 'cbs', 'Live, with a state lawsuit or inquiry open'),
    },
  },
  polymarketus: {
    kind: 'exchange', product: 'Polymarket US (CFTC), never polymarket.com',
    default: { s: 'yes', src: 'cbs' },
    states: {
      ...each('NV AZ CT MD TN', 'no', 'cbs', 'Not offered or blocked here'),
      ...each('MI UT WA MA', 'unknown', 'cbs', 'Sports contracts are blocked or contested here for other exchanges; Polymarket US not stated'),
    },
  },
  gemini: {
    kind: 'exchange', product: 'Gemini Predictions',
    default: { s: 'yes', src: 'casinoorg', note: 'All 50 states and DC; sports markets may vary by state' },
    states: { ...each('CT', 'unknown', 'defirate_ct', 'Reported to restrict trading in Connecticut') },
  },
  // ── pick'em apps (the house pick'em board we price) ──
  prizepicks: {
    kind: 'pickem', product: 'Player Picks (pick\'em)',
    default: { s: 'unknown', src: 'oa_pp' },
    states: {
      ...each('AL AK AZ AR CA CO DE DC FL GA IL IN KS KY ME MA MN MO NE NH NM NY NC ND OK OR RI SC SD TN TX UT VT VA WV WI WY', 'yes', 'oa_pp'),
      ...each('CT HI ID IA LA MD MI MS MT NJ OH PA', 'no', 'oa_pp', 'Only PrizePicks predictions here, not Player Picks'),
      ...each('NV WA', 'no', 'oa_pp', 'Free-to-play only'),
    },
  },
  underdog: {
    kind: 'pickem', product: 'Pick\'em (against the house)',
    default: { s: 'unknown', src: 'oa_ud' },
    states: {
      ...each('AK GA IN MN NE NM ND OK OR RI SC SD TX UT WI', 'yes', 'oa_ud'),
      ...each('AL AZ AR CA CO DE FL IL KS KY MA MS MO NH NC TN VT VA WV WY', 'unknown', 'oa_ud', 'Peer-to-peer Pick\'em Champions here, not the house pick\'em we price: check the payouts in the app'),
      ...each('MD MI NJ NY OH PA DC', 'no', 'oa_ud', 'Drafts only here'),
      ...each('CT HI ID IA LA ME MT WA', 'no', 'oa_ud', 'Prediction markets only here'),
      ...each('NV', 'no', 'oa_ud', 'Not available'),
    },
  },
  sleeper: {
    kind: 'pickem', product: 'Sleeper Picks',
    default: { s: 'unknown', src: 'busa_sleeper', note: 'Not on the source\'s Sleeper Picks list' },
    states: {
      ...each('AK AR CA GA IL IN MN NE NM NC ND OK OR RI SC SD TX UT VT VA DC WI', 'yes', 'busa_sleeper'),
      ...each('AL FL KS MA WV WY', 'unknown', 'busa_sleeper', 'Sleeper PicksVS (head to head) here, not Sleeper Picks'),
    },
  },
  pick6: {
    kind: 'pickem', product: 'DraftKings Pick6',
    default: { s: 'unknown', src: 'lsr_pick6', note: 'Not on the source\'s Pick6 list' },
    states: {
      ...each('AL AK AZ AR CA CO CT DE FL GA IL IN KS KY ME MA MN MO NE NH NM NC ND OK RI SC SD TN TX UT VT VA WV WI DC', 'yes', 'lsr_pick6'),
      ...each('NY', 'no', 'lsr_pick6', 'Not offered in New York'),
    },
  },
  // ── sportsbooks we read direct ──
  fanduel: {
    kind: 'book', product: 'FanDuel Sportsbook (online)',
    default: { s: 'no', src: 'an_fanduel', note: 'Not on FanDuel\'s list of live states' },
    states: { ...each('AZ CO CT IL IN IA KS KY LA MD MA MI MO NJ NY NC OH PA TN VT VA WV WY DC', 'yes', 'an_fanduel') },
  },
  betrivers: {
    kind: 'book', product: 'BetRivers Sportsbook (online)',
    default: { s: 'no', src: 'fw_betrivers', note: 'Not on BetRivers\' list of live states' },
    states: { ...each('AZ CO DE IL IN IA LA MD MI NJ NY OH PA VA WV', 'yes', 'fw_betrivers') },
  },
  // ── Texas-only rows from the first Texas list; elsewhere not looked up ──
  betr: { kind: 'pickem', product: 'Betr Picks', default: { s: 'unknown', src: null }, states: each('TX', 'yes', 'tx_dfs') },
  dabble: { kind: 'pickem', product: 'Dabble', default: { s: 'unknown', src: null }, states: each('TX', 'yes', 'tx_dfs') },
  parlayplay: { kind: 'pickem', product: 'ParlayPlay', default: { s: 'unknown', src: null }, states: each('TX', 'yes', 'tx_dfs') },
  chalkboard: { kind: 'pickem', product: 'Chalkboard', default: { s: 'unknown', src: null }, states: each('TX', 'yes', 'tx_chalkboard') },
  novig: { kind: 'exchange', product: 'Novig', default: { s: 'unknown', src: null }, states: each('TX', 'yes', 'tx_pm') },
  fanduel_predicts: { kind: 'exchange', product: 'FanDuel Predicts', default: { s: 'unknown', src: null }, states: each('TX', 'yes', 'tx_pm') },
  draftkings_predictions: { kind: 'exchange', product: 'DraftKings Predictions', default: { s: 'unknown', src: null }, states: each('TX', 'yes', 'tx_pm') },
  crypto_com: { kind: 'exchange', product: 'OG (Crypto.com)', default: { s: 'unknown', src: null }, states: each('TX', 'yes', 'tx_pm') },
  robinhood: { kind: 'exchange', product: 'Robinhood prediction markets', default: { s: 'unknown', src: null }, states: each('TX', 'yes', 'tx_pm') },
  // ── never a US venue ──
  polymarket: { kind: 'exchange', product: 'polymarket.com (international)', default: { s: 'no', src: 'no_us', note: 'Not for US users: use Polymarket US' }, states: {} },
  pinnacle: { kind: 'book', product: 'Pinnacle (reference price only)', default: { s: 'no', src: 'no_us', note: 'Not licensed in any US state; shown as the sharp reference only' }, states: {} },
  matchbook: { kind: 'exchange', product: 'Matchbook (reference price only)', default: { s: 'no', src: 'no_us', note: 'Not licensed in any US state; reference only' }, states: {} },
  bovada: { kind: 'book', product: 'Bovada', default: { s: 'no', src: 'no_us', note: 'Offshore, not licensed in any US state' }, states: {} },
};

// Texas has no legal sportsbook (every Texas source above): any book not in
// the table is a "no" there, not an unknown
const NO_BOOKS = { TX: { src: 'tx_dfs', note: 'No sportsbook is legal in Texas' } };

module.exports = { READ, SOURCES, JURISDICTIONS, TABLE, NO_BOOKS };
