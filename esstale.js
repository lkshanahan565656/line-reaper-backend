// ─── ESPORTS STALE LINES: ONE PICK'EM APP MOVED, THE OTHERS HAVEN'T ──────────
// Esports kill props have no sharp book behind them: Pinnacle posts no player
// lines. So the leader here is whichever app moves first. When Underdog moves
// a player's kill line (or bends its payouts) and PrizePicks or Sleeper is
// still on the number Underdog just left, the unmoved app is stale. No model
// prices these rows: a row's edge is the leader's new number against the
// follower's old one.
//
// This module:
//   1. keeps each app's last quote on each subject (a player's stat over a map
//      span in one match): its line and the mean that quote implies on the
//      board's curve (esmarket.consensus), with the time it was read
//   2. calls a MOVE when an app's chance of the over at its own old line, read
//      on its new quote, shifts by moveProbPts or more (a one-kill CS line
//      move is about 6 points, a PrizePicks half-kill about 3, Sleeper's
//      cent-by-cent payout drift under 1)
//   3. follows every other app quoting the subject at the move for an hour:
//      FOLLOWED when its own mean moves followFrac of the leader's move the
//      same way (the lag is the time to that read), OPPOSITE when it moves as
//      far the other way, PULLED when it takes the line down. An app that
//      already moved that way in the ledMs before, or already sat at least
//      half way to the leader's new number, is AHEAD, not stale.
//   4. lists each app still on its pre-move quote while the move is under an
//      hour old and the leader hasn't moved back: the follower's own number
//      priced on the leader's new mean (priceApp supplies the payout math).
// Pure state; the server feeds it after every esports board build.

const DEFAULTS = {
  moveProbPts: 3,          // a move: the app's chance at its own old line shifts this much
  followFrac: 0.5,         // a follower moves this share of the leader's move, in mean
  windowMs: 60 * 60e3,     // a move is followed (and its stale rows shown) for an hour
  ledMs: 10 * 60e3,        // an app that moved the same way this long before led it
  minEv: 2,
  maxEv: 30,               // past this a row is a mismatched subject, not a stale line
  logMs: 2 * 86400e3,      // closed moves kept for the lag table
  logCap: 5000,
  histMs: 2 * 3600e3,      // each app's recent moves, for the AHEAD check
};
const APPS = ['prizepicks', 'underdog', 'sleeper'];
const BOOK_APP = { PP: 'prizepicks', UD: 'underdog', SL: 'sleeper' };

const { probToAmerican } = require('./ev');

const r1 = x => Math.round(x * 10) / 10;

