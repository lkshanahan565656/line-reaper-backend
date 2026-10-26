// ─── CBB MODEL: LIVE DATA AND THE MODEL SECTION ───────────────────────────────
// The NBA model's live layer (nbadata.js) with college basketball's settings:
// ESPN's men's D1 scoreboard (groups=50) and box scores, read every 30 minutes,
// the shipped seed (seeds/cbb-games.json.gz), players keyed by ESPN athlete id
// with a name index (a props row names a player; the one whose school plays in
// that window is picked), teams by ESPN team id. ESPN keeps no college injury
// list, so nobody is marked Out before the tip.
//
// A model view: "model, not an edge" until its own record (kinds cbb-model on
// PrizePicks, p6-cbb-model on Pick6, ud-cbb-model on Underdog at its real
// multiplier) reaches 50 graded live legs with the hit rate z 2+ above that
// app's break-even, then a raw re-check. No alerts.

const path = require('path');
const D = require('./nbadata');
const C = require('./cbbmodel');

const MODEL_VERSION = 'v1';
const VERSION_AT = '2026-10-25';
const VERSION_NOTE = 'v1 from 2026-10-25: the NBA v2 model on college box scores (2023-24 to 2025-26), tuned on November to January 2024-25 games. No college prop line from any book or app exists to test it on, so its calibration is the NBA model\'s (fitted on real NBA book lines) and its live record, from 0, is the only test.';
const KINDS = { prizepicks: 'cbb-model', pick6: 'p6-cbb-model', underdog: 'ud-cbb-model' };

// a schedule team that matches the props row's team text exactly: the
// school's abbreviation, its full name, or its short name or place ("Duke",
// "Kansas St") (no nickname matching: dozens of schools share "Wildcats")
function teamMatch(key, name, s, abbr, alt = []) {
  const t = String(s || '').trim().toLowerCase();
  if (!t) return false;
  return [abbr, name, ...(alt || [])].some(x => x && t === String(x).trim().toLowerCase());
}

const CBB = {
  sport: 'CBB', label: 'college basketball', espn: 'https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball',
  scoreParams: { groups: 50, limit: 500 }, seed: path.join(__dirname, 'seeds', 'cbb-games.json.gz'),
  backtest: path.join(__dirname, 'seeds', 'cbb-model-backtest.json'), injuries: false, kinds: KINDS, version: MODEL_VERSION,
  indexNames: true, preferRowTeam: true, schedOpts: { teamKey: C.teamOf, minTotal: C.COMPACT.minTotal }, compactOpts: C.COMPACT, fixTeam: x => String(x), teamMatch,
};

function createCbbModel(opts = {}) {
  return D.createNbaModel({ params: C.PARAMS, ...opts, sport: CBB });
}

module.exports = { createCbbModel, CBB, KINDS, teamMatch, MODEL_VERSION, VERSION_AT, VERSION_NOTE, PICK_MIN: D.PICK_MIN, UD_EV_MIN: D.UD_EV_MIN };
