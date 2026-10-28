// ─── LINE HISTORY: 30 DAYS OF EVERY MARKET'S PRICES ─────────────────────────
// The odds screen (oddsscreen.createHistory, game lines) and the shopper
// (shopper.createLineHistory, player props) save each market's prices every
// few minutes while it is on the board, and drop it 6 hours after the start.
// This module keeps what they drop for 30 days after the start, small enough
// to ride the results backup (backup.js) across Railway deploys:
//
//   thin     a long series is cut to the points that matter most: the first
//            and last read, the last read before the start (the close), the
//            biggest moves, and a few reads spread evenly in time. Every kept
//            point is a real read; nothing is averaged or made up. A dropped
//            read was a small move between two kept ones.
//   archive  a dropped market is thinned to at most 60 reads (game lines) or
//            30 (props) and kept in a compact form: one venue list per
//            market, then rows of numbers. If the whole archive passes its
//            budget, markets over a week old are thinned to 12 reads, then
//            every market to half, then to 12, then the oldest dropped.
//            status() says how many.
//   pages    /lines lists every market kept; /lines/game/{id} and
//            /lines/prop?key= chart one market against each venue, in the
//            viewer's odds format and My state (?odds=, ?state=), with the
//            reads in a table and a CSV or JSON download.
//
// Pure: no I/O. server.js wires the stores, routes and plan limits.

'use strict';
const { CSS, LOGO, FAVICON, esc } = require('./learn');
const oddsFmt = require('./oddsfmt');
const venues = require('./venues');

const DAY = 86400e3;
const KEEP_DAYS = 30;
const r4 = x => (x == null || !Number.isFinite(x) ? null : Math.round(x * 1e4) / 1e4);
const ms = t => { const x = Date.parse(t || ''); return Number.isFinite(x) ? x : null; };
const prob = a => (a == null || !Number.isFinite(a) ? null : a > 0 ? 100 / (a + 100) : -a / (-a + 100));

// ── how much a read moved from the one before it ──
// game read: [t, point, fair, { venue: american }]
function gameDiff(a, b) {
  let d = a[1] !== b[1] ? 1 : 0;
  if (a[2] != null && b[2] != null) d += Math.abs(a[2] - b[2]);
  else if ((a[2] == null) !== (b[2] == null)) d += 0.02;
  const pa = a[3] || {}, pb = b[3] || {};
  let m = 0;
  for (const v of new Set([...Object.keys(pa), ...Object.keys(pb)])) {
    const x = prob(pa[v]), y = prob(pb[v]);
    m = Math.max(m, x == null || y == null ? (x == null && y == null ? 0 : 0.02) : Math.abs(x - y));
  }
  return d + m;
}
// prop read: [t, fairOver, { venue: [overAm, underAm] }]
function propDiff(a, b) {
  let d = 0;
  if (a[1] != null && b[1] != null) d += Math.abs(a[1] - b[1]);
  else if ((a[1] == null) !== (b[1] == null)) d += 0.02;
  const pa = a[2] || {}, pb = b[2] || {};
  let m = 0;
  for (const v of new Set([...Object.keys(pa), ...Object.keys(pb)])) {
    for (const i of [0, 1]) {
      const x = prob(pa[v]?.[i]), y = prob(pb[v]?.[i]);
      m = Math.max(m, x == null || y == null ? (x == null && y == null ? 0 : 0.02) : Math.abs(x - y));
    }
  }
  return d + m;
}

// pts (oldest first) → at most max of them, in order. Kept always: the first,
// the last, every index at or past protectFrom, and the last read before
// `start` (the close). Of the rest, three quarters of the room goes to the
// biggest moves and a quarter to reads spread evenly in time.
function thin(pts, max, { diff = gameDiff, start = null, protectFrom = Infinity } = {}) {
  const n = pts.length;
  if (n <= max) return pts.slice();
  const keep = new Set([0, n - 1]);
  for (let i = Math.max(0, Math.min(protectFrom, n)); i < n; i++) keep.add(i);
  const st = ms(start);
  if (st != null) { let c = -1; for (let i = 0; i < n; i++) if (pts[i][0] < st) c = i; if (c >= 0) keep.add(c); }
  let room = max - keep.size;
  if (room > 0) {
    const free = [];
    for (let i = 1; i < n - 1; i++) if (!keep.has(i)) free.push(i);
    const spread = Math.floor(room / 4);
    const scored = free.map(i => [i, diff(pts[i - 1], pts[i])]).sort((a, b) => b[1] - a[1] || b[0] - a[0]);
    for (const [i, s] of scored) { if (room <= spread || s <= 0) break; keep.add(i); room--; }
    // evenly in time over what is left
    if (room > 0) {
      const t0 = pts[0][0], t1 = pts[n - 1][0];
      const left = free.filter(i => !keep.has(i));
      for (let k = 1; k <= room && left.length; k++) {
        const want = t0 + (t1 - t0) * k / (room + 1);
        let best = 0;
        for (let j = 1; j < left.length; j++) if (Math.abs(pts[left[j]][0] - want) < Math.abs(pts[left[best]][0] - want)) best = j;
        keep.add(left[best]); left.splice(best, 1);
      }
    }
  }
  return [...keep].sort((a, b) => a - b).map(i => pts[i]);
}

// ── compact form: one venue list, then rows of numbers; times in minutes ──
const tMin = t => Math.round(t / 60e3);
function encodeGame(x) {
  const v = [...new Set(x.pts.flatMap(p => Object.keys(p[3] || {})))];
  return { v, pts: x.pts.map(p => [tMin(p[0]), p[1] ?? null, p[2] ?? null, ...v.map(k => p[3]?.[k] ?? null)]) };
}
function decodeGame(e) {
  return e.pts.map(r => {
    const px = {};
    e.v.forEach((k, i) => { if (r[3 + i] != null) px[k] = r[3 + i]; });
    return [r[0] * 60e3, r[1], r[2], px];
  });
}
function encodeProp(x) {
  const v = [...new Set(x.pts.flatMap(p => Object.keys(p[2] || {})))];
  return { v, pts: x.pts.map(p => [tMin(p[0]), p[1] ?? null, ...v.flatMap(k => [p[2]?.[k]?.[0] ?? null, p[2]?.[k]?.[1] ?? null])]) };
}
function decodeProp(e) {
  return e.pts.map(r => {
    const px = {};
    e.v.forEach((k, i) => { const o = r[2 + 2 * i], u = r[3 + 2 * i]; if (o != null || u != null) px[k] = [o, u]; });
    return [r[0] * 60e3, r[1], px];
  });
}

