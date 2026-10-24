// ─── EXCHANGE SHOPPER: THE SAME BET AT EVERY VENUE, BEST PRICE FIRST ─────────
// Takes oddsschema quotes from every adapter (oddsproviders.js) and lines up
// each market (a moneyline, a spread or total at one number, a player prop at
// one line) across every venue that hangs it, alternate numbers and props
// included. For each side it shows the best and second-best price after fees,
// the fair (Pinnacle's no-vig, with Matchbook beside it when it prices the
// same line; else a labelled median of 4+ books), EV per unit and for a
// stake, the gap to the next venue, and the hold at the best price on every
// side (under 0 is an arb, with the stakes). Ranked opportunities come from
// oddsrank.js and are leads unless the tracker has proven that venue.
//
// A reference venue (Pinnacle, Matchbook) is a column and a fair, never the
// "best" place to bet. A second-hand copy is a column and can be best, but
// never ranks as an opportunity on its own. With a state, only venues legal
// there can be best (Texas: Kalshi, Gemini, Polymarket US).
//
// Pure functions, no I/O.

const engine = require('./oddsengine');
const schema = require('./oddsschema');
const ranker = require('./oddsrank');
const venues = require('./venues');
const { canonName } = require('./ev');

const SHARP_WEIGHTS = { pinnacle: 1, matchbook: 0.6 };
const MIN_CONSENSUS = 4;
const ms = t => { const x = Date.parse(t || ''); return Number.isFinite(x) ? x : null; };
const r4 = engine.r4, r2 = engine.r2;
const SIDE_ORDER = { moneyline: ['home', 'draw', 'away'], spread: ['home', 'away'], total: ['over', 'under'], player_prop: ['over', 'under'] };

function groupOf(q) {
  if (q.marketType === 'moneyline') return { key: q.marketId || `${q.eventId}|ml`, line: null };
  if (q.marketType === 'spread') { const homeLine = q.side === 'home' ? q.line : -q.line; return { key: `${q.eventId}|spread|${homeLine}`, line: homeLine }; }
  if (q.marketType === 'total') return { key: `${q.eventId}|total|${q.line}`, line: q.line };
  if (q.marketType === 'player_prop') return { key: `${q.eventId}|prop|${q.marketName}|${canonName(q.player)}|${q.line}`, line: q.line };
  return null;
}
function median(xs) {
  const s = xs.slice().sort((a, b) => a - b);
  const n = s.length;
  return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : null;
}

// quotes → Map key → market (raw: every provider's prices per side)
function groupMarkets(quotes) {
  const out = new Map();
  for (const q of quotes || []) {
    const g = groupOf(q);
    if (!g || !(q.effectiveDecimal > 1) || !q.side) continue;
    let m = out.get(g.key);
    if (!m) {
      m = { key: g.key, eventId: q.eventId, sport: q.sport, league: q.league, home: q.home, away: q.away, start: q.startUtc, marketType: q.marketType,
        marketName: q.marketName ? q.marketName.replace(/ \(alt\)$/, '') : q.marketName, period: q.period, line: g.line, player: q.player || null, by: new Map() };
      out.set(g.key, m);
    }
    if (!m.by.has(q.providerId)) m.by.set(q.providerId, {});
    const px = m.by.get(q.providerId);
    // the better of two quotes for the same side (a main and an alt rung at one number)
    if (!px[q.side] || q.effectiveDecimal > px[q.side].effectiveDecimal) px[q.side] = q;
  }
  return out;
}

// the fair on one market: Pinnacle (with Matchbook beside it), else a median
// of MIN_CONSENSUS books that price every side
function fairOf(m, sides, { method = 'power', now = Date.now() } = {}) {
  const full = [...m.by].filter(([, px]) => sides.every(s => px[s] && !px[s].oneWay));
  const sharp = full.filter(([id]) => SHARP_WEIGHTS[id] && id !== 'matchbook');
  if (sharp.length) {
    const srcs = full.filter(([id]) => SHARP_WEIGHTS[id]).map(([id, px]) => ({ id, decimals: sides.map(s => px[s].decimal), weight: SHARP_WEIGHTS[id] }));
    const b = engine.blendFair(srcs, { method });
    if (!b) return null;
    const pin = m.by.get('pinnacle');
    const at = Math.min(...sides.map(s => ms(pin[s].updatedAt) ?? now));
    return { p: Object.fromEntries(sides.map((s, i) => [s, b.fair[i]])), source: b.n > 1 ? 'pinnacle_matchbook' : 'pinnacle', sources: b.sources.map(x => x.id),
      spreadPts: b.spreadPts.length ? Math.max(...b.spreadPts) : null, method, freshness: schema.freshness(now - at) };
  }
  const books = full.filter(([id]) => !schema.PROVIDERS[id]?.reference);
  if (books.length >= MIN_CONSENSUS) {
    const nv = books.map(([, px]) => engine.devig(sides.map(s => px[s].decimal), method)).filter(Boolean);
    if (nv.length >= MIN_CONSENSUS) {
      const raw = sides.map((_, i) => median(nv.map(p => p[i])));
      const t = raw.reduce((a, b) => a + b, 0);
      return { p: Object.fromEntries(sides.map((s, i) => [s, r4(raw[i] / t)])), source: 'consensus', sources: books.map(([id]) => id), spreadPts: null, method, freshness: 'live' };
    }
  }
  return null;
}

