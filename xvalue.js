// ─── EXCHANGE VALUE ───────────────────────────────────────────────────────────
// One-sided +EV on the US exchanges. Polymarket International carries the
// deepest book on most games; Kalshi and Polymarket US often trail it by a few
// cents when news or money moves the line. When the ask on a US venue, fee
// included, is under Polymarket's mid by more than minEv, the ask is a bet
// with an edge, without needing the other side (that's an arb, xarb.js).
//
//   fair  = Polymarket's mid ((best bid + best ask) / 2), only from a book with
//           a spread of maxSpread or less and minLiquidity or more behind it
//   cost  = the US venue's ask + its taker fee per contract (at a 100 lot)
//   EV    = fair / cost − 1, between minEv and maxEv (past maxEv it's nearly
//           always two markets that don't settle the same way)
//
// Pairs: Kalshi to Polymarket are matchMarkets' game, soccer-result and line
// pairs (title matches are left out: their rules can differ). Polymarket US
// to Polymarket share the game's event slug, then the same kind, line and
// team. Only games that haven't started, with the price between 5¢ and 95¢.
//
// Every edge is graded on closing-line value (evtrack.js): the fair at the
// last scan before the start is the close. `fairs` carries every paired side's
// fair, so a flagged bet keeps its close current after its edge is gone.

const { kalshiFee } = require('./exchanges');
const { polymarketFee, nameMatch } = require('./xarb');
const { moveText } = require('./steam');
const { moverText } = require('./movers');

const DEFAULTS = {
  minEv: 0.02,
  maxEv: 0.12,
  maxSpread: 0.03,
  minLiquidity: 2000,
  minPrice: 0.05,
  maxPrice: 0.95,
  minLeadMs: 60e3,       // a game starting within a minute is as good as live
  kalshiFeeRate: 0.07,
  lot: 100,
  // Kalshi as the reference for a Polymarket US side Polymarket can't price
  kalshiMaxSpread: 0.03,
  kalshiMinLiquidity: 500,
  // Kalshi quotes in whole cents, so its mid is only good to half a cent: a
  // Kalshi-priced edge has to clear the fee by a cent too (5.5¢ vs 5.3¢ is +3% and noise)
  kalshiMinEdge: 0.01,
};
const VENUE = { kalshi: 'Kalshi', polymarketus: 'Polymarket US' };
const REF_NAME = { polymarket: 'Polymarket', kalshi: 'Kalshi' };

const r4 = x => Math.round(x * 1e4) / 1e4;
// a league label for the record when the parsers only know the big US ones:
// Kalshi's series ("KXEPLGAME-…" → epl, "KXATPMATCH-…" → atp), Polymarket's
// game slug ("ucl-ars-bay-2026-10-21" → ucl). Only labels Results and Best
// Plays (so a losing league can be cut); matching never sees it.
function leagueTag(r) {
  if (!r) return null;
  if (r.exchange === 'kalshi') {
    const m = String(r.id || r.eventKey || '').match(/KX([A-Z0-9]{2,12}?)(?:GAME|MATCH|FIGHT|TOTAL|SPREAD|SERIES)\b/i);
    return m ? m[1].toLowerCase() : null;
  }
  const m = String(r.gameSlug || r.slug || '').toLowerCase().match(/^([a-z][a-z0-9]{1,7})-[a-z0-9]+-[a-z0-9]+-\d{4}-\d\d-\d\d/);
  return m ? m[1] : null;
}
const ms = t => { const x = Date.parse(t); return Number.isFinite(x) ? x : null; };
const isYes = s => /^yes$/i.test(String(s || '').trim());

function optsFromEnv(env = process.env) {
  const o = {};
  const f = k => { const v = parseFloat(env[k]); return Number.isFinite(v) ? v : null; };
  if (f('XVALUE_MIN_EV') != null) o.minEv = f('XVALUE_MIN_EV');
  if (f('XVALUE_MAX_EV') != null) o.maxEv = f('XVALUE_MAX_EV');
  if (f('XVALUE_MAX_SPREAD') != null) o.maxSpread = f('XVALUE_MAX_SPREAD');
  if (f('XVALUE_MIN_LIQUIDITY') != null) o.minLiquidity = f('XVALUE_MIN_LIQUIDITY');
  if (f('XVALUE_KALSHI_MAX_SPREAD') != null) o.kalshiMaxSpread = f('XVALUE_KALSHI_MAX_SPREAD');
  return o;
}

