// ─── BOOK ARBS AND MIDDLES: FILL RECORD ──────────────────────────────────────
// An arb is only worth an alert if a subscriber who sees it can still place
// both legs. Every row bookarbs.js lists is logged once, at its first price,
// and checked once two minutes later from the first scan whose data is that
// fresh:
//
//   sportsbook leg   still posted at the same line, at the shown price or better
//   exchange leg     the same, and the book still holds the contracts a $100
//                    pair needs (or what it held at the flag, if less)
//
// execOk: both legs pass. The margin at +2 min is what the pair costs then
// (null when a leg is gone). A check that can't be made within lateMs of its
// due time is dropped as 'late', so a deploy never grades stale rows.

const { createMemoryStore } = require('./evtrack');

const DEFAULTS = { lagMs: 2 * 60e3, lateMs: 4 * 60e3, stake: 100, minMiddleEv: 2, provenN: 50, keepMs: 3 * 86400e3 };
const r2 = x => (x == null || !Number.isFinite(x) ? null : Math.round(x * 100) / 100);
const r4 = x => Math.round(x * 1e4) / 1e4;
const ms = t => { const x = Date.parse(t || ''); return Number.isFinite(x) ? x : null; };
const isExchange = v => v === 'kalshi' || v === 'polymarketus';
const bookKey = l => `${l.venue}:${l.marketId}:${l.side}`;

// one leg two minutes on → { ok, cost, reason }. quote: this scan's quote at
// the leg's line (bookarbs.quoteIndex); fill: contracts resting at or under
// the shown price now (exchange legs), need: contracts the pair needs
// An exchange leg is judged on its book read fresh at the check (its listed
// quote can lag a few minutes); a sportsbook leg on this scan's feed.
function checkLeg(leg, quote, { fill = null, need = 0 } = {}) {
  if (isExchange(leg.venue)) {
    if (fill == null) return { ok: null, cost: null, reason: 'unread' };
    if (fill <= 0) return { ok: false, cost: quote?.cost ?? null, reason: 'price', fill };
    if (fill < need) return { ok: false, cost: leg.cost, reason: 'size', fill };
    return { ok: true, cost: leg.cost, fill };
  }
  if (!quote) return { ok: false, cost: null, reason: 'gone' };
  if (!(quote.cost <= leg.cost + 1e-4)) return { ok: false, cost: quote.cost, reason: 'price' };
  return { ok: true, cost: quote.cost };
}

