// Book arbs and middles, props board, slip legs and the odds feed
// Moved out of server.js as it was (the route split): mount(ctx) runs where
// the section used to be, so routes keep their order. ctx carries what the
// section reads from server.js; it returns what server.js reads back.
'use strict';

module.exports = function mount(ctx) {
// ctx.bookPropsIndex, ctx.pinPropsIndex and ctx.propsBoardCache are replaced
// by their refresh jobs in server.js: read them when they are used
const {
  ANCHOR_INFO, APP_CARD_ON, APP_CARD_SPORTS, BIG_LEAGUE, BIG_OPTS, FREE_BOOKS_MAX_AGE_MS,
  INJURY_NEWS_ON, MLB_PIN_ON, ODDS_API_KEY, P6_KIND, PP_ES_STALE_MS, PP_SPORT_STALE_MS, SHARP_OPTS,
  SPORT_OPTS, app, appScore, appScoreResults, auth, axios, bigGames, bigMoney, bigState, bigTracker,
  bookLineQuotes, cache, cbbModel, cbbdata, cfbModel, cfbdata, cold, comboSourcesAt,
  createEvStoreFromEnv, dfsLegEv, esModelsState, esPicksOnce, esSlipLog, esSlipTracker, esportsCache,
  evScreen, execcheck, farlines, fetchOddsApiProps, fetchOddsForSport, fetchOwlsOdds, fetchOwlsProps,
  fetchOwlsSplits, freeBooksState, freebooks, fs, hasPro, ingestSharp, injuryNews, injuryState,
  isEsports, kpropsState, kxExtraState, lateSlipGrader, licenceOf, mergeProps, mlbBoard, mlbPinFor,
  nbaModel, nbadata, noteQuota, oddsBudget, oddsCost, path, pick6, pinPropsState,
  pinprops, polymarketUs, ppLinesNow, ppState, priceAgeNow, promoTracker, propCloseBook, propsBoard,
  propsBoardRebuild, propsBoardRows, requireAdmin, resultsBackup, rowKalshi,
  runSteps, runStepsAsync, sendErr, sharpQuotes, shopTracker, slipLate, slipLegTracker, slipLog,
  sliplogSideOf, slipstamp, sportFairAt, sportPinAt, sportProps, sportSharpAt, sportTracker,
  staleAppPlays, staleLines, staleState, tailEngine, upstream, whaleWatcher
} = ctx;

const bookArbs = require('../bookarbs');
const bookArbTracker = require('../bookarbtrack').createBookArbTracker({
  store: resultsBackup.wrap('bookArbs', createEvStoreFromEnv(process.env, { table: 'book_arbs', fileVar: 'BOOKARB_TRACK_FILE', file: 'book-arbs.json' })),
});
bookArbTracker.ready().catch(e => console.error('Book arbs: store failed to initialise:', e.message));
const bookArbState = { arbs: [], middles: [], counts: null, updated: null, dataAt: null, errors: [], reads: 0 };
const bookArbBooks = new Map();   // `${venue}:${marketId}` → { at, payload }
async function bookArbRead(leg, t, budget) {
  const k = `${leg.venue}:${leg.marketId}`;
  const c = bookArbBooks.get(k);
  if (c && t - c.at < 45e3) return c.payload;
  if (budget.left <= 0) return undefined;
  budget.left--;
  try {
    const payload = leg.venue === 'kalshi' ? (await upstream.get(execcheck.KALSHI_BOOK_URL(leg.marketId), { timeout: 10000 }))?.data
      : polymarketUs ? await polymarketUs.book(leg.marketId) : null;
    if (payload == null) return undefined;
    bookArbBooks.set(k, { at: t, payload });
    return payload;
  } catch { return undefined; }
}
function bookArbAsks(leg, payload) {
  if (leg.venue === 'kalshi') return execcheck.kalshiAsks(payload, leg.side);
  if (payload?.open === false || !(leg.yesSide === 'long' || leg.yesSide === 'short')) return [];
  return execcheck.pmusAsks(payload, leg.side === 'yes' ? leg.yesSide : leg.yesSide === 'long' ? 'short' : 'long');
}
async function scanBookArbs() {
  const dataAt = freeBooksState.gamesAt;
  if (!dataAt || Date.now() - Date.parse(dataAt) >= FREE_BOOKS_MAX_AGE_MS) return;
  const t = Date.now(), budget = { left: 30 };
  const collected = bookArbs.collect({ gamesBySport: freeBooksState.games, exchangeRows: bigGames().rows, kalshiRungs: kpropsState.rungs || null,
    leagueOf: s => freebooks.LEAGUES[s]?.props || s.toUpperCase(), now: t });
  const found = bookArbs.find(collected, { now: t });
  // the size behind each exchange leg, best rows first; a leg whose book no
  // longer holds the price at all takes its row off the list
  const rows = [...found.arbs, ...found.middles];
  for (const leg of bookArbs.legsToRead(rows, 20)) await bookArbRead(leg, t, budget);
  const gone = new Set();
  for (const r of rows) for (const l of r.legs) {
    if (!bookArbs.EXCHANGES.has(l.venue)) continue;
    const c = bookArbBooks.get(`${l.venue}:${l.marketId}`);
    if (!c || t - c.at > 60e3) continue;
    l.fill = bookArbs.fillable(r, l, bookArbAsks(l, c.payload));
    // under $10 of size isn't a bet anyone can place: off the list
    if (r.type === 'arb' ? !(l.fill.maxStake >= 10) : !(l.fill.atPrice >= 10)) gone.add(r.id);
  }
  for (const r of rows) {
    const fills = r.legs.filter(l => l.fill).map(l => l.fill);
    r.maxStake = r.type === 'arb' && fills.length ? Math.min(...fills.map(f => f.maxStake)) : null;
  }
  const keep = r => !gone.has(r.id);
  // two minutes on: re-read the due rows' exchange books, then check both legs
  const due = await bookArbTracker.due(dataAt);
  for (const r of due) for (const l of r.legs) if (bookArbs.EXCHANGES.has(l.venue)) await bookArbRead(l, t, budget);
  const fillAt = l => {
    const c = bookArbBooks.get(`${l.venue}:${l.marketId}`);
    if (!c || t - c.at > 60e3) return null;
    // contracts resting at or under the leg's shown all-in cost
    return Math.floor(bookArbAsks(l, c.payload).reduce((a, [p, n]) => a + (bookArbs.exchangeCost(l.venue, p) <= l.cost + 1e-4 ? n : 0), 0));
  };
  await bookArbTracker.check(bookArbs.quoteIndex(collected), fillAt, dataAt).catch(e => console.warn('Book arb tracker:', e.message));
  const arbs = found.arbs.filter(keep), middles = found.middles.filter(keep);
  await bookArbTracker.record([...arbs, ...middles], dataAt).catch(e => console.warn('Book arb tracker:', e.message));
  Object.assign(bookArbState, { arbs, middles, dataAt, updated: new Date(t).toISOString(), reads: 30 - budget.left,
    counts: { ...bookArbs.summarize({ arbs, middles, counts: found.counts }), stale: gone.size } });
}
const bigRungMid = rung => (rung && rung.yesBid > 0 && rung.yesAsk < 1 && rung.yesAsk > rung.yesBid ? (rung.yesBid + rung.yesAsk) / 2 : null);
const ladderKey = rung => `${rung.eventTicker}|${evScreen.canonName(rung.player)}|${rung.mkey}`;
// a stored print → the bet it backed
function bigResolve(p, games) {
  if (p.exchange === 'kalshi') {
    const rung = kpropsState.rungs?.get(p.market);
    if (rung) {
      const side = p.yes ? 'Over' : 'Under';
      return { kind: 'prop', betKey: `prop|${rung.league}|${evScreen.canonName(rung.player)}|${rung.mkey}|${rung.line}|${side}`, sport: rung.league, player: rung.player,
        mkey: rung.mkey, stat: rung.stat, line: rung.line, side, start: rung.start, ladder: ladderKey(rung), rung, title: `${rung.player} ${side} ${rung.line} ${rung.stat}`, backsRowYes: p.yes };
    }
  }
  const id = p.exchange === 'polymarket' ? p.conditionId || p.market : p.market;
  const g = games.rows.get(`${p.exchange}:${id}`);
  if (!g) return null;
  const rowYes = p.exchange === 'polymarket' ? (p.yes ? 0 : 1) === (g.row.yesIndex ?? 0) : p.yes;
  const key = rowYes ? g.yes : g.no;
  const b = key && games.bets.get(key);
  if (!b || !g.league || !BIG_LEAGUE[g.league]) return null;
  return { kind: 'game', betKey: key, sport: BIG_LEAGUE[g.league], title: b.label, matchup: `${g.game.away} @ ${g.game.home}`, side: key.split('|').pop(), start: g.game.start,
    game: { league: BIG_LEAGUE[g.league], home: g.game.home, away: g.game.away, start: g.game.start }, backsRowYes: rowYes, row: g.row };
}
// the props board row for a player and stat, nearest the start
function bigBoardRow(rows, sport, player, mkey, start) {
  const t = Date.parse(start || '');
  let best = null;
  for (const r of rows.get(`${sport}|${evScreen.canonName(player)}|${mkey}`) || []) {
    const d = Math.abs(Date.parse(r.startTime || '') - t);
    if (Number.isFinite(d) && d <= 6 * 3600e3 && (!best || d < best.d)) best = { r, d };
  }
  return best?.r || null;
}
let bigBookProps = { at: null, idx: new Map() };
function bigBookPropsFor(key, start) {
  if (bigBookProps.at !== freeBooksState.gamesAt) bigBookProps = { at: freeBooksState.gamesAt, idx: bigMoney.bookPropIndex(freeBooksState.games, s => freebooks.LEAGUES[s]?.props || null) };
  if (Date.now() - Date.parse(freeBooksState.gamesAt || 0) >= FREE_BOOKS_MAX_AGE_MS) return [];
  const t = Date.parse(start || '');
  return (bigBookProps.idx.get(key) || []).filter(q => Math.abs(Date.parse(q.start) - t) <= 3 * 3600e3);
}
// a side's chance at a line from a P(over) quoted at another line
const sideAt = (mkey, sport, fromLine, pOverAt, line, side) => { const p = bigMoney.atLine(mkey, sport, fromLine, pOverAt, line); return p == null ? null : side === 'Over' ? p : 1 - p; };
// one grouped play → priced, with venues, best, Pinnacle and the flow label
function bigPrice(play, ctx) {
  const { games, boardRows, byMarket, byLadder } = ctx;
  const fair = play.money.price;
  let venues = [], pin = null, now = null, sharp = null, url = null;
  if (play.kind === 'prop') {
    const row = bigBoardRow(boardRows, play.sport, play.player, play.mkey, play.start);
    const key = `${play.sport}|${evScreen.canonName(play.player)}|${play.mkey}`;
    venues = bigMoney.propVenues({ sport: play.sport, mkey: play.mkey, line: play.line, side: play.side, fair }, { board: row, books: bigBookPropsFor(key, play.start), dfsEv: dfsLegEv, o: BIG_OPTS });
    const rung = play.rung, mid = bigRungMid(rung);
    if (mid != null) now = play.side === 'Over' ? mid : 1 - mid;
    // Kalshi's own ask for the side now (the money's market)
    const ask = play.side === 'Over' ? rung.yesAsk : rung.yesBid > 0 ? 1 - rung.yesBid : null;
    const cost = ask > 0 && ask < 1 ? bigMoney.exchangeCost({ exchange: 'kalshi' }, ask) : null;
    if (cost) venues.push({ venue: 'kalshi', name: 'Kalshi', line: play.line, sameLine: true, fair, implied: cost, decimal: +(1 / cost).toFixed(4), price: ask, american: bigMoney.american(cost), ev: +((fair / cost - 1) * 100).toFixed(2), own: true });
    const pq = row || { key, startTime: play.start };
    const pinQ = pinprops.quoteFor(ctx.pinPropsIndex, { ...pq, key });
    if (pinQ) pin = sideAt(play.mkey, play.sport, pinQ.line, pinQ.pOver, play.line, play.side);
    for (const v of venues) {
      const pv = pinQ ? sideAt(play.mkey, play.sport, pinQ.line, pinQ.pOver, v.line, play.side) : null;
      if (pv != null) { v.pin = +pv.toFixed(4); v.evPin = +((pv * v.decimal - 1) * 100).toFixed(2); }
    }
    if (row) {
      const c = sportProps.consensusFor(row, play.line, { sharp: sharpQuotes(row), kalshi: rowKalshi(row), o: SHARP_OPTS });
      if (c) sharp = play.side === 'Over' ? c.p : 1 - c.p;
    }
    url = rung.url;
    play.prop = { sport: play.sport, player: play.player, mkey: play.mkey, startTime: play.start, team: row?.team || '', matchTitle: row?.matchTitle || '' };
  } else {
    const b = games.bets.get(play.betKey);
    pin = b?.pin ?? null;
    sharp = pin;
    for (const v of b?.venues || []) {
      const own = v.venue === play.money.exchange && String(v.marketId) === String(play.money.market);
      venues.push({ ...v, line: null, sameLine: true, fair, ev: +((fair * v.decimal - 1) * 100).toFixed(2), ...(own ? { own: true } : {}),
        ...(pin != null ? { pin, evPin: +((pin * v.decimal - 1) * 100).toFixed(2) } : {}) });
    }
    const m = play.row ? (play.row.yesAsk > 0 && play.row.noAsk > 0 ? (play.row.yesAsk + 1 - play.row.noAsk) / 2 : null) : null;
    if (m != null) now = play.backsRowYes ? m : 1 - m;
    url = play.money.exchange === 'kalshi' ? play.row?.url || null : null;   // never a polymarket.com link
  }
  venues.sort((a, b) => b.ev - a.ev);
  const best = bigMoney.pickBest(venues, BIG_OPTS);
  const flow = bigMoney.flowOf({ ...play.money }, { market: byMarket.get(`${play.money.exchange}|${play.money.market}`) || [], ladder: play.ladder ? byLadder.get(play.ladder) || [] : [],
    side: play.kind === 'prop' ? play.side : null, isMaker: w => !!tailEngine.trader(w)?.marketMaker, o: BIG_OPTS });
  const { rung, row, ...rest } = play;
  return { ...rest, id: play.betKey, url, venues, best, pinFair: pin == null ? null : +pin.toFixed(4), sharpFair: sharp == null ? null : +sharp.toFixed(4), now: now == null ? null : +now.toFixed(4),
    flow: flow.flow, why: flow.why, minEv: BIG_OPTS.minEv, flagged: !!(best && best.ev >= BIG_OPTS.minEv) };
}
async function scanBigMoney() {
  if (process.env.BIG_MONEY === 'off') return;
  const t = Date.now();
  for (const p of whaleWatcher.prints({ since: t - BIG_OPTS.keepMs, minUsd: BIG_OPTS.floorUsd })) {
    const n = bigMoney.normPrint(p);
    if (n) bigState.store.set(n.key, n);
  }
  for (const [k, p] of bigState.store) if (p.at < t - BIG_OPTS.keepMs) bigState.store.delete(k);
  const store = [...bigState.store.values()].sort((a, b) => a.at - b.at);
  const games = bigGames();
  // prints by market, and Kalshi props by player ladder (the flow label reads these)
  const byMarket = new Map(), byLadder = new Map();
  for (const p of store) {
    const k = `${p.exchange}|${p.market}`;
    if (!byMarket.has(k)) byMarket.set(k, []);
    byMarket.get(k).push(p);
    const rung = p.exchange === 'kalshi' ? kpropsState.rungs?.get(p.market) : null;
    if (rung) { const l = ladderKey(rung); if (!byLadder.has(l)) byLadder.set(l, []); byLadder.get(l).push(p); }
  }
  const boardRows = new Map();
  for (const r of propsBoardRows().rows || []) {
    if (r.esports) continue;
    const k = r.key.replace(/\|\d{4}-\d{2}-\d{2}$/, '');
    if (!boardRows.has(k)) boardRows.set(k, []);
    boardRows.get(k).push(r);
  }
  const grouped = bigMoney.groupMoney(store, p => bigResolve(p, games), { now: t, o: BIG_OPTS });
  const plays = [];
  for (const g of grouped.slice(0, BIG_OPTS.maxPlays)) {
    try { plays.push(bigPrice(g, { games, boardRows, byMarket, byLadder })); } catch (e) { bigState.errors = [e.message, ...bigState.errors].slice(0, 5); }
  }
  bigState.plays = plays;
  bigState.updated = new Date(t).toISOString();
  bigState.counts = { prints: store.length, big: store.filter(p => p.usd >= BIG_OPTS.minUsd && !p.block).length, plays: plays.length, flagged: plays.filter(p => p.flagged).length,
    marketMaker: plays.filter(p => p.flow === 'market maker').length, props: plays.filter(p => p.kind === 'prop').length, games: plays.filter(p => p.kind === 'game').length,
    rungs: kpropsState.rungs?.size || 0, gameRows: games.rows.size, bets: games.bets.size };
  await bigTracker.record(plays.filter(p => p.flagged));
  await bigTracker.mark(r => bigMarkLookup(r, { games, boardRows }));
  if (t - (bigState.gradedAt || 0) > 10 * 60e3) { bigState.gradedAt = t; await bigTracker.grade(); }
}
// a logged row → the venue's price now, the money's market and the sharp fair at our line
function bigMarkLookup(r, { games, boardRows }) {
  if (r.kind === 'prop') {
    const rung = kpropsState.rungs?.get(r.moneyMarket);
    const row = bigBoardRow(boardRows, r.sport, r.prop?.player, r.prop?.mkey, r.start);
    const mid = bigRungMid(rung);
    const close = mid == null ? null : sideAt(r.prop.mkey, r.sport, r.moneyLine, mid, r.line, r.side);
    let sharp = null, venue = null;
    if (row) {
      const c = sportProps.consensusFor(row, r.line, { sharp: sharpQuotes(row), kalshi: rowKalshi(row), o: SHARP_OPTS });
      if (c) sharp = r.side === 'Over' ? c.p : 1 - c.p;
      const cell = row.books[r.venue];
      if (cell && (r.side === 'Over' ? cell.overOpen : cell.underOpen)) { const pr = bigMoney.appPrice(r.venue, cell, r.side, r.fair, dfsLegEv); if (pr) venue = { line: cell.line, decimal: pr.decimal }; }
    }
    if (!venue && (r.venue === 'fanduel' || r.venue === 'betrivers')) {
      const q = bigBookPropsFor(`${r.sport}|${evScreen.canonName(r.prop.player)}|${r.prop.mkey}`, r.start).find(x => x.book === r.venue && x.line === r.line);
      const a = q && (r.side === 'Over' ? q.over : q.under);
      if (a) venue = { line: q.line, decimal: a > 0 ? 1 + a / 100 : 1 + 100 / -a };
    }
    return { venue, close, sharp };
  }
  const b = games.bets.get(r.betKey);
  const v = b?.venues.find(x => x.venue === r.venue);
  const g = r.moneyExchange === 'polymarket' ? games.rows.get(`polymarket:${r.moneyMarket}`) : games.rows.get(`${r.moneyExchange}:${r.moneyMarket}`);
  const row = g?.row;
  const m = row && row.yesAsk > 0 && row.noAsk > 0 ? (row.yesAsk + 1 - row.noAsk) / 2 : null;
  const yesKey = g?.yes;
  return { venue: v ? { line: null, decimal: v.decimal } : null, close: m == null ? null : yesKey === r.betKey ? m : 1 - m, sharp: b?.pin ?? null };
}

// Every two minutes after the scrapes: flag, check two minutes on, keep the close
let sportTrackRunning = false;
async function trackSportProps() {
  if (sportTrackRunning) return;
  sportTrackRunning = true;
  try {
    const { rows, sportPlays } = await propsBoardRebuild({ fresh: true });
    // when each app's lines were last read (a PrizePicks pull that failed read nothing)
    const updated = { prizepicks: ppState.fullOkAt ? new Date(ppState.fullOkAt).toISOString() : null, underdog: cache.underdog.updated, sleeper: cache.sleeperSports.updated, ...pick6.readTimes() };
    // a Pick6 leg goes in under a kind of its own, so its record stands apart
    const flagged = [...sportPlays.filter(x => x.research || x.kind === 'sharp' || x.kind === 'sharp3' || x.kind === 'combo' || x.play.ev >= SPORT_OPTS.minEv), ...staleAppPlays(rows)]
      .map(x => (x.play.book === 'pick6' && !x.research ? { ...x, kind: P6_KIND(x.kind) } : x));   // research rows stay research
    // the CFB model's confident PrizePicks and Pick6 legs, and Underdog's +5% at its real multiplier: records of their own (kinds cfb-model, p6-cfb-model, ud-cfb-model)
    if (cfbModel) { try { flagged.push(...cfbModel.plays(rows, { pinAt: cfbPinAt })); } catch (e) { console.warn('CFB model plays:', e.message); } }
    // the NBA model's confident PrizePicks and Pick6 legs: a record of their own (kinds nba-model, p6-nba-model)
    if (nbaModel) { try { flagged.push(...nbaModel.plays(rows, { pinAt: nbaPinAt })); } catch (e) { console.warn('NBA model plays:', e.message); } }
    // the CBB model's: kinds cbb-model, p6-cbb-model, ud-cbb-model (no far-line kinds for college)
    if (cbbModel) { try { flagged.push(...cbbModel.plays(rows)); } catch (e) { console.warn('CBB model plays:', e.message); } }
    // every MLB leg Pinnacle prices, gap and even, each app its own kind (mlbboard.js)
    if (MLB_PIN_ON) { try { flagged.push(...mlbBoard.plays(rows, { pinFor: mlbPinFor })); } catch (e) { console.warn('MLB board plays:', e.message); } }
    // NBA teammates' legs left on the pre-news number after a player is ruled out (injurynews.js)
    try { flagged.push(...injuryPlays(rows)); } catch (e) { injuryState.errors = [`legs ${e.message}`, ...injuryState.errors].slice(0, 5); }

    await sportTracker.record({ rows: rows.filter(r => !r.esports), flagged, fairAt: sportFairAt, sharpAt: sportSharpAt, pinAt: sportPinAt, sourcesAt: comboSourcesAt, updated });
    // the slip log's legs keep their close on the same reads, on the sharp consensus
    await slipLegTracker.record({ rows: rows.filter(r => !r.esports), flagged: [], fairAt: slipFairAt, updated });
    // every prop's last Pinnacle and Kalshi number, frozen at the start (propclose.js)
    await propCloseBook.observe(rows, row => ({ pin: sharpQuotes(row).filter(q => q.book === 'pinnacle'), kal: rowKalshi(row) })).catch(e => console.warn('Prop close book:', e.message));
    // the app scorecard: settle the closed props from the box scores (one result per prop, budgeted)
    if (APP_CARD_ON) await appScoreResults.run(propCloseBook.entries({ sports: APP_CARD_SPORTS, sinceMs: Date.now() - 4 * 86400e3 }), { budget: 150 }).catch(e => console.warn('App scorecard:', e.message));
    // the softest number across the apps (appshop.js): kinds shop-any, shop-pp,
    // shop-p6 and shop-mid in a record of their own (own store, own grading
    // budget), never plays or alerts
    if (APP_SHOP_RECORD) {
      const byKey = new Map(rows.map(r => [r.key, r]));
      const shopFlags = [];
      for (const x of appShop.recordLegs(shopBoard())) { const row = byKey.get(x.rowKey); if (row) shopFlags.push({ row, play: x.play, kind: x.kind, research: true }); }
      await shopTracker.record({ rows: rows.filter(r => !r.esports), flagged: shopFlags, fairAt: sportFairAt, updated });
    }
    // the apps' promo legs (promos.js): kinds promo-<app>-<type>, own store, never plays or alerts
    if (PROMO_RECORD) {
      const byKey = new Map(rows.map(r => [r.key, r]));
      const flags = promos.recordLegs(await runStepsAsync(promoBoardSteps()), { boardRow: k => byKey.get(k) });
      for (const f of flags) promoRowsSeen.set(f.row.key, f.row);
      // a promo the app took down keeps its row (no app cell: not executable)
      // so its close still reads the sharp price to the start
      const live = new Set(flags.map(f => f.row.key));
      const t = Date.now();
      for (const [k, r] of promoRowsSeen) {
        if (Date.parse(r.startTime) < t - 6 * 3600e3) { promoRowsSeen.delete(k); continue; }
        if (!live.has(k) && Object.keys(r.books).length) promoRowsSeen.set(k, { ...r, books: {} });
      }
      const promoUpdated = { prizepicks: updated.prizepicks, underdog: cache.udPromos.updated, sleeper: cache.slPromos.updated, ...pick6.readTimes() };
      await promoTracker.record({ rows: [...promoRowsSeen.values()], flagged: flags.map(f => ({ ...f, research: true })), fairAt: promoFairAt, updated: promoUpdated });
    }
  } catch (e) { console.warn('Sports props record:', e.message); }
  finally { sportTrackRunning = false; }
}
// The NBA MODEL section: every NBA row the model prices, each app's line with
// the model's P(over), Pinnacle's no-vig P(over) at its own line where it
// hangs the prop, the model's own record and its backtest (seeds/nba-model-backtest.json)
// FAR FROM PROJECTION (farlines.js): an app line 1+ of the model's own sds from
// its projection, its own record per app and the held-out backtest
// (seeds/far-lines-backtest.json, checks/far-lines-2026-10-25)
let farBacktest;
function farSummary(sport, kinds, count) {
  if (farBacktest === undefined) { try { farBacktest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'seeds', 'far-lines-backtest.json'), 'utf8')); } catch { farBacktest = null; } }
  const k = farlines.KINDS[sport];
  return { label: 'model, not an edge', minD: farlines.FAR_D, note: farlines.NOTE, bar: farlines.BAR, count,
    record: { prizepicks: kinds[k.prizepicks] || null, pick6: kinds[k.pick6] || null, underdog: kinds[k.underdog] || null },
    backtest: farBacktest?.[sport] || null };
}
// Pinnacle's prop for a row: the line nearest the apps' own
function nbaPinAt(row) {
  const qs = pinprops.quotesForGame(ctx.pinPropsIndex, row) || [];
  if (!qs.length) return null;
  const lines = Object.values(row.books || {}).map(c => c.line).filter(Number.isFinite);
  const ref = lines.length ? lines.sort((a, b) => a - b)[Math.floor(lines.length / 2)] : null;
  const q = ref == null ? qs[0] : qs.slice().sort((a, b) => Math.abs(a.line - ref) - Math.abs(b.line - ref))[0];
  return q && Number.isFinite(q.pOver) ? { line: q.line, pOver: q.pOver } : null;
}
// one section per board build (and per Pinnacle read and model refresh), every request reads it
let nbaSectionCache = { rows: null, pin: null, version: null, list: [] };
function nbaSection() {
  const { rows } = propsBoardRows();
  const st = nbaModel.state, version = `${st.refreshedAt}|${st.injuriesAt}|${st.added}`;
  const c = nbaSectionCache;
  if (c.rows === rows && c.pin === ctx.pinPropsIndex && c.version === version) return c.list;
  nbaSectionCache = { rows, pin: ctx.pinPropsIndex, version, list: nbaModel.section(rows, { pinAt: nbaPinAt }) };
  return nbaSectionCache.list;
}
app.get('/api/props/nbamodel', async (req, res) => {
  if (!nbaModel) return res.json({ on: false, note: 'The NBA model is switched off on this server (NBA_MODEL=off).', rows: [] });
  let list = nbaSection();
  const q = String(req.query.q || '').toLowerCase().trim();
  if (q) list = list.filter(r => `${r.player} ${r.team} ${r.opp} ${r.market}`.toLowerCase().includes(q));
  if (req.query.stat) list = list.filter(r => r.mkey === String(req.query.stat));
  const farCount = list.filter(r => r.far).length;
  if (req.query.far === '1') list = list.filter(r => r.far).sort((a, b) => Math.abs(b.farD) - Math.abs(a.farD));
  const sum = await sportTracker.summary();
  const kinds = sum.byKind || {}, byVer = sum.byModelVersion || {};
  res.json({ on: true, label: 'model, not an edge', status: nbaModel.status(), far: farSummary('NBA', kinds, farCount), pickMin: nbadata.PICK_MIN, udEvMin: nbadata.UD_EV_MIN,
    version: nbadata.MODEL_VERSION, versionAt: nbadata.VERSION_AT, versionNote: nbadata.VERSION_NOTE,
    bar: 'Not a bet until its own record has 50+ graded live legs on one app with the hit rate 2+ standard errors above the break-even (PrizePicks 55.03%, Pick6 56.7%; Underdog judged on profit at its real multipliers), and an independent re-check of the results.',
    record: { prizepicks: kinds['nba-model'] || null, pick6: kinds['p6-nba-model'] || null, underdog: kinds['ud-nba-model'] || null },
    recordByVersion: { prizepicks: byVer[`nba-model@${nbadata.MODEL_VERSION}`] || null, pick6: byVer[`p6-nba-model@${nbadata.MODEL_VERSION}`] || null, underdog: byVer[`ud-nba-model@${nbadata.MODEL_VERSION}`] || null },
    backtest: nbaModel.state.backtest, count: list.length, rows: list.slice(0, Math.min(parseInt(req.query.limit) || 300, 1000)) });
});
// ── CBB MODEL: the same view for college basketball (cbbdata.js), Pinnacle at
// its own line where it hangs the prop
let cbbSectionCache = { rows: null, pin: null, version: null, list: [] };
function cbbSection() {
  const { rows } = propsBoardRows();
  const st = cbbModel.state, version = `${st.refreshedAt}|${st.added}`;
  const c = cbbSectionCache;
  if (c.rows === rows && c.pin === ctx.pinPropsIndex && c.version === version) return c.list;
  cbbSectionCache = { rows, pin: ctx.pinPropsIndex, version, list: cbbModel.section(rows, { pinAt: nbaPinAt }) };
  return cbbSectionCache.list;
}
app.get('/api/props/cbbmodel', async (req, res) => {
  if (!cbbModel) return res.json({ on: false, note: 'The CBB model is switched off on this server (CBB_MODEL=off).', rows: [] });
  try {
    let list = cbbSection();
    const q = String(req.query.q || '').toLowerCase().trim();
    if (q) list = list.filter(r => `${r.player} ${r.team} ${r.opp} ${r.market}`.toLowerCase().includes(q));
    if (req.query.stat) list = list.filter(r => r.mkey === String(req.query.stat));
    const sum = await sportTracker.summary();
    const kinds = sum.byKind || {}, byVer = sum.byModelVersion || {};
    const V = cbbdata.MODEL_VERSION, K = cbbdata.KINDS;
    res.json({ on: true, sport: 'CBB', label: 'model, not an edge', status: cbbModel.status(), pickMin: cbbdata.PICK_MIN, udEvMin: cbbdata.UD_EV_MIN,
      version: V, versionAt: cbbdata.VERSION_AT, versionNote: cbbdata.VERSION_NOTE,
      bar: 'Not a bet until its own record has 50+ graded live legs on one app with the hit rate 2+ standard errors above the break-even (PrizePicks 55.03%, Pick6 56.7%; Underdog judged on profit at its real multipliers), and an independent re-check of the results.',
      record: { prizepicks: kinds[K.prizepicks] || null, pick6: kinds[K.pick6] || null, underdog: kinds[K.underdog] || null },
      recordByVersion: { prizepicks: byVer[`${K.prizepicks}@${V}`] || null, pick6: byVer[`${K.pick6}@${V}`] || null, underdog: byVer[`${K.underdog}@${V}`] || null },
      backtest: cbbModel.state.backtest, count: list.length, rows: list.slice(0, Math.min(parseInt(req.query.limit) || 300, 1000)) });
  } catch (e) { sendErr(res, e); }
});
app.get('/api/props/board', (req, res) => {
  const { rows, counts } = propsBoardRows();
  const pro = hasPro(req);
  // Kalshi's prices back the sports fair; without its licence those stay hidden
  const kalshiOk = licenceOf(req).kalshi;
  const book = propsBoard.BOOKS.includes(req.query.book) ? req.query.book : '';
  const sort = pro ? String(req.query.sort || 'ev') : (req.query.sort === 'ev' || !req.query.sort ? 'books' : String(req.query.sort));
  const qo = { sport: req.query.sport, book, q: req.query.q, sort, multi: req.query.multi === '1', priced: pro && req.query.priced === '1', gaps: req.query.gaps === '1', sharp: req.query.sharp === '1', sharp3: req.query.sharp3 === '1', combo: req.query.combo === '1',
    anchor: ['none', 'sharp'].includes(req.query.anchor) ? req.query.anchor : '' };
  const market = String(req.query.market || '').slice(0, 80);
  const hits = propsBoard.queryRows(rows, { ...qo, market });
  // the Lines view: one app's lines, with the header count and the prop filter
  let lines = null;
  if (book && req.query.facets === '1') {
    const f = propsBoard.lineFacets(market ? propsBoard.queryRows(rows, qo) : hits, book, SHARP_OPTS.minEv);
    lines = { markets: f.markets, bettable: pro ? propsBoard.lineFacets(hits, book, SHARP_OPTS.minEv).bettable : null, minEv: SHARP_OPTS.minEv };
  }
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit) || 150));
  const offset = Math.max(0, parseInt(req.query.offset) || 0);
  let page = hits.slice(offset, offset + limit);
  if (!pro) page = page.map(propsBoard.redactRow);
  else if (!kalshiOk) page = page.map(r => (r.esports ? r : propsBoard.redactRow(r)));
  res.json({
    rows: page, total: hits.length, offset, limit, pro, counts, ...(lines ? { lines } : {}),
    // the esports models' verdicts (esmodels.js): a failed one's legs are not plays
    esModels: esModelsState.cards ? Object.fromEntries(esModelsState.cards.map(c => [c.key, { verdict: c.verdict, graded: c.graded, wins: c.wins, losses: c.losses, hitPct: c.hitPct, breakEvenPct: c.breakEvenPct, units: c.units }])) : null,
    coverage: ctx.propsBoardCache.coverage ? { leagues: ctx.propsBoardCache.coverage.leagues, byApp: ctx.propsBoardCache.coverage.byApp } : null,
    anchor: { ...ANCHOR_INFO, now: ctx.propsBoardCache.anchor || null },
    updated: { underdog: cache.underdog.updated, prizepicks: cache.prizepicks.updated, sleeper: cache.sleeper.updated, kalshi: kpropsState.updated, esports: esportsCache.lastUpdated },
  });
});

