// ─── EXCHANGE PROPS: KALSHI PLAYER-PROP RUNGS AGAINST PINNACLE ───────────────
// Kalshi lists player stat ladders ("Jalen Brunson: 25+ points"), one market
// per rung. A rung N+ is the same bet as Pinnacle's Over N-0.5, and its NO is
// the Under. Where Pinnacle hangs its main line exactly on a rung, its no-vig
// price is a fair for that rung. This keeps a research record of two ways to
// play the gap, each league x stat its own kind, never pooled. Rules fixed
// before any price was looked at (checks/kxprops-2026-10-26/PREREGISTERED.md):
//
//   match   same player, stat and game (Kalshi settles 0-12 h after Pinnacle's
//           start), Pinnacle's line exactly the rung's line; no interpolation
//   taker   the first read 2 min to 24 h before the start where Pinnacle's fair
//           / (Kalshi's ask + taker fee) - 1 >= 2%; one per rung x side. The
//           order book at that read gives the size at the shown price.
//   maker   a resting bid at the highest cent b <= ask - 1c with fair /
//           (b + maker fee) - 1 >= 2%, posted once per rung x side; cancelled
//           when fair / (b + fee) falls under 1 or at the start; filled only
//           on a Kalshi trade printed strictly through the bid
//   close   Pinnacle's fair at its last read <= 20 min before the start, on
//           the same line (a line that moved off the rung is not graded on CLV)
//   result  Kalshi's settlement (the official box score); profit per $1 at
//           the price paid, fee in
//   verdict 50 graded of one kind: CLV t >= 2 and results not 1.5 sd short of
//           what the close expects → passes the record (then a raw re-check);
//           CLV <= 0 or results 1.5 sd short → fails
//
// Research, not a tip sheet: identical for every viewer, no alerts, no orders,
// no sizing. EXCHANGE_PROPS=off stops it.

const { canonName } = require('./ev');
const fees = require('./fees');
const kmaker = require('./kmaker');
const execcheck = require('./execcheck');

const EDGE = 0.02;
const MIN_N = 50;
const LOT = 100;                       // fees priced on a 100-contract order
const TAKER_RATE = fees.SCHEDULES.kalshi.taker.rate;   // 0.07
const MAKER_RATE = kmaker.MAKER_RATE;                  // 0.0175 where the series charges makers
const CLOSE_MAX_AGE_MS = 20 * 60e3;
const WINDOW_MIN = [2, 1440];
const SETTLE_MAX_MS = 12 * 3600e3;    // a rung settles within this long after the start
const MIN_PRICE = 0.03;
const API = 'https://api.elections.kalshi.com/trade-api/v2';
const LEAGUES = new Set(['NFL', 'NBA', 'NHL', 'MLB', 'WNBA']);
// Kalshi's stat words that ev.canonMarket leaves long
const MKEY_FIX = { 'points,_rebounds,_and_assists': 'pra', 'points,_rebounds_and_assists': 'pra' };
const mkeyOf = k => MKEY_FIX[k] || k;
const r4 = x => Math.round(x * 1e4) / 1e4;
const cents = x => Math.round(x * 100) / 100;

const takerFee = p => fees.orderFee('kalshi', p, LOT, { rate: TAKER_RATE, round: true }) / LOT;
const kindOf = (role, league, mkey) => `kxprop-${role}-${String(league).toLowerCase()}-${mkey}`;
// 'kxprop-maker-nhl-points' → { role, league, mkey }
function parseKind(kind) {
  const m = /^kxprop-(taker|maker)-([a-z]+)-(.+)$/.exec(String(kind || ''));
  return m ? { role: m[1], league: m[2].toUpperCase(), mkey: m[3] } : null;
}

