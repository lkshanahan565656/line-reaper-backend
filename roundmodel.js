// ─── ROUND MODEL: PINNACLE'S ROUNDS × EACH PLAYER'S KILLS A ROUND ────────────
// CS2 and Valorant kill lines, where Pinnacle prices no kills but does price
// every map's rounds: a round total, a round handicap and each team's rounds.
// A player's kills on a map are his kills a round times the rounds played,
// a little more on the side that wins more of them:
//
//   kills ~ NB( kpr × R × (1 + beta × (won / R − ½)) )
//
// with (won, lost) drawn from a map of rounds: first to 13, CS2's MR3
// overtime or Valorant's win-by-two, each round won with chance q, q itself
// spread around the match's q0 (a Beta with concentration kappa, so a map can
// be a stomp or a grind). q0 for each map is the one that best fits
// Pinnacle's round ladders on that map (total, handicap, team totals), so the
// expected rounds and who wins them are Pinnacle's, the kills a round are the
// player's own (his recent maps, shrunk toward the game's average).
//
// Fit on 16,021 bo3.gg CS2 maps (test Apr-Oct 2026, 67,204 player maps):
// with the rounds known, RMSE 4.05 kills a map against 5.45 for the
// player's own kills a map; with the ten rates scaled (matchScale) calibrated
// within 1-2 points a band. Valorant,
// 9,465 vlr.gg maps Jul 2025-Oct 2026 (test Mar-Oct 2026, 43,375 player
// maps): 4.13 against 5.19, within 1-2 points a band. Untested: how close Pinnacle's
// pregame rounds sit to the rounds played (no Pinnacle history); the spread of
// q around q0 is read off the shape of Pinnacle's own ladders.
//
// Two numbers for each app line, both on Pinnacle's rounds:
//   rounds    the player's kills a round × Pinnacle's rounds (this model)
//   pinnacle  the apps' own kills a round (their mean over the average
//             rounds) × Pinnacle's rounds
// A play clears when the first beats the app's break-even by minEv and the
// two agree within agreePts on that side. Graded in a record of its own.
// BetRivers' per-map round lines get a second price too: the round model's
// reading of Pinnacle's map winner (q0 from the map moneyline alone), next
// to Pinnacle's own round ladder. Pure; the server feeds picks and Pinnacle.


const DEFAULTS = {
  // concentration of q around q0. 35 fits the shape of Pinnacle's own round
  // ladders within about a point (snapshot 10-14: 13 CS2 and 2 Valorant
  // matches; 18 missed by 3-4) and, over a spread of q0 like Pinnacle's, gives
  // the history's overtime share (11%) and overs at 21.5 (45-47%). Fit with
  // no pregame strength the bo3.gg maps want 16-20: that spread is partly
  // which team is better, which Pinnacle's q0 already carries.
  kappa: { CS2: 35, VAL: 35 },
  // a winning team's players take more of the kills a round: fit 0.9 in both
  // (CS2 RMSE 4.40 → 4.05, Valorant 4.47 → 4.13)
  beta: { CS2: 0.9, VAL: 0.9 },
  // variance over mean of a player's kills with the rounds known (Valorant
  // 1.14 by moments, 1.3 calibrates its bands within about 2 points)
  nbk: { CS2: 1.13, VAL: 1.3 },
  kpr0: { CS2: 0.667, VAL: 0.697 },
  // both teams' kills a round add to a near-constant (CS2 6.66, sd 0.59 a
  // map over 16,021 maps, s-tier 6.55; Valorant 6.96, sd 0.32 over 9,465):
  // with both lineups known the ten players' rates are scaled to it, so a
  // profile source that runs hot or cold doesn't tilt every line one way
  matchKpr: { CS2: 6.6, VAL: 6.95 },
  avgRounds: { CS2: 21.4, VAL: 21.0 },
  shrinkMaps: 8,     // maps of the game's average kills a round mixed into a player's
  minMaps: 6,        // fewer and his kills a round is a guess
  need: 5,           // a team's players with a rate before its lineup counts as known
  minEv: 2, maxEv: 30, agreePts: 5,
  minP: 0.05, maxP: 0.95,
};
const GAMES = new Set(['CS2', 'VAL']);
const r2 = x => Math.round(x * 100) / 100;
const comb = (n, k) => { let c = 1; for (let i = 0; i < k; i++) c = c * (n - i) / (i + 1); return c; };
const r4 = x => Math.round(x * 1e4) / 1e4;
const gameOf = sport => { const s = String(sport || '').toUpperCase(); return s.includes('VAL') ? 'VAL' : s.includes('CS') || s.includes('COUNTER') ? 'CS2' : null; };