// ── CFB MODEL: every CFB row the model prices, each app's line with the
// model's P(over), Pinnacle's and FanDuel/BetRivers' no-vig P(over) at their
// own lines where they hang the prop, the model's record and its backtest
// (seeds/cfb-model-backtest.json). Same shape as the NBA model's view.
function nearestQuote(row, qs) {
  if (!qs.length) return null;
  const lines = Object.values(row.books || {}).map(c => c.line).filter(Number.isFinite).sort((a, b) => a - b);
  const ref = lines.length ? lines[Math.floor(lines.length / 2)] : null;
  return ref == null ? qs[0] : qs.slice().sort((a, b) => Math.abs(a.line - ref) - Math.abs(b.line - ref))[0];
}
function cfbPinAt(row) {
  const q = nearestQuote(row, (pinprops.quotesForGame(ctx.pinPropsIndex, row) || []).filter(x => Number.isFinite(x.pOver)));
  return q ? { line: q.line, pOver: q.pOver } : null;
}
function cfbBookAt(row) {
  const q = nearestQuote(row, bookLineQuotes(row).filter(x => Number.isFinite(x.line) && Number.isFinite(x.pOver)));
  return q ? { book: q.book, line: q.line, pOver: q.pOver } : null;
}
app.get('/api/props/cfbmodel', async (req, res) => {
  if (!cfbModel) return res.json({ on: false, note: 'The CFB model is switched off on this server (CFB_MODEL=off).', rows: [] });
  try {
    const { rows } = propsBoardRows();
    let list = cfbModel.section(rows, { pinAt: cfbPinAt, bookAt: cfbBookAt });
    const q = String(req.query.q || '').toLowerCase().trim();
    if (q) list = list.filter(r => `${r.player} ${r.team} ${r.opp} ${r.market}`.toLowerCase().includes(q));
    if (req.query.stat) list = list.filter(r => r.mkey === String(req.query.stat));
    const farCount = list.filter(r => r.far).length;
    if (req.query.far === '1') list = list.filter(r => r.far).sort((a, b) => Math.abs(b.farD) - Math.abs(a.farD));
    const sum = await sportTracker.summary();
    const kinds = sum.byKind || {}, byVer = sum.byModelVersion || {};
    const V = cfbdata.MODEL_VERSION;
    res.json({ on: true, sport: 'CFB', label: 'model, not an edge', status: cfbModel.status(), far: farSummary('CFB', kinds, farCount), pickMin: cfbdata.PICK_MIN, udEvMin: cfbdata.UD_EV_MIN,
      version: V, versionAt: cfbdata.VERSION_AT, versionNote: cfbdata.VERSION_NOTE,
      bar: 'Not a bet until its own record has 50+ graded live legs on one app with the hit rate 2+ standard errors above the break-even (PrizePicks 55.03%, Pick6 56.7%; Underdog judged on profit at its real multipliers), and an independent re-check of the results.',
      record: { prizepicks: kinds['cfb-model'] || null, pick6: kinds['p6-cfb-model'] || null, underdog: kinds['ud-cfb-model'] || null },
      recordByVersion: { prizepicks: byVer[`cfb-model@${V}`] || null, pick6: byVer[`p6-cfb-model@${V}`] || null, underdog: byVer[`ud-cfb-model@${V}`] || null },
      backtest: cfbModel.state.backtest, count: list.length, rows: list.slice(0, Math.min(parseInt(req.query.limit) || 300, 1000)) });
  } catch (e) { sendErr(res, e); }
});

