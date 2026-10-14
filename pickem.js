// ─── PICK'EM BOOK PARSERS: PrizePicks and Sleeper ────────────────────────────
// Pure functions, so the payload handling is testable and survives shape changes.
// Both answer from Railway (checked live 2026-10-13 on /api/esports/probe/books):
//   PrizePicks partner-api.prizepicks.com/projections (api.prizepicks.com 403s
//   datacenter IPs), JSON:API with league_id filtering.
//   Sleeper api.sleeper.app/lines/available: one row per player line, an
//   option per side with its own payout, players from /players/{sport}.

// PrizePicks. Only standard lines: goblins and demons pay on a different table
// and allow one side only, so pricing them at standard odds would be wrong.
// Combo props (two players, or a whole team) aren't modelled.
function parsePrizePicksPayload(data) {
  const players = {}, leagues = {}, lines = [];
  for (const inc of (data && data.included) || []) {
    const a = inc.attributes || {};
    if (inc.type === 'new_player') players[inc.id] = { name: a.display_name || a.name || '', team: a.team || '', league: a.league || '' };
    if (inc.type === 'league') leagues[inc.id] = a.name || '';
  }
  for (const proj of (data && data.data) || []) {
    const attr = proj.attributes || {};
    if (!attr.line_score) continue;
    if (attr.odds_type && attr.odds_type !== 'standard') continue;
    if (/combo/i.test(attr.stat_type || '') || attr.event_type === 'combo') continue;
    if (attr.status && attr.status !== 'pre_game') continue;
    const player = players[proj.relationships?.new_player?.data?.id] || {};
    if (!player.name) continue;   // a line we can't name can't be matched or graded
    const leagueId = proj.relationships?.league?.data?.id;
    const sport = leagues[leagueId] || player.league || attr.league || '';
    lines.push({ book: 'prizepicks', sport, leagueId: leagueId || null, player: player.name, team: player.team || '', market: attr.stat_type || '',
      line: parseFloat(attr.line_score), startTime: attr.start_time || '', matchTitle: attr.description || '', gameId: attr.game_id || null });
  }
  return { lines, leagues };
}

// Sleeper's esports sport keys, and the labels the rest of the server uses
const SLEEPER_ESPORTS = { cs: 'CS', cs2: 'CS', lol: 'LOL', val: 'VAL', valorant: 'VAL', dota: 'DOTA', dota2: 'DOTA', cod: 'COD', r6: 'R6' };

// "kills_maps_1_2" → "Kills Maps 1-2", "headshots_maps_1_3" → "Headshots Maps 1-3",
// "kills_map_1" → "Kills Map 1". The range form, so 1_3 reads as three maps.
function sleeperMarket(wager) {
  const w = String(wager || '');
  const m = w.match(/^(.*?)_(maps?|games?)_(\d+)(?:_(\d+))?$/);
  const words = s => s.split('_').filter(Boolean).map(x => x.charAt(0).toUpperCase() + x.slice(1)).join(' ');
  if (!m) return words(w);
  const unit = m[2].charAt(0).toUpperCase() + m[2].slice(1);
  return `${words(m[1])} ${unit} ${m[4] ? `${m[3]}-${m[4]}` : m[3]}`;
}

// Sleeper's sports keys (soccer comes per competition, "clubsoccer:epl"), as
// the labels Underdog and PrizePicks use, so one player's lines line up
const SLEEPER_SPORTS = { nfl: 'NFL', nba: 'NBA', mlb: 'MLB', nhl: 'NHL', wnba: 'WNBA', cfb: 'CFB', cbb: 'CBB', tennis: 'TENNIS', mma: 'MMA', golf: 'GOLF' };
const sleeperSport = key => {
  const k = String(key || '').toLowerCase();
  return SLEEPER_ESPORTS[k] || SLEEPER_SPORTS[k] || (/^clubsoccer|^soccer/.test(k) ? 'SOCCER' : null);
};
// Sleeper's wager keys in the words Underdog uses ("Rush + Rec Yards"), so
// ev.js canonMarket reads all three books the same
const SLEEPER_WAGERS = {
  points: 'Points', rebounds: 'Rebounds', assists: 'Assists', threes_made: '3-Pointers Made', steals: 'Steals', blocks: 'Blocks',
  pts_reb_ast: 'Pts + Rebs + Asts', pts_reb: 'Pts + Rebs', pts_ast: 'Pts + Asts', reb_ast: 'Rebs + Asts', turnovers: 'Turnovers',
  hits: 'Hits', hits_runs_rbis: 'Hits + Runs + RBIs', runs: 'Runs', singles: 'Singles', total_bases: 'Total Bases', bat_walks: 'Batter Walks',
  rbis: 'RBIs', stolen_bases: 'Stolen Bases', earned_runs: 'Earned Runs Allowed', first_inning_runs: '1st Inn. Runs Allowed',
  hits_allowed: 'Hits Allowed', outs: 'Pitching Outs', strike_outs: 'Pitcher Strikeouts', walks: 'Pitcher Walks Allowed',
  goals: 'Goals', powerplay_points: 'Power Play Points', goals_against: 'Goals Against', saves: 'Saves', blocked_shots: 'Blocked Shots',
  anytime_touchdowns: 'Anytime TD', receiving_yards: 'Receiving Yards', receptions: 'Receptions', rushing_yards: 'Rush Yards',
  passing_yards: 'Pass Yards', passing_touchdowns: 'Pass TDs', rushing_and_receiving_yards: 'Rush + Rec Yards',
  passing_and_rushing_yards: 'Pass + Rush Yards', rushing_attempts: 'Rush Attempts', pass_completions: 'Completions',
  passing_attempts: 'Pass Attempts', interceptions: 'INTs Thrown', longest_rush: 'Longest Rush', longest_reception: 'Longest Reception',
  longest_passing_completion: 'Longest Completion', extra_point_made: 'XP Made', field_goal_made: 'FG Made', kicking_points: 'Kicking Points',
  games_played: 'Total Games', games_won: 'Games Won', aces: 'Aces', breakpts_won: 'Break Points Won',
  significant_strikes: 'Significant Strikes', takedowns: 'Takedowns', total_fight_time: 'Fight Time',
  shots_on_target: 'Shots On Target', passes_attempted: 'Passes Attempted', first_half_goals_against: '1H Goals Against',
};
function sleeperSportMarket(sport, wager) {
  const w = String(wager || '').toLowerCase();
  if (w === 'shots') return sport === 'NHL' ? 'Shots on Goal' : 'Shots';
  return SLEEPER_WAGERS[w] || sleeperMarket(w);
}

