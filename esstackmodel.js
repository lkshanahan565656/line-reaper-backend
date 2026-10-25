// ─── ESPORTS SAME-MATCH STACK MODEL ───────────────────────────────────────────
// How often every leg of a same-match pick'em stack hits together, from a link
// fitted to finished pro series (checks/es-stacks-2026-10-25, scripts in
// that folder, fitted parameters in seeds/es-stack-params.json).
//
// Each leg hits when its latent y = a·M + b·s·D + e clears its threshold:
//   M  the match itself (more rounds, a longer game: everyone's numbers move
//      together), drawn from a two-part scale mixture so a long overtime match
//      or a stomp can drag a whole lineup at once (the tail a plain normal
//      under-calls on six-leg stacks)
//   D  which side dominates (s = +1 for one team, −1 for the other), its own
//      scale mixture
//   e  the player's own noise, so each leg's variance is exactly 1
// Every leg's threshold is solved on that mixture, so each leg alone still
// hits exactly as often as its own price says; only the joint changes. An
// UNDER uses its own fitted loadings with the signs flipped (it hits on the
// low side). Loadings are per game, stat and side; a leg with none (an
// unfitted stat, no team) rides along independent.
//
// Pure: no I/O beyond reading the seed once. Everything is unit-tested.

const fs = require('fs');
const path = require('path');

const SEED = path.join(__dirname, 'seeds', 'es-stack-params.json');

function phiCdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp(-x * x / 2);
  const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}
// midpoint grid over a standard normal
function grid(n) {
  const out = [];
  let tot = 0;
  for (let i = 0; i < n; i++) { const x = -5.5 + 11 * (i + 0.5) / n; const w = Math.exp(-x * x / 2); out.push([x, w]); tot += w; }
  return out.map(([x, w]) => [x, w / tot]);
}
const GRID = grid(28);

// a scale mixture [w, s] → its two parts [[weight, sd], ...] with unit variance
// overall (w = 0 or s = 1 is a plain normal)
function mixture(t) {
  const w = Array.isArray(t) ? Math.max(0, Math.min(0.5, +t[0] || 0)) : 0;
  const s = Array.isArray(t) ? Math.max(1, +t[1] || 1) : 1;
  if (!(w > 0) || s === 1 || w * s * s >= 0.98) return [[1, 1]];
  const s0 = Math.sqrt((1 - w * s * s) / (1 - w));
  return [[1 - w, s0], [w, s]];
}

