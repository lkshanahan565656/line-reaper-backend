// ─── THE CLOSE SCOREBOARD: EVERY BOOK AND EVERY KIND AGAINST THE CLOSE ────────
// One table for the sportsbook side: each kind of play (main +EV lines, alt
// lines, stale lines, the pick'em apps' sharp-consensus and stale legs, big
// money) cut by the book or app it was bet at, with
//
//   graded    plays whose close was read within the hour before the start
//             (evtrack/sporttrack closeOk), the count toward the 50 a verdict
//             needs; a close read earlier than that is 'stale' and one from
//             before the check existed is 'unverified', both counted apart
//             and never graded
//   beat      share of graded plays whose price beat the close
//   clv       average closing-line value at the flagged price, and at the
//             price two minutes on where the record has one (exec)
//   mark      the tracker's own verdict (results.js verdictOf: a t of 2 on
//             CLV), held below proven until TARGET games are graded;
//             'not graded yet' with none
//
// Lines on the same game, or the same player's stat, aren't independent: one
// BetRivers game listed nine spreads and a moneyline on the same team, all
// "graded" at once (10-15 audit). A play here is that cluster, scored on the
// mean of its lines. And a close priced on our own curve (alt lines with no
// exact sharp line) or on soft books alone isn't a sharp close: CLV against it
// is the flag EV again, so those kinds are shown but never marked or counted
// in a book's total.
//
// Proven is narrower still: one kind of play on one book we read ourselves.
// The headline pools every book and kind, a book's total pools its kinds
// (main lines with big money and esports), and a book seen only through Action
// Network's copy has never had its price checked at the book: all three stop at
// promising, however good the numbers (10-16, when Hard Rock's copied NHL
// prices and the pooled total first read "proven").
//
// A public page may claim only what this marks proven. Book arbs aren't here:
// a locked arb has no close to beat (its record grades fills, /api/book-arbs/record).

const results = require('./results');
const evtrack = require('./evtrack');
const sporttrack = require('./sporttrack');

const TARGET = 50;
const r2 = x => (x == null || !Number.isFinite(x) ? null : Math.round(x * 100) / 100);
const mean = a => (a.length ? a.reduce((x, v) => x + v, 0) / a.length : null);

const BOOK = { fanduel: 'FanDuel', betrivers: 'BetRivers', draftkings: 'DraftKings', betmgm: 'BetMGM', caesars: 'Caesars', bet365: 'bet365',
  fanatics: 'Fanatics', hardrock: 'Hard Rock', thescore: 'theScore', kalshi: 'Kalshi', polymarket: 'Polymarket', matchbook: 'Matchbook',
  gemini: 'Gemini', polymarketus: 'Polymarket US',
  prizepicks: 'PrizePicks', underdog: 'Underdog', sleeper: 'Sleeper', pick6: 'DK Pick6', PP: 'PrizePicks', UD: 'Underdog', SL: 'Sleeper', P6: 'DK Pick6' };
// Action Network's copies: no direct read of the book's own price
const RELAYED = new Set(['draftkings', 'betmgm', 'caesars', 'bet365', 'fanatics', 'hardrock', 'thescore']);

const KINDS = {
  'ev': 'Main lines vs the sharp fair',
  'ev-consensus': 'Main lines vs a soft consensus',
  'alt': 'Alt lines (cleared)',
  'alt-model': 'Alt lines (model only)',
  'stale': 'Stale lines (confirmed)',
  'stale-single': 'Stale lines (Pinnacle only)',
  'esports': 'Esports book lines',
  'props-sharp': "Pick'em sharp consensus",
  'props-ev': "Pick'em sharp price",
  'props-gap': "Pick'em line gap",
  'props-stale': "Pick'em stale (confirmed)",
  'props-stale-single': "Pick'em stale (Pinnacle only)",
  // the same stale legs where Pinnacle sat on the app's own number at the flag
  // and at the close: closed on Pinnacle's own price there, no curve (closePinEv)
  'props-stale-exact': "Pick'em stale at Pinnacle's own number",
  // DraftKings Pick6, a lead with its own record
  'props-p6-sharp': 'Pick6 sharp consensus',
  'props-p6-ev': 'Pick6 sharp price',
  'props-p6-gap': 'Pick6 line gap',
  // FanDuel and BetRivers alone where nothing sharp prices the leg (college
  // football, NHL): the apps' margin against the soft books, judged on their close
  'props-book-fair': "Pick'em vs FanDuel + BetRivers",
  'props-book-fair-single': "Pick'em vs one book (FanDuel or BetRivers)",
  'props-p6-book-fair': 'Pick6 vs FanDuel + BetRivers',
  'props-p6-book-fair-single': 'Pick6 vs one book',
  // three or more sportsbooks at the app's own number, where nothing sharp prices it
  'props-book-consensus': "Pick'em vs 3+ books' consensus",
  'props-p6-book-consensus': "Pick6 vs 3+ books' consensus",
  // Pinnacle and two of FanDuel, BetRivers and Kalshi at the app's own number,
  // every one past break-even; the close is Pinnacle's own price there
  'props-sharp3': "Pick'em vs three sharps (Pinnacle + 2)",
  'props-p6-sharp3': 'Pick6 vs three sharps (Pinnacle + 2)',
  // combos (pts+rebs, pts+asts, rebs+asts, steals+blocks) off FanDuel, BetRivers and Pinnacle's parts
  'props-combo': "Pick'em combos vs the books + Pinnacle's parts",
  'props-p6-combo': "Pick6 combos vs the books + Pinnacle's parts",
  'bigmoney': 'Big money',
};