// ── MLB vs PINNACLE (mlbboard.js): every MLB app leg next to Pinnacle's own number ──
// Each MLB player stat Pinnacle prices: Pinnacle's line, its prices and no-vig
// P(over), FanDuel's and BetRivers' where they post it, and every app's
// number as a gap leg (on the good side of Pinnacle's) or an even leg (the
// same number). Same-game stacks priced leg by leg. Research: its own record
// kinds, no alerts. The prices are Pro, like the board's fair.
const mlbBacktest = (() => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'seeds', 'mlb-backtest.json'), 'utf8')); } catch { return null; } })();
const SLIPS = require('../slips');
const mlbBooksFor = row => (Date.now() - Date.parse(freeBooksState.gamesAt || 0) < FREE_BOOKS_MAX_AGE_MS ? sportProps.quotesFor(ctx.bookPropsIndex, row) : []);
const mlbPriceOf = (row, line) => mlbBoard.priceFrom(mlbPinFor(row), row.mkey, line) || mlbBoard.priceFrom(mlbBooksFor(row), row.mkey, line);
app.get('/api/props/mlb', async (req, res) => {
  try {
    const pro = hasPro(req);
    const { rows } = propsBoardRows();
    const mlbRows = rows.filter(r => r.sport === 'MLB' && !r.esports);
    let list = mlbBoard.board(mlbRows, { pinFor: mlbPinFor, booksFor: mlbBooksFor });
    const q = String(req.query.q || '').toLowerCase().trim().slice(0, 60);
    if (q) list = list.filter(b => `${b.row.player} ${b.row.team} ${b.row.market} ${b.row.matchTitle}`.toLowerCase().includes(q));
    if (req.query.stat) list = list.filter(b => b.row.mkey === String(req.query.stat));
    if (req.query.gaps === '1') list = list.filter(b => b.legs.some(l => l.rel === 'gap'));
    list.sort((a, b) => Date.parse(a.row.startTime) - Date.parse(b.row.startTime) || (b.legs.some(l => l.rel === 'gap') - a.legs.some(l => l.rel === 'gap')) || a.row.player.localeCompare(b.row.player));
    const hide = o => (pro ? o : { ...o, pOver: null, fair: null, ev: null, pinOver: null, over: undefined, under: undefined, ...(o.rel === 'even' ? { side: null } : {}) });
    const out = list.map(({ row, pin, books, legs }) => ({ key: row.key, sport: 'MLB', player: row.player, team: row.team || '', opponent: row.opponent || '', market: row.market, mkey: row.mkey,
      startTime: row.startTime, matchTitle: row.matchTitle || '', books: row.books,
      pinnacle: hide({ line: pin.line, pOver: r4n(pin.pOver), over: pin.over ?? null, under: pin.under ?? null }),
      others: books.map(b => hide({ book: b.book, line: b.line, pOver: r4n(b.pOver) })),
      legs: Object.fromEntries(legs.map(l => [l.app, hide(l)])) }));
    const st = mlbBoard.stacks(mlbRows, { priceOf: mlbPriceOf, slips: SLIPS });
    const kinds = (await sportTracker.summary()).byKind || {};
    const rec = Object.fromEntries([...mlbBoard.KINDS].map(k => [k, kinds[k] || null]));
    const legsAll = list.flatMap(b => b.legs);
    res.json({ on: MLB_PIN_ON, pro, label: 'research, not a bet',
      bar: 'Not a bet until one app\'s gap legs have 50+ graded live with the hit rate 2+ standard errors above its break-even (PrizePicks 55.03%, Pick6 56.7%, Underdog 56.23%, Sleeper its own payout) and an independent re-check of the results.',
      counts: { rows: out.length, legs: legsAll.length, gap: legsAll.filter(l => l.rel === 'gap').length, even: legsAll.filter(l => l.rel === 'even').length,
        byApp: Object.fromEntries(mlbBoard.APPS.map(a => [a, legsAll.filter(l => l.app === a).length])), mlbRows: mlbRows.length, sports: {}, books: {} },
      record: rec, backtest: mlbBacktest,
      stacks: pro ? st.slice(0, 20) : st.slice(0, 20).map(x => ({ app: x.app, game: x.game, players: x.players, linked: x.linked, standard: x.standard, repriced: x.repriced })),
      stacksClearing: st.filter(x => x.clears).length,
      rows: out.slice(0, Math.min(parseInt(req.query.limit) || 300, 1000)), total: out.length });
  } catch (e) { sendErr(res, e); }
});
const r4n = x => (Number.isFinite(x) ? Math.round(x * 1e4) / 1e4 : null);

