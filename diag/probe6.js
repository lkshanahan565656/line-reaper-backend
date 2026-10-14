// find Action Network prop type names: market_rules lists only valid ones
const fs = require('fs');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
const day = d => new Date(Date.now() + d * 864e5).toISOString().slice(0, 10).replace(/-/g, '');
const get = async url => { try { const r = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: AbortSignal.timeout(30000) }); const t = await r.text(); try { return { status: r.status, j: JSON.parse(t) }; } catch { return { status: r.status }; } } catch (e) { return { status: 0 }; } };
const V = `passing_yards passing_tds passing_touchdowns passing_attempts passing_completions completions pass_attempts interceptions interceptions_thrown rushing_yards rushing_attempts rush_attempts carries receiving_yards receptions rushing_receiving_yards rushing_and_receiving_yards passing_rushing_yards longest_reception longest_rush longest_completion anytime_td anytime_touchdown_scorer anytime_td_scorer first_td_scorer points rebounds assists threes 3fgm three_pointers_made steals blocks turnovers points_rebounds_assists pra points_rebounds points_assists rebounds_assists steals_blocks double_double triple_double shots_on_goal shots goals saves total_saves blocked_shots power_play_points strikeouts pitcher_strikeouts hits total_bases home_runs rbis rbi runs runs_scored hits_runs_rbis earned_runs hits_allowed outs pitching_outs outs_recorded walks stolen_bases singles doubles field_goals_made kicking_points tackles_assists sacks tackles made_threes three_pointers player_points goalscorer anytime_goal_scorer to_record_a_hit batter_strikeouts pitcher_outs player_shots_on_goal`.split(/\s+/);
(async () => {
  const sum = {};
  for (const [lg, d] of [['nfl', 4], ['nhl', 0], ['nba', 0], ['mlb', 0]]) {
    const all = [];
    for (let id = 1; id <= 130; id++) for (const v of V) all.push(`core_bet_type_${id}_${v}`);
    const found = {};
    for (let i = 0; i < all.length; i += 110) {
      const r = await get(`https://api.actionnetwork.com/web/v2/scoreboard/${lg}?bookIds=68&periods=event&date=${day(d)}&customPickTypes=${all.slice(i, i + 110).join(',')}`);
      for (const [k, v] of Object.entries(r.j?.market_rules || {})) found[k] = v.name;
      await new Promise(f => setTimeout(f, 150));
    }
    sum[lg] = found;
    fs.mkdirSync('out', { recursive: true });
    fs.writeFileSync('out/summary6.json', JSON.stringify(sum, null, 1));
  }
})();