const NO_SHARP_CLOSE = new Set(['alt-model', 'ev-consensus']);
// An alt line's close is Kalshi's midpoint (a spread up to 6c wide) or a
// sportsbook's own number at that rung; Pinnacle's two-way price is never at
// the rung, only its curve. Scored and marked, but never proven, and never a
// book's proof (10-18: FanDuel's alt lines read proven at 75 games, +2.6% CLV,
// while 102 lines lost 24.6 units and today's clearing rungs were -3% against
// Pinnacle's own curve).
// Stale lines are the same problem at the venue's own number: the venue is
// still on the number Pinnacle just left, so where Pinnacle moved its number
// the fair (and the close) is read off our stat curve, not Pinnacle's price
// there. 10-19: BetRivers' stale lines read proven at 65 games, +4.2% CLV,
// while 104 graded lines won 47 against 57.9 the close expected (-16.9 units);
// of the props with Pinnacle's line on record, 19 of 27 sat at another number.
const CAPPED_KINDS = new Set(['alt', 'stale', 'stale-single', 'props-stale', 'props-stale-single']);
// why each capped kind stops at promising, shown on the record screen
const ALT_NOTE = "Never proven: the close is Kalshi's mid or another book's number at the rung, not Pinnacle's own price.";
// 10-24 re-check of PrizePicks' stale legs from ESPN box scores (all 249
// graded): where Pinnacle sat elsewhere (our curve) 133 legs won 70 against
// 76.5 the close expected (-5.8 units); at Pinnacle's own number 116 won 67
// against 66.0 (+5.8 units). Those now score in their own kind, closed on
// Pinnacle's own price.
const STALE_NOTE = "Never proven: where Pinnacle moved its number, the close is our curve at the venue's number, not Pinnacle's own price. Legs at Pinnacle's own number score on their own row.";
const CAP_NOTE = { alt: ALT_NOTE, stale: STALE_NOTE, 'stale-single': STALE_NOTE, 'props-stale': STALE_NOTE, 'props-stale-single': STALE_NOTE };
// closes on the soft books' own fair: scored and marked, but kept out of a
// book's total and the headline, which count sharp closes only
const BOOK_CLOSE = new Set(['props-book-fair', 'props-book-fair-single', 'props-p6-book-fair', 'props-p6-book-fair-single', 'props-book-consensus', 'props-p6-book-consensus']);
const day = t => String(t || '').slice(0, 10);
// a second view of legs already counted in another kind: kept out of a book's
// total and the headline, so no leg counts twice there
const DUP_KINDS = new Set(['props-stale-exact']);
const STALE_PROPS = new Set(['stale', 'stale-single']);