// ── INJURY NEWS (injurynews.js): teammates' app lines left on the pre-news number ──
// ESPN's NBA injury list every 3 minutes: a rotation player newly Out (or
// Doubtful) is news. For each of his teammates' props, Pinnacle's number before
// the news (the stale engine's history, 15 minutes before it) against its
// number now, and each app's number before against now: an app still on its
// old number while Pinnacle's chance there moved 2+ points is a leg. Research:
// its own record kinds per app, no alerts. The prices are Pro, like the board's fair.
const injuryBacktest = (() => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'seeds', 'injury-stale-backtest.json'), 'utf8')); } catch { return null; } })();
const injKey = row => staleLines.propKey(row.sport, row.player, row.mkey, row.startTime);
const injCell = c => (c && Number.isFinite(c.line) ? { line: c.line, over: c.over ?? null, under: c.under ?? null, overOpen: c.overOpen !== false, underOpen: c.underOpen !== false } : null);
// what legsFor reads: teams and minutes from the NBA model's box scores,
// Pinnacle's and the apps' numbers before the news from the stale engine and
// now from the engine (Pinnacle, fresh reads only) and the board (the apps)
function injuryContext(t = Date.now()) {
  if (!INJURY_NEWS_ON || !staleState.enabled || !nbaModel) return null;
  const H = nbaModel.history();
  return {
    t,
    teamOf: (key, at) => injuryNews.rotationOf(H.players, key, at),
    pinAt: (row, at) => {
      if (at < t) return staleState.engine.quoteAt(injKey(row), 'pinnacle', at);
      const m = staleState.engine.pinMain(injKey(row), t);
      return m ? { line: m.x, pOver: m.p } : null;
    },
    appAt: (row, app, at) => (at < t ? staleState.engine.quoteAt(injKey(row), app, at) : injCell(row.books?.[app])),
  };
}
function injuryFind(rows, ctx) {
  const nba = (rows || []).filter(r => r.sport === 'NBA' && !r.esports);
  const evs = injuryState.watch.events().filter(e => ctx.t - e.newsAt <= injuryNews.WINDOW_MS);
  return evs.flatMap(ev => injuryNews.legsFor(ev, nba, ctx));
}
// the legs found since the last call, first sighting only (one per app and prop)
function injuryPlays(rows) {
  const ctx = injuryContext();
  if (!ctx) return [];
  const found = injuryFind(rows, ctx);
  injuryState.legs = found.length; injuryState.legsAt = new Date(ctx.t).toISOString();
  const out = [];
  for (const f of found) {
    const id = `${f.leg.app}|${f.row.key}`;
    if (injuryState.flagged.has(id)) continue;
    injuryState.flagged.set(id, ctx.t);
    out.push(injuryNews.playOf(f));
  }
  for (const [id, at] of injuryState.flagged) if (ctx.t - at > 24 * 3600e3) injuryState.flagged.delete(id);
  return out;
}
async function readInjuries() {
  if (!INJURY_NEWS_ON || !nbaModel) return;
  try {
    const r = await axios.get('https://site.api.espn.com/apis/site/v2/sports/basketball/nba/injuries', { timeout: 20000 });
    const fresh = injuryState.watch.observe(injuryNews.espnEntries(r?.data), Date.now());
    injuryState.at = new Date().toISOString();
    if (fresh.length) console.log(`Injury news: ${fresh.map(e => `${e.team} ${e.name} ${e.from} -> ${e.status}`).join('; ')}`);
  } catch (e) { injuryState.errors = [`ESPN injuries: ${e.message}`, ...injuryState.errors].slice(0, 5); }
}
app.get('/api/props/injury', async (req, res) => {
  try {
    const pro = hasPro(req);
    const t = Date.now();
    const ctx = injuryContext(t);
    const events = injuryState.watch.events().slice().reverse().slice(0, 80).map(e => {
      const r = ctx ? ctx.teamOf(e.key, e.newsAt) : null;
      return { name: e.name, team: e.team, status: e.status, from: e.from, newsAt: new Date(e.newsAt).toISOString(), mins: Math.round((t - e.newsAt) / 60e3),
        mpg: r?.mpg ?? null, rotation: !!r?.rotation, open: t - e.newsAt <= injuryNews.WINDOW_MS, comment: e.comment || '' };
    });
    const { rows } = propsBoardRows();
    const found = ctx ? injuryFind(rows, ctx) : [];
    const hide = l => (pro ? l : { ...l, fair: null, ev: null, pinPre: { line: l.pinPre.line, pOver: null }, pinNow: { line: l.pinNow.line, pOver: null } });
    const byRow = new Map();
    for (const f of found) {
      const k = `${f.row.key}|${f.event.key}`;
      if (!byRow.has(k)) byRow.set(k, { key: f.row.key, sport: 'NBA', player: f.row.player, team: f.row.team || '', market: f.row.market, mkey: f.row.mkey, startTime: f.row.startTime,
        matchTitle: f.row.matchTitle || '', books: f.row.books, out: f.event.name, outTeam: f.event.team, newsAt: new Date(f.event.newsAt).toISOString(), mins: f.mins, mateMpg: f.mateMpg, legs: {} });
      byRow.get(k).legs[f.leg.app] = hide(f.leg);
    }
    const out = [...byRow.values()].sort((a, b) => a.mins - b.mins || a.player.localeCompare(b.player));
    const kinds = (await sportTracker.summary()).byKind || {};
    const record = Object.fromEntries([...injuryNews.KINDS].map(k => [k, kinds[k] || null]));
    const logged = [];
    // the secondary slice (pre-registered before any live leg): legs where Pinnacle's chance at the app's number cleared the break-even when flagged
    const clears = {};
    for (const k of injuryNews.KINDS) {
      const all = await sportTracker.list({ kind: k, limit: 1e6 });
      const g = all.filter(b => b.signalFair != null && b.signalFair * b.signalDecimal >= 1 && b.status === 'graded' && (b.outcome === 'win' || b.outcome === 'loss'));
      const w = g.filter(b => b.outcome === 'win').length;
      clears[k] = { logged: all.filter(b => b.signalFair != null && b.signalFair * b.signalDecimal >= 1).length, graded: g.length, wins: w, losses: g.length - w, units: +g.reduce((a, b) => a + (b.profit || 0), 0).toFixed(2) };
      logged.push(...all.slice(0, 40));
    }
    logged.sort((a, b) => Date.parse(b.signalAt) - Date.parse(a.signalAt));
    res.json({ on: INJURY_NEWS_ON && staleState.enabled && !!nbaModel, pro, label: 'research, not a bet', bar: injuryNews.BAR,
      rule: { minMpg: injuryNews.MIN_MPG, minPts: injuryNews.MIN_PTS, preMin: injuryNews.PRE_MS / 60e3, windowMin: injuryNews.WINDOW_MS / 60e3 },
      watch: { ...injuryState.watch.status(), readAt: injuryState.at, errors: injuryState.errors.slice(0, 3) },
      events, rows: out, total: out.length, record, clears, backtest: injuryBacktest,
      logged: logged.slice(0, 40).map(b => ({ app: b.book, kind: b.kind, player: b.player, market: b.market, side: b.signalSide, line: b.signalLine, signalAt: b.signalAt, start: b.start,
        out: b.injury?.out || null, mins: b.injury?.mins ?? null, status: b.status, outcome: b.outcome || null, result: b.result ?? null, execOk: b.execOk ?? null,
        ev: pro ? b.signalEv ?? null : null, closeEv: pro ? b.closeEv ?? null : null })) });
  } catch (e) { sendErr(res, e); }
});