// ── the 30-day archive ──
// entry: { id: 'game:<series id>' | 'prop:<market key>', kind, key, start,
//   firstAt, lastAt, reads (before thinning), thinned, archivedAt, v, pts,
//   game: { game, market, label, league, leagueLabel, event } | prop: { event, league, player, stat, line } }
function createArchive({ keepDays = KEEP_DAYS, maxPts = { game: 60, prop: 30 }, minPts = 12, budget = { game: 250000, prop: 200000 }, now = () => Date.now() } = {}) {
  const entries = new Map();
  const totals = { game: 0, prop: 0 };
  const dropped = { thinnedHarder: 0, removedForRoom: 0, removedThrough: null, expired: 0 };
  let lastPrune = 0;

  function put(e) {
    const had = entries.get(e.id);
    if (had) totals[had.kind] -= had.pts.length;
    entries.set(e.id, e);
    totals[e.kind] += e.pts.length;
  }
  function remove(id) {
    const e = entries.get(id);
    if (!e) return;
    totals[e.kind] -= e.pts.length;
    entries.delete(id);
  }
  // x: a live series as the odds screen or shopper drops it
  function add(kind, x) {
    if (!x || !x.id || !Array.isArray(x.pts) || !x.pts.length || !(kind === 'game' || kind === 'prop')) return null;
    const pts = thin(x.pts, maxPts[kind], { diff: kind === 'game' ? gameDiff : propDiff, start: x.start });
    const enc = kind === 'game' ? encodeGame({ pts }) : encodeProp({ pts });
    const e = {
      id: `${kind}:${x.id}`, kind, key: x.id, start: x.start || null,
      firstAt: new Date(x.pts[0][0]).toISOString(), lastAt: new Date(x.pts[x.pts.length - 1][0]).toISOString(),
      reads: (x.reads || x.pts.length), thinned: pts.length < x.pts.length || !!x.thinned, archivedAt: new Date(now()).toISOString(), ...enc,
      ...(kind === 'game'
        ? { game: { game: x.game, market: x.market, label: x.label, league: x.league || null, leagueLabel: x.leagueLabel || null, event: x.event || null } }
        : { prop: { event: x.event || null, league: x.league || null, player: x.player || null, stat: x.stat || null, line: x.line ?? null } }),
    };
    const had = entries.get(e.id);
    // the one with the later last read wins (a restore never undoes a newer drop)
    if (had && had.lastAt >= e.lastAt) return had;
    put(e);
    if (now() - lastPrune > 10 * 60e3) prune();
    // a little over is fine until the next sweep; well over, sweep now
    else if (totals[kind] > budget[kind] * 1.05) enforce(kind);
    return e;
  }
  const ageOf = e => ms(e.start) ?? ms(e.lastAt) ?? 0;
  function prune() {
    lastPrune = now();
    const cut = now() - keepDays * DAY;
    for (const [id, e] of entries) if (ageOf(e) < cut) { remove(id); dropped.expired++; }
    enforce('game'); enforce('prop');
  }
  // over budget: thin the oldest markets harder (half, then minPts), then drop the oldest
  // each sweep goes down to 95% of the budget so the next ones are rare
  function enforce(kind) {
    if (totals[kind] <= budget[kind]) return;
    const goal = Math.floor(budget[kind] * 0.95);
    const list = [...entries.values()].filter(e => e.kind === kind).sort((a, b) => ageOf(a) - ageOf(b));
    // markets more than a week past the start go to minPts first, then everything to half, then to minPts
    const weekAgo = now() - 7 * DAY;
    for (const [target, oldOnly] of [[minPts, true], [Math.max(minPts, Math.floor(maxPts[kind] / 2)), false], [minPts, false]]) {
      for (const e of list) {
        if (totals[kind] <= goal) return;
        if (oldOnly && ageOf(e) >= weekAgo) break;
        if (e.pts.length <= target) continue;
        const pts = kind === 'game' ? decodeGame(e) : decodeProp(e);
        const t = thin(pts, target, { diff: kind === 'game' ? gameDiff : propDiff, start: e.start });
        put({ ...e, ...(kind === 'game' ? encodeGame({ pts: t }) : encodeProp({ pts: t })), thinned: true });
        dropped.thinnedHarder++;
      }
    }
    for (const e of list) {
      if (totals[kind] <= goal) return;
      if (!entries.has(e.id)) continue;
      remove(e.id); dropped.removedForRoom++;
      if (!dropped.removedThrough || (e.start && e.start > dropped.removedThrough)) dropped.removedThrough = e.start;
    }
  }
  // decoded, in the live histories' own shapes
  function gameSeries(gameId) {
    const out = [];
    for (const e of entries.values()) if (e.kind === 'game' && String(e.game.game) === String(gameId)) out.push(toGameSeries(e));
    return out;
  }
  const toGameSeries = e => ({ id: e.key, game: e.game.game, start: e.start, label: e.game.label, market: e.game.market, league: e.game.league, leagueLabel: e.game.leagueLabel,
    event: e.game.event, pts: decodeGame(e), archived: true, thinned: e.thinned, reads: e.reads, firstAt: e.firstAt });
  function propSeries(key) {
    const e = entries.get(`prop:${key}`);
    if (!e) return null;
    return { id: e.key, event: e.prop.event, league: e.prop.league, start: e.start, player: e.prop.player, stat: e.prop.stat, line: e.prop.line,
      pts: decodeProp(e), archived: true, thinned: e.thinned, reads: e.reads, firstAt: e.firstAt };
  }
  // one row per market (a game's market groups its sides)
  function index() {
    const rows = new Map();
    for (const e of entries.values()) {
      if (e.kind === 'prop') { rows.set(e.id, { kind: 'prop', key: e.key, event: e.prop.event, league: e.prop.league, start: e.start, player: e.prop.player, stat: e.prop.stat, line: e.prop.line, firstAt: e.firstAt, lastAt: e.lastAt, reads: e.reads, venues: [...(e.v || [])], archived: true }); continue; }
      const k = `game:${e.game.game}|${e.game.market}`;
      const r = rows.get(k);
      if (r) { r.reads += e.reads; if (e.firstAt < r.firstAt) r.firstAt = e.firstAt; if (e.lastAt > r.lastAt) r.lastAt = e.lastAt; for (const v of e.v || []) if (!r.venues.includes(v)) r.venues.push(v); continue; }
      rows.set(k, { kind: 'game', key: String(e.game.game), market: e.game.market, event: e.game.event, league: e.game.league, leagueLabel: e.game.leagueLabel, start: e.start, firstAt: e.firstAt, lastAt: e.lastAt, reads: e.reads, venues: [...(e.v || [])], archived: true });
    }
    return [...rows.values()];
  }
  function oldestFirstAt() {
    let o = null;
    for (const e of entries.values()) if (!o || e.firstAt < o) o = e.firstAt;
    return o;
  }
  function status() {
    const n = { game: 0, prop: 0 };
    for (const e of entries.values()) n[e.kind]++;
    return { keepDays, markets: n, points: { ...totals }, budget: { ...budget }, maxPts: { ...maxPts }, minPts, since: oldestFirstAt(), dropped: { ...dropped } };
  }
  const dump = () => [...entries.values()];
  function load(docs) {
    for (const d of docs || []) {
      if (!d || !d.id || !Array.isArray(d.pts) || !Array.isArray(d.v) || !(d.kind === 'game' || d.kind === 'prop')) continue;
      const had = entries.get(d.id);
      if (had && had.lastAt >= d.lastAt) continue;
      put(d);
    }
    enforce('game'); enforce('prop');
  }
  return { add, prune, enforce, gameSeries, propSeries, index, status, dump, load, has: id => entries.has(id), size: () => entries.size, points: () => totals.game + totals.prop };
}

