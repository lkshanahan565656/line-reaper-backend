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
};
const VENUE = { kalshi: 'Kalshi', polymarketus: 'Polymarket US' };

const r4 = x => Math.round(x * 1e4) / 1e4;
const ms = t => { const x = Date.parse(t); return Number.isFinite(x) ? x : null; };
const isYes = s => /^yes$/i.test(String(s || '').trim());

function optsFromEnv(env = process.env) {
  const o = {};
  const f = k => { const v = parseFloat(env[k]); return Number.isFinite(v) ? v : null; };
  if (f('XVALUE_MIN_EV') != null) o.minEv = f('XVALUE_MIN_EV');
  if (f('XVALUE_MAX_EV') != null) o.maxEv = f('XVALUE_MAX_EV');
  if (f('XVALUE_MAX_SPREAD') != null) o.maxSpread = f('XVALUE_MAX_SPREAD');
  if (f('XVALUE_MIN_LIQUIDITY') != null) o.minLiquidity = f('XVALUE_MIN_LIQUIDITY');
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

// { matches (Kalshi ↔ Polymarket), kalshi, usRows, polymarket } → { edges, fairs, pairs }
// venues: which US venues may be bet ('kalshi', 'polymarketus')
function findValue({ matches = [], kalshi = [], usRows = [], polymarket = [] } = {}, opts = {}) {
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
  if (venues.has('polymarketus')) pairs.push(...pairUs(usRows, polymarket));

  const best = new Map(), fairs = new Map();
  for (const { target: t, ref: p, same } of pairs) {
    if (!t || !t.tradable) continue;
    const start = ms(t.startTime) ?? ms(p.startTime);
    if (start == null || start - now < o.minLeadMs) continue;
    const ref = refFair(p, o);
    if (!ref) continue;
    for (const side of ['yes', 'no']) {
      const fair = (side === 'yes') === !!same ? ref.fair : 1 - ref.fair;
      const pick = `${pickOf(t, side)}${lineText(t, side)}`;
      const group = `${t.exchange}|${t.id}`;
      fairs.set(`${group}|${pick}`, fair * 100);
      const c = costOf(t, side, o);
      if (!c) continue;
      const ev = fair / c.cost - 1;
      if (ev < o.minEv || ev > o.maxEv) continue;
      const e = {
        id: `${group}|${side}`, group, venue: t.exchange, venueName: VENUE[t.exchange] || t.exchange, marketId: t.id, side, pick,
        title: t.eventTitle || t.title, market: t.kind === 'teams' || t.game3 ? 'moneyline' : t.kind,
        league: t.league || p.league || null, category: t.category || p.category || 'sports',
        price: c.price, cost: r4(c.cost), fair: r4(fair), ev: r4(ev),
        refId: String(p.id), refToken: p.tokenIds?.[p.yesIndex ?? 0] ?? null,
        ref: { venue: 'polymarket', mid: r4(ref.fair), spread: r4(ref.spread), liquidity: ref.liquidity, source: ref.source, url: p.url },
        start: new Date(start).toISOString(), url: t.url || null, rules: t.rules || null,
      };
      // one bet per contract side
      if (!best.has(e.id) || best.get(e.id).ev < e.ev) best.set(e.id, e);
    }
  }
  const edges = [...best.values()].sort((a, b) => b.ev - a.ev);
  return { edges, fairs, pairs: pairs.length };
}

// The first pass on Gamma's quotes, wide enough that a lagging Gamma price
// doesn't hide an edge the book has: what to read the live book for.
const SCREEN = { minEv: -0.01, maxEv: 0.3, maxSpread: 0.06 };
function screen(input, opts = {}) {
  return findValue(input, { ...opts, ...SCREEN, books: null, requireBook: false }).edges;
}

// The price screen's fair column (xarb.exchangeScreen rows): each side's fair
// from Polymarket's mid, and the EV of the cheaper venue's all-in price at it.
// Polymarket US rows pair by slug, kind, line and team; a Polymarket row (intl
// mode) is its own ref. Looser than an edge: a wider spread still prices it.
const FAIR_SCREEN = { maxSpread: 0.04 };
function screenFairs(rows = [], { usRows = [], polymarket = [], books = null } = {}, opts = {}) {
  const o = { ...DEFAULTS, ...FAIR_SCREEN, ...opts, books, requireBook: false };
  const want = new Set(rows.map(r => String(r.id)));
  const refs = new Map();
  for (const { target, ref, same } of pairUs(usRows.filter(u => want.has(String(u.id))), polymarket)) {
    const f = refFair(ref, o);
    if (f && !refs.has(String(target.id))) refs.set(String(target.id), { fair: f.fair, same });
  }
  for (const p of polymarket) if (want.has(String(p.id)) && !refs.has(String(p.id))) { const f = refFair(p, o); if (f) refs.set(String(p.id), { fair: f.fair, same: true }); }
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
    return { ...r, sides, maxEv: evs.length ? Math.max(...evs) : null };
  });
}

// edges → evtrack rows (ev and fair in percent)
function trackRows(edges) {
  return edges.map(e => ({
    group: e.group, side: e.pick, book: e.venue, start: e.start, sport: e.league || e.category, event: e.title,
    market: e.market, price: e.cost, decimal: 1 / e.cost, ev: e.ev * 100, fairProb: e.fair * 100, source: 'xvalue',
  }));
}

// "NBA · Lakers at Celtics: Celtics on Kalshi at 52¢ (53.1¢ with fee), Polymarket 56¢ (+5.5%) <link>"
function describe(e) {
  const when = e.start ? new Date(e.start).toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: '2-digit' }) + ' ET' : '';
  const c = x => `${Math.round(x * 1000) / 10}¢`;
  return `${(e.league || e.category || '').toUpperCase()} · ${e.title}${when ? ` (${when})` : ''}: ${e.pick} on ${e.venueName} at ${c(e.price)} (${c(e.cost)} with fee), Polymarket ${c(e.fair)} (+${Math.round(e.ev * 1000) / 10}%)${e.url ? ` ${e.url}` : ''}`;
}

module.exports = { findValue, screen, SCREEN, screenFairs, pairUs, refFair, trackRows, describe, optsFromEnv, DEFAULTS };
