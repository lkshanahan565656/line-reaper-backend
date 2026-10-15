// ─── WHAT'S WINNING ───────────────────────────────────────────────────────────
// One scoreboard across every track record: Sharp Tail signals, the
// fresh-wallet radar, the +EV screener, esports exchange edges, exchange
// value (US exchange prices under Polymarket's) and esports prop picks. Each record becomes a bet { profit, staked, clv }, bets are
// grouped into plays (A-grade sports tails, Kalshi CS2 match edges, ...) and
// every play gets a verdict from its own sample:
//
//   proven     20+ bets and a t-stat of 2+ on CLV or on ROI, with it positive
//              (CLV here is the 2-minute grade once 8+ bets have one)
//   promising  8+ bets, beating the close (or in profit when there's no CLV)
//   avoid      8+ bets, losing to the close and losing money (or a t of -2)
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
function verdictOf(s) {
  if (s.sizedN >= EXEC_MIN_N) s = { ...s, avgClv: s.sizedClv, clvN: s.sizedN, clvT: s.sizedT ?? null };
  else if (s.execN >= EXEC_MIN_N) s = { ...s, avgClv: s.execClv, clvN: s.execN, clvT: s.execT ?? null };
  const clvN = s.clvN ?? s.n, roiN = s.graded ?? s.n;
  // CLV leads once it has a sample; until then ROI does, when there is one
  const useClv = s.avgClv != null && (clvN >= 8 || s.roi == null);
  const lead = useClv ? s.avgClv : s.roi;
  const leadN = useClv ? clvN : roiN;
  const clvProven = clvN >= 20 && (s.clvT ?? -Infinity) >= 2 && s.avgClv > 0;
  const roiProven = roiN >= 20 && (s.roiT ?? -Infinity) >= 2 && s.roi > 0;
  if (clvProven || roiProven) return 'proven';
  const clvBad = clvN >= 8 && (s.clvT ?? 0) <= -2;
  const losing = leadN >= 8 && lead != null && lead <= 0 && (s.roi == null || s.roi < 0);
  if (clvBad || losing) return 'avoid';
  if (leadN >= 8 && lead != null && lead > 0) return 'promising';
  return 'early';
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
const evBet = b => ({ profit: null, staked: 0, clv: b.clv != null ? b.clv / 100 : null, exec: b.execClv != null ? b.execClv / 100 : null,
  sized: b.execSizedClv != null ? b.execSizedClv / 100 : null, labels: { sport: b.sport, book: b.book, market: b.market } });
// sports pick'em props (sporttrack.js): CLV is the leg's EV at the close (the
// fair at the start times what the leg pays); the +2 min grade counts only legs
// still up at the same line and payout two minutes after the flag
const SPORT_BOOKS = { PP: 'PrizePicks', UD: 'Underdog', SL: 'Sleeper', P6: 'DK Pick6' };
// research rows and the stale-line legs (stalelines.js, their own record on
// the +EV tab) never count toward the sports props headline or its plays
// leads with records of their own (stale lines, the books' fair) stay out of the verdict
const SPORT_RESEARCH = new Set(['gap-odd', 'gap-stale', 'stale', 'stale-single', 'book-fair', 'book-fair-single', 'p6-book-fair', 'p6-book-fair-single']);
const SPORT_KIND = { gap: 'line gap', ev: 'sharp price', sharp: 'sharp consensus', 'p6-gap': 'Pick6 line gap', 'p6-ev': 'Pick6 sharp price', 'p6-sharp': 'Pick6 sharp consensus' };
const sportPropBet = r => {
  const graded = r.status === 'graded' && r.outcome !== 'push';
  const clv = r.closeEv != null ? r.closeEv / 100 : null;
  return { profit: graded ? r.profit ?? null : null, staked: graded ? 1 : 0, clv, exec: r.execOk === true ? clv : null,
    labels: { kind: SPORT_KIND[r.kind] || 'sharp price', sport: r.sport, book: SPORT_BOOKS[r.signalBook] || r.signalBook, stat: r.mkey } };
};
const pickBet = r => ({
  profit: r.status === 'graded' ? r.profit ?? null : null, staked: r.status === 'graded' && r.outcome !== 'push' ? 1 : 0, clv: null,
  labels: { sport: r.sport, stat: r.stat, side: r.signalSide },
});

const BIG_VENUES = { prizepicks: 'PrizePicks', underdog: 'Underdog', sleeper: 'Sleeper', fanduel: 'FanDuel', betrivers: 'BetRivers' };
const bigMoneyBet = r => {
  const graded = r.status === 'graded' && r.outcome !== 'push';
  const clv = r.closeEv != null ? r.closeEv / 100 : null;
  return { profit: graded ? r.profit ?? null : null, staked: graded ? 1 : 0, clv, exec: r.execOk === true ? clv : null,
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
  ev: { label: '+EV screener', done: b => b.status === 'closed', bet: evBet, cuts: [['sport'], ['book'], ['market']] },
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
    sources[name] = { label: def.label, open, overall: score(bets) };
    if (bets.length) plays.push({ source: name, label: def.label, play: 'all', ...sources[name].overall });
    for (const cut of def.cuts) {
      const g = new Map();
      for (const b of bets) {
        const vals = cut.map(k => b.labels[k]);
        if (vals.some(v => v == null || v === '')) continue;
        const k = vals.join(' · ');
        if (!g.has(k)) g.set(k, []);
        g.get(k).push(b);
      }
      for (const [k, list] of g) if (list.length >= minN) plays.push({ source: name, label: def.label, play: k, by: cut.join('+'), ...score(list) });
    }
  }
  const lead = p => p.clvT ?? p.roiT ?? -Infinity;
  plays.sort((a, b) => VERDICT_ORDER[a.verdict] - VERDICT_ORDER[b.verdict] || lead(b) - lead(a) || b.n - a.n);
  return { sources, plays };
}

module.exports = { scoreboard, score, tStat, verdictOf, SOURCES, EXEC_MIN_N };