// ── what a viewer may see: the fair is Pro; Kalshi needs its data licence ──
function cutGame(series, { pro = true, kalshi = true } = {}) {
  return series.map(x => ({ ...x, pts: x.pts.map(([t, p, f, px]) => [t, p, pro ? f : null, kalshi ? px : Object.fromEntries(Object.entries(px || {}).filter(([k]) => k !== 'kalshi'))]) }));
}
// a prop series (live or archived, [t, fairOver, { v: [o, u] }]) → one series per side, as the charts read it
function propSides(x) {
  const side = (i, label) => ({ id: `${x.id}|${i ? 'under' : 'over'}`, label, market: 'prop',
    pts: x.pts.map(([t, f, px]) => [t, x.line, f == null ? null : r4(i ? 1 - f : f), Object.fromEntries(Object.entries(px || {}).filter(([, a]) => a[i] != null).map(([v, a]) => [v, a[i]]))]) });
  return [side(0, `Over ${x.line}`), side(1, `Under ${x.line}`)];
}
// the plan's window: reads older than `days` before now are left out
function windowed(series, days, now = Date.now()) {
  if (!days) return series;
  const cut = now - days * DAY;
  return series.map(x => ({ ...x, pts: x.pts.filter(p => p[0] >= cut) })).filter(x => x.pts.length);
}

// ── downloads ──
const CSV_COLUMNS = ['time_utc', 'event', 'league', 'market', 'side', 'line', 'venue', 'american', 'decimal', 'implied_prob', 'fair_prob'];
// a text cell that a spreadsheet would read as a formula gets a leading '
const csvCell = v => {
  if (v == null) return '';
  let s = String(v);
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s) && !/^[+-]?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const decOf = a => (a == null ? null : Math.round((a > 0 ? 1 + a / 100 : 1 + 100 / -a) * 1e4) / 1e4);
// series: game-shaped ([t, point, fair, { venue: american }]); one row per read and venue
function toCsv(meta, series) {
  const rows = [CSV_COLUMNS.join(',')];
  for (const x of series) {
    for (const [t, point, fair, px] of x.pts) {
      const at = new Date(t).toISOString();
      const vs = Object.entries(px || {});
      if (!vs.length) rows.push([at, meta.event, meta.league, x.market, x.label, point, '', '', '', '', fair].map(csvCell).join(','));
      for (const [v, a] of vs) rows.push([at, meta.event, meta.league, x.market, x.label, point, v, a, decOf(a), r4(prob(a)), fair].map(csvCell).join(','));
    }
  }
  return rows.join('\n') + '\n';
}
function toJson(meta, series) {
  return { ...meta, series: series.map(x => ({ id: x.id, market: x.market, side: x.label,
    points: x.pts.map(([t, point, fair, px]) => ({ t: new Date(t).toISOString(), line: point ?? null, fair: fair ?? null, prices: px || {} })) })) };
}

// ── pages ──
const COLORS = { pinnacle: '#cbd5e1', kalshi: '#3987e5', polymarketus: '#d95926', gemini: '#199e70', fanduel: '#c98500', betrivers: '#d55181', draftkings: '#008300', matchbook: '#9085e9', betmgm: '#e66767',
  prizepicks: '#a855f7', underdog: '#eab308', sleeper: '#22d3ee', pick6: '#16a34a', betr: '#f472b6' };
const SPARE = ['#f97316', '#84cc16', '#06b6d4', '#ec4899', '#a3a3a3', '#facc15'];
const REFS = new Set(['pinnacle', 'matchbook', 'polymarket']);
const nameOf = v => venues.NAMES[v] || { pinnacle: 'Pinnacle', matchbook: 'Matchbook', polymarketus: 'Polymarket US', pick6: 'DK Pick6' }[v] || v;
const MARKET_LABEL = { ml: 'Moneyline', spread: 'Spread', total: 'Total', prop: 'Player prop' };
// a prop's stat key in words: 'pass_att' → 'pass attempts' (the key stays as is in the API and the CSV)
const STAT_LABEL = { pass_att: 'pass attempts', pass_comp: 'completions', pass_yds: 'passing yards', pass_tds: 'passing TDs', pass_ints: 'interceptions', rush_att: 'rush attempts',
  rush_yds: 'rushing yards', rush_tds: 'rushing TDs', rec_yds: 'receiving yards', rush_rec_yds: 'rushing + receiving yards', pass_rush_yds: 'passing + rushing yards', receptions: 'receptions',
  targets: 'targets', anytime_td: 'anytime TD', pra: 'pts + reb + ast', pr: 'pts + reb', pa: 'pts + ast', ra: 'reb + ast', threes: '3-pointers', blocks_steals: 'blocks + steals',
  sog: 'shots on goal', shots_on_goal: 'shots on goal', saves: 'saves', hits_runs_rbis: 'hits + runs + RBIs', total_bases: 'total bases', strikeouts: 'strikeouts', fg_made: 'field goals made' };
