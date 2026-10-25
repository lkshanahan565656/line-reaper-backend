// ─── MATCHUP ENGINE: PER-GAME SETTINGS ───────────────────────────────────────
// One rating engine (esmatchup.js) serves LoL, CS2 and VALORANT. What differs
// is where results come from, what stands in for a league, how long a map
// takes, and the model settings each game's own walk-forward backtest picked
// (scripts/esmatchup-backtest.js; fitted on series before 2026, 2026 out of
// sample).
const path = require('path');

const seed = f => path.join(__dirname, 'seeds', f);

// CS2 has no leagues: bo3.gg's event tier stands in, so a new team starts at
// the level of the events it plays.
const CS_PRIOR = { 'CS2 S-tier': 1800, 'CS2 A-tier': 1640, 'CS2 B-tier': 1470, 'CS2 C-tier': 1350, 'CS2 other': 1350 };

const GAMES = {
  LOL: {
    id: 'LOL', label: 'LoL', board: 'LOL', pmLeague: 'lol', seed: seed('lol-series.json.gz'), backtest: seed('lol-matchup-backtest.json'),
    mapMinutes: 45, trainFrom: '2024-07-01', testFrom: '2026-01-01', major: /^(LCK|LPL|LEC|LCS|LTA North|LTA South|CBLOL|LCP|Worlds|MSI|First Stand|Esports World Cup)$/,
    model: {},
  },
  CS2: {
    id: 'CS2', label: 'CS2', board: 'CS2', pmLeague: 'cs2', seed: seed('cs2-series.json.gz'), backtest: seed('cs2-matchup-backtest.json'),
    mapMinutes: 50, trainFrom: '2024-07-01', testFrom: '2026-01-01', major: /^CS2 (S|A)-tier$/,
    // fitted 2024-07..2025-12: train log loss 0.6309 to 0.6293
    model: { leaguePrior: CS_PRIOR, unknownPrior: 1350, leagueEta: 0, offsetIntlOnly: true, tier2Re: null, scale: 0.8, rdPerDay: 8, breakShrink: 0.1 },
  },
  VAL: {
    id: 'VAL', label: 'VALORANT', board: 'VAL', pmLeague: 'valorant', seed: seed('val-series.json.gz'), backtest: seed('val-matchup-backtest.json'),
    mapMinutes: 50, trainFrom: '2024-09-01', testFrom: '2026-01-01', major: null,
    // fitted 2024-09..2025-12: LoL's settings ran overconfident (train log loss 0.684); these 0.659
    model: { leaguePrior: {}, unknownPrior: 1500, leagueEta: 0, offsetIntlOnly: true, tier2Re: null, scale: 0.6, mapWeight: 0.35, rdUnknown: 250, rdMax: 250 },
  },
};

module.exports = { GAMES, CS_PRIOR };
