// ─── BIGGEST MOVES: TODAY'S LARGEST LINE MOVES, AND WHO HASN'T FOLLOWED ─────
// Ranks the markets that moved most since we first saw them ("open": the first
// price in our own history, not the venue's opening line), in the last 3 hours
// and in the last hour, at each venue: Pinnacle, Kalshi, Polymarket US,
// FanDuel, BetRivers (and Gemini) on game lines, and Pinnacle, the books,
// Kalshi and each pick'em app on player props.
//
// Two kinds of move:
//   price  the same number, a different price: cents of implied probability
//          (game lines: the venue's own price, fees in on exchanges; props:
//          the no-vig chance of the Over where the venue prices both sides,
//          an app's chance from its payouts)
//   line   the number itself moved: points (a spread, a total, a prop line)
//
// Each row lists every other venue on the same market now: MOVED TOO (it went
// the same way by at least half the move and a cent, or it hangs the new
// number), STILL AT OLD NUMBER (it moved under a cent, or still hangs the old
// number), PART (it moved some), the other way, another number, or new (no
// price at the window's start). It is information, not an edge: the "app
// stale" and "lead-lag" leads have both graded as no edge against the close.
//
// It reads only what the server already keeps: the odds screen's game-line
// history (oddsscreen.createHistory, which rides the results backup) and the
// stale-lines engine's change history (stalelines.sources, 3 hours, memory
// only, so it starts empty after a deploy). No new reads, no recorder.
//
// Pure functions, no I/O.

const { americanToDecimal } = require('./ev');
const venues = require('./venues');

const WINDOWS = { open: null, '3h': 3 * 3600e3, '1h': 3600e3 };
// the venues a move is ranked at (the copies and Matchbook are shown as followers only)
const MOVERS = ['pinnacle', 'kalshi', 'polymarketus', 'gemini', 'fanduel', 'betrivers', 'prizepicks', 'underdog', 'sleeper', 'pick6'];
const APPS = new Set(['prizepicks', 'underdog', 'sleeper', 'pick6']);
const EXCHANGES = new Set(['kalshi', 'polymarketus', 'gemini']);
const NAMES = { pinnacle: 'Pinnacle', kalshi: 'Kalshi', polymarketus: 'Polymarket US', gemini: 'Gemini', fanduel: 'FanDuel', betrivers: 'BetRivers', matchbook: 'Matchbook',
  prizepicks: 'PrizePicks', underdog: 'Underdog', sleeper: 'Sleeper', pick6: 'DK Pick6' };
// the apps' own pages: they publish no deep link to a pick, so a tap opens the app's board
const APP_HOME = { prizepicks: 'https://app.prizepicks.com/', underdog: 'https://underdogfantasy.com/pick-em/higher-lower', sleeper: 'https://sleeper.com/picks', pick6: 'https://pick6.draftkings.com/' };
const DEFAULTS = { minCents: 1, minLine: 0.5, followFrac: 0.5, followMin: 0.01, startGraceMs: 5 * 60e3, horizonMs: 36 * 3600e3, maxRows: 300 };

const { r1, r4 } = require('./mathutil');
const ms = t => { const x = typeof t === 'number' ? t : Date.parse(t || ''); return Number.isFinite(x) ? x : null; };
const nameOf = v => NAMES[v] || venues.NAMES?.[v] || v;
const impOf = a => { const d = americanToDecimal(a); return d > 1 ? 1 / d : null; };
const eq = (a, b) => a != null && b != null && Math.abs(a - b) < 1e-9;
const cutoffOf = (window, now) => (WINDOWS[window] == null ? null : now - WINDOWS[window]);

// how another venue answered a price move of `d` (> 0) over the same window
function followOf(du, d, o) {
  if (du == null) return 'new';
  if (du >= Math.max(o.followMin, o.followFrac * d) - 1e-9) return 'moved';
  if (Math.abs(du) < o.followMin - 1e-9) return 'old';
  return du > 0 ? 'part' : 'against';
}
// a line move from `from` to `to`: where another venue's number is now
function lineFollowOf(x, from, to) {
  if (x == null) return 'new';
  if (eq(x, to)) return 'moved';
  if (eq(x, from)) return 'old';
  // past the new number, or between: it moved the same way
  return (to - from) * (x - from) > 0 ? 'moved' : 'other';
}

