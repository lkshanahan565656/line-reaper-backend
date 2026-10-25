// ─── MIDDLES: TRACK RECORD ────────────────────────────────────────────────────
// Every middle xarb.findMiddles lists is logged once, at its first price, and
// graded from Kalshi's own settled lines for that game. A Kalshi total or
// spread ladder is a row of "more than s" contracts, so once they settle the
// highest strike that said YES and the lowest that said NO bracket the final
// number. Both legs pay when that number is strictly between the middle's two
// lines (hit: 2 − cost a pair), one leg when it's outside (miss: 1 − cost).
// When the ladder can't place it either side of a line, the bet waits, and
// is dropped as 'ungraded' two days after the start. 1u staked a middle.

const { createMemoryStore } = require('./evtrack');

const KALSHI_MARKETS_URL = 'https://api.elections.kalshi.com/trade-api/v2/markets';
const DAY = 86400e3;
const kalshiLeg = m => (m.legs || []).find(l => l.venue === 'kalshi');
// the Kalshi event of a ladder rung, and which ladder it's on: a spread's
// rungs are per team ("…-BOS5"), a total's are bare numbers ("…-221")
const eventOf = ticker => String(ticker || '').split('-').slice(0, -1).join('-');
const ladderOf = ticker => (String(ticker || '').split('-').pop() || '').replace(/[\d.]+$/, '');

// settled rungs of one ladder → { above, below }: the number is > above and ≤ below
function bracket(markets, ladder) {
  let above = -Infinity, below = Infinity;
  for (const m of markets || []) {
    const s = Number(m.floor_strike), r = String(m.result || '').toLowerCase();
    if (!Number.isFinite(s) || ladderOf(m.ticker) !== ladder || !['yes', 'no'].includes(r)) continue;
    if (r === 'yes') above = Math.max(above, s); else below = Math.min(below, s);
  }
  return { above, below };
}
// → 'hit' | 'miss' | null (can't tell yet)
function gradeMiddle(low, high, { above, below }) {
  if (above >= low && below <= high) return 'hit';
  if (below <= low || above >= high) return 'miss';
  return null;
}

function createMiddleTracker({ store = createMemoryStore(), http = null, now = () => Date.now(), graceMs = 3 * 3600e3, log = console } = {}) {
  const ready = store.init();
  const open = new Map();
  const loaded = ready.then(async () => { for (const r of await store.all()) if (r.status === 'open') open.set(r.id, r); });

  async function record(middles = []) {
    await loaded;
    const writes = [], seen = new Set((await store.all()).map(r => r.id));
    for (const m of middles) {
      const k = kalshiLeg(m);
      if (seen.has(m.id) || !k || !m.startTime) continue;
      seen.add(m.id);
      const r = {
        id: m.id, status: 'open', flaggedAt: new Date(now()).toISOString(), start: m.startTime, title: m.title, league: m.league, kind: m.kind,
        low: m.low, high: m.high, cost: m.totalCost, hitProb: m.hitProb, evPct: m.evPct, event: eventOf(k.marketId), ladder: ladderOf(k.marketId),
        legs: m.legs.map(l => ({ venue: l.venue, pick: l.pick, price: l.price })),
      };
      open.set(r.id, r);
      writes.push(store.put(r));
    }
    await Promise.all(writes).catch(e => log.warn?.(`Middle tracker: ${e.message}`));
  }

  // games over: read each event's settled ladder once and grade its middles
  async function grade() {
    await loaded;
    if (!http) return;
    const t = now(), due = [...open.values()].filter(r => Date.parse(r.start) + graceMs <= t);
    const byEvent = new Map();
    for (const r of due) { if (!byEvent.has(r.event)) byEvent.set(r.event, []); byEvent.get(r.event).push(r); }
    for (const [event, list] of byEvent) {
      let markets = null;
      try { markets = (await http.get(KALSHI_MARKETS_URL, { params: { event_ticker: event, limit: 200 }, timeout: 15000 }))?.data?.markets; }
      catch (e) { log.warn?.(`Middle tracker: ${event}: ${e.message}`); continue; }
      for (const r of list) {
        const outcome = gradeMiddle(r.low, r.high, bracket(markets, r.ladder));
        if (outcome) Object.assign(r, { status: 'graded', outcome, profit: Math.round((((outcome === 'hit' ? 2 : 1) - r.cost) / r.cost) * 1e4) / 1e4, gradedAt: new Date(t).toISOString() });
        else if (Date.parse(r.start) + 2 * DAY <= t) Object.assign(r, { status: 'ungraded' });
        else continue;
        open.delete(r.id);
        await store.put(r).catch(e => log.warn?.(`Middle tracker: ${e.message}`));
      }
    }
  }

  async function summary() {
    await loaded;
    const graded = (await store.all()).filter(r => r.status === 'graded');
    const hits = graded.filter(r => r.outcome === 'hit').length;
    const units = graded.reduce((a, r) => a + r.profit, 0);
    const expected = graded.reduce((a, r) => a + (r.hitProb || 0), 0);
    return { open: open.size, graded: graded.length, hits, misses: graded.length - hits, expectedHits: Math.round(expected * 10) / 10,
      units: Math.round(units * 100) / 100, roi: graded.length ? Math.round((units / graded.length) * 1e4) / 1e4 : null };
  }
  async function list() { await loaded; return store.all(); }
  return { record, grade, summary, list, ready: () => loaded, store };
}

module.exports = { createMiddleTracker, gradeMiddle, bracket, eventOf, ladderOf };