// One rung against Pinnacle's quotes for the same player and stat.
// rung: kpropsState.rungs value { ticker, league, player, mkey, line, start (settles - 3h), yesBid, yesAsk, eventTicker, url }
// quotes: pinprops quotes [{ line, pOver, start }] for `${league}|${canonName(player)}|${mkey}`
// → the board row, or null when Pinnacle has no line on the rung
function priceRung(rung, quotes, { now = Date.now(), edge = EDGE, makerRate = MAKER_RATE } = {}) {
  if (!rung || !LEAGUES.has(rung.league) || !Array.isArray(quotes)) return null;
  const settles = Date.parse(rung.start) + 3 * 3600e3;
  const q = quotes.find(x => Math.abs(Number(x.line) - Number(rung.line)) < 1e-6 && settles - Date.parse(x.start) > 0 && settles - Date.parse(x.start) <= SETTLE_MAX_MS);
  if (!q || !(q.pOver > 0 && q.pOver < 1)) return null;
  const start = new Date(Date.parse(q.start)).toISOString();
  const ask = { yes: rung.yesAsk, no: rung.yesBid > 0 && rung.yesBid < 1 ? cents(1 - rung.yesBid) : null };
  const fair = { yes: r4(q.pOver), no: r4(1 - q.pOver) };
  const sides = {};
  for (const s of ['yes', 'no']) {
    const a = ask[s];
    const ok = a > 0 && a < 1;
    const cost = ok ? r4(a + takerFee(a)) : null;
    const bid = ok ? kmaker.suggestBid({ fair: fair[s], ask: a, edge, rate: makerRate }) : null;
    sides[s] = { fair: fair[s], ask: ok ? a : null, cost, ev: cost ? r4(fair[s] / cost - 1) : null, ...(bid && bid.bid >= MIN_PRICE ? { bid: bid.bid, bidFee: bid.fee, bidCost: bid.cost, bidEdge: bid.edge } : { bid: null }) };
  }
  return { ticker: rung.ticker, league: rung.league, player: rung.player, mkey: rung.mkey, line: rung.line, start, event: rung.eventTicker || null, url: rung.url || null,
    yesBid: rung.yesBid ?? null, yesAsk: rung.yesAsk ?? null, pinOver: r4(q.pOver), sides, minsToStart: Math.round((Date.parse(start) - now) / 60e3) };
}

// every rung with a Pinnacle line on it → board rows, soonest start first
function boardOf({ rungs, pinIdx } = {}, { now = Date.now(), rateOf = () => MAKER_RATE, edge = EDGE } = {}) {
  const out = [];
  if (!rungs || !pinIdx) return out;
  for (const rung of rungs.values ? rungs.values() : rungs) {
    if (!LEAGUES.has(rung.league)) continue;
    const mkey = mkeyOf(rung.mkey);
    const quotes = pinIdx.get(`${rung.league}|${canonName(rung.player)}|${mkey}`);
    if (!quotes) continue;
    const row = priceRung(mkey === rung.mkey ? rung : { ...rung, mkey }, quotes, { now, edge, makerRate: rateOf(rung.ticker) });
    if (row) out.push(row);
  }
  return out.sort((a, b) => Date.parse(a.start) - Date.parse(b.start) || a.player.localeCompare(b.player));
}

// one closed bet → CLV and result
function grade(b) {
  const out = {};
  if (b.closeFair > 0) out.clv = r4(b.closeFair / b.cost - 1);
  if (b.result === 'yes' || b.result === 'no') {
    const won = (b.side === 'yes') === (b.result === 'yes');
    out.outcome = won ? 'win' : 'loss';
    out.profit = won ? r4(1 / b.cost - 1) : -1;
  } else if (b.result === 'void') { out.outcome = 'push'; out.profit = 0; }
  return out;
}