// ── one map's rounds ──
// [a, b, p]: team 0 won a rounds, team 1 won b, when team 0 takes each round with chance q
function mapRounds(q, game = 'CS2') {
  const out = new Map();
  const add = (a, b, p) => { const k = a * 100 + b; out.set(k, (out.get(k) || 0) + p); };
  let st = new Map([[0, 1]]), tie = 0;
  for (let r = 0; r < 24; r++) {
    const nx = new Map();
    for (const [k, p] of st) {
      const a = Math.floor(k / 100), b = k % 100;
      for (const [na, nb, pp] of [[a + 1, b, q], [a, b + 1, 1 - q]]) {
        if (na === 13 || nb === 13) add(na, nb, p * pp);
        else if (na === 12 && nb === 12) tie += p * pp;
        else nx.set(na * 100 + nb, (nx.get(na * 100 + nb) || 0) + p * pp);
      }
    }
    st = nx;
  }
  let base = 12, mass = tie;
  if (game === 'CS2') {
    // MR3: six rounds, first to four; 3-3 plays six more
    for (let ot = 0; ot < 6 && mass > 1e-9; ot++) {
      let s = new Map([[0, mass]]), next = 0;
      for (let r = 0; r < 6; r++) {
        const nx = new Map();
        for (const [k, p] of s) {
          const a = Math.floor(k / 100), b = k % 100;
          for (const [na, nb, pp] of [[a + 1, b, q], [a, b + 1, 1 - q]]) {
            if (na === 4 || nb === 4) add(base + na, base + nb, p * pp);
            else if (na === 3 && nb === 3) next += p * pp;
            else nx.set(na * 100 + nb, (nx.get(na * 100 + nb) || 0) + p * pp);
          }
        }
        s = nx;
      }
      base += 3; mass = next;
    }
  } else {
    // win by two
    for (let ot = 0; ot < 15 && mass > 1e-9; ot++) {
      add(base + 2, base, mass * q * q); add(base, base + 2, mass * (1 - q) * (1 - q));
      mass *= 2 * q * (1 - q); base += 1;
    }
  }
  return [...out].map(([k, p]) => [Math.floor(k / 100), k % 100, p]);
}
// q spread around q0 (Beta(q0 κ, (1 − q0) κ) on 41 points), cached by q0 to 0.0025
const MIX = new Map();
function rounds(q0, game = 'CS2', o = DEFAULTS) {
  const kappa = (o.kappa || DEFAULTS.kappa)[game] ?? 18;
  const q = Math.min(0.95, Math.max(0.05, Math.round(q0 * 400) / 400));
  const key = `${game}|${q}|${kappa}`;
  if (MIX.has(key)) return MIX.get(key);
  const acc = new Map(), N = 41, a = q * kappa, b = (1 - q) * kappa;
  const w = [];
  for (let i = 0; i < N; i++) { const x = (i + 0.5) / N; w.push(Math.exp((a - 1) * Math.log(x) + (b - 1) * Math.log(1 - x))); }
  const W = w.reduce((s, x) => s + x, 0);
  for (let i = 0; i < N; i++) for (const [x, y, p] of mapRounds((i + 0.5) / N, game)) { const k = x * 100 + y; acc.set(k, (acc.get(k) || 0) + p * w[i] / W); }
  const out = [...acc].filter(([, p]) => p > 1e-7).map(([k, p]) => [Math.floor(k / 100), k % 100, p]);
  if (MIX.size > 4000) MIX.clear();
  MIX.set(key, out);
  return out;
}
const expectedRounds = dist => dist.reduce((s, [a, b, p]) => s + (a + b) * p, 0);

// the chance of a ladder point's side under a map of rounds (x as in esbooks: team 0's
// handicap for a spread, −line for totals; p is team 0 covering / the over)
function ladderProb(dist, type, x, team = 0) {
  let s = 0, push = 0, all = 0;
  for (const [a, b, p] of dist) {
    const v = type === 'spread' ? a + x - b : type === 'total' ? a + b + x : type === 'tt' ? (team === 0 ? a : b) + x : type === 'ml' ? a - b : null;
    all += p;
    if (v > 0) s += p; else if (v === 0) push += p;
  }
  return all - push > 0 ? s / (all - push) : null;
}