const sportKey = sport => {
  const s = String(sport || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (s === 'cs' || s === 'cs2' || s === 'csgo' || s === 'counterstrike') return 'cs';
  if (s === 'lol' || s === 'leagueoflegends') return 'lol';
  if (s === 'dota' || s === 'dota2') return 'dota';
  if (s === 'val' || s === 'valorant') return 'val';
  return null;
};
const statKey = stat => {
  const s = String(stat || 'kills').toLowerCase();
  if (/head/.test(s)) return 'headshots';
  if (/assist/.test(s)) return 'assists';
  if (/kill/.test(s)) return 'kills';
  return s;
};

// Hit-count distribution for one match's legs.
// legs: [{ p, a, b, s }] (a, b signed loadings or null; s = ±1 team side)
// tail: { m: [w, s], d: [w, s] }
function hitsDistribution(legs, tail = {}) {
  const n = legs.length;
  const mm = mixture(tail.m), dm = mixture(tail.d);
  const parts = [];
  for (const [wm, sm] of mm) for (const [wd, sd] of dm) parts.push([wm * wd, sm, sd]);
  // thresholds on the mixture marginal (bisection), so each leg hits at p
  const c = legs.map(l => {
    const p = Math.min(1 - 1e-9, Math.max(1e-9, l.p));
    if (l.a == null) return null;
    const e2 = Math.max(1e-9, 1 - l.a * l.a - l.b * l.b);
    const tailP = x => parts.reduce((acc, [w, sm, sd]) => acc + w * (1 - phiCdf(x / Math.sqrt(l.a * l.a * sm * sm + l.b * l.b * sd * sd + e2))), 0);
    let lo = -12, hi = 12;
    for (let i = 0; i < 60; i++) { const mid = (lo + hi) / 2; if (tailP(mid) > p) lo = mid; else hi = mid; }
    return (lo + hi) / 2;
  });
  const sdE = legs.map(l => (l.a == null ? 1 : Math.sqrt(Math.max(1e-9, 1 - l.a * l.a - l.b * l.b))));
  const out = new Array(n + 1).fill(0);
  const dist = new Float64Array(n + 1);
  for (const [w, sm, sd] of parts) {
    for (const [zm, wzm] of GRID) {
      const m = zm * sm;
      for (const [zd, wzd] of GRID) {
        const d = zd * sd;
        dist.fill(0); dist[0] = 1;
        for (let i = 0; i < n; i++) {
          const l = legs[i];
          const q = l.a == null ? l.p : 1 - phiCdf((c[i] - l.a * m - l.b * l.s * d) / sdE[i]);
          for (let h = i + 1; h > 0; h--) dist[h] = dist[h - 1] * q + dist[h] * (1 - q);
          dist[0] *= 1 - q;
        }
        const ww = w * wzm * wzd;
        for (let h = 0; h <= n; h++) out[h] += ww * dist[h];
      }
    }
  }
  const tot = out.reduce((a, b) => a + b, 0) || 1;
  return out.map(x => x / tot);
}

function independent(probs) {
  let dist = [1];
  for (const p of probs) {
    const next = new Array(dist.length + 1).fill(0);
    for (let h = 0; h < dist.length; h++) { next[h] += dist[h] * (1 - p); next[h + 1] += dist[h] * p; }
    dist = next;
  }
  return dist;
}

let seedCache;
function loadParams(file = SEED) {
  if (file === SEED && seedCache !== undefined) return seedCache;
  let p = null;
  try { p = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { p = null; }
  if (file === SEED) seedCache = p;
  return p;
}

// the span bucket a leg's market prices: "Map 1" alone, else Maps 1-2 (a
// Maps 1-3 line rides the 1-2 link; the third map is the slip pricer's
// map-count scenario, not this link)
function spanKey(leg) {
  const m = String(leg.market || leg.rawMarket || leg.span || '');
  if (/maps?\s*1\s*-\s*[23]/i.test(m) || /\b1-[23]\b/.test(m)) return '1-2';
  if (/map\s*[1-5]\b/i.test(m) || /^[1-5]$/.test(m.trim())) return '1';
  return '1-2';
}
// one leg's fitted bucket: { f: [a², b²], tail } or null
function bucket(params, leg) {
  const g = params?.games?.[sportKey(leg.sport)];
  const side = String(leg.side || '').toUpperCase() === 'UNDER' ? 'UNDER' : 'OVER';
  const st = statKey(leg.stat || leg.market);
  const b = g?.buckets?.[`${st}|${spanKey(leg)}`] || g?.buckets?.[`${st}|1-2`];
  return b?.[side] || null;
}
// one leg's signed loadings under PARAMS, or null
function loadings(params, leg) {
  const f = bucket(params, leg)?.f;
  if (!f || !leg.team) return null;
  const sign = String(leg.side || '').toUpperCase() === 'UNDER' ? -1 : 1;
  return { a: sign * Math.sqrt(Math.max(0, f[0])), b: sign * Math.sqrt(Math.max(0, f[1])) };
}

// legs: [{ prob (0-1), team, sport, stat|market, side }] from ONE match
// → { dist, probAll, probAllIndependent, fitted }
function stackDistribution(legs, params = loadParams()) {
  const t0 = legs.find(l => l.team)?.team;
  const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  // one match has one tail: the most common bucket's among the legs
  const tails = new Map();
  for (const l of legs) { const b = bucket(params, l); if (b?.tail) { const k = JSON.stringify(b.tail); tails.set(k, (tails.get(k) || 0) + 1); } }
  const tail = tails.size ? JSON.parse([...tails.entries()].sort((a, b) => b[1] - a[1])[0][0]) : {};
  const mapped = legs.map(l => {
    const ld = loadings(params, l);
    return { p: l.prob, a: ld ? ld.a : null, b: ld ? ld.b : null, s: norm(l.team) === norm(t0) ? 1 : -1 };
  });
  const dist = hitsDistribution(mapped, tail);
  const ind = independent(legs.map(l => l.prob));
  return { dist, probAll: dist[legs.length], probAllIndependent: ind[legs.length], independentDist: ind, fitted: mapped.some(l => l.a != null) };
}

const evOf = (dist, table) => dist.reduce((a, p, h) => a + p * (table?.[h] || 0), 0) - 1;

// The one rule for flagging a stack (pre-registered in
// checks/es-stacks-2026-10-25/PREREGISTERED.md):
//   PrizePicks, Underdog and Sleeper say they cut the payout on correlated
//   lineups and do not publish by how much, so a stack counts only at the
//   REPRICED payout: what the app would pay if it priced the link our model
//   measures (standard × P(all, independent) / P(all, linked)). That is EV
//   with the legs' own edge and nothing from the link; the link only sets
//   the payout the app has to show (breakEvenPays) for it to be a play at all.
//   DK Pick6 posts one payout table for every entry and its entry data shows
//   no cut, so Pick6 stacks are judged at its own table.
const CUTS_PAYOUT = { PP: true, UD: true, SL: true, P6: false };
const MIN_EV = 0;   // % at the payout the rule uses

// stack: { book, payTable (standard, by hit count), picks: [{ prob 0-100 or 0-1, team, sport, market, side }] }
function priceStack(stack, params = loadParams()) {
  const legs = (stack.picks || []).map(l => ({ ...l, prob: l.prob > 1 ? l.prob / 100 : l.prob }));
  const n = legs.length;
  if (n < 2 || !stack.payTable) return null;
  const sd = stackDistribution(legs, params);
  const std = stack.payTable;
  const stdEv = evOf(sd.dist, std);
  // repriced: every row the app pays scaled by indep/linked of the sweep
  const scale = sd.probAll > 0 ? sd.probAllIndependent / sd.probAll : 1;
  const repTable = {};
  for (const [h, v] of Object.entries(std)) repTable[h] = +(v * (Number(h) === n ? scale : 1)).toFixed(4);
  const repEv = evOf(sd.dist, repTable);
  const cuts = CUTS_PAYOUT[stack.book] !== false;
  const ruleEv = cuts ? repEv : stdEv;
  return {
    legs: n, fitted: sd.fitted,
    probAll: +sd.probAll.toFixed(5), probAllIndependent: +sd.probAllIndependent.toFixed(5),
    lift: sd.probAllIndependent > 0 ? +(sd.probAll / sd.probAllIndependent).toFixed(3) : null,
    hits: sd.dist.map(x => +x.toFixed(6)),
    standard: { paysAll: std[n] ?? null, ev: +(stdEv * 100).toFixed(2) },
    repriced: { paysAll: repTable[n] ?? null, ev: +(repEv * 100).toFixed(2), table: repTable },
    // the sweep payout this stack needs, other rows as posted
    breakEvenPays: sd.probAll > 0 ? +((1 - sd.dist.reduce((a, p, h) => a + (h < n ? p * (std[h] || 0) : 0), 0)) / sd.probAll).toFixed(2) : null,
    rule: cuts ? 'repriced' : 'standard',
    ruleEv: +(ruleEv * 100).toFixed(2),
    flag: sd.fitted && ruleEv * 100 >= MIN_EV,
  };
}

module.exports = { hitsDistribution, independent, mixture, stackDistribution, priceStack, loadParams, loadings, bucket, spanKey, sportKey, statKey, evOf, CUTS_PAYOUT, MIN_EV, SEED };

// ── the board → model stacks ─────────────────────────────────────────────────
// For each match, app and side: the legs on that side by their own EV, at
// every size from 2 to 6 with both teams in it (the apps want two), each
// priced on the app's standard table(s), then by the model. The best size by
// the rule's EV is kept per match, app and side; flagged ones are the record.
const BOOK_NAMES = { PP: 'PrizePicks', UD: 'Underdog', SL: 'Sleeper', P6: 'DK Pick6' };
const MAX_LEGS = 6;
const POOL = 8;   // best legs per team the search looks at

// the standard payout table(s) an app offers for these legs: [{ table, tableName, payTable }]
function tablesFor(book, legs, { pick6Table = null } = {}) {
  const { PAYOUTS, PICK6_PAYOUTS } = require('./slip');
  const n = legs.length;
  const prod = legs.reduce((m, l) => m * (l.mult > 0 ? l.mult : 1), 1);
  const out = [];
  if (book === 'PP') {
    if (PAYOUTS.prizepicks_power[n]) out.push({ table: 'prizepicks_power', tableName: 'Power', payTable: { [n]: PAYOUTS.prizepicks_power[n][n] } });
    if (PAYOUTS.prizepicks_flex[n]) out.push({ table: 'prizepicks_flex', tableName: 'Flex', payTable: { ...PAYOUTS.prizepicks_flex[n] } });
  } else if (book === 'UD') {
    if (PAYOUTS.underdog_standard[n]) out.push({ table: 'underdog_standard', tableName: 'Standard', payTable: { [n]: +(PAYOUTS.underdog_standard[n][n] * prod).toFixed(4) } });
    if (PAYOUTS.underdog_flex[n] && Math.abs(prod - 1) < 1e-6) out.push({ table: 'underdog_flex', tableName: 'Flex', payTable: { ...PAYOUTS.underdog_flex[n] } });
  } else if (book === 'SL') {
    if (legs.every(l => l.mult > 1)) out.push({ table: 'sleeper', tableName: 'Picks', payTable: { [n]: +prod.toFixed(4) } });
  } else if (book === 'P6') {
    const t = (pick6Table || PICK6_PAYOUTS)[n];
    if (t) out.push({ table: 'pick6', tableName: 'Picks', payTable: { ...t, [n]: +(t[n] * prod).toFixed(4) } });
  }
  return out;
}

const r1 = x => Math.round(x * 10) / 10;
const nrm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// legs: one book's legs (slipbuild.bookLeg shape, prob 0-1) → model stacks for that book
function stacksForBook(legs, book, { params = loadParams(), pick6Table = null } = {}) {
  const games = new Map();
  for (const l of legs) {
    if (!l.gameId || !l.team || !sportKey(l.sport)) continue;
    if (!games.has(l.gameId)) games.set(l.gameId, []);
    games.get(l.gameId).push(l);
  }
  const out = [];
  for (const g of games.values()) {
    for (const side of ['OVER', 'UNDER']) {
      const pool = g.filter(l => l.side === side && Number.isFinite(l.prob));
      const teams = [...new Set(pool.map(l => nrm(l.team)))];
      if (teams.length !== 2) continue;
      // one leg per player, best EV first, interleaving the two teams
      const per = teams.map(t => {
        const seen = new Set();
        return pool.filter(l => nrm(l.team) === t).sort((a, b) => b.ev - a.ev).filter(l => { const k = nrm(l.player); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, POOL);
      });
      let best = null;
      for (let n = 2; n <= MAX_LEGS; n++) {
        for (let x = 1; x < n; x++) {
          const y = n - x;
          if (per[0].length < x || per[1].length < y) continue;
          const picks = [...per[0].slice(0, x), ...per[1].slice(0, y)];
          for (const t of tablesFor(book, picks, { pick6Table })) {
            const pr = priceStack({ book, payTable: t.payTable, picks }, params);
            if (!pr || !pr.fitted) continue;
            if (!best || pr.ruleEv > best.priced.ruleEv) best = { picks, t, priced: pr };
          }
        }
      }
      if (best) out.push(present(book, best));
    }
  }
  return out.sort((a, b) => b.ruleEv - a.ruleEv);
}

function present(book, { picks, t, priced }) {
  const cuts = CUTS_PAYOUT[book] !== false;
  return {
    kind: 'es-stacks', label: 'model, not an edge', book, bookName: BOOK_NAMES[book], table: t.table, tableName: t.tableName, legs: picks.length,
    matchTitle: [...new Set(picks.map(l => l.team).filter(Boolean))].join(' vs '),
    side: picks[0].side, sport: picks[0].sport,
    status: priced.flag ? 'plus' : 'near', flag: priced.flag, rule: priced.rule,
    ruleEv: priced.ruleEv, ev: priced.ruleEv, evStandard: priced.standard.ev, evRepriced: priced.repriced.ev,
    probAll: priced.probAll, probAllIndependent: priced.probAllIndependent, lift: priced.lift, hits: priced.hits,
    paysAll: priced.standard.paysAll, repricedPays: priced.repriced.paysAll, breakEvenPays: priced.breakEvenPays,
    // graded at the payout the rule used; the standard table kept beside it
    payTable: cuts ? priced.repriced.table : t.payTable, standardPayTable: t.payTable,
    picks: picks.map(l => ({ player: l.player, team: l.team, sport: l.sport, market: l.market, rawMarket: l.rawMarket, side: l.side, line: l.line,
      gameId: l.gameId, matchTitle: l.matchTitle, prob: r1(l.prob * 100), ev: l.ev, mult: l.mult, startTime: l.startTime, fair: l.fair, flipped: l.flipped || undefined })),
  };
}

// the esports board (server picks) → { stacks (flagged first), flagged, byBook }
function boardStacks(picks, { now = Date.now(), pick6 = null, pick6Table = null, params = loadParams() } = {}) {
  if (!params) return { on: false, stacks: [], flagged: [], byBook: {} };
  const { bookLeg, otherSide } = require('./slipbuild');
  const live = (picks || []).filter(p => { const t = Date.parse(p.startTime); return p.pricing && p.side && !(Number.isFinite(t) && t <= now); });
  const byBook = {};
  for (const book of pick6?.size ? ['PP', 'UD', 'SL', 'P6'] : ['PP', 'UD', 'SL']) {
    const legs = [];
    for (const p of live) {
      const l = bookLeg(p, book, { pick6 });
      if (!l) continue;
      legs.push(l);
      if (book === 'PP') { const o = otherSide(l); if (o) legs.push(o); }
    }
    byBook[book] = stacksForBook(legs, book, { params, pick6Table });
  }
  const stacks = Object.values(byBook).flat().sort((a, b) => (b.flag - a.flag) || (b.ruleEv - a.ruleEv));
  return { on: true, stacks, flagged: stacks.filter(s => s.flag), byBook };
}

module.exports.tablesFor = tablesFor;
module.exports.stacksForBook = stacksForBook;
module.exports.boardStacks = boardStacks;
module.exports.BOOK_NAMES = BOOK_NAMES;
