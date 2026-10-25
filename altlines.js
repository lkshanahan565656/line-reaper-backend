// ─── ALTERNATE LINES AND LADDERS, PRICED OFF PINNACLE AND KALSHI ────────────
// The +EV screen (ev.js) scores FanDuel and BetRivers only where a sharp
// source posts the very same line. The books also hang one-way ladders and
// alternates nobody sharp posts at those numbers:
//
//   player ladders   FanDuel "Parker Washington 50+ Yards", "2+ Shots on
//                    Goal", anytime TD scorer; BetRivers "25+ Receiving Yards
//                    By The Player", "Touchdown Scorer"
//   alt game lines   FanDuel's alternate spreads and totals (one runner a
//                    line), BetRivers' two-way alternates
//
// Soft books price the tails worst, so this is where OddsJam-style +EV sits.
// Each rung is priced from up to three sources, each read at the rung's own
// line:
//
//   pinnacle   props: its line and no-vig over read as a mean on the stat's
//              curve (sportprops.pOver, fitted on Kalshi ladders) and read
//              back at the rung. Game lines: its own spread or total when it
//              posts that number (exact), else its ladder of alternates
//              interpolated in z (probit) space, or stretched past its last
//              line at its own ladder's slope (modelled)
//   kalshi     its contract at that exact line: a player rung ("50+" is 49.5)
//              or a game spread or total, at the bid/ask mid
//   the other  FanDuel's two-way line for a BetRivers rung and the other way
//   free book  round, read on the same curve (weight 1)
//
// A rung CLEARS when at least one source prices that exact line (Kalshi's
// rung, or Pinnacle's own number), it beats that exact price by minEv, and two
// or more sources sit within agreePts (and agreeRel of the chance) of each
// other at that line. Rungs
// resting on the curve alone are shown, marked model-only, and never count:
// two medians agreeing on the same curve doesn't check the curve's tail.
// Rows grade like the +EV record (closing fair, the price two minutes on) in a
// tracker of their own, so the main-line record and its proof stay clean.
// Pure functions; the server passes freebooks' merged games in.

const { canonName, americanToDecimal, probToAmerican, devig } = require('./ev');
const { pOver, meanFor } = require('./sportprops');
const { normalCdf } = require('./dist');

const DEFAULTS = {
  minEv: 2,          // percent past the fair, as on the +EV tab
  agreePts: 5,       // the sources' spread at the rung, points of win chance
  agreeRel: 0.25,    // and at most this share of the smaller chance
  maxEv: 30,         // past this a rung is a bad match, not an edge
  minP: 0.04, maxP: 0.96,   // tails this far out are the curve's guess
  weights: { pinnacle: 3, kalshi: 2, fanduel: 1, betrivers: 1 },
  kalshiMaxSpread: 0.06,
  matchMs: 6 * 3600e3,      // a Kalshi rung settles within this of the game's start
};
// a sport's margin and total spread (points), for a ladder too short to fit
const SD = { nfl: [13.5, 13.5], ncaaf: [16, 16.5], nba: [12.5, 18], wnba: [10, 15], nhl: [2.4, 2.3], mlb: [4.4, 4.3] };
const FREE = ['fanduel', 'betrivers'];
const SHARP = new Set(['pinnacle', 'kalshi']);