const stat = xs => {
  const n = xs.length;
  if (!n) return { n: 0, mean: null, t: null };
  const mean = xs.reduce((s, x) => s + x, 0) / n;
  const sd = n > 1 ? Math.sqrt(xs.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1)) : 0;
  return { n, mean: r4(mean), t: sd > 0 ? Math.round(mean / (sd / Math.sqrt(n)) * 100) / 100 : null };
};
// a bet that counts: a taker flag, or a maker bid a print went through
const counts = b => b.role === 'taker' || b.filled === true;
// bets of one kind → the record row
function summarize(bets = [], { minN = MIN_N, kind = null } = {}) {
  const live = bets.filter(counts);
  const graded = live.filter(b => b.clv != null);
  const clv = stat(graded.map(b => b.clv));
  const res = live.filter(b => b.outcome === 'win' || b.outcome === 'loss' || b.outcome === 'push');
  const withClose = res.filter(b => b.closeFair > 0);
  const profit = r4(res.reduce((s, b) => s + b.profit, 0));
  const exp = r4(withClose.reduce((s, b) => s + (b.closeFair / b.cost - 1), 0));
  const sd = Math.sqrt(withClose.reduce((s, b) => s + b.closeFair * (1 - b.closeFair) / (b.cost * b.cost), 0));
  const z = sd > 0 ? Math.round((r4(withClose.reduce((s, b) => s + b.profit, 0)) - exp) / sd * 100) / 100 : null;
  const sizes = live.filter(b => b.depth && b.depth.usd != null).map(b => b.depth.usd).sort((a, b) => a - b);
  const makers = bets.filter(b => b.role === 'maker');
  const decided = makers.filter(b => b.filled != null);
  // under the bar: a kind behind the close is no lead at all
  let verdict = clv.n && clv.mean <= 0 ? 'no lead' : 'lead';
  if (clv.n >= minN) verdict = (clv.mean <= 0 || (z != null && z <= -1.5)) ? 'fail' : clv.t >= 2 ? 'passes the record' : 'lead';
  else if (verdict === 'lead' && z != null && res.length >= 20 && z <= -1.5) verdict = 'lead (results short)';
  return {
    kind, bets: live.length, open: live.filter(b => b.status !== 'graded').length, graded: clv.n, of: minN, clv: clv.mean, clvT: clv.t,
    beatClose: graded.length ? r4(graded.filter(b => b.clv > 0).length / graded.length) : null,
    results: res.length, won: res.filter(b => b.outcome === 'win').length, lost: res.filter(b => b.outcome === 'loss').length, profit, expected: exp, z,
    lineMoved: live.filter(b => b.closeMissing === 'line moved').length,
    medianUsdAtEdge: sizes.length ? sizes[Math.floor((sizes.length - 1) / 2)] : null, sized: sizes.length,
    ...(makers.length ? { posted: makers.length, decided: decided.length, fillRate: decided.length ? r4(decided.filter(b => b.filled).length / decided.length) : null } : {}),
    verdict,
  };
}
// one record per kind, never pooled → [{ kind, role, league, mkey, ...summarize }], most bets first
function byKind(bets = [], o = {}) {
  const m = new Map();
  for (const b of bets) { if (!m.has(b.kind)) m.set(b.kind, []); m.get(b.kind).push(b); }
  return [...m].map(([kind, xs]) => ({ ...parseKind(kind), ...summarize(xs, { ...o, kind }) }))
    .sort((a, b) => b.bets - a.bets || String(a.kind).localeCompare(b.kind));
}

const seriesOf = t => String(t || '').split('-')[0].toUpperCase();