// ── SHOP: the softest number across the apps (appshop.js) ──
// Every player stat two or more apps hang at different numbers: the softest
// app per side (lowest line for an Over, highest for an Under), the gap to the
// nearest other app, the sharp price at that number where Pinnacle, Kalshi or
// the books post one, the leg's EV at its own app's payout, and the middles
// between two apps worth more than zero on the stat's curve. A research view:
// the backtest (checks/app-shop-2026-10-25) found the softest number short of
// every break-even, so nothing here is a play or an alert.
const appShop = require('../appshop');
// APP_SHOP_RECORD=off stops recording the shop legs (on by default: alerts are off either way)
const APP_SHOP_RECORD = String(process.env.APP_SHOP_RECORD || 'on').toLowerCase() !== 'off';
let shopCache = { at: 0, src: null, rows: [] };
function shopBoard() {
  const { rows } = propsBoardRows();
  if (shopCache.src === rows && Date.now() - shopCache.at < 60000) return shopCache.rows;
  const sharpAt = (row, line) => {
    const f = sportProps.consensusFor(row, line, { sharp: sharpQuotes(row), kalshi: rowKalshi(row), o: SHARP_OPTS });
    if (!f) return null;
    const names = [...new Set((f.sources || []).filter(s => !s.shadow).map(s => s.book))];
    return { p: f.p, source: sportProps.sharpBacked(f) ? 'sharp' : 'books', books: names };
  };
  const evOf = (p, app, side, cell, mult) => dfsLegEv(p, app, mult ?? 1, { overMultiplier: cell.over, underMultiplier: cell.under }, side);
  const out = appShop.shopRows(rows, { sharpAt, evOf });
  shopCache = { at: Date.now(), src: rows, rows: out };
  return out;
}
app.get('/api/props/shop', (req, res) => {
  let rows = shopBoard();
  const pro = hasPro(req), kalshiOk = licenceOf(req).kalshi;
  const sport = String(req.query.sport || 'ALL').toUpperCase();
  if (sport !== 'ALL' && sport !== 'SPORTS') rows = rows.filter(r => r.sport === sport);
  const q = String(req.query.q || '').toLowerCase().slice(0, 60);
  if (q) rows = rows.filter(r => `${r.player} ${r.team} ${r.market} ${r.matchTitle}`.toLowerCase().includes(q));
  const minGap = Math.max(appShop.MIN_GAP, parseFloat(req.query.minGap) || 0);
  rows = rows.filter(r => r.gap >= minGap);
  if (req.query.middles === '1') rows = rows.filter(r => r.middles.length);
  const sort = String(req.query.sort || 'gap');
  if (pro && sort === 'ev') rows = [...rows].sort((a, b) => (b.bestEv ?? -1e9) - (a.bestEv ?? -1e9) || b.gap - a.gap);
  else if (pro && sort === 'middle') rows = [...rows].sort((a, b) => (b.middles[0]?.expUnits ?? -1e9) - (a.middles[0]?.expUnits ?? -1e9));
  else if (sort === 'start') rows = [...rows].sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime));
  const sports = {};
  for (const r of shopBoard()) sports[r.sport] = (sports[r.sport] || 0) + 1;
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit) || 150));
  const offset = Math.max(0, parseInt(req.query.offset) || 0);
  let page = rows.slice(offset, offset + limit);
  // the fair, EV and middles are Pro, and a Kalshi-backed fair needs its licence
  if (!pro || !kalshiOk) page = page.map(appShop.redactShop);
  res.json({ rows: page, total: rows.length, offset, limit, pro, counts: { sports, rows: shopBoard().length, books: {} },
    middles: rows.filter(r => r.middles.length).length, minGap, updated: new Date(shopCache.at).toISOString(), priceAge: priceAgeNow(),
    note: 'Research: on the recorded boards the softest number won 52.6% at PrizePicks (589 legs) vs its 55.0% break-even. Not a play until its own record clears 50 graded live.' });
});

