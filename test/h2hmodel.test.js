const test = require('node:test');
const assert = require('node:assert');
const H = require('../h2hmodel');
const D = require('../h2hdata');

test('teamKills: a team that kills more against an opponent that dies more expects more', () => {
  const avg = H.teamKills('LOL', 15, { kf: 15, n: 30 }, { ka: 15, n: 30 });
  assert.ok(Math.abs(avg - 15) < 1e-9);
  const hot = H.teamKills('LOL', 15, { kf: 20, n: 30 }, { ka: 19, n: 30 });
  const cold = H.teamKills('LOL', 15, { kf: 11, n: 30 }, { ka: 12, n: 30 });
  assert.ok(hot > 18 && hot < 21, String(hot));
  assert.ok(cold < 13 && cold > 11, String(cold));
  // a short record sits near the pace
  const thin = H.teamKills('LOL', 15, { kf: 25, n: 1 }, { ka: 15, n: 30 });
  assert.ok(thin < 16.5, String(thin));
  assert.equal(H.teamKills('LOL', 0, { kf: 1, n: 1 }, { ka: 1, n: 1 }), null);
  assert.equal(H.teamKills('XX', 15, { kf: 1, n: 1 }, { ka: 1, n: 1 }), null);
});

test('playerShare shrinks a share above a fifth, keeps a low one (LoL), keeps a carry raw (Dota)', () => {
  const lol = H.playerShare('LOL', 6, 10, 15);   // raw 0.4
  assert.equal(lol.raw, 0.4);
  assert.ok(lol.share < 0.4 && lol.share > 0.25);
  assert.equal(H.playerShare('LOL', 1.5, 10, 15).share, 0.1);
  assert.equal(H.playerShare('DOTA', 9, 10, 30).share, 0.3);
  assert.equal(H.playerShare('LOL', 0, 10, 15), null);
});

test('mapMean: share × team kills, × rounds in CS2, blended toward his own average', () => {
  assert.ok(Math.abs(H.mapMean('LOL', { share: 0.3, teamKillsPerMap: 16 }) - 4.8) < 1e-9);
  // CS2: 0.2 × 3.4 kills a round × 21.3 rounds = 14.48, blended 0.75 toward an own 18
  const cs = H.mapMean('CS', { share: 0.2, teamKillsPerMap: 3.4, own: 18, rounds: 21.3 });
  assert.ok(Math.abs(cs - (18 + 0.75 * (0.2 * 3.4 * 21.3 - 18))) < 1e-9);
  assert.ok(Math.abs(H.mapMean('DOTA', { share: 0.25, teamKillsPerMap: 28 }) - 7 * 1.03) < 1e-9);
  assert.equal(H.mapMean('LOL', { share: 0, teamKillsPerMap: 16 }), null);
});

test('h2hProb: a mean right on the line is a coin flip, the sides add to one', () => {
  const o = H.h2hProb('CS', 17, 34.5, 'OVER', [{ maps: 2, weight: 1 }]);
  const u = H.h2hProb('CS', 17, 34.5, 'UNDER', [{ maps: 2, weight: 1 }]);
  assert.ok(Math.abs(o + u - 1) < 1e-9);
  assert.ok(o > 0.45 && o < 0.53, String(o));
  assert.ok(H.h2hProb('LOL', 4, 10.5, 'OVER', [{ maps: 3, weight: 1 }]) > 0.55);
  // a whole-number line leaves the push out
  const w = H.h2hProb('LOL', 3, 6, 'OVER', [{ maps: 2, weight: 1 }]) + H.h2hProb('LOL', 3, 6, 'UNDER', [{ maps: 2, weight: 1 }]);
  assert.ok(Math.abs(w - 1) < 1e-9);
});

test('scenariosFor: certain maps, a Bo3 decider weighted by the map price, nothing guessed past it', () => {
  assert.deepEqual(H.scenariosFor([1, 2], 3, 0.6), [{ maps: 2, weight: 1 }]);
  assert.deepEqual(H.scenariosFor([1, 2, 3], 5, 0.6), [{ maps: 3, weight: 1 }]);
  const bo3 = H.scenariosFor([1, 2, 3], 3, 0.5);
  assert.equal(bo3.length, 2);
  assert.ok(Math.abs(bo3[1].weight - 0.5) < 1e-9 && bo3[1].maps === 3);
  assert.equal(H.scenariosFor([1, 2, 3], null, 0.5), null);   // unknown series length: maps 1-3 unpriced
  assert.equal(H.scenariosFor([4, 5], 5, 0.5), null);
  assert.equal(H.scenariosFor([], 3), null);
});

