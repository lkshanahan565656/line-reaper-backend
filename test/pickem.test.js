const test = require('node:test');
const assert = require('node:assert');
const { parsePrizePicksPayload, parseSleeperLines, sleeperMarket, attachMatches, sleeperPricing, sleeperEsportsKeys } = require('../pickem');
const { teamsMatch } = require('../context');
const { sportKey } = require('../tracker');

test('PrizePicks: standard single-player lines only, named from included players', () => {
  const proj = (id, attrs, player = 'p1') => ({ id, type: 'projection', attributes: { line_score: 20.5, stat_type: 'MAPS 1-2 Kills', start_time: '2026-10-13T05:00:00-04:00', odds_type: 'standard', status: 'pre_game', description: 'BRO', ...attrs },
    relationships: { new_player: { data: { id: player } }, league: { data: { id: '265' } } } });
  const data = {
    data: [proj('1', {}), proj('2', { odds_type: 'demon' }), proj('3', { odds_type: 'goblin' }), proj('4', { stat_type: 'MAPS 1-3 Kills (Combo)' }), proj('5', {}, 'missing'), proj('6', { line_score: null })],
    included: [{ id: 'p1', type: 'new_player', attributes: { display_name: 'donk', team: 'Spirit', league: 'CS2' } }, { id: '265', type: 'league', attributes: { name: 'CS2' } }],
  };
  const { lines, leagues } = parsePrizePicksPayload(data);
  assert.strictEqual(lines.length, 1);
  assert.deepStrictEqual([lines[0].player, lines[0].team, lines[0].sport, lines[0].line, lines[0].leagueId], ['donk', 'Spirit', 'CS2', 20.5, '265']);
  assert.deepStrictEqual(leagues, { 265: 'CS2' });
});

test('Sleeper market names read as map ranges', () => {
  assert.strictEqual(sleeperMarket('kills_maps_1_2'), 'Kills Maps 1-2');
  assert.strictEqual(sleeperMarket('headshots_maps_1_3'), 'Headshots Maps 1-3');
  assert.strictEqual(sleeperMarket('kills_map_1'), 'Kills Map 1');
  assert.strictEqual(sleeperMarket('fantasy_points'), 'Fantasy Points');
});

const opt = (outcome, mult, extra = {}) => ({ status: 'active', outcome, outcome_value: 9.5, payout_multiplier: String(mult), subject_team: 'Liquid', ...extra });
const row = (extra = {}) => ({ status: 'active', sport: 'cs', subject_id: '11572', subject_type: 'player', outcome_type: 'over_under', game_status: 'pre_game', wager_type: 'headshots_maps_1_2', game_id: 'match-1', options: [opt('over', 1.48), opt('under', 2.19)], ...extra });

test('Sleeper: esports player lines with a price per side, names from the player table', () => {
  const players = { cs: { 11572: { metadata: { username: 'NAF' }, first_name: 'Keith', last_name: 'Markovic', team: 'TL' } } };
  const rows = [row(), row({ sport: 'nfl' }), row({ subject_id: 'unknown' }), row({ game_status: 'in_game' }),
    row({ subject_id: '11572', wager_type: 'kills_maps_1_2', options: [opt('over', 1.8), opt('under', 1.9, { status: 'suspended' })] })];
  const lines = parseSleeperLines(rows, players);
  assert.strictEqual(lines.length, 2);
  assert.deepStrictEqual([lines[0].player, lines[0].sport, lines[0].market, lines[0].line, lines[0].overMultiplier, lines[0].underMultiplier], ['NAF', 'CS', 'Headshots Maps 1-2', 9.5, 1.48, 2.19]);
  assert.strictEqual(lines[1].underOpen, false);
  assert.deepStrictEqual(sleeperEsportsKeys(rows), ['cs']);
});

test('Sleeper lines borrow the match from the team\'s next PP or UD line, else drop', () => {
  const now = Date.parse('2026-10-13T00:00:00Z');
  const sl = [{ sport: 'CS', team: 'Liquid', player: 'NAF' }, { sport: 'CS', team: 'Nobody', player: 'x' }];
  const refs = [
    { sport: 'CS', team: 'Team Liquid', startTime: '2026-10-14T00:00:00Z', matchTitle: 'later' },
    { sport: 'LOL', team: 'Liquid', startTime: '2026-10-13T01:00:00Z', matchTitle: 'wrong game' },
    { sport: 'CS', team: 'Team Liquid', startTime: '2026-10-13T02:00:00Z', matchTitle: 'Liquid vs NAVI' },
    { sport: 'CS', team: 'Team Liquid', startTime: '2026-10-12T02:00:00Z', matchTitle: 'already played' },
  ];
  const out = attachMatches(sl, refs, teamsMatch, sportKey, now);
  assert.strictEqual(out.length, 1);
  assert.deepStrictEqual([out[0].matchTitle, out[0].team], ['Liquid vs NAVI', 'Team Liquid']);
});

test('Sleeper pricing: decimal EV, vig out before the sanity check', () => {
  const a = sleeperPricing(58, 1.8, 1.9);
  assert.ok(Math.abs(a.ev - 4.4) < 1e-9);
  assert.ok(Math.abs(a.implied - 51.35) < 0.01);
  // 1.48 vs 2.19 implies about 60% over. A model at 75% is a fake edge: withheld
  assert.strictEqual(sleeperPricing(75, 1.48, 2.19).ev, null);
  assert.strictEqual(sleeperPricing(75, 1.48, 2.19).flag, 'price-mismatch');
  // at 45% it's just a bad price on Sleeper: the negative EV shows
  const bad = sleeperPricing(45, 1.48, 2.19);
  assert.strictEqual(bad.flag, null);
  assert.ok(Math.abs(bad.ev - (0.45 * 1.48 - 1) * 100) < 1e-9);
});
