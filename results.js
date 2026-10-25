// ─── WHAT'S WINNING ───────────────────────────────────────────────────────────
// One scoreboard across every track record: Sharp Tail signals, the
// fresh-wallet radar, the +EV screener, esports exchange edges, exchange
// value (US exchange prices under Polymarket's) and esports prop picks. Each record becomes a bet { profit, staked, clv }, bets are
// grouped into plays (A-grade sports tails, Kalshi CS2 match edges, ...) and
// every play gets a verdict from its own sample:
//
//   proven     50+ bets (PROVEN_N) and a t-stat of 2+ on CLV or on ROI, with it
//              positive (CLV here is the 2-minute grade once 8+ bets have one),
//              and never while the CLV says the opposite (a t of -2): 21 gas
//              locks won at 96-98c with the close against them read "proven" on
//              ROI alone (10-16)
//   promising  8+ bets, beating the close (or in profit when there's no CLV)
//   avoid      8+ bets, losing to the close and losing money (or a t of -2)
//
// Sportsbook records (BOOK_SOURCES) are held to a stricter rule: only a cut by
// a single book can be proven, and only with PROVEN_BOOK_N graded bets of its
// own, counted one per game (or player stat) and day: nine spreads on one game
// are one bet of evidence, not nine. A pooled group (all books, a sport, a
// market) never makes a book proven, and neither does a book we only see
// second-hand (Action Network's copies of DraftKings, Hard Rock, ...): nobody
// has checked that price could be bet there.
//   early      everything else
//
// "Bets" means bets that carry the number being judged: a CLV verdict counts
// bets with a closing price, an ROI verdict counts graded bets. A play with 20
// records but CLV on only 3 of them has 3 bets of CLV evidence, not 20.
//
// CLV is the main signal (closing price / entry − 1): it settles at the start
// of the event and needs a few dozen bets where ROI needs hundreds. ROI is
// profit / staked in units. Both are fractions (0.05 = 5%).

const r4 = x => (x == null || !Number.isFinite(x) ? null : Math.round(x * 1e4) / 1e4);
const r2 = x => (x == null || !Number.isFinite(x) ? null : Math.round(x * 100) / 100);

const mean = a => a.reduce((x, v) => x + v, 0) / a.length;
// one-sample t against 0 (null under 3 values or with no spread)
function tStat(a) {
  if (a.length < 3) return null;
  const m = mean(a);
  const sd = Math.sqrt(a.reduce((x, v) => x + (v - m) ** 2, 0) / (a.length - 1));
  return sd > 0 ? r2(m / (sd / Math.sqrt(a.length))) : null;
}

// Once 8+ bets carry a grade at the price 2 minutes after the alert (execClv),
// that grade is the CLV judged: a signal counts only at a price a subscriber
// can still get, not at the alerted one.
// Graded at $100 through the book (sizedClv) once 8 have that, which is
// what a subscriber betting real size gets.
const EXEC_MIN_N = 8;
const PROVEN_N = 50;
function verdictOf(s) {
  if (s.sizedN >= EXEC_MIN_N) s = { ...s, avgClv: s.sizedClv, clvN: s.sizedN, clvT: s.sizedT ?? null };
  else if (s.execN >= EXEC_MIN_N) s = { ...s, avgClv: s.execClv, clvN: s.execN, clvT: s.execT ?? null };
  const clvN = s.clvN ?? s.n, roiN = s.graded ?? s.n;
  // CLV leads once it has a sample; until then ROI does, when there is one
  const useClv = s.avgClv != null && (clvN >= 8 || s.roi == null);
  const lead = useClv ? s.avgClv : s.roi;
  const leadN = useClv ? clvN : roiN;
  const clvBad = clvN >= 8 && (s.clvT ?? 0) <= -2;
  const clvProven = clvN >= PROVEN_N && (s.clvT ?? -Infinity) >= 2 && s.avgClv > 0;
  const roiProven = roiN >= PROVEN_N && (s.roiT ?? -Infinity) >= 2 && s.roi > 0 && !clvBad;
  if (clvProven || roiProven) return 'proven';
  const losing = leadN >= 8 && lead != null && lead <= 0 && (s.roi == null || s.roi < 0);
  if (clvBad || losing) return 'avoid';
  if (leadN >= 8 && lead != null && lead > 0) return 'promising';
  return 'early';
}

