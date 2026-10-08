// ─── WHALE FLOW ───────────────────────────────────────────────────────────────
// Big money moving on the exchanges, as it happens.
//
// Kalshi trades are anonymous, so Kalshi gives FLOW: which side the big orders
// are hitting, not who placed them. Each trade row is one fill: `count`
// contracts, the YES and NO prices (integer cents in older responses,
// "0.5600" `_dollars` strings in newer ones; the dollar field wins) and
// `taker_side`, the side the aggressive order bought. The money behind a fill
// is what the taker paid:
//
//   notional = count × price of the taker side          (dollars)
//
// A $20k order usually sweeps several resting orders and comes back as several
// fills with the same ticker, taker side and created_time (to the microsecond),
// so those are summed into one "print" first (its price is their average).
// Times sent to the whole second can't tell one sweep from many takers hitting
// a busy market in the same second, so those fills stay one print each. A print of
// WHALE_MIN_USD ($5,000) or more is a whale event. Polls overlap a little so
// late trades aren't missed, and trade_id keeps a fill from counting twice.
//
// Polymarket trades settle on-chain, so every big trade has a wallet. Fills of
// one order share a transaction hash and are summed the same way. Each whale
// is tagged with the wallet's grade from a lookup the caller passes in
// (tail.js scores wallets): "graded whale" when the wallet is a graded sharp,
// "unknown whale" otherwise.
//
// Per market over a rolling hour: whale dollars on YES vs NO and the net, all
// the taker flow seen, the largest print, and the YES price before the first
// whale print and the latest one. On Polymarket "YES" means the market's first
// outcome: buying outcome 0 or selling outcome 1 is YES money.
//
// Prices are dollars per contract (0–1), money is dollars, times on returned
// objects are ISO strings. Parsers and the aggregation are pure; the fetchers
// take an axios-style `http`, and createWhaleWatcher keeps the rolling state
// (seen trade ids, recent prints, the whale feed) so a cron can drive it.

const KALSHI_TRADES_URL = 'https://api.elections.kalshi.com/trade-api/v2/markets/trades';
const POLYMARKET_TRADES_URL = 'https://data-api.polymarket.com/trades';
const HOUR = 3600e3;
const TIMEOUT = 10000;
const EPS = 1e-6;   // $5,000.00 computed as 4999.9999999 is still a whale

const DEFAULTS = {
  minUsd: 5000,                // a print this big is a whale (WHALE_MIN_USD)
  windowMs: HOUR,              // rolling flow window
  groupFills: true,            // sum the Kalshi fills of one sweep into one print
  kalshiLimit: 1000,           // trades per page (Kalshi's max)
  kalshiMaxPages: 10,          // page cap per poll
  kalshiOverlapMs: 60e3,       // each poll re-reads this far behind the newest trade seen
  polymarketLimit: 500,
  polymarketMaxPages: 1,
  polymarketMinCash: 500,      // server-side size filter on the Polymarket read; whales are the ≥ minUsd ones
  maxNewAgeMs: 10 * 60e3,      // a whale older than this when first seen goes in the feed but isn't "new"
  seenTtlMs: null,             // dedup memory, default window + overlap + 5 min; trades older than this are ignored outright
  maxEvents: 500,              // whale feed size
  maxPrints: 200000,           // memory cap on stored prints
};

function resolveOptions(opts = {}) {
  const o = { ...DEFAULTS };
  for (const [k, v] of Object.entries(opts || {})) if (v !== undefined && v !== null) o[k] = v;
  // forgetting a trade id before the overlap re-reads it would count it twice;
  // remembering every fill much longer than the flow window just costs memory
  o.seenTtlMs = o.seenTtlMs == null ? o.windowMs + o.kalshiOverlapMs + 5 * 60e3 : Math.max(o.seenTtlMs, o.windowMs + o.kalshiOverlapMs);
  return o;
}

function optionsFromEnv(env = process.env) {
  const f = k => (env[k] == null || String(env[k]).trim() === '' || !Number.isFinite(Number(env[k])) ? undefined : Number(env[k]));
  const out = {};
  const minUsd = f('WHALE_MIN_USD');
  if (minUsd > 0) out.minUsd = minUsd;
  return out;
}

