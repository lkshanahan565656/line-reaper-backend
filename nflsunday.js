// ─── NFL SUNDAY BOARD: EVERY PICK'EM LEG, PRICED AND GRADED ─────────────────
// NFL Sunday is the biggest pick'em board of the week. This records every NFL
// player leg on PrizePicks, Underdog, Sleeper and DK Pick6 from Saturday on,
// next to Pinnacle's, FanDuel's and BetRivers' own prices for the same player
// and stat, and grades every leg from ESPN's box scores once the games end.
// Nothing here is flagged or alerted: it is a full, unbiased board, so a kind
// is judged on every leg it would have taken, not on the ones we happened to
// track.
//
// The recorder (scripts/nflsunday-record.js) runs inside GitHub Actions
// (Pick6 answers only there) and writes a change log: one line each time a
// source's number for a (player, stat) changes, so the open, every move and the
// last read before kickoff are all there. This module is the pure part:
// turning reads into log entries, replaying the log, pricing each leg at the
// app's own number and summarising the graded legs per kind against each app's
// break-even. Pinnacle's close is Pinnacle's raw line and price at the last
// read before kickoff, never a curve of ours: a leg whose number Pinnacle
// doesn't hang has no price, and says so.

const { canonName } = require('./ev');
const { sportMarketKey } = require('./propsboard');
const { devigPower } = require('./pinprops');
const { PP_ENTRIES, PP_GRADE, FIXED } = require('./sportprops');

const APPS = ['prizepicks', 'underdog', 'sleeper', 'pick6'];
const BOOKS = ['pinnacle', 'fanduel', 'betrivers'];
const UD_IMPLIED = 0.5623, UD_DECIMAL = 1.35;
const BET_LEAD_MS = 60 * 60e3;          // "bet time": the last read an hour before kickoff
const { toProb } = require('./mathutil');
const num = v => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

// ── reads → entries ──
// One app's lines → Map(key → { v, m }). key = player|stat, v = [line, over
// multiplier, under multiplier, over open, under open] (PrizePicks has no
// multipliers: null), m = what the grader needs the first time a key shows.
// tag: keys start with the sport ("NBA|lebronjames|points"), for a board
// that records several leagues in one log (the weekend board, 10-24)
const keyOf = (sport, player, mkey, tag) => `${tag ? `${sport}|` : ''}${canonName(player)}|${mkey}`;
function appEntries(lines, sport = 'NFL', { tag = false } = {}) {
  const out = new Map();
  for (const l of lines || []) {
    if (!l?.player || String(l.sport || '').toUpperCase() !== sport) continue;
    const line = num(l.line);
    if (line == null) continue;
    const mkey = sportMarketKey(l.market, sport);
    const key = keyOf(sport, l.player, mkey, tag);
    const pp = l.book === 'prizepicks';
    const v = [line, pp ? null : num(l.overMultiplier), pp ? null : num(l.underMultiplier), l.overOpen === false ? 0 : 1, l.underOpen === false ? 0 : 1];
    const old = out.get(key);
    // a stat listed twice: keep the line with both sides open, then the lower
    if (old && (old.v[3] + old.v[4] > v[3] + v[4] || (old.v[3] + old.v[4] === v[3] + v[4] && old.v[0] <= v[0]))) continue;
    out.set(key, { v, m: { p: l.player, tm: l.team || '', st: l.startTime || '', mt: l.matchTitle || l.opponent || '', mk: l.market || '', mkey, ...(tag ? { sp: sport } : {}) } });
  }
  return out;
}

// One book's two-sided props ({ player, mkey, line, over, under, start } with
// American prices) → Map(key → { v: [[line, over, under], …] by line, m })
function bookEntries(props, { sport = 'NFL', tag = false } = {}) {
  const out = new Map();
  for (const p of props || []) {
    const line = num(p.line), over = num(p.over), under = num(p.under);
    if (!p?.player || !p.mkey || line == null || over == null || under == null) continue;
    const key = keyOf(sport, p.player, p.mkey, tag);
    if (!out.has(key)) out.set(key, { v: [], m: { p: p.player, st: p.start || '', mkey: p.mkey, ...(tag ? { sp: sport } : {}) } });
    const e = out.get(key);
    if (!e.v.some(x => x[0] === line)) e.v.push([line, over, under]);
  }
  for (const e of out.values()) e.v.sort((a, b) => a[0] - b[0]);
  return out;
}