// Results against what the close expected. A close the play really beat
// predicts its wins; graded lines winning far less than that (1.5 sd under
// in units, over 30+ lines) say the close itself is wrong, the way FanDuel's
// alt lines (10-18) and BetRivers' stale lines (10-19) read +2% to +4% CLV
// while losing. lines: [{ win, p (close chance 0-1), d (decimal paid) }]
const SHORT_MIN_N = 30, SHORT_Z = -1.5;
function resultsShortfall(lines) {
  const l = (lines || []).filter(x => typeof x.win === 'boolean' && x.p > 0 && x.p < 1 && x.d > 1);
  if (!l.length) return { n: 0, short: false };
  const units = l.reduce((a, x) => a + (x.win ? x.d - 1 : -1), 0);
  const exp = l.reduce((a, x) => a + x.p * x.d - 1, 0);
  const sd = Math.sqrt(l.reduce((a, x) => a + x.p * (1 - x.p) * x.d * x.d, 0));
  const z = sd > 0 ? (units - exp) / sd : 0;
  const short = l.length >= SHORT_MIN_N && z <= SHORT_Z;
  return { n: l.length, units: r2(units), expUnits: r2(exp), z: r2(z), short,
    note: short ? `Not proven: ${l.length} graded lines made ${r2(units)} units where the close expected ${r2(exp) > 0 ? '+' : ''}${r2(exp)} (${r2(z)} sd), so the close is in doubt.` : null };
}

// bets → stats with a verdict
function score(bets) {
  const graded = bets.filter(b => b.profit != null && b.staked > 0);
  const staked = graded.reduce((x, b) => x + b.staked, 0);
  const units = graded.reduce((x, b) => x + b.profit, 0);
  const clvs = bets.map(b => b.clv).filter(v => v != null && Number.isFinite(v));
  const s = {
    n: bets.length, graded: graded.length,
    wins: graded.filter(b => b.profit > 0).length, losses: graded.filter(b => b.profit < 0).length,
    staked: r2(staked), units: r2(units), roi: staked > 0 ? r4(units / staked) : null,
    roiT: tStat(graded.map(b => b.profit / b.staked)),
    avgClv: clvs.length ? r4(mean(clvs)) : null, beatClosePct: clvs.length ? r4(clvs.filter(v => v > 0).length / clvs.length) : null,
    clvN: clvs.length, clvT: tStat(clvs),
  };
  // executable CLV: graded at what the bet cost a couple of minutes after the alert
  // (execAlertClv: the same bets at the alert, so the two compare like for like)
  const exB = bets.filter(b => b.exec != null && Number.isFinite(b.exec)), ex = exB.map(b => b.exec);
  if (ex.length) {
    const al = exB.map(b => b.clv).filter(v => v != null && Number.isFinite(v));
    Object.assign(s, { execClv: r4(mean(ex)), execBeatPct: r4(ex.filter(v => v > 0).length / ex.length), execN: ex.length, execT: tStat(ex), execAlertClv: al.length ? r4(mean(al)) : null });
  }
  // at size: $100 walked through the book at that same moment
  const sz = bets.map(b => b.sized).filter(v => v != null && Number.isFinite(v));
  if (sz.length) Object.assign(s, { sizedClv: r4(mean(sz)), sizedN: sz.length, sizedT: tStat(sz) });
  s.verdict = verdictOf(s);
  return s;
}