// options → a predicate on providers: include list, exclude list, state
function providerFilter({ providers = null, exclude = null, state = null } = {}) {
  const inc = providers && providers.length ? new Set(providers) : null;
  const exc = new Set(exclude || []);
  const legal = venues.legalIn(state);
  return {
    show: id => !exc.has(id) && (!inc || inc.has(id) || schema.PROVIDERS[id]?.reference),
    bettable: id => !exc.has(id) && (!inc || inc.has(id)) && !schema.PROVIDERS[id]?.reference && legal(id),
  };
}

function priceCell(q, { fair, stake, now, bettable }) {
  const p = schema.provider(q.providerId);
  const age = q.updatedAt ? now - ms(q.updatedAt) : null;
  const eff = q.effectiveDecimal;
  const feeUnknown = q.commission?.type === 'commission' && q.commission.rate == null;
  return {
    provider: q.providerId, name: p?.name || q.providerId, type: p?.type || null, decimal: r4(q.decimal), effective: r4(eff), american: schema.fromDecimal(eff, 'american'),
    implied: r4(1 / eff), ev: fair == null ? null : r4(engine.ev(fair, eff)), evAmount: fair == null ? null : r2(engine.evAmount(fair, eff, stake)),
    ref: !!p?.reference, secondHand: p?.access === 'second_hand', texas: !!p?.texas, oneWay: !!q.oneWay, bettable: bettable(q.providerId),
    fee: q.commission?.type || 'none', feeUnknown, freshness: schema.freshness(age, { access: p?.access }), ageSec: age == null ? null : Math.round(age / 1000),
    liquidity: q.liquidity, maxStake: q.maxStake, url: q.sourceIds?.url || null, sourceIds: q.sourceIds || null, line: q.line,
  };
}

