// ─── STALE LINES: BOOKS AND APPS STILL ON THE NUMBER PINNACLE JUST LEFT ──────
// Pinnacle takes the sharpest money and moves first. A US book or pick'em app
// that hasn't moved yet is still dealing the old number, and for a while that
// number is priced off a market that no longer exists. This module:
//
//   1. keeps a rolling history of every source's line on every subject (a
//      game's moneyline, spread or total; a player's prop), changes only, with
//      the time each was read: Pinnacle, FanDuel, BetRivers, Kalshi's mids,
//      PrizePicks, Underdog and Sleeper
//   2. calls a Pinnacle MOVE when its chance at its old number shifts by
//      moveProbPts (2 points of win chance), or its number moves half a point
//      or more and that chance shifts lineMovePts (1 point) with it
//   3. follows every venue that was quoting the subject at the move: the
//      minutes until it moved the same way (by half Pinnacle's move, at least
//      a point at the old number) are its LAG; a venue that had already moved
//      that way in the 10 minutes before is a LEADER, not stale
//   4. lists each venue still on its pre-move quote while the move is under an
//      hour old: its price against Pinnacle's post-move fair at the venue's
//      own number. A row CLEARS at minEv when another sharp source (Kalshi,
//      FanDuel or BetRivers, never the venue itself) moved the same way since
//      15 minutes before; a Pinnacle-only move is shown, marked single-source,
//      and never counts.
//
// Every number is read the way the feeds deliver it: Pinnacle's and the books'
// game lines once a minute in one pass (Pinnacle first), FanDuel's props every
// other minute, Pinnacle's props every other minute, the apps at their own
// scrape times. A lag shorter than a read cycle shows as 0 minutes, so the
// lag table is a floor on how fast the free feeds let us see a venue follow.
// Pure state plus pure quote builders; the server feeds it.

const { americanToDecimal, probToAmerican, canonName } = require('./ev');
const { pOver, meanFor } = require('./sportprops');
const { normalCdf } = require('./dist');
const { probit, SD } = require('./altlines');

const DEFAULTS = {
  moveProbPts: 2,          // a move: Pinnacle's chance at its old number shifts this much
  lineMovePts: 1,          // or its number moves ≥ 0.5 and the chance shifts this much
  windowMs: 60 * 60e3,     // a move is followed (and its stale rows shown) for an hour
  followFrac: 0.5,         // a venue follows when it moves this share of Pinnacle's move
  minFollowPts: 1,         // and at least this many points at the old number
  ledMs: 10 * 60e3,        // a venue that moved this long before Pinnacle led it
  confirmLookbackMs: 15 * 60e3,
  minEv: 2,                // % past the post-move fair, as on the +EV tab
  maxEv: 25,               // past this a row is a bad match, not a stale line
  minShowEv: 0,
  keepMs: 3 * 3600e3,      // history kept per source and subject
  histCap: 40,
  logMs: 2 * 86400e3,      // closed moves kept for the lag table
  logCap: 20000,
  venueMaxAgeMs: { fanduel: 6 * 60e3, betrivers: 6 * 60e3, prizepicks: 25 * 60e3, underdog: 20 * 60e3, sleeper: 20 * 60e3 },
  // Pinnacle's quote stops being the fair this long after its last read, as on
  // the +EV board (game lines 5 minutes, props 10)
  pinMaxAgeMs: { game: 5 * 60e3, prop: 10 * 60e3 },
  sportKey: null,          // the board's sport name → the key rows carry ('NFL' → 'nfl')
};
const BOOK_VENUES = ['fanduel', 'betrivers'];
const APP_VENUES = ['prizepicks', 'underdog', 'sleeper'];
const VENUES = [...BOOK_VENUES, ...APP_VENUES];
const CONFIRM = ['kalshi', 'fanduel', 'betrivers'];

const r1 = x => Math.round(x * 10) / 10;
const r2 = x => Math.round(x * 100) / 100;
const r4 = x => Math.round(x * 1e4) / 1e4;
const ms = t => { const x = typeof t === 'number' ? t : Date.parse(t || ''); return Number.isFinite(x) ? x : null; };
// the game's day on the US clock (6 hours behind UTC), so one player's two games stay apart
const dayOf = t => { const x = ms(t); return x == null ? '' : new Date(x - 6 * 3600e3).toISOString().slice(0, 10); };
const zToP = z => normalCdf(z, 0, 1);
// one player's stat in one game, the same from every source
const propKey = (sport, player, mkey, start) => `${sport}|${canonName(player)}|${mkey}|${dayOf(start)}`;
const toP = d => (d > 1 ? 1 / d : null);