// q0 for team 0 on one map from Pinnacle's round ladders there
//   ladders: Map(`rounds|N|total` → [{ x, p }], `rounds|N|spread`, `rounds|N|tt|0|1`)
//   → { q, rounds, rms (points off Pinnacle), points } or null
function fitMap(ladders, period, game, o = DEFAULTS) {
  const pts = [];
  for (const type of ['total', 'spread', 'tt']) {
    for (const team of type === 'tt' ? [0, 1] : [0]) {
      const key = `rounds|${period}|${type}${type === 'tt' ? `|${team}` : ''}`;
      for (const q of ladders?.get(key) || []) if (q.p > 0.03 && q.p < 0.97) pts.push({ type, team, x: q.x, p: q.p });
    }
  }
  if (!pts.some(x => x.type === 'total' || x.type === 'tt')) return null;
  let best = null;
  for (let q = 0.2; q <= 0.8001; q += 0.0025) {
    const d = rounds(q, game, o);
    let e = 0;
    for (const t of pts) { const m = ladderProb(d, t.type, t.x, t.team); e += (m - t.p) ** 2; }
    if (!best || e < best.e) best = { q: r4(q), e };
  }
  const d = rounds(best.q, game, o);
  return { q: best.q, rounds: r2(expectedRounds(d)), rms: r2(Math.sqrt(best.e / pts.length) * 100), points: pts.length };
}
// q0 from a map-winner chance alone (team 0 wins the map with chance pWin)
function qFromWin(pWin, game, o = DEFAULTS) {
  if (!(pWin > 0.02 && pWin < 0.98)) return null;
  let lo = 0.05, hi = 0.95;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (ladderProb(rounds(mid, game, o), 'ml', 0) < pWin) lo = mid; else hi = mid;
  }
  return r4((lo + hi) / 2);
}

// ── a player's kills ──
function nbPmf(mean, k, max) {
  const out = new Float64Array(max + 1);
  if (!(mean > 0)) { out[0] = 1; return out; }
  if (k <= 1.0001) { let p = Math.exp(-mean); out[0] = p; for (let x = 1; x <= max; x++) { p *= mean / x; out[x] = p; } return out; }
  const r = mean / (k - 1), pr = 1 / k;
  let p = Math.exp(r * Math.log(pr)); out[0] = p;
  for (let x = 1; x <= max; x++) { p *= (x - 1 + r) / x * (1 - pr); out[x] = p; }
  return out;
}
// kills on one map: kpr a round, his team's q0 (team 0 = his team)
function mapKills(kpr, q, game, o = DEFAULTS, max = 90) {
  const beta = (o.beta || DEFAULTS.beta)[game] ?? 0.9, k = (o.nbk || DEFAULTS.nbk)[game] ?? 1.13;
  const out = new Float64Array(max + 1);
  for (const [a, b, p] of rounds(q, game, o)) {
    if (p < 1e-6) continue;
    const R = a + b, f = nbPmf(kpr * R * (1 + beta * (a / R - 0.5)), k, max);
    for (let x = 0; x <= max; x++) out[x] += p * f[x];
  }
  return out;
}
function convolve(a, b) {
  const o = new Float64Array(a.length + b.length - 1);
  for (let i = 0; i < a.length; i++) if (a[i] > 1e-12) for (let j = 0; j < b.length; j++) o[i + j] += a[i] * b[j];
  return o;
}
// ctx: { game, kpr, qs: [his team's q0 on each map the line covers] } → pmf of his kills
const PMF = new Map();
function killsPmf(ctx, o = DEFAULTS) {
  const key = `${ctx.game}|${r4(ctx.kpr)}|${(ctx.qs || []).join(',')}`;
  if (PMF.has(key)) return PMF.get(key);
  let pmf = null;
  for (const q of ctx.qs || []) { const m = mapKills(ctx.kpr, q, ctx.game, o); pmf = pmf ? convolve(pmf, m) : m; }
  if (PMF.size > 3000) PMF.clear();
  PMF.set(key, pmf);
  return pmf;
}
const pmfMean = pmf => pmf.reduce((s, p, x) => s + p * x, 0);
// the chance of a side at a line (pushes off the table)
function sideProb(ctx, line, side, o = DEFAULTS) {
  if (!ctx || !(ctx.kpr > 0) || !ctx.qs?.length || !(line > 0)) return null;
  const pmf = killsPmf(ctx, o);
  if (!pmf) return null;
  let over = 0, push = 0;
  for (let x = 0; x < pmf.length; x++) { if (x > line) over += pmf[x]; else if (x === line) push += pmf[x]; }
  const under = 1 - over - push;
  if (push >= 1) return null;
  return (side === 'UNDER' ? under : over) / (1 - push);
}