// ─── records → bets with the labels plays are cut by ─────────────────────────
const tailBet = r => ({
  profit: r.profit ?? null, staked: r.result === 'void' ? 0 : r.units, clv: r.clv ?? null,
  labels: { grade: r.grade ? `${r.grade} grade` : null, category: r.category || 'other', venue: r.venue || 'Polymarket', consensus: r.isConsensus ? 'consensus' : 'single wallet', order: r.order === 'limit' ? 'limit bid' : 'take' },
});
// evtrack: CLV in percent, no win/loss
// game: one per event (or player) and day, the unit a book's 50 counts in
const day = t => String(t || '').slice(0, 10);
// Main lines graded from an ESPN final carry their 1u result (evtrack
// setResult); the exchanges a Texan trades are graded on Pinnacle's own close
const PIN_GRADED = new Set(['gemini', 'polymarketus', 'kalshi']);
const evClv = b => (PIN_GRADED.has(b.book) && b.pinClv !== undefined ? b.pinClv : b.clv);
const evExec = b => (PIN_GRADED.has(b.book) && b.pinClv !== undefined ? b.execPinClv : b.execClv);
const evBet = b => ({ profit: b.profit ?? null, staked: b.profit != null ? 1 : 0, clv: evClv(b) != null ? evClv(b) / 100 : null, exec: evExec(b) != null ? evExec(b) / 100 : null,
  sized: b.execSizedClv != null ? b.execSizedClv / 100 : null, game: `${b.event || b.group}|${b.player || 'game'}|${day(b.start)}`,
  line: !PIN_GRADED.has(b.book) && (b.outcome === 'win' || b.outcome === 'loss') && b.closeFair != null && b.decimal != null ? { win: b.outcome === 'win', p: b.closeFair / 100, d: b.decimal } : null,
  labels: { sport: b.sport, book: b.book, market: b.market, kind: b.player ? 'player prop' : 'main line' } });
// sports pick'em props (sporttrack.js): CLV is the leg's EV at the close (the
// fair at the start times what the leg pays); the +2 min grade counts only legs
// still up at the same line and payout two minutes after the flag
const SPORT_BOOKS = { PP: 'PrizePicks', UD: 'Underdog', SL: 'Sleeper', P6: 'DK Pick6' };
// research rows and the stale-line legs (stalelines.js, their own record on
// the +EV tab) never count toward the sports props headline or its plays
// leads with records of their own (stale lines, the books' fair) stay out of the verdict
const SPORT_RESEARCH = new Set(['gap-odd', 'gap-stale', 'shop-any', 'shop-pp', 'shop-p6', 'shop-mid', 'stale', 'stale-single', 'book-fair', 'book-fair-single', 'p6-book-fair', 'p6-book-fair-single', 'book-consensus', 'p6-book-consensus', 'sharp3', 'p6-sharp3', 'combo', 'p6-combo', 'nba-model', 'p6-nba-model', 'cfb-model', 'p6-cfb-model', 'mlb-pin', 'p6-mlb-pin', 'ud-mlb-pin', 'sl-mlb-pin', 'mlb-even', 'p6-mlb-even', 'ud-mlb-even', 'sl-mlb-even']);
const SPORT_KIND = { gap: 'line gap', ev: 'sharp price', sharp: 'sharp consensus', 'p6-gap': 'Pick6 line gap', 'p6-ev': 'Pick6 sharp price', 'p6-sharp': 'Pick6 sharp consensus', 'nba-model': 'NBA model', 'p6-nba-model': 'Pick6 NBA model', 'cfb-model': 'CFB model', 'p6-cfb-model': 'Pick6 CFB model', 'mlb-pin': 'MLB vs Pinnacle, PrizePicks', 'p6-mlb-pin': 'MLB vs Pinnacle, Pick6', 'ud-mlb-pin': 'MLB vs Pinnacle, Underdog', 'sl-mlb-pin': 'MLB vs Pinnacle, Sleeper', 'mlb-even': 'MLB at Pinnacle\'s number, PrizePicks', 'p6-mlb-even': 'MLB at Pinnacle\'s number, Pick6', 'ud-mlb-even': 'MLB at Pinnacle\'s number, Underdog', 'sl-mlb-even': 'MLB at Pinnacle\'s number, Sleeper' };
const sportPropBet = r => {
  const graded = r.status === 'graded' && r.outcome !== 'push';
  const clv = r.closeEv != null ? r.closeEv / 100 : null;
  return { profit: graded ? r.profit ?? null : null, staked: graded ? 1 : 0, clv, exec: r.execOk === true ? clv : null,
    game: `${r.sport}|${r.player}|${r.mkey}|${day(r.start || r.startTime)}`,
    line: graded && r.closeFair != null && r.signalDecimal != null ? { win: r.outcome === 'win', p: r.closeFair, d: r.signalDecimal } : null,
    labels: { kind: SPORT_KIND[r.kind] || 'sharp price', sport: r.sport, book: SPORT_BOOKS[r.signalBook] || r.signalBook, stat: r.mkey } };
};
const pickBet = r => ({
  profit: r.status === 'graded' ? r.profit ?? null : null, staked: r.status === 'graded' && r.outcome !== 'push' ? 1 : 0, clv: null,
  labels: { sport: r.sport, stat: r.stat, side: r.signalSide },
});