// power devig of a two-way pair of decimals → P(first side)
function devig2(d0, d1) {
  const a = toP(d0), b = toP(d1);
  if (!(a > 0 && b > 0)) return null;
  if (a + b <= 1) return a / (a + b);
  let lo = 1, hi = 3;
  for (let i = 0; i < 50; i++) { const k = (lo + hi) / 2; if (a ** k + b ** k > 1) lo = k; else hi = k; }
  return a ** ((lo + hi) / 2);
}

// ── QUOTES ──
// A quote is one source's line on one subject:
//   { kind: 'ml', p, d0, d1 }                         P(home), decimals home / away
//   { kind: 'spread'|'total', sd, pts: [{ x, p, d0, d1 }] }
//        spread: x = the home side's points, p = P(home covers)
//        total:  x = −line, p = P(over)   (both rise with x)
//   { kind: 'prop', mkey, sport, pts: [{ x: line, p: P(over), d0, d1, cell }] }
// side 0 is home / over, side 1 away / under.

// the chance of side 0 at number x: exact where the source posts x, else
// interpolated in z between its numbers, else stretched at the sport's slope
// (games) or read on the stat's curve from its nearest line (props)
function pAt(q, x) {
  if (!q) return null;
  if (q.kind === 'ml') return q.p;
  const pts = (q.pts || []).filter(a => a.p > 0 && a.p < 1);
  if (!pts.length) return null;
  const hit = pts.find(a => Math.abs(a.x - x) < 1e-9);
  if (hit) return hit.p;
  if (q.kind === 'prop') {
    const near = pts.reduce((b, a) => (Math.abs(a.x - x) < Math.abs(b.x - x) ? a : b));
    const m = meanFor(q.mkey, q.sport, near.x, near.p);
    return m == null ? null : pOver(q.mkey, q.sport, m, x);
  }
  const zs = pts.map(a => ({ x: a.x, z: probit(a.p) })).sort((a, b) => a.x - b.x);
  const hi = zs.findIndex(a => a.x > x);
  if (hi > 0) { const a = zs[hi - 1], b = zs[hi]; return zToP(a.z + (b.z - a.z) * (x - a.x) / (b.x - a.x)); }
  const end = hi === 0 ? zs[0] : zs[zs.length - 1];
  if (!(q.sd > 0) || Math.abs(x - end.x) > q.sd) return null;
  return zToP(end.z + (x - end.x) / q.sd);
}
// a source's chance at x, read off its own number and Pinnacle's slope:
// Pinnacle's curve shifted (in z) to pass through the source's main line.
// A source posting x itself is read there.
function shiftedAt(q, pin, x) {
  if (!q) return null;
  if (q.kind === 'ml') return q.p;
  const own = (q.pts || []).find(a => Math.abs(a.x - x) < 1e-9 && a.p > 0 && a.p < 1);
  if (own) return own.p;
  const m = mainOf(q);
  const a = pin ? pAt(pin, x) : null, b = pin && m ? pAt(pin, m.x) : null;
  if (a == null || b == null || !(m.p > 0 && m.p < 1) || !(a > 0 && a < 1) || !(b > 0 && b < 1)) return pAt(q, x);
  return zToP(probit(a) + probit(m.p) - probit(b));
}
// the source's own number: the line nearest even money
function mainOf(q) {
  if (!q) return null;
  if (q.kind === 'ml') return { x: null, p: q.p, d0: q.d0, d1: q.d1 };
  const pts = q.pts || [];
  if (!pts.length) return null;
  return pts.reduce((b, a) => (Math.abs(a.p - 0.5) < Math.abs(b.p - 0.5) ? a : b));
}
// what has to change for "still on the old number" to stop being true
function fingerprint(q) {
  const m = mainOf(q);
  if (!m) return '';
  const c = m.cell ? `${m.cell.over ?? ''}/${m.cell.under ?? ''}/${m.cell.overOpen ? 1 : 0}${m.cell.underOpen ? 1 : 0}` : '';
  return `${m.x ?? ''}|${m.d0 != null ? r4(m.d0) : ''}|${m.d1 != null ? r4(m.d1) : ''}|${c}|${m.p != null && m.d0 == null ? r4(m.p) : ''}`;
}

