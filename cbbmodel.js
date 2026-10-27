// ─── COLLEGE BASKETBALL PLAYER-PROP MODEL ─────────────────────────────────────
// The NBA model (nbamodel.js: minutes distribution, per-minute rates shrunk to
// the league, pace, what the opponent allows per possession, a negative
// binomial per stat mixed over minutes, the shared calibration in propcal.js)
// run on ESPN's men's D1 box scores with the college game's constants: 40
// minutes, 200 player-minutes a team, lower totals and pace. Players are keyed
// by ESPN athlete id (thousands of players, many shared names, transfers every
// spring) and teams by ESPN team id (360 schools, abbreviations clash).
//
// Fitted and scored in checks/cbb-model-2026-10-25 (PREREGISTERED.md, REPORT.md).

const M = require('./nbamodel');
const { canonName } = require('./ev');

const PARAMS = require('./seeds/cbb-model-params.json');

// ESPN team id as the team key; athlete id as the player key
const teamOf = t => String(t?.id || t?.abbreviation || '');
const keyOf = a => (a?.id ? `a${a.id}` : canonName(a?.displayName || ''));
const COMPACT = { teamOf, keyOf, minTotal: 100 };
function compactGame(sum) {
  const g = M.compactGame(sum, COMPACT);
  if (!g) return null;
  // the school's abbreviation per team key, for display
  const ab = {};
  for (const c of (sum?.comp || sum?.header?.competitions?.[0] || {}).competitors || []) ab[teamOf(c.team)] = c.team?.abbreviation || '';
  g.abbr = ab;
  return g;
}

const P0 = () => PARAMS;
const buildHistory = (games, P = P0()) => M.buildHistory(games, P);
const project = (H, key, ctx, P = P0()) => M.project(H, key, ctx, P);
const priceLine = (proj, stat, line, P = P0()) => M.priceLine(proj, stat, line, P);
const expected = (proj, stat, P = P0()) => M.expected(proj, stat, P);
const median = (proj, stat, P = P0()) => M.median(proj, stat, P);
const probOver = (proj, stat, line, P = P0()) => M.probOver(proj, stat, line, P);

module.exports = { PARAMS, STATS: M.STATS, BASE: M.BASE, COMBOS: M.COMBOS, COMPACT, teamOf, keyOf, compactGame, buildHistory, project, priceLine,
  expected, median, probOver, spreadOf: (pc, h, a) => M.spreadOf(pc, h, a, COMPACT.minTotal), before: M.before, seasonOf: M.seasonOf };