const BIG_VENUES = { prizepicks: 'PrizePicks', underdog: 'Underdog', sleeper: 'Sleeper', fanduel: 'FanDuel', betrivers: 'BetRivers' };
// pin: the same ticket graded on Pinnacle's no-vig close (sharpEv), counted
// only when the close was read within the hour before the start (closeOk);
// game: one per Pinnacle game and day, the unit the strict rule counts in
const bigMoneyBet = r => {
  const graded = r.status === 'graded' && r.outcome !== 'push';
  const clv = r.closeEv != null ? r.closeEv / 100 : null;
  const pinOk = r.sharpEv != null && r.closeOk !== false;
  return { profit: graded ? r.profit ?? null : null, staked: graded ? 1 : 0, clv, exec: r.execOk === true ? clv : null,
    pin: pinOk ? r.sharpEv / 100 : null, execOk: r.execOk === true, game: `${String(r.betKey || r.title || '').split('|')[0]}|${day(r.start)}`,
    line: graded && pinOk && r.sharpFair > 0 && r.decimal > 1 ? { win: r.outcome === 'win', p: r.sharpFair, d: r.decimal } : null,
    labels: { flow: r.flow || 'bettor', venue: BIG_VENUES[r.venue] || r.venue, kind: r.kind === 'prop' ? 'player prop' : 'game line', line: r.sameLine === false ? 'other line' : 'same line' } };
};
// A tail counts once it settles, or as CLV only (no profit yet) once its
// close is in: a game's close is known at kick-off, hours before Polymarket
// resolves it. A bid still waiting to fill isn't a bet.
const tailDone = r => (r.status === 'settled' ? r.result !== 'unfilled' : r.clv != null && !(r.order === 'limit' && !r.filled));