// ── GAME LINES (the odds screen's history) ──
// series: oddsHistory.dump() → [{ id `${game}|${market}|${side}`, game, start, label, market, pts: [[t, point, fair, { venue: american }]] }]
// screen: oddsscreen.build() output now (each venue's current cell: number, url)
// size(game, market, side, venue) → the exchange's book size, or null
function gameMoves(series, screen, { window = 'open', now = Date.now(), size = null, opts = {} } = {}) {
  const o = { ...DEFAULTS, ...opts };
  const cut = cutoffOf(window, now);
  const sides = new Map();
  for (const g of screen?.games || []) for (const m of g.markets || []) m.sides.forEach((s, i) => sides.set(`${g.id}|${m.key}|${s.name}`, { g, m, s, i }));
  const rows = [];
  let considered = 0, earliest = null;
  for (const x of series || []) {
    const st = ms(x.start);
    if (st == null || st < now - o.startGraceMs || st > now + o.horizonMs) continue;
    const cur = sides.get(x.id);
    const pts = (x.pts || []).filter(p => p[0] <= now);
    if (!cur || !pts.length) continue;
    if (earliest == null || pts[0][0] < earliest) earliest = pts[0][0];
    considered++;
    const last = pts[pts.length - 1];
    const bi = cut == null ? 0 : pts.findLastIndex(p => p[0] <= cut);
    if (bi < 0) continue;
    const base = pts[bi];
    const cells = cur.s.venues || [];
    const cellOf = v => cells.find(c => c.venue === v) || null;
    const common = { kind: 'game', league: cur.g.league, leagueLabel: cur.g.leagueLabel, gameId: cur.g.id, event: `${cur.g.away} @ ${cur.g.home}`, start: cur.g.start, market: cur.m.key, marketLabel: cur.m.label };
    const sizeFor = v => (size && EXCHANGES.has(v) ? size(cur.g, cur.m, cur.s, v) : null);
    const others = mk => cells.filter(c => c.venue !== mk.venue).map(c => ({ venue: c.venue, name: nameOf(c.venue), ...mk.of(c), url: c.url || null, secondHand: !!c.secondHand, ref: !!c.ref, size: sizeFor(c.venue) }));

    // Pinnacle's number moved (one row per market, on its first side: home's spread, the Over)
    if (cur.m.key !== 'ml' && base[1] != null && last[1] != null && !eq(base[1], last[1]) && cur.i === 0) {
      const from = base[1], to = last[1];
      if (Math.abs(to - from) >= o.minLine - 1e-9) {
        const pin = cellOf('pinnacle');
        const mk = { venue: 'pinnacle', of: c => ({ status: lineFollowOf(c.point, from, to), now: c.american, point: c.point }) };
        rows.push({ ...common, id: `${x.id}|line|pinnacle`, type: 'line', venue: 'pinnacle', venueName: nameOf('pinnacle'), side: lineLabel(cur, from, to),
          from, to, move: r1(Math.abs(to - from)), dir: Math.sign(to - from), since: new Date(base[0]).toISOString(), now: pin?.american ?? null, url: pin?.url || null, size: null,
          followers: others(mk) });
      }
    }
    // each venue's price at the number it is on now, from the start of the
    // current run at that number (a number that left and came back is a new run)
    const sameNum = p => eq(p[1], last[1]) || (p[1] == null && last[1] == null);
    let run = pts.length - 1;
    while (run > 0 && sameNum(pts[run - 1])) run--;
    const runPts = pts.slice(run);
    const deltas = {};
    for (const c of cells) {
      if (c.lineDiffers || last[3]?.[c.venue] == null) continue;
      const was = cut == null ? runPts.find(p => p[3]?.[c.venue] != null) : runPts.filter(p => p[0] <= cut && p[3]?.[c.venue] != null).pop();
      if (!was) { deltas[c.venue] = null; continue; }
      const a = impOf(was[3][c.venue]), b = impOf(last[3][c.venue]);
      deltas[c.venue] = a == null || b == null ? null : { d: b - a, from: was[3][c.venue], to: last[3][c.venue], t: was[0] };
    }
    for (const v of MOVERS) {
      const dv = deltas[v];
      if (!dv || dv.d < o.minCents / 100 - 1e-9) continue;
      const c = cellOf(v);
      const mk = { venue: v, of: cc => (cc.lineDiffers ? { status: 'other', now: cc.american, point: cc.point }
        : { status: followOf(deltas[cc.venue]?.d ?? null, dv.d, o), from: deltas[cc.venue]?.from ?? null, now: cc.american, cents: deltas[cc.venue] ? r1(deltas[cc.venue].d * 100) : null }) };
      rows.push({ ...common, id: `${x.id}|price|${v}`, type: 'price', venue: v, venueName: nameOf(v), side: cur.s.label, from: dv.from, to: dv.to,
        move: r1(dv.d * 100), dir: 1, since: new Date(dv.t).toISOString(), now: c?.american ?? null, url: c?.url || null, size: sizeFor(v), followers: others(mk) });
    }
  }
  return { rows, considered, earliest: earliest == null ? null : new Date(earliest).toISOString() };
}
function lineLabel(cur, from, to) {
  const f = x => (x > 0 ? `+${x}` : `${x}`);
  if (cur.m.key === 'total') return `Total ${from} → ${to}`;
  return `${cur.g.home} ${f(from)} → ${f(to)}`;
}