// Odds API game (freebooks / kalshiMidBooks shape) → [{ key, source, q, meta }]
// for Pinnacle, FanDuel, BetRivers and Kalshi's mids. feedSport: 'nfl', …
// league: the board's name for the sport ('NFL', 'CFB'), shown on the rows
function gameQuotes(games, feedSport, { sources = ['pinnacle', 'fanduel', 'betrivers', 'kalshi_mid'], league = null } = {}) {
  const out = [];
  const sd = SD[feedSport] || null;
  for (const g of games || []) {
    const home = g.home_team, away = g.away_team;
    const base = { sport: league || feedSport, event: `${away} @ ${home}`, home, away, start: g.commence_time, gameId: g.id };
    for (const bm of g.bookmakers || []) {
      if (!sources.includes(bm.key)) continue;
      const source = bm.key === 'kalshi_mid' ? 'kalshi' : bm.key;
      for (const m of bm.markets || []) {
        if (m.key === 'h2h') {
          const h = m.outcomes.find(o => o.name === home), a = m.outcomes.find(o => o.name === away);
          if (!h || !a || m.outcomes.length !== 2) continue;
          const d0 = americanToDecimal(h.price), d1 = americanToDecimal(a.price), p = devig2(d0, d1);
          if (p == null) continue;
          out.push({ key: `${g.id}|ml`, source, q: { kind: 'ml', p: r4(p), d0, d1 }, meta: { ...base, kind: 'ml', market: 'moneyline' } });
        } else if (m.key === 'spreads' || m.key === 'totals') {
          const kind = m.key === 'spreads' ? 'spread' : 'total';
          const by = new Map();
          for (const o of m.outcomes || []) {
            if (o.point == null) continue;
            const s0 = kind === 'total' ? o.name === 'Over' : o.name === home;
            if (kind === 'spread' && o.name !== home && o.name !== away) continue;
            const x = kind === 'total' ? -o.point : (s0 ? o.point : -o.point);
            if (!by.has(x)) by.set(x, {});
            by.get(x)[s0 ? 'd0' : 'd1'] = americanToDecimal(o.price);
          }
          const pts = [];
          for (const [x, d] of by) { const p = devig2(d.d0, d.d1); if (p != null) pts.push({ x, p: r4(p), d0: d.d0, d1: d.d1 }); }
          if (!pts.length) continue;
          out.push({ key: `${g.id}|${kind}`, source, q: { kind, sd: sd ? sd[kind === 'spread' ? 0 : 1] : null, pts }, meta: { ...base, kind, market: kind } });
        }
      }
    }
  }
  return out;
}
// the books' two-way player props in the same games → prop quotes
// sportOf(feedSport) → the board's sport ('NFL', 'CFB', …)
function bookPropQuotes(games, feedSport, sportOf, { books = BOOK_VENUES } = {}) {
  const sport = sportOf(feedSport);
  if (!sport) return [];
  const out = [];
  for (const g of games || []) {
    for (const bm of g.bookmakers || []) {
      if (!books.includes(bm.key)) continue;
      const by = new Map();
      for (const m of bm.markets || []) {
        if (/^(h2h|spreads|totals)$/.test(m.key)) continue;
        for (const o of m.outcomes || []) {
          if (!o.description || o.point == null) continue;
          const k = `${canonName(o.description)}|${m.key}`;
          if (!by.has(k)) by.set(k, { player: o.description, mkey: m.key, lines: new Map() });
          const L = by.get(k).lines;
          if (!L.has(o.point)) L.set(o.point, {});
          L.get(o.point)[o.name === 'Over' ? 'd0' : 'd1'] = americanToDecimal(o.price);
        }
      }
      for (const [k, v] of by) {
        const pts = [];
        for (const [x, d] of v.lines) { const p = devig2(d.d0, d.d1); if (p != null) pts.push({ x: Number(x), p: r4(p), d0: d.d0, d1: d.d1 }); }
        if (!pts.length) continue;
        out.push({ key: propKey(sport, v.player, v.mkey, g.commence_time), source: bm.key, q: { kind: 'prop', mkey: v.mkey, sport, pts },
          meta: { sport, kind: 'prop', market: v.mkey, player: v.player, event: `${g.away_team} @ ${g.home_team}`, start: g.commence_time } });
      }
    }
  }
  return out;
}
// pinprops rows → Pinnacle prop quotes
function pinPropQuotes(props) {
  return (props || []).map(p => ({ key: propKey(p.sport, p.player, p.mkey, p.start), source: 'pinnacle',
    q: { kind: 'prop', mkey: p.mkey, sport: p.sport, pts: [{ x: p.line, p: p.pOver, d0: americanToDecimal(p.over), d1: americanToDecimal(p.under) }] },
    meta: { sport: p.sport, kind: 'prop', market: p.mkey, player: p.player, start: p.start } }));
}
// the props board's sports rows → app quotes (each app's line, its own chance
// at it where its payouts say one, else even money) and Kalshi's ladder
// pOverOf(book, cell) → the app's P(over) or null; kalshiOf(row) → Map line → P(over)
function appQuotes(rows, { pOverOf, kalshiOf = null } = {}) {
  const out = [];
  for (const row of rows || []) {
    if (row.esports || !row.mkey || String(row.mkey).includes('|') || !row.startTime) continue;
    const key = propKey(row.sport, row.player, row.mkey, row.startTime);
    const meta = { sport: row.sport, kind: 'prop', market: row.mkey, marketLabel: row.market, player: row.player, event: row.matchTitle || '', start: row.startTime, row };
    for (const [book, c] of Object.entries(row.books || {})) {
      if (!APP_VENUES.includes(book) || c.line == null) continue;
      const p = pOverOf(book, c) ?? 0.5;
      out.push({ key, source: book, q: { kind: 'prop', mkey: row.mkey, sport: row.sport, pts: [{ x: c.line, p, cell: { over: c.over ?? null, under: c.under ?? null, overOpen: !!c.overOpen, underOpen: !!c.underOpen } }] }, meta });
    }
    const k = kalshiOf ? kalshiOf(row) : null;
    if (k?.size) out.push({ key, source: 'kalshi', q: { kind: 'prop', mkey: row.mkey, sport: row.sport, pts: [...k].filter(([, p]) => p > 0 && p < 1).map(([x, p]) => ({ x, p })) }, meta });
  }
  return out;
}

