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
  prizepicks: 'PrizePicks', underdog: 'Underdog', sleeper: 'Sleeper', PP: 'PrizePicks', UD: 'Underdog', SL: 'Sleeper' };
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
  'bigmoney': 'Big money',
};

const NO_SHARP_CLOSE = new Set(['alt-model', 'ev-consensus']);
const day = t => String(t || '').slice(0, 10);

// one line: { kind, book, cluster, state: null (open) | 'ok' | 'stale' | 'unverified', clv, exec, win, bet }
function evPlay(kind) {
  return b => ({ kind, book: b.book, cluster: `${b.event || b.group}|${b.player || 'game'}|${day(b.start)}`, state: evtrack.closeState(b),
    clv: b.clv ?? null, exec: b.execClv ?? null, win: null, bet: results.SOURCES.ev.bet(b) });
}
const evKind = b => (b.source === 'consensus' ? 'ev-consensus' : 'ev');
function propsPlay(b) {
  const state = sporttrack.closeState(b);
  const graded = b.status === 'graded' && (b.outcome === 'win' || b.outcome === 'loss');
  return { kind: `props-${b.kind}`, book: b.book || ({ PP: 'prizepicks', UD: 'underdog', SL: 'sleeper' })[b.signalBook] || b.signalBook,
    cluster: `${b.sport}|${b.player}|${b.mkey}|${day(b.start)}`, state, clv: b.closeEv ?? null,
    exec: b.execOk === true ? b.closeEv ?? null : null, win: graded ? b.outcome === 'win' : null, bet: results.SOURCES.sportsProps.bet(b) };
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
function stats(plays, { noMark = false } = {}) {
  const lines = plays.filter(p => p.state === 'ok' && p.clv != null);
  const g = clusterBets(lines);
  const ex = g.filter(p => p.exec != null);
  const won = plays.filter(p => p.win != null);
  let mark = 'not graded yet';
  if (noMark) mark = 'no sharp close';
  else if (g.length) {
    mark = results.score(g.map(p => p.bet)).verdict;
    if (mark === 'proven' && g.length < TARGET) mark = 'promising';
  }
  return {
    recorded: plays.length, open: plays.filter(p => p.state == null).length,
    graded: g.length, gradedLines: lines.length, toTarget: Math.min(1, r2(g.length / TARGET)),
    staleClose: plays.filter(p => p.state === 'stale').length, unverified: plays.filter(p => p.state === 'unverified').length,
    beatPct: g.length ? r2((100 * g.filter(p => p.clv > 0).length) / g.length) : null,
    avgClv: r2(mean(g.map(p => p.clv))),
    execN: ex.length, avgExecClv: r2(mean(ex.map(p => p.exec))),
    wins: won.filter(p => p.win).length, losses: won.filter(p => !p.win).length,
    mark,
  };
}

// lists: { ev, alt, stale, esports, props, bigMoney } (each tracker's list) →
// { rows: [{ kind, kindLabel, book, bookName, relayed, ...stats }], byBook, byKind, target }
function scoreboard(lists = {}, { since = 0 } = {}) {
  const at = b => Date.parse(b.flaggedAt || b.signalAt || '') || 0;
  const keep = b => !since || at(b) >= since;
  const plays = [
    ...(lists.ev || []).filter(keep).map(b => evPlay(evKind(b))(b)),
    ...(lists.alt || []).filter(keep).map(b => evPlay(b.source === 'alt' ? 'alt' : 'alt-model')(b)),
    ...(lists.stale || []).filter(keep).map(b => evPlay(b.source === 'stale' ? 'stale' : 'stale-single')(b)),
    ...(lists.esports || []).filter(keep).map(evPlay('esports')),
    // the research kinds (gap-odd, gap-stale) price nothing, so they aren't plays
    ...(lists.props || []).filter(keep).filter(b => KINDS[`props-${b.kind}`] && b.status !== 'void').map(propsPlay),
    ...(lists.bigMoney || []).filter(keep).filter(b => b.status !== 'void').map(bigPlay),
  ];
  const group = (f, list = plays) => {
    const m = new Map();
    for (const p of list) { const k = f(p); if (!m.has(k)) m.set(k, []); m.get(k).push(p); }
    return m;
  };
  // a book's total and the headline count sharp closes only
  const sharp = plays.filter(p => !NO_SHARP_CLOSE.has(p.kind));
  const order = (a, b) => (a.mark === 'no sharp close') - (b.mark === 'no sharp close') || b.graded - a.graded || b.recorded - a.recorded;
  const rows = [...group(p => `${p.kind}|${p.book}`)].map(([k, l]) => {
    const [kind, book] = k.split('|');
    return { kind, kindLabel: KINDS[kind] || kind, book, bookName: BOOK[book] || book, relayed: RELAYED.has(book), ...stats(l, { noMark: NO_SHARP_CLOSE.has(kind) }) };
  }).sort(order);
  const byBook = Object.fromEntries([...group(p => p.book, sharp)].map(([k, l]) => [k, { bookName: BOOK[k] || k, relayed: RELAYED.has(k), ...stats(l) }])
    .sort((a, b) => order(a[1], b[1])));
  const byKind = Object.fromEntries([...group(p => p.kind)].map(([k, l]) => [k, { kindLabel: KINDS[k] || k, ...stats(l, { noMark: NO_SHARP_CLOSE.has(k) }) }])
    .sort((a, b) => order(a[1], b[1])));
  return { target: TARGET, freshMin: evtrack.CLOSE_FRESH_MS / 60e3, overall: stats(sharp), rows, byBook, byKind };
}

module.exports = { scoreboard, KINDS, TARGET, NO_SHARP_CLOSE };
