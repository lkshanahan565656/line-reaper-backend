// ─── BID, THEN HEDGE: TRACK RECORD ────────────────────────────────────────────
// Every bid plan xarb.findBidArbs lists is followed until its game starts:
//   filled     the maker venue's ask came down to the bid (a seller reached
//              it), and the hedge is bought at its ask in that same scan,
//              whatever it is by then: the lock (or loss) is what a follower
//              would really have got, adverse moves included
//   cancelled  the hedge ran past its break-even before the bid filled; the
//              card says to cancel then, so it's no bet
//   unfilled   the game started with the bid still resting: no bet
// A filled plan is graded at once on the lock (1u staked). Nothing waits for
// the result: both sides are held, so it pays the lock whichever way it ends.

const { createMemoryStore } = require('./evtrack');
const { bidLock } = require('./xarb');

const ask = (row, side) => (row ? (side === 'yes' ? row.yesAsk : row.noAsk) : null);
const slim = l => ({ venue: l.venue, marketId: l.marketId, side: l.side, pick: l.pick, ...(l.feeSchedule ? { feeSchedule: l.feeSchedule } : {}) });

function createBidTracker({ store = createMemoryStore(), fees = {}, now = () => Date.now(), log = console } = {}) {
  const ready = store.init();
  const open = new Map();
  const loaded = ready.then(async () => { for (const r of await store.all()) if (r.status === 'open') open.set(r.id, r); });

  // plans: this scan's findBidArbs; rows: every venue row this scan read
  async function record(plans = [], rows = []) {
    await loaded;
    const t = now(), at = new Date(t).toISOString();
    const byKey = new Map(rows.map(r => [`${r.exchange}:${r.id}`, r]));
    const quote = l => ask(byKey.get(`${l.venue}:${l.marketId}`), l.side);
    const writes = [];
    for (const p of plans) {
      // with no start time there's no telling a pre-game fill from an in-play one
      if (open.has(p.id) || !p.startTime) continue;
      const [b, h] = p.legs;
      const start = p.startTime;
      const r = {
        id: p.id, status: 'open', flaggedAt: at, start, title: p.title, kind: p.kind || null,
        maker: slim(b), bidPrice: b.price, front: !!b.front, hedge: slim(h), hedgeAtFlag: h.price, hedgeMax: h.maxPrice, lockAtFlag: p.profitPct,
      };
      open.set(r.id, r);
      writes.push(store.put(r));
    }
    for (const r of open.values()) {
      const hedgeNow = quote(r.hedge), makerAsk = quote(r.maker);
      if (r.start && Date.parse(r.start) <= t) Object.assign(r, { status: 'unfilled', closedAt: at });
      else if (makerAsk != null && makerAsk <= r.bidPrice + 1e-9 && hedgeNow != null) {
        Object.assign(r, { status: 'filled', closedAt: at, hedgeAt: hedgeNow, lock: bidLock(r.maker, r.bidPrice, r.hedge, hedgeNow, fees) });
      } else if (hedgeNow != null && hedgeNow > r.hedgeMax + 1e-9) Object.assign(r, { status: 'cancelled', closedAt: at, hedgeAt: hedgeNow });
      else continue;
      open.delete(r.id);
      writes.push(store.put(r));
    }
    await Promise.all(writes).catch(e => log.warn?.(`Bid tracker: ${e.message}`));
  }

  async function summary() {
    await loaded;
    const all = await store.all();
    const n = s => all.filter(r => r.status === s).length;
    const filled = all.filter(r => r.status === 'filled' && r.lock != null);
    const done = filled.length + n('unfilled') + n('cancelled');
    const units = filled.reduce((a, r) => a + r.lock / 100, 0);
    return {
      open: open.size, filled: filled.length, unfilled: n('unfilled'), cancelled: n('cancelled'),
      fillRate: done ? Math.round((filled.length / done) * 1000) / 1000 : null,
      locked: filled.filter(r => r.lock > 0).length, lost: filled.filter(r => r.lock < 0).length,
      avgLock: filled.length ? Math.round((units / filled.length) * 1e4) / 100 : null, units: Math.round(units * 100) / 100,
    };
  }

  async function list() { await loaded; return store.all(); }
  return { record, summary, list, ready: () => loaded, store };
}

module.exports = { createBidTracker };