// source → which records count and how plays are cut
const SOURCES = {
  tail: { label: 'Sharp Tail', done: tailDone, open: r => r.status !== 'settled', bet: tailBet, cuts: [['grade'], ['category'], ['grade', 'category'], ['venue'], ['consensus'], ['order']] },
  fresh: { label: 'Fresh wallets', done: tailDone, open: r => r.status !== 'settled', bet: tailBet, cuts: [['category'], ['venue']] },
  // edges priced off Pinnacle's no-vig line keep their own record
  esportsEdges: { label: 'Esports edges', done: b => b.status === 'closed',
    bet: b => { const x = evBet(b); x.labels.fair = b.source === 'esboard-pin' ? 'vs Pinnacle' : b.source === 'esboard-bid' ? 'limit bid' : 'vs exchanges'; return x; },
    cuts: [['fair'], ['sport'], ['book'], ['market'], ['sport', 'book'], ['fair', 'market']] },
  // steam (a price Polymarket just moved), a line mover (a big move today,
  // followed near fair) and a standing gap are cut apart
  exchangeValue: { label: 'Exchange value', done: b => b.status === 'closed',
    bet: b => { const x = evBet(b); x.labels.signal = b.source === 'mover' ? 'line mover' : b.source === 'steam' ? 'steam' : b.source === 'kalshiref' ? 'Kalshi price' : 'price gap'; return x; },
    cuts: [['signal'], ['sport'], ['book'], ['market'], ['sport', 'book'], ['signal', 'sport']] },
  ev: { label: '+EV screener', done: b => b.status === 'closed', bet: evBet, cuts: [['sport'], ['book'], ['market'], ['book', 'kind']] },
  // a filled bid-then-hedge is graded on its lock at once (1u); unfilled and cancelled ones aren't bets
  bidArbs: { label: 'Bid, then hedge', done: r => r.status === 'filled' && r.lock != null, open: r => r.status === 'open',
    bet: r => ({ profit: r.lock / 100, staked: 1, clv: null, labels: { venue: r.maker?.venue === 'kalshi' ? 'bid on Kalshi' : 'bid on Polymarket US', market: r.kind } }),
    cuts: [['venue'], ['market']] },
  // a middle is graded on whether the final landed between its lines (1u staked)
  middles: { label: 'Middles', done: r => r.status === 'graded', open: r => r.status === 'open',
    bet: r => ({ profit: r.profit, staked: 1, clv: null, labels: { league: r.league, kind: r.kind } }), cuts: [['league'], ['kind']] },
  // a gas lock: 1u at its first price, graded on Kalshi's result and on our side's last mid (gaslocks.js)
  gasLocks: { label: 'Gas locks', done: r => r.status === 'graded', open: r => r.status === 'open',
    bet: r => ({ profit: r.profit, staked: 1, clv: r.clv ?? null, labels: { state: r.state, price: r.price >= 0.96 ? '96-98c' : r.price >= 0.93 ? '93-95c' : '90-92c' } }),
    cuts: [['state'], ['price']] },
  // research rows (unpriced gaps tracked both ways) are never plays
  sportsProps: { label: 'Sports props', done: r => !SPORT_RESEARCH.has(r.kind) && (r.status === 'graded' || r.status === 'locked'),
    open: r => !SPORT_RESEARCH.has(r.kind) && r.status === 'open', bet: sportPropBet,
    cuts: [['kind'], ['sport'], ['book'], ['kind', 'book'], ['sport', 'stat']] },
  // big money: the bet a big exchange print backed, taken at a softer venue
  // (bigmoney.js). CLV is our ticket's EV at the money's market close; the
  // +2 min grade counts only plays still up at that venue's price two minutes on
  bigMoney: { label: 'Big money', done: r => r.status === 'graded' || r.status === 'locked', open: r => r.status === 'open', bet: bigMoneyBet,
    cuts: [['flow'], ['venue'], ['kind'], ['line'], ['flow', 'venue'], ['kind', 'flow']] },
  esportsPicks: { label: 'Esports props', done: r => r.status === 'graded', bet: pickBet, cuts: [['sport'], ['stat'], ['side'], ['sport', 'stat', 'side']] },
};
// sportsbook records whose proven mark must come from one book's own sample
const BOOK_SOURCES = new Set(['ev', 'sportsProps']);
const PROVEN_BOOK_N = 50;
// books read only through Action Network's copy of their prices
const RELAYED_BOOKS = new Set(['draftkings', 'betmgm', 'caesars', 'bet365', 'fanatics', 'hardrock', 'thescore', 'DraftKings', 'BetMGM', 'Caesars', 'Fanatics', 'Hard Rock', 'theScore']);
// the bets behind a verdict: the sized or 2-minute grade once 8+ carry one, else the close
const judgedN = s => (s.sizedN >= EXEC_MIN_N ? s.sizedN : s.execN >= EXEC_MIN_N ? s.execN : (s.clvN ?? s.graded ?? s.n));
// games (one per event or player stat and day) among the bets that carry a CLV
const gamesOf = bets => new Set(bets.filter(b => b.clv != null && Number.isFinite(b.clv)).map(b => b.game ?? b)).size;
// What may read 'proven' (the strict rule, closeboard.js): one kind on one book
// read direct, 50+ games, CLV t of 2+ and positive, results not 1.5 sd under the
// close. Pooled cuts, killed kinds and negative-CLV cuts stop at promising.
// The sales page and the app show this label (10-24: 7 failing plays read proven).
const KILLED_SOURCES = { fresh: 'Fresh-wallet following was killed out of sample 10-24 (no edge)' };
function cap(s, why, extra = {}) {
  return { ...s, verdict: s.verdict === 'proven' ? 'promising' : s.verdict, provenNote: why, ...extra };
}
function bookGuard(source, by, s, { bets = null, vals = null } = {}) {
  if (s.verdict === 'avoid') return s;
  if (s.verdict === 'proven' && KILLED_SOURCES[source]) return cap(s, KILLED_SOURCES[source]);
  if (s.verdict === 'proven' && s.avgClv != null && s.avgClv <= 0) return cap(s, `not proven: closes ${(s.avgClv * 100).toFixed(1)}% CLV, the price did not beat the close`);
  if (source === 'bigMoney' && s.verdict === 'proven') return bigMoneyGuard(by, s, bets, vals);
  if (!BOOK_SOURCES.has(source)) return s;
  // pick'em legs: flagged legs do not beat Pinnacle's price (10-24 checks), nothing here is proven
  if (source === 'sportsProps' && s.verdict === 'proven') return cap(s, "not proven: flagged pick'em legs have not beaten Pinnacle's price on results (10-24 checks)");
  const cuts = by ? by.split('+') : [];
  const book = vals && cuts.includes('book') ? vals[cuts.indexOf('book')] : null;
  const kind = vals && cuts.includes('kind') ? vals[cuts.indexOf('kind')] : null;
  const ownBook = cuts.length === 2 && book != null && kind != null;
  const games = bets ? Math.min(judgedN(s), gamesOf(bets)) : judgedN(s);
  const relayed = ownBook && RELAYED_BOOKS.has(book);
  const short = bets ? resultsShortfall(bets.map(b => b.line).filter(Boolean)) : { short: false, n: 0 };
  const clv = s.avgClv != null ? `, ${s.avgClv > 0 ? '+' : ''}${(s.avgClv * 100).toFixed(1)}% CLV` : '';
  const strictClv = (s.clvN ?? 0) >= PROVEN_N && (s.clvT ?? -Infinity) >= 2 && s.avgClv > 0;
  if (ownBook && !relayed && games >= PROVEN_BOOK_N && strictClv && !short.short && !(source === 'ev' && kind !== 'main line')) return s;
  const why = short.short ? short.note
    : !ownBook ? `not proven yet: ${games} graded${clv}`
    : source === 'ev' && kind !== 'main line' ? `not proven: ${kind} lines are not the proven kind, ${games} graded${clv}`
    : !strictClv ? `not proven yet: ${games} graded${clv}, CLV t ${s.clvT ?? 'n/a'}`
    : `not proven yet: ${games} graded${clv}${relayed ? ', price copied via Action Network, never checked at the book' : ''}`;
  return cap(s, why, { games });
}
// Big money (10-25 re-check, checks/brmoney-recheck-2026-10-25): its own CLV
// is the ticket against the exchange's mid, and its cuts pool game lines with
// props and count every line on a game. It reads proven only on the strict
// rule: a cut naming one venue, game lines only, 50+ games (one per Pinnacle
// game and day), Pinnacle's close beaten at a t of 2+ on the bets still up two
// minutes on (all bets until 8 have that grade), results not 1.5 sd under it.
function bigMoneyGuard(by, s, bets, vals) {
  const cuts = by ? by.split('+') : [];
  const venue = vals && cuts.includes('venue') ? vals[cuts.indexOf('venue')] : null;
  const list = bets || [];
  const props = list.filter(b => b.labels?.kind !== 'game line').length;
  const exec = list.filter(b => b.execOk && b.pin != null);
  const use = exec.length >= EXEC_MIN_N ? exec : list.filter(b => b.pin != null);
  const g = new Map();
  for (const b of use) { if (!g.has(b.game)) g.set(b.game, []); g.get(b.game).push(b.pin); }
  const per = [...g.values()].map(mean);
  const pinClv = per.length ? r4(mean(per)) : null, pinT = tStat(per);
  const short = resultsShortfall(list.map(b => b.line).filter(Boolean));
  const extra = { games: per.length, pinClv, pinT };
  const pc = pinClv != null ? `${pinClv > 0 ? '+' : ''}${(pinClv * 100).toFixed(1)}%` : 'n/a';
  if (!venue) return cap(s, `not proven: pooled across venues, ${per.length} games`, extra);
  if (props) return cap(s, `not proven: pools ${props} player props with game lines`, extra);
  if (short.short) return cap(s, short.note, extra);
  if (per.length < PROVEN_BOOK_N || !(pinT >= 2) || !(pinClv > 0)) return cap(s, `not proven yet: ${per.length} games, ${pc} vs Pinnacle's close${exec.length >= EXEC_MIN_N ? ' two minutes on' : ''}, t ${pinT ?? 'n/a'}`, extra);
  return { ...s, ...extra };
}
const VERDICT_ORDER = { proven: 0, promising: 1, early: 2, avoid: 3 };