const r2 = x => Math.round(x * 100) / 100;
const half = x => Number.isFinite(x) && Math.abs(Math.abs(x % 1) - 0.5) < 1e-9;
// inverse normal (Acklam), for interpolating a ladder in z
function probit(p) {
  if (!(p > 0 && p < 1)) return null;
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155211881];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const q = p < 0.02425 ? Math.sqrt(-2 * Math.log(p)) : p > 1 - 0.02425 ? Math.sqrt(-2 * Math.log(1 - p)) : null;
  if (q == null) {
    const x = p - 0.5, r = x * x;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * x / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  const z = (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  return p < 0.5 ? z : -z;
}
const zToP = z => normalCdf(z, 0, 1);

// A ladder of (x, p) points, p rising with x (half lines only) → the chance
// at any x: { p, exact } or null. Between two points: straight in z. Past
// the ends: the sport's 1 / sd, up to maxSd × sd past the last point.
function ladderAt(points, x, sd, maxSd = 0.75) {
  const pts = points.filter(q => half(q.x) && q.p > 0 && q.p < 1).sort((a, b) => a.x - b.x);
  if (!pts.length) return null;
  const hit = pts.find(q => Math.abs(q.x - x) < 1e-9);
  if (hit) return { p: hit.p, exact: true };
  const zs = pts.map(q => ({ x: q.x, z: probit(q.p) }));
  const hi = zs.findIndex(q => q.x > x);
  if (hi > 0) {
    const a = zs[hi - 1], b = zs[hi];
    return { p: zToP(a.z + (b.z - a.z) * (x - a.x) / (b.x - a.x)), exact: false };
  }
  // A short ladder's own slope is the key numbers' (a CFB 2.5-to-3.5 step
  // stretched seven points priced a +5.5 dog at 83% for a 70% bet), so the
  // ends stretch at the sport's average slope, and not past maxSd of it.
  const end = hi === 0 ? zs[0] : zs[zs.length - 1];
  if (Math.abs(x - end.x) > maxSd * sd) return null;
  return { p: zToP(end.z + (x - end.x) / sd), exact: false };
}

// a bookmaker's two-way game market → ladder points. spreads: x = the home
// side's points, p = P(home covers); totals: x = −line, p = P(over), so both
// rise with x.
function gamePoints(bm, key, home) {
  const m = (bm?.markets || []).find(x => x.key === key);
  if (!m) return [];
  const by = new Map();
  for (const o of m.outcomes || []) {
    if (o.point == null) continue;
    const x = key === 'totals' ? -o.point : (o.name === home ? o.point : -o.point);
    const side = key === 'totals' ? (o.name === 'Over' ? 0 : 1) : (o.name === home ? 0 : 1);
    if (!by.has(x)) by.set(x, []);
    by.get(x)[side] = americanToDecimal(o.price);
  }
  const out = [];
  for (const [x, [d0, d1]] of by) {
    if (!d0 || !d1) continue;
    const f = devig([d0, d1]);
    if (f) out.push({ x, p: f[0] });
  }
  return out;
}

// a bookmaker's two-way player props → Map(`${canonName(player)}|${mkey}` → { line, p })
// (the line closest to even when a book posts more than one)
function propLines(bm) {
  const out = new Map();
  for (const m of bm?.markets || []) {
    if (/^(h2h|spreads|totals)$/.test(m.key)) continue;
    const by = new Map();
    for (const o of m.outcomes || []) {
      if (!o.description || o.point == null) continue;
      const k = `${canonName(o.description)}|${m.key}|${o.point}`;
      if (!by.has(k)) by.set(k, { key: `${canonName(o.description)}|${m.key}`, line: o.point });
      by.get(k)[o.name] = americanToDecimal(o.price);
    }
    for (const x of by.values()) {
      if (!x.Over || !x.Under) continue;
      const f = devig([x.Over, x.Under]);
      if (!f) continue;
      const old = out.get(x.key);
      if (!old || Math.abs(f[0] - 0.5) < Math.abs(old.p - 0.5)) out.set(x.key, { line: x.line, p: f[0] });
    }
  }
  return out;
}

// Kalshi player rungs (bigmoney.rungIndex) → Map(`${league}|${canonName}|${mkey}|${line}` → [{ p, start }])
function kalshiRungIndex(rungs, o = DEFAULTS) {
  const out = new Map();
  for (const r of (rungs instanceof Map ? rungs.values() : rungs || [])) {
    if (!(r.yesBid > 0 && r.yesAsk < 1 && r.yesAsk > r.yesBid) || r.yesAsk - r.yesBid > o.kalshiMaxSpread) continue;
    const k = `${r.league}|${canonName(r.player)}|${r.mkey}|${r.line}`;
    if (!out.has(k)) out.set(k, []);
    out.get(k).push({ p: (r.yesBid + r.yesAsk) / 2, start: Date.parse(r.start || '') });
  }
  return out;
}

// the sources at one rung → { fair, sources, agree, spreadPts, exact }.
// A source at the rung's own line is a price; a curve read is a guess. With
// one or more exact sources the fair is theirs alone and the curve reads only
// have to agree with it: on the first live run (2026-10-14) Kalshi sat under
// the curve on almost every tail rung (6.5% vs 9.7% on a 2+ assists), so a
// blend priced most "clearing" rungs off the curve's error.
// Agreement scales with the chance: within agreePts, and within agreeRel of
// the smaller one (5 points apart on a 9% rung is a different price).
function blend(sources, o) {
  const s = sources.filter(x => x.p > 0 && x.p < 1);
  if (!s.length) return null;
  const mean = list => list.reduce((a, x) => a + (o.weights[x.book] ?? 1) * x.p, 0) / list.reduce((a, x) => a + (o.weights[x.book] ?? 1), 0);
  const ex = s.filter(x => x.exact);
  const fair = mean(ex.length ? ex : s);
  const ps = s.map(x => x.p);
  const lo = Math.min(...ps), hi = Math.max(...ps);
  const spreadPts = s.length > 1 ? r2((hi - lo) * 100) : null;
  const agree = s.length > 1 && spreadPts <= o.agreePts && hi - lo <= o.agreeRel * lo;
  // only Pinnacle's or Kalshi's own price at the rung can clear it: another
  // sportsbook's number is a soft price (10-18: FanDuel rungs cleared on
  // BetRivers' line alone, Jonathan Taylor 19.5 rec yds +2.8% vs BetRivers,
  // -7.5% vs Pinnacle's curve)
  return { fair, sources: s, agree, spreadPts, exact: ex.length > 0, sharpExact: ex.some(x => SHARP.has(x.book)) };
}

// one rung's row, or null when it's off the board's range
function rowFor(base, f, price, o, fairs, costs) {
  const d = americanToDecimal(price);
  if (!d || !f) return null;
  if (fairs) fairs.set(`${base.group}|${base.side}`, r2(f.fair * 100));
  if (costs) costs.set(`${base.group}|${base.side}|${base.book}`, Math.round(1e4 / d) / 1e4);
  if (f.fair < o.minP || f.fair > o.maxP) return null;
  const ev = (f.fair * d - 1) * 100;
  if (ev < o.minEv || ev > o.maxEv) return null;
  const clears = f.agree && f.sharpExact;
  return {
    ...base, price, decimal: Math.round(d * 1000) / 1000, fairProb: r2(f.fair * 100), fairPrice: probToAmerican(f.fair), ev: r2(ev),
    kelly: r2(Math.max(0, (f.fair * d - 1) / (d - 1)) * 25),
    source: clears ? 'alt' : 'alt-model', alt: true, clears, model: !f.exact, agree: f.agree, spreadPts: f.spreadPts,
    sharpBooks: [...new Set(f.sources.map(x => x.feed))],
    sources: f.sources.map(x => ({ book: x.book, p: r2(x.p * 100), ...(x.line != null ? { line: x.line } : {}), exact: !!x.exact })),
  };
}

// freebooks' merged games by sport → alt rows, best first. kalshiGame:
// Map(game id → 'kalshi_mid' bookmaker at Kalshi's own lines,
// pingames.kalshiMidBooks); kalshiRungs: bigmoney.rungIndex; leagueOf: board
// sport → Kalshi / pinprops league ('nfl' → 'NFL'). fairs and costs (Maps)
// are filled for every rung priced, as ev.screen does, for the tracker.
// (screenSteps: the same screen as a generator that stops every few games, so
// the server can run it a slice at a time; screen runs it in one go)
/** @param {any} [opts] */
function screen(opts) {
  const it = screenSteps(opts);
  for (;;) { const r = it.next(); if (r.done) return r.value; }
}
/** @param {any} [args] */
function* screenSteps({ gamesBySport = {}, kalshiGame = new Map(), kalshiRungs = null, leagueOf = s => s.toUpperCase(), now = Date.now(), fairs = null, costs = null, o: opts = {} } = {}) {
  let steps = 0;
  const o = { ...DEFAULTS, ...opts, weights: { ...DEFAULTS.weights, ...(opts.weights || {}) } };
  const kr = kalshiRungIndex(kalshiRungs, o);
  const rows = [];
  for (const [sport, games] of Object.entries(gamesBySport || {})) {
    const sd = SD[sport] || [12, 12];
    const league = leagueOf(sport);
    for (const g of games || []) {
      if (++steps % 4 === 0) yield;
      const t = Date.parse(g.commence_time || '');
      if (!(t > now)) continue;
      const pin = (g.bookmakers || []).find(b => b.key === 'pinnacle');
      if (!pin) continue;
      const day = String(g.commence_time).slice(0, 10);
      const eventId = `${canonName(g.away_team)}@${canonName(g.home_team)}|${day}`;
      const base0 = { sport, event: `${g.away_team} @ ${g.home_team}`, start: g.commence_time };
      const km = kalshiGame.get(g.id);
      const curve = {}, kpts = {};
      for (const key of ['spreads', 'totals']) {
        curve[key] = gamePoints(pin, key, g.home_team);
        kpts[key] = new Map(gamePoints(km, key, g.home_team).map(q => [q.x, q.p]));
      }
      const pinProps = propLines(pin);
      const bookProps = Object.fromEntries(FREE.map(b => [b, propLines((g.bookmakers || []).find(x => x.key === b))]));

      for (const bm of g.bookmakers || []) {
        if (!FREE.includes(bm.key)) continue;
        // ── game lines: FanDuel's one-way alternates, BetRivers' two-way ones
        // off Pinnacle's numbers (at Pinnacle's numbers ev.screen has them)
        const rungs = [...(bm.altLines || [])];
        if (!rungs.length) for (const key of ['spreads', 'totals']) {
          const m = (bm.markets || []).find(x => x.key === key);
          const has = new Set(curve[key].map(q => q.x));
          for (const x of m?.outcomes || []) {
            const xx = key === 'totals' ? -x.point : (x.name === g.home_team ? x.point : -x.point);
            if (!has.has(xx)) rungs.push({ kind: key, name: x.name, point: x.point, price: x.price });
          }
        }
        // a line this book posts two-way where Pinnacle posts it too is ev.screen's
        const mainAt = new Set(['spreads', 'totals'].flatMap(key => {
          const pinX = new Set(curve[key].map(q => q.x));
          return gamePoints(bm, key, g.home_team).filter(q => pinX.has(q.x)).map(q => `${key}|${q.x}`);
        }));
        const seen = new Set();
        for (const r of rungs) {
          if (!half(r.point)) continue;
          const key = r.kind;
          const isHome = r.name === g.home_team;
          // x on the ladder, and whether this side is the ladder's p or 1 − p
          const x = key === 'totals' ? -r.point : (isHome ? r.point : -r.point);
          const up = key === 'totals' ? r.name === 'Over' : isHome;
          if (mainAt.has(`${key}|${x}`)) continue;
          const group = key === 'totals' ? `alt|${eventId}|totals|${r.point}` : `alt|${eventId}|spreads|${isHome ? r.point : -r.point}`;
          const side = key === 'totals' ? r.name : `${r.name} ${r.point > 0 ? '+' : ''}${r.point}`;
          if (seen.has(`${group}|${side}`)) continue;
          seen.add(`${group}|${side}`);
          const sources = [];
          const pl = ladderAt(curve[key], x, sd[key === 'totals' ? 1 : 0]);
          if (pl) sources.push({ book: 'pinnacle', feed: 'pinnacle', p: up ? pl.p : 1 - pl.p, exact: pl.exact });
          const kp = kpts[key].get(x);
          if (kp != null) sources.push({ book: 'kalshi', feed: 'kalshi_mid', p: up ? kp : 1 - kp, exact: true });
          const row = rowFor({ ...base0, group, market: key, player: null, point: r.point, side, book: bm.key }, blend(sources, o), r.price, o, fairs, costs);
          if (row) rows.push(row);
        }

        // ── player ladders: an "N+" rung is the over at N − 0.5
        for (const r of bm.ladders || []) {
          const pk = `${canonName(r.player)}|${r.mkey}`;
          const sources = [];
          const read = (book, q, w) => {
            if (!q) return;
            if (q.line === r.line) { sources.push({ book, feed: book, p: q.p, line: q.line, exact: true }); return; }
            const mean = meanFor(r.mkey, league, q.line, q.p);
            if (mean != null) sources.push({ book, feed: book, p: pOver(r.mkey, league, mean, r.line), line: q.line, exact: false });
          };
          read('pinnacle', pinProps.get(pk));
          for (const other of FREE) if (other !== bm.key) read(other, bookProps[other].get(pk));
          const ks = (kr.get(`${league}|${pk}|${r.line}`) || []).filter(k => !Number.isFinite(k.start) || Math.abs(k.start - t) <= o.matchMs);
          if (ks.length) sources.push({ book: 'kalshi', feed: 'kalshi_props', p: ks[0].p, line: r.line, exact: true });
          // a soft book's line alone isn't a price: Pinnacle or Kalshi must be in it
          if (!sources.some(s => s.book === 'pinnacle' || s.book === 'kalshi')) continue;
          // the same book's own two-way line at a sharp line is ev.screen's
          const own = bookProps[bm.key].get(pk);
          if (own && own.line === r.line && pinProps.get(pk)?.line === r.line) continue;
          const group = `alt|${eventId}|${r.mkey}|${canonName(r.player)}|${r.line}`;
          const row = rowFor({ ...base0, group, market: r.mkey, player: r.player, point: r.line, side: 'Over', book: bm.key }, blend(sources, o), r.price, o, fairs, costs);
          if (row) rows.push(row);
        }
      }
    }
  }
  return rows.sort((a, b) => (b.clears - a.clears) || b.ev - a.ev);
}

// counts for the status page and the reply: rungs read, priced, shown, clearing
function summarize(gamesBySport = {}, rows = [], fairs = null) {
  let ladders = 0, altLines = 0;
  for (const games of Object.values(gamesBySport || {})) for (const g of games || []) for (const bm of g.bookmakers || []) {
    ladders += (bm.ladders || []).length; altLines += (bm.altLines || []).length;
  }
  const priced = fairs ? [...fairs.keys()].filter(k => k.startsWith('alt|')).length : null;
  const by = k => rows.reduce((m, r) => ((m[r[k]] = (m[r[k]] || 0) + 1), m), {});
  return { ladders, altLines, priced, shown: rows.length, clear: rows.filter(r => r.clears).length, byBook: by('book'), bySport: by('sport'), byMarket: by('market') };
}

module.exports = { DEFAULTS, SD, probit, ladderAt, gamePoints, propLines, kalshiRungIndex, blend, screen, screenSteps, summarize };
