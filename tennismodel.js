// ─── TENNIS MATCH-WINNER MODEL (tennismodel.js) ──────────────────────────────
// Our own transparent ATP/WTA model, built only from finished matches on
// ESPN's tennis scoreboards (2016 on). Every number can be explained:
//
//   1. Two Elo ratings per player: overall, and one per surface (hard, clay,
//      grass). K shrinks as a player plays more: K = kc / (n + off)^shape.
//   2. The match logit is scale x (w x overall gap + (1 - w) x surface gap),
//      in Elo points, stretched by bo5 for best-of-five.
//   3. Form: each player's shrunk mean of (won - expected) over the last 60
//      days, times formW, added to the logit.
//   4. Layoff: a player back from 60+ idle days pulls the logit toward 50%
//      by `layoff` (we don't know why he was away).
//   5. A player with fewer than minMatches rated matches gets no price.
//
// Parameters were fitted by walk-forward log loss on 2019-2023 only
// (scripts/tennis-backtest.js), then frozen; 2025 and 2026 are the held-out
// test against Kalshi and Polymarket. Pure module: no I/O.

const DEFAULTS = {
  // frozen 2026-10-25 from scripts/tennis-fit.js (2019-2023 log loss 0.6221,
  // 2024 check 0.6295); the starting values were Elo's usual 250 / 5 / 0.4
  r0: 1500, kc: 200, off: 5, shape: 0.4, w: 0.75, scale: 0.9, bo5: 1.4,
  formDays: 60, formShrink: 3, formW: 0.5, layoffDays: 60, layoff: 1, minMatches: 10,
};

const Q = Math.LN10 / 400;
const sigmoid = x => 1 / (1 + Math.exp(-x));
const clampP = p => Math.min(1 - 1e-6, Math.max(1e-6, p));
const logit = p => Math.log(clampP(p) / (1 - clampP(p)));
const r4 = x => (x == null || !Number.isFinite(x) ? null : Math.round(x * 1e4) / 1e4);