test('priceH2H clears only where a sharp price agrees past break-even', () => {
  const evAt = prob => (prob / 0.5503 - 1) * 100;   // a PrizePicks-like break-even
  const p = { h2h: { game: 'LOL', perMap: 4, scenarios: [{ maps: 3, weight: 1 }] } };
  const books = [{ book: 'PP', line: 9.5, evAt }];
  const alone = H.priceH2H(p, { books });
  assert.equal(alone.side, 'OVER');
  assert.ok(alone.ev > 2);
  assert.equal(alone.clears, false);           // no sharp price: shown, never a play
  const agree = H.priceH2H(p, { books, sharp: (line, side) => ({ src: 'pin', prob: H.h2hProb('LOL', 3.9, line, side, [{ maps: 3, weight: 1 }]) }) });
  assert.equal(agree.clears, true);
  assert.equal(agree.cells.PP.sharp.src, 'pin');
  const disagree = H.priceH2H(p, { books, sharp: (line, side) => ({ src: 'pin', prob: H.h2hProb('LOL', 3.0, line, side, [{ maps: 3, weight: 1 }]) }) });
  assert.equal(disagree.clears, false);
  // a closed side isn't priced
  const closed = H.priceH2H(p, { books: [{ book: 'UD', line: 9.5, open: { OVER: false, UNDER: true }, evAt }] });
  assert.equal(closed.side, 'UNDER');
  assert.equal(H.priceH2H({}, { books }), null);
});

test('h2hPlay tracks the model alone past minEv and marks the sharp-backed ones', () => {
  const p = { sport: 'LoL', player: 'Caps', team: 'G2', market: 'MAPS 1-3 Kills', startTime: '2030-01-01T00:00:00Z', ppLine: 9.5,
    h2h: { game: 'LOL', perMap: 4, mean: 12, scenarios: [{ maps: 3, weight: 1 }] } };
  const play = H.h2hPlay(p, { book: 'PP', side: 'OVER', ev: 5, prob: 58, line: 9.5, clears: false });
  assert.equal(play.bestEv, 5);
  assert.equal(play.fairSource, 'h2h');
  assert.equal(play.marketPred, 4);
  assert.equal(H.h2hPlay(p, { book: 'PP', side: 'OVER', ev: 5, prob: 58, line: 9.5, clears: true }).fairSource, 'h2h-sharp');
  assert.equal(H.h2hPlay(p, { book: 'PP', side: 'OVER', ev: 1, prob: 56, line: 9.5, clears: false }).bestEv, null);
});

test('h2hRecord splits sharp-backed plays from the model alone and counts teams', () => {
  const g = (o) => ({ status: 'graded', signalSide: 'OVER', signalBook: 'PP', sport: 'LOL', startTime: 't', gameId: 'g1', ...o });
  const rec = H.h2hRecord([
    g({ outcome: 'win', profit: 0.8, team: 'G2', fair: 'h2h-sharp' }),
    g({ outcome: 'loss', profit: -1, team: 'G2', fair: 'h2h' }),
    g({ outcome: 'loss', profit: -1, team: 'FNC', fair: 'h2h' }),
    { status: 'open', outcome: null },
  ]);
  assert.equal(rec.all.plays, 3);
  assert.equal(rec.all.teams, 2);
  assert.equal(rec['cleared (model + sharp)'].wins, 1);
  assert.equal(rec['model only'].losses, 2);
});

test('store: running totals per team and player, inputs by name, the opponent by name or code', () => {
  const st = D.createStore({ title: 'DOTA', hl: 40, unit: 'game', pace0: 28 });
  const map = (t, kA, kB) => ({ t, teams: [{ key: 'dota:1', name: 'Team Spirit', tag: 'TSpirit', K: kA }, { key: 'dota:2', name: 'Tundra Esports', tag: 'Tundra', K: kB }],
    players: [...[0, 1, 2, 3, 4].map(i => ({ id: `dota:a${i}`, name: i === 0 ? 'Yatoro' : `a${i}`, ti: 0, k: i === 0 ? 10 : kA / 5 - 1 })),
      ...[0, 1, 2, 3, 4].map(i => ({ id: `dota:b${i}`, name: `b${i}`, ti: 1, k: kB / 5 }))] });
  for (let i = 1; i <= 8; i++) assert.ok(st.ingest(map(i * 1000, 30, 20)));
  assert.equal(st.ingest(map(500, 30, 20)), false);     // older than the last: skipped
  const inp = st.inputs('Yatoro', 'Team Spirit', 'Tundra');
  assert.ok(!inp.why, JSON.stringify(inp));
  assert.ok(Math.abs(inp.team.kf - 30) < 1e-9);
  assert.ok(Math.abs(inp.opp.ka - 30) < 1e-9);
  assert.ok(Math.abs(inp.share - 1 / 3) < 1e-9);
  assert.equal(st.inputs('Nobody', 'Team Spirit', 'Tundra').why, 'player');
  assert.equal(st.inputs('Yatoro', 'Team Spirit', 'Gaimin').why, 'team');
  // round trip through JSON keeps the state
  const back = D.wrapStore(JSON.parse(JSON.stringify(st.toJSON())));
  assert.equal(back.inputs('Yatoro', 'TSpirit', 'Tundra Esports').games, inp.games);
});