// ── small helpers ──
const num = v => (v == null || v === '' || typeof v === 'boolean' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const round = (x, n) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** n) / 10 ** n);
const r2 = x => round(x, 2);
const lower = v => (v == null ? '' : String(v).trim().toLowerCase());
const iso = ms => (ms == null || !Number.isFinite(ms) ? null : new Date(ms).toISOString());
const sum = xs => xs.reduce((a, b) => a + b, 0);
const isWhale = (p, minUsd) => p.notional >= minUsd - EPS;
// arrays come bare or wrapped, depending on the endpoint and its age
function rowsOf(payload, keys = ['trades', 'data']) {
  if (Array.isArray(payload)) return payload;
  for (const k of keys) if (Array.isArray(payload?.[k])) return payload[k];
  return [];
}
// unix seconds, unix ms or an ISO string → ms
function toMs(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (Number.isFinite(n)) return n <= 0 ? null : n > 1e12 ? n : n * 1000;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}
const errText = e => e?.message || String(e);

// ── Kalshi ──
// "0.5600" dollars wins over 56 cents.
function kalshiPrice(t, field) {
  const d = num(t[`${field}_dollars`]);
  if (d != null) return d;
  const c = num(t[field]);
  return c == null ? null : c / 100;
}

// "KXNBAGAME-26OCT08NYKBOS-BOS" → "KXNBAGAME-26OCT08NYKBOS": a market ticker
// is its event ticker plus one more segment.
function kalshiEventTicker(ticker) {
  const parts = String(ticker || '').split('-');
  return parts.length >= 3 ? parts.slice(0, -1).join('-') : String(ticker || '');
}

// info: (ticker) => { title, eventTicker?, url? } | 'title' | null, or a Map /
// object keyed by ticker (e.g. built from xarb's Kalshi events scan).
function kalshiMeta(ticker, info = null) {
  let m = null;
  try {
    if (typeof info === 'function') m = info(ticker);
    else if (info instanceof Map) m = info.get(ticker);
    else if (info && typeof info === 'object') m = info[ticker];
  } catch { m = null; }
  if (typeof m === 'string') m = { title: m };
  const eventTicker = String(m?.eventTicker || m?.event_ticker || kalshiEventTicker(ticker));
  return { title: m?.title || ticker, eventTicker, url: m?.url || `https://kalshi.com/markets/${eventTicker.toLowerCase()}` };
}

// One row per fill, deduped by trade_id. → { id, ticker, side, price (taker
// side), yesPrice, contracts, notional, at (ms), time (as sent, for grouping) }
function parseKalshiTrades(payload) {
  const out = [], ids = new Set();
  for (const t of rowsOf(payload, ['trades', 'data'])) {
    if (!t || typeof t !== 'object') continue;
    const side = lower(t.taker_side ?? t.takerSide);
    if (side !== 'yes' && side !== 'no') continue;
    let yes = kalshiPrice(t, 'yes_price'), no = kalshiPrice(t, 'no_price');
    if (yes == null && no != null) yes = 1 - no;
    if (no == null && yes != null) no = 1 - yes;
    const price = side === 'yes' ? yes : no;
    const contracts = num(t.count_fp) ?? num(t.count);
    const ticker = t.ticker ?? t.market_ticker;
    if (!ticker || !(price > 0 && price < 1) || !(contracts > 0)) continue;
    const time = t.created_time ?? t.createdTime ?? t.ts ?? null;
    const at = toMs(time);
    const id = String(t.trade_id ?? t.tradeId ?? t.id ?? `${ticker}|${side}|${time}|${contracts}|${price}`);
    if (ids.has(id)) continue;
    ids.add(id);
    out.push({
      id, ticker: String(ticker), side, price: round(price, 6), yesPrice: round(yes, 6), contracts,
      notional: contracts * price, at, time: time == null ? null : String(time),
    });
  }
  return out;
}