// the shop's own record: P1-P3 and the middles (appshop.recordSummary), free
let shopRecordCache = { at: 0, body: null };
app.get('/api/props/shop/record', async (req, res) => {
  try {
    if (!shopRecordCache.body || Date.now() - shopRecordCache.at > 60e3) shopRecordCache = { at: Date.now(), body: appShop.recordSummary(await shopTracker.list({ limit: 1e6 })) };
    res.json({ ...shopRecordCache.body, recording: APP_SHOP_RECORD, preregistered: 'checks/app-shop-2026-10-25/PREREGISTERED.md' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── APP SCORECARD: each pick'em app's closing number vs Pinnacle's close (appscore.js) ──
// Per app, and per app and stat: how often the app sits at Pinnacle's
// closing number, how far off it is (stat units and points of win chance),
// the side to take at the app's payout and how often it clears break-even,
// graded on the box score. Research until a cell's clears reach 50 graded
// with z 2+ (checks/app-scorecard-2026-10-25/PREREGISTERED.md). Free: it
// shows closed props only.
const appCardCache = new Map();
app.get('/api/props/shop/scorecard', async (req, res) => {
  try {
    const sport = String(req.query.sport || 'NFL').toUpperCase();
    const days = Math.min(14, Math.max(1, parseInt(req.query.days) || 14));
    const ck = `${sport}|${days}`;
    const hit = appCardCache.get(ck);
    if (hit && Date.now() - hit.at < 60e3) return res.json(hit.body);
    await propCloseBook.ready();
    await appScoreResults.ready();
    const sports = sport === 'ALL' ? null : [sport];
    const entries = propCloseBook.entries({ sports, sinceMs: Date.now() - days * 86400e3 });
    const legs = appScore.legsFromBook(entries, appScoreResults.map());
    const card = appScore.scorecard(legs, { minCell: 5 });
    const games = new Set(entries.map(([, e]) => `${e.matchTitle}|${e.start}`)).size;
    const body = { ...card, sport, days, props: entries.length, games, grading: { on: APP_CARD_ON, sports: APP_CARD_SPORTS, ...appScoreResults.status() },
      since: entries.reduce((m, [, e]) => (!m || e.start < m ? e.start : m), null), updated: new Date().toISOString(),
      preregistered: 'checks/app-scorecard-2026-10-25/PREREGISTERED.md',
      note: 'Research, not a play. Every app number here is its last read before the start, against Pinnacle\'s own last number. A cell counts only when its clears reach 50 graded with the hit rate z 2+ past break-even and units above zero, then a raw re-check.' };
    appCardCache.set(ck, { at: Date.now(), body });
    res.json(body);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PROMOS: the apps' discounted and boosted legs vs the sharp price (promos.js) ──
// PrizePicks goblins, demons and promos, Underdog discounted lines, alternates
// and boosted sides, Sleeper's non-normal lines, Pick6's Gimme Pick, Stat
// Slice, Power Up and alt ladders: each at its own payout's required hit rate
// against Pinnacle's no-vig (FanDuel/BetRivers where Pinnacle has none). A lead
// with its own record (promo-<app>-<type>), alerts off: on the weekend boards
// Underdog's boosted sides won 41.7% of 247 vs 49.5% needed
// (checks/promos-2026-10-25). Not a bet until a kind clears 50 graded live.
const promos = require('../promos');
// PROMO_RECORD=off stops recording the promo legs (on by default: alerts are off either way)
const PROMO_RECORD = String(process.env.PROMO_RECORD || 'on').toLowerCase() !== 'off' && !cold.closed('promoLegs');
const promoRowsSeen = new Map();
let promoCache = { at: 0, src: null, rows: [], counts: null };
// every promo leg the readers hold now (PrizePicks only while its pulls are fresh, like its board lines)
function promoLegsNow(now = Date.now()) {
  const ppFresh = ppState.fullOkAt && now - ppState.fullOkAt <= PP_SPORT_STALE_MS;
  const pp = ppFresh ? (cache.ppPromos.data || []).filter(l => !isEsports(l.sport) || now - (ppState.leagueOkAt[l.leagueId] || ppState.fullOkAt) <= PP_ES_STALE_MS) : [];
  return [...pp, ...(cache.udPromos.data || []), ...(cache.slPromos.data || []), ...pick6.promos()];
}
function promoRowIndex(rows) {
  const idx = new Map();
  for (const r of rows) {
    const k = `${r.sport}|${evScreen.canonName(r.player)}|${r.mkey}`;
    (idx.get(k) || idx.set(k, []).get(k)).push(r);
  }
  return idx;
}
// (the props record pass builds it a slice at a time, promoBoardSteps; a request in one go)
const promoBoard = () => runSteps(promoBoardSteps());
function* promoBoardSteps() {
  const { rows } = propsBoardRows();
  if (promoCache.src === rows && Date.now() - promoCache.at < 60000) return promoCache.rows;
  const idx = promoRowIndex(rows);
  const rowFor = leg => {
    const list = idx.get(`${leg.sport}|${evScreen.canonName(leg.player)}|${leg.mkey}`);
    if (!list) return null;
    const t = Date.parse(leg.startTime || '');
    // a leg with its own start takes the row within 3 hours of it; Sleeper's carry none
    if (t) return list.find(r => Math.abs(Date.parse(r.startTime) - t) <= 3 * 3600e3) || null;
    return list.length === 1 ? list[0] : null;
  };
  yield;
  const out = yield* promos.buildPromosSteps(promoLegsNow(), { rowFor, quotesFor: sharpQuotes });
  promoCache = { at: Date.now(), src: rows, rows: out, counts: promos.promoCounts(out) };
  return out;
}
// the record's close: the sharp price at the promo's own number on its board row
// (board rows by key, once per build: the record asks for every promo leg)
let promoKeyIndex = { rows: null, byKey: new Map() };
function promoFairAt(row, book, line) {
  const { rows } = propsBoardRows();
  if (promoKeyIndex.rows !== rows) {
    const byKey = new Map();
    for (const r of rows) if (!byKey.has(r.key)) byKey.set(r.key, r);   // the first, as find took
    promoKeyIndex = { rows, byKey };
  }
  const base = promoKeyIndex.byKey.get(row.baseKey || promos.baseKeyOf(row.key));
  if (!base) return null;
  return promos.sharpAt(sharpQuotes(base), base.mkey, base.sport, line)?.p ?? null;
}
app.get('/api/props/promos', (req, res) => {
  let rows = promoBoard();
  const pro = hasPro(req);
  const sport = String(req.query.sport || 'ALL').toUpperCase();
  if (sport !== 'ALL') rows = rows.filter(r => r.sport === sport);
  if (promos.APPS.includes(req.query.app)) rows = rows.filter(r => r.app === req.query.app);
  if (req.query.type) rows = rows.filter(r => r.type === String(req.query.type).toLowerCase());
  if (req.query.priced !== '0') rows = rows.filter(r => r.fair != null);
  const q = String(req.query.q || '').toLowerCase().slice(0, 60);
  if (q) rows = rows.filter(r => `${r.player} ${r.team} ${r.market} ${r.matchTitle}`.toLowerCase().includes(q));
  if (req.query.sort === 'start') rows = [...rows].sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime));
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit) || 60));
  const offset = Math.max(0, parseInt(req.query.offset) || 0);
  let page = rows.slice(offset, offset + limit);
  // the fair and EV are Pro, like the props board's
  if (!pro) page = page.map(promos.redactPromo);
  res.json({ rows: page, total: rows.length, offset, limit, pro, counts: promoCache.counts, updated: new Date(promoCache.at).toISOString(),
    readers: { prizepicks: cache.ppPromos.updated, underdog: cache.udPromos.updated, sleeper: cache.slPromos.updated, pick6: pick6.status().promos ?? null },
    note: 'A lead, not a bet: each leg at its own payout. PrizePicks does not publish goblin and demon payouts, so those show the multiplier they would need. On the weekend boards Underdog boosted sides won 41.7% of 247 vs 49.5% needed. Nothing is a bet until a kind clears 50 graded live.' });
});
// the promo record by kind (promos.recordSummary), free
let promoRecordCache = { at: 0, body: null };
app.get('/api/props/promos/record', async (req, res) => {
  try {
    if (!promoRecordCache.body || Date.now() - promoRecordCache.at > 60e3) promoRecordCache = { at: Date.now(), body: promos.recordSummary(await promoTracker.list({ limit: 1e6 })) };
    res.json({ ...promoRecordCache.body, recording: PROMO_RECORD, closed: cold.closedInfo('promoLegs'), preregistered: 'checks/promos-2026-10-25/PREREGISTERED.md' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── COVERAGE: how many pick'em legs carry a sharp price (propsboard.coverage) ──
// By app, league and stat: legs priced off Pinnacle, off Kalshi, a sportsbook
// alone, the other apps only, or nothing; `never` marks stats no sharp market
// lists. Counts only, free. ?sport=MMA narrows the markets list.
app.get('/api/props/coverage', (req, res) => {
  const { coverage } = propsBoardRows();
  const sport = String(req.query.sport || '').toUpperCase();
  res.json({ ...coverage, markets: sport ? coverage.markets.filter(m => m.sport === sport) : coverage.markets,
    sources: { pinnacleProps: pinPropsState.props, pinnacleExtra: pinPropsState.extra || null, kalshiExtra: kxExtraState, kalshiLadders: kpropsState.counts },
    updated: new Date(ctx.propsBoardCache.at).toISOString() });
});

// The Lines view's "Used?" boxes, kept on the account so they follow the
// person between devices (the page keeps them in localStorage without one).
// key → when ticked; a week on, the game is long over.
const USED_KEEP_MS = 7 * 86400e3, USED_MAX = 2000;
function usedOf(user) {
  const now = Date.now(), out = {};
  for (const [k, t] of Object.entries(user.used || {})) if (now - t < USED_KEEP_MS) out[k] = t;
  return out;
}
app.get('/api/me/used', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Log in first' });
  res.json({ used: Object.keys(usedOf(req.user)) });
});
app.post('/api/me/used', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Log in first' });
  const keys = (Array.isArray(req.body?.keys) ? req.body.keys : [req.body?.key]).filter(k => typeof k === 'string' && k && k.length <= 200).slice(0, 200);
  if (!keys.length) return res.status(400).json({ error: 'key needed' });
  const used = usedOf(req.user);
  for (const k of keys) { if (req.body?.used === false) delete used[k]; else used[k] = Date.now(); }
  const trimmed = Object.fromEntries(Object.entries(used).sort((a, b) => b[1] - a[1]).slice(0, USED_MAX));
  try {
    const fresh = (await auth.store.get(req.user.id)) || req.user;
    await auth.store.put({ ...fresh, used: trimmed });
    res.json({ used: Object.keys(trimmed) });
  }
  catch (e) { sendErr(res, e); }
});

// MY SLIPS: a user's pick'em legs (no stakes) → each leg against the close.
// A leg is matched to its props-board row and followed from first sight on the
// sharp consensus at its own line (sliplog.js); a leg whose game started
// before it reached us says 'no line history'. Free, like the records.
// The fair is the props record's sharp consensus, down to one source: a leg
// Pinnacle or Kalshi alone prices still gets a close (weights put Pinnacle first).
const SLIP_FAIR_OPTS = { ...SHARP_OPTS, minSources: 1 };
const slipFairAt = (row, book, line) => {
  const f = sportProps.consensusFor(row, line, { sharp: sharpQuotes(row), kalshi: rowKalshi(row), o: { ...SLIP_FAIR_OPTS, weights: SHARP_OPTS.weights } });
  return f ? f.p : null;
};
app.post('/api/slips/grade', async (req, res) => {
  const legs = Array.isArray(req.body?.legs) ? req.body.legs.slice(0, 300) : null;
  if (!legs) return res.status(400).json({ error: 'legs needed' });
  try { res.json(await gradeSlipLegs(legs)); } catch (e) { sendErr(res, e); }
});
// One slip, checked at the moment it is logged (slipstamp.js): each leg goes
// into the slip log now (its sharp price followed from this second to the
// close) and comes back ok (with the server time, the start, the app's line
// and multiplier on the board now, the sharp fair and Pinnacle's own fair at
// that exact line), started (refused, in plain words) or unmatched (no board
// lists it now, so its start is checked later from the box score).
app.post('/api/slips/stamp', async (req, res) => {
  const c = slipstamp.cleanLegs(req.body);
  if (c.error) return res.status(400).json({ error: c.error });
  try {
    const now = Date.now(), at = new Date(now).toISOString();
    const key = `st${now.toString(36)}${Math.random().toString(36).slice(2, 7)}`;
    const ids = c.legs.map((l, i) => `${key}-${i}`);
    const valid = c.legs.map((l, i) => ({ l, i })).filter(({ l }) => l.side && Number.isFinite(l.line) && l.player && l.market);
    const out = valid.length ? await gradeSlipLegs(valid.map(({ l, i }) => ({ id: ids[i], app: c.app, sport: l.sport || null, player: l.player, market: l.market, side: l.side, line: l.line, betAt: at, betAtExact: true, ...(l.opp ? { opp: l.opp } : {}) }))) : { results: {} };
    const { rows } = propsBoardRows();
    const idx = require('../sliplog').indexRows((rows || []).filter(r => !r.esports));
    const verdicts = c.legs.map((l, i) => {
      const g = out.results[ids[i]] || (valid.some(v => v.i === i) ? null : { status: 'nohistory', reason: 'unread' });
      let extra = null;
      if (g?.matched?.start && !g.esports) {
        const m = require('../sliplog').matchLeg({ ...l, app: c.app, betAt: at }, idx, { now });
        const row = m.row, cell = row?.books?.[c.app];
        if (row) {
          const pin = sharpQuotes(row).find(q => q.book === 'pinnacle' && Number(q.line) === l.line);
          const mult = cell ? Number(l.side === 'Over' ? cell.over : cell.under) : NaN;
          extra = { appLine: cell?.line ?? null, mult: mult > 0 && cell?.line === l.line ? mult : null,
            pin: pin && Number.isFinite(pin.pOver) ? Math.round((l.side === 'Over' ? pin.pOver : 1 - pin.pOver) * 1e4) / 1e4 : null };
        }
      }
      return slipstamp.verdict(l, g, { now, extra });
    });
    res.json({ ...slipstamp.stamp(c.legs, verdicts, { now }), app: c.app });
  } catch (e) { sendErr(res, e); }
});
// legs (gradeRequest's shape, at most 300) → { results: { id: view }, at, tables }:
// MY SLIPS and the public bettor records (pubrecord.js) grade the same way
async function gradeSlipLegs(legs) {
  {
    const { rows } = propsBoardRows();
    // esports legs (a league tag of CS, LoL, Valorant, Dota) go to the esports slip record
    const esMod = require('../esslips');
    const esLegs = legs.filter(esMod.isEsportsLeg);
    const rest = legs.filter(l => !esMod.isEsportsLeg(l));
    const out = await slipLog.grade(rest, { rows: rows.filter(r => !r.esports), fairAt: slipFairAt });
    // a leg with no league tag that no sports board lists may be an esports player
    const maybe = rest.filter(l => !l.sport && out.results[String(l.id || '').slice(0, 200)]?.reason === 'player');
    const esTry = [...esLegs, ...maybe];
    if (esTry.length) {
      if (!(esportsCache.picks || []).length) await esPicksOnce().catch(() => {});
      const es = await esSlipLog.grade(esTry, { picks: esportsCache.picks || [] });
      for (const l of esTry) {
        const id = String(l.id || '').slice(0, 200), g = es.results[id];
        // an untagged leg keeps its sports answer unless an esports line lists the player
        if (g && (esLegs.includes(l) || g.reason !== 'player')) out.results[id] = g;
      }
    }
    await gradeSlipCloses(rest, out.results);
    return { ...out, tables: { pick6: pick6.state.payouts || null } };
  }
}
// After the slip log: every sports leg it followed gets Pinnacle's raw close
// beside the sharp consensus, and every leg it couldn't follow (the game had
// started, no app lists the player now, an old Pikkit bet) goes to the late
// grader: the prop close book and the box scores (slipgrade.js).
const SLIP_LATE_REASONS = new Set(['before', 'player', 'market']);
async function gradeSlipCloses(legs, results) {
  const late = [];
  for (const l of legs) {
    const id = String(l?.id || '').slice(0, 200), g = results[id];
    if (!g) continue;
    const side = sliplogSideOf(l.side), line = Number(l.line);
    if (!side || !Number.isFinite(line)) continue;
    const sport = l.sport ? propsBoard.boardSport(l.sport).sport : null;
    if (g.matched?.start && g.status !== 'nohistory' && !g.esports && !g.late) {
      // a followed leg: Pinnacle's own last number, from the close book once the game started
      const e = propCloseBook.get(g.matched.sport, g.matched.player, g.matched.mkey, g.matched.start);
      const c = e ? slipLate.closeOf(e, line, side) : null;
      if (c) g.raw = { ...c, ev: g.decimal ? Math.round((c.fair * g.decimal - 1) * 1e4) / 100 : null };
      continue;
    }
    if (g.status !== 'nohistory' || !SLIP_LATE_REASONS.has(g.reason)) continue;
    const app = String(l.app || '').toLowerCase();
    late.push({ id, app, sport, player: String(l.player || ''), market: String(l.market || ''), mkey: propsBoard.sportMarketKey(l.market, sport || ''),
      side, line, betAt: l.betAt, betAtExact: !!l.betAtExact });
  }
  if (!late.length) return;
  const { legDecimal } = require('../slips');
  const r = await lateSlipGrader.grade(late, { decimalOf: legDecimal });
  // a leg the late grader has no answer for keeps the slip log's reason
  for (const [id, v] of Object.entries(r.results)) results[id] = v;
}
app.get('/api/slips/record', async (req, res) => {
  res.json({ ...(await slipLegTracker.summary({ sinceDays: parseFloat(req.query.days) || undefined })), esports: await esSlipTracker.summary(),
    // the prop close book's days and the late legs graded from box scores
    closeBook: propCloseBook.status(), late: lateSlipGrader.status(), appCard: appScoreResults.status() });
});

// The sports props record: free to see, like every other record. Open legs
// are today's plays, so only finished ones are free.
app.get('/api/props/record', async (req, res) => {
  res.json({ ...(await sportTracker.summary({ sinceDays: parseFloat(req.query.days) || undefined })), minEv: SPORT_OPTS.minEv, gapMinPts: SPORT_OPTS.minProbPts });
});
app.get('/api/props/record/picks', async (req, res) => {
  const status = hasPro(req) ? req.query.status : (['locked', 'graded'].includes(req.query.status) ? req.query.status : 'graded');
  // ?kind=stale-single narrows the list; ?before=<signalAt> pages back
  const q = k => (typeof req.query[k] === 'string' && req.query[k]) || undefined;
  res.json({ picks: await sportTracker.list({ status, kind: q('kind'), before: q('before'), limit: Math.min(parseInt(req.query.limit) || 100, 1000) }) });
});

// Pick'em stale at Pinnacle's own number (staleexact.js): the daily check on
// the one pick'em kind still standing, live legs apart from the 10-24 backfit.
// Free, like the record; today's open legs only with Pro.
const staleExact = require('../staleexact');
app.get('/api/props/stale-exact', async (req, res) => {
  try {
    const legs = await sportTracker.list({ limit: 1e9 });
    res.json(staleExact.report(legs, { showOpen: hasPro(req) }));
  } catch (e) { sendErr(res, e); }
});

// ── MAIN PROPS — merges Owls + Odds API for 24/7 coverage ────────────────────
app.get('/api/props/:sport', async (req, res) => {
  const sport = req.params.sport;
  const oddsApiMap = { nba:'basketball_nba', mlb:'baseball_mlb', nhl:'icehockey_nhl', nfl:'americanfootball_nfl', mma:'mma_mixed_martial_arts', basketball_nba:'basketball_nba', baseball_mlb:'baseball_mlb', icehockey_nhl:'icehockey_nhl', americanfootball_nfl:'americanfootball_nfl' };
  const oddsKey = oddsApiMap[sport] || sport;

  let owls = cache.owlsProps[sport]?.data;
  const owlsFresh = cache.owlsProps[sport]?.updated && (Date.now()-new Date(cache.owlsProps[sport].updated).getTime()) < 300000;
  if (!owlsFresh) owls = await fetchOwlsProps(sport);

  let oddsApi = cache.oddsApiProps[oddsKey]?.data;
  const oddsApiFresh = cache.oddsApiProps[oddsKey]?.updated && (Date.now()-new Date(cache.oddsApiProps[oddsKey].updated).getTime()) < 600000;
  if (!oddsApiFresh) oddsApi = await fetchOddsApiProps(oddsKey);

  let merged = mergeProps(owls, oddsApi);

  // FALLBACK: if nothing from Owls or Odds API, build from PP/UD data
  if (!merged.length) {
    const sportUpper = sport.toUpperCase();
    const ppLines = ppLinesNow().filter(l =>
      l.sport && l.sport.toLowerCase().includes(sport.toLowerCase()) ||
      (sport === 'nba' && l.sport === 'NBA') ||
      (sport === 'mlb' && l.sport === 'MLB') ||
      (sport === 'nhl' && l.sport === 'NHL') ||
      (sport === 'nfl' && l.sport === 'NFL')
    );
    const udLines = (cache.underdog.data || []).filter(l =>
      l.sport && (l.sport.toLowerCase().includes(sport.toLowerCase()) || l.sport.toUpperCase() === sportUpper)
    );

    if (ppLines.length || udLines.length) {
      const playerMap = {};
      for (const l of ppLines) {
        const key = `${l.player}|||${l.market}`;
        if (!playerMap[key]) playerMap[key] = { player: l.player, team: l.team, market: l.market, pp: l.line, ud: null };
      }
      for (const l of udLines) {
        const key = `${l.player}|||${l.market}`;
        if (!playerMap[key]) playerMap[key] = { player: l.player, team: l.team, market: l.market, pp: null, ud: l.line };
        else playerMap[key].ud = l.line;
      }

      const ppProps = [], udProps = [];
      for (const p of Object.values(playerMap)) {
        if (p.pp != null) ppProps.push({ player: p.player, market: p.market, line: p.pp, overPrice: -110, underPrice: -110 });
        if (p.ud != null) udProps.push({ player: p.player, market: p.market, line: p.ud, overPrice: -110, underPrice: -110 });
      }

      const books = [];
      if (ppProps.length) books.push({ key: 'prizepicks', title: 'PrizePicks', props: ppProps });
      if (udProps.length) books.push({ key: 'underdog', title: 'Underdog', props: udProps });

      if (books.length) {
        merged = [{ sport, id: `dfs_${sport}`, home_team: `${sportUpper} Players`, away_team: 'DFS Lines', commence_time: new Date().toISOString(), books }];
        console.log(`Props ${sport}: using DFS fallback — PP:${ppProps.length} UD:${udProps.length}`);
      }
    }
  }

  const total = merged.reduce((s,g)=>s+g.books.reduce((s2,b)=>s2+b.props.length,0),0);
  console.log(`Props ${sport}: ${merged.length} games, ${total} props`);
  res.json(merged);
});

app.get('/api/props', async (req, res) => {
  const sports = ['nba','mlb','nhl','nfl'];
  const oddsMap = { nba:'basketball_nba', mlb:'baseball_mlb', nhl:'icehockey_nhl', nfl:'americanfootball_nfl' };
  const result = {};
  for (const s of sports) {
    result[s] = mergeProps(cache.owlsProps[s]?.data, cache.oddsApiProps[oddsMap[s]]?.data);
  }
  res.json(result);
});

app.get('/api/owls-odds/:sport', async (req, res) => {
  const sport = req.params.sport;
  const c = cache.owlsOdds[sport];
  if (c?.updated && (Date.now()-new Date(c.updated).getTime()) < 30000) return res.json(c.data);
  res.json(await fetchOwlsOdds(sport) || []);
});

app.get('/api/sharp-moves', (req, res) => {
  res.json({ moves: cache.sharpMoves.slice(0, parseInt(req.query.limit)||100), count: cache.sharpMoves.length, updated: new Date().toISOString() });
});
app.delete('/api/sharp-moves', requireAdmin, (req, res) => { cache.sharpMoves = []; res.json({ ok: true }); });

app.get('/api/splits/:sport', async (req, res) => res.json(await fetchOwlsSplits(req.params.sport) || {}));
app.get('/api/odds/:sport', async (req, res) => res.json(await fetchOddsForSport(req.params.sport)));

// The app's Odds API calls come through here so the key stays on the server,
// and every viewer shares one cached response instead of each spending credits.
// ?markets=h2h,spreads&regions=us&includeLinks=true
const ODDS_FEED_TTL_MS = parseInt(process.env.ODDS_FEED_TTL_MS) || 120000;
const FEED_MARKETS = new Set(['h2h', 'spreads', 'totals', 'outrights']);
const oddsFeedCache = new Map();
const oddsFeedInflight = new Map();
// One billed Odds API odds pull for a sport, shared by the app's feed and the
// sportsbook poller. Concurrent callers wait on the same request; the credit
// budget can refuse it ({ budget: { waitMs } } is thrown then).
// Low-usage mode skips totals: on the free plan that stretches 500 credits a
// month to about 8 board refreshes a day instead of 5.
const feedMarkets = () => (oddsBudget.active() ? 'h2h,spreads' : 'h2h,spreads,totals');
async function pullOddsFeed(sport, regions) {
  const key = `${sport}|${regions}`;
  if (!oddsFeedInflight.has(key)) {
    const markets = feedMarkets();
    const budget = oddsBudget.take(oddsCost(markets, regions));
    if (!budget.ok) throw Object.assign(new Error('budget'), { budget });
    oddsFeedInflight.set(key, axios.get(`https://api.the-odds-api.com/v4/sports/${sport}/odds/`, {
      params: { apiKey: ODDS_API_KEY, regions, markets, oddsFormat: 'american', ...(regions !== 'us' ? { includeLinks: true } : {}) }, timeout: 12000,
    }).then(r => {
      noteQuota(r);
      oddsFeedCache.set(key, { at: Date.now(), data: r.data });
      // the screener and sharp tracker read game lines from here too
      if (regions === 'us') cache.odds[sport] = { data: r.data, updated: new Date().toISOString() };
      ingestSharp(sport, r.data);
      return r.data;
    }).finally(() => oddsFeedInflight.delete(key)));
  }
  return oddsFeedInflight.get(key);
}

app.get('/api/odds-feed/:sport', async (req, res) => {
  const sport = String(req.params.sport);
  if (!/^[a-z0-9_]+$/.test(sport)) return res.status(400).json({ error: 'Bad sport key' });
  if (!ODDS_API_KEY) return res.status(503).json({ error: 'ODDS_API_KEY is not set on the server' });
  // Every request maps to one of two upstream fetches per sport (the main view,
  // or the arb scan's wider one), so query variations can't fan out into new
  // billed calls. Markets the caller didn't ask for are trimmed from the reply.
  const wanted = new Set(String(req.query.markets || 'h2h,spreads').split(',').filter(x => FEED_MARKETS.has(x)));
  // Low-usage mode fetches only the main US books: the wide pull costs 3× the credits.
  const wide = !oddsBudget.active() && (/us2|us_ex/.test(String(req.query.regions || '')) || wanted.has('totals'));
  const regions = wide ? 'us,us2,us_ex' : 'us';
  const key = `${sport}|${regions}`;
  const trim = data => (Array.isArray(data) ? data.map(g => ({ ...g, bookmakers: (g.bookmakers || []).map(b => ({ ...b, markets: (b.markets || []).filter(m => wanted.has(m.key)) })) })) : data);
  res.set('Access-Control-Expose-Headers', 'x-requests-remaining, x-cache');
  const hit = oddsFeedCache.get(key);
  // low-usage mode: whatever the poller last pulled is as fresh as it gets
  if (hit && (Date.now() - hit.at < ODDS_FEED_TTL_MS || (oddsBudget.active() && !oddsBudget.check(oddsCost(feedMarkets(), regions)).ok))) {
    if (cache.quotaRemaining != null) res.set('x-requests-remaining', String(cache.quotaRemaining));
    res.set('x-cache', 'hit');
    return res.json(trim(hit.data));
  }
  try {
    const data = await pullOddsFeed(sport, regions);
    if (cache.quotaRemaining != null) res.set('x-requests-remaining', String(cache.quotaRemaining));
    res.set('x-cache', 'miss');
    res.json(trim(data));
  } catch (e) {
    if (e.budget) {
      const mins = Math.ceil(e.budget.waitMs / 60000);
      res.set('x-cache', 'budget');
      if (hit) return res.json(trim(hit.data));
      return res.status(503).json({ error: `Saving Odds API credits: next refresh in about ${mins} min`, lowUsage: true, retryInMs: e.budget.waitMs });
    }
    const status = e.response?.status || 502;
    if (hit) { res.set('x-cache', 'stale'); return res.json(trim(hit.data)); }   // better old odds than none
    res.status(status).json({ error: status === 429 ? 'Odds API quota used up' : status === 401 ? 'Odds API key rejected' : `Odds API error ${status}` });
  }
});


return {
  bookArbTracker, bookArbState, scanBookArbs, scanBigMoney, trackSportProps,
  readInjuries, gradeSlipLegs, ODDS_FEED_TTL_MS, oddsFeedCache, feedMarkets, pullOddsFeed
};
};