// Polymarket's fair YES price, or null when its book is too thin or wide.
// o.books (ref market id → tail.parseBook of its YES token) wins over Gamma's
// quote, which can lag the book; with o.requireBook a ref needs one.
function refFair(p, o) {
  if (!p || !p.tradable) return null;
  const book = o.books?.get(String(p.id));
  if (!book && o.requireBook) return null;
  const ask = book ? book.ask : p.yesAsk, bid = book ? book.bid : (p.noAsk == null ? null : 1 - p.noAsk);
  if (ask == null || bid == null) return null;
  const spread = ask - bid;
  if (!(spread >= 0) || spread > o.maxSpread + 1e-9) return null;
  if (p.liquidity != null && p.liquidity < o.minLiquidity) return null;
  return { fair: (ask + bid) / 2, spread, liquidity: p.liquidity ?? null, source: book ? 'book' : 'gamma' };
}

// Kalshi's fair YES price from its own quote (the list API is live, no book
// read needed): only a market 3¢ wide or tighter with money behind it. A Kalshi game is
// as deep as Polymarket's on the US leagues, so where Polymarket has no tight
// book (most NHL and college games) Kalshi's mid prices Polymarket US.
function kalshiFair(k, o) {
  if (!k || !k.tradable || k.yesAsk == null || k.noAsk == null) return null;
  const spread = k.yesAsk + k.noAsk - 1;
  if (!(spread >= 0) || spread > o.kalshiMaxSpread + 1e-9) return null;
  if (k.liquidity != null && k.liquidity < o.kalshiMinLiquidity) return null;
  return { fair: (k.yesAsk + 1 - k.noAsk) / 2, spread, liquidity: k.liquidity ?? null, source: 'kalshi' };
}

// per-contract cost of buying `side` of row t, fee included
function costOf(t, side, o) {
  const price = side === 'yes' ? t.yesAsk : t.noAsk;
  if (price == null || !(price >= o.minPrice && price <= o.maxPrice)) return null;
  const fee = t.exchange === 'kalshi' ? kalshiFee(price, o.lot, o.kalshiFeeRate)
    : t.feeSchedule ? polymarketFee(price, o.lot, t.feeSchedule) : 0;
  return { price, cost: price + fee / o.lot };
}

function pickOf(t, side) {
  const label = t.outcomeLabel && !isYes(t.outcomeLabel) ? t.outcomeLabel : '';
  if (side === 'yes') return label || 'YES';
  return t.noLabel || (label ? `NO ${label}` : 'NO');
}

// Polymarket US labels are bare ("Over", a team): add the line. Kalshi's carry it.
function lineText(t, side) {
  if (t.exchange === 'kalshi' || t.line == null) return '';
  if (t.kind === 'total') return ` ${t.line}`;
  return t.kind === 'spread' ? ` ${side === 'yes' ? '-' : '+'}${t.line}` : '';
}

// Polymarket US rows paired with Polymarket's by event slug, kind, line and team
// → [{ target, ref, same }]
function pairUs(usRows = [], polyRows = []) {
  const bySlug = new Map();
  for (const p of polyRows) if (p.gameSlug && ['teams', 'total', 'spread'].includes(p.kind)) {
    if (!bySlug.has(p.gameSlug)) bySlug.set(p.gameSlug, []);
    bySlug.get(p.gameSlug).push(p);
  }
  const out = [];
  for (const u of usRows) {
    const cands = bySlug.get(u.gameSlug) || [];
    for (const p of cands) {
      if (p.kind !== u.kind) continue;
      if (u.kind === 'teams') {
        if (nameMatch(u.outcomeLabel, p.outcomeLabel) && nameMatch(u.noLabel, p.noLabel)) out.push({ target: u, ref: p, same: true });
        else if (nameMatch(u.outcomeLabel, p.noLabel) && nameMatch(u.noLabel, p.outcomeLabel)) out.push({ target: u, ref: p, same: false });
      } else if (Math.abs(u.line - p.line) < 1e-9) {
        // YES is Over on both; on a spread YES is the team giving the points
        if (u.kind === 'total' || nameMatch(u.lineTeam, p.lineTeam)) out.push({ target: u, ref: p, same: true });
      }
    }
  }
  return out;
}