// one grouped market → its view, or null when nothing in it is bettable
function viewMarket(m, { filter, stake, now, method }) {
  const order = SIDE_ORDER[m.marketType];
  const present = new Set([...m.by.values()].flatMap(px => Object.keys(px)));
  const sides = order.filter(s => present.has(s) && (s !== 'draw' || m.marketType === 'moneyline'));
  if (m.marketType === 'moneyline' && m.key.endsWith('|ml3') ? sides.length !== 3 : sides.length !== 2) return null;
  const fair = fairOf(m, sides, { method, now });
  const out = sides.map(s => {
    const f = fair?.p[s] ?? null;
    const cells = [...m.by].filter(([id, px]) => px[s] && filter.show(id)).map(([, px]) => priceCell(px[s], { fair: f, stake, now, bettable: filter.bettable }));
    const live = cells.filter(c => c.bettable && c.freshness !== 'stale').sort((a, b) => b.effective - a.effective);
    const best = live[0] || null, second = live[1] || null;
    for (const c of cells) c.best = c === best;
    cells.sort((a, b) => (b.ref - a.ref) || b.effective - a.effective);
    return {
      side: s, name: selectionName(m, s), fair: f, fairAmerican: f ? schema.fromDecimal(1 / f, 'american') : null,
      best: best ? { provider: best.provider, name: best.name, american: best.american, effective: best.effective, ev: best.ev, evAmount: best.evAmount, freshness: best.freshness, secondHand: best.secondHand, oneWay: best.oneWay, liquidity: best.liquidity } : null,
      second: second ? { provider: second.provider, name: second.name, american: second.american, effective: second.effective } : null,
      edgePts: f != null && best ? r2((f - best.implied) * 100) : null,
      discrepancy: best && second ? engine.discrepancy(best.effective, second.effective) : null,
      kelly: f != null && best ? r4(engine.kelly(f, best.effective, 0.25)) : null,
      prices: cells,
    };
  });
  if (!out.some(s => s.prices.some(c => c.bettable))) return null;
  const bests = out.map(s => s.best?.effective);
  const a = bests.every(Boolean) ? engine.arb(bests, stake) : null;
  return {
    key: m.key, eventId: m.eventId, sport: m.sport, league: m.league, event: `${m.away} @ ${m.home}`, home: m.home, away: m.away, start: m.start,
    marketType: m.marketType, marketName: m.marketName, period: m.period, line: m.line, player: m.player,
    fair: fair ? { source: fair.source, sources: fair.sources, spreadPts: fair.spreadPts, method: fair.method, freshness: fair.freshness } : null,
    hold: a ? a.hold : null, arb: a && a.arb ? { profit: a.profit, stakes: Object.fromEntries(out.map((s, i) => [s.side, a.stakes[i]])), payout: a.payout, total: stake,
      legs: out.map(s => ({ side: s.side, provider: s.best.provider, name: s.best.name, american: s.best.american, secondHand: s.best.secondHand, freshness: s.best.freshness })) } : null,
    venues: new Set(out.flatMap(s => s.prices.map(c => c.provider))).size,
    maxEv: Math.max(...out.map(s => s.best?.ev ?? -Infinity)),
    sides: out,
  };
}
function selectionName(m, s) {
  const sgn = x => `${x > 0 ? '+' : ''}${x}`;
  if (m.marketType === 'moneyline') return s === 'home' ? m.home : s === 'away' ? m.away : 'Draw';
  if (m.marketType === 'spread') return s === 'home' ? `${m.home} ${sgn(m.line)}` : `${m.away} ${sgn(-m.line)}`;
  if (m.marketType === 'total') return `${s === 'over' ? 'Over' : 'Under'} ${m.line}`;
  return `${m.player} ${s === 'over' ? 'Over' : 'Under'} ${m.line}`;
}

