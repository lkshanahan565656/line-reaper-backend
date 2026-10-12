// Free player stats for props (gol.gg, vlr.gg) and team-vs-team history.
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../propstats');

const GOL = `<table class='table_list playerslist tablesaw trhover'><thead><tr>
  <th>Player</th><th>Country</th><th>Games</th><th>Win rate</th><th>KDA</th><th>Avg kills</th><th>Avg deaths</th><th>Avg assists</th><th>CSM</th><th>GPM</th><th title='x'>KP%</th>
  </tr></thead>
  <tr><td><a href='./player-stats/1/' title='Carzzy stats'>Carzzy</a></td><td class='text-center'><span class='d-none'>CZ</span>&nbsp;<img/></td><td>91</td><td>55%</td><td>3.8</td><td>4.6</td><td>2.6</td><td>5.2</td><td>9.1</td><td>440</td><td>61.8%</td></tr><tr><td><a href='./player-stats/2/'>Bdd</a></td><td></td><td>116</td><td>60%</td><td>3.7</td><td>3.6</td><td>2.6</td><td>6.2</td><td>8.8</td><td>420</td><td>67.8%</td></tr><tr><td><a href='./player-stats/3/'>Bdd</a></td><td></td><td>4</td><td>0%</td><td>1</td><td>1.0</td><td>4</td><td>2</td><td>7</td><td>300</td><td>30%</td></tr>
</table>`;

test('gol.gg: every player row, by header name, the bigger sample winning a shared name', () => {
  const p = P.parseGolPlayers(GOL);
  assert.deepEqual(p.carzzy, { name: 'Carzzy', games: 91, kpg: 4.6, dpg: 2.6, apg: 5.2, kp: 0.618 });
  assert.equal(p.bdd.games, 116);
  assert.equal(P.golSeason(Date.parse('2026-10-12')), 'S16');
  assert.deepEqual(P.parseGolPlayers('<html>blocked</html>'), {});
});

const SEARCH = `<a href="/search/r/player/601/idx" class="wf-module-item search-item mod-first"><div class="search-item-thumb"><img></div>
  <div class="search-item-title">
    Asuna    </div><div class="search-item-desc"></div></a>
  <a href="/search/r/player/50907/idx" class="wf-module-item search-item "><div class="search-item-title">Asuna</div></a>
  <a href="/search/r/player/29750/idx" class="wf-module-item search-item "><div class="search-item-title">soggyseal278</div></a>`;
const page = (team, rows) => `<h2>Current Teams</h2><div class="wf-card"><a class="wf-module-item mod-first" href="/team/120/x"><div><img></div><div>
  <div style="font-weight: 500;">
    ${team} </div></div></a></div>
  <table class="st-table mod-agent-rows" id="st-table"><thead><tr><th class="mod-agent"></th><th class="mod-use">Use</th><th>Rnd</th><th>R</th><th>ACS</th><th>K:D</th><th>KAST</th><th>ADR</th><th>KPR</th><th>APR</th><th>FK:FD</th><th>K</th><th>D</th><th>A</th><th>FK</th><th>FD</th></tr></thead><tbody>
  ${rows.map(([maps, rnd, r, k]) => `<tr><td class="mod-agent"><img></td><td class="mod-use">(${maps}) 50%</td><td>${rnd}</td><td>${r}</td><td>200</td><td>1.1</td><td>70%</td><td>140</td><td>0.8</td><td>0.3</td><td>1</td><td>${k}</td><td>200</td><td>90</td><td>40</td><td>20</td></tr>`).join('')}
  </tbody></table>`;

test('vlr.gg: search hits and the 60-day agent table summed into per-map rates', () => {
  assert.deepEqual(P.parseVlrSearch(SEARCH).map(x => x.id), ['601', '50907', '29750']);
  const p = P.parseVlrPlayer(page('100 Thieves', [[15, 308, 1.15, 249], [3, 56, 1.19, 43], [2, 39, 1.13, 25]]));
  assert.equal(p.team, '100 Thieves');
  assert.equal(p.maps, 20);
  assert.equal(p.rounds, 403);
  assert.equal(p.kills, 317);
  assert.ok(Math.abs(p.avgKillsPerMap - 15.85) < 1e-9);
  assert.ok(Math.abs(p.kpr - 317 / 403) < 1e-9);
  assert.equal(P.parseVlrPlayer('<html></html>'), null);
});

test('vlr.gg lookups: the namesake on the line\'s team wins, and the answer is cached', async () => {
  const calls = [];
  const http = { get: async url => { calls.push(url); if (url.includes('/search/')) return { data: SEARCH }; if (url.includes('/player/601/')) return { data: page('100 Thieves', [[20, 403, 1.15, 317]]) }; return { data: page('Some Academy', [[40, 900, 1.0, 600]]) }; } };
  const v = P.createVlrStats({ http, gapMs: 0 });
  const a = await v.lookup('Asuna', '100 Thieves');
  assert.equal(a.id, '601');
  assert.equal(a.source, 'vlr');
  const before = calls.length;
  await v.lookup('asuna', '100 Thieves');
  assert.equal(calls.length, before, 'cached');
  // with no team to go on, the bigger sample wins
  const w = P.createVlrStats({ http, gapMs: 0 });
  assert.equal((await w.lookup('Asuna')).id, '50907');
});

test('team-vs-team: meetings grouped into series, plus each side\'s recent form', () => {
  const day = 86400e3, t0 = Date.parse('2026-10-01');
  const g = (a, b, aWon, t) => ({ a, b, aWon, t });
  const games = [
    // Vitality 2-1 NAVI (one series, same timestamp)
    g('Team Vitality', 'Natus Vincere', true, t0), g('Team Vitality', 'Natus Vincere', false, t0), g('Team Vitality', 'Natus Vincere', true, t0),
    // NAVI 2-0 Vitality, written the other way round
    g('Natus Vincere', 'Team Vitality', true, t0 + 5 * day), g('Natus Vincere', 'Team Vitality', true, t0 + 5 * day),
    // Vitality 2-0 MOUZ
    g('Vitality', 'MOUZ', true, t0 + 9 * day), g('Vitality', 'MOUZ', true, t0 + 9 * day),
  ];
  const idx = P.indexGames(games);
  const h = P.headToHead(idx, 'Vitality', 'Natus Vincere');
  assert.deepEqual(h.meetings.map(m => m.score), [[0, 2], [2, 1]], 'newest first, from Vitality\'s side');
  assert.deepEqual(h.record, [1, 1]);
  assert.deepEqual(h.maps, [2, 3]);
  assert.equal(h.form[0].series, 3);
  assert.deepEqual(h.form[0].last, ['W', 'L', 'W']);
  assert.equal(h.form[1].won, 1);
  assert.equal(P.headToHead(idx, 'Nobody', 'Else'), null);
  assert.equal(P.headToHead(idx, 'Vitality', 'Spirit').record, null, 'no meetings yet');
});