// a player's kills a round, shrunk toward the game's average
//   raw: his kills a round, maps: maps behind it → { kpr, raw, maps } or null
function playerRate(raw, maps, game, o = DEFAULTS) {
  if (!(raw > 0.2 && raw < 1.5) || !(maps >= o.minMaps)) return null;
  const k0 = (o.kpr0 || DEFAULTS.kpr0)[game] ?? 0.7;
  return { kpr: r4((raw * maps + k0 * o.shrinkMaps) / (maps + o.shrinkMaps)), raw: r4(raw), maps };
}

// both teams' rated players → the factor that puts the match on matchKpr
// (each team's mean rate × 5), or null when either team has fewer than need
function matchScale(team0, team1, game, o = DEFAULTS) {
  const a = (team0 || []).filter(x => x > 0), b = (team1 || []).filter(x => x > 0);
  if (a.length < o.need || b.length < o.need) return null;
  const tot = 5 * (a.reduce((s, x) => s + x, 0) / a.length) + 5 * (b.reduce((s, x) => s + x, 0) / b.length);
  return r4(((o.matchKpr || DEFAULTS.matchKpr)[game] ?? tot) / tot);
}

// One pick priced on the round model (as sharemodel.priceShare)
//   p.rounds: { ctx, pinCtx (the apps' kills a round on Pinnacle's rounds), lineup }
//   books:    [{ book, line, open: { OVER, UNDER }, evAt(prob, side) → % }]
function priceRounds(p, { books, o: opts = {} } = {}) {
  const o = { ...DEFAULTS, ...opts };
  const r = p?.rounds;
  if (!r?.ctx) return null;
  const cells = {};
  let best = null;
  for (const b of books || []) {
    if (!(b.line > 0)) continue;
    let cell = null;
    for (const side of ['OVER', 'UNDER']) {
      if (b.open && b.open[side] === false) continue;
      const prob = sideProb(r.ctx, b.line, side, o);
      if (!(prob > 0 && prob < 1)) continue;
      const ev = b.evAt(prob, side);
      if (ev == null || !Number.isFinite(ev)) continue;
      if (!cell || ev > cell.ev) {
        const pinProb = r.pinCtx ? sideProb(r.pinCtx, b.line, side, o) : null;
        cell = { side, ev: r2(ev), prob: r2(prob * 100), pinProb: pinProb != null ? r2(pinProb * 100) : null, line: b.line };
      }
    }
    if (!cell) continue;
    cell.clears = r.lineup === 'known' && cell.ev >= o.minEv && cell.ev <= o.maxEv && cell.pinProb != null
      && Math.abs(cell.prob - cell.pinProb) <= o.agreePts && cell.pinProb > 50;
    cells[b.book] = cell;
    if (!best || (cell.clears - best.clears || cell.ev - best.ev) > 0) best = { book: b.book, ...cell };
  }
  return best ? { ...best, cells } : null;
}

// A priced pick → the tracker's shape (as sharemodel.sharePlay). The close is
// priced on the same ctx (his kills a round, Pinnacle's rounds at each refresh).
function roundsPlay(p, priced) {
  if (!priced || !p?.rounds) return null;
  const book = priced.book;
  return {
    sport: p.sport, player: p.player, team: p.team, matchTitle: p.matchTitle, gameId: p.gameId ?? null,
    market: p.market, displayMarket: p.displayMarket || p.market, startTime: p.startTime,
    side: priced.side, bestBook: book, bestEv: priced.clears ? priced.ev : null, prob: priced.prob, rawProb: priced.prob,
    ppLine: book === 'PP' ? priced.line : p.ppLine, udLine: book === 'UD' ? priced.line : p.udLine, sleeperLine: book === 'SL' ? priced.line : p.sleeperLine ?? null,
    udImplied: p.udImplied ?? null, udMultiplier: p.udMultiplier ?? null, sleeperMultiplier: p.sleeperMultiplier ?? null,
    modelPred: p.rounds.mean, rawPred: null, predSource: 'rounds',
    marketPred: p.rounds.mean, fairSource: 'rounds', confidence: null, context: p.context || null,
    roundsCtx: p.rounds.ctx,
  };
}