// The whole shopper.
// opts: sport, league, q (team or player text), marketTypes [], providers [],
// exclude [], state, fromMs / toMs (start window), minEv, minEdgePts (fair
// minus the best price's implied chance, points), minLiquidity, maxAgeSec,
// pricedOnly, arbsOnly, sort (score | ev | start | hold | gap), stake, method,
// limit, proven (Set of provider ids the tracker marks proven).
function build(quotes, opts = {}) {
  const now = opts.now ?? Date.now();
  const stake = opts.stake > 0 ? opts.stake : 100;
  const method = engine.DEVIG_METHODS.includes(opts.method) ? opts.method : 'power';
  const from = opts.fromMs ?? now - 5 * 60e3, to = opts.toMs ?? now + 48 * 3600e3;
  const want = String(opts.q || '').trim().toLowerCase();
  const types = opts.marketTypes && opts.marketTypes.length ? new Set(opts.marketTypes) : null;
  const filter = providerFilter(opts);
  const kept = (quotes || []).filter(q => {
    const t = ms(q.startUtc);
    if (t == null || t < from || t > to) return false;
    if (opts.sport && q.sport !== opts.sport) return false;
    if (opts.league && q.league !== opts.league) return false;
    if (types && !types.has(q.marketType)) return false;
    if (q.marketStatus !== 'open' || q.available === false) return false;
    if (opts.maxAgeSec != null && q.updatedAt && (now - ms(q.updatedAt)) / 1000 > opts.maxAgeSec && !schema.PROVIDERS[q.providerId]?.reference) return false;
    if (want && !`${q.home} ${q.away} ${q.player || ''}`.toLowerCase().includes(want)) return false;
    return true;
  });
  const grouped = groupMarkets(kept);
  let markets = [];
  for (const m of grouped.values()) {
    const v = viewMarket(m, { filter, stake, now, method });
    if (v) markets.push(v);
  }
  const all = markets;
  // ranked opportunities: each side's best bettable price above the fair
  const cands = [];
  for (const m of all) for (const s of m.sides) {
    if (!s.best || s.best.ev == null || s.best.ev <= 0) continue;
    cands.push({ key: `${m.key}|${s.side}`, market: m.key, event: m.event, sport: m.sport, league: m.league, start: m.start, marketType: m.marketType, marketName: m.marketName,
      line: m.line, player: m.player, selection: s.name, provider: s.best.provider, providerName: s.best.name, american: s.best.american, effective: s.best.effective,
      fairAmerican: s.fairAmerican, fair: s.fair, ev: s.best.ev, evAmount: s.best.evAmount, edgePts: s.edgePts, kelly: s.kelly, second: s.second,
      fairSource: m.fair?.source, spreadPts: m.fair?.spreadPts ?? null, freshness: s.best.freshness, fairFreshness: m.fair?.freshness, access: s.best.secondHand ? 'second_hand' : 'direct',
      oneWay: s.best.oneWay, liquidity: s.best.liquidity, view: m });
  }
  const minEv = Number.isFinite(opts.minEv) ? opts.minEv : 0;
  const minEdge = Number.isFinite(opts.minEdgePts) ? opts.minEdgePts : null;
  let opportunities = ranker.rankAll(cands, { proven: opts.proven, stake })
    .filter(o => o.ev >= minEv && (minEdge == null || o.edgePts >= minEdge) && (opts.minLiquidity == null || (o.liquidity != null && o.liquidity >= opts.minLiquidity)));
  const arbs = all.filter(m => m.arb && m.arb.legs.every(l => !l.secondHand && l.freshness !== 'stale'))
    .sort((a, b) => b.arb.profit - a.arb.profit);
  // the market list itself
  markets = all.filter(m =>
    (!opts.pricedOnly || m.fair) && (!opts.arbsOnly || m.arb) &&
    (!(minEv > 0) || m.maxEv >= minEv) &&
    (minEdge == null || m.sides.some(s => s.edgePts != null && s.edgePts >= minEdge)) &&
    (opts.minLiquidity == null || m.sides.some(s => s.best?.liquidity != null && s.best.liquidity >= opts.minLiquidity)));
  const sorters = {
    ev: (a, b) => b.maxEv - a.maxEv,
    start: (a, b) => ms(a.start) - ms(b.start) || a.key.localeCompare(b.key),
    hold: (a, b) => (a.hold ?? 9) - (b.hold ?? 9),
    gap: (a, b) => Math.max(...b.sides.map(s => s.discrepancy?.pts ?? -9)) - Math.max(...a.sides.map(s => s.discrepancy?.pts ?? -9)),
    venues: (a, b) => b.venues - a.venues || ms(a.start) - ms(b.start),
  };
  markets.sort(sorters[opts.sort] || sorters.ev);
  const limit = Math.min(opts.limit > 0 ? opts.limit : 200, 1000);
  const count = (xs, f) => xs.reduce((n, x) => n + (f(x) ? 1 : 0), 0);
  const facets = { sports: {}, leagues: {}, marketTypes: {}, providers: {} };
  for (const m of all) {
    facets.sports[m.sport] = (facets.sports[m.sport] || 0) + 1;
    facets.leagues[m.league] = (facets.leagues[m.league] || 0) + 1;
    facets.marketTypes[m.marketType] = (facets.marketTypes[m.marketType] || 0) + 1;
    for (const s of m.sides) for (const c of s.prices) facets.providers[c.provider] = (facets.providers[c.provider] || 0) + 1;
  }
  return {
    // the first 50 leads carry their whole market, so a row can open to every venue
    markets: markets.slice(0, limit), opportunities: opportunities.slice(0, limit).map((o, i) => { const { view, ...rest } = o; return i < 50 ? { ...rest, view } : rest; }), arbs: arbs.slice(0, 100),
    counts: { quotes: kept.length, markets: all.length, shown: Math.min(markets.length, limit), matching: markets.length, priced: count(all, m => m.fair), plusEv: count(all, m => m.maxEv > 0),
      opportunities: opportunities.length, arbs: arbs.length, lowHold: count(all, m => m.hold != null && m.hold < 0.01), multiVenue: count(all, m => m.venues >= 3) },
    facets, stake, method, state: venues.stateOf(opts.state), window: { from: new Date(from).toISOString(), to: new Date(to).toISOString() },
  };
}

// free viewers: every price, no fair, EV or ranking
function stripPro(view) {
  return { ...view, opportunities: [], arbs: [], locked: { opportunities: view.opportunities.length, arbs: view.arbs.length },
    markets: view.markets.map(m => ({ ...m, maxEv: null, fair: m.fair ? { source: m.fair.source } : null, arb: null,
      sides: m.sides.map(s => ({ ...s, fair: null, fairAmerican: null, edgePts: null, kelly: null, best: s.best ? { ...s.best, ev: null, evAmount: null } : null,
        prices: s.prices.map(c => ({ ...c, ev: null, evAmount: null })) })) })) };
}

module.exports = { SHARP_WEIGHTS, groupOf, groupMarkets, fairOf, providerFilter, viewMarket, build, stripPro };