// Fills of one sweep share ticker, taker side and created_time to the
// microsecond. A time with no fraction of a second (or no time) is too coarse
// to group on, so that fill stands alone.
const SUB_SECOND = /\.\d*[1-9]/;
const kalshiPrintKey = (f, groupFills = true) =>
  (groupFills && f.time != null && SUB_SECOND.test(f.time) ? `kalshi|${f.ticker}|${f.side}|${f.time}` : `kalshi|${f.ticker}|${f.side}|id:${f.id}`);

// ids: false skips copying the trade ids (the watcher keeps them only for whales)
function kalshiPrintOf(key, fills, { ids = true } = {}) {
  const f0 = fills[0], up = f0.side === 'yes';
  const contracts = sum(fills.map(f => f.contracts)), notional = sum(fills.map(f => f.notional));
  const price = notional / contracts;
  const ys = fills.map(f => f.yesPrice);
  const ats = fills.map(f => f.at).filter(a => a != null);
  return {
    key, exchange: 'kalshi', market: f0.ticker, ticker: f0.ticker, side: f0.side, dir: f0.side,
    contracts, notional, price, yesPrice: up ? price : 1 - price,
    // a YES sweep walks the price up, a NO sweep walks it down
    yesStart: up ? Math.min(...ys) : Math.max(...ys), yesEnd: up ? Math.max(...ys) : Math.min(...ys),
    at: ats.length ? Math.min(...ats) : null, nFills: fills.length, ...(ids ? { tradeIds: fills.map(f => f.id) } : {}),
  };
}

// parsed fills → prints, in first-seen order
function kalshiPrints(fills, { groupFills = DEFAULTS.groupFills } = {}) {
  const groups = new Map();
  for (const f of fills || []) {
    const key = kalshiPrintKey(f, groupFills);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(f);
  }
  return [...groups].map(([key, list]) => kalshiPrintOf(key, list));
}

function kalshiWhaleEvent(print, { kalshiInfo = null } = {}) {
  const meta = kalshiMeta(print.ticker, kalshiInfo);
  return {
    id: print.key, exchange: 'kalshi', ticker: print.ticker, eventTicker: meta.eventTicker, title: meta.title,
    side: print.side, price: round(print.price, 4), yesPrice: round(print.yesPrice, 4),
    contracts: round(print.contracts, 2), notional: r2(print.notional), fills: print.nFills ?? print.tradeIds?.length ?? 1, tradeIds: [...(print.tradeIds || [])],
    at: iso(print.at), url: meta.url,
  };
}

// parsed fills → whale events (prints ≥ minUsd), oldest first
function kalshiWhales(fills, { minUsd = DEFAULTS.minUsd, groupFills = DEFAULTS.groupFills, kalshiInfo = null } = {}) {
  return kalshiPrints(fills, { groupFills }).filter(p => isWhale(p, minUsd))
    .sort((a, b) => (a.at ?? 0) - (b.at ?? 0)).map(p => kalshiWhaleEvent(p, { kalshiInfo }));
}

// ── Polymarket ──
function outcomeIndexOf(r) {
  const i = num(r.outcomeIndex);
  if (i === 0 || i === 1) return i;
  const label = lower(r.outcome);
  return label === 'yes' ? 0 : label === 'no' ? 1 : i;
}

