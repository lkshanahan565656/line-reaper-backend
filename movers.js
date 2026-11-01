// ─── LINE MOVERS ──────────────────────────────────────────────────────────────
// Where the sharp money went today: the paired game lines whose Polymarket
// price moved most over the last day and hour, the side it moved to, and what
// Kalshi and Polymarket US charge for that side now. Polymarket's book is the
// deepest on most games, so its move is the market's; a US venue still selling
// near the old price hasn't caught up (steam.js catches the minutes-old moves,
// this is the slower picture, OddsJam's "line movement" screen).
//
// Gamma gives every market's oneHourPriceChange and oneDayPriceChange (xarb
// parse: hourChange / dayChange, as YES's), so the view needs no history and
// survives a deploy. Gamma's change follows the last trade, so only a market
// whose book is tight now (spread ≤ maxSpread) counts, and the move has to
// be minMove or more in a day or minHourMove in the hour.

const DEFAULTS = { minMove: 0.03, minHourMove: 0.02, maxSpread: 0.03, maxRows: 40 };
const { r4 } = require('./mathutil');
const VENUE = { kalshi: 'Kalshi', polymarketus: 'Polymarket US' };

// quotes: xvalue's Map side id → { fair, cost, price, spread, refId, dir, venue, pick, ... }
// polymarket: Polymarket rows (by id) → movers, biggest move first; one row per
// game side, with each US venue's price for it
function findMovers(quotes, polymarket = [], opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const byId = new Map(polymarket.map(p => [String(p.id), p]));
  const rows = new Map();
  for (const [id, q] of quotes) {
    const p = byId.get(String(q.refId));
    if (!p || q.dir == null || !(q.spread <= o.maxSpread + 1e-9)) continue;
    const day = (p.dayChange ?? 0) * q.dir, hour = (p.hourChange ?? 0) * q.dir;
    // the side that went up: its NO twin shows the same move down
    const move = Math.max(day, hour);
    if (!(day >= o.minMove - 1e-9 || hour >= o.minHourMove - 1e-9)) continue;
    const key = `${q.refId}|${q.dir}`;
    const venue = { venue: q.venue, venueName: VENUE[q.venue] || q.venue, price: r4(q.price), cost: r4(q.cost), ev: r4(q.fair / q.cost - 1), url: q.url, pick: q.pick, id,
      group: id.slice(0, id.lastIndexOf('|')), side: id.slice(id.lastIndexOf('|') + 1) };
    const row = rows.get(key);
    if (row) { row.venues.push(venue); continue; }
    rows.set(key, {
      key, refId: q.refId, refToken: q.refToken ?? null, title: q.title, league: q.league, category: q.category, market: q.market, start: q.start, pick: q.pick,
      fair: r4(q.fair), from: r4(q.fair - day), day: r4(day), hour: r4(hour), move: r4(move), venues: [venue],
    });
  }
  const out = [...rows.values()];
  for (const r of out) {
    r.venues.sort((a, b) => a.cost - b.cost);
    r.best = r.venues[0];
  }
  return out.sort((a, b) => b.move - a.move || b.day - a.day).slice(0, o.maxRows);
}

// Movers as bets, tracked on CLV like exchange value (source 'mover', the
// "line mover" signal in Results): the side the move went to, at its cheapest
// US venue that sells it at or under the fair Polymarket's book shows now.
// On paper a fair price has no edge; what the record answers is whether a big
// Polymarket move keeps going into the close, so a follow-the-move bet beats
// it. fairs: xvalue.findValue's book-read fairs (group|pick → percent), so a
// mover is only taken once its book has been read; a side that's already an
// exchange value edge stays that edge.
function moverBets(movers = [], { fairs = new Map(), edges = [], minEv = 0, maxEv = 0.12 } = {}) {
  const taken = new Set(edges.map(e => e.id));
  const out = [];
  for (const m of movers) {
    for (const v of m.venues) {
      if (taken.has(v.id)) break;
      const f = fairs.get(`${v.group}|${v.pick}`);
      if (f == null || !(v.cost > 0)) continue;
      const fair = f / 100, ev = fair / v.cost - 1;
      if (ev < minEv - 1e-9 || ev > maxEv) continue;
      out.push({
        id: v.id, group: v.group, venue: v.venue, venueName: v.venueName, marketId: v.group.slice(v.group.indexOf('|') + 1), side: v.side, pick: v.pick,
        title: m.title, market: m.market, league: m.league, category: m.category, price: v.price, cost: v.cost, fair: r4(fair), ev: r4(ev),
        refId: m.refId, refToken: m.refToken, refName: 'Polymarket', start: m.start, url: v.url,
        mover: { from: m.from, day: m.day, hour: m.hour, move: m.move },
      });
      break;   // one bet per move: its cheapest venue
    }
  }
  return out;
}

// "moved 6¢ today (52.5¢ → 58.5¢)" / "moved 3¢ in the last hour"
function moverText(mv) {
  const c = x => `${Math.round(x * 1000) / 10}¢`;
  return mv.day >= mv.hour ? `Polymarket moved it ${c(mv.day)} today (${c(mv.from)} → ${c(mv.from + mv.day)})` : `Polymarket moved it ${c(mv.hour)} in the last hour`;
}

module.exports = { findMovers, moverBets, moverText, DEFAULTS };
