// ─── PINNACLE TEAM KILL GAPS ─────────────────────────────────────────────────
// Pinnacle prices each team's kills on each map (LoL and Dota); the pick'em
// books hang one kills line per player. esmarket.teamKillBudget puts the two
// side by side (p.pinTeam.factor = Pinnacle / the books' five players). This
// turns every team where they part by MIN_GAP or more into tracked plays: each
// of the team's players on Pinnacle's side (over when Pinnacle has the team
// higher), at the book whose line is best for that side. They're graded like
// any pick, in their own record, so the gap is tested before anything is
// priced or alerted on it. Pure, so it's unit-tested.

const MIN_GAP = 0.03;

// Maps a span covers for sure: a Bo3 always plays two maps, a Bo5 three.
// "Maps 1-3" in a Bo3 may stop at two, and the books' per-map number then
// isn't comparable with Pinnacle's per-map total, so those spans are left out.
function spanIsCertain(maps, bestOf) {
  const top = Math.max(...maps);
  if (!(top > 0)) return false;
  if (bestOf === 1) return top === 1;
  if (bestOf > 1) return top <= Math.ceil(bestOf / 2);
  return top <= 2;
}

// pick → tracked play on Pinnacle's side, or null. mapsOf(p) → [1, 2, ...].
function gapPlay(p, { mapsOf, minGap = MIN_GAP } = {}) {
  const f = p?.pinTeam?.factor;
  if (!(f > 0) || Math.abs(f - 1) < minGap) return null;
  const maps = mapsOf(p);
  if (!maps?.length || !spanIsCertain(maps, p.context?.bestOf)) return null;
  const side = f > 1 ? 'OVER' : 'UNDER';
  const lines = [['PP', p.ppLine], ['UD', p.udLine]].filter(([, l]) => l != null && Number.isFinite(+l));
  if (!lines.length) return null;
  // the softest line for the side; PrizePicks first on a tie
  lines.sort((a, b) => (side === 'OVER' ? a[1] - b[1] : b[1] - a[1]));
  const [book, line] = lines[0];
  return {
    sport: p.sport, player: p.player, team: p.team, matchTitle: p.matchTitle, gameId: p.gameId ?? null,
    market: p.market, displayMarket: p.displayMarket || p.market, startTime: p.startTime,
    side, bestBook: book, bestEv: 0, prob: null, rawProb: null,
    ppLine: book === 'PP' ? line : p.ppLine, udLine: book === 'UD' ? line : p.udLine, sleeperLine: p.sleeperLine ?? null,
    // standard payout on either book: the gap is judged on hit rate
    udImplied: null, sleeperMultiplier: null,
    modelPred: p.marketPred ?? null, rawPred: null, predSource: 'pinnacle team kills',
    marketPred: p.marketPred ?? null, fairSource: 'pinnacle-team', confidence: null, context: p.context || null,
    pinTeam: p.pinTeam,
  };
}

function gapPlays(picks, opts) {
  const out = [];
  for (const p of picks || []) { const g = gapPlay(p, opts); if (g) out.push(g); }
  return out;
}

// How big the gap was, for the record
function gapBucket(factor) {
  const g = Math.abs((factor ?? 1) - 1);
  if (g < 0.05) return '3-5%';
  if (g < 0.10) return '5-10%';
  return '10%+';
}

// Graded rows → record by gap size, overall and by team (five plays on one
// team move together, so the team count is the honest sample size).
function gapRecord(rows, { breakEven = 0.5622 } = {}) {
  const groups = {};
  const add = (k, r) => {
    const g = groups[k] ||= { plays: 0, wins: 0, losses: 0, pushes: 0, profit: 0, teams: new Set() };
    g.plays++;
    if (r.outcome === 'win') g.wins++; else if (r.outcome === 'loss') g.losses++; else g.pushes++;
    g.profit += r.profit || 0;
    g.teams.add(`${r.gameId ?? r.startTime}|${String(r.team || '').toLowerCase()}`);
  };
  for (const r of rows || []) {
    if (r.status !== 'graded' || !['win', 'loss', 'push'].includes(r.outcome)) continue;
    add('all', r);
    add(gapBucket(r.pinTeam), r);
    add(`${r.signalSide === 'OVER' ? 'overs' : 'unders'}`, r);
  }
  const out = {};
  for (const [k, g] of Object.entries(groups)) {
    const decided = g.wins + g.losses;
    out[k] = { plays: g.plays, teams: g.teams.size, wins: g.wins, losses: g.losses, pushes: g.pushes,
      hitRate: decided ? +(g.wins / decided).toFixed(4) : null, breakEven, profit: +g.profit.toFixed(2),
      roi: g.plays ? +(g.profit / g.plays * 100).toFixed(1) : null };
  }
  return out;
}

module.exports = { MIN_GAP, spanIsCertain, gapPlay, gapPlays, gapBucket, gapRecord };