// { matches (Kalshi ↔ Polymarket), kalshi, usRows, polymarket, usMatches
// (Kalshi ↔ Polymarket US) } → { edges, fairs, quotes, pairs }
// venues: which US venues may be bet ('kalshi', 'polymarketus')
// A Polymarket US side is priced off Polymarket when Polymarket quotes it
// tightly (on Gamma: an unread book doesn't hand it to Kalshi), else off Kalshi.
function findValue({ matches = [], kalshi = [], usRows = [], polymarket = [], usMatches = [] } = {}, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const now = o.now ?? Date.now();
  const venues = new Set(o.venues || ['kalshi', 'polymarketus']);
  const pairs = [];
  if (venues.has('kalshi')) {
    // a Kalshi game is a market per team, and matchMarkets pairs one of them:
    // the other team's market is the same game the other way round
    const teamMkts = new Map();
    for (const k of kalshi) if (k.kind === 'teams') teamMkts.set(`${k.eventKey}|${k.outcomeLabel}`, k);
    for (const m of matches) {
      if (m.by === 'title') continue;
      pairs.push({ target: m.kalshi, ref: m.polymarket, same: m.same });
      const twin = m.by === 'teams' && m.kalshi.noLabel ? teamMkts.get(`${m.kalshi.eventKey}|${m.kalshi.noLabel}`) : null;
      if (twin && twin !== m.kalshi) pairs.push({ target: twin, ref: m.polymarket, same: !m.same });
    }
  }
  if (venues.has('polymarketus')) {
    const us = pairUs(usRows, polymarket);
    pairs.push(...us);
    const gammaOnly = { ...o, books: null, requireBook: false };
    const polyPriced = new Set(us.filter(x => refFair(x.ref, gammaOnly)).map(x => String(x.target.id)));
    for (const m of usMatches) {
      if (m.by === 'title' || !m.polymarket || polyPriced.has(String(m.polymarket.id))) continue;
      pairs.push({ target: m.polymarket, ref: m.kalshi, same: m.same, kalshiRef: true });
    }
  }

  const best = new Map(), fairs = new Map(), quotes = new Map();
  let kalshiPriced = 0;
  for (const { target: t, ref: p, same, kalshiRef } of pairs) {
    if (!t || !t.tradable) continue;
    const start = ms(t.startTime) ?? ms(p.startTime);
    if (start == null || start - now < o.minLeadMs) continue;
    const ref = kalshiRef ? kalshiFair(p, o) : refFair(p, o);
    if (!ref) continue;
    if (kalshiRef) kalshiPriced++;
    const refVenue = kalshiRef ? 'kalshi' : 'polymarket';
    const refToken = kalshiRef ? null : p.tokenIds?.[p.yesIndex ?? 0] ?? null;
    const refId = kalshiRef ? `kalshi:${p.id}` : String(p.id);
    for (const side of ['yes', 'no']) {
      const fair = (side === 'yes') === !!same ? ref.fair : 1 - ref.fair;
      const pick = `${pickOf(t, side)}${lineText(t, side)}`;
      const group = `${t.exchange}|${t.id}`;
      fairs.set(`${group}|${pick}`, fair * 100);
      const c = costOf(t, side, o);
      if (!c) continue;
      const ev = fair / c.cost - 1;
      const id = `${group}|${side}`;
      if (!quotes.has(id) || quotes.get(id).fair / quotes.get(id).cost < fair / c.cost) {
        quotes.set(id, { fair, cost: c.cost, price: c.price, spread: ref.spread, refId, refToken, dir: (side === 'yes') === !!same ? 1 : -1,
          venue: t.exchange, pick, title: t.eventTitle || t.title, league: t.league || p.league || leagueTag(t) || leagueTag(p), category: t.category || p.category || 'sports',
          market: t.kind === 'teams' || t.game3 ? 'moneyline' : t.kind, start: new Date(start).toISOString(), url: t.url || null });
      }
      // a side the reference just moved on (steam.js) is worth a bet at a smaller edge
      const steam = o.steam ? o.steam.steamOf(id, fair, c.cost, now) : null;
      const minEv = steam && o.steamMinEv != null ? Math.min(o.minEv, o.steamMinEv) : o.minEv;
      if (ev < minEv || ev > o.maxEv) continue;
      if (kalshiRef && fair - c.cost < o.kalshiMinEdge - 1e-9) continue;
      const e = {
        id, group, venue: t.exchange, venueName: VENUE[t.exchange] || t.exchange, marketId: t.id, side, pick,
        title: t.eventTitle || t.title, market: t.kind === 'teams' || t.game3 ? 'moneyline' : t.kind,
        league: t.league || p.league || leagueTag(t) || leagueTag(p), category: t.category || p.category || 'sports',
        price: c.price, cost: r4(c.cost), fair: r4(fair), ev: r4(ev),
        refId, refToken, refName: REF_NAME[refVenue],
        ref: { venue: refVenue, mid: r4(ref.fair), spread: r4(ref.spread), liquidity: ref.liquidity, source: ref.source, url: p.url },
        start: new Date(start).toISOString(), url: t.url || null, rules: t.rules || null,
        steam: steam || null,
        ...(t.yesSide ? { yesSide: t.yesSide } : {}),   // Polymarket US: which side of the market's book YES is
      };
      // one bet per contract side
      if (!best.has(e.id) || best.get(e.id).ev < e.ev) best.set(e.id, e);
    }
  }
  const edges = [...best.values()].sort((a, b) => b.ev - a.ev);
  return { edges, fairs, quotes, pairs: pairs.length, kalshiPriced };
}