function createEsStale(opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const last = new Map();      // key → { app → { line, mean, t, cell } }
  const metaOf = new Map();    // key → { sport, player, market, event, start, probAt }
  const recent = new Map();    // `${key}|${app}` → [{ t, dir }]
  const open = [];             // moves being followed
  const log = [];              // closed moves (one entry per leader → follower)
  const lastRead = {};         // app → last read time fed

  // the chance of the over at line x on mean m, from the subject's own curve
  const pAt = (key, m, x) => { const f = metaOf.get(key)?.probAt; const v = f ? f(m, x) : null; return Number.isFinite(v) ? v : null; };

  function close(mv, app, status, t) {
    const f = mv.followers[app];
    if (!f || f.status !== 'waiting') return;
    f.status = status; f.at = t;
    if (status === 'followed' || status === 'opposite') f.lagMin = r1((t - mv.t) / 60e3);
    log.push({ t: mv.t, key: mv.key, sport: mv.sport, leader: mv.leader, app, status, lagMin: f.lagMin ?? null, dPts: mv.dPts });
  }

  // quotes: [{ key, app, line, mean, cell, meta: { sport, player, market, event, start, probAt(m, x) } }]
  // for ONE app's read at time t: that app's whole esports board. A subject
  // the app quoted before and leaves out now has been taken down.
  function observe(app, quotes, t) {
    if (!APPS.includes(app)) return;
    lastRead[app] = t;
    const seen = new Set();
    for (const q of quotes || []) {
      if (q.app !== app || !(q.line > 0) || !Number.isFinite(q.mean)) continue;
      seen.add(q.key);
      if (q.meta) metaOf.set(q.key, q.meta);
      const per = last.get(q.key) || new Map();
      last.set(q.key, per);
      const prev = per.get(app);
      const cur = { line: q.line, mean: q.mean, t, cell: q.cell || null };
      per.set(app, cur);
      // this app following (or running against) open moves on the subject
      let followedNow = false;
      for (const mv of open) {
        if (mv.key !== q.key) continue;
        const f = mv.followers[app];
        if (f?.status === 'waiting') {
          const shift = (q.mean - f.mean0) * mv.dir;
          if (shift >= o.followFrac * mv.dMean) { close(mv, app, 'followed', t); followedNow = true; }
          else if (-shift >= o.followFrac * mv.dMean) close(mv, app, 'opposite', t);
        }
        // the leader moving back half way ends the move
        if (mv.leader === app && !mv.endedAt && (mv.mean1 - q.mean) * mv.dir >= o.followFrac * mv.dMean) mv.endedAt = t;
      }
      if (!prev) continue;
      const p0 = pAt(q.key, prev.mean, prev.line), p1 = pAt(q.key, q.mean, prev.line);
      if (p0 == null || p1 == null) continue;
      const dPts = (p1 - p0) * 100;
      if (Math.abs(dPts) < o.moveProbPts) continue;
      const dir = Math.sign(dPts);
      // an app catching up with another's move is a follow, not a new lead
      if (followedNow) continue;
      const rk = `${q.key}|${app}`;
      const hist = (recent.get(rk) || []).filter(x => t - x.t <= o.histMs);
      hist.push({ t, dir }); recent.set(rk, hist);
      const meta = metaOf.get(q.key) || {};
      const followers = {};
      for (const [b, c] of per) {
        if (b === app) continue;
        // led: b moved this way in the ledMs before; ahead: b already sits half way or more to the new number
        const led = (recent.get(`${q.key}|${b}`) || []).some(x => x.dir === dir && t - x.t <= o.ledMs);
        const ahead = (c.mean - prev.mean) * dir >= o.followFrac * Math.abs(q.mean - prev.mean);
        followers[b] = { mean0: c.mean, line0: c.line, status: led ? 'led' : ahead ? 'ahead' : 'waiting' };
        if (led || ahead) log.push({ t, key: q.key, sport: meta.sport, leader: app, app: b, status: led ? 'led' : 'ahead', lagMin: null, dPts: r1(dPts) });
      }
      // a fresh move by the same app on the same subject replaces the old one
      for (const mv of open) if (mv.key === q.key && mv.leader === app && !mv.endedAt) mv.endedAt = t;
      open.push({ key: q.key, sport: meta.sport, leader: app, t, dir, dPts: r1(dPts), dMean: Math.abs(q.mean - prev.mean),
        line0: prev.line, line1: q.line, mean0: prev.mean, mean1: q.mean, cell0: prev.cell, cell1: q.cell || null, followers });
    }
    // taken down: every subject this app quoted before and didn't now
    for (const [key, per] of last) {
      if (!per.has(app) || seen.has(key)) continue;
      per.delete(app);
      for (const mv of open) if (mv.key === key) close(mv, app, 'pulled', t);
      if (!per.size) { last.delete(key); metaOf.delete(key); }
    }
  }

  // drop moves past their window (followers still waiting never followed)
  function step(t) {
    for (let i = open.length - 1; i >= 0; i--) {
      const mv = open[i];
      const start = Date.parse(metaOf.get(mv.key)?.start || '');
      if (t - mv.t < o.windowMs && !(start <= t)) continue;
      for (const [b, f] of Object.entries(mv.followers)) if (f.status === 'waiting') { f.status = 'none'; log.push({ t: mv.t, key: mv.key, sport: mv.sport, leader: mv.leader, app: b, status: 'none', lagMin: null, dPts: mv.dPts }); }
      open.splice(i, 1);
    }
    while (log.length > o.logCap || (log.length && t - log[0].t > o.logMs)) log.shift();
    for (const [k, h] of recent) { const kept = h.filter(x => t - x.t <= o.histMs); if (kept.length) recent.set(k, kept); else recent.delete(k); }
  }

  // stale rows now. priceApp(app, fair 0-1, cell, side 'Over'|'Under', line)
  // → { ev, decimal, entry?, entries? } | null
  function rows(t, { priceApp } = {}) {
    const out = [];
    for (const mv of open) {
      if (mv.endedAt || t - mv.t >= o.windowMs) continue;
      const meta = metaOf.get(mv.key) || {};
      if (Date.parse(meta.start || '') <= t) continue;
      const per = last.get(mv.key);
      const lead = per?.get(mv.leader);
      if (!lead) continue;
      // the apps disagree: another app moved this subject the other way within the hour
      if (open.some(x => x !== mv && x.key === mv.key && !x.endedAt && x.dir !== mv.dir && t - x.t < o.windowMs)) continue;
      for (const [b, f] of Object.entries(mv.followers)) {
        if (f.status !== 'waiting') continue;
        const c = per.get(b);
        if (!c) continue;
        const side = mv.dir > 0 ? 'Over' : 'Under';
        const pOver = pAt(mv.key, lead.mean, c.line);
        if (pOver == null) continue;
        const fair = side === 'Over' ? pOver : 1 - pOver;
        // the follower's own read of its number, before and now
        const pre = pAt(mv.key, f.mean0, c.line);
        const priced = priceApp ? priceApp(b, fair, c.cell || {}, side, c.line) : null;
        if (!priced || !Number.isFinite(priced.ev) || priced.ev > o.maxEv) continue;
        out.push({
          key: mv.key, sport: mv.sport, player: meta.player, market: meta.market, event: meta.event, start: meta.start, team: meta.team || '',
          app: b, line: c.line, side, fairProb: r1(fair * 100), fairPrice: probToAmerican(fair), preFair: pre == null ? null : r1((side === 'Over' ? pre : 1 - pre) * 100),
          ev: +priced.ev.toFixed(2), decimal: priced.decimal ?? null, entry: priced.entry || null, entries: priced.entries || null,
          mult: side === 'Over' ? c.cell?.over ?? null : c.cell?.under ?? null,
          leader: mv.leader, leadPre: mv.line0, leadPost: lead.line, leadPreCell: mv.cell0, leadPostCell: lead.cell, dPts: mv.dPts,
          moveAt: new Date(mv.t).toISOString(), mins: Math.max(0, Math.round((t - mv.t) / 60e3)),
          readMins: lastRead[b] ? Math.max(0, Math.round((t - lastRead[b]) / 60e3)) : null,
          leadReadMins: lastRead[mv.leader] ? Math.max(0, Math.round((t - lastRead[mv.leader]) / 60e3)) : null,
          clears: priced.ev >= o.minEv,
        });
      }
    }
    // one row per app and subject: the newest move behind it
    const best = new Map();
    for (const r of out) { const k = `${r.key}|${r.app}`; const b = best.get(k); if (!b || r.moveAt > b.moveAt) best.set(k, r); }
    return [...best.values()].sort((a, b) => b.ev - a.ev);
  }

  // how often each app leads and how fast the others follow, from closed moves
  function lagSummary(t = Date.now()) {
    const cells = {};
    for (const e of log) {
      const k = `${e.leader}>${e.app}`;
      const c = cells[k] = cells[k] || { leader: e.leader, app: e.app, moves: 0, followed: 0, opposite: 0, pulled: 0, none: 0, led: 0, ahead: 0, lags: [] };
      c.moves++; c[e.status] = (c[e.status] || 0) + 1;
      if (e.status === 'followed') c.lags.push(e.lagMin);
    }
    const leads = {};
    for (const e of log) { const s = leads[e.leader] = leads[e.leader] || new Set(); s.add(`${e.key}|${e.t}`); }
    const out = Object.values(cells).map(c => {
      const lags = c.lags.sort((a, b) => a - b);
      const moved = c.followed + c.opposite;
      return { leader: c.leader, app: c.app, moves: c.moves, followed: c.followed, opposite: c.opposite, pulled: c.pulled, none: c.none, led: c.led, ahead: c.ahead,
        sameWayPct: moved ? Math.round(100 * c.followed / moved) : null,
        medianMin: lags.length ? lags[Math.floor(lags.length / 2)] : null,
        within2: c.moves ? Math.round(100 * lags.filter(x => x <= 2).length / c.moves) : null,
        within15: c.moves ? Math.round(100 * lags.filter(x => x <= 15).length / c.moves) : null };
    }).sort((a, b) => b.moves - a.moves);
    const first = log.length ? log[0].t : t;
    return { lag: out, leads: Object.fromEntries(Object.entries(leads).map(([a, s]) => [a, s.size])), open: open.filter(m => !m.endedAt).length,
      hours: +((t - first) / 3600e3).toFixed(2), reads: Object.fromEntries(Object.entries(lastRead).map(([a, x]) => [a, new Date(x).toISOString()])),
      thresholds: { moveProbPts: o.moveProbPts, followFrac: o.followFrac, windowMin: o.windowMs / 60e3 } };
  }

  return { observe, step, rows, lagSummary, state: () => ({ subjects: last.size, open: open.length, log: log.length }) };
}

