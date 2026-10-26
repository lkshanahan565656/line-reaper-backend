// ─── GLOSSARY: EVERY LABEL AND BADGE ON THE SITE, IN PLAIN WORDS ─────────────
// One list, two places: the GLOSSARY section on /learn (learn.js renders it)
// and the app, where a ? beside a label, or a long press on it, opens the
// same definition (served at /glossary.js, window.LRGlossary).
//
// Each term: id (the /learn#g-<id> anchor), term (as the site prints it),
// labels (the on-screen texts it explains, matched after norm()), def (one or
// two plain sentences) and learn (a guide slug for more, optional).
//
// Definitions explain; they never claim a result. A test runs the e2e claim
// check over every definition, and "proven" only ever appears as the rule.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LRGlossary = factory();
}(/** @type {any} */ (typeof self !== 'undefined' ? self : this), function () {
  'use strict';

  // the record's bar (results.js PROVEN_N; a test keeps them equal)
  const BAR = 50;

  const TERMS = [
    // ── prices ──
    { id: 'fair', term: 'Fair', labels: ['FAIR', 'PINNACLE FAIR', 'FAIR AT POST', 'FAIR AT FLAG', 'FAIR FIRST', 'FAIR CLOSE', 'FAIR NOW', 'FAIR MOVED', 'FAIR AT CLOSE'], learn: 'no-vig-fair-odds',
      def: "The chance a side really has, read from Pinnacle's price with its margin taken out (Matchbook blended in when it prices the same line). Every EV, edge and CLV on the site is measured against it." },
    { id: 'no-vig', term: 'No-vig', labels: ['NO-VIG', 'NO VIG'], learn: 'no-vig-fair-odds',
      def: "A price with the book's margin (the vig) removed, so both sides add up to 100%. Pinnacle's no-vig price is the fair." },
    { id: 'devig', term: 'DEVIG', labels: ['DEVIG'], learn: 'no-vig-fair-odds',
      def: 'The way the margin is taken out of a price: power (the default), multiplicative, additive or Shin. Switching it changes every fair and EV on the page, usually by a fraction of a point.' },
    { id: 'above-fair', term: 'Above fair', labels: ['ABOVE FAIR', 'BEST PRICES ABOVE FAIR', 'BEST PRICE'], learn: 'expected-value',
      def: 'A price that pays more than the fair chance is worth, so its EV is positive. It is a price, not a record: check RESULTS for what has held up against the close.' },
    { id: 'implied', term: 'Implied chance', labels: ['CHANCE', 'PROB', 'IMPLIED %'],
      def: 'The win chance a price stands for: 1 ÷ decimal odds. On an exchange it is the contract price in cents, with the fee added when the screen says fee in.' },
    { id: 'ev', term: 'EV', labels: ['EV', 'EV AT YOURS', 'MIN EV', 'MIN EV %', 'EV TOP', 'EV ON $', '+EV'], learn: 'expected-value',
      def: 'Expected value: what a bet returns on average at the fair chance, as a share of the stake. It is only as right as the fair it is measured against.' },
    { id: 'edge', term: 'Edge', labels: ['EDGE', 'EDGE IF FILLED', 'MIN EDGE PTS', 'PINNACLE − COST', 'MODEL − COST'],
      def: "The gap, in points of chance, between the fair (or our model) and what the bet costs you. A positive edge is a price the math likes, not a result." },
    { id: 'best', term: 'BEST', labels: ['BEST'],
      def: 'The best price you can bet on that side among the venues shown, after fees. Green when it is also above the fair.' },
    { id: 'hold', term: 'Hold', labels: ['HOLD', 'LOWEST HOLD'], learn: 'hold-and-arbitrage',
      def: "The margin left when you take the best price on every side of a market. Under zero means an arb." },
    { id: 'arb', term: 'Arb', labels: ['ARB', 'ARBS'], learn: 'hold-and-arbitrage',
      def: 'Prices on every side that together cost less than the payout, so the stakes can be split to come out ahead whatever happens. They close fast and a stale or copied price breaks them, so check each app first.' },
    { id: 'middle', term: 'Middle', labels: ['MIDDLE', 'MIDDLES'], learn: 'middles',
      def: 'Over at a low number and Under at a higher one, so a result in between wins both bets. It pays only when the result lands in the gap.' },
    { id: 'line-gap', term: 'Line gap', labels: ['LINE GAP', 'GAP'],
      def: 'Two apps hang the same prop at different numbers. A gap alone is not a bet: the payouts can even it out, and the softest number has graded as no edge.' },
    { id: 'alt-line', term: 'Alt line', labels: ['ALT LINE'],
      def: "A number other than the venue's main line. Alt lines are graded as their own kind of bet and never counted with main lines." },
    { id: 'one-way', term: 'One-way', labels: ['ONE-WAY'],
      def: 'A price posted on one side only, with no other side to take the margin out of, so its fair is read from the main line.' },
    // ── fees and size ──
    { id: 'after-fees', term: 'AFTER FEES', labels: ['AFTER FEES', 'FEES', 'FEE'], learn: 'exchange-fees',
      def: "A view (CUSTOMIZE > After fees) that shows each price as the chance you must win to break even after the venue's cut. It changes what is shown, never a stake or an alert." },
    { id: 'break-even', term: 'Break-even', labels: ['BREAK-EVEN', 'BE', 'SIDE VS BREAK-EVEN'], learn: 'pickem-math',
      def: "The hit rate a bet needs to come out even after the venue's cut: an exchange's all-in cost, a book's implied chance, or a pick'em leg's share of its slip's payout." },
    { id: 'taker', term: 'Taker fee', labels: ['TAKE NOW', 'TAKER'], learn: 'exchange-fees',
      def: "What an exchange charges when you buy at the ask right away. Kalshi's is 0.07 × contracts × price × (1 − price), rounded up." },
    { id: 'ask', term: 'Ask', labels: ['ASK', 'KALSHI ASK', 'COST', 'KALSHI COST', 'COST AT $50'],
      def: 'The lowest price someone will sell a contract for right now. Cost is the ask with the taker fee added.' },
    { id: 'maker', term: 'Maker', labels: ['MAKER', 'MAKER FEE', 'REST A BID AT', 'BID', 'BEST BID', 'BID ON'],
      def: 'Resting a bid under the ask and waiting for a seller, instead of buying now. It pays a smaller maker fee (none on Kalshi NHL spreads and totals) and fills only if someone sells to you.' },
    { id: 'fills', term: 'Fills', labels: ['FILLS', 'FILL', 'SIZE', 'AT THE PRICE', '$50', '$200', '$1K'],
      def: "How much money an exchange's order book takes at the price shown, read from the book itself. A bid counts as filled only when a trade printed through it." },
    { id: 'min-bet-size', term: 'MIN BET SIZE', labels: ['MIN BET SIZE'],
      def: 'Shows exchange prices at what that many dollars actually fills at, walking down the order book, and drops prices that cannot take it.' },
    // ── the record ──
    { id: 'clv', term: 'CLV', labels: ['CLV', 'LEG CLV', 'SLIP CLV', 'WEEK CLV', 'ALL-TIME CLV', 'CLV +2 MIN', 'VS PINNACLE', 'CLV VS PINNACLE'], learn: 'closing-line-value',
      def: "Closing line value: the price you got against the fair when the market closed. Beating the close over many bets is the most reliable sign that a way of betting has an edge." },
    { id: 'close', term: 'Close', labels: ['CLOSE', 'PIN CLOSE', 'AT CLOSE', 'APP CLOSE'], learn: 'closing-line-value',
      def: "The last price before the event starts. Pinnacle's no-vig close is the yardstick every record here is graded against." },
    { id: 'beat-close', term: 'Beat the close', labels: ['BEAT CLOSE', 'BEAT IT', 'BEAT', 'LEGS BEAT CLOSE', 'BEAT THE CLOSE'],
      def: 'The share of bets whose price was better than the closing fair. Around half is what chance alone gives.' },
    { id: 'graded', term: 'Graded', labels: ['GRADED', 'GRADED VS CLOSE', 'GRADED SIDE', 'WITH A CLOSE', 'JUDGED (CLEARS)'],
      def: 'A bet with a closing price read, so its CLV is counted. Bets with no close are kept but never judged.' },
    { id: 'bar-50', term: `The ${BAR} bar`, labels: ['TOWARD 50', 'THE 50 BAR', '50 BAR'], learn: 'how-the-record-works',
      def: `A kind of bet is judged only once it has ${BAR} graded bets of its own at one venue. Under ${BAR}, a record is noise, not a finding.` },
    { id: 't-stat', term: 't-stat', labels: ['T-STAT', 'CLV T'], learn: 'how-the-record-works',
      def: "How many standard errors the average CLV sits above zero. The record's rule needs 2 or more, so the result is unlikely to be luck." },
    { id: 'z', term: 'z', labels: ['Z-SCORE'],
      def: "How many standard errors a hit rate sits above its break-even. 2 is the bar; under about 50 legs it means little." },
    { id: 'proven', term: 'PROVEN (label)', labels: ['PROVEN'], learn: 'how-the-record-works',
      def: `The label the record marks proven only after ${BAR} graded bets of one kind at one venue read direct, CLV above zero with a t-stat of 2 or more against Pinnacle's close, and results not far below what that CLV predicts. It describes the sample so far, not future results.` },
    { id: 'lead', term: 'LEAD', labels: ['LEAD', 'LEADS'],
      def: `A price the math likes that the record has not backed: under ${BAR} graded, or graded without passing the test. Treat it as something to check, not a bet.` },
    { id: 'model', term: 'MODEL, NOT AN EDGE', labels: ['MODEL, NOT AN EDGE', 'MODEL'],
      def: "Our own model's number shown next to the market's. In its held-out test the market's price beat the model, so a gap is the model disagreeing, not a bet." },
    { id: 'research', term: 'RESEARCH, NOT A BET', labels: ['RESEARCH, NOT A BET', 'RESEARCH'],
      def: 'A screen that measures an idea while its own record builds, with alerts off. Nothing on it is a recommendation until RESULTS says otherwise.' },
    { id: 'information', term: 'INFORMATION, NOT AN EDGE', labels: ['INFORMATION, NOT AN EDGE'],
      def: 'Facts about the market, such as how far a line moved. Useful context; on its own it has graded as no edge.' },
    { id: 'verdict', term: 'Verdict', labels: ['VERDICT'],
      def: 'Where a kind of bet stands on its own record: a lead while it builds, failed when it lost to the close, and what the rule calls proven once it passes the test.' },
    { id: 'units', term: 'Units', labels: ['UNITS'],
      def: 'Profit counted in stakes of one unit each, so records with different bet sizes compare.' },
    { id: 'roi', term: 'ROI', labels: ['ROI'],
      def: 'Profit divided by the money staked. It needs hundreds of bets to settle, which is why CLV is judged first.' },
    { id: 'record', term: 'W-L', labels: ['W-L', 'W-L-P', 'RECORD'],
      def: 'Wins, losses and pushes of graded bets. A win rate means something only next to the break-even it needs.' },
    { id: 'held-out', term: 'Held-out test', labels: ['HELD-OUT TEST'],
      def: "A model scored on games it was never fitted on, against the market's price at the time. It is the only test a model here is judged by." },
    { id: 'log-loss', term: 'Log loss', labels: ['LOG LOSS'],
      def: "A score of how well probabilities matched what happened; lower is better. A model is compared with the market's own log loss on the same games." },
    // ── freshness and sources ──
    { id: 'stale', term: 'STALE', labels: ['STALE', 'STALE AT PINNACLE'],
      def: 'A price not re-read in the last few minutes, or one that stood still while the market moved. Check it in the app before you bet.' },
    { id: 'trust', term: 'TRUST', labels: ['TRUST'],
      def: 'How far the fair and the price can be relied on: fresh, read direct, a main line and a sharp fair score higher. Hover a row for the reasons.' },
    { id: 'ref', term: 'REF', labels: ['REF', 'PINNACLE'],
      def: "A sharp reference column (Pinnacle, Matchbook). It sets the fair and is never a place we suggest you bet." },
    { id: 'copy', term: 'COPY (c)', labels: ['COPY'],
      def: "A book's price read second-hand through Action Network. It can be minutes old and is never a play on its own." },
    { id: 'tx', term: 'TX', labels: ['TX', 'TX ✓', 'TEXAS', 'TEXAS VENUES'],
      def: "A venue open to bettors in Texas: pick'em apps and the CFTC exchanges (Kalshi, Polymarket US, Gemini). No sportsbook is legal there." },
    { id: 'line-moves', term: 'LINE MOVES', labels: ['LINE MOVES', 'MOVES', 'MOVE', 'CHART'],
      def: 'Each venue\'s price for a side over time, saved every few minutes from when we first saw it. "Since first seen" starts at our first read, not the opening line.' },
    { id: 'moved-too', term: 'Moved too', labels: ['MOVED TOO', 'MOVED AT'],
      def: 'Venues whose price followed the biggest move on the same market. "Moved at" is the venue that moved most.' },
    { id: 'old-number', term: 'Still at old number', labels: ['STILL AT OLD NUMBER'],
      def: 'Venues that have not followed a move yet. That alone has graded as no edge against the close.' },
    { id: 'steam', term: 'Steam', labels: ['STEAM'],
      def: 'Several venues moving the same way within minutes, usually on news or big money.' },
    // ── pick'em ──
    { id: 'multiplier', term: 'Multiplier', labels: ['MULT', 'PAYS', 'STD'], learn: 'pickem-math',
      def: "What a pick'em app pays on a slip, or on one side of a leg (e.g. 0.85x). Std is the app's standard table." },
    { id: 'pickem', term: "Pick'em", labels: ["PICK'EM", 'PICKEM'], learn: 'pickem-math',
      def: "Apps (PrizePicks, Underdog, Sleeper, DK Pick6) where you pick Over or Under on several player props in one slip, paid from a table. Each leg has to hit more often than the slip's break-even." },
    { id: 'sharp-consensus', term: 'Sharp consensus', labels: ['SHARP CONSENSUS', 'NO SHARP LINE', 'NO SHARP MARKET'],
      def: 'The fair from the sharp sources that post a prop (Pinnacle, Kalshi). No sharp line means none posts it, so the leg is never priced as a play.' },
    { id: 'projection', term: 'Projection', labels: ['PROJ', 'PROJECTION', 'FAR FROM PROJECTION'],
      def: "Our model's expected stat for a player. A line far from it is the model disagreeing with the market, not a bet." },
    { id: 'lean', term: 'Lean', labels: ['LEAN'],
      def: 'The side the fair favours at the app\'s number, before the payout is taken into account.' },
    { id: 'outright', term: 'Outright', labels: ['OUTRIGHTS', 'OUTRIGHT'],
      def: 'A bet on who wins an event with many runners (an F1 race, a golf tournament), priced against Pinnacle\'s no-vig. Pinnacle takes small limits here, so the fair is weaker than on game lines.' },
  ];

  // a label as printed → the form labels are kept in: upper case, single spaces,
  // no sort arrows, counts in brackets or trailing colons
  function norm(s) {
    return String(s == null ? '' : s).replace(/[▾▴↓↑]/g, '').replace(/\(\d[\d,]*\)\s*$/, '').replace(/[:?]\s*$/, '')
      .replace(/\s+/g, ' ').trim().toUpperCase();
  }
  const BY_LABEL = new Map();
  const BY_ID = new Map();
  for (const t of TERMS) {
    BY_ID.set(t.id, t);
    for (const l of t.labels) if (!BY_LABEL.has(norm(l))) BY_LABEL.set(norm(l), t);
  }
  // the term a printed label stands for, or null
  const lookup = text => BY_LABEL.get(norm(text)) || null;
  const get = id => BY_ID.get(id) || null;

  return { BAR, TERMS, norm, lookup, get };
}));