// FanDuel's one-sided "N+" rungs (combo ladders like "To Record 30+ Pts + Reb")
// → Map(key → { v: [[line, price], …], m }): kept raw for the combo pricing
function rungEntries(games, book, { sport = 'NFL', tag = false } = {}) {
  const out = new Map();
  for (const g of games || []) {
    const bm = (g.bookmakers || []).find(b => b.key === book);
    for (const r of bm?.ladders || []) {
      const line = num(r.line), price = num(r.price);
      if (!r.player || !r.mkey || line == null || price == null) continue;
      const key = keyOf(sport, r.player, r.mkey, tag);
      if (!out.has(key)) out.set(key, { v: [], m: { p: r.player, st: g.commence_time || '', mkey: r.mkey, ...(tag ? { sp: sport } : {}) } });
      const e = out.get(key);
      if (!e.v.some(x => x[0] === line)) e.v.push([line, price]);
    }
  }
  for (const e of out.values()) e.v.sort((a, b) => a[0] - b[0]);
  return out;
}

// Odds API-shaped games (freebooks.fetchFreeBooks) → one book's raw props
function gameProps(games, book) {
  const out = [];
  for (const g of games || []) {
    const bm = (g.bookmakers || []).find(b => b.key === book);
    for (const m of bm?.markets || []) {
      if (/^(h2h|spreads|totals)$/.test(m.key)) continue;
      const pairs = new Map();
      for (const o of m.outcomes || []) {
        if (!o.description || o.point == null) continue;
        const k = `${o.description}|${o.point}`;
        if (!pairs.has(k)) pairs.set(k, {});
        pairs.get(k)[o.name] = o;
      }
      for (const { Over, Under } of pairs.values()) if (Over && Under)
        out.push({ player: Over.description, mkey: m.key, line: Over.point, over: Over.price, under: Under.price, start: g.commence_time });
    }
  }
  return out;
}

// ── the change log ──
// write(obj) gets { t, s: source, k, v } when a key's value changes (with m
// the first time a key shows), and { t, s, k, gone: 1 } when a source that
// answered in full no longer lists it. A failed read changes nothing.
function createChangeLog(write) {
  const last = {};   // source → Map(key → json)
  let lines = 0;
  // scope: only keys starting with it can go (one league's read on a board
  // that logs several leagues per source)
  function observe(src, entries, t = Date.now(), { scope = '' } = {}) {
    const seen = last[src] || (last[src] = new Map());
    for (const [k, { v, m }] of entries) {
      const j = JSON.stringify(v);
      if (seen.get(k) === j) continue;
      const first = !seen.has(k);
      seen.set(k, j);
      write({ t, s: src, k, v, ...(first ? { m } : {}) }); lines++;
    }
    for (const k of [...seen.keys()]) if (!entries.has(k) && k.startsWith(scope)) { seen.delete(k); write({ t, s: src, k, gone: 1 }); lines++; }
  }
  return { observe, size: () => Object.fromEntries(Object.entries(last).map(([s, m]) => [s, m.size])), lines: () => lines };
}