// Data-API trades → one row per order (fills with the same transaction, token,
// wallet and side are summed, price averaged). `dir` is 'yes' when the money
// backs the first outcome, `yesPrice` is the first outcome's price.
function parsePolymarketTrades(payload) {
  const byKey = new Map();
  for (const r of rowsOf(payload, ['data', 'trades'])) {
    if (!r || typeof r !== 'object') continue;
    const wallet = lower(r.proxyWallet ?? r.wallet ?? r.user);
    const side = String(r.side || '').trim().toUpperCase();
    const size = num(r.size), price = num(r.price);
    const asset = r.asset != null && r.asset !== '' ? String(r.asset) : null;
    if (!wallet || !asset || (side !== 'BUY' && side !== 'SELL') || !(size > 0) || !(price > 0 && price < 1)) continue;
    const at = toMs(r.timestamp ?? r.at);
    const txHash = r.transactionHash || r.txHash || null;
    const key = `polymarket|${txHash ? `${txHash}:${asset}:${wallet}:${side}` : `${wallet}:${asset}:${at}:${side}:${size}:${price}`}`;
    const prev = byKey.get(key);
    if (prev) {
      prev.contracts += size;
      prev.notional += size * price;
      prev.price = prev.notional / prev.contracts;
      prev.fills++;
      continue;
    }
    const idx = outcomeIndexOf(r);
    byKey.set(key, {
      key, exchange: 'polymarket', market: r.conditionId || asset, wallet, name: r.name || r.pseudonym || null,
      side, asset, conditionId: r.conditionId || null, outcome: r.outcome ?? null, outcomeIndex: idx,
      price, contracts: size, notional: size * price, at, fills: 1,
      title: r.title || '', slug: r.slug || '', eventSlug: r.eventSlug || '', txHash,
    });
  }
  return [...byKey.values()].map(t => {
    const idx = t.outcomeIndex;
    const first = idx === 0 ? true : idx === 1 ? false : null;
    t.dir = first == null ? null : (t.side === 'BUY') === first ? 'yes' : 'no';
    t.yesPrice = first == null ? null : first ? t.price : 1 - t.price;
    return t;
  });
}

// The grade lookup may answer 'A' / 'B', a scored trader ({ grade, name, ... }),
// { grade: null } for a wallet that was scored and isn't tailable, or nothing.
function gradeInfo(v) {
  if (v == null || v === false || typeof v.then === 'function') return { grade: null, known: false, name: null };
  const g = typeof v === 'string' ? v : typeof v === 'object' ? v.grade : null;
  const grade = g == null ? null : String(g).trim().toUpperCase();
  return { grade: /^[A-Z]$/.test(grade || '') ? grade : null, known: true, name: typeof v === 'object' ? v.name || null : null };
}

function safeLookup(gradeOf, trade) {
  if (typeof gradeOf !== 'function') return null;
  try { return gradeOf(trade.wallet, trade); } catch { return null; }
}

function polymarketWhaleEvent(trade, lookup = null) {
  const g = gradeInfo(lookup);
  const slug = trade.eventSlug || trade.slug || null;
  return {
    id: trade.key, exchange: 'polymarket', wallet: trade.wallet, name: trade.name || g.name || null,
    grade: g.grade, graded: !!g.grade, known: g.known, tag: g.grade ? 'graded whale' : 'unknown whale',
    side: trade.side, outcome: trade.outcome, outcomeIndex: trade.outcomeIndex,
    price: round(trade.price, 4), yesPrice: round(trade.yesPrice, 4), contracts: round(trade.contracts, 2), notional: r2(trade.notional),
    fills: trade.fills ?? 1, at: iso(trade.at), title: trade.title || '', slug: trade.slug || '', eventSlug: trade.eventSlug || '',
    conditionId: trade.conditionId, asset: trade.asset, txHash: trade.txHash || null,
    url: slug ? `https://polymarket.com/event/${slug}` : null,
  };
}

// parsed trades → whale events, oldest first. gradeOf(wallet, trade) must be
// synchronous here; the watcher also accepts an async one.
function polymarketWhales(trades, { minUsd = DEFAULTS.minUsd, gradeOf = null } = {}) {
  return (trades || []).filter(t => isWhale(t, minUsd)).sort((a, b) => (a.at ?? 0) - (b.at ?? 0))
    .map(t => polymarketWhaleEvent(t, safeLookup(gradeOf, t)));
}