// ── surface from the event name and date (ESPN gives no surface) ──
// The rule is fixed in checks/tennis-model-2026-10-25/PREREGISTERED.md.
const GRASS_RE = /wimbledon|queen'?s|hsbc championships|cinch|halle|terra wortmann|hertogenbosch|libema|mallorca|eastbourne|birmingham|nottingham|berlin|bad homburg|ilkley|surbiton|hall of fame|boss open|rothesay|lexus/i;
const CLAY_RE = /roland|french open|madrid|mutua|internazionali|\brome\b|italian open|monte[- ]?carlo|barcelona|godo|estoril|munich|bmw open|marrakech|hassan|houston|clay court|charleston|bogota|colsanitas|cordoba|c[oó]rdoba|argentina open|buenos aires|rio open|\brio\b|chile open|santiago|bastad|b[aå]stad|nordea|gstaad|swiss open|hamburg|umag|croatia open|plava laguna|kitzb|generali open|palermo|budapest|hungar|lausanne|iasi|warsaw|poland open|bucharest|tiriac|parma|rabat|strasbourg|geneva|gonet|\blyon\b|grado|montevideo|istanbul/i;
function surfaceOf(name, t) {
  const n = String(name || '');
  if (GRASS_RE.test(n)) return 'grass';
  const d = new Date(t);
  const md = (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
  if (CLAY_RE.test(n) || (/prague/i.test(n) && md >= 401 && md <= 531)) return 'clay';
  if (md >= 401 && md <= 610) return 'clay';
  if (md >= 611 && md <= 713) return 'grass';
  return 'hard';
}

// ── ratings ──
function createRatings(opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const P = new Map();   // id → { id, name, r, n, s: {surf: [r, n]}, last, form: [[t, resid]], hist: [] }
  let lastT = 0, count = 0;
  const player = (id, name) => {
    let p = P.get(id);
    if (!p) { p = { id, name: name || id, r: o.r0, n: 0, s: {}, last: null, form: [], hist: [] }; P.set(id, p); }
    if (name) p.name = name;
    return p;
  };
  const surf = (p, s) => p.s[s] || (p.s[s] = [o.r0, 0]);
  const K = n => o.kc / Math.pow(n + o.off, o.shape);
  function formOf(p, t) {
    const cut = t - o.formDays * 86400e3;
    let sum = 0, k = 0;
    for (let i = p.form.length - 1; i >= 0; i--) { const [ft, res] = p.form[i]; if (ft < cut) break; if (ft < t) { sum += res; k++; } }
    return { value: sum / (k + o.formShrink), matches: k };
  }
  // P(a beats b) on surface s at time t; null players read as unrated
  function parts(a, b, s, t, bestOf = 3) {
    const sa = surf(a, s), sb = surf(b, s);
    const dOverall = a.r - b.r, dSurf = sa[0] - sb[0];
    const elo = o.w * dOverall + (1 - o.w) * dSurf;
    let x = o.scale * Q * elo;
    const fa = formOf(a, t), fb = formOf(b, t);
    const formTerm = o.formW * (fa.value - fb.value);
    x += formTerm;
    const idleA = a.last != null ? (t - a.last) / 86400e3 : null, idleB = b.last != null ? (t - b.last) / 86400e3 : null;
    const laid = (idleA != null && idleA > o.layoffDays) || (idleB != null && idleB > o.layoffDays);
    if (laid) x *= o.layoff;
    if (bestOf === 5) x *= o.bo5;
    return { p: sigmoid(x), elo, dOverall, dSurf, formA: fa, formB: fb, formTerm, laid, idleA, idleB };
  }
  // one finished match, in time order: { t, a, b, an, bn, w (1 if a won), surf, bo, ev }
  function add(m) {
    const a = player(m.a, m.an), b = player(m.b, m.bn);
    const s = m.surf || 'hard';
    const pr = parts(a, b, s, m.t, m.bo);
    const eo = sigmoid(Q * (a.r - b.r));   // plain Elo expectation for the update
    const sa = surf(a, s), sb = surf(b, s);
    const es = sigmoid(Q * (sa[0] - sb[0]));
    const y = m.w ? 1 : 0;
    const ka = K(a.n), kb = K(b.n), ksa = K(sa[1]), ksb = K(sb[1]);
    const before = [a.r, b.r];
    a.r += ka * (y - eo); b.r -= kb * (y - eo);
    sa[0] += ksa * (y - es); sb[0] -= ksb * (y - es);
    a.n++; b.n++; sa[1]++; sb[1]++;
    a.form.push([m.t, y - pr.p]); b.form.push([m.t, (1 - y) - (1 - pr.p)]);
    if (a.form.length > 60) a.form.shift();
    if (b.form.length > 60) b.form.shift();
    a.last = m.t; b.last = m.t;
    const hrow = (me, opp, won, chg) => ({ t: m.t, opp: opp.name, won, ev: m.ev || null, surf: s, change: Math.round(chg) });
    a.hist.push(hrow(a, b, !!y, a.r - before[0])); b.hist.push(hrow(b, a, !y, b.r - before[1]));
    if (a.hist.length > 12) a.hist.shift();
    if (b.hist.length > 12) b.hist.shift();
    lastT = Math.max(lastT, m.t); count++;
    return pr.p;
  }
  // a prediction for two players (ids), with the reasons
  function predict(aId, bId, { surf: s = 'hard', t = Date.now(), bestOf = 3 } = {}) {
    const a = P.get(aId), b = P.get(bId);
    const known = [a, b].map(x => (x ? x.n : 0));
    if (!a || !b || known[0] < o.minMatches || known[1] < o.minMatches) return { priced: false, reason: 'insufficient', matches: known };
    const pr = parts(a, b, s, t, bestOf);
    return { priced: true, p: r4(pr.p), surf: s, bestOf, matches: known, elo: Math.round(pr.elo), dOverall: Math.round(pr.dOverall), dSurf: Math.round(pr.dSurf),
      form: [r4(pr.formA.value), r4(pr.formB.value)], formTerm: r4(pr.formTerm), laid: pr.laid, idle: [pr.idleA, pr.idleB].map(x => (x == null ? null : Math.round(x))) };
  }
  function view(id) {
    const p = P.get(id);
    if (!p) return null;
    const s = Object.fromEntries(Object.entries(p.s).map(([k, [r, n]]) => [k, { rating: Math.round(r), matches: n }]));
    const recent = p.hist.slice().reverse();
    const w = recent.slice(0, 10).filter(h => h.won).length;
    return { id: p.id, name: p.name, rating: Math.round(p.r), matches: p.n, surfaces: s, last: p.last ? new Date(p.last).toISOString() : null,
      last10: `${w}-${Math.min(10, recent.length) - w}`, recent: recent.slice(0, 6).map(h => ({ ...h, t: new Date(h.t).toISOString() })) };
  }
  function table({ min = 20, surf: s = null, limit = 300 } = {}) {
    return [...P.values()].filter(p => p.n >= min)
      .map(p => ({ id: p.id, name: p.name, rating: Math.round(s ? (p.s[s]?.[0] ?? o.r0) : p.r), matches: p.n, last: p.last ? new Date(p.last).toISOString().slice(0, 10) : null }))
      .sort((x, y) => y.rating - x.rating).slice(0, limit);
  }
  return { add, predict, parts, view, table, player: id => P.get(id) || null, size: () => P.size, count: () => count, last: () => lastT, opts: o };
}

// matches (any order) → ratings with everything added in time order
function buildRatings(matches, opts = {}) {
  const R = createRatings(opts);
  for (const m of [...matches].sort((x, y) => x.t - y.t)) R.add(m);
  return R;
}

// ── names ──
// "Carlos Alcaraz", "C. Alcaraz", "Alcaraz C" → comparable pieces
const fold = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z\s'-]/g, ' ').replace(/['-]/g, ' ').replace(/\s+/g, ' ').trim();
function nameKey(n) {
  const w = fold(n).split(' ').filter(Boolean);
  return { all: w, last: w[w.length - 1] || '', first: w[0] || '' };
}
// how well a venue's player name fits a rated name: 0 (no) to 1 (exact)
function nameScore(venue, rated) {
  const a = nameKey(venue), b = nameKey(rated);
  if (!a.last || !b.last) return 0;
  if (a.all.join(' ') === b.all.join(' ')) return 1;
  const setB = new Set(b.all);
  const shared = a.all.filter(x => x.length > 1 && setB.has(x));
  if (!shared.length) return 0;
  const lastHit = setB.has(a.last) || a.all.includes(b.last);
  if (!lastHit) return 0;
  // an initial that agrees ("C Alcaraz") or a full first name that agrees
  const initA = a.all.filter(x => !shared.includes(x)).map(x => x[0]), initB = b.all.filter(x => !shared.includes(x)).map(x => x[0]);
  if (!initA.length || !initB.length) return 0.8;
  return initA.some(i => initB.includes(i)) ? 0.9 : 0.3;
}