// log lines (any order, several files) → { series: { src: Map(key → [{ t, v }]) }, meta: Map(key → m) }
function replay(records) {
  const series = {}, meta = new Map();
  const seen = new Set();
  for (const r of records) {
    if (!r || !r.s || !r.k) continue;
    // the same line pushed twice (a partial push and the final one) counts once
    const id = `${r.t}|${r.s}|${r.k}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const m = (series[r.s] ||= new Map());
    if (!m.has(r.k)) m.set(r.k, []);
    m.get(r.k).push({ t: r.t, v: r.gone ? null : r.v });
    if (r.m) {
      const old = meta.get(r.k) || {};
      // apps name the team and game; books only the start
      meta.set(r.k, { ...r.m, ...old, tm: old.tm || r.m.tm || '', mt: old.mt || r.m.mt || '', st: old.st || r.m.st || '' });
      if (APPS.includes(r.s)) (meta.get(r.k).starts ||= {})[r.s] = r.m.st;
    }
  }
  for (const m of Object.values(series)) for (const list of m.values()) list.sort((a, b) => a.t - b.t);
  return { series, meta };
}
// a series' value at t (the last change at or before t), or null
function at(list, t) {
  let v = null, found = false;
  for (const x of list || []) { if (x.t > t) break; v = x.v; found = true; }
  return found ? v : null;
}

// ── pricing at the app's number ──
// a book's ladder → its no-vig P(over) at exactly `line`, with its raw prices;
// { exact: false, nearest } when it hangs another number
function bookAt(ladder, line) {
  if (!Array.isArray(ladder) || !ladder.length) return null;
  const hit = ladder.find(x => x[0] === line);
  if (hit) {
    const po = toProb(hit[1]), pu = toProb(hit[2]);
    if (!(po > 0 && pu > 0) || po + pu < 1) return null;
    return { exact: true, line, over: hit[1], under: hit[2], pOver: +devigPower(po, pu).toFixed(4) };
  }
  const near = ladder.reduce((a, b) => (Math.abs(b[0] - line) < Math.abs(a[0] - line) ? b : a));
  return { exact: false, line: near[0], over: near[1], under: near[2], diff: +(near[0] - line).toFixed(2) };
}

// break-even win chance for one side of one leg on its app, at the entry the
// record grades it on: PrizePicks 3-pick Power (6x), Pick6 its 3-pick (6x)
// scaled by the pick's multiplier, Underdog its leg multiplier on the 3-pick
// standard (UD_IMPLIED) or a decimal price, Sleeper its decimal multiplier
function breakEven(app, side, v) {
  const mult = side === 'Over' ? v[1] : v[2], other = side === 'Over' ? v[2] : v[1];
  switch (app) {
    case 'prizepicks': return PP_GRADE.be;
    case 'pick6': return mult > 0 ? FIXED.pick6.grade.be / mult : null;
    case 'underdog': {
      const m = mult > 0 ? mult : 1;
      return m > UD_DECIMAL && !(other > 0 && other < 1) ? 1 / m : UD_IMPLIED / m;
    }
    case 'sleeper': return mult > 1 ? 1 / mult : null;
    default: return null;
  }
}
const sideOpen = (side, v) => (side === 'Over' ? v[3] : v[4]) !== 0;

// one app leg (app, key) → the leg's two sides at bet time and the close, or
// null when it never showed before kickoff. betLeadMs: bet time is that long
// before kickoff, or the leg's first read if it went up later.
function buildLeg(app, key, list, series, meta, { betLeadMs = BET_LEAD_MS } = {}) {
  const m = meta.get(key);
  const start = Date.parse(m?.starts?.[app] || m?.st || '');
  if (!m || !start) return null;
  const before = list.filter(x => x.t < start);
  const listed = before.filter(x => x.v);
  if (!listed.length) return null;
  const close = before[before.length - 1].v ? before[before.length - 1] : listed[listed.length - 1];
  const open = listed[0];
  // the line still up an hour out is bettable then, even if it last changed long before
  const betT = Math.max(open.t, start - betLeadMs);
  const bet = { t: betT, v: at(list, betT) || close.v };
  const price = (t, line) => Object.fromEntries(BOOKS.map(b => [b, bookAt(at(series[b]?.get(key), t), line)]).filter(([, q]) => q));
  return {
    app, key, sport: m.sp || 'NFL', player: m.p, team: m.tm, mkey: m.mkey, market: m.mk, matchTitle: m.mt, start: new Date(start).toISOString(),
    open: { t: open.t, line: open.v[0] }, bet: { t: bet.t, v: bet.v, books: price(bet.t, bet.v[0]) },
    close: { t: close.t, v: close.v, books: price(start - 1, close.v[0]) },
    moves: listed.reduce((n, x, i) => n + (i && x.v[0] !== listed[i - 1].v[0] ? 1 : 0), 0),
  };
}
function buildLegs(series, meta, o = {}) {
  const out = [];
  for (const app of APPS) for (const [key, list] of series[app] || []) {
    const leg = buildLeg(app, key, list, series, meta, o);
    if (leg) out.push(leg);
  }
  return out;
}

// a leg's two sides, each at bet-time numbers, with its break-even and every
// book's no-vig chance for that side then and at the close (exact number only)
function sides(leg) {
  const out = [];
  for (const side of ['Over', 'Under']) {
    const v = leg.bet.v;
    if (!sideOpen(side, v)) continue;
    const be = breakEven(leg.app, side, v);
    if (!(be > 0 && be < 1)) continue;
    const pick = q => (q?.exact ? (side === 'Over' ? q.pOver : +(1 - q.pOver).toFixed(4)) : null);
    const fair = Object.fromEntries(BOOKS.map(b => [b, pick(leg.bet.books[b])]));
    // the close at the bet's number: Pinnacle's last read before kickoff
    const closeFair = Object.fromEntries(BOOKS.map(b => [b, leg.close.v[0] === v[0] ? pick(leg.close.books[b]) : null]));
    out.push({ side, line: v[0], mult: side === 'Over' ? v[1] : v[2], be: +be.toFixed(4), fair, closeFair });
  }
  return out;
}

// ── kinds, fixed before any game is graded ──
// Each is a rule on one side of one leg at bet time, so every leg it would
// take is in its record. 'pin' kinds need Pinnacle at the app's own number.
const KINDS = {
  all: () => true,
  over: s => s.side === 'Over',
  under: s => s.side === 'Under',
  // Pinnacle at the app's number says this side clears the app's break-even
  'pin-backed': s => s.fair.pinnacle != null && s.fair.pinnacle >= s.be,
  // and by 2 points of win chance or more
  'pin-backed-2': s => s.fair.pinnacle != null && s.fair.pinnacle >= s.be + 0.02,
  // FanDuel and BetRivers both at the number, both past break-even
  'books-agree': s => s.fair.fanduel != null && s.fair.betrivers != null && s.fair.fanduel >= s.be && s.fair.betrivers >= s.be,
  // all three sharps at the number, all past break-even
  'three-sharps': s => BOOKS.every(b => s.fair[b] != null && s.fair[b] >= s.be),
  // Pinnacle's coin flip (48-52%) on this side: the who-is-right lead (take the app's side vs Pinnacle's lean)
  'pin-coinflip': s => s.fair.pinnacle != null && Math.abs(s.fair.pinnacle - 0.5) <= 0.02,
};
// pre-registered 10-24 from the leg-picker check (35-48 on 15 games): QB
// passing yards Over on PrizePicks, every leg, standard line
const PREREG = {
  'pp-qb-pass-over': (leg, s) => leg.app === 'prizepicks' && leg.mkey === 'pass_yds' && s.side === 'Over',
  // pre-registered 10-24 for the weekend board (NBA, CFB, NHL), before any
  // result: (a) every leg whose number Pinnacle hangs too, Overs and Unders
  // apart (Pinnacle's Over leans ran 49.2% vs 53.4% on the who-is-right check)
  'pin-same-over': (leg, s) => s.fair.pinnacle != null && s.side === 'Over',
  'pin-same-under': (leg, s) => s.fair.pinnacle != null && s.side === 'Under',
  // (b) Sleeper's NBA combo legs FanDuel or BetRivers price at Sleeper's own
  // number, and the ones where those books' average clears Sleeper's multiplier
  'sl-combo-books': (leg, s) => slCombo(leg, s) != null,
  'sl-combo-books-backed': (leg, s) => { const f = slCombo(leg, s); return f != null && f >= s.be; },
};
const COMBOS = new Set(['pts_rebs', 'pts_asts', 'rebs_asts', 'pra', 'stocks']);
function slCombo(leg, s) {
  if (leg.app !== 'sleeper' || leg.sport !== 'NBA' || !COMBOS.has(leg.mkey)) return null;
  const f = ['fanduel', 'betrivers'].map(b => s.fair[b]).filter(x => x != null);
  return f.length ? f.reduce((a, b) => a + b, 0) / f.length : null;
}

// a better number than Pinnacle's: the app's line sits on this side of
// Pinnacle's main line at bet time (app 245.5 vs Pinnacle 252.5 → Over)
function betterNumber(leg, s) {
  const q = leg.bet.books.pinnacle;
  if (!q || q.exact) return null;
  return s.side === 'Over' ? q.line - s.line : s.line - q.line;
}

// ── grading ──
// result (the player's stat) → 'win' | 'loss' | 'push'
const outcome = (side, line, result) => (result === line ? 'push' : (result > line) === (side === 'Over') ? 'win' : 'loss');

// graded rows [{ app, kind, side, be, out, clv? }] → { n, w, l, p, hit, expW, z, units, roi, clv }
function tally(rows) {
  let w = 0, l = 0, p = 0, expW = 0, varW = 0, units = 0, clvN = 0, clvS = 0, beatClose = 0;
  for (const r of rows) {
    if (r.out === 'push') { p++; continue; }
    if (r.out === 'win') { w++; units += 1 / r.be - 1; } else { l++; units -= 1; }
    expW += r.be; varW += r.be * (1 - r.be);
    if (r.clv != null) { clvN++; clvS += r.clv; if (r.clv > 0) beatClose++; }
  }
  const n = w + l;
  return { n, w, l, p, hit: n ? +(w / n).toFixed(4) : null, be: n ? +(expW / n).toFixed(4) : null, expW: +expW.toFixed(1),
    z: varW ? +((w - expW) / Math.sqrt(varW)).toFixed(2) : null, units: +units.toFixed(2), roi: n ? +(units / n * 100).toFixed(1) : null,
    clvN, clv: clvN ? +(clvS / clvN * 100).toFixed(2) : null, beatClose: clvN ? +(beatClose / clvN).toFixed(3) : null };
}

// legs + graded results (Map leg.key|app → { result } | { void } | { pending }) → the report
// clv: Pinnacle's no-vig chance for the side at the close minus at bet time,
// same number (points of win chance)
// bySport: every group key starts with the leg's sport ("NBA|prizepicks|all")
function summarize(legs, results, { bySport = false } = {}) {
  const rows = [], pending = { legs: 0 }, voided = { legs: 0 };
  const byPlayer = new Map();   // prizepicks pass/rec Overs for the stack slice
  for (const leg of legs) {
    const r = results.get(`${leg.app}|${leg.key}`);
    if (!r || r.pending) { pending.legs++; continue; }
    if (r.void) { voided.legs++; continue; }
    for (const s of sides(leg)) {
      const out = outcome(s.side, s.line, r.result);
      const clv = s.fair.pinnacle != null && s.closeFair.pinnacle != null ? s.closeFair.pinnacle - s.fair.pinnacle : null;
      const base = { app: leg.app, side: s.side, be: s.be, out, clv, mkey: leg.mkey, sport: leg.sport || 'NFL' };
      for (const [kind, rule] of Object.entries(KINDS)) if (rule(s, leg)) rows.push({ ...base, kind });
      for (const [kind, rule] of Object.entries(PREREG)) if (rule(leg, s)) rows.push({ ...base, kind, prereg: true });
      const bn = betterNumber(leg, s);
      if (bn != null && bn > 0) rows.push({ ...base, kind: 'better-number-than-pin' });
      if (leg.app === 'prizepicks' && s.side === 'Over' && (leg.mkey === 'pass_yds' || leg.mkey === 'rec_yds'))
        byPlayer.set(`${leg.mkey}|${leg.key}`, { leg, hit: out === 'win', push: out === 'push' });
    }
  }
  // per app and kind, plus per app, kind and stat for the bigger kinds
  const group = (keyOf) => {
    const g = new Map();
    for (const r of rows) { let k = keyOf(r); if (!k) continue; if (bySport) k = `${r.sport}|${k}`; if (!g.has(k)) g.set(k, []); g.get(k).push(r); }
    return Object.fromEntries([...g].map(([k, v]) => [k, tally(v)]).sort((a, b) => b[1].n - a[1].n));
  };
  const byKind = group(r => `${r.app}|${r.kind}`);
  const byStat = group(r => (['all', 'pin-backed', 'over', 'under'].includes(r.kind) ? `${r.app}|${r.kind}|${r.mkey}` : null));
  const sportsSeen = [...new Set(legs.map(l => l.sport || 'NFL'))];
  const stacks = Object.fromEntries(sportsSeen.map(sp => [sp, qbStack(new Map([...byPlayer].filter(([, x]) => (x.leg.sport || 'NFL') === sp)))]));
  return { byKind, byStat, stack: qbStack(byPlayer), stacks, pending, voided, legs: legs.length,
    breakEvens: breakEvenTable() };
}

// pre-registered 10-24: a QB's passing yards Over with his own receiver's
// receiving yards Over on PrizePicks (41% CFB, 38% NFL joint hit vs 33.3% for
// a 2-pick at 3x). PrizePicks cuts the payout for same-team picks, so the joint
// hit rate is the number to judge here; the payout belongs to the stack thread.
function qbStack(byPlayer) {
  const qbs = [...byPlayer.values()].filter(x => x.leg.mkey === 'pass_yds' && x.leg.team);
  const recs = [...byPlayer.values()].filter(x => x.leg.mkey === 'rec_yds' && x.leg.team);
  let pairs = 0, both = 0, pushes = 0;
  const games = new Set();
  for (const q of qbs) for (const r of recs) {
    if (r.leg.team !== q.leg.team || r.leg.start !== q.leg.start) continue;
    if (q.push || r.push) { pushes++; continue; }
    pairs++; if (q.hit && r.hit) both++;
    games.add(`${q.leg.team}|${q.leg.start}`);
  }
  const bar = 1 / 3;
  return { pairs, both, pushes, games: games.size, hit: pairs ? +(both / pairs).toFixed(4) : null, bar: +bar.toFixed(4),
    z: pairs ? +((both - pairs * bar) / Math.sqrt(pairs * bar * (1 - bar))).toFixed(2) : null, prereg: true };
}

// every app's break-even per entry, for the report's key
function breakEvenTable() {
  return {
    prizepicks: Object.fromEntries(PP_ENTRIES.map(e => [e.name, +e.be.toFixed(4)])),
    pick6: Object.fromEntries((FIXED.pick6?.entries || []).map(e => [e.name, +e.be.toFixed(4)])),
    underdog: { '1x leg (3-pick standard)': UD_IMPLIED, 'other legs': 'UD_IMPLIED / multiplier, or 1 / decimal price' },
    sleeper: { 'every leg': '1 / its multiplier' },
  };
}

// the report as text: what a reader needs first
function reportText(rep, { title = 'NFL Sunday pick\'em board' } = {}) {
  const pct = x => (x == null ? '-' : `${(x * 100).toFixed(1)}%`);
  const row = (k, t) => `${k.padEnd(44)} ${String(t.n).padStart(5)}  ${`${t.w}-${t.l}${t.p ? `-${t.p}` : ''}`.padEnd(11)} ${pct(t.hit).padStart(6)} vs ${pct(t.be).padStart(6)}  z ${String(t.z ?? '-').padStart(5)}  ${String(t.units).padStart(7)}u  clv ${t.clv == null ? '-' : `${t.clv}pt (${t.clvN})`}`;
  const L = [`${title}: ${rep.legs} legs, ${rep.pending.legs} not graded yet, ${rep.voided.legs} void (player not in the box)`, ''];
  L.push('Pre-registered 10-24:');
  const pre = Object.keys(PREREG);
  const isPre = k => pre.includes(k.split('|').pop());
  const preRows = Object.entries(rep.byKind).filter(([k]) => isPre(k));
  if (!preRows.length) L.push('none graded yet');
  for (const [k, t] of preRows) L.push(row(k, t));
  const stacks = rep.stacks && Object.keys(rep.stacks).length ? rep.stacks : { '': rep.stack };
  for (const [sp, st] of Object.entries(stacks)) if (!sp || st.pairs || sp === 'NFL' || sp === 'CFB')
    L.push(`${sp ? `${sp} ` : ''}PP QB pass Over + own receiver Over: ${st.both} of ${st.pairs} pairs (${pct(st.hit)}) on ${st.games} games vs ${pct(st.bar)} for a 2-pick at 3x, z ${st.z ?? '-'} (payout cut for same-team picks not applied)`);
  L.push('', 'Per app and kind (graded at bet time, an hour before the start; units at 1u a leg at the break-even price):');
  for (const [k, t] of Object.entries(rep.byKind)) if (!isPre(k)) L.push(row(k, t));
  L.push('', 'Break-evens:', JSON.stringify(rep.breakEvens));
  return L.join('\n');
}

module.exports = { APPS, BOOKS, BET_LEAD_MS, KINDS, PREREG, COMBOS, appEntries, bookEntries, rungEntries, gameProps, createChangeLog, replay, at, bookAt, breakEven,
  buildLeg, buildLegs, sides, betterNumber, outcome, tally, summarize, qbStack, breakEvenTable, reportText };