// lists: { tail: [records], fresh, esportsEdges, exchangeValue, ev, esportsPicks, gasLocks } →
// { sources: { name: { label, open, overall } }, plays: [ranked] }
function scoreboard(lists, { sinceMs = 0, minN = 3 } = {}) {
  const sources = {}, plays = [];
  for (const [name, def] of Object.entries(SOURCES)) {
    const all = (lists[name] || []).filter(r => !sinceMs || (Date.parse(r.recordedAt || r.flaggedAt || r.startTime) || 0) >= sinceMs);
    const done = all.filter(def.done);
    const bets = done.map(def.bet);
    const open = def.open ? all.filter(def.open).length : all.length - done.length - all.filter(r => r.result === 'unfilled').length;
    sources[name] = { label: def.label, open, overall: bookGuard(name, null, score(bets)) };
    if (bets.length) plays.push({ source: name, label: def.label, play: 'all', ...bookGuard(name, null, sources[name].overall) });
    for (const cut of def.cuts) {
      const g = new Map();
      for (const b of bets) {
        const vals = cut.map(k => b.labels[k]);
        if (vals.some(v => v == null || v === '')) continue;
        const k = vals.join(' · ');
        if (!g.has(k)) g.set(k, []);
        g.get(k).push(b);
      }
      for (const [k, list] of g) {
        if (list.length < minN) continue;
        plays.push({ source: name, label: def.label, play: k, by: cut.join('+'), ...bookGuard(name, cut.join('+'), score(list), { bets: list, vals: cut.map(k2 => list[0].labels[k2]) }) });
      }
    }
  }
  const lead = p => p.clvT ?? p.roiT ?? -Infinity;
  plays.sort((a, b) => VERDICT_ORDER[a.verdict] - VERDICT_ORDER[b.verdict] || lead(b) - lead(a) || b.n - a.n);
  return { sources, plays };
}

module.exports = { scoreboard, score, tStat, resultsShortfall, verdictOf, SOURCES, EXEC_MIN_N, PROVEN_N, PROVEN_BOOK_N, BOOK_SOURCES, RELAYED_BOOKS };
