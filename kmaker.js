// ─── KALSHI MAKER: RESTING BIDS BELOW PINNACLE'S FAIR ─────────────────────────
// Every Kalshi taker lane lost to Pinnacle's close (xsize.js: -1.6% to -2.1%
// at $50 to $1,000). A taker pays the spread and the 7% fee; a maker sets the
// price and pays a quarter of that fee. This prices a resting bid on each
// Kalshi NFL, CFB, NBA and NHL game side a few cents under Pinnacle's no-vig
// fair, and keeps a record of what those bids would have done, judged on
// Kalshi's own trade prints. Rules fixed before any data
// (checks/kalshi-maker-2026-10-25/PREREGISTERED.md):
//
//   bid     the highest whole cent b with fair / (b + maker fee) - 1 >= 2%,
//           at least 1c under the ask (a resting order, never a take), b >= 3c
//   post    the first read 2 min to 24 h before the start with such a bid;
//           one bid per market × side, Pinnacle main lines only
//   cancel  when Pinnacle's fair falls until the bid no longer clears the fee,
//           or at the start
//   fill    a Kalshi trade printed strictly through the bid between the post
//           and the cancel (a sell printed at exactly the bid is reported apart)
//   close   Pinnacle's fair for the side at its last read <= 20 min before start
//   result  Kalshi's settlement; profit per $1 at bid + fee
//   verdict 50 graded fills: CLV t >= 2 and results not 1.5 sd short → passes
//           the record (then a raw re-check); CLV <= 0 or 1.5 sd short → fails
//
// Research, not a tip sheet: no alerts, no orders, no sizing. KALSHI_MAKER=off stops it.

const { kalshiFee } = require('./exchanges');
const xsize = require('./xsize');

const KIND = 'kalshi-maker';
const SPORTS = new Set(['nfl', 'ncaaf', 'nba', 'nhl']);
const EDGE = 0.02;
const EDGES = [0.01, 0.02, 0.04];      // reported in the backtest; 2% is the one judged
const MAKER_RATE = 0.0175;             // Kalshi: round up(0.0175 × C × P × (1−P)) on markets with maker fees
const LOT = 100;                        // fee rounding is per order: priced on a 100-contract order
const MIN_BID = 0.03;
const MIN_N = 50;
const CLOSE_MAX_AGE_MS = 20 * 60e3;
const WINDOW_MIN = [2, 1440];
const API = 'https://api.elections.kalshi.com/trade-api/v2';
const r4 = x => Math.round(x * 1e4) / 1e4;
const cents = x => Math.round(x * 100) / 100;

// the series' fee schedule → the maker rate. Kalshi lists fee_type
// 'quadratic_with_maker_fees' where makers pay, 'quadratic' where they don't;
// unknown → the maker fee is charged (the safe side)
function makerRateOf(series) {
  const mult = Number(series?.fee_multiplier);
  const m = Number.isFinite(mult) && mult > 0 ? mult : 1;
  const type = String(series?.fee_type || '').toLowerCase();
  if (type === 'quadratic' || type === 'flat' || type === 'free') return 0;
  return MAKER_RATE * m;
}
// maker fee per contract at price p on a LOT-contract order
const makerFee = (p, rate = MAKER_RATE) => kalshiFee(p, LOT, rate) / LOT;

// the bid for one side: fair (Pinnacle no-vig), ask (Kalshi's ask on that side)
// → { bid, fee, cost, edge } | null
function suggestBid({ fair, ask, edge = EDGE, rate = MAKER_RATE }) {
  if (!(fair > 0 && fair < 1)) return null;
  const top = cents(Math.min(ask > 0 && ask <= 1 ? ask - 0.01 : 0.99, Math.floor(fair * 100 + 1e-9) / 100));
  for (let b = top; b >= MIN_BID - 1e-9; b = cents(b - 0.01)) {
    const fee = makerFee(b, rate), cost = b + fee;
    if (fair / cost - 1 >= edge - 1e-9) return { bid: b, fee: r4(fee), cost: r4(cost), edge: r4(fair / cost - 1) };
  }
  return null;
}