// one line: { kind, book, cluster, state: null (open) | 'ok' | 'stale' | 'unverified', clv, exec, win, bet }
// Main lines (pin: true) grade the exchanges a Texan trades (Gemini,
// Polymarket US, Kalshi) on Pinnacle's own close (evtrack.gradeOf), and every
// main line with an ESPN final carries its result, so a close the results
// don't back up (results.resultsShortfall) can't be proven.
function evPlay(kind, { pin = false } = {}) {
  return b => {
    const g = pin ? evtrack.gradeOf(b) : { state: evtrack.closeState(b), clv: b.clv ?? null, exec: b.execClv ?? null, p: b.closeFair != null ? b.closeFair / 100 : null };
    const won = pin && (b.outcome === 'win' || b.outcome === 'loss') ? b.outcome === 'win' : null;
    return { kind, book: b.book, cluster: `${b.event || b.group}|${b.player || 'game'}|${day(b.start)}`, state: g.state,
      clv: g.clv, exec: g.exec, win: won, p: g.p, d: b.decimal ?? null, bet: results.SOURCES.ev.bet(b) };
  };
}
const evKind = b => (b.source === 'consensus' ? 'ev-consensus' : 'ev');
// the app a props-record row was offered on
const APP_CODES = { PP: 'prizepicks', UD: 'underdog', SL: 'sleeper', P6: 'pick6' };
const propsVenue = b => b.book || APP_CODES[b.signalBook] || b.signalBook;
function propsPlay(b) {
  const state = sporttrack.closeState(b);
  const graded = b.status === 'graded' && (b.outcome === 'win' || b.outcome === 'loss');
  return { kind: `props-${b.kind}`, book: propsVenue(b),
    cluster: `${b.sport}|${b.player}|${b.mkey}|${day(b.start)}`, state, clv: b.closeEv ?? null,
    exec: b.execOk === true ? b.closeEv ?? null : null, win: graded ? b.outcome === 'win' : null,
    p: b.closeFair ?? null, d: b.signalDecimal ?? null, bet: results.SOURCES.sportsProps.bet(b) };
}
// a stale leg closed on Pinnacle's own number (sporttrack pinClose): its CLV is
// Pinnacle's price at the app's line, and it scores as a sharp close
function propsExactPlay(b) {
  const p = propsPlay(b);
  return { ...p, kind: 'props-stale-exact', clv: b.closePinEv, exec: b.execOk === true ? b.closePinEv : null, p: b.closePinFair ?? null };
}
function bigPlay(b) {
  const state = b.status === 'open' || b.status === 'void' ? null : sporttrack.closeState(b);
  const graded = b.status === 'graded' && (b.outcome === 'win' || b.outcome === 'loss');
  return { kind: 'bigmoney', book: b.venue, cluster: `${b.title || b.betKey}|${day(b.start)}`, state, clv: b.closeEv ?? null, exec: b.execOk === true ? b.closeEv ?? null : null,
    win: graded ? b.outcome === 'win' : null, bet: results.SOURCES.bigMoney.bet(b) };
}

// the graded lines of one book and kind on one game (or player stat) → one
// bet: CLV and the +2 min CLV averaged, results summed
function clusterBets(lines) {
  const m = new Map();
  for (const p of lines) { const k = `${p.kind}|${p.book}|${p.cluster}`; if (!m.has(k)) m.set(k, []); m.get(k).push(p); }
  return [...m.values()].map(l => {
    const ex = l.filter(p => p.exec != null), won = l.map(p => p.bet).filter(b => b.profit != null && b.staked > 0);
    return { clv: mean(l.map(p => p.clv)), exec: ex.length ? mean(ex.map(p => p.exec)) : null, lines: l.length,
      bet: { clv: mean(l.map(p => p.clv)) / 100, exec: ex.length ? mean(ex.map(p => p.exec)) / 100 : null, sized: null,
        profit: won.length ? won.reduce((a, b) => a + b.profit, 0) : null, staked: won.reduce((a, b) => a + b.staked, 0) } };
  });
}
function stats(plays, { noMark = false, cap = false, capNote = null } = {}) {
  const lines = plays.filter(p => p.state === 'ok' && p.clv != null);
  const g = clusterBets(lines);
  const ex = g.filter(p => p.exec != null);
  const won = plays.filter(p => p.win != null);
  let mark = 'not graded yet', note = null;
  // results far under what the close expected: the close itself is in doubt
  const short = results.resultsShortfall(lines.filter(p => p.win != null && p.p != null && p.d != null).map(p => ({ win: p.win, p: p.p, d: p.d })));
  if (noMark) mark = 'no sharp close';
  else if (g.length) {
    mark = results.score(g.map(p => p.bet)).verdict;
    if (mark === 'proven' && (g.length < TARGET || cap)) { mark = 'promising'; if (cap && capNote) note = capNote; }
    if (mark === 'proven' && short.short) { mark = 'promising'; note = short.note; }
  }
  return {
    recorded: plays.length, open: plays.filter(p => p.state == null).length,
    graded: g.length, gradedLines: lines.length, toTarget: Math.min(1, r2(g.length / TARGET)),
    staleClose: plays.filter(p => p.state === 'stale').length, unverified: plays.filter(p => p.state === 'unverified').length,
    beatPct: g.length ? r2((100 * g.filter(p => p.clv > 0).length) / g.length) : null,
    avgClv: r2(mean(g.map(p => p.clv))),
    execN: ex.length, avgExecClv: r2(mean(ex.map(p => p.exec))),
    wins: won.filter(p => p.win).length, losses: won.filter(p => !p.win).length,
    ...(short.n ? { resultsZ: short.z, resultsUnits: short.units, resultsExpUnits: short.expUnits } : {}),
    mark, ...(note || (cap && capNote) ? { note: note || capNote } : {}),
  };
}