// The first pass on Gamma's quotes, wide enough that a lagging Gamma price
// doesn't hide an edge the book has: what to read the live book for.
const SCREEN = { minEv: -0.01, maxEv: 0.3, maxSpread: 0.06 };
// edges, plus every paired side's quote (what steam.js keeps a history of)
function screen(input, opts = {}) {
  return findValue(input, { ...opts, ...SCREEN, books: null, requireBook: false, steam: null });
}

// The price screen's fair column (xarb.exchangeScreen rows): each side's fair
// from Polymarket's mid, and the EV of the cheaper venue's all-in price at it.
// Polymarket US rows pair by slug, kind, line and team; a Polymarket row (intl
// mode) is its own ref. Looser than an edge: a wider spread still prices it.
const FAIR_SCREEN = { maxSpread: 0.04 };
function screenFairs(rows = [], { usRows = [], polymarket = [], books = null, usMatches = [] } = {}, opts = {}) {
  const o = { ...DEFAULTS, ...FAIR_SCREEN, ...opts, books, requireBook: false };
  const want = new Set(rows.map(r => String(r.id)));
  const refs = new Map();
  for (const { target, ref, same } of pairUs(usRows.filter(u => want.has(String(u.id))), polymarket)) {
    const f = refFair(ref, o);
    if (f && !refs.has(String(target.id))) refs.set(String(target.id), { fair: f.fair, same });
  }
  for (const p of polymarket) if (want.has(String(p.id)) && !refs.has(String(p.id))) { const f = refFair(p, o); if (f) refs.set(String(p.id), { fair: f.fair, same: true }); }
  // what Polymarket can't price, Kalshi's tight quote does
  for (const m of usMatches) {
    const id = String(m.polymarket?.id);
    if (m.by === 'title' || !want.has(id) || refs.has(id)) continue;
    const f = kalshiFair(m.kalshi, o);
    if (f) refs.set(id, { fair: f.fair, same: m.same, by: 'kalshi' });
  }
  return rows.map(r => {
    const ref = refs.get(String(r.id));
    if (!ref) return { ...r, maxEv: null };
    // side 0 is the screen row's YES, side 1 its NO
    const sides = r.sides.map((x, i) => {
      const fair = (i === 0) === ref.same ? ref.fair : 1 - ref.fair;
      const best = [x.kalshi, x.other].filter(c => c != null);
      const ev = best.length ? fair / Math.min(...best) - 1 : null;
      return { ...x, fair: r4(fair), ev: ev == null ? null : r4(ev) };
    });
    const evs = sides.map(x => x.ev).filter(e => e != null);
    return { ...r, sides, maxEv: evs.length ? Math.max(...evs) : null, ...(ref.by ? { fairBy: ref.by } : {}) };
  });
}