const WORD = { yds: 'yards', tds: 'TDs', td: 'TD', att: 'attempts', comp: 'completions', ints: 'interceptions', rec: 'receiving', pts: 'points', reb: 'rebounds', ast: 'assists', rbis: 'RBIs' };
const statLabel = k => (k == null || k === '' ? '' : STAT_LABEL[k] || String(k).split('_').filter(Boolean).map(w => WORD[w] || w).join(' '));
const whenUtc = t => { const x = ms(typeof t === 'number' ? new Date(t).toISOString() : t); return x == null ? '—' : new Date(x).toISOString().slice(0, 16).replace('T', ' ') + ' UTC'; };
const dateUtc = t => { const x = typeof t === 'number' ? t : ms(t); return x == null ? '—' : new Date(x).toISOString().slice(0, 10); };

// The chart, drawn the same on the server and in the browser (the page
// inlines this function's source and redraws it at the box's own width).
// It must not use anything outside itself.
function chartSvg(d, W) {
  const H = W < 500 ? 200 : 250, L = 40, R = 10, T = 12, B = 26;
  const all = [];
  for (const l of d.lines) for (const p of l.pts) all.push(p);
  if (!all.length) return '';
  let t0 = 1e15, t1 = -1e15, y0 = 1e15, y1 = -1e15;
  for (const p of all) { if (p[0] < t0) t0 = p[0]; if (p[0] > t1) t1 = p[0]; if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1]; }
  if (t1 - t0 < 60e3) t1 = t0 + 60e3;
  const pad = Math.max(0.01, (y1 - y0) * 0.15); y0 = Math.max(0, y0 - pad); y1 = Math.min(1, y1 + pad);
  if (y1 - y0 < 0.02) { y0 = Math.max(0, y0 - 0.01); y1 = Math.min(1, y1 + 0.01); }
  const X = t => L + (t - t0) / (t1 - t0) * (W - L - R), Y = p => T + (1 - (p - y0) / (y1 - y0)) * (H - T - B);
  const lab = t => new Date(t).toISOString().slice(5, 16).replace('T', ' ');
  let s = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${d.title}" style="display:block;max-width:100%;height:auto">`;
  for (let i = 0; i < 4; i++) { const p = y0 + (y1 - y0) * i / 3; s += `<line x1="${L}" x2="${W - R}" y1="${Y(p).toFixed(1)}" y2="${Y(p).toFixed(1)}" stroke="#1e2738" stroke-width="1"/><text x="${L - 6}" y="${(Y(p) + 3).toFixed(1)}" fill="#8391a7" font-size="10" text-anchor="end">${(p * 100).toFixed(0)}%</text>`; }
  [t0, (t0 + t1) / 2, t1].forEach((t, i) => { s += `<text x="${X(t).toFixed(1)}" y="${H - 8}" fill="#8391a7" font-size="10" text-anchor="${['start', 'middle', 'end'][i]}">${lab(t)}</text>`; });
  if (d.start != null && d.start > t0 && d.start < t1) s += `<line x1="${X(d.start).toFixed(1)}" x2="${X(d.start).toFixed(1)}" y1="${T}" y2="${H - B}" stroke="#94a3b8" stroke-width="1" stroke-dasharray="2 3"/><text x="${(X(d.start) + 3).toFixed(1)}" y="${T + 9}" fill="#94a3b8" font-size="10">start</text>`;
  for (const l of d.lines) {
    if (!l.pts.length) continue;
    let p = '';
    l.pts.forEach((q, i) => { p += i ? `H${X(q[0]).toFixed(1)}V${Y(q[1]).toFixed(1)}` : `M${X(q[0]).toFixed(1)},${Y(q[1]).toFixed(1)}`; });
    p += `H${X(l.end == null ? t1 : Math.min(l.end, t1)).toFixed(1)}`;
    s += `<path d="${p}" fill="none" stroke="${l.color}" stroke-width="2"${l.dash ? ` stroke-dasharray="${l.dash}"` : ''} stroke-linejoin="round"/>`;
  }
  return s + '</svg>';
}