// ── LABELS ──
const fmtPts = x => (x > 0 ? `+${x}` : `${x}`);
function numberLabel(q, meta) {
  const m = mainOf(q);
  if (!m) return '';
  const pct = `${r1(m.p * 100)}%`;
  if (q.kind === 'ml') return `${meta.home} ${pct}`;
  if (q.kind === 'spread') return `${meta.home} ${fmtPts(m.x)} ${pct}`;
  if (q.kind === 'total') return `o${-m.x} ${pct}`;
  return `o${m.x} ${pct}`;
}
// 'pass_yds' → 'Pass Yds' when no app named the stat
const propLabel = m => String(m || '').split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
const sideName = (kind, meta, s) => (kind === 'ml' || kind === 'spread' ? (s === 0 ? meta.home : meta.away) : s === 0 ? 'Over' : 'Under');
// the venue's number on a side, as people read it
function lineText(kind, x, s) {
  if (kind === 'ml' || x == null) return '';
  if (kind === 'spread') return fmtPts(s === 0 ? x : -x);
  if (kind === 'total') return `${-x}`;
  return `${x}`;
}

// ── THE ENGINE ──
function createStaleLines(opts = {}) {
  const o = { ...DEFAULTS, ...opts, venueMaxAgeMs: { ...DEFAULTS.venueMaxAgeMs, ...(opts.venueMaxAgeMs || {}) }, pinMaxAgeMs: { ...DEFAULTS.pinMaxAgeMs, ...(opts.pinMaxAgeMs || {}) } };
  const subjects = new Map();   // key → { meta, src: { source: [{ t, seenAt, q, fp }] }, anchor, moves: [] }
  const log = [];               // closed moves, for the lag table
  const reads = {};             // source kind → read times
  let seq = 0, movesSeen = 0;
  const startedAt = Date.now();

  const latest = (s, source) => { const l = s.src[source]; return l?.length ? l[l.length - 1] : null; };
  // the source's quote as of time t (the last change at or before t), else its first
  const at = (s, source, t) => {
    const l = s.src[source];
    if (!l?.length) return null;
    let e = l[0];
    for (const x of l) { if (x.t <= t) e = x; else break; }
    return e;
  };
  const need = mv => Math.max(o.minFollowPts / 100, o.followFrac * Math.abs(mv.d));
  // how far a source moved the move's way, read at Pinnacle's old number on
  // Pinnacle's post-move slope (shiftedAt), so a book with one line and an
  // app with no price compare like for like with Pinnacle's own ladder
  const moved = (mv, from, to) => { const a = shiftedAt(from?.q, mv.to, mv.oldX), b = shiftedAt(to?.q, mv.to, mv.oldX); return a == null || b == null ? null : (b - a) * mv.dir; };

  function noteRead(kind, t) {
    const l = (reads[kind] ||= []);
    if (l[l.length - 1] !== t) l.push(t);
    while (l.length > 30) l.shift();
  }

  // a batch of quotes read at time t (ms). kind names the read for the cadence table.
  function observe(quotes, t, kind = null) {
    if (kind) noteRead(kind, t);
    // Pinnacle first: it's read first in each pass, so a venue that moved in
    // the same pass followed with a lag under a minute, it didn't lead.
    // A source quoting one prop at two lines in a batch (Pinnacle lists some
    // players twice) is one quote with both lines, else it flips every read.
    const merged = new Map();
    for (const x of quotes || []) {
      const k = `${x.key}|${x.source}`, m = merged.get(k);
      if (!m) merged.set(k, x);
      else if (x.q.kind === 'prop' && m.q.kind === 'prop') {
        const pts = [...m.q.pts, ...x.q.pts.filter(a => !m.q.pts.some(b => Math.abs(b.x - a.x) < 1e-9))].sort((a, b) => a.x - b.x);
        merged.set(k, { ...m, q: { ...m.q, pts } });
      }
    }
    const ordered = [...merged.values()].sort((a, b) => (b.source === 'pinnacle') - (a.source === 'pinnacle'));
    for (const { key, source, q, meta } of ordered) {
      let s = subjects.get(key);
      if (!s) { s = { meta, src: {}, anchor: null, moves: [] }; subjects.set(key, s); }
      if (source === 'pinnacle' || !s.meta.home) s.meta = { ...s.meta, ...meta, row: meta.row || s.meta.row, marketLabel: meta.marketLabel || s.meta.marketLabel };
      else if (meta.row) s.meta = { ...s.meta, row: meta.row, marketLabel: meta.marketLabel || s.meta.marketLabel };
      const l = (s.src[source] ||= []);
      const fp = fingerprint(q);
      const last = l[l.length - 1];
      if (last && last.fp === fp) { if (t > last.seenAt) last.seenAt = t; last.q = q; continue; }
      if (last && t < last.t) continue;   // an older read landing late
      l.push({ t, seenAt: t, q, fp });
      while (l.length > o.histCap || (l.length > 1 && t - l[0].t > o.keepMs && t - l[1].t > o.keepMs)) l.shift();
      if (source === 'pinnacle') checkMove(key, s, t);
    }
  }
  const fresh = (v, e, t) => !!e && t - e.seenAt <= (o.venueMaxAgeMs[v] ?? 6 * 60e3);
  const pinFresh = (s, e, t) => !!e && t - e.seenAt <= (s.meta.kind === 'prop' ? o.pinMaxAgeMs.prop : o.pinMaxAgeMs.game);

  function checkMove(key, s, t) {
    const cur = latest(s, 'pinnacle');
    // the move is measured from Pinnacle's last move, or from where it stood
    // an hour ago: slow drift over a day is not a move
    if (s.anchor && t - s.anchor.t > o.windowMs) s.anchor = at(s, 'pinnacle', t - o.windowMs);
    if (!s.anchor || s.anchor === cur) { s.anchor = cur; return; }
    const from = s.anchor.q, to = cur.q;
    const fm = mainOf(from), tm = mainOf(to);
    if (!fm || !tm) return;
    const oldX = fm.x;
    const p0 = pAt(from, oldX), p1 = pAt(to, oldX);
    if (p0 == null || p1 == null) { s.anchor = cur; return; }
    const d = p1 - p0;
    const numberMoved = oldX != null && tm.x != null && Math.abs(tm.x - oldX) >= 0.5 - 1e-9;
    if (!(Math.abs(d) >= o.moveProbPts / 100 - 1e-9 || (numberMoved && Math.abs(d) >= o.lineMovePts / 100 - 1e-9))) return;
    const mv = { id: ++seq, key, t, from, to, fromAt: s.anchor.t, oldX, newX: tm.x, d, dir: Math.sign(d), venues: {} };
    // Pinnacle turned back: the earlier move's open venues were right to sit still
    for (const prev of s.moves) if (prev.dir !== mv.dir) for (const st of Object.values(prev.venues)) if (st.status === 'open') st.status = 'reverted';
    const pNew = pAt(to, oldX);
    for (const v of VENUES) {
      const e = latest(s, v);
      if (!fresh(v, e, t)) continue;   // not quoting the subject now: nothing to follow
      const snap = { snapE: e, snapFp: e.fp, snapQ: e.q, snapAt: e.t };
      // a venue that moved Pinnacle's way in the ledMs before led the move;
      // one already at (or past) Pinnacle's new price was never behind it
      const before = at(s, v, t - o.ledMs);
      const m = before && before !== e ? moved(mv, before, e) : 0;
      const sv = shiftedAt(e.q, to, oldX);
      if (m != null && m >= need(mv)) mv.venues[v] = { status: 'led', how: 'moved', ledMs: t - e.t, ...snap };
      else if (sv != null && pNew != null && (sv - pNew) * mv.dir >= -need(mv) / 2) mv.venues[v] = { status: 'led', how: 'already', ...snap };
      else mv.venues[v] = { status: 'open', ...snap };
    }
    s.moves.push(mv);
    movesSeen++;
    s.anchor = cur;
  }

  // follow every open move's venues; close moves past the window or the start
  function step(t) {
    for (const [key, s] of subjects) {
      const start = ms(s.meta.start);
      for (const mv of s.moves) {
        for (const [v, st] of Object.entries(mv.venues)) {
          if (st.status !== 'open') continue;
          const l = s.src[v] || [];
          const i = l.indexOf(st.snapE);
          const later = i >= 0 ? l.slice(i + 1) : l.filter(e => e.t >= st.snapAt && e !== st.snapE);
          for (const e of later) {
            const m = moved(mv, { q: st.snapQ }, e);
            if (m == null || m < need(mv)) continue;
            // a read taken before Pinnacle's move that landed after it: the venue was first
            if (e.t < mv.t) { st.status = 'led'; st.how = 'moved'; st.ledMs = mv.t - e.t; }
            else { st.status = 'followed'; st.lagMs = e.t - mv.t; st.followAt = e.t; }
            break;
          }
        }
      }
      const keep = [];
      for (const mv of s.moves) {
        const started = start != null && t >= start && start - mv.t < o.windowMs;
        if (t - mv.t > o.windowMs || started) {
          for (const st of Object.values(mv.venues)) if (st.status === 'open') st.status = started ? 'started' : 'never';
          log.push({ id: mv.id, t: mv.t, kind: s.meta.kind, sport: s.meta.sport, dPts: r1(mv.d * 100), closedAt: t,
            venues: Object.fromEntries(Object.entries(mv.venues).map(([v, st]) => [v, { status: st.status, lagMs: st.lagMs ?? null, ledMs: st.ledMs ?? null }])) });
        } else keep.push(mv);
      }
      s.moves = keep;
      // a subject gone quiet past its start drops out
      const lastT = Math.max(0, ...Object.values(s.src).map(l => l[l.length - 1]?.seenAt || 0));
      if ((start != null && t - start > 3600e3) || t - lastT > o.keepMs) subjects.delete(key);
    }
    while (log.length && (log.length > o.logCap || t - log[0].t > o.logMs)) log.shift();
  }

  // which sharp sources (other than the venue) moved the move's way since
  // confirmLookbackMs before it
  function confirmedBy(s, mv, venue) {
    const out = [];
    for (const c of CONFIRM) {
      if (c === venue) continue;
      const e = latest(s, c);
      const b = at(s, c, mv.t - o.confirmLookbackMs);
      if (!e || !b || e === b) continue;
      const m = moved(mv, b, e);
      if (m != null && m >= need(mv)) out.push(c);
    }
    return out;
  }

  // the board: every venue that hasn't followed Pinnacle's latest move on a
  // subject, priced at its quote now against Pinnacle's post-move fair at the
  // venue's own number. Pinnacle's quote must be fresh (pinMaxAgeMs).
  // priceApp(book, fair, cell, side) → { ev (%), decimal, entry?, entries? } | null
  function rows(t, { priceApp = null } = {}) {
    const out = [];
    for (const [key, s] of subjects) {
      const mv = s.moves[s.moves.length - 1];
      if (!mv) continue;
      const start = ms(s.meta.start);
      if (start != null && t >= start) continue;
      const pin = latest(s, 'pinnacle');
      if (!pinFresh(s, pin, t)) continue;
      for (const [v, st] of Object.entries(mv.venues)) {
        if (st.status !== 'open') continue;
        const e = latest(s, v);
        if (!fresh(v, e, t)) continue;   // not read lately
        const vm = mainOf(e.q);
        if (!vm) continue;
        const x = vm.x;
        const p0 = pAt(pin.q, x);
        if (p0 == null) continue;
        const side = mv.dir > 0 ? 0 : 1;
        const fair = side === 0 ? p0 : 1 - p0;
        const pre = pAt(mv.from, x);
        let ev, decimal, entry = null, entries = null, mult = null;
        if (APP_VENUES.includes(v)) {
          const c = vm.cell;
          if (!c || !(side === 0 ? c.overOpen : c.underOpen) || !priceApp) continue;
          const pr = priceApp(v, fair, c, side === 0 ? 'Over' : 'Under');
          if (!pr || !Number.isFinite(pr.ev)) continue;
          ({ ev, decimal } = pr); entry = pr.entry || null; entries = pr.entries || null;
          mult = (side === 0 ? c.over : c.under) ?? 1;
        } else {
          decimal = side === 0 ? vm.d0 : vm.d1;
          if (!(decimal > 1)) continue;
          ev = (fair * decimal - 1) * 100;
        }
        if (!(ev >= o.minShowEv) || ev > o.maxEv) continue;
        const conf = confirmedBy(s, mv, v);
        const clears = conf.length > 0 && ev >= o.minEv;
        const kind = s.meta.kind;
        // single-source and confirmed rows are separate bets in the record:
        // each is graded as of the moment it showed in its own bucket
        const source = conf.length ? 'stale' : 'stale-single';
        const group = `${source}|${key}|${x ?? 'ml'}`;
        const sideLabel = sideName(kind, s.meta, side);
        out.push({
          group, key, x, kind, venue: v, book: v, app: APP_VENUES.includes(v), sport: o.sportKey ? o.sportKey(s.meta.sport) : s.meta.sport,
          event: s.meta.event || '', start: s.meta.start || null,
          market: kind === 'prop' ? s.meta.market : kind === 'ml' ? 'h2h' : kind === 'spread' ? 'spreads' : 'totals',
          marketLabel: kind === 'prop' ? (s.meta.marketLabel || propLabel(s.meta.market)) : kind === 'ml' ? 'Moneyline' : kind === 'spread' ? 'Spread' : 'Total',
          player: s.meta.player || null, point: x == null ? null : kind === 'spread' ? (side === 0 ? x : -x) : kind === 'total' ? -x : x,
          side: sideLabel, sideIdx: side, line: lineText(kind, x, side),
          price: decimal ? probToAmerican(1 / decimal) : null, decimal: r4(decimal), mult, entry, entries,
          ev: r2(ev), fairProb: r2(fair * 100), fairPrice: probToAmerican(fair), preFair: pre == null ? null : r2((side === 0 ? pre : 1 - pre) * 100),
          moveAt: new Date(mv.t).toISOString(), mins: Math.floor((t - mv.t) / 60e3), venueSince: new Date(e.t).toISOString(),
          // when we last read the venue: PrizePicks is read every 20 min, so its line may have moved since
          venueReadAt: new Date(e.seenAt).toISOString(), readMins: Math.max(0, Math.floor((t - e.seenAt) / 60e3)),
          moveSourceAt: new Date(mv.fromAt).toISOString(), dPts: r1(Math.abs(mv.d) * 100),
          pinPre: numberLabel(mv.from, s.meta), pinPost: numberLabel(mv.to, s.meta), pinNow: numberLabel(pin.q, s.meta),
          confirmedBy: conf, clears, single: conf.length === 0, source,
          sharpBooks: ['pinnacle', ...conf.map(c => (c === 'kalshi' ? (kind === 'prop' ? 'kalshi_props' : 'kalshi_mid') : c))],
          ...(s.meta.row ? { rowKey: s.meta.row.key } : {}),
        });
      }
    }
    return out.sort((a, b) => (b.clears - a.clears) || b.ev - a.ev);
  }

  // Pinnacle's chance of side 0 at x on a subject now, or null when its quote
  // isn't fresh: the close for a tracked leg is graded on the same fair it was
  // flagged on
  function fairAt(key, x, t = Date.now()) {
    const s = subjects.get(key);
    const pin = s && latest(s, 'pinnacle');
    return s && pinFresh(s, pin, t) ? pAt(pin.q, x) : null;
  }

  // close-of-market fairs and the venues' prices now, for every bet a tracker
  // holds: bets → Map(id → { group, key, x, venue })
  function marks(bets, t = Date.now()) {
    const fairs = new Map(), costs = new Map();
    for (const g of bets.values()) {
      const s = subjects.get(g.key);
      if (!s) continue;
      const p0 = fairAt(g.key, g.x, t);
      if (p0 != null) { fairs.set(`${g.group}|${sideName(s.meta.kind, s.meta, 0)}`, r2(p0 * 100)); fairs.set(`${g.group}|${sideName(s.meta.kind, s.meta, 1)}`, r2((1 - p0) * 100)); }
      const e = latest(s, g.venue);
      if (!e || APP_VENUES.includes(g.venue) || !fresh(g.venue, e, t)) continue;
      const pt = e.q.kind === 'ml' ? e.q : (e.q.pts || []).find(a => Math.abs(a.x - g.x) < 1e-9);
      if (!pt) continue;
      for (const side of [0, 1]) { const d = side === 0 ? pt.d0 : pt.d1; if (d > 1) costs.set(`${g.group}|${sideName(s.meta.kind, s.meta, side)}|${g.venue}`, 1 / d); }
    }
    return { fairs, costs };
  }

  // the lag table: by venue and market kind, over the last 24 hours of moves
  function lagSummary(t = Date.now()) {
    const all = [...log];
    for (const s of subjects.values()) for (const mv of s.moves)
      all.push({ t: mv.t, kind: s.meta.kind, sport: s.meta.sport, dPts: r1(mv.d * 100), venues: Object.fromEntries(Object.entries(mv.venues).map(([v, st]) => [v, { status: st.status, lagMs: st.lagMs ?? null }])) });
    const day = all.filter(m => t - m.t <= 86400e3);
    const hours = Math.max(1 / 60, Math.min(24, (t - Math.max(startedAt, t - 86400e3)) / 3600e3));
    const byKind = {}, bySport = {};
    for (const m of day) {
      const sp = o.sportKey ? o.sportKey(m.sport) : m.sport;
      byKind[m.kind] = (byKind[m.kind] || 0) + 1; bySport[sp] = (bySport[sp] || 0) + 1;
    }
    const cells = {};
    for (const m of day) for (const [v, st] of Object.entries(m.venues)) {
      const c = (cells[`${v}|${m.kind}`] ||= { venue: v, kind: m.kind, moves: 0, followed: 0, led: 0, never: 0, open: 0, reverted: 0, started: 0, lags: [], openAges: [] });
      c.moves++;
      if (st.status === 'followed') { c.followed++; c.lags.push(st.lagMs / 60e3); }
      else if (st.status === 'open') { c.open++; c.openAges.push((t - m.t) / 60e3); }
      else c[st.status] = (c[st.status] || 0) + 1;
    }
    const median = l => { if (!l.length) return null; const s = [...l].sort((a, b) => a - b), h = s.length / 2; return r1(s.length % 2 ? s[Math.floor(h)] : (s[h - 1] + s[h]) / 2); };
    const pctl = (l, f) => { if (!l.length) return null; const s = [...l].sort((a, b) => a - b); return r1(s[Math.min(s.length - 1, Math.floor(f * s.length))]); };
    const lag = Object.values(cells).map(c => {
      // within m minutes: of the moves whose answer at m is known (followed,
      // gone the hour unfollowed, or still open past m)
      const within = m => { const n = c.followed + c.never + c.openAges.filter(a => a > m).length; return n ? r2(100 * c.lags.filter(x => x <= m).length / n) : null; };
      const done = c.followed + c.never;
      return { venue: c.venue, kind: c.kind, moves: c.moves, followed: c.followed, led: c.led, never: c.never, open: c.open, reverted: c.reverted, started: c.started,
        medianMin: median(c.lags), p75Min: pctl(c.lags, 0.75), within2: within(2), within5: within(5), within15: within(15), neverPct: done ? r2(100 * c.never / done) : null };
    }).sort((a, b) => b.moves - a.moves);
    const cadence = Object.fromEntries(Object.entries(reads).map(([k, l]) => {
      const gaps = l.slice(1).map((x, i) => (x - l[i]) / 60e3);
      return [k, { reads: l.length, medianGapMin: median(gaps), last: l.length ? new Date(l[l.length - 1]).toISOString() : null }];
    }));
    return { since: new Date(Math.max(startedAt, t - 86400e3)).toISOString(), hours: r2(hours), moves24h: day.length, movesPerDay: Math.round(day.length * 24 / hours),
      byKind, bySport, lag, cadence, subjects: subjects.size, openMoves: [...subjects.values()].reduce((a, s) => a + s.moves.length, 0), movesSeen,
      thresholds: { moveProbPts: o.moveProbPts, lineMovePts: o.lineMovePts, followFrac: o.followFrac, minFollowPts: o.minFollowPts, windowMin: o.windowMs / 60e3, minEv: o.minEv } };
  }

  // one subject's Pinnacle history (and the others'), for the curious
  function history(key) {
    const s = subjects.get(key);
    if (!s) return null;
    return { key, meta: { ...s.meta, row: undefined }, moves: s.moves.map(m => ({ t: new Date(m.t).toISOString(), dPts: r1(m.d * 100), pre: numberLabel(m.from, s.meta), post: numberLabel(m.to, s.meta), venues: Object.fromEntries(Object.entries(m.venues).map(([v, st]) => [v, st.status])) })),
      sources: Object.fromEntries(Object.entries(s.src).map(([k, l]) => [k, l.map(e => ({ t: new Date(e.t).toISOString(), number: numberLabel(e.q, s.meta) }))])) };
  }

  return { observe, step, rows, fairAt, marks, lagSummary, history, size: () => subjects.size, opts: o };
}

module.exports = { DEFAULTS, VENUES, BOOK_VENUES, APP_VENUES, CONFIRM, devig2, pAt, shiftedAt, mainOf, fingerprint, dayOf, propKey, gameQuotes, bookPropQuotes, pinPropQuotes, appQuotes, numberLabel, createStaleLines };