// ── PLAYER PROPS (the stale-lines engine's change history) ──
// subjects: staleLines engine .sources(now, { kind: 'prop' }) → [{ key, meta, src: { venue: { live, list: [{ t, q: { pts: [{ x, p, cell }] } }] } } }]
// leagueOf(meta.sport) → the odds screen's league key ('nfl')
function mainOf(q) {
  const pts = (q?.pts || []).filter(a => Number.isFinite(a.x));
  if (!pts.length) return null;
  return pts.reduce((b, a) => (Math.abs((a.p ?? 0.5) - 0.5) < Math.abs((b.p ?? 0.5) - 0.5) ? a : b));
}
const pAtX = (q, x) => { const a = (q?.pts || []).find(b => eq(b.x, x)); return a && a.p > 0 && a.p < 1 ? a.p : null; };
function propMoves(subjects, { window = 'open', now = Date.now(), leagueOf = s => String(s || '').toLowerCase(), labelOf = null, opts = {} } = {}) {
  const o = { ...DEFAULTS, ...opts };
  const cut = cutoffOf(window, now);
  const rows = [];
  let considered = 0, earliest = null;
  for (const subj of subjects || []) {
    const meta = subj.meta || {};
    const st = ms(meta.start);
    if (meta.kind !== 'prop' || st == null || st < now - o.startGraceMs || st > now + o.horizonMs) continue;
    // each live venue: its quote now and at the window's start
    const v = {};
    for (const [venue, { live, list }] of Object.entries(subj.src || {})) {
      if (!live || !list?.length) continue;
      const l = list.filter(e => e.t <= now);
      if (!l.length) continue;
      if (earliest == null || l[0].t < earliest) earliest = l[0].t;
      const was = cut == null ? l[0] : l.filter(e => e.t <= cut).pop() || null;
      v[venue] = { now: l[l.length - 1], was };
    }
    const names = Object.keys(v);
    if (!names.length) continue;
    considered++;
    const league = leagueOf(meta.sport);
    const stat = meta.marketLabel || (labelOf ? labelOf(meta.market) : meta.market);
    const common = { kind: 'prop', league, leagueLabel: String(meta.sport || '').toUpperCase(), event: meta.event || '', player: meta.player, start: meta.start, market: meta.market, marketLabel: stat };
    const lineNow = q => mainOf(q)?.x ?? null;
    const urlOf = venue => APP_HOME[venue] || null;
    for (const mover of MOVERS) {
      const x = v[mover];
      if (!x || !x.was) continue;
      const m0 = mainOf(x.was.q), m1 = mainOf(x.now.q);
      if (!m0 || !m1) continue;
      // Kalshi lists a ladder: its "number" is whichever rung is nearest even, so only its prices count
      if (!eq(m0.x, m1.x) && mover !== 'kalshi') {
        const from = m0.x, to = m1.x;
        if (Math.abs(to - from) < o.minLine - 1e-9) continue;
        rows.push({ ...common, id: `${subj.key}|line|${mover}`, type: 'line', venue: mover, venueName: nameOf(mover), side: `${meta.player} ${stat} ${from} → ${to}`,
          from, to, move: r1(Math.abs(to - from)), dir: Math.sign(to - from), since: new Date(x.was.t).toISOString(), now: to, url: urlOf(mover), size: null,
          // Kalshi's ladder has no one number to compare, so it isn't a follower of a line move
          followers: names.filter(n => n !== mover && n !== 'kalshi').map(n => ({ venue: n, name: nameOf(n), status: lineFollowOf(lineNow(v[n].now.q), from, to), point: lineNow(v[n].now.q), url: urlOf(n) })) });
        continue;
      }
      // the same number: the chance of the Over there
      const at = m0.x;
      const a = pAtX(x.was.q, at), b = pAtX(x.now.q, at);
      if (a == null || b == null) continue;
      const d = b - a;
      if (Math.abs(d) < o.minCents / 100 - 1e-9) continue;
      const over = d > 0, dd = Math.abs(d);
      const side = `${meta.player} ${over ? 'Over' : 'Under'} ${at} ${stat}`;
      const pSide = p => (p == null ? null : r4(over ? p : 1 - p));
      rows.push({ ...common, id: `${subj.key}|price|${mover}|${at}`, type: 'price', venue: mover, venueName: nameOf(mover), side, from: pSide(a), to: pSide(b), point: at,
        move: r1(dd * 100), dir: 1, since: new Date(x.was.t).toISOString(), now: pSide(b), url: urlOf(mover), size: null,
        followers: names.filter(n => n !== mover).map(n => {
          const w = v[n];
          const pn = pAtX(w.now.q, at), pw = w.was ? pAtX(w.was.q, at) : null;
          if (pn == null) return { venue: n, name: nameOf(n), status: 'other', point: lineNow(w.now.q), url: urlOf(n) };
          const du = pw == null ? null : (pn - pw) * (over ? 1 : -1);
          return { venue: n, name: nameOf(n), status: followOf(du, dd, o), from: pSide(pw), now: pSide(pn), cents: du == null ? null : r1(du * 100), url: urlOf(n) };
        }) });
    }
  }
  return { rows, considered, earliest: earliest == null ? null : new Date(earliest).toISOString() };
}