// rows: /lines/available. players: { sport: { id: player } } from /players/{sport}.
// Each side's payout_multiplier is that leg's own multiplier (an entry pays
// their product), so it's a decimal price: 1.48 Over vs 2.19 Under says Sleeper
// sees the over near 60%.
// Esports only unless { sports: true }: the esports board borrows each line's
// match from another book, while the props board takes every sport.
function parseSleeperLines(rows, players = {}, { sports = false } = {}) {
  const lines = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const key = String(row.sport || '').toLowerCase();
    const sport = sports ? sleeperSport(key) : SLEEPER_ESPORTS[key];
    if (!sport || row.subject_type !== 'player' || row.outcome_type !== 'over_under') continue;
    if (row.status && row.status !== 'active') continue;
    if (row.game_status && row.game_status !== 'pre_game') continue;
    let over = null, under = null, line = null, team = '';
    for (const o of row.options || []) {
      if (!o || (o.status && o.status !== 'active')) continue;
      const m = parseFloat(o.payout_multiplier);
      if (!(m > 1)) continue;
      if (o.outcome === 'over') over = m; else if (o.outcome === 'under') under = m; else continue;
      if (line == null) line = parseFloat(o.outcome_value);
      team = team || o.subject_team || '';
    }
    if (line == null || !isFinite(line) || (over == null && under == null)) continue;
    const p = (players[key] || {})[row.subject_id] || {};
    const name = p.metadata?.username || p.username || [p.first_name, p.last_name].filter(Boolean).join(' ');
    if (!name) continue;
    const esport = !!SLEEPER_ESPORTS[key];
    lines.push({
      book: 'sleeper', sport, player: name, team: team || p.team || '', market: esport ? sleeperMarket(row.wager_type) : sleeperSportMarket(sport, row.wager_type), line,
      gameId: row.game_id || null, startTime: '', matchTitle: '', slSport: key, season: row.season || null, seasonType: row.season_type || null,
      overMultiplier: over, underMultiplier: under, overOpen: over != null, underOpen: under != null,
    });
  }
  return lines;
}

// Every sport key with lines, esports and sports
function sleeperSportKeys(rows) {
  const s = new Set();
  for (const r of Array.isArray(rows) ? rows : []) if (sleeperSport(r.sport)) s.add(String(r.sport).toLowerCase());
  return [...s];
}
// A player table is a few MB (CFB about 6); only the fields a line needs are kept
function slimPlayers(table) {
  const out = {};
  for (const [id, p] of Object.entries(table || {})) {
    if (!p || typeof p !== 'object') continue;
    out[id] = { first_name: p.first_name || '', last_name: p.last_name || '', team: p.team || '', ...(p.metadata?.username ? { metadata: { username: p.metadata.username } } : {}) };
  }
  return out;
}

// Sleeper lines carry no start time or match. Borrow both from a PrizePicks or
// Underdog line on the same team; without one we can't tell the match hasn't
// started, so the line is left out.
function attachMatches(slLines, refLines, teamsMatch, sportKey, now = Date.now()) {
  // the team's next match first, when it plays more than one
  const refs = refLines.filter(r => r.team && r.startTime && Date.parse(r.startTime) > now)
    .sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime));
  const out = [];
  for (const l of slLines) {
    if (!l.team) continue;
    const ref = refs.find(r => sportKey(r.sport) === sportKey(l.sport) && teamsMatch(r.team, l.team));
    if (!ref) continue;
    out.push({ ...l, team: ref.team, startTime: ref.startTime, matchTitle: ref.matchTitle || '' });
  }
  return out;
}

// One Sleeper leg: EV at its own decimal multiplier, with the same sanity check
// as Underdog (withheld only when our chance sits far ABOVE Sleeper's). When both sides are open the vig comes out before comparing our
// probability with Sleeper's.
const MAX_GAP = 0.10;
function sleeperPricing(prob, mult, otherMult) {
  const p = prob > 1 ? prob / 100 : prob;
  const raw = 1 / mult;
  const implied = otherMult ? raw / (raw + 1 / otherMult) : raw;
  const gap = p - implied;
  const flag = gap > MAX_GAP ? 'price-mismatch' : null;
  return { ev: flag ? null : (p * mult - 1) * 100, implied: implied * 100, flag, gap: gap * 100 };
}

module.exports = { parsePrizePicksPayload, parseSleeperLines, sleeperSportKeys, sleeperSport, sleeperSportMarket, slimPlayers, sleeperMarket, attachMatches, sleeperPricing, SLEEPER_ESPORTS };