const PAGE_CSS = `
.chips { display:flex; flex-wrap:wrap; gap:6px; margin:0 0 12px; }
.chip { font:600 11px var(--mono); letter-spacing:.06em; color:var(--text2); text-decoration:none; border:1px solid var(--border2); border-radius:6px; padding:5px 10px; white-space:nowrap; }
.chip.on { color:var(--bg); background:var(--green2); border-color:var(--green2); }
.chart { background:var(--card); border:1px solid var(--border); border-radius:10px; padding:10px; margin:0 0 10px; min-width:0; overflow:hidden; }
.legend { display:flex; flex-wrap:wrap; gap:6px 14px; margin:0 0 14px; font:500 12px var(--mono); color:var(--text2); }
.legend span { display:inline-flex; align-items:center; gap:6px; }
.legend i { display:inline-block; width:12px; height:3px; border-radius:2px; }
.legend em { font-style:normal; color:var(--muted); font-size:11px; }
.sub { display:block; color:var(--muted); font-size:11px; font-family:var(--mono); }
.note { color:var(--text2); font-size:14px; }
.empty { background:var(--card); border:1px dashed var(--border2); border-radius:10px; padding:14px 16px; color:var(--text2); margin:0 0 18px; }
.st-pick { display:flex; flex-wrap:wrap; gap:8px; align-items:center; margin:0 0 16px; font:500 12px var(--mono); color:var(--muted); }
.st-pick select, .st-pick button, .st-pick input { background:var(--card); color:var(--text); border:1px solid var(--border); border-radius:6px; padding:6px 8px; font:600 12px var(--mono); max-width:100%; min-width:0; }
.st-pick button { cursor:pointer; letter-spacing:1px; }
.st-pick span { flex-basis:100%; font-size:11px; }
@media (max-width:560px) { .st-pick { display:grid; grid-template-columns:max-content minmax(0,1fr); } .st-pick button, .st-pick span { grid-column:1 / -1; } .st-pick button { justify-self:start; } }
.links { display:flex; flex-wrap:wrap; gap:8px; margin:0 0 20px; }
.links .go { margin:0; }
td.n, th.n { text-align:right; white-space:nowrap; }
ul.mk { list-style:none; padding:0; margin:0 0 16px; border-top:1px solid var(--border); }
ul.mk li { border-bottom:1px solid var(--border); margin:0; }
ul.mk a { display:block; padding:10px 0; color:var(--text); text-decoration:none; overflow-wrap:anywhere; }
ul.mk a b { font-weight:600; }
.tag { display:inline-block; font:600 10px var(--mono); letter-spacing:.08em; text-transform:uppercase; border:1px solid var(--border2); color:var(--text2); border-radius:4px; padding:1px 6px; white-space:nowrap; }
`;
function head({ title, description, canonical = null, index = true }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta name="robots" content="${index ? 'index,follow' : 'noindex'}">
<meta name="theme-color" content="#080b10">
${canonical ? `<link rel="canonical" href="${esc(canonical)}">` : ''}
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<link rel="icon" href="${FAVICON}">
<style>${CSS}${PAGE_CSS}</style>
</head>`;
}
const top = () => `<header class="top"><div class="top-in"><a class="brand" href="/">${LOGO}<span>LINE<b>REAPER</b></span></a><a class="back" href="/app?start=odds">OPEN THE APP</a></div></header>`;
const foot = () => `<footer><div class="in"><nav><a href="/">Line Reaper</a><a href="/lines">Line history</a><a href="/leagues">Leagues</a><a href="/developers">API</a><a href="/pricing">Pricing</a><a href="/learn">Learn</a><a href="/terms">Terms</a><a href="/responsible-gambling">Responsible gambling</a></nav>
<div>Line Reaper is an information service, not a sportsbook. It does not take or place bets. These are the prices each feed showed when we read it; a line move is information, not a proven edge. 21+ only. Gambling problem? Call or text 1-800-GAMBLER.</div></div></footer>`;

// the query a page keeps on its own links: state and odds format, each only when not the default (Texas, American)
function keepQs(o = {}) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v != null && v !== '') p.set(k, v);
  const q = p.toString();
  return q ? `?${q}` : '';
}
// venues: true → every venue ('all'); 'state' → only the state's, said out loud so the saved choice is cleared
const viewQs = (st, fmt, all) => ({ state: st && st !== 'TX' ? st : null, odds: fmt !== 'american' ? fmt : null, venues: all === true ? 'all' : all === 'state' ? 'state' : null });
// "Show every venue" is kept in this browser like My state and the odds
// format: a page opened with ?venues=all or ?venues=state saves the choice,
// a page opened with neither reopens with the saved one
const venuesPrefScript = () => `<script>(function(){try{var u=new URL(location.href),p=u.searchParams.get('venues');if(p==='all'||p==='state'){localStorage.setItem('lr_lines_venues',p);return}if(localStorage.getItem('lr_lines_venues')==='all'){u.searchParams.set('venues','all');location.replace(u.toString())}}catch(e){}})();</script>`;
// the app keeps My state and the odds format in this browser; a page opened
// without them in the link picks them up from there once
const prefsScript = () => `<script>(function(){try{var u=new URL(location.href);if(u.searchParams.has('state')||u.searchParams.has('odds')||sessionStorage.getItem('lr_lines_prefs'))return;sessionStorage.setItem('lr_lines_prefs','1');var s=localStorage.getItem('lr_state'),f=localStorage.getItem('lr_odds_fmt'),c=false;if(s&&/^[A-Z]{2}$/.test(s)&&s!=='TX'){u.searchParams.set('state',s);c=true}if(f&&/^[a-z]+$/.test(f)&&f!=='american'){u.searchParams.set('odds',f);c=true}if(c)location.replace(u.toString())}catch(e){}})();</script>`;

function pickerForm(action, hidden, { st, fmt, states }) {
  const hid = Object.entries(hidden).filter(([, v]) => v != null && v !== '').map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('');
  return `<form class="st-pick" method="get" action="${esc(action)}">${hid}<label for="stp">Betting from</label><select id="stp" name="state">${states.map(([c, n]) => `<option value="${esc(c)}"${c === st ? ' selected' : ''}>${esc(n)}</option>`).join('')}</select><label for="sto">Odds</label><select id="sto" name="odds">${oddsFmt.OPTIONS.map(([v, n]) => `<option value="${esc(v)}"${v === fmt ? ' selected' : ''}>${esc(n)}</option>`).join('')}</select><button type="submit">SHOW</button><span>Venues a resident can use, from our venue table. Pinnacle and Matchbook are the sharp references, not US venues. Exchange prices are the all-in cost with the taker fee in.</span></form>`;
}

// a market a resident of `st` could bet: at least one venue it was read at is
// open there on our venue table (Pinnacle and the other references don't count;
// Kalshi only when the viewer may see Kalshi's prices)
function usableIn(row, st, { kalshi = true } = {}) {
  return (row.venues || []).some(v => !REFS.has(v) && (kalshi || v !== 'kalshi') && venues.statusOf(st, v) === 'yes');
}
// what one venue is to the viewer's state
function venueRole(v, st) {
  if (REFS.has(v)) return { show: true, tag: 'reference' };
  const s = venues.statusOf(st, v);
  return { show: s === 'yes', tag: s === 'yes' ? `${st}: yes` : s === 'no' ? `not in ${st}` : `${st}: check` };
}

// data: { kind: 'game' | 'prop', id, meta: { event, league, leagueLabel, start, player, stat, line },
//   series: [{ id, market, label, pts: [[t, point, fair, { venue: american }]], archived, thinned, reads }],
//   market, side, pro, now, keepDays, liveKeepHours, windowDays, plan }
// opts: { st, fmt, allVenues, states }
function marketPage(data, { st = 'TX', fmt = 'american', allVenues = false, states = [], origin = '' } = {}) {
  const now = data.now ?? Date.now();
  const kind = data.kind;
  const base = kind === 'game' ? `/lines/game/${encodeURIComponent(data.id)}` : '/lines/prop';
  const keyQ = kind === 'prop' ? { key: data.id } : {};
  const meta = data.meta || {};
  const markets = kind === 'game' ? [...new Set(data.series.map(x => x.market))].sort((a, b) => ['ml', 'spread', 'total'].indexOf(a) - ['ml', 'spread', 'total'].indexOf(b)) : ['prop'];
  const market = markets.includes(data.market) ? data.market : markets[0];
  const sides = data.series.filter(x => x.market === market && x.pts.length);
  const side = sides.find(x => x.id === data.side) || sides[0] || null;
  const keep = viewQs(st, fmt, allVenues);
  const title = kind === 'game'
    ? `${meta.event || 'Game'}: ${MARKET_LABEL[market] || market || 'line'} history`
    : `${meta.player || 'Player'} ${statLabel(meta.stat)} ${meta.line ?? ''}: line history`.replace(/\s+/g, ' ');
  const description = side ? `Every saved price for ${title.replace(/ history$/, '')} at each venue we read, Pinnacle included, from ${dateUtc(side.pts[0][0])}. Kept ${data.keepDays} days after the start.` : `Line history at Line Reaper: kept ${data.keepDays} days after the start.`;
  const canonical = origin && side ? `${origin}${base}${keepQs({ ...keyQ, market: kind === 'game' ? market : null })}` : null;
  const back = `<p class="kicker"><a href="/lines${esc(keepQs({ state: keep.state, odds: keep.odds }))}" style="color:inherit;text-decoration:none">Line history</a>${meta.leagueLabel || meta.league ? ` · ${esc(meta.leagueLabel || String(meta.league).toUpperCase())}` : ''}</p>`;
  if (!side) {
    return `${head({ title: 'Line history | Line Reaper', description, index: false })}
<body>
${top()}
<main>
${back}
<h1>No saved prices for this market</h1>
<div class="empty">We have no saved prices for this ${kind === 'prop' ? 'prop' : 'game'}. A market's prices are saved from when it first shows up on the board and kept ${esc(String(data.keepDays))} days after its start${data.windowDays && data.windowDays < data.keepDays ? `; on your plan, the last ${esc(String(data.windowDays))} days` : ''}. <a href="/lines">See every market we keep</a>.</div>
</main>
${foot()}
</body>
</html>`;
  }
  const chip = (href, label, on) => `<a class="chip${on ? ' on' : ''}" href="${esc(href)}"${on ? ' aria-current="true"' : ''}>${esc(label)}</a>`;
  const mChips = kind === 'game' && markets.length > 1 ? `<div class="chips">${markets.map(m => chip(`${base}${keepQs({ market: m, ...keep })}`, MARKET_LABEL[m] || m, m === market)).join('')}</div>` : '';
  const sChips = sides.length > 1 ? `<div class="chips">${sides.map(x => chip(`${base}${keepQs({ ...keyQ, market: kind === 'game' ? market : null, side: x.id, ...keep })}`, x.label, x.id === side.id)).join('')}</div>` : '';
  const vin = [...new Set(side.pts.flatMap(p => Object.keys(p[3] || {})))];
  const roles = Object.fromEntries(vin.map(v => [v, venueRole(v, st)]));
  const order = ['pinnacle', 'matchbook', 'kalshi', 'polymarketus', 'gemini', 'fanduel', 'betrivers', 'prizepicks', 'underdog', 'sleeper', 'pick6'];
  vin.sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99) || a.localeCompare(b));
  const shown = vin.filter(v => allVenues || roles[v].show);
  let spare = 0;
  const color = v => COLORS[v] || SPARE[spare++ % SPARE.length];
  const colorOf = Object.fromEntries(vin.map(v => [v, color(v)]));
  const lines = [];
  if (data.pro && side.pts.some(p => p[2] != null)) lines.push({ key: 'fair', name: kind === 'prop' ? 'Fair (no vig)' : 'Fair (Pinnacle, no vig)', color: '#e2e8f0', dash: '4 3', pts: side.pts.filter(p => p[2] != null).map(p => [p[0], p[2]]) });
  for (const v of shown) {
    const pts = side.pts.filter(p => p[3]?.[v] != null).map(p => [p[0], r4(prob(p[3][v]))]);
    if (pts.length) lines.push({ key: v, name: nameOf(v), color: colorOf[v], pts });
  }
  const start = ms(meta.start);
  const chartData = { title: esc(`Line history for ${side.label}`), start, lines };
  const legend = `<div class="legend">${lines.map(l => `<span><i style="background:${l.color}"></i>${esc(l.name)}${l.key !== 'fair' ? ` <em>${esc(roles[l.key].tag)}</em>` : ''}</span>`).join('')}</div>`;
  const hiddenV = vin.filter(v => !shown.includes(v));
  const vToggle = hiddenV.length || allVenues
    ? `<p class="note">${allVenues ? `Showing every venue, ${esc(st)} or not. <a href="${esc(base + keepQs({ ...keyQ, market: kind === 'game' ? market : null, side: side.id, ...viewQs(st, fmt, 'state') }))}">Only ${esc(st)} venues</a>.` : `Not shown, not open to a ${esc(st)} resident on our venue table: ${hiddenV.map(v => esc(nameOf(v))).join(', ')}. <a href="${esc(base + keepQs({ ...keyQ, market: kind === 'game' ? market : null, side: side.id, ...viewQs(st, fmt, true) }))}">Show every venue</a>.`}</p>` : '';
  // every venue that priced it is hidden for this state and there is no fair to draw: say so, no empty chart or table of dashes
  const nothingShown = !allVenues && !lines.length && hiddenV.length > 0;
  const showAllHref = base + keepQs({ ...keyQ, market: kind === 'game' ? market : null, side: side.id, ...viewQs(st, fmt, true) });
  const first = side.pts[0][0], last = side.pts[side.pts.length - 1][0];
  const span = (now - first) / DAY;
  const since = `Saved since ${whenUtc(first)}${span < data.keepDays ? ` (${span < 1 ? 'less than a day' : `${Math.floor(span)} day${Math.floor(span) === 1 ? '' : 's'}`} of history, shorter than ${data.keepDays} days because that is when this market first showed up${data.windowDays && data.windowDays < data.keepDays ? ' or your plan\'s window starts' : ''})` : ''}. Last read ${whenUtc(last)}.`;
  const thinNote = side.thinned || side.archived
    ? ` This market's saved reads were thinned to ${side.pts.length} of ${side.reads || side.pts.length}: we keep the first and last read, the last one before the start, the biggest moves and a few spread through time. Every row below is a real read; a dropped one was a small move between two kept.`
    : ` Each read is kept while the market is on the board: a point when anything moved (at most every 4 minutes) or every 30 minutes.`;
  const fairNote = data.pro ? '' : ' The fair (Pinnacle\'s no-vig price) is for subscribers; every price is here.';
  // the reads, newest first, in the viewer's odds format
  const rows = side.pts.slice().reverse();
  const cap = 300;
  const cell = a => esc(oddsFmt.fromAm(a, fmt));
  const table = `<div class="scroll"><table><thead><tr><th>Read (UTC)</th>${kind === 'game' && market !== 'ml' ? '<th class="n">Line</th>' : ''}${data.pro ? '<th class="n">Fair</th>' : ''}${shown.map(v => `<th class="n">${esc(nameOf(v))}</th>`).join('')}</tr></thead><tbody>${rows.slice(0, cap).map(p => `<tr><td>${esc(whenUtc(p[0]).replace(' UTC', ''))}</td>${kind === 'game' && market !== 'ml' ? `<td class="n">${p[1] == null ? '—' : esc((market === 'spread' && p[1] > 0 ? '+' : '') + p[1])}</td>` : ''}${data.pro ? `<td class="n">${p[2] == null ? '—' : esc(`${(p[2] * 100).toFixed(1)}%`)}</td>` : ''}${shown.map(v => `<td class="n">${p[3]?.[v] == null ? '—' : cell(p[3][v])}</td>`).join('')}</tr>`).join('')}</tbody></table></div>${rows.length > cap ? `<p class="note">The newest ${cap} of ${rows.length} reads; the download has all of them.</p>` : ''}`;
  const dl = (f) => `/api/lines/${kind}${kind === 'game' ? `/${encodeURIComponent(data.id)}` : ''}${keepQs({ ...keyQ, market: kind === 'game' ? market : null, format: f })}`;
  const lineNote = kind === 'game' && market !== 'ml' ? ' Line is Pinnacle\'s main number; a venue at another number is left out of that read, not shown at the wrong number.' : '';
  return `${head({ title: `${title} | Line Reaper`, description, canonical })}
<body>
${top()}
<main>
${back}
<h1>${esc(title.replace(/ history$/, ''))}</h1>
<p class="lead">${esc(kind === 'game' ? `${meta.event || ''}` : `${meta.event || ''}`)}${meta.start ? ` · ${start != null && start < now ? 'started' : 'starts'} ${esc(whenUtc(meta.start))}` : ''}</p>
${pickerForm(base, { ...keyQ, market: kind === 'game' ? market : null, side: side.id, venues: allVenues ? 'all' : null }, { st, fmt, states })}
${mChips}${sChips}
${nothingShown ? `<div class="empty">No venue a ${esc(st)} resident can use on our venue table priced this ${kind === 'prop' ? 'prop' : 'market'}: ${hiddenV.map(v => esc(nameOf(v))).join(', ')}. <a href="${esc(showAllHref)}">Show every venue</a>.</div>` : `<div class="chart" id="lhChart">${chartSvg(chartData, 720)}</div>
${legend}`}
<p class="note">The chance each price implies, over time, fees in: lower is a better price for ${esc(side.label)}. ${esc(since)}${esc(thinNote)}${esc(fairNote)}${esc(lineNote)}</p>
${nothingShown ? '' : vToggle}
<div class="links"><a class="go" href="${esc(dl('csv'))}" download>DOWNLOAD CSV</a><a class="go" href="${esc(dl('json'))}">DOWNLOAD JSON</a><a class="go" href="/developers#lines">IN THE API →</a></div>
${nothingShown ? '' : `<h2>Every read</h2>
${table}`}
<p class="note">A line move is information, not a proven edge. Venues still at an old number have graded as no edge against the close on our record.</p>
</main>
${foot()}
<script>(function(){var draw=${chartSvg.toString()};var d=${JSON.stringify(chartData).replace(/</g, '\\u003c')};var el=document.getElementById('lhChart');if(!el)return;function go(){var w=Math.max(280,Math.round(el.clientWidth-20));el.innerHTML=draw(d,w)}go();var t;window.addEventListener('resize',function(){clearTimeout(t);t=setTimeout(go,150)})})();</script>
${prefsScript()}
${venuesPrefScript()}
</body>
</html>`;
}