// Merge, filter and rank. With no venue picked each market shows once, at the
// venue that moved most; picking a venue shows every move at that venue.
function rank(rows, { venue = null, league = null, type = 'price', kind = null, sort = 'move', maxRows = DEFAULTS.maxRows } = {}) {
  let out = rows.filter(r => r.type === type && (!league || r.league === league) && (!venue || r.venue === venue) && (!kind || r.kind === kind));
  if (!venue) {
    const best = new Map();
    for (const r of out) {
      const k = `${r.kind}|${r.gameId || r.event}|${r.market}|${r.player || ''}|${r.type === 'line' ? '' : r.side}`;
      const b = best.get(k);
      if (!b || r.move > b.move || (r.move === b.move && MOVERS.indexOf(r.venue) < MOVERS.indexOf(b.venue))) best.set(k, r);
    }
    out = [...best.values()];
  }
  for (const r of out) r.stillOld = r.followers.filter(f => f.status === 'old').length;
  const by = {
    move: (a, b) => b.move - a.move,
    start: (a, b) => ms(a.start) - ms(b.start),
    old: (a, b) => b.stillOld - a.stillOld || b.move - a.move,
  }[sort] || ((a, b) => b.move - a.move);
  out.sort((a, b) => by(a, b) || ms(a.start) - ms(b.start) || String(a.id).localeCompare(String(b.id)));
  return out.slice(0, maxRows);
}

// the venues and leagues the rows cover, for the filters
function facets(rows, type) {
  const of = rows.filter(r => r.type === type);
  const count = (key, label) => {
    const m = new Map();
    for (const r of of) { const k = r[key]; if (!m.has(k)) m.set(k, { key: k, label: label(r), n: 0 }); m.get(k).n++; }
    return [...m.values()];
  };
  return {
    venues: count('venue', r => r.venueName).sort((a, b) => MOVERS.indexOf(a.key) - MOVERS.indexOf(b.key)),
    leagues: count('league', r => r.leagueLabel).sort((a, b) => b.n - a.n),
  };
}

module.exports = { WINDOWS, MOVERS, APPS, EXCHANGES, NAMES, APP_HOME, DEFAULTS, followOf, lineFollowOf, gameMoves, propMoves, rank, facets };