function createBookArbTracker({ store = createMemoryStore(), now = () => Date.now(), opts = {}, log = console } = {}) {
  const o = { ...DEFAULTS, ...opts };
  const ready = store.init();
  const open = new Map();
  const ids = new Set();
  const loaded = ready.then(async () => { for (const r of await store.all()) { ids.add(r.id); if (r.status === 'open') open.set(r.id, r); } });

  // rows: bookarbs.find's arbs and middles (legs carry fill from the server's
  // book reads); dataAt: when this scan's prices were read (ISO)
  async function record(rows = [], dataAt = new Date(now()).toISOString()) {
    await loaded;
    const writes = [];
    for (const a of rows) {
      if (ids.has(a.id) || (a.type === 'middle' && !(a.evPct >= o.minMiddleEv))) continue;
      ids.add(a.id);
      const fills = a.legs.filter(l => isExchange(l.venue)).map(l => l.fill?.atPrice).filter(x => x != null);
      const r = {
        id: a.id, status: 'open', flaggedAt: new Date(now()).toISOString(), dataAt, type: a.type, kind: a.kind, sport: a.sport, pair: a.pair,
        title: a.title, start: a.start, subject: a.subject, low: a.low, high: a.high, totalCost: a.totalCost, profitPct: a.profitPct, evPct: a.evPct,
        missPct: a.missPct, hitProb: a.hitProb, fill: fills.length ? Math.min(...fills) : null,
        legs: a.legs.map(l => ({ venue: l.venue, pick: l.pick, qkey: l.qkey, cost: l.cost, ...(l.marketId ? { marketId: l.marketId, side: l.side } : {}), ...(l.yesSide ? { yesSide: l.yesSide } : {}) })),
      };
      open.set(r.id, r);
      writes.push(store.put(r));
    }
    await Promise.all(writes).catch(e => log.warn?.(`Book arb tracker: ${e.message}`));
  }

  // rows due their check at this scan's data time, for the server to read
  // their exchange books first
  async function due(dataAt) {
    await loaded;
    const t = ms(dataAt);
    return [...open.values()].filter(r => t != null && t - ms(r.dataAt) >= o.lagMs);
  }

  // quotes: bookarbs.quoteIndex of this scan; books: Map `${venue}:${marketId}:${side}`
  // → contracts resting at or under a price, as fillAt(leg) → number|null
  async function check(quotes, fillAt = () => null, dataAt = new Date(now()).toISOString()) {
    await loaded;
    const t = ms(dataAt), writes = [];
    for (const r of await due(dataAt)) {
      if (t - ms(r.dataAt) > o.lagMs + o.lateMs) {
        Object.assign(r, { status: 'late' });
      } else {
        const need = Math.min(r.fill ?? Infinity, Math.ceil(o.stake / r.totalCost));
        const legs = r.legs.map(l => checkLeg(l, quotes.get(l.qkey), { fill: isExchange(l.venue) ? fillAt(l) : null, need }));
        if (legs.some(x => x.ok === null)) continue;   // a book unread this scan: try the next one
        const cost = legs.every(x => x.cost != null) ? r4(legs.reduce((a, x) => a + x.cost, 0)) : null;
        Object.assign(r, { status: 'checked', exec: { at: dataAt, ok: legs.every(x => x.ok), cost, marginPct: cost ? r2(((1 - cost) / cost) * 100) : null,
          legs: legs.map(x => ({ ok: x.ok, cost: x.cost, ...(x.reason ? { reason: x.reason } : {}), ...(x.fill != null ? { fill: x.fill } : {}) })) } });
      }
      open.delete(r.id);
      writes.push(store.put(r));
    }
    await Promise.all(writes).catch(e => log.warn?.(`Book arb tracker: ${e.message}`));
    return writes.length;
  }

  async function summary() {
    await loaded;
    const all = await store.all();
    const checked = all.filter(r => r.status === 'checked');
    const cut = f => {
      const out = {};
      for (const r of checked) {
        const k = f(r);
        const c = out[k] ||= { n: 0, ok: 0, shown: 0, exec: 0, execN: 0 };
        c.n++; if (r.exec.ok) c.ok++;
        c.shown += r.type === 'arb' ? r.profitPct : r.evPct;
        if (r.exec.marginPct != null) { c.exec += r.exec.marginPct; c.execN++; }
      }
      for (const c of Object.values(out)) Object.assign(c, { okRate: r2(c.ok / c.n), avgShown: r2(c.shown / c.n), avgExecMargin: c.execN ? r2(c.exec / c.execN) : null, shown: undefined, exec: undefined });
      return out;
    };
    const ok = checked.filter(r => r.exec.ok).length;
    const reasons = {};
    for (const r of checked) for (const l of r.exec.legs) if (l.reason) reasons[l.reason] = (reasons[l.reason] || 0) + 1;
    const byType = cut(r => r.type);
    // alerts wait on arbs whose two legs were both still there, not middles
    return { open: open.size, checked: checked.length, ok, okRate: checked.length ? r2(ok / checked.length) : null, late: all.filter(r => r.status === 'late').length,
      proven: (byType.arb?.ok || 0) >= o.provenN, provenN: o.provenN, byType, byPair: cut(r => `${r.type}:${r.pair}`), reasons };
  }
  async function list({ limit = 200 } = {}) { await loaded; return (await store.all()).sort((a, b) => ms(b.flaggedAt) - ms(a.flaggedAt)).slice(0, limit); }
  return { record, due, check, summary, list, ready: () => loaded, store, opts: o };
}

module.exports = { createBookArbTracker, checkLeg, bookKey, DEFAULTS };
