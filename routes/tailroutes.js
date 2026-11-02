// Sharp Tail endpoints: signals, wallets, whales and cross-venue arbs
// Moved out of server.js as it was (the route split): mount(ctx) runs where
// the section used to be, so routes keep their order. ctx carries what the
// section reads from server.js; it returns what server.js reads back.
'use strict';

module.exports = function mount(ctx) {
// ctx.BIG_OPTS, ctx.bigState, ctx.bigTracker and the book arb state are set up
// further down server.js: read per request
const {
  FRESH_BACKTEST, LICENCE_NOTE, OFFSHORE_PAIRS, STEAM_ALERT_MIN, TAIL_FREE_DELAY_MS,
  TAIL_REGION, XARB_ALERT_MIN, XARB_OPTS, XVALUE_ALERT_MIN, XVALUE_BOOKS, XVALUE_EXEC,
  XVALUE_MIN_DEPTH, XVALUE_OPTS, XVALUE_VENUES, app, arbOk, bidTracker, bigMoney,
  boardLivePrice, cold, esinplay, freshTracker, gasState,
  gasTracker, gaslocks, hasPro, hiddenWallets, inplayLive, inplayTracker, licenceOf, licenceState,
  maskSignal, maskTrader, maskWallet, maskWhale, middleTracker, offshoreRef, offshoreRefOn,
  offshoreref, publicWhaleState, regionSafe, requirePro, steamWatch, tail, tailEngine, tailTracker,
  valueOk, venueFor, whaleOk, whaleWatcher, withheldOf, xarb, xarbState, xvalue, xvalueState,
  xvalueTracker
} = ctx;

const withheldBody = list => (list.length ? { withheld: list, note: LICENCE_NOTE } : {});

// Scored wallets, best first. ?category=politics&grade=A|B|graded&limit=100.
// Free: the leaderboard with wallets masked.
app.get('/api/tail/traders', (req, res) => {
  const pro = hasPro(req), lic = licenceOf(req);
  const category = tail.CATEGORIES.includes(req.query.category) ? req.query.category : null;
  const g = String(req.query.grade || '').toUpperCase();
  const grade = ['A', 'B', 'GRADED'].includes(g) ? g : null;
  const list = lic.polymarket ? tailEngine.traders({ category, grade, limit: Math.min(parseInt(req.query.limit) || 100, 500) }) : [];
  const st = tailEngine.state();
  res.json(regionSafe({
    traders: pro ? list.map(({ holdings, ...t }) => t) : list.map(maskTrader), pro, category, grade,
    state: { candidates: st.candidates, scored: st.scored, pending: st.pending, graded: st.graded, lastScoreAt: st.lastScoreAt },
    ...withheldBody(withheldOf(lic, ['polymarket'])),
  }));
});
// The Sharp Board: markets where graded wallets hold a position now, the side
// with the most sharp weight first, with where a US bettor can take that side.
// Pro: wallets and venue prices. Free: the top rows, wallets masked, the rest
// counted as locked. ?category=politics&limit=50
const BOARD_FREE_ROWS = 3;
function boardVenues(row, lic, now = Date.now()) {
  let quotes = [];
  try {
    quotes = xarb.venueQuotes({ type: 'entry', conditionId: row.conditionId, asset: row.lead.asset, outcome: row.lead.outcome, outcomeIndex: row.lead.outcomeIndex, market: row.title },
      xarbState.venues, { ...XARB_OPTS, now });
  } catch (e) { console.warn('Board venues:', e.message); }
  return quotes.filter(v => lic.kalshi || v.key !== 'kalshi').sort((a, b) => a.cost - b.cost)
    .map(v => ({ key: v.key, name: v.name, price: v.price, fee: v.fee, cost: v.cost, american: v.american ?? null, pick: v.pick || null, buy: v.buy || null, url: v.url || null, warning: v.warning || null }));
}
app.get('/api/tail/board', (req, res) => {
  const pro = hasPro(req), lic = licenceOf(req);
  const category = tail.CATEGORIES.includes(req.query.category) ? req.query.category : null;
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const rows = lic.polymarket ? tailEngine.sharpBoard({ category, limit, livePrice: boardLivePrice }) : [];
  const now = Date.now();
  const full = rows.map(r => ({ ...r, venues: boardVenues(r, lic, now) }));
  const mask = r => ({ ...r, conditionId: null, lead: { ...r.lead, asset: null, list: r.lead.list.map(w => ({ grade: w.grade, wallet: maskWallet(w.wallet), name: null, cost: null })) }, locked: true });
  const st = tailEngine.state();
  res.json(regionSafe({
    rows: pro ? full : full.slice(0, BOARD_FREE_ROWS).map(mask), locked: pro ? 0 : Math.max(0, full.length - BOARD_FREE_ROWS), pro, category,
    graded: st.graded, scored: st.scored, pending: st.pending, updated: new Date(now).toISOString(),
    ...withheldBody(withheldOf(lic, ['polymarket'])),
  }));
});

// One wallet's full score, its recent signals and their record (Pro: a
// wallet's grade is what's being sold).
app.get('/api/tail/trader/:wallet', requirePro, async (req, res) => {
  const lic = licenceOf(req);
  if (!lic.polymarket) return res.status(403).json({ error: `Polymarket wallets: ${LICENCE_NOTE}`, ...withheldBody(['polymarket']) });
  if (hiddenWallets().includes(String(req.params.wallet).toLowerCase())) return res.status(404).json({ error: 'That wallet has not been scored yet' });
  const tr = tailEngine.trader(req.params.wallet);
  if (!tr) return res.status(404).json({ error: 'That wallet has not been scored yet' });
  const signals = tailEngine.signals({ limit: 500 }).filter(s => s.wallet === tr.wallet).slice(0, 50).map(s => venueFor(s, lic));
  let record = [];
  try { record = (await tailTracker.list({ limit: 5000 })).filter(r => r.wallet === tr.wallet).slice(0, 50); } catch { /* store down */ }
  res.json(regionSafe({ trader: tr, signals, record }));
});
// Newest first. ?type=entry|exit&since=<iso>&limit=100. Pro: live. Free: only
// signals at least 30 minutes old, wallets masked; `locked` counts the rest.
// Each entry carries `venue` (where to tail it: the most units, or null) and
// every `venues` quote.
app.get('/api/tail/signals', (req, res) => {
  const pro = hasPro(req), lic = licenceOf(req);
  const type = ['entry', 'exit'].includes(req.query.type) ? req.query.type : null;
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  let list = lic.polymarket ? tailEngine.signals({ limit: 500, type, since: req.query.since || null }).map(s => venueFor(s, lic)) : [];
  let locked = 0;
  if (!pro) {
    const cut = Date.now() - TAIL_FREE_DELAY_MS;
    const old = list.filter(s => Date.parse(s.seenAt || s.at) <= cut);
    locked = list.length - old.length;
    list = old.map(maskSignal);
  }
  res.json(regionSafe({ signals: list.slice(0, limit), pro, delayMinutes: pro ? 0 : TAIL_FREE_DELAY_MS / 60e3, locked, updated: tailEngine.state().lastPollAt,
    region: TAIL_REGION, ...withheldBody(withheldOf(lic, ['polymarket'])) }));
});
// The signals' own track record: free, since it's the pitch. Open ones are
// live tails, so free users only see the settled list. The rows are
// Polymarket wallets' bets, so they need that licence; the totals don't.
// ?days=30&grade=A&category=politics&status=open|settled&limit=50
app.get('/api/tail/record', async (req, res) => {
  try {
    const pro = hasPro(req), lic = licenceOf(req);
    const q = req.query;
    // ?book=fresh: the fresh-wallet radar's record instead
    const book = q.book === 'fresh' ? 'fresh' : 'tail';
    const tracker = book === 'fresh' ? freshTracker : tailTracker;
    const grade = ['A', 'B'].includes(String(q.grade || '').toUpperCase()) ? String(q.grade).toUpperCase() : undefined;
    const category = tail.CATEGORIES.includes(q.category) ? q.category : undefined;
    const sinceDays = parseFloat(q.days) || undefined;
    const summary = { ...(await tracker.summary({ sinceDays, grade, category })), book };
    const status = pro ? (['open', 'settled'].includes(q.status) ? q.status : undefined) : 'settled';
    const cut = sinceDays ? Date.now() - sinceDays * 86400e3 : 0;
    const list = !lic.polymarket ? [] : (await tracker.list({ status, limit: 5000 }))
      .filter(r => (!grade || r.grade === grade) && (!category || r.category === category) && Date.parse(r.recordedAt) >= cut)
      .slice(0, Math.min(parseInt(q.limit) || 50, 500));
    res.json(regionSafe({ ...summary, signals: pro ? list : list.map(maskSignal), pro, ...withheldBody(withheldOf(lic, ['polymarket'])) }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Whale prints (newest first) and per-market flow over the last hour.
// ?exchange=kalshi|polymarket&graded=1|0&fresh=1|0&minUsd=10000&since=<iso>&limit=100.
// Free: wallets masked, and graded and fresh-wallet tags only once they're 30
// minutes old. Each exchange's prints need its licence, and so do Kalshi venues.
// freshRecord: the fresh-wallet radar's totals (its bets: /api/tail/record?book=fresh).
const kalshiVenuesOk = lic => e => (lic.kalshi || !Array.isArray(e?.venues) ? e
  : { ...e, venues: e.venues.filter(v => v.key !== 'kalshi'), venue: e.venues.find(v => v.key !== 'kalshi') || null });
app.get('/api/whales', async (req, res) => {
  const pro = hasPro(req), lic = licenceOf(req);
  const q = req.query;
  const exchange = ['kalshi', 'polymarket'].includes(q.exchange) ? q.exchange : null;
  const graded = pro && q.graded != null && q.graded !== '' ? /^(1|true|yes)$/i.test(q.graded) : null;
  const freshOnly = pro && q.fresh != null && q.fresh !== '' ? /^(1|true|yes)$/i.test(q.fresh) : null;
  const minUsd = parseFloat(q.minUsd);
  const t = Date.now();
  const limit = Math.min(parseInt(q.limit) || 100, 500);
  const shown = whaleOk(lic);
  // the feed is cut to this viewer's exchanges before the limit, so a withheld one doesn't eat it
  const only = exchange || (lic.kalshi === lic.polymarket ? null : lic.kalshi ? 'kalshi' : 'polymarket');
  const events = lic.kalshi || lic.polymarket ? whaleWatcher.events({ limit, exchange: only, graded, fresh: freshOnly, minUsd: Number.isFinite(minUsd) ? minUsd : null, since: q.since || null })
    .filter(shown).map(kalshiVenuesOk(lic)) : [];
  const flow = whaleWatcher.flow({ exchange, limit: Math.min(parseInt(q.flowLimit) || 50, 200) }).filter(f => shown(f));
  let freshRecord = null;
  try { const r = await freshTracker.summary({}); freshRecord = { overall: r.overall, clustered: r.clustered, texas: r.texas, firstBet: r.firstBet, firstBetTexas: r.firstBetTexas, backtest: FRESH_BACKTEST, open: r.open }; } catch { /* store down */ }
  res.json(regionSafe({
    freshRecord,
    events: pro ? events : events.map(e => maskWhale(e, t)),
    flow: pro ? flow : flow.map(f => ({ ...f, largest: maskWhale(f.largest, t) })),
    pro, minUsd: whaleWatcher.settings().minUsd, windowMs: whaleWatcher.settings().windowMs, state: pro ? whaleWatcher.state() : publicWhaleState(whaleWatcher.state()),
    ...withheldBody(withheldOf(lic, ['kalshi', 'polymarket'])),
  }));
});
// Exchange arbs, best first, and `near`: the watchlist of pairs and sets just
// short of one (xarb.findNearArbs). ?type=cross|multi|book&category=sports&minPct=1.
// `bids`: pairs a limit bid on one venue and a take on the other would lock
// (xarb.findBidArbs). `middles`: a total or spread at two lines on two venues
// (xarb.findMiddles).
// Stakes are the same for everyone: each leg's `pct` of the total (and the
// $100 reference split in `stakes`). US mode only has Kalshi and US
// sportsbook legs. Free: count and profit % only.
app.get('/api/xarbs', async (req, res) => {
  const pro = hasPro(req), lic = licenceOf(req);
  const q = req.query;
  const minPct = parseFloat(q.minPct);
  const arbs = xarbState.arbs.filter(arbOk(lic))
    .filter(a => (!q.type || a.type === q.type) && (!q.category || a.category === q.category) && (!Number.isFinite(minPct) || a.profitPct >= minPct));
  const near = (xarbState.near || []).filter(arbOk(lic)).filter(a => !q.category || a.category === q.category);
  const bids = (xarbState.bids || []).filter(arbOk(lic)).filter(a => !q.category || a.category === q.category);
  const middles = (xarbState.middles || []).filter(arbOk(lic));
  let bidRecord = null, middleRecord = null;
  let bookRecord = null;
  try { [bidRecord, middleRecord, bookRecord] = await Promise.all([bidTracker.summary(), middleTracker.summary(), ctx.bookArbTracker.summary()]); } catch { /* store down */ }
  // sportsbook pairs (bookarbs.js): FanDuel, BetRivers, Kalshi, Polymarket US
  const bookArbList = ctx.bookArbState.arbs.filter(arbOk(lic)), bookMiddleList = ctx.bookArbState.middles.filter(arbOk(lic));
  const books = { arbCount: bookArbList.length, middleCount: bookMiddleList.length, updated: ctx.bookArbState.updated, record: bookRecord };
  const base = { count: arbs.length, nearCount: near.length, bidCount: bids.length, middleCount: middles.length, bidRecord, bidClosed: cold.closedInfo('bidArbs'), middleRecord, updated: xarbState.updated, pro, region: TAIL_REGION, ...withheldBody(withheldOf(lic, TAIL_REGION === 'us' ? ['kalshi'] : ['kalshi', 'polymarket'])) };
  if (!pro) return res.json({ ...base, books: { ...books, arbs: bookArbList.map(a => ({ profitPct: a.profitPct, locked: true })) }, arbs: arbs.map(a => ({ profitPct: a.profitPct, locked: true })) });
  res.json(regionSafe({
    ...base, books: { ...books, arbs: bookArbList, middles: bookMiddleList.slice(0, 60), counts: ctx.bookArbState.counts },
    arbs: arbs.slice(0, Math.min(parseInt(q.limit) || 200, 1000)), near, bids, middles,
    minPct: XARB_OPTS.minPct ?? xarb.DEFAULTS.minPct, counts: xarbState.counts, errors: xarbState.errors.slice(0, 5),
  }));
});
// Book arbs' fill record (bookarbtrack.js): each row and its +2 min check. ?limit=200
app.get('/api/book-arbs/record', async (req, res) => {
  try {
    const summary = await ctx.bookArbTracker.summary();
    if (!hasPro(req)) return res.json({ summary });
    res.json({ summary, rows: await ctx.bookArbTracker.list({ limit: Math.min(parseInt(req.query.limit) || 200, 2000) }) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// The exchanges' odds screen (xarb.exchangeScreen): games in the next 36
// hours, each side's all-in price on Kalshi and Polymarket US. Free: the count.
app.get('/api/xscreen', (req, res) => {
  const pro = hasPro(req), lic = licenceOf(req);
  // without Kalshi's data licence its prices are left out, not the games
  // without Polymarket's, the fair column (its mid) is
  const rows = (xarbState.screen || [])
    .map(r => (lic.kalshi ? r : { ...r, sides: r.sides.map(x => ({ ...x, kalshi: null, kalshiUrl: null, best: x.other != null ? r.venue : null, gap: null, ev: x.fair != null && x.other != null ? Math.round((x.fair / x.other - 1) * 1e4) / 1e4 : null })) }))
    .map(r => (lic.polymarket ? r : { ...r, maxEv: null, sides: r.sides.map(x => ({ ...x, fair: null, ev: null })) }))
    .map(r => { const evs = r.sides.map(x => x.ev).filter(e => e != null); return { ...r, maxEv: evs.length ? Math.max(...evs) : null }; });
  const base = { count: rows.length, updated: xarbState.updated, pro, region: TAIL_REGION };
  if (!pro) return res.json(base);
  res.json(regionSafe({ ...base, rows }));
});
// Gas locks (gaslocks.js): tonight's plays, the record and the backtest.
// Free: the count and the record; the plays are Pro, and need Kalshi's licence.
// Offshore reference (offshoreref.js): the pairs, the mismatch list, the
// backtest and the live record are free; the live gaps need Pro and the
// Polymarket and Kalshi display licences. No offshore links, ever.
app.get('/api/offshore-ref', async (req, res) => {
  try {
    const pro = hasPro(req), lic = licenceOf(req);
    const rows = await offshoreRef.list();
    const fams = {};
    for (const p of OFFSHORE_PAIRS.pairs) { const k = p.fam; fams[k] ||= { pairs: 0, kalshi: 0, pmus: 0 }; fams[k].pairs++; if (p.k) fams[k].kalshi++; if (p.u) fams[k].pmus++; }
    const base = { on: offshoreRefOn(), label: 'research, not an edge', pro, rule: offshoreref.DEFAULTS, pairs: { builtAt: OFFSHORE_PAIRS.builtAt, count: OFFSHORE_PAIRS.pairs.length, byFamily: fams, minOffshoreVolume: OFFSHORE_PAIRS.minOffshoreVolume },
      mismatches: require('../seeds/offshore-mismatch.json').reasons, backtest: require('../seeds/offshore-backtest.json'),
      record: offshoreref.summarize(rows), state: offshoreRef.state(), ...withheldBody(withheldOf(lic, ['polymarket', 'kalshi'])) };
    if (!pro || !lic.polymarket) return res.json(base);
    res.json({ ...base, gaps: offshoreRef.gaps(40).filter(g => g.venue !== 'kalshi' || lic.kalshi) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/gas-locks', async (req, res) => {
  try {
    const pro = hasPro(req), lic = licenceOf(req);
    const record = await gasTracker.summary();
    const recent = (await gasTracker.list()).filter(r => r.status === 'graded').sort((a, b) => (b.gradedAt || '').localeCompare(a.gradedAt || '')).slice(0, 50);
    const plays = lic.kalshi ? gasState.plays : [];
    const base = { count: plays.length, updated: gasState.updated, pro, record, backtest: gaslocks.BACKTEST,
      rule: { states: gaslocks.DEFAULTS.states, minPrice: gaslocks.DEFAULTS.minPrice, maxPrice: gaslocks.DEFAULTS.maxPrice, maxSpread: gaslocks.DEFAULTS.maxSpread, fromHours: gaslocks.DEFAULTS.fromHours, toHours: gaslocks.DEFAULTS.toHours, minDepthUsd: gaslocks.DEFAULTS.minDepthUsd },
      off: process.env.GAS_LOCKS === 'off', ...withheldBody(withheldOf(lic, ['kalshi'])) };
    if (!pro) return res.json({ ...base, recent });
    res.json({ ...base, plays, recent, counts: gasState.counts, errors: gasState.errors });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Live esports maps (esinplay.js): the record (free), the live board and the flags (Pro, Kalshi licence).
app.get('/api/esports/inplay', async (req, res) => {
  try {
    const pro = hasPro(req), lic = licenceOf(req);
    const rows = await inplayTracker.list();
    const summary = esinplay.summarize(rows);
    const recent = rows.filter(r => r.status === 'graded').sort((a, b) => (b.flaggedAt || '').localeCompare(a.flaggedAt || '')).slice(0, 40);
    const base = { updated: inplayLive.state.updated, pro, summary, rule: esinplay.DEFAULTS, models: Object.fromEntries(Object.entries(esinplay.MODELS).map(([g, m]) => [g, m ? m.kind : null])),
      fit: esinplay.INPLAY_FITS, counts: inplayLive.state.counts, off: process.env.ESPORTS_INPLAY === 'off', closed: cold.closedInfo('esportsInplay'),
      note: 'Our live win probability against Kalshi\'s in-play ask, fee included, with the size resting there. Records only: nothing alerts, nothing trades. Counted toward 50 graded: the first flag per map and team.',
      ...withheldBody(withheldOf(lic, ['kalshi'])) };
    if (!pro || !lic.kalshi) return res.json({ ...base, recent });
    const open = rows.filter(r => r.status === 'open').sort((a, b) => (b.flaggedAt || '').localeCompare(a.flaggedAt || '')).slice(0, 40);
    res.json({ ...base, recent, open, live: inplayLive.state.live, errors: inplayLive.state.errors });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// BIG MONEY (bigmoney.js): big exchange prints and the same bet at every
// venue. ?minUsd=2500 &mm=1 (market makers too) &kind=prop|game. Free: the count only.
app.get('/api/big-money', async (req, res) => {
  try {
    const pro = hasPro(req), lic = licenceOf(req), q = req.query;
    const record = await ctx.bigTracker.summary();
    const recent = (await ctx.bigTracker.list()).filter(r => r.status === 'graded').sort((a, b) => (b.gradedAt || '').localeCompare(a.gradedAt || '')).slice(0, 40)
      .map(({ why, prop, game, ...r }) => r);
    const minUsd = Number.isFinite(parseFloat(q.minUsd)) ? parseFloat(q.minUsd) : ctx.BIG_OPTS.minUsd;
    const shown = p => (p.money.exchanges || [p.money.exchange]).every(x => (x === 'kalshi' ? lic.kalshi : x === 'polymarket' ? lic.polymarket : true));
    let plays = ctx.bigState.plays.filter(p => shown(p) && p.money.usd >= minUsd - 1e-6 && (!q.kind || p.kind === q.kind));
    const hiddenMm = plays.filter(p => p.flow === 'market maker').length;
    if (!/^(1|true|on)$/i.test(String(q.mm || ''))) plays = plays.filter(p => p.flow !== 'market maker');
    plays = plays.map(({ money: { wallets, ...m }, ...p }) => ({ ...p, money: { ...m, wallets: wallets?.length || 0 } }));
    const base = { count: plays.length, flagged: plays.filter(p => p.flagged).length, hiddenMarketMakers: hiddenMm, updated: ctx.bigState.updated, pro, record,
      settings: { minUsd: ctx.BIG_OPTS.minUsd, minEv: ctx.BIG_OPTS.minEv, twoWayShare: ctx.BIG_OPTS.twoWayShare, flowWindowMs: ctx.BIG_OPTS.flowWindowMs },
      backtest: bigMoney.BACKTEST, off: process.env.BIG_MONEY === 'off', ...withheldBody(withheldOf(lic, ['kalshi', 'polymarket'])) };
    if (!pro) return res.json({ ...base, recent });
    res.json({ ...base, plays, recent, counts: ctx.bigState.counts, errors: ctx.bigState.errors });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// The big-money record's settled rows (locked, graded, void), every field but
// the internal ones, oldest first: what an independent re-check reads
// (checks/brmoney-recheck-2026-10-25). Open rows are today's board: Pro only.
app.get('/api/big-money/record', async (req, res) => {
  try {
    const pro = hasPro(req);
    const rows = (await ctx.bigTracker.list()).filter(r => pro || r.status !== 'open')
      .sort((a, b) => (a.flaggedAt || '').localeCompare(b.flaggedAt || '')).map(({ why, ...r }) => r);
    res.set('Cache-Control', 'no-store').json({ n: rows.length, rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Exchange value (xvalue.js): Kalshi and Polymarket US asks under Polymarket's
// live mid, best first, plus how the flagged prices did against the close.
// Free: the count and the edges' sizes only.
app.get('/api/exchange-value', async (req, res) => {
  try {
    const pro = hasPro(req), lic = licenceOf(req);
    const edges = xvalueState.edges.filter(valueOk(lic));
    const record = await xvalueTracker.summary({ sinceDays: parseFloat(req.query.days) || undefined });
    const moved = !lic.polymarket ? [] : (xvalueState.movers || []).map(m => ({ ...m, venues: m.venues.filter(v => v.venue !== 'kalshi' || lic.kalshi) }))
      .filter(m => m.venues.length).map(m => ({ ...m, best: m.venues[0] }));
    const base = { count: edges.length, steamCount: edges.filter(e => e.steam).length, moverCount: moved.length, updated: xvalueState.updated, pro, region: TAIL_REGION, venues: XVALUE_VENUES, record,
      ...withheldBody(withheldOf(lic, ['polymarket', 'kalshi'])) };
    if (!pro) return res.json({ ...base, edges: edges.map(e => ({ ev: e.ev, locked: true })) });
    res.json(regionSafe({ ...base, edges: edges.slice(0, Math.min(parseInt(req.query.limit) || 200, 500)), movers: moved, counts: xvalueState.counts,
      settings: { ...xvalue.DEFAULTS, ...XVALUE_OPTS, alertMin: XVALUE_ALERT_MIN, booksPerScan: XVALUE_BOOKS, steam: { ...steamWatch.opts, alertMin: STEAM_ALERT_MIN }, executable: { minDepthUsd: XVALUE_MIN_DEPTH, ...XVALUE_EXEC, lagMin: 2 } } }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Each tracked exchange value bet with its grades (at the alert, at the best
// price 2 min later, and at $100 through the book then), newest first. Open
// bets are live edges, so only closed ones are free.
app.get('/api/exchange-value/bets', async (req, res) => {
  try {
    const status = hasPro(req) ? req.query.status : 'closed';
    const limit = Math.min(parseInt(req.query.limit) || 100, 1000);
    const ok = valueOk(licenceOf(req));
    const bets = (await xvalueTracker.list({ status, limit: 1e9 })).filter(b => ok({ venue: b.book }))
      .sort((a, b) => Date.parse(b.flaggedAt) - Date.parse(a.flaggedAt)).slice(0, limit);
    res.json(regionSafe({ bets }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// The thresholds in force (defaults overridden by env), so the app can show
// them, plus the region and the data-licence gates.
app.get('/api/tail/settings', (req, res) => {
  const w = whaleWatcher.settings();
  res.json({
    tail: tailEngine.settings(),
    whales: { minUsd: w.minUsd, windowMs: w.windowMs },
    xarb: { minPct: XARB_OPTS.minPct ?? xarb.DEFAULTS.minPct, alertMinPct: XARB_ALERT_MIN,
      kalshiFeeRate: XARB_OPTS.kalshiFeeRate ?? xarb.DEFAULTS.kalshiFeeRate, polymarketFeeRate: XARB_OPTS.polymarketFeeRate ?? xarb.DEFAULTS.polymarketFeeRate,
      polymarketFees: 'per market: shares × rate × p(1 − p), sports 5%' },
    freeDelayMinutes: TAIL_FREE_DELAY_MS / 60e3,
    region: TAIL_REGION, licence: licenceState(req),
  });
});


return {
  boardVenues, kalshiVenuesOk
};
};
