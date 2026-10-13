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
const r4 = x => Math.round(x * 1e4) / 1e4;
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
    const venue = { venue: q.venue, venueName: VENUE[q.venue] || q.venue, price: r4(q.price), cost: r4(q.cost), ev: r4(q.fair / q.cost - 1), url: q.url, pick: q.pick, id };
    const row = rows.get(key);
    if (row) { row.venues.push(venue); continue; }
    rows.set(key, {
      key, title: q.title, league: q.league, category: q.category, market: q.market, start: q.start, pick: q.pick,
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

module.exports = { findMovers, DEFAULTS };