// lists: { ev, alt, stale, esports, props, bigMoney } (each tracker's list) →
// { rows: [{ kind, kindLabel, book, bookName, relayed, ...stats }], byBook, byKind, target }
function scoreboard(lists = {}, { since = 0 } = {}) {
  const at = b => Date.parse(b.flaggedAt || b.signalAt || '') || 0;
  const keep = b => !since || at(b) >= since;
  const plays = [
    ...(lists.ev || []).filter(keep).map(b => evPlay(evKind(b), { pin: true })(b)),
    ...(lists.alt || []).filter(keep).map(b => evPlay(b.source === 'alt' ? 'alt' : 'alt-model')(b)),
    ...(lists.stale || []).filter(keep).map(b => evPlay(b.source === 'stale' ? 'stale' : 'stale-single')(b)),
    ...(lists.esports || []).filter(keep).map(evPlay('esports')),
    // the research kinds (gap-odd, gap-stale) price nothing, so they aren't plays
    ...(lists.props || []).filter(keep).filter(b => KINDS[`props-${b.kind}`] && b.status !== 'void').map(propsPlay),
    ...(lists.props || []).filter(keep).filter(b => STALE_PROPS.has(b.kind) && b.pinExact === true && b.status !== 'void').map(propsExactPlay),
    ...(lists.bigMoney || []).filter(keep).filter(b => b.status !== 'void').map(bigPlay),
  ];
  const group = (f, list = plays) => {
    const m = new Map();
    for (const p of list) { const k = f(p); if (!m.has(k)) m.set(k, []); m.get(k).push(p); }
    return m;
  };
  // a book's total and the headline count sharp closes only
  const sharp = plays.filter(p => !NO_SHARP_CLOSE.has(p.kind) && !BOOK_CLOSE.has(p.kind) && !DUP_KINDS.has(p.kind));
  const order = (a, b) => (a.mark === 'no sharp close') - (b.mark === 'no sharp close') || b.graded - a.graded || b.recorded - a.recorded;
  const rows = [...group(p => `${p.kind}|${p.book}`)].map(([k, l]) => {
    const [kind, book] = k.split('|');
    return { kind, kindLabel: KINDS[kind] || kind, book, bookName: BOOK[book] || book, relayed: RELAYED.has(book), ...stats(l, { noMark: NO_SHARP_CLOSE.has(kind), cap: RELAYED.has(book) || CAPPED_KINDS.has(kind), capNote: CAP_NOTE[kind] || null }) };
  }).sort(order);
  // a book's total is proven only through one of its own kinds
  const provenBooks = new Set(rows.filter(r => r.mark === 'proven' && !BOOK_CLOSE.has(r.kind)).map(r => r.book));
  const byBook = Object.fromEntries([...group(p => p.book, sharp)].map(([k, l]) => [k, { bookName: BOOK[k] || k, relayed: RELAYED.has(k), ...stats(l, { cap: !provenBooks.has(k) }) }])
    .sort((a, b) => order(a[1], b[1])));
  // a kind's total pools its books
  const byKind = Object.fromEntries([...group(p => p.kind)].map(([k, l]) => [k, { kindLabel: KINDS[k] || k, ...stats(l, { noMark: NO_SHARP_CLOSE.has(k), cap: true, capNote: CAP_NOTE[k] || null }) }])
    .sort((a, b) => order(a[1], b[1])));
  return { target: TARGET, freshMin: evtrack.CLOSE_FRESH_MS / 60e3, overall: stats(sharp, { cap: true }), rows, byBook, byKind };
}

// Who the +EV webhook may post for. The webhook reaches other people, so it
// carries only what this board marks proven: a book read direct whose main
// lines (or, for a pick'em app, whose sharp-price legs) are proven here, and
// still beating the close at the price two minutes on. A copied book never
// does, and neither does a book proven only on another kind (alt lines).
const ALERT_KINDS = new Set(['ev', 'props-ev']);
function alertBooks(board, { minExecClv = 1 } = {}) {
  return new Set((board?.rows || []).filter(r => ALERT_KINDS.has(r.kind) && !r.relayed && !RELAYED.has(r.book) && r.mark === 'proven' && (r.avgExecClv ?? -Infinity) >= minExecClv).map(r => r.book));
}

module.exports = { scoreboard, alertBooks, propsVenue, KINDS, TARGET, NO_SHARP_CLOSE, BOOK_CLOSE, CAPPED_KINDS, DUP_KINDS };