// Kalshi trades [[ms, yesPrice, takerSide, count]] → did a bid on `buy` at `bid`
// fill between from (exclusive) and to (inclusive)?
//   through   a print strictly better than the bid for a seller to us
//   atBid     a sell printed at exactly the bid (we might have been behind the queue)
function fillOf(trades, { buy, bid, from, to }) {
  let through = null, atBid = null, contractsAt = 0;
  for (const [t, yp, taker, n] of trades || []) {
    if (!(t > from && t <= to) || !(yp >= 0 && yp <= 1)) continue;
    const p = buy === 'yes' ? yp : cents(1 - yp);
    // a seller to a YES bid is a NO taker; to a NO bid, a YES taker
    const seller = buy === 'yes' ? taker === 'no' : taker === 'yes';
    if (p < bid - 1e-9) { if (!through || t < through.t) through = { t, price: p }; }
    else if (Math.abs(p - bid) < 1e-9 && seller) { contractsAt += Number(n) || 0; if (!atBid || t < atBid.t) atBid = { t, price: p }; }
  }
  return { through, atBid, contractsAt };
}

// one closed bid → CLV and result per $1 at the bid + fee
function grade(b) {
  const out = {};
  if (b.closeFair > 0) out.clv = r4(b.closeFair / b.cost - 1);
  if (b.result === 'yes' || b.result === 'no') {
    const won = (b.buy === 'yes') === (b.result === 'yes');
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
// bids → the record row: fills, fill rate, CLV, results vs what the close expects, verdict.
// Only fills through the bid are judged; at-bid fills are shown apart.
function summarize(bids = [], { minN = MIN_N, fill = 'through' } = {}) {
  const decided = bids.filter(b => b.filled != null);
  const fills = decided.filter(b => (fill === 'atBid' ? b.filled || b.filledAtBid : b.filled));
  const graded = fills.filter(b => b.clv != null);
  const clv = stat(graded.map(b => b.clv));
  const res = graded.filter(b => b.outcome === 'win' || b.outcome === 'loss' || b.outcome === 'push');
  const profit = r4(res.reduce((s, b) => s + b.profit, 0));
  const exp = r4(res.reduce((s, b) => s + (b.closeFair / b.cost - 1), 0));
  const sd = Math.sqrt(res.reduce((s, b) => s + b.closeFair * (1 - b.closeFair) / (b.cost * b.cost), 0));
  const z = sd > 0 ? Math.round((profit - exp) / sd * 100) / 100 : null;
  // adverse selection: how far Pinnacle's fair had moved against the side by the fill, and by the close
  const drift = stat(fills.filter(b => b.fairAtFill > 0).map(b => r4(b.fairAtFill - b.fairAtPost)));
  const toClose = stat(graded.map(b => r4(b.closeFair - b.fairAtPost)));
  let verdict = 'lead';
  if (clv.n >= minN) verdict = (clv.mean <= 0 || (z != null && z <= -1.5)) ? 'fail' : clv.t >= 2 ? 'passes the record' : 'lead';
  else if (z != null && res.length >= 20 && z <= -1.5) verdict = 'lead (results short)';
  return {
    kind: KIND, posted: bids.length, open: bids.filter(b => b.status === 'open' || b.status === 'closed').length,
    decided: decided.length, filled: fills.length, fillRate: decided.length ? r4(fills.length / decided.length) : null,
    graded: clv.n, of: minN, clv: clv.mean, clvT: clv.t, beatClose: graded.length ? r4(graded.filter(b => b.clv > 0).length / graded.length) : null,
    results: res.length, won: res.filter(b => b.outcome === 'win').length, lost: res.filter(b => b.outcome === 'loss').length,
    profit, expected: exp, z, fairDriftAtFill: drift.mean, fairDriftToClose: toClose.mean, verdict,
  };
}
function summarizeBy(bids, keyOf, o) {
  const m = new Map();
  for (const b of bids) { const k = keyOf(b); if (!m.has(k)) m.set(k, []); m.get(k).push(b); }
  return [...m].map(([key, xs]) => ({ key, ...summarize(xs, o) })).sort((a, b) => b.posted - a.posted);
}

// Kalshi's sides with Pinnacle's fair (xsize.sidesOf), the four leagues only,
// with the ask and best bid on the side and the suggested bid
// → [{ sideKey, sport, event, start, market, side, point, marketId, buy, alt, fair, ask, bestBid, ...suggestBid }]
function boardOf({ games = {}, pinGames = [], kalshiRows = [] } = {}, { rateOf = () => MAKER_RATE, edge = EDGE } = {}) {
  const rowBy = new Map(kalshiRows.map(r => [r.id, r]));
  const out = [];
  for (const s of xsize.sidesOf({ games, pinGames, kalshiRows })) {
    if (s.venue !== 'kalshi' || !SPORTS.has(s.sport)) continue;
    const row = rowBy.get(s.ref.id);
    if (!row) continue;
    const ask = s.ref.buy === 'yes' ? row.yesAsk : row.noAsk, other = s.ref.buy === 'yes' ? row.noAsk : row.yesAsk;
    if (!(ask > 0 && ask < 1)) continue;
    const bestBid = other > 0 && other < 1 ? cents(1 - other) : null;
    const rate = rateOf(s.ref.id);
    const bid = suggestBid({ fair: s.fair, ask, edge, rate });
    out.push({ sideKey: s.sideKey, sport: s.sport, event: s.event, start: s.start, market: s.market, side: s.side, point: s.point,
      marketId: s.ref.id, buy: s.ref.buy, alt: !!s.alt, fair: s.fair, ask, bestBid, takerCost: s.cost, takerEv: s.ev, makerRate: rate,
      ...(bid ? { bid: bid.bid, fee: bid.fee, cost: bid.cost, edge: bid.edge } : { bid: null }) });
  }
  return out;
}

const seriesOf = ticker => String(ticker || '').split('-')[0].toUpperCase();

// The live record. store: { init?, all, put }; http.get(url, { params }) for Kalshi's public API.
function createMakerTracker({ store, http, now = () => Date.now(), log = console } = {}) {
  const loaded = (async () => { if (store.init) await store.init(); })();
  const series = new Map();      // series ticker → { rate, at }
  const state = { scans: 0, lastScan: null, sides: 0, withBid: 0, posted: 0, settled: 0, errors: [], board: [], boardAt: null };
  const rateOf = id => series.get(seriesOf(id))?.rate ?? MAKER_RATE;
  const err = e => { state.errors = [String(e?.response?.status || e?.message || e).slice(0, 160), ...state.errors].slice(0, 5); };

  async function feeSchedules(ids) {
    const want = [...new Set(ids.map(seriesOf))].filter(s => s && !(now() - (series.get(s)?.at || 0) < 6 * 3600e3)).slice(0, 10);
    for (const s of want) {
      try { const r = await http.get(`${API}/series/${s}`, { timeout: 8000 }); series.set(s, { rate: makerRateOf(r?.data?.series), type: r?.data?.series?.fee_type ?? null, at: now() }); }
      catch (e) { series.set(s, { rate: MAKER_RATE, type: null, at: now() - 5.5 * 3600e3 }); err(e); }
    }
  }

  // one pass: the board, new bids posted, open bids followed, started ones closed
  async function scan(input) {
    await loaded;
    const t = now();
    try { await feeSchedules((input.kalshiRows || []).filter(r => r.exchange === 'kalshi').map(r => r.id)); } catch (e) { err(e); }
    const board = boardOf(input, { rateOf });
    state.sides = board.length; state.withBid = board.filter(x => x.bid != null).length;
    state.board = board; state.boardAt = new Date(t).toISOString();
    const bySide = new Map(board.map(x => [x.sideKey, x]));
    const all = await store.all();
    const have = new Map(all.map(b => [b.id, b]));
    const changed = new Map();
    for (const b of all) {
      if (b.status !== 'open') continue;
      const x = bySide.get(b.sideKey);
      if (Date.parse(b.start) <= t) { closeBid(b); changed.set(b.id, b); continue; }
      if (!x) continue;
      // fairLastAt moves in memory every read; the row is saved when the fair moves, or every 10 minutes
      const moved = x.fair !== b.fairLast || x.alt !== !!b.altLast;
      b.fairLast = x.fair; b.fairLastAt = new Date(t).toISOString(); b.altLast = x.alt;
      if (!b.cancelAt && x.fair / b.cost - 1 < 0) { b.cancelAt = new Date(t).toISOString(); b.fairAtCancel = x.fair; }
      if (moved) { (b.fairs ||= []).push([t, x.fair]); if (b.fairs.length > 400) b.fairs = b.fairs.filter((_, i) => i % 2 === 0); }
      if (moved || t - (b.savedAt || 0) >= 10 * 60e3) { b.savedAt = t; changed.set(b.id, b); }
    }
    for (const x of board) {
      if (x.bid == null || x.alt || have.has(x.sideKey)) continue;
      const mins = (Date.parse(x.start) - t) / 60e3;
      if (!(mins >= WINDOW_MIN[0] && mins <= WINDOW_MIN[1])) continue;
      const b = { id: x.sideKey, kind: KIND, sideKey: x.sideKey, sport: x.sport, event: x.event, start: x.start, market: x.market, side: x.side, point: x.point,
        marketId: x.marketId, buy: x.buy, bid: x.bid, fee: x.fee, cost: x.cost, edgeAtPost: x.edge, makerRate: x.makerRate,
        fairAtPost: x.fair, askAtPost: x.ask, bestBidAtPost: x.bestBid, postedAt: new Date(t).toISOString(), minsBefore: Math.round(mins),
        fairLast: x.fair, fairLastAt: new Date(t).toISOString(), fairs: [[t, x.fair]], status: 'open' };
      have.set(b.id, b); changed.set(b.id, b); state.posted++;
    }
    for (const b of changed.values()) await store.put(b);
    state.scans++; state.lastScan = new Date(t).toISOString();
    return { sides: board.length, posted: changed.size };
  }

  function closeBid(b) {
    b.status = 'closed';
    const age = Date.parse(b.start) - Date.parse(b.fairLastAt || 0);
    if (b.fairLast > 0 && age <= CLOSE_MAX_AGE_MS && !b.altLast) b.closeFair = b.fairLast;
    else { b.closeFair = null; b.closeMissing = true; }
  }

  // closed bids: the fill from Kalshi's trade prints, then the settlement
  async function settle({ limit = 15, minAgeMs = 10 * 60e3 } = {}) {
    await loaded;
    const t = now();
    const due = (await store.all()).filter(b => (b.status === 'closed' && t - Date.parse(b.start) >= minAgeMs) || (b.status === 'filled' && t - Date.parse(b.start) >= 2 * 3600e3 && !(b.resultTries >= 48)))
      .sort((a, b) => Date.parse(a.start) - Date.parse(b.start)).slice(0, limit);
    let n = 0;
    for (const b of due) {
      try {
        if (b.status === 'closed') {
          const from = Date.parse(b.postedAt), to = Math.min(Date.parse(b.cancelAt || b.start), Date.parse(b.start));
          const trades = await readTrades(b.marketId, from, to);
          const f = fillOf(trades, { buy: b.buy, bid: b.bid, from, to });
          b.filled = !!f.through; b.filledAtBid = !f.through && !!f.atBid; b.contractsAtBid = f.contractsAt; b.trades = trades.length;
          const first = f.through || f.atBid;
          if (first) { b.fillAt = new Date(first.t).toISOString(); b.fairAtFill = fairAt(b, first.t); }
          b.status = b.filled || b.filledAtBid ? 'filled' : 'unfilled';
          if (b.status === 'unfilled') delete b.fairs;
        }
        if (b.status === 'filled') {
          const r = await http.get(`${API}/markets/${encodeURIComponent(b.marketId)}`, { timeout: 8000 });
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
      for (const x of page) out.push(tradeRow(x));
      cursor = r?.data?.cursor || null;
      if (!cursor || !page.length) break;
    }
    return out;
  }
  async function list() { await loaded; return store.all(); }
  return { scan, settle, list, state, ready: () => loaded, rateOf };
}
// Pinnacle's fair for a bid at time t from its followed reads
function fairAt(b, t) {
  let v = b.fairAtPost;
  for (const [at, f] of b.fairs || []) { if (at <= t) v = f; else break; }
  return v;
}
// a Kalshi trade (yes_price_dollars or yes_price in cents) → [ms, yesPrice, takerSide, count]
function tradeRow(x) {
  const yp = x.yes_price_dollars != null ? Number(x.yes_price_dollars) : Number(x.yes_price) / 100;
  return [Date.parse(x.created_time), yp, x.taker_side, Number(x.count_fp ?? x.count) || 0];
}

module.exports = { KIND, SPORTS, EDGE, EDGES, MAKER_RATE, LOT, MIN_N, makerRateOf, makerFee, suggestBid, fillOf, grade, summarize, summarizeBy, boardOf, createMakerTracker, tradeRow, fairAt, seriesOf };
