// ─── HEAD-TO-HEAD KILL MODEL: OUR OWN FAIR FOR EVERY ESPORTS PLAYER ───────────
// The kill-share model (sharemodel.js) and the round model price a player's
// kills off Pinnacle's team total. This one needs no Pinnacle number: it
// prices the matchup from our own data, the way LCS Larry's board reads.
//
//   team kills a map  = the league's pace × (his team's kills for ÷ pace)^A
//                                          × (the opponent's kills against ÷ pace)^B
//                       (kills a game in LoL and Dota; kills a round × the
//                        rounds a map in CS2 and Valorant)
//   player's mean     = his share of his team's kills × team kills a map × maps
//
// with every rate shrunk toward the pace by a few games so a team with a short
// record sits near average, and a share above a fifth shrunk toward a fifth. In
// CS2 the matchup moves a player's number less than the fit says (slope 0.7 to
// 0.85), so the mean is blended back toward his plain average (blend).
//
// Fit walk-forward on the free history (fit numbers below and in the PR):
// LoL 6,661 lolesports games, CS2 16,802 bo3.gg maps, Dota from OpenDota and
// Valorant 9,466 vlr.gg maps. Against each player's own average the miss falls about 2.5%
// on one LoL game and 5% on three, about 1% in CS2. A team's kills in one game
// are mostly not predictable (LoL sd 8.1, our miss 7.6), so read the mean as a
// mean, never a pick.
//
// Which side to play needs a sharp price too: a leg clears only when this
// model and a Pinnacle-based fair (the kill-share or round model) both put the
// same side past the app's break-even by minEv. With no sharp price the row
// shows the model's fair and is tracked, never marked a play. Pure, so it's
// unit-tested; the server feeds stats in (h2hdata.js).

const { sideProbs } = require('./dist');

const TITLES = {
  // A, B: weight on the team's kills-for and the opponent's kills-against;
  // shrink: games (maps) of the league pace mixed into each team's rate;
  // shareGames: games of an even fifth mixed into a share above a fifth;
  // varA + varB × mean ÷ maps: variance ÷ mean of a player's total (fit by map
  // count; calibrated within 1 to 2 points a decile); blend: weight on the
  // matchup against his own average
  LOL: { unit: 'game', A: 0.7, B: 0.7, shrink: 8, shareGames: 10, varA: 1.4, varB: 0.18, blend: 1, scale: 1, minShare: 0.12 },
  // Dota keeps a carry's share as it is (a position 1 takes a third by role)
  // and runs 3% low on the fit without the lift
  DOTA: { unit: 'game', A: 0.7, B: 0.7, shrink: 8, shareGames: 0, varA: 1.9, varB: 0.12, blend: 1, scale: 1.03, minShare: 0 },
  CS: { unit: 'round', A: 1, B: 1, shrink: 6, shareGames: 4, varA: 2.1, varB: 0, blend: 0.75, scale: 1, minShare: 0, roundsPerMap: 21.3 },
  // Valorant fit walk-forward on 9,466 vlr.gg maps (Jul 2025 to Oct 2026):
  // miss 5.14 kills a map vs 5.20 on his own average, mean within 0.01,
  // variance ÷ mean 1.80 on one map and 1.86 on two
  VAL: { unit: 'round', A: 1, B: 1, shrink: 6, shareGames: 4, varA: 1.85, varB: 0, blend: 0.75, scale: 1, minShare: 0, roundsPerMap: 21 },
};

const DEFAULTS = {
  minEv: 2,          // percent past the app's break-even, for the model and the sharp price alike
  maxEv: 30,         // past this it's a bad match, not an edge
  agreePts: 5,       // model and sharp price within this many points of win chance
  minGames: 6,       // a player with fewer games has no rate worth pricing
  minTeamGames: 3,   // a team with fewer has no pace
};

const r2 = x => Math.round(x * 100) / 100;
const r4 = x => Math.round(x * 1e4) / 1e4;

// One team's kills a map (a game, or a round × rounds) against one opponent.
// pace: the league's kills a team-game (a team-round); team: { kf, n } its kills
// for a game and games; opp: { ka, n } the opponent's kills against a game
function teamKills(title, pace, team, opp) {
  const t = TITLES[title];
  if (!t || !(pace > 0) || !team || !opp) return null;
  const shr = (rate, n) => ((rate > 0 ? rate : pace) * (n || 0) + pace * t.shrink) / ((n || 0) + t.shrink);
  const f = shr(team.kf, team.n), a = shr(opp.ka, opp.n);
  return pace * Math.pow(f / pace, t.A) * Math.pow(a / pace, t.B);
}