// ── flow ──
// prints: kalshiPrints(...) and/or parsePolymarketTrades(...) rows (anything
// with exchange, market, dir, notional, at and a YES price). Per market with at
// least one whale print in [now − windowMs, now]: whale dollars by side, all
// flow by side, the largest print, and the YES price just before the first
// whale print (that print's own starting price when nothing came before) and
// after the latest print. Biggest whale money first.
function aggregateFlow(prints, { now = Date.now(), windowMs = DEFAULTS.windowMs, minUsd = DEFAULTS.minUsd, exchange = null, limit = Infinity, gradeOf = null, kalshiInfo = null } = {}) {
  const start = now - windowMs;
  const byMarket = new Map();
  for (const p of prints || []) {
    if (!p?.market || (p.dir !== 'yes' && p.dir !== 'no') || p.at == null || !(p.notional > 0)) continue;
    if (exchange && p.exchange !== exchange) continue;
    const k = `${p.exchange}|${p.market}`;
    if (!byMarket.has(k)) byMarket.set(k, []);
    byMarket.get(k).push(p);
  }
  const yesStart = p => p.yesStart ?? p.yesPrice ?? null, yesEnd = p => p.yesEnd ?? p.yesPrice ?? null;
  const usd = (list, dir) => r2(sum(list.filter(p => p.dir === dir).map(p => p.notional)));
  const rows = [];
  for (const list of byMarket.values()) {
    list.sort((a, b) => a.at - b.at);   // stable: ties keep arrival order
    const inWindow = list.filter(p => p.at >= start);
    const whales = inWindow.filter(p => isWhale(p, minUsd));
    if (!whales.length) continue;
    const first = whales[0], last = whales[whales.length - 1], latest = list[list.length - 1];
    const before = list[list.indexOf(first) - 1];
    const big = whales.reduce((a, b) => (b.notional > a.notional ? b : a));
    const pm = first.exchange === 'polymarket';
    const outcomes = pm ? [null, null] : ['Yes', 'No'];
    if (pm) for (const p of list) if (p.outcome != null && (p.outcomeIndex === 0 || p.outcomeIndex === 1)) outcomes[p.outcomeIndex] = String(p.outcome);
    const titled = [...list].reverse().find(p => p.title);
    const meta = pm ? null : kalshiMeta(first.market, kalshiInfo);
    const slug = pm ? (titled?.eventSlug || titled?.slug || first.eventSlug || first.slug || null) : null;
    const yesUsd = usd(whales, 'yes'), noUsd = usd(whales, 'no'), netUsd = r2(yesUsd - noUsd);
    const priceBefore = before ? yesEnd(before) : yesStart(first), priceAfter = yesEnd(latest);
    const lean = netUsd > 0 ? 'yes' : netUsd < 0 ? 'no' : null;
    rows.push({
      exchange: first.exchange, market: first.market, title: pm ? titled?.title || first.market : meta.title,
      url: pm ? (slug ? `https://polymarket.com/event/${slug}` : null) : meta.url, outcomes,
      whalePrints: whales.length, whaleUsd: r2(yesUsd + noUsd), yesUsd, noUsd, netUsd, lean,
      leanOutcome: lean ? outcomes[lean === 'yes' ? 0 : 1] : null,
      prints: inWindow.length, flowYesUsd: usd(inWindow, 'yes'), flowNoUsd: usd(inWindow, 'no'),
      flowNetUsd: r2(usd(inWindow, 'yes') - usd(inWindow, 'no')),
      largest: big.event || (pm ? polymarketWhaleEvent(big, safeLookup(gradeOf, big)) : kalshiWhaleEvent(big, { kalshiInfo })),
      priceBefore: round(priceBefore, 4), priceAfter: round(priceAfter, 4),
      priceMove: priceBefore != null && priceAfter != null ? round(priceAfter - priceBefore, 4) : null,
      firstWhaleAt: iso(first.at), lastWhaleAt: iso(last.at), windowStart: iso(start), windowEnd: iso(now),
    });
  }
  rows.sort((a, b) => (b.whaleUsd - a.whaleUsd) || (Math.abs(b.netUsd) - Math.abs(a.netUsd)));
  return rows.slice(0, limit);
}

