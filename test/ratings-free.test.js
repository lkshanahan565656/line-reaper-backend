const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../ratings');

test('lolesports: completed matches become map wins each way', () => {
  const games = R.lolesportsGames([
    { startTime: '2026-10-03T20:00:00Z', state: 'completed', type: 'match', match: { teams: [
      { name: 'LYON', result: { outcome: 'win', gameWins: 3 } }, { name: 'Cloud9 Kia', result: { outcome: 'loss', gameWins: 1 } }] } },
    { startTime: '2026-10-12T20:00:00Z', state: 'unstarted', type: 'match', match: { teams: [{ name: 'A', result: null }, { name: 'B', result: null }] } },
    { startTime: '2026-10-03T19:00:00Z', state: 'completed', type: 'show' },
  ]);
  assert.equal(games.length, 4);
  assert.equal(games.filter(g => g.aWon).length, 3);
  assert.equal(games[0].a, 'LYON');
  assert.equal(games[0].t, Date.parse('2026-10-03T20:00:00Z'));
});

// trimmed from vlr.gg/matches/results (2026-10-10)
const VLR = `
<div class="wf-label mod-large"> Sat, October 10, 2026 <span class="wf-tag">Today</span> </div>
<div class="wf-card"> <a href="/754734/g2-esports-vs-team-vitality" class="wf-module-item match-item mod-color mod-first">
 <div class="match-item-time"> 8:00 AM </div> <div class="match-item-vs"> <div class="match-item-vs-team ">
 <div class="match-item-vs-team-name"> <div class="text-of"> <span class="flag mod-us"></span> G2 Esports </div> </div>
 <div class="match-item-vs-team-score sp-mask mod-dash"> 0 </div> </div> <div class="match-item-vs-team mod-winner">
 <div class="match-item-vs-team-name"> <i class="sp-hide fa fa-caret-right"></i> <div class="text-of"> <span class="flag mod-eu"></span> Team Vitality </div> </div>
 <div class="match-item-vs-team-score sp-mask mod-dash"> 2 </div> </div> </div> </a>
 <a href="/754735/nrg-vs-loud" class="wf-module-item match-item mod-color "> <div class="match-item-vs"> <div class="match-item-vs-team ">
 <div class="match-item-vs-team-name"> <div class="text-of"> <span class="flag mod-us"></span> NRG </div> </div>
 <div class="match-item-vs-team-score sp-mask mod-dash"> 1 </div> </div> <div class="match-item-vs-team mod-winner">
 <div class="match-item-vs-team-name"> <div class="text-of"> <span class="flag mod-br"></span> LOUD </div> </div>
 <div class="match-item-vs-team-score sp-mask mod-dash"> 2 </div> </div> </div> </a> </div>
<div class="wf-label mod-large"> Fri, October 9, 2026 </div>
<div class="wf-card"> <a href="/1/x" class="wf-module-item match-item mod-color"> <div class="match-item-vs">
 <div class="match-item-vs-team "> <div class="match-item-vs-team-name"> <div class="text-of"> Sentinels </div> </div>
 <div class="match-item-vs-team-score sp-mask mod-dash"> 2 </div> </div> <div class="match-item-vs-team">
 <div class="match-item-vs-team-name"> <div class="text-of"> Paper Rex </div> </div>
 <div class="match-item-vs-team-score sp-mask mod-dash"> 1 </div> </div> </div> </a> </div>`;

test('vlr.gg results page: teams, series scores and the day', () => {
  const games = R.vlrResultsGames(VLR);
  assert.equal(games.length, 2 + 3 + 3);
  const g2 = games.filter(g => g.a === 'G2 Esports');
  assert.equal(g2.length, 2);
  assert.ok(g2.every(g => g.b === 'Team Vitality' && !g.aWon));
  assert.equal(games.find(g => g.a === 'Sentinels').t, Date.parse('Fri, October 9, 2026'));
  assert.ok(games[0].t > 0);
  assert.deepEqual(R.vlrResultsGames('<html>blocked</html>'), []);
});

test('bo3.gg: finished matches by team id, names from the team list', () => {
  const names = new Map([[791, 'FaZe'], [441, 'NAVI Junior']]);
  const games = R.bo3Games([
    { status: 'finished', team1_id: 791, team2_id: 441, team1_score: 2, team2_score: 0, start_date: '2026-10-10T18:20:00.000+00:00' },
    { status: 'finished', team1_id: 791, team2_id: 999, team1_score: 2, team2_score: 1, start_date: '2026-10-09T18:20:00.000+00:00' },
    { status: 'upcoming', team1_id: 791, team2_id: 441, team1_score: 0, team2_score: 0 },
  ], names);
  assert.equal(games.length, 2, 'an unnamed team and an unplayed match are skipped');
  assert.ok(games.every(g => g.a === 'FaZe' && g.b === 'NAVI Junior' && g.aWon));
});

test('refresh: one source failing falls through to the next, and to the other sports', async () => {
  const http = {
    async get(url) {
      if (url.includes('lolesports')) throw new Error('lolesports down');
      if (url.includes('lol.fandom.com')) return { data: { cargoquery: [{ title: { Team1: 'T1', Team2: 'Gen.G', WinTeam: 'T1', DateTime: '2026-09-01 10:00:00' } }] } };
      if (url.includes('opendota')) return { data: [] };
      if (url.includes('vlr.gg')) return { data: VLR };
      if (url.includes('bo3.gg') && url.endsWith('/matches')) return { data: { results: [{ status: 'finished', team1_id: 1, team2_id: 2, team1_score: 2, team2_score: 1, start_date: '2026-10-10T00:00:00Z' }] } };
      if (url.includes('bo3.gg') && url.endsWith('/teams')) return { data: { results: [{ id: 1, name: 'Spirit' }, { id: 2, name: 'MOUZ' }] } };
      throw new Error('unexpected ' + url);
    },
  };
  const state = { elo: {}, meta: {} };
  await R.refreshRatings(http, state, {});
  assert.equal(state.meta.LOL.games, 1, 'Leaguepedia after lolesports failed');
  assert.ok(state.meta.DOTA.error, 'no Dota games is an error, not a crash');
  assert.equal(state.meta.VAL.games, 8);
  assert.equal(state.meta.CS.games, 3);
  assert.ok(state.elo.CS.rating('Team Spirit') > state.elo.CS.rating('MOUZ'));
});