// a player's share of his team's kills: his kills a game over the team's, a
// share above a fifth shrunk toward it by shareGames games
function playerShare(title, rate, games, teamRate) {
  const t = TITLES[title];
  if (!t || !(rate > 0) || !(teamRate > 0) || !(games > 0)) return null;
  const raw = rate / teamRate;
  const k = raw > 0.2 ? t.shareGames : 0;
  return { share: r4(Math.min(0.6, (raw * games + 0.2 * k) / (games + k))), raw: r4(raw) };
}

// a player's mean kills on one map: share × team kills (× rounds), blended
// toward his own average
function mapMean(title, { share, teamKillsPerMap, own = null, rounds = null }) {
  const t = TITLES[title];
  if (!t || !(share > 0) || !(teamKillsPerMap > 0)) return null;
  const per = t.unit === 'round' ? teamKillsPerMap * (rounds > 0 ? rounds : t.roundsPerMap) : teamKillsPerMap;
  const m = share * per;
  return (own > 0 ? own + t.blend * (m - own) : m) * (t.scale || 1);
}

// variance ÷ mean of a player's total over `maps` maps at that total's mean
function varRatio(title, mean, maps) {
  const t = TITLES[title];
  return Math.max(1.06, t.varA + (t.varB * mean) / Math.max(1, maps));
}

// The chance of a side at a line. scenarios: [{ maps, weight }] (a Bo3 "maps
// 1-3" line is 2 maps or 3); perMap: the player's mean a map
function h2hProb(title, perMap, line, side, scenarios = [{ maps: 1, weight: 1 }]) {
  if (!TITLES[title] || !(perMap > 0) || !(line > 0)) return null;
  let win = 0, push = 0, wsum = 0;
  for (const s of scenarios) {
    if (!(s.weight > 0) || !(s.maps > 0)) continue;
    const mean = perMap * s.maps;
    const r = sideProbs(line, mean, varRatio(title, mean, s.maps), 'kills');
    win += s.weight * (side === 'UNDER' ? r.under : r.over);
    push += s.weight * r.push;
    wsum += s.weight;
  }
  if (!wsum) return null;
  win /= wsum; push /= wsum;
  return push < 1 ? win / (1 - push) : null;
}

// The maps a line covers → scenarios. maps: the map numbers; bestOf: the series
// length; pMap: the player's team's chance a map (for a decider). A map that
// may not be played (map 3 of a Bo3) is a weight on the scenario with it.
function scenariosFor(maps, bestOf, pMap = 0.5) {
  const list = (maps || []).filter(n => n > 0);
  if (!list.length) return null;
  const need = Math.ceil((bestOf || 1) / 2);   // maps to win the series
  const sure = list.filter(n => n <= need).length;
  const maybe = list.filter(n => n > need);
  if (!maybe.length) return [{ maps: sure, weight: 1 }];
  // Bo3 map 3 and Bo5 map 4 are the only ones priced: anything later is a guess
  if (maybe.length > 1 || maybe[0] !== need + 1) return null;
  const p = Math.min(0.95, Math.max(0.05, pMap > 0 ? pMap : 0.5));
  // the chance the series goes to the map after `need` maps
  const reach = need === 2 ? 2 * p * (1 - p) : 1 - Math.pow(p, 3) - Math.pow(1 - p, 3);
  return [{ maps: sure, weight: 1 - reach }, { maps: sure + 1, weight: reach }].filter(s => s.weight > 0);
}

// One pick priced on the model at every app's own line and payout.
//   p.h2h:   { perMap, scenarios, game }
//   books:   [{ book, line, open: { OVER, UNDER }, evAt(prob 0-1, side) → % }]
//   sharp:   (line, side) → { src, prob 0-1 } or null: a Pinnacle-based fair at that line
// → { side, line, book, ev, prob, sharp, clears, cells } or null
function priceH2H(p, { books, sharp = null, o: opts = {} } = {}) {
  const o = { ...DEFAULTS, ...opts };
  const h = p?.h2h;
  if (!h || !(h.perMap > 0)) return null;
  const cells = {};
  let best = null;
  for (const b of books || []) {
    if (!(b.line > 0)) continue;
    let cell = null;
    for (const side of ['OVER', 'UNDER']) {
      if (b.open && b.open[side] === false) continue;
      const prob = h2hProb(h.game, h.perMap, b.line, side, h.scenarios);
      if (!(prob > 0 && prob < 1)) continue;
      const ev = b.evAt(prob, side);
      if (ev == null || !Number.isFinite(ev)) continue;
      if (!cell || ev > cell.ev) cell = { side, ev: r2(ev), prob: r2(prob * 100), line: b.line };
    }
    if (!cell) continue;
    const s = typeof sharp === 'function' ? sharp(b.line, cell.side) : null;
    if (s && s.prob > 0 && s.prob < 1) {
      const sEv = b.evAt(s.prob, cell.side);
      cell.sharp = { src: s.src, prob: r2(s.prob * 100), ev: sEv != null && Number.isFinite(sEv) ? r2(sEv) : null };
    }
    cell.clears = cell.ev >= o.minEv && cell.ev <= o.maxEv && !!cell.sharp && cell.sharp.ev != null && cell.sharp.ev >= o.minEv
      && Math.abs(cell.prob - cell.sharp.prob) <= o.agreePts;
    cells[b.book] = cell;
    if (!best || (cell.clears - best.clears || cell.ev - best.ev) > 0) best = { book: b.book, ...cell };
  }
  return best ? { ...best, cells } : null;
}