// ── scoring helpers (shared with the backtest) ──
const llOf = (p, y) => -(y ? Math.log(clampP(p)) : Math.log(1 - clampP(p)));
function explain(pred, names = ['A', 'B']) {
  if (!pred?.priced) return [`No model price: ${names[0]} has ${pred?.matches?.[0] ?? 0} rated matches, ${names[1]} ${pred?.matches?.[1] ?? 0} (we need ${DEFAULTS.minMatches} each).`];
  const out = [];
  out.push(`Rating gap ${pred.dOverall >= 0 ? '+' : ''}${pred.dOverall} overall and ${pred.dSurf >= 0 ? '+' : ''}${pred.dSurf} on ${pred.surf}, blended to ${pred.elo >= 0 ? '+' : ''}${pred.elo} for ${names[0]}.`);
  if (pred.formTerm) out.push(`Form over the last 60 days moves the logit by ${pred.formTerm >= 0 ? '+' : ''}${pred.formTerm}.`);
  if (pred.laid) out.push(DEFAULTS.layoff < 1 ? `A player is back from ${Math.max(...pred.idle.filter(x => x != null))} idle days, so the price is pulled toward 50%.` : `A player is back from ${Math.max(...pred.idle.filter(x => x != null))} idle days; the 2019-2023 fit gave a layoff no weight, so the price ignores it.`);
  if (pred.bestOf === 5) out.push('Best of five: the better player\'s edge is stretched.');
  return out;
}

module.exports = { DEFAULTS, GRASS_RE, CLAY_RE, surfaceOf, createRatings, buildRatings, nameKey, nameScore, fold, llOf, explain, logit, sigmoid };