// rows: index rows (live and archived, one per market) in filterIndex's 'soon'
// order: not started yet soonest first, then started, most recent first
// q: { q, league, kind }, leagues: [[key, label, n]]; hidden: rows left out
// because no venue open in the viewer's state priced them (allVenues off)
function indexPage({ rows = [], total = 0, hidden = 0, leagues = [], q = {}, since = null, keepDays = KEEP_DAYS, now = Date.now(), next = null, status = null } = {}, { st = 'TX', fmt = 'american', allVenues = false, states = [], origin = '' } = {}) {
  const keep = viewQs(st, fmt, allVenues ? true : null);
  const listQs = all => keepQs({ q: q.q, league: q.league, kind: q.kind, ...viewQs(st, fmt, all) });
  const showAll = `<a href="/lines${esc(listQs(true))}">Show every venue</a>`;
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const venueNote = allVenues
    ? `Showing markets at every venue we read, ${esc(st)} or not. <a href="/lines${esc(listQs('state'))}">Only ${esc(st)} venues</a>.`
    : `Showing markets priced by at least one venue a ${esc(st)} resident can use, on our venue table${hidden ? `; ${plural(hidden, 'market', 'markets')} priced only elsewhere ${hidden === 1 ? 'is' : 'are'} left out` : ''}. ${showAll}.`;
  const href = r => r.kind === 'game' ? `/lines/game/${encodeURIComponent(r.key)}${keepQs({ market: r.market, ...keep })}` : `/lines/prop${keepQs({ key: r.key, ...keep })}`;
  const item = r => {
    const s = ms(r.start);
    const what = r.kind === 'game' ? `${r.event || r.key} · ${MARKET_LABEL[r.market] || r.market}` : `${r.player || ''} ${statLabel(r.stat)} ${r.line ?? ''} · ${r.event || ''}`.replace(/\s+/g, ' ');
    return `<li><a href="${esc(href(r))}"><b>${esc(what)}</b><span class="sub">${esc(String(r.leagueLabel || r.league || '').toUpperCase())}${r.start ? ` · ${s != null && s < now ? 'started' : 'starts'} ${esc(whenUtc(r.start))}` : ''} · ${r.reads} read${r.reads === 1 ? '' : 's'} since ${esc(dateUtc(r.firstAt))}${r.archived ? ' · closed' : ' · on the board'}</span></a></li>`;
  };
  const form = `<form class="st-pick" method="get" action="/lines"><label for="lq">Find</label><input id="lq" name="q" value="${esc(q.q || '')}" placeholder="team or player" maxlength="60"><label for="ll">League</label><select id="ll" name="league"><option value="">All</option>${leagues.map(([k, l, n]) => `<option value="${esc(k)}"${k === q.league ? ' selected' : ''}>${esc(l)} (${n})</option>`).join('')}</select><label for="lk">Kind</label><select id="lk" name="kind"><option value="">Both</option><option value="game"${q.kind === 'game' ? ' selected' : ''}>Game lines</option><option value="prop"${q.kind === 'prop' ? ' selected' : ''}>Props</option></select><label for="stp">Betting from</label><select id="stp" name="state">${states.map(([c, n]) => `<option value="${esc(c)}"${c === st ? ' selected' : ''}>${esc(n)}</option>`).join('')}</select><label for="sto">Odds</label><select id="sto" name="odds">${oddsFmt.OPTIONS.map(([v, n]) => `<option value="${esc(v)}"${v === fmt ? ' selected' : ''}>${esc(n)}</option>`).join('')}</select>${allVenues ? '<input type="hidden" name="venues" value="all">' : ''}<button type="submit">SHOW</button></form>`;
  const upRows = rows.filter(r => { const t = ms(r.start); return t != null && t >= now; }), pastRows = rows.filter(r => !upRows.includes(r));
  const list = (label, rs) => (rs.length ? `<p class="kicker">${label}</p><ul class="mk">${rs.map(item).join('')}</ul>` : '');
  const emptyTxt = !allVenues && hidden && !total
    ? `No saved market ${q.q || q.league || q.kind ? 'matching that search ' : ''}was priced by a venue a ${esc(st)} resident can use on our venue table: ${plural(hidden, 'market was', 'markets were')} priced only elsewhere. ${showAll}.`
    : `No saved market matches${q.q || q.league || q.kind ? ' that search' : ' yet'}.`;
  const sinceTxt = since ? `We started keeping ${keepDays} days on ${dateUtc(since)}, so the oldest market here is from then${(now - ms(since)) / DAY < keepDays ? `: ${(n => `${n} day${n === 1 ? '' : 's'}`)(Math.max(0, Math.floor((now - ms(since)) / DAY)))} so far` : ''}.` : 'Nothing is saved yet.';
  const dropTxt = status && (status.dropped.removedForRoom || status.dropped.thinnedHarder) ? ` To stay small, ${status.dropped.thinnedHarder} older market${status.dropped.thinnedHarder === 1 ? ' was' : 's were'} thinned harder and ${status.dropped.removedForRoom} removed early.` : '';
  return `${head({ title: 'Line history: every market\'s prices for 30 days | Line Reaper', description: `Every game line and player prop we read, Pinnacle included, with each venue's price over time, kept ${keepDays} days after the start. Chart, table and CSV download.`, canonical: origin ? `${origin}/lines` : null })}
<body>
${top()}
<main>
<p class="kicker">Line history</p>
<h1>Every market's prices, kept ${keepDays} days</h1>
<p class="lead">Each game line and player prop we read, at every venue we read it, Pinnacle included: a chart, every read in a table, and a CSV or JSON download. Only prices we actually read; nothing filled in.</p>
<p class="note">${esc(sinceTxt)} A market is saved from when it first shows up and kept ${keepDays} days after its start.${esc(dropTxt)}</p>
${form}
<p class="note" id="lhVenues">${venueNote}</p>
${rows.length ? `${list('Not started yet, soonest first', upRows)}${list('Started, most recent first', pastRows)}` : `<div class="empty">${emptyTxt}</div>`}
<p class="note">${total} market${total === 1 ? '' : 's'} match${total === 1 ? 'es' : ''}${total > rows.length ? `; showing ${rows.length}` : ''}.</p>
${next != null ? `<p><a class="go" href="/lines${esc(keepQs({ q: q.q, league: q.league, kind: q.kind, ...keep, from: next }))}">MORE MARKETS →</a></p>` : ''}
<div class="links"><a class="go" href="/developers#lines">LINE HISTORY IN THE API →</a><a class="go" href="/app?start=odds">ODDS SCREEN →</a></div>
</main>
${foot()}
${prefsScript()}
${venuesPrefScript()}
</body>
</html>`;
}

// index rows → filtered and paged. order 'newest' (the API): newest start
// first, paged by start (`before`). order 'soon' (the /lines page): games not
// started yet, soonest first, then started ones, most recent first; paged by
// position (`from`). usable: a row test (the viewer's state); `hidden` counts
// the rows it left out.
function filterIndex(rows, { q = '', league = '', kind = '', before = null, from = 0, limit = 100, order = 'newest', usable = null, now = Date.now() } = {}) {
  const words = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
  let out = rows.filter(r => (!kind || r.kind === kind) && (!league || String(r.league || '').toLowerCase() === league)
    && words.every(w => `${r.event || ''} ${r.player || ''} ${r.stat || ''} ${r.league || ''}`.toLowerCase().includes(w)));
  let hidden = 0;
  if (usable) { const n = out.length; out = out.filter(usable); hidden = n - out.length; }
  if (order === 'soon') {
    const t = r => ms(r.start);
    const up = r => t(r) != null && t(r) >= now;
    out.sort((a, b) => (up(b) - up(a)) || (up(a) ? t(a) - t(b) : (t(b) ?? -Infinity) - (t(a) ?? -Infinity)) || String(a.key).localeCompare(String(b.key)));
    const total = out.length, at = Math.max(0, from | 0);
    const page = out.slice(at, at + limit);
    return { rows: page, total, hidden, from: at, next: at + limit < total ? at + limit : null, upcoming: out.filter(up).length };
  }
  out.sort((a, b) => (ms(b.start) ?? 0) - (ms(a.start) ?? 0) || String(a.key).localeCompare(String(b.key)));
  const total = out.length;
  if (before) out = out.filter(r => (r.start || '') < before);
  const page = out.slice(0, limit);
  return { rows: page, total, hidden, next: out.length > limit ? page[page.length - 1].start : null };
}

module.exports = { statLabel, KEEP_DAYS, DAY, thin, gameDiff, propDiff, encodeGame, decodeGame, encodeProp, decodeProp, createArchive, cutGame, propSides, windowed,
  CSV_COLUMNS, toCsv, toJson, chartSvg, marketPage, indexPage, filterIndex, venueRole, usableIn, nameOf, venuesPrefScript };