// A priced pick → the tracker's row. Every leg the model alone puts past minEv
// is tracked (bestEv set) so the model gets a record of its own against the
// lines; fairSource 'h2h-sharp' marks the ones a sharp price backed, the only plays.
function h2hPlay(p, priced, { minEv = DEFAULTS.minEv } = {}) {
  if (!priced || !p?.h2h) return null;
  const book = priced.book;
  return {
    sport: p.sport, player: p.player, team: p.team, matchTitle: p.matchTitle, gameId: p.gameId ?? null,
    market: p.market, displayMarket: p.displayMarket || p.market, startTime: p.startTime,
    side: priced.side, bestBook: book, bestEv: priced.ev >= minEv && priced.ev <= DEFAULTS.maxEv ? priced.ev : null, prob: priced.prob, rawProb: priced.prob,
    ppLine: book === 'PP' ? priced.line : p.ppLine, udLine: book === 'UD' ? priced.line : p.udLine, sleeperLine: book === 'SL' ? priced.line : p.sleeperLine ?? null,
    udImplied: p.udImplied ?? null, udMultiplier: p.udMultiplier ?? null, sleeperMultiplier: p.sleeperMultiplier ?? null,
    modelPred: p.h2h.mean, rawPred: null, predSource: 'h2h',
    // the tracker prices the close on this: the model's mean a map at each refresh
    // 'h2h-sharp' when a Pinnacle-based fair backed it at signal (kept on the row)
    marketPred: p.h2h.perMap, fairSource: priced.clears ? 'h2h-sharp' : 'h2h', confidence: null, context: p.context || null,
    h2hCtx: { game: p.h2h.game, scenarios: p.h2h.scenarios },
  };
}

// Graded rows → record: the plays a sharp price backed, the model on its own,
// by side, app and title, each with its team count (five players on one team
// move together, so teams are the honest sample size)
function h2hRecord(rows) {
  const groups = {};
  const add = (k, r) => {
    const g = groups[k] ||= { plays: 0, wins: 0, losses: 0, pushes: 0, profit: 0, teams: new Set(), clvN: 0, clvBeat: 0, clvSum: 0 };
    g.plays++;
    if (r.outcome === 'win') g.wins++; else if (r.outcome === 'loss') g.losses++; else g.pushes++;
    g.profit += r.profit || 0;
    g.teams.add(`${r.gameId ?? r.startTime}|${String(r.team || '').toLowerCase()}`);
    if (r.signalFair != null && r.closeFair != null) { g.clvN++; g.clvSum += r.closeFair - r.signalFair; if (r.closeFair > r.signalFair) g.clvBeat++; }
  };
  for (const r of rows || []) {
    if (r.status !== 'graded' || !['win', 'loss', 'push'].includes(r.outcome)) continue;
    add('all', r);
    add(r.fair === 'h2h-sharp' ? 'cleared (model + sharp)' : 'model only', r);
    add(r.signalSide === 'OVER' ? 'overs' : 'unders', r);
    add(`book ${r.signalBook}`, r);
    add(`sport ${r.sport}`, r);
  }
  const out = {};
  for (const [k, g] of Object.entries(groups)) {
    const decided = g.wins + g.losses;
    out[k] = { plays: g.plays, teams: g.teams.size, wins: g.wins, losses: g.losses, pushes: g.pushes,
      hitRate: decided ? +(g.wins / decided).toFixed(4) : null, profit: +g.profit.toFixed(2),
      roi: g.plays ? +(g.profit / g.plays * 100).toFixed(1) : null,
      closeMoved: g.clvN, closeBeat: g.clvBeat, closeAvgPts: g.clvN ? +(g.clvSum / g.clvN * 100).toFixed(2) : null };
  }
  return out;
}

module.exports = { TITLES, DEFAULTS, teamKills, playerShare, mapMean, varRatio, h2hProb, scenariosFor, priceH2H, h2hPlay, h2hRecord };
