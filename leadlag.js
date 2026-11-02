// ─── KALSHI MOVES FIRST: POLYMARKET US STILL AT THE OLD PRICE ────────────────
// A lead with its own record, never an alert. The lead-lag study (10-24 to
// 10-26, /mnt/project-files/line-reaper/checks/lead-lag-2026-10-24/) found:
//
//   history, 3,278 Kalshi/Polymarket game lines, Sep 24 to Oct 14, 1-minute
//   prices: Kalshi moves first. After a Kalshi move of 3c+ in 5 minutes,
//   Polymarket had made half of it within 2 minutes 41% of the time and within
//   an hour 59%; Kalshi gave its move back 5 to 14%. Polymarket's own moves
//   were noise (Kalshi followed 8%, Polymarket gave back 40%).
//
//   live, 1-minute recorder, Oct 24 to 26, every venue: Polymarket US made half
//   of Kalshi's move within 15 minutes 74% of the time (23 moves, 16 games);
//   taking Polymarket US at its price a minute after the move beat its own
//   close by +0.95c (t 1.4), results +16c a contract on 16 graded. Far under
//   50, not proven. Gemini did not follow Kalshi (0 of 5), and every other
//   laggard (Kalshi, Gemini, Polymarket US behind Pinnacle, FanDuel or
//   BetRivers) lost to its own close.
//
// So this records the one pair worth a record: Kalshi moves, Polymarket US has
// not, the Polymarket US side Kalshi moved toward at its price then. Graded on
// Pinnacle's close at the same number (the exchange books' grade) and on the
// ESPN final, judged at 50 graded. Identical for everyone; no alerts.
//
// A move: Kalshi's cost for a side up moveMin (3c) or more against its price
// up to windowMs (10 min) back, the other side's cost down at least half that
// (the whole market moved, not one side's ask), still there holdMs (3 min)
// later; Polymarket US's cost for the side up under half Kalshi's move since
// the window began. One flag per side an hour.
//
// Pure: observe(screen) takes the odds screen (oddsscreen.build) each minute
// and returns new flags as +EV-screen-shaped rows for an evtrack tracker.

const { canonName } = require('./ev');

const MARKET = { ml: 'h2h', spread: 'spreads', total: 'totals' };
const { r4 } = require('./mathutil');
const implied = v => (v && v.decimal > 1 ? 1 / v.decimal : null);

// the +EV screen's market group and side names for an odds-screen side
function groupOf(g, m, s) {
  const day = g.start ? String(g.start).slice(0, 10) : '';
  const eventId = `${canonName(g.away)}@${canonName(g.home)}|${day}`;
  const market = MARKET[m.key];
  if (!market) return null;
  if (market === 'h2h') return { group: `${eventId}|h2h`, side: s.name, market, point: null };
  if (m.point == null) return null;
  if (market === 'totals') return { group: `${eventId}|totals|${m.point}`, side: s.name, market, point: m.point };
  // spreads: m.point is home's number
  const p = s.name === g.home ? m.point : -m.point;
  return { group: `${eventId}|spreads|${m.point}`, side: `${s.name} ${p > 0 ? '+' : ''}${p}`, market, point: p };
}

function createLeadLag({ leader = 'kalshi', followers = ['polymarketus'], moveMin = 0.03, windowMs = 10 * 60e3, holdMs = 3 * 60e3,
  followFrac = 0.5, cooldownMs = 60 * 60e3, keepMs = 2 * 3600e3 } = {}) {
  const hist = new Map();      // side id → [[t, leaderCost, otherLeaderCost, { follower: cost }]]
  const pending = new Map();   // side id → { t, from, to, fol: { follower: cost at window start } }
  const lastFlag = new Map();  // `${id}|${follower}` → t
  const stats = { observed: 0, moves: 0, flags: 0, dropped: { gaveBack: 0, followed: 0, started: 0 } };

  function observe(screen, now = Date.now()) {
    const out = [];
    stats.observed++;
    for (const g of screen?.games || []) {
      const start = Date.parse(g.start || '');
      if (!(start > now)) continue;
      for (const m of g.markets || []) {
        const two = m.sides?.length === 2;
        for (const s of m.sides || []) {
          const vs = Object.fromEntries((s.venues || []).filter(v => !v.lineDiffers).map(v => [v.venue, v]));
          const L = implied(vs[leader]);
          if (L == null) continue;
          const other = two ? m.sides.find(x => x !== s) : null;
          const Lo = other ? implied((other.venues || []).find(v => v.venue === leader && !v.lineDiffers)) : null;
          const id = `${g.id}|${m.key}|${m.point ?? ''}|${s.name}`;
          const fol = {};
          for (const f of followers) { const c = implied(vs[f]); if (c != null) fol[f] = c; }
          let h = hist.get(id);
          if (!h) hist.set(id, (h = []));
          h.push([now, L, Lo, fol]);
          while (h.length && now - h[0][0] > windowMs + holdMs + 60e3) h.shift();

          // a move held long enough: flag each follower still behind it
          const p = pending.get(id);
          if (p && now - p.t >= holdMs) {
            pending.delete(id);
            const move = p.to - p.from;
            if (L - p.from < (2 / 3) * move) { stats.dropped.gaveBack++; continue; }
            for (const f of followers) {
              const c = fol[f], c0 = p.fol[f];
              if (c == null || c0 == null) continue;
              if (c - c0 >= followFrac * move) { stats.dropped.followed++; continue; }
              const key = `${id}|${f}`;
              if (now - (lastFlag.get(key) || -Infinity) < cooldownMs) continue;
              lastFlag.set(key, now);
              const gs = groupOf(g, m, s);
              if (!gs) continue;
              const v = vs[f];
              stats.flags++;
              out.push({
                ...gs, sport: g.league, event: `${g.away} @ ${g.home}`, start: g.start, book: f, price: v.american, decimal: v.decimal,
                source: 'kalshi-lead', fairProb: s.fair != null ? r4(s.fair * 100) : null,
                // EV against Pinnacle's no-vig where it prices the side (information only: every flag is logged)
                ev: s.fair != null ? r4((s.fair * v.decimal - 1) * 100) : 0,
                lead: { venue: leader, from: r4(p.from), to: r4(L), movedAt: new Date(p.t).toISOString(), followerFrom: r4(c0), followerNow: r4(c), url: v.url || null },
              });
            }
            continue;
          }
          if (p || now - (lastFlag.get(`${id}|${followers[0]}`) || -Infinity) < cooldownMs) continue;
          // a fresh move: against the oldest price in the window
          const base = h.find(x => now - x[0] <= windowMs);
          if (!base || base === h[h.length - 1]) continue;
          const move = L - base[1];
          if (move < moveMin) continue;
          if (two && (Lo == null || base[2] == null || base[2] - Lo < move / 2)) continue;
          stats.moves++;
          pending.set(id, { t: now, from: base[1], to: L, fol: { ...base[3] } });
        }
      }
    }
    // forget sides whose game is long gone
    for (const [id, h] of hist) if (!h.length || now - h[h.length - 1][0] > keepMs) { hist.delete(id); pending.delete(id); }
    for (const [k, t] of lastFlag) if (now - t > keepMs + cooldownMs) lastFlag.delete(k);
    return out;
  }
  return { observe, stats: () => ({ ...stats, sides: hist.size, pending: pending.size }) };
}

module.exports = { createLeadLag, groupOf };