// ── fetching ──
// Newest first. Follows Kalshi's cursor until it runs out, a page comes back
// empty, or maxPages; a failed page keeps what came before. sinceMs → min_ts
// (unix seconds). → { trades (parsed fills), pages, truncated, errors }
async function fetchKalshiTrades(http, { sinceMs = null, ticker = null, limit = DEFAULTS.kalshiLimit, maxPages = DEFAULTS.kalshiMaxPages } = {}) {
  const raw = [], errors = [];
  let cursor = null, pages = 0;
  try {
    while (pages < maxPages) {
      const params = { limit };
      if (ticker) params.ticker = ticker;
      if (sinceMs != null) params.min_ts = Math.floor(sinceMs / 1000);
      if (cursor) params.cursor = cursor;
      const res = await http.get(KALSHI_TRADES_URL, { params, timeout: TIMEOUT });
      const page = rowsOf(res?.data, ['trades']);
      raw.push(...page);
      pages++;
      cursor = res?.data?.cursor || null;
      if (!cursor || !page.length) { cursor = null; break; }
    }
  } catch (e) { errors.push({ exchange: 'kalshi', key: `trades page ${pages + 1}`, message: errText(e) }); }
  return { trades: parseKalshiTrades(raw), pages, truncated: !!cursor || errors.length > 0, errors };
}

// Recent large taker trades, newest first; offset paging up to maxPages.
// → { trades (parsed, fills merged), pages, errors }
async function fetchPolymarketTrades(http, { limit = DEFAULTS.polymarketLimit, minCash = DEFAULTS.polymarketMinCash, maxPages = DEFAULTS.polymarketMaxPages } = {}) {
  const raw = [], errors = [];
  let pages = 0;
  try {
    while (pages < maxPages) {
      const params = { limit, takerOnly: true, filterType: 'CASH', filterAmount: minCash };
      if (pages) params.offset = pages * limit;
      const res = await http.get(POLYMARKET_TRADES_URL, { params, timeout: TIMEOUT });
      const page = rowsOf(res?.data, ['data', 'trades']);
      raw.push(...page);
      pages++;
      if (page.length < limit) break;
    }
  } catch (e) { errors.push({ exchange: 'polymarket', key: `trades page ${pages + 1}`, message: errText(e) }); }
  return { trades: parsePolymarketTrades(raw), pages, errors };
}