// The pick's quotes, one per app, from the board's market consensus
// (p.marketQuotes: { book: 'PP'|'UD'|'SL', line, pOver, mean }). cellOf(p, book)
// gives the app's payout cell for pricing.
// one player's stat over one map span in one match
const subjectKey = p => `${String(p.sport || '').toUpperCase()}|${String(p.player || '').toLowerCase().replace(/[^a-z0-9]/g, '')}|${p.market}|${p.gameId ?? String(p.startTime || '').slice(0, 10)}`;
function pickQuotes(p, { probAt, cellOf = () => null } = {}) {
  const out = [];
  if (!p || !Array.isArray(p.marketQuotes) || !p.player || !p.startTime) return out;
  const key = subjectKey(p);
  const meta = { sport: p.sport, player: p.player, team: p.team || '', market: p.displayMarket || p.market, event: p.matchTitle || '', start: p.startTime, probAt: (m, x) => probAt(p, m, x) };
  for (const q of p.marketQuotes) {
    const app = BOOK_APP[q.book];
    if (!app || !(q.line > 0) || !Number.isFinite(q.mean)) continue;
    out.push({ key, app, line: q.line, mean: q.mean, cell: cellOf(p, q.book), meta });
  }
  return out;
}

module.exports = { DEFAULTS, APPS, BOOK_APP, createEsStale, pickQuotes, subjectKey };