// ── BetRivers' per-map round lines ──
// Each BetRivers round line (total, handicap, team rounds on map N) priced on
// the round model with q0 from Pinnacle's map winner (its moneyline on that
// map, else the match price read as a map): a second source beside Pinnacle's
// own round ladder. pinMatch: esbooks.parsePinnacle row aligned to the book's
// team order (its ladders Map). → Map(lineKey|x → p for side 0) or empty
function bookRoundFairs(game, ladders, lines, o = DEFAULTS) {
  const out = new Map();
  if (!GAMES.has(game)) return out;
  const qByMap = new Map();
  // the match price read as one map's, when Pinnacle has no price on that map:
  // a best-of-n won with chance P when each map is won with chance p
  const series = ladders?.get('series|0|ml')?.slice(-1)[0]?.p;
  const bo = (ladders?.get('series|0|total') || []).some(x => x.x <= -3) ? 5 : 3;
  const perMap = P => {
    if (!(P > 0.02 && P < 0.98)) return null;
    const need = Math.ceil(bo / 2), win = p => { let s = 0; for (let k = need; k <= bo; k++) s += comb(bo, k) * p ** k * (1 - p) ** (bo - k); return s; };
    let lo = 0.01, hi = 0.99;
    for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2; if (win(m) < P) lo = m; else hi = m; }
    return (lo + hi) / 2;
  };
  for (const l of lines || []) {
    if (l.scope !== 'rounds') continue;
    if (!qByMap.has(l.period)) {
      const ml = ladders?.get(`map|${l.period}|ml`)?.slice(-1)[0]?.p ?? (series != null ? perMap(series) : null);
      qByMap.set(l.period, ml != null ? qFromWin(ml, game, o) : null);
    }
    const q = qByMap.get(l.period);
    if (q == null) continue;
    const p = ladderProb(rounds(q, game, o), l.type, l.x, l.team ?? 0);
    if (p != null) out.set(`${l.key}|${l.x}`, { p: r4(p), q, rounds: r2(expectedRounds(rounds(q, game, o))) });
  }
  return out;
}

// Graded rows → record: overall, by side, app and game, and by team-map (one
// team's players on one map ride the same Pinnacle rounds, so that count is
// the honest sample size)
function roundsRecord(rows) {
  const groups = {};
  const add = (k, r) => {
    const g = groups[k] ||= { plays: 0, wins: 0, losses: 0, pushes: 0, profit: 0, teams: new Set(), clvN: 0, clvBeat: 0, clvSum: 0 };
    g.plays++;
    if (r.outcome === 'win') g.wins++; else if (r.outcome === 'loss') g.losses++; else g.pushes++;
    g.profit += r.profit || 0;
    g.teams.add(`${r.gameId ?? r.startTime}|${String(r.team || '').toLowerCase()}|${r.market || ''}`);
    if (r.signalFair != null && r.closeFair != null) { g.clvN++; g.clvSum += r.closeFair - r.signalFair; if (r.closeFair > r.signalFair) g.clvBeat++; }
  };
  for (const r of rows || []) {
    if (r.status !== 'graded' || !['win', 'loss', 'push'].includes(r.outcome)) continue;
    add('all', r);
    add(r.signalSide === 'OVER' ? 'overs' : 'unders', r);
    add(`book ${r.signalBook}`, r);
    add(`sport ${r.sport}`, r);
  }
  const out = {};
  for (const [k, g] of Object.entries(groups)) {
    const decided = g.wins + g.losses;
    out[k] = { plays: g.plays, teamMaps: g.teams.size, wins: g.wins, losses: g.losses, pushes: g.pushes,
      hitRate: decided ? +(g.wins / decided).toFixed(4) : null, profit: +g.profit.toFixed(2),
      roi: g.plays ? +(g.profit / g.plays * 100).toFixed(1) : null,
      closeMoved: g.clvN, closeBeat: g.clvBeat, closeAvgPts: g.clvN ? +(g.clvSum / g.clvN * 100).toFixed(2) : null };
  }
  return out;
}

module.exports = { DEFAULTS, GAMES, gameOf, mapRounds, rounds, expectedRounds, ladderProb, fitMap, qFromWin, mapKills, killsPmf, pmfMean, sideProb, playerRate, matchScale, priceRounds, roundsPlay, bookRoundFairs, roundsRecord };