// ── watcher ──
// gradeOf(wallet, trade) → grade (sync or async), e.g. from tail.js:
//   (w, t) => tail.gradeFor(engine.trader(w), tail.classify(t)).grade
// kalshiInfo: see kalshiMeta. poll() every ~30 s; events() and flow() read.
function createWhaleWatcher({ http, now = () => Date.now(), opts = {}, gradeOf = null, kalshiInfo = null, log = console } = {}) {
  const o = resolveOptions(opts);
  const prints = new Map();        // key → print, both exchanges (flow)
  const kalshiSeen = new Map();    // trade_id → at
  const kalshiFills = new Map();   // print key → fills, so a late fill joins its sweep
  const pmSeen = new Map();        // trade key → { at, notional }
  const emitted = new Map();       // print key → whale event
  let feed = [];                   // whale events, newest first
  let kalshiMark = null;           // newest Kalshi trade time seen (ms)
  let version = 0;                 // bumped whenever prints change (flow cache)
  const busy = { kalshi: false, polymarket: false };
  const health = { lastKalshiPollAt: null, lastPolymarketPollAt: null, lastWhaleAt: null, kalshiPages: 0, kalshiTruncated: false, errors: [] };
  // the log gets the whole message; state() (public) gets it without wallets
  const warn = msg => { health.errors.push({ at: iso(now()), message: String(msg).replace(/0x[0-9a-f]{8,}/gi, '0x…') }); health.errors = health.errors.slice(-20); log?.warn?.(`Whales: ${msg}`); };

  // a new whale goes in the feed; it's "new" (returned) only if recent
  function emit(ev, at, t, fresh) {
    feed.push(ev);
    feed.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
    if (feed.length > o.maxEvents) feed = feed.slice(0, o.maxEvents);
    if (t - at <= o.maxNewAgeMs) { fresh.push(ev); health.lastWhaleAt = iso(t); }
  }

  // parsed Kalshi fills → new whale events, oldest first
  function ingestKalshi(fills, t = now()) {
    const horizon = t - o.seenTtlMs;
    const touched = new Set();
    for (const raw of fills || []) {
      if (kalshiSeen.has(raw.id)) continue;
      const f = raw.at == null ? { ...raw, at: t } : raw;
      if (f.at < horizon) continue;   // older than our memory: it may have been counted already
      kalshiSeen.set(f.id, f.at);
      const key = kalshiPrintKey(f, o.groupFills);
      if (!kalshiFills.has(key)) kalshiFills.set(key, []);
      kalshiFills.get(key).push(f);
      touched.add(key);
      if (kalshiMark == null || f.at > kalshiMark) kalshiMark = f.at;
    }
    const fresh = [];
    if (touched.size) version++;
    for (const key of touched) {
      const fills = kalshiFills.get(key);
      const p = kalshiPrintOf(key, fills, { ids: false });
      const prev = prints.get(key);
      if (prev?.event) p.event = prev.event;
      prints.delete(key);   // re-insert so Map order stays ≈ arrival order
      prints.set(key, p);
      if (!isWhale(p, o.minUsd)) continue;
      p.tradeIds = fills.map(f => f.id);
      const ev = kalshiWhaleEvent(p, { kalshiInfo });
      if (p.event) { Object.assign(p.event, ev); continue; }   // a sweep that grew: same event, bigger
      p.event = ev;
      emitted.set(key, ev);
      emit(ev, p.at, t, fresh);
    }
    return fresh.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  }

  // parsed Polymarket trades → new whale events, oldest first
  async function ingestPolymarket(trades, t = now()) {
    const horizon = t - o.seenTtlMs;
    const fresh = [];
    for (const raw of [...(trades || [])].sort((a, b) => (a.at ?? 0) - (b.at ?? 0))) {
      const tr = raw.at == null ? { ...raw, at: t } : raw;
      if (tr.at < horizon) continue;
      const seen = pmSeen.get(tr.key);
      // a re-read can only add fills to an order; anything else is a repeat
      if (seen && !(tr.notional > seen.notional + EPS)) continue;
      pmSeen.set(tr.key, { at: tr.at, notional: tr.notional });
      version++;
      const p = { ...tr };
      const known = emitted.get(tr.key);
      if (known) p.event = known;
      prints.delete(tr.key);
      prints.set(tr.key, p);
      if (!isWhale(p, o.minUsd)) continue;
      if (known) {   // grew: refresh the numbers, keep the grade it was tagged with
        const { grade, graded, known: k, tag, name } = known;
        Object.assign(known, polymarketWhaleEvent(p), { grade, graded, known: k, tag, name: p.name || name });
        continue;
      }
      let lookup = null;
      if (typeof gradeOf === 'function') {
        try { lookup = await gradeOf(p.wallet, p); } catch (e) { warn(`grade lookup ${p.wallet}: ${errText(e)}`); }
      }
      const ev = polymarketWhaleEvent(p, lookup);
      p.event = ev;
      emitted.set(tr.key, ev);
      emit(ev, p.at, t, fresh);
    }
    return fresh.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  }

  function prune(t) {
    version++;
    const horizon = t - o.seenTtlMs;
    for (const [id, at] of kalshiSeen) if (at < horizon) kalshiSeen.delete(id);
    for (const [k, v] of pmSeen) if (v.at < horizon) pmSeen.delete(k);
    for (const [k, p] of prints) {
      if (p.at >= horizon) continue;
      prints.delete(k);
      kalshiFills.delete(k);
      emitted.delete(k);
    }
    // memory cap: drop the oldest-arrived prints (their ids stay in the seen maps)
    for (const k of prints.keys()) {
      if (prints.size <= o.maxPrints) break;
      prints.delete(k);
      kalshiFills.delete(k);
      emitted.delete(k);
    }
  }

  async function pollKalshi() {
    if (busy.kalshi) return [];
    busy.kalshi = true;
    try {
      const t = now();
      const since = Math.max(kalshiMark != null ? Math.min(kalshiMark, t) - o.kalshiOverlapMs : t - o.windowMs, t - o.seenTtlMs);
      const r = await fetchKalshiTrades(http, { sinceMs: since, limit: o.kalshiLimit, maxPages: o.kalshiMaxPages });
      for (const e of r.errors) warn(`kalshi ${e.key}: ${e.message}`);
      health.kalshiPages = r.pages;
      health.kalshiTruncated = r.truncated;
      const out = ingestKalshi(r.trades, t);
      prune(t);
      health.lastKalshiPollAt = iso(t);
      return out;
    } finally { busy.kalshi = false; }
  }

  async function pollPolymarket() {
    if (busy.polymarket) return [];
    busy.polymarket = true;
    try {
      const t = now();
      const r = await fetchPolymarketTrades(http, { limit: o.polymarketLimit, minCash: Math.min(o.polymarketMinCash, o.minUsd), maxPages: o.polymarketMaxPages });
      for (const e of r.errors) warn(`polymarket ${e.key}: ${e.message}`);
      const out = await ingestPolymarket(r.trades, t);
      prune(t);
      health.lastPolymarketPollAt = iso(t);
      return out;
    } finally { busy.polymarket = false; }
  }

  // both exchanges; one failing doesn't stop the other → new whales, oldest first
  async function poll() {
    const [k, p] = await Promise.all([
      pollKalshi().catch(e => { warn(`kalshi: ${errText(e)}`); return []; }),
      pollPolymarket().catch(e => { warn(`polymarket: ${errText(e)}`); return []; }),
    ]);
    return [...k, ...p].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  }

  // newest first. graded: true = graded whales only, false = unknown only
  function events({ limit = 100, exchange = null, graded = null, minUsd = null, since = null, market = null } = {}) {
    const cut = since == null ? null : toMs(since);
    return feed.filter(e => (!exchange || e.exchange === exchange)
      && (graded == null || (e.exchange === 'polymarket' && e.graded === !!graded))
      && (minUsd == null || e.notional >= minUsd - EPS)
      && (cut == null || Date.parse(e.at) >= cut)
      && (!market || e.ticker === market || e.conditionId === market)).slice(0, limit);
  }

  // cached until the next poll changes the prints (every page view would
  // otherwise regroup every stored print), and for at most 15 s
  let flowCache = null;
  function flow({ exchange = null, windowMs = o.windowMs, minUsd = o.minUsd, limit = 50 } = {}) {
    const t = now(), key = JSON.stringify([exchange, windowMs, minUsd, limit]);
    if (flowCache && flowCache.version === version && flowCache.key === key && t - flowCache.at < 15e3) return flowCache.rows;
    const rows = aggregateFlow([...prints.values()], { now: t, windowMs, minUsd, exchange, limit, kalshiInfo });
    flowCache = { version, key, at: t, rows };
    return rows;
  }

  function state() {
    const t = now(), start = t - o.windowMs;
    const recent = feed.filter(e => Date.parse(e.at) >= start);
    return {
      minUsd: o.minUsd, windowMs: o.windowMs, events: feed.length, prints: prints.size,
      lastHour: { whales: recent.length, usd: r2(sum(recent.map(e => e.notional))), graded: recent.filter(e => e.graded).length },
      seen: { kalshi: kalshiSeen.size, polymarket: pmSeen.size }, kalshiMark: iso(kalshiMark),
      ...health, errors: health.errors.slice(-5),
    };
  }

  return { poll, pollKalshi, pollPolymarket, ingestKalshi, ingestPolymarket, events, flow, state, settings: () => o };
}

module.exports = {
  DEFAULTS, KALSHI_TRADES_URL, POLYMARKET_TRADES_URL, resolveOptions, optionsFromEnv,
  parseKalshiTrades, kalshiPrints, kalshiWhaleEvent, kalshiWhales, kalshiEventTicker,
  parsePolymarketTrades, gradeInfo, polymarketWhaleEvent, polymarketWhales,
  aggregateFlow, fetchKalshiTrades, fetchPolymarketTrades, createWhaleWatcher, toMs,
};