// Which Polymarket books to read this scan, at most `max`: every urgent ref
// (a steaming side: the move needs a fresh price), then the rest by how long
// ago their book was read, never-read first. cache: ref id → { book, at }.
// With a few dozen reads a minute and books kept `ttl`, every candidate gets
// read every few scans instead of only the screen's top few.
function planReads({ urgent = [], rest = [], cache = new Map(), now = Date.now(), max = 30 } = {}) {
  const out = [], seen = new Set();
  for (const id of urgent) if (!seen.has(id) && out.length < max) { seen.add(id); out.push(id); }
  const age = id => { const c = cache.get(id); return c ? now - c.at : Infinity; };
  const queue = rest.filter(id => !seen.has(id) && (seen.add(id), true)).map((id, i) => ({ id, i, age: age(id) }))
    .sort((a, b) => b.age - a.age || a.i - b.i);
  for (const q of queue) if (out.length < max) out.push(q.id);
  return out;
}

// A Kalshi game is two team markets, so one outcome can be YES on one and NO
// on the other: the same bet at the same fair. Keep its cheaper market.
function dedupeEdges(edges) {
  const best = new Map();
  for (const e of edges) {
    const k = `${e.venue}|${e.refId}|${e.fair}|${e.start}`;
    if (!best.has(k) || best.get(k).ev < e.ev) best.set(k, e);
  }
  return edges.filter(e => best.get(`${e.venue}|${e.refId}|${e.fair}|${e.start}`) === e);
}

// edges → evtrack rows (ev and fair in percent)
function trackRows(edges) {
  return edges.map(e => ({
    group: e.group, side: e.pick, book: e.venue, start: e.start, sport: e.league || e.category, event: e.title,
    market: e.market, price: e.cost, decimal: 1 / e.cost, ev: e.ev * 100, fairProb: e.fair * 100,
    source: e.mover ? 'mover' : e.steam ? 'steam' : e.ref?.venue === 'kalshi' ? 'kalshiref' : 'xvalue',
    depthUsd: e.depth?.usd ?? null,
  }));
}

// every paired side's cost now (group|pick → cost with fee): what a tracked
// bet's execPrice is read from a couple of minutes after its flag
function costsOf(quotes = new Map()) {
  const out = new Map();
  for (const [id, q] of quotes) if (q.pick && q.cost > 0) out.set(`${id.slice(0, id.lastIndexOf('|'))}|${q.pick}`, q.cost);
  return out;
}

// "NBA · Lakers at Celtics: Celtics on Kalshi at 52¢ (53.1¢ with fee), Polymarket 56¢ (+5.5%) <link>"
function describe(e) {
  const when = e.start ? new Date(e.start).toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: '2-digit' }) + ' ET' : '';
  const c = x => `${Math.round(x * 1000) / 10}¢`;
  const ref = e.refName || 'Polymarket';
  const steam = e.steam ? `STEAM: ${moveText(e.steam, e.venueName, ref)}. ` : e.mover ? `LINE MOVER: ${moverText(e.mover)}. ` : '';
  return `${steam}${(e.league || e.category || '').toUpperCase()} · ${e.title}${when ? ` (${when})` : ''}: ${e.pick} on ${e.venueName} at ${c(e.price)} (${c(e.cost)} with fee), ${ref} ${c(e.fair)} (${e.ev >= 0 ? '+' : ''}${Math.round(e.ev * 1000) / 10}%)${e.depth ? `, $${e.depth.usd.toLocaleString('en-US')} on the book at that price` : ''}${e.url ? ` ${e.url}` : ''}`;
}

module.exports = { costsOf, leagueTag, planReads, dedupeEdges, findValue, screen, SCREEN, screenFairs, pairUs, refFair, trackRows, describe, optsFromEnv, DEFAULTS };