test('bo3Map: two full lineups or nothing', () => {
  const row = (nick, team, k) => ({ steam_profile: { player: { nickname: nick, slug: nick.toLowerCase() } }, clan_name: team, kills: k });
  const rows = [...['a', 'b', 'c', 'd', 'e'].map(n => row(n, 'FURIA', 18)), ...['f', 'g', 'h', 'i', 'j'].map(n => row(n, 'BetBoom', 14))];
  const m = D.bo3Map({ team1_id: 1, team2_id: 2, start_date: '2026-10-14T17:00:00Z' }, { begin_at: '2026-10-14T17:05:00Z', rounds_count: 24 }, rows, { 1: 'FURIA', 2: 'BetBoom' });
  assert.equal(m.R, 24);
  assert.deepEqual(m.teams.map(t => t.K), [90, 70]);
  assert.equal(m.players.length, 10);
  assert.equal(D.bo3Map({ team1_id: 1, team2_id: 2 }, { begin_at: '2026-10-14T17:05:00Z', rounds_count: 24 }, rows.slice(1), { 1: 'FURIA', 2: 'BetBoom' }), null);
});

test('dotaMaps groups explorer rows into games with team ids and pro names', () => {
  const rows = [];
  for (let s = 0; s < 10; s++) rows.push({ match_id: 7, start_time: 100, radiant_score: 30, dire_score: 20, radiant_team_id: 1, dire_team_id: 2, player_slot: s < 5 ? s : 128 + s, account_id: 50 + s, kills: s < 5 ? 6 : 4 });
  const [m] = D.dotaMaps(rows, { teams: { 1: { name: 'Team Spirit', tag: 'TS' } }, pros: { 50: 'Yatoro' } });
  assert.equal(m.t, 100000);
  assert.equal(m.teams[0].name, 'Team Spirit');
  assert.equal(m.players.find(p => p.name === 'Yatoro').ti, 0);
  assert.equal(D.dotaMaps(rows.slice(1)).length, 0);
});

test('parseGolTeams reads the team list; golInputs finds teams by code', () => {
  const td = v => `<td class='text-center'>${v}</td>`;
  const row = (name, games, kpg, dpg) => `<tr><td><a href='./team-stats/1/'>${name}</a></td>${td('S16')}${td('LCK')}${td(games)}${td('50%')}${td('1.0')}${td('1900')}${td('0')}${td('31:30')}${td('x')}${td('x')}${td(kpg)}${td(dpg)}</tr>`;
  const html = `<table><thead><tr><th>Name</th><th>Season</th><th>Region</th><th>Games</th><th>Win rate</th><th>K:D</th><th>GPM</th><th>GDM</th><th>Game duration</th><th>FP%</th><th>Blue%</th><th>Kills / game</th><th>Deaths / game</th></tr></thead><tbody>${row('Karmine Corp', 40, 16.2, 12.1)}${row('Cloud9 Kia', 30, 13.5, 14)}</tbody></table>`;
  const t = D.parseGolTeams(html);
  assert.equal(t.karminecorp.kpg, 16.2);
  assert.equal(t.cloud9kia.dpg, 14);
  assert.equal(t.karminecorp.minutes, 31.5);
  const inp = D.golInputs(t, { kpg: 5, games: 40 }, 'KC', 'C9');
  assert.ok(!inp.why, JSON.stringify(inp));
  assert.equal(inp.team.kf, 16.2);
  assert.equal(inp.opp.ka, 14);
  assert.equal(D.golInputs(t, { kpg: 5, games: 2 }, 'KC', 'C9').why, 'games');
  assert.equal(D.golInputs(t, { kpg: 5, games: 40 }, 'KC', 'T1').why, 'team');
});

test('the seeds load and price a known matchup', () => {
  const path = require('path');
  for (const t of ['cs', 'dota']) {
    const s = D.loadStore(path.join(__dirname, '..', 'seeds', `h2h-${t}.json.gz`));
    assert.ok(s && Object.keys(s.state.players).length > 500, t);
    assert.ok(s.state.lastT > Date.parse('2026-10-01'), t);
  }
});
