// ─── STEAM ────────────────────────────────────────────────────────────────────
// Polymarket's book moves first: it's the deepest market on most games, so
// news and sharp money show up there. Kalshi and Polymarket US often take
// minutes to follow. A side whose Polymarket price just jumped while the US
// venue's ask sat still is the stale price OddsJam-style steam alerts chase,
// and a better bet than a standing gap: a gap that has been there all along is
// as often the reference being wrong as the US venue.
//
// Each scan feeds every paired side's quote (xvalue.findValue's `quotes`):
// Polymarket's fair for the side and the US venue's all-in cost. A side is
// steaming when, inside the last `windowMs`:
//   move  = fair now − the lowest fair in the window ≥ minMove
//   lag   = the venue's cost moved by at most maxFollow × move since that low
// The move is read against the venue's cost at the time of the low, so a
// venue that already followed doesn't count. Only quotes from a tight book
// (spread ≤ maxSpread) go into the history: a wide book's mid is noise.
//
// Each side keeps only the points that can still be a window's low (a point
// with a lower fair after it never can), so a flat side is a point or two and
// the history is small enough to ride through a deploy: dump() goes into the
// results backup, load() puts it back on boot. Without that, every deploy
// left steam blind for its first 20 minutes (six deploys 19:56 to 21:52 10-13).

const DEFAULTS = {
  windowMs: 20 * 60e3,
  minMove: 0.03,        // 3¢ on the side's fair
  maxFollow: 0.4,       // the venue moved under 40% of the way
  maxSpread: 0.03,
  minEv: 0.01,          // a steaming side is worth a bet from 1% EV (a standing gap needs 2%)
};

const r4 = x => Math.round(x * 1e4) / 1e4;

function optsFromEnv(env = process.env) {
  const o = {};
  const f = k => { const v = parseFloat(env[k]); return Number.isFinite(v) ? v : null; };
  if (f('STEAM_WINDOW_MIN') != null) o.windowMs = f('STEAM_WINDOW_MIN') * 60e3;
  if (f('STEAM_MIN_MOVE') != null) o.minMove = f('STEAM_MIN_MOVE');
  if (f('STEAM_MIN_EV') != null) o.minEv = f('STEAM_MIN_EV');
  return o;
}

function createSteamWatch(opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const hist = new Map();   // side id → [{ t, fair, cost }], oldest first

  // quotes: Map id → { fair, cost, spread }
  function observe(quotes, now = Date.now()) {
    const cut = now - o.windowMs;
    for (const [id, q] of quotes) {
      if (q.fair == null || q.cost == null || !(q.spread <= o.maxSpread + 1e-9)) continue;
      if (!hist.has(id)) hist.set(id, []);
      const h = hist.get(id);
      while (h.length && h[h.length - 1].fair > q.fair + 1e-12) h.pop();
      h.push({ t: now, fair: q.fair, cost: q.cost });
      while (h.length && h[0].t < cut) h.shift();
    }
    for (const [id, h] of hist) {
      while (h.length && h[0].t < cut) h.shift();
      if (!h.length) hist.delete(id);
    }
  }

  // The move into `fair` at `cost` now, or null when the side isn't steaming.
  function steamOf(id, fair, cost, now = Date.now()) {
    const h = hist.get(id);
    if (!h || fair == null || cost == null) return null;
    let low = null;
    for (const p of h) if (p.t >= now - o.windowMs && p.t < now && (!low || p.fair < low.fair)) low = p;
    if (!low) return null;
    const move = fair - low.fair;
    if (move < o.minMove - 1e-9) return null;
    const follow = cost - low.cost;
    if (follow > o.maxFollow * move + 1e-9) return null;
    return { from: r4(low.fair), to: r4(fair), move: r4(move), costFrom: r4(low.cost), follow: r4(follow), sinceMs: now - low.t, at: new Date(low.t).toISOString() };
  }

  // Every steaming side in `quotes`, biggest move first: what to read the live book for.
  function candidates(quotes, now = Date.now()) {
    const out = [];
    for (const [id, q] of quotes) {
      const s = steamOf(id, q.fair, q.cost, now);
      if (s && q.fair / q.cost - 1 >= o.minEv) out.push({ id, ...q, steam: s });
    }
    return out.sort((a, b) => b.steam.move - a.steam.move);
  }

  // the history as backup docs: { id, h: [[t, fair, cost], ...] }
  function dump() {
    return [...hist].map(([id, h]) => ({ id, h: h.map(p => [p.t, r4(p.fair), r4(p.cost)]) }));
  }
  // back from a backup: points still inside the window, merged by time into
  // whatever this container has seen since it booted → sides restored
  let restored = 0;
  function load(docs = [], now = Date.now()) {
    const cut = now - o.windowMs;
    let n = 0;
    for (const d of docs) {
      if (!d || d.id == null || !Array.isArray(d.h)) continue;
      const pts = d.h.filter(p => Array.isArray(p) && p[0] >= cut && p[0] <= now && Number.isFinite(p[1]) && Number.isFinite(p[2]))
        .map(([t, fair, cost]) => ({ t, fair, cost }));
      if (!pts.length) continue;
      const merged = [...pts, ...(hist.get(d.id) || [])].sort((a, b) => a.t - b.t);
      const h = [];
      for (const p of merged) {
        while (h.length && h[h.length - 1].fair > p.fair + 1e-12) h.pop();
        h.push(p);
      }
      hist.set(d.id, h);
      n++;
    }
    restored += n;
    return n;
  }

  return { observe, steamOf, candidates, dump, load, size: () => hist.size, points: () => [...hist.values()].reduce((a, h) => a + h.length, 0), restored: () => restored, opts: o };
}

// "moved 48¢ → 53¢ in 6 min, Kalshi still 49¢"
function moveText(s, venueName, refName = 'Polymarket') {
  const c = x => `${Math.round(x * 1000) / 10}¢`;
  const mins = Math.max(1, Math.round(s.sinceMs / 60e3));
  return `${refName} moved ${c(s.from)} → ${c(s.to)} in ${mins} min, ${venueName} ${Math.abs(s.follow) < 0.005 ? 'hasn\'t moved' : `moved ${s.follow > 0 ? '+' : ''}${c(s.follow)}`}`;
}

module.exports = { createSteamWatch, moveText, optsFromEnv, DEFAULTS };