// The live record. store: { init?, all, put }; http.get(url, cfg) for Kalshi's public API.
function createExchangePropsTracker({ store, http, now = () => Date.now(), maxBooks = 12 } = {}) {
  const loaded = (async () => { if (store.init) await store.init(); })();
  const series = new Map();
  const state = { scans: 0, lastScan: null, rungs: 0, matched: 0, takerNow: 0, makerNow: 0, flagged: 0, posted: 0, settled: 0, books: 0, errors: [], board: [], boardAt: null };
  const rateOf = t => series.get(seriesOf(t))?.rate ?? MAKER_RATE;
  const err = e => { state.errors = [String(e?.response?.status || e?.message || e).slice(0, 160), ...state.errors].slice(0, 5); };

  async function feeSchedules(tickers) {
    const want = [...new Set(tickers.map(seriesOf))].filter(s => s && !(now() - (series.get(s)?.at || 0) < 6 * 3600e3)).slice(0, 10);
    for (const s of want) {
      try { const r = await http.get(`${API}/series/${s}`, { timeout: 8000 }); series.set(s, { rate: kmaker.makerRateOf(r?.data?.series), at: now() }); }
      catch (e) { series.set(s, { rate: MAKER_RATE, at: now() - 5.5 * 3600e3 }); err(e); }
    }
  }
  // the order book behind a flag: contracts and dollars at prices that still clear the edge
  async function depthOf(ticker, side, fair) {
    const r = await http.get(execcheck.KALSHI_BOOK_URL(ticker), { timeout: 8000 });
    const asks = execcheck.kalshiAsks(r?.data, side).sort((a, b) => a[0] - b[0]);
    let contracts = 0, usd = 0;
    for (const [p, q] of asks) { if (fair / (p + takerFee(p)) - 1 < EDGE - 1e-9) break; contracts += q; usd += q * p; }
    state.books++;
    return { contracts: Math.round(contracts), usd: Math.round(usd), top: asks[0] ? asks[0][0] : null, topSize: asks[0] ? Math.round(asks[0][1]) : null, at: new Date(now()).toISOString() };
  }

  async function scan({ rungs, pinIdx } = {}) {
    await loaded;
    const t = now();
    const rungList = rungs ? [...(rungs.values ? rungs.values() : rungs)] : [];
    state.rungs = rungList.length;
    let board = boardOf({ rungs: rungList, pinIdx }, { now: t, rateOf });
    try { await feeSchedules(board.map(x => x.ticker)); board = boardOf({ rungs: rungList, pinIdx }, { now: t, rateOf }); } catch (e) { err(e); }
    state.matched = board.length;
    state.takerNow = board.filter(x => ['yes', 'no'].some(s => x.sides[s].ev >= EDGE)).length;
    state.makerNow = board.filter(x => ['yes', 'no'].some(s => x.sides[s].bid != null)).length;
    state.board = board; state.boardAt = new Date(t).toISOString();
    const byTicker = new Map(board.map(x => [x.ticker, x]));
    const all = await store.all();
    const have = new Set(all.map(b => b.id));
    const changed = new Map();
    // follow open bets: Pinnacle's fair (for the close), and the maker cancel
    for (const b of all) {
      if (b.status !== 'open') continue;
      if (Date.parse(b.start) <= t) { closeBet(b); changed.set(b.id, b); continue; }
      const x = byTicker.get(b.ticker);
      if (!x) continue;
      const f = x.sides[b.side].fair;
      const moved = f !== b.fairLast;
      b.fairLast = f; b.fairLastAt = new Date(t).toISOString(); b.lineOk = true;
      if (b.role === 'maker' && !b.cancelAt && f / b.cost - 1 < 0) { b.cancelAt = new Date(t).toISOString(); b.fairAtCancel = f; }
      if (moved) { (b.fairs ||= []).push([t, f]); if (b.fairs.length > 300) b.fairs = b.fairs.filter((_, i) => i % 2 === 0); }
      if (moved || t - (b.savedAt || 0) >= 10 * 60e3) { b.savedAt = t; changed.set(b.id, b); }
    }
    // an open bet whose rung lost its Pinnacle match this read: Pinnacle moved its line (or pulled the prop)
    // (only on a read where Pinnacle answered and Kalshi still lists the rung)
    const listed = new Set(rungList.map(r => r.ticker));
    const pinUp = !!(pinIdx && pinIdx.size);
    for (const b of all) if (pinUp && b.status === 'open' && listed.has(b.ticker) && !byTicker.has(b.ticker) && b.lineOk !== false && Date.parse(b.start) > t) { b.lineOk = false; b.lineOffAt = new Date(t).toISOString(); changed.set(b.id, b); }
    let books = 0;
    for (const x of board) {
      const mins = (Date.parse(x.start) - t) / 60e3;
      if (!(mins >= WINDOW_MIN[0] && mins <= WINDOW_MIN[1])) continue;
      for (const side of ['yes', 'no']) {
        const s = x.sides[side];
        const base = { ticker: x.ticker, side, league: x.league, player: x.player, mkey: x.mkey, line: x.line, start: x.start, event: x.event, url: x.url,
          fairAtPost: s.fair, askAtPost: s.ask, postedAt: new Date(t).toISOString(), minsBefore: Math.round(mins), fairLast: s.fair, fairLastAt: new Date(t).toISOString(), fairs: [[t, s.fair]], lineOk: true, status: 'open' };
        const tid = `taker|${x.ticker}|${side}`;
        if (s.ev >= EDGE && s.ask >= MIN_PRICE && !have.has(tid)) {
          const b = { id: tid, role: 'taker', kind: kindOf('taker', x.league, x.mkey), price: s.ask, cost: s.cost, evAtPost: s.ev, ...base };
          if (books < maxBooks) { books++; try { b.depth = await depthOf(x.ticker, side, s.fair); } catch (e) { err(e); } }
          have.add(tid); changed.set(tid, b); state.flagged++;
        }
        const mid = `maker|${x.ticker}|${side}`;
        if (s.bid != null && !have.has(mid)) {
          const b = { id: mid, role: 'maker', kind: kindOf('maker', x.league, x.mkey), bid: s.bid, fee: s.bidFee, cost: s.bidCost, edgeAtPost: s.bidEdge, makerRate: rateOf(x.ticker), bestBidAtPost: side === 'yes' ? x.yesBid : (x.yesAsk > 0 && x.yesAsk < 1 ? cents(1 - x.yesAsk) : null), ...base };
          have.add(mid); changed.set(mid, b); state.posted++;
        }
      }
    }
    for (const b of changed.values()) await store.put(b);
    state.scans++; state.lastScan = new Date(t).toISOString();
    return { matched: board.length, changed: changed.size };
  }

  function closeBet(b) {
    b.status = 'closed';
    const age = Date.parse(b.start) - Date.parse(b.fairLastAt || 0);
    if (b.lineOk === false) { b.closeFair = null; b.closeMissing = 'line moved'; }
    else if (b.fairLast > 0 && age <= CLOSE_MAX_AGE_MS) b.closeFair = b.fairLast;
    else { b.closeFair = null; b.closeMissing = 'no fresh close'; }
    if (b.role === 'taker') b.status = 'filled';
  }

  // closed makers: the fill from Kalshi's prints; every filled bet: the settlement
  async function settle({ limit = 20, minAgeMs = 10 * 60e3 } = {}) {
    await loaded;
    const t = now();
    const due = (await store.all()).filter(b => (b.status === 'closed' && t - Date.parse(b.start) >= minAgeMs) || (b.status === 'filled' && t - Date.parse(b.start) >= 2 * 3600e3 && !(b.resultTries >= 48)))
      .sort((a, b) => Date.parse(a.start) - Date.parse(b.start)).slice(0, limit);
    let n = 0;
    for (const b of due) {
      try {
        if (b.status === 'closed' && b.role === 'maker') {
          const from = Date.parse(b.postedAt), to = Math.min(Date.parse(b.cancelAt || b.start), Date.parse(b.start));
          const trades = await readTrades(b.ticker, from, to);
          const f = kmaker.fillOf(trades, { buy: b.side, bid: b.bid, from, to });
          b.filled = !!f.through; b.filledAtBid = !f.through && !!f.atBid; b.contractsAtBid = f.contractsAt; b.trades = trades.length;
          if (f.through) { b.fillAt = new Date(f.through.t).toISOString(); b.fairAtFill = kmaker.fairAt({ fairAtPost: b.fairAtPost, fairs: b.fairs }, f.through.t); }
          b.status = b.filled ? 'filled' : 'unfilled';
          if (!b.filled) delete b.fairs;
        }
        if (b.status === 'filled' && t - Date.parse(b.start) >= 2 * 3600e3) {
          const r = await http.get(`${API}/markets/${encodeURIComponent(b.ticker)}`, { timeout: 8000 });
          const m = r?.data?.market;
          const res = String(m?.result || '').toLowerCase();
          if (res === 'yes' || res === 'no' || (res === 'void' && /settled|finalized/.test(String(m?.status)))) {
            b.result = res; Object.assign(b, grade(b)); b.status = 'graded'; delete b.fairs; n++;
          } else b.resultTries = (b.resultTries || 0) + 1;
        }
        await store.put(b);
      } catch (e) { err(e); }
    }
    state.settled += n;
    return { due: due.length, graded: n };
  }
  async function readTrades(ticker, from, to) {
    const out = [];
    let cursor = null;
    for (let p = 0; p < 20; p++) {
      const r = await http.get(`${API}/markets/trades`, { params: { ticker, limit: 1000, min_ts: Math.floor(from / 1000), max_ts: Math.ceil(to / 1000), ...(cursor ? { cursor } : {}) }, timeout: 10000 });
      const page = r?.data?.trades || [];
      for (const x of page) out.push(kmaker.tradeRow(x));
      cursor = r?.data?.cursor || null;
      if (!cursor || !page.length) break;
    }
    return out;
  }
  async function list() { await loaded; return store.all(); }
  return { scan, settle, list, state, ready: () => loaded, rateOf };
}

module.exports = { mkeyOf, EDGE, MIN_N, LEAGUES, TAKER_RATE, MAKER_RATE, takerFee, kindOf, parseKind, priceRung, boardOf, grade, summarize, byKind, counts, createExchangePropsTracker };
