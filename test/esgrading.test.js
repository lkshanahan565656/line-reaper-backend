const test = require('node:test');
const assert = require('node:assert/strict');

const { vlrMatchPage, vlrResultsList, vlrGradeFromPage, vlrPickSide, createValGrader, vlrMapDone } = require('../graders');
const { createTracker, createMemoryStore } = require('../tracker');
const T = require('../pintotals');
const roundmodel = require('../roundmodel');
const sharemodel = require('../sharemodel');

const quiet = { warn() {}, log() {} };
const HOUR = 3600e3;

// ── a vlr.gg match page in its current layout, cut down ──
function vlrRow(name, tag, k, d, a, pid) {
  return `<div class="ovw-row"> <div class="ovw-cell mod-player"> <div class="ovw-player"> <a href="/player/${pid}/x"> <div class="ovw-player-name text-of">${name}</div> <div class="ovw-player-tag ge-text-light">${tag}</div> </a> </div> </div>
  <div class="ovw-cell mod-kda"> <span class="stats-sq mod-kda"><span class="ovw-kda-stat" data-col="kills"><span class="side mod-both">${k}</span><span class="side mod-t">1</span></span><span class="num-space">/</span><span class="ovw-kda-stat" data-col="deaths"><span class="side mod-both">${d}</span></span><span class="num-space">/</span><span class="ovw-kda-stat" data-col="assists"><span class="side mod-both">${a}</span></span></span> </div> </div>`;
}
function vlrGame(gid, left, right, sl, sr, tags, players, map = 'Ascent') {
  return `<div class="vm-stats-game " data-game-id="${gid}"> <div class="vm-stats-game-header"> <div class="team"> <div class="score mod-win">${sl} </div> <div> <div class="team-name"> ${left} </div> </div> </div>
  <div class="map"> <div class="map-name"> <span style="position: relative;"> ${map} <span class="picked">PICK</span> </span> </div> </div>
  <div class="team mod-right"> <div> <div class="team-name"> ${right} </div> </div> <div class="score ">${sr}</div> </div> </div>
  <div class="vlr-rounds"> <span class="vlr-rounds-tag" title="${tags[0]}">${tags[0]}</span> <span class="vlr-rounds-tag" title="${tags[1]}">${tags[1]}</span> </div>
  <div class="ovw-table"> <div class="ovw-row mod-head"> <div class="ovw-th mod-player"></div> </div> ${players.join('\n')} </div> </div>`;
}
const LINEUPS = {
  G2: ['jawgemo', 'trent', 'valyn', 'BABYBAY', 'leaf'],
  T1: ['Meteor', 'stax', 'iZu', 'Munchkin', 'BuZz'],
};
function lineup(seed, swap = false) {
  const g2 = LINEUPS.G2.map((n, i) => vlrRow(n, 'G2', seed + i, 15, 5, 100 + i));
  const t1 = LINEUPS.T1.map((n, i) => vlrRow(n, 'T1', seed + 10 + i, 15, 5, 200 + i));
  return swap ? [...t1, ...g2] : [...g2, ...t1];
}
function vlrPage({ final = true, games, start = '2026-10-11 07:15:00', id = 754741, nav = [[283300, 1, 'Lotus'], [283301, 2, 'Abyss'], [283302, 3, 'Ascent']] } = {}) {
  return `<html><head><link rel="canonical" href="https://www.vlr.gg/${id}/g2-esports-vs-t1"></head><body>
  <div class="match-header-date"> <div class="moment-tz-convert" data-utc-ts="${start}"> Sunday </div> </div>
  <div class="match-header-vs"> <a class="match-header-link mod-1" href="/team/1"> <div class="match-header-link-name mod-1"> <div class="wf-title-med "> G2 Esports </div> </div> </a>
  <div class="match-header-vs-score"> <div class="match-header-vs-note"> ${final ? 'final' : 'live'} </div> <div class="match-header-vs-note"> Bo3 </div> </div>
  <a class="match-header-link mod-2" href="/team/2"> <div class="match-header-link-name mod-2"> <div class="wf-title-med "> T1 </div> </div> </a> </div>
  <div class="vm-stats-gamesnav"> <a href="/x/?game=all" class="vm-stats-gamesnav-item js-map-switch mod-all" data-game-id="all"> All Maps </a>
  ${nav.map(([g, n, m]) => `<a href="/x/?game=${g}" class="vm-stats-gamesnav-item js-map-switch " data-game-id="${g}" data-disabled="0"> <div> <span style="vertical-align: 4px;">${n}</span> ${m} </div> </a>`).join('\n')} </div>
  <div class="vm-stats-container"> ${games.join('\n')} </div></body></html>`;
}
// map 1 in the page's own order, then the "all" block and maps 2 and 3, as vlr.gg serves them
const G2T1 = vlrPage({ games: [
  vlrGame(283300, 'G2 Esports', 'T1', 13, 11, ['G2', 'T1'], lineup(10)),
  `<div class="vm-stats-game mod-active" data-game-id="all"> ${lineup(30).join('')} </div>`,
  // map 2's header lists T1 first: its scores and tags are flipped back to the match order
  vlrGame(283301, 'T1', 'G2 Esports', 13, 10, ['T1', 'G2'], lineup(20, true), 'Abyss'),
  vlrGame(283302, 'G2 Esports', 'T1', 13, 6, ['G2', 'T1'], lineup(5), 'Ascent'),
] });

test('vlr.gg match page: teams, start, maps by series number, players by team', () => {
  const p = vlrMatchPage(G2T1);
  assert.equal(p.id, '754741');
  assert.equal(p.start, Date.parse('2026-10-11T07:15:00Z'));
  assert.equal(p.final, true);
  assert.deepEqual(p.teams, [{ name: 'G2 Esports', tag: 'G2' }, { name: 'T1', tag: 'T1' }]);
  assert.deepEqual(p.maps.map(m => [m.number, m.name, m.score, m.done, m.players.length]),
    [[1, 'Ascent', [13, 11], true, 10], [2, 'Abyss', [10, 13], true, 10], [3, 'Ascent', [13, 6], true, 10]]);
  const leaf2 = p.maps[1].players.find(x => x.name === 'leaf');
  assert.deepEqual([leaf2.team, leaf2.kills, leaf2.deaths, leaf2.assists], [0, 24, 15, 5]);
  assert.equal(p.maps[1].players.find(x => x.name === 'BuZz').team, 1);
  assert.equal(vlrMapDone([13, 11]), true);
  assert.equal(vlrMapDone([13, 12]), false, 'overtime: not over until someone leads by two');
  assert.equal(vlrMapDone([14, 12]), true);
});

test('vlr.gg grade: the player within his team, maps by number', () => {
  const p = vlrMatchPage(G2T1);
  const pick = { player: 'leaf', team: 'G2', stat: 'kills', matchTitle: 'G2 vs T1' };
  const r = vlrGradeFromPage(p, pick);
  assert.deepEqual(r.maps, { 1: 14, 2: 24, 3: 9 });
  assert.equal(r.complete, true);
  // the full team name and a match title alone work too
  assert.deepEqual(vlrGradeFromPage(p, { ...pick, team: 'G2 Esports' }).maps, r.maps);
  assert.equal(vlrPickSide(p, { team: '', matchTitle: 'T1 vs G2 Esports' }), 2);
  assert.deepEqual(vlrGradeFromPage(p, { ...pick, team: '', matchTitle: 'T1 vs G2 Esports' }).maps, r.maps);
  assert.deepEqual(vlrGradeFromPage(p, { ...pick, stat: 'assists' }).maps, { 1: 5, 2: 5, 3: 5 });
});

test('vlr.gg grade: anything that does not match cleanly is ungradable, never a guess', () => {
  const p = vlrMatchPage(G2T1);
  // another match's team: not this match
  assert.equal(vlrGradeFromPage(p, { player: 'leaf', team: 'Sentinels', stat: 'kills' }), null);
  // a player listed on the other team: not him (DNP for G2's lineup)
  assert.match(vlrGradeFromPage(p, { player: 'stax', team: 'G2', stat: 'kills' }).unavailable, /did not play/);
  // vlr.gg counts no headshots
  assert.match(vlrGradeFromPage(p, { player: 'leaf', team: 'G2', stat: 'headshots' }).unavailable, /no headshots/);
  // two players with one handle in the match
  const dup = vlrMatchPage(vlrPage({ games: [vlrGame(1, 'G2 Esports', 'T1', 13, 3, ['G2', 'T1'], [...lineup(1).slice(0, 9), vlrRow('leaf', 'T1', 3, 3, 3, 9)])], nav: [[1, 1, 'Bind']] }));
  assert.match(vlrGradeFromPage(dup, { player: 'leaf', team: '', matchTitle: 'G2 vs T1', stat: 'kills' }).unavailable, /two players/);
  // a live match: maps in play are not done, nothing until it's final
  const live = vlrMatchPage(vlrPage({ final: false, games: [vlrGame(1, 'G2 Esports', 'T1', 9, 7, ['G2', 'T1'], lineup(1))], nav: [[1, 1, 'Bind']] }));
  assert.equal(vlrGradeFromPage(live, { player: 'jawgemo', team: 'G2', stat: 'kills' }), null);
});

test('vlr.gg results list → ids, teams, day', () => {
  const html = `<div class="wf-label mod-large"> Sun, October 11, 2026 </div><div class="wf-card">
    <a href="/754741/g2-esports-vs-t1" class="wf-module-item match-item mod-color"> <div class="match-item-vs-team-name"> <div class="text-of"> G2 Esports </div> </div>
    <div class="match-item-vs-team-name"> <div class="text-of"> T1 </div> </div> </a> </div>`;
  assert.deepEqual(vlrResultsList(html), [{ id: '754741', teams: ['G2 Esports', 'T1'], day: Date.parse('Sun, October 11, 2026') }]);
});

function fakeHttp(routes) {
  const calls = [];
  return { calls, async get(url) { calls.push(url); for (const [re, body] of routes) if (re.test(url)) return { data: typeof body === 'function' ? body() : body }; throw new Error('404 ' + url); } };
}
const RESULTS = `<div class="wf-label mod-large"> Sun, October 11, 2026 </div>
  <a href="/754741/g2-esports-vs-t1" class="wf-module-item match-item"> <div class="match-item-vs-team-name"> <div class="text-of"> G2 Esports </div> </div> <div class="match-item-vs-team-name"> <div class="text-of"> T1 </div> </div> </a>
  <a href="/754740/nrg-vs-100t" class="wf-module-item match-item"> <div class="match-item-vs-team-name"> <div class="text-of"> NRG </div> </div> <div class="match-item-vs-team-name"> <div class="text-of"> 100 Thieves </div> </div> </a>`;

test('Valorant grader: results list → match page → maps; wrong start or team finds nothing', async () => {
  const http = fakeHttp([[/results\/\?page=2/, ''], [/results/, RESULTS], [/vlr\.gg\/754741$/, G2T1]]);
  const grade = createValGrader(http, { pause: 0, now: () => Date.parse('2026-10-12T00:00:00Z') });
  const r = await grade({ player: 'leaf', team: 'G2', stat: 'kills', startTime: '2026-10-11T07:00:00Z', market: 'MAPS 1-2 Kills' });
  assert.deepEqual(r.maps, { 1: 14, 2: 24, 3: 9 });
  // the app listed it 10 hours off: not this match
  assert.equal(await grade({ player: 'leaf', team: 'G2', stat: 'kills', startTime: '2026-10-11T17:30:00Z' }), null);
  // NRG's player against this page: never fetched, nothing found
  assert.equal(await grade({ player: 'leaf', team: 'Sentinels', stat: 'kills', startTime: '2026-10-11T07:00:00Z' }), null);
  // a final page is kept: one fetch of it however many picks ask
  await grade({ player: 'trent', team: 'G2', stat: 'kills', startTime: '2026-10-11T07:00:00Z' });
  assert.equal(http.calls.filter(u => /754741$/.test(u)).length, 1);
});

test('tracker: Valorant rows parked for want of a grader are graded once one exists', async () => {
  const clock = { t: Date.parse('2026-10-14T12:00:00Z') };
  const store = createMemoryStore();
  const parseMapSpan = () => ({ count: 2, label: '1-2' });
  const pick = { sport: 'VAL', player: 'leaf', team: 'G2', market: 'MAPS 1-2 Kills', ppLine: 30.5, startTime: new Date(clock.t + HOUR).toISOString(), side: 'OVER', prob: 58, bestBook: 'PP', bestEv: 3 };
  const before = createTracker({ store, graders: {}, parseMapSpan, minEv: 0, now: () => clock.t, log: quiet });
  await before.recordBoard([pick]);
  clock.t += 2 * HOUR; await before.lockStarted();
  clock.t += 80 * HOUR; await before.gradeDue();
  assert.equal((await before.list())[0].status, 'review');
  assert.match((await before.list())[0].note, /No automatic grader for VAL/);
  const after = createTracker({ store, graders: { VAL: async () => ({ maps: { 1: 14, 2: 24 }, complete: true }) }, parseMapSpan, minEv: 0, now: () => clock.t, log: quiet });
  const res = await after.gradeDue();
  assert.equal(res.graded, 1);
  const row = (await after.list())[0];
  assert.equal(row.status, 'graded');
  assert.equal(row.result, 38);
  assert.equal(row.outcome, 'win');
});

// ── Pinnacle totals ──
const ladder = pts => pts.map(([line, p]) => ({ x: -line, p }));
function pinMatch(over = {}) {
  const ladders = new Map([
    ['kills|1|total', ladder([[27.5, 0.52], [28.5, 0.46], [26.5, 0.58]])],
    ['kills|1|tt|0', ladder([[14.5, 0.52]])],
    ['kills|1|tt|1', ladder([[13.5, 0.49]])],
    ['kills|2|total', ladder([[27.5, 0.5]])],
  ]);
  return { id: 77, game: 'LOL', league: 'LoL - Worlds', teams: ['Team WE', 'HANJIN BRION'], start: Date.parse('2026-10-15T09:00:00Z'), ladders, ...over };
}

test('ladder line: main line, 50/50 point between alternates, one-point fallback on the sd', () => {
  const l = T.ladderLine(ladder([[27.5, 0.52], [28.5, 0.46], [26.5, 0.58]]), 8.5);
  assert.equal(l.line, 27.5);
  assert.equal(l.p, 0.52);
  assert.ok(l.median > 27.5 && l.median < 28.5, `${l.median}`);
  const one = T.ladderLine(ladder([[14.5, 0.52]]), 6);
  assert.ok(Math.abs(one.median - (14.5 + 6 * 0.0502)) < 0.02, `${one.median}`);
  assert.equal(T.ladderLine([], 6), null);
});

test('observe: signal kept, close moves until the start, nothing after', () => {
  const rows = new Map();
  const t0 = Date.parse('2026-10-15T01:00:00Z');
  assert.equal(T.observe(rows, [pinMatch()], t0).length, 2);
  const id = 'LOL|77|1';
  assert.equal(rows.get(id).signal.total.line, 27.5);
  const moved = pinMatch();
  moved.ladders.set('kills|1|total', ladder([[29.5, 0.5]]));
  T.observe(rows, [moved], t0 + HOUR);
  assert.equal(rows.get(id).signal.total.line, 27.5);
  assert.equal(rows.get(id).close.total.line, 29.5);
  // after the start nothing is read (Pinnacle's live lines are skipped anyway)
  moved.ladders.set('kills|1|total', ladder([[35.5, 0.5]]));
  assert.equal(T.observe(rows, [moved], Date.parse('2026-10-15T09:05:00Z')).length, 0);
  assert.equal(rows.get(id).close.total.line, 29.5);
});

test('align and grade: orientation by name, map played or not, ungradable after give-up', () => {
  const rows = new Map();
  T.observe(rows, [pinMatch()], Date.parse('2026-10-15T01:00:00Z'));
  const [m1, m2] = [rows.get('LOL|77|1'), rows.get('LOL|77|2')];
  // the source lists the teams the other way round
  const found = { names: ['HANJIN BRION', 'Team WE'], start: Date.parse('2026-10-15T09:10:00Z'), complete: true, played: [1], maps: { 1: { teams: [11, 20] } } };
  const res = T.alignFound(m1, found);
  assert.deepEqual(res.maps[1], { total: 31, teams: [20, 11] });
  const now = Date.parse('2026-10-15T12:00:00Z');
  assert.equal(T.gradeRow(m1, res, now), true);
  assert.equal(m1.status, 'graded');
  assert.equal(T.gradeRow(m2, res, now), true);
  assert.equal(m2.status, 'not played');
  // a match with other teams or far from the start is no match
  assert.equal(T.alignFound(m1, { ...found, names: ['Team WE', 'T1'] }), null);
  assert.equal(T.alignFound(m1, { ...found, start: Date.parse('2026-10-16T09:00:00Z') }), null);
  // a map the series played with no numbers stays open until the give-up
  const r3 = { ...m1, status: 'open', map: 1 };
  assert.equal(T.gradeRow(r3, { complete: true, played: [1], maps: {} }, now), false);
  assert.equal(T.gradeRow(r3, null, Date.parse('2026-10-17T10:00:00Z')), true);
  assert.equal(r3.status, 'ungradable');
});

test('scoreboard and fit: assumed until enough maps, then the fitted team sd', () => {
  const rows = [];
  for (let i = 0; i < 60; i++) {
    const snap = { total: { line: 27.5, p: 0.5, median: 27.5 }, teams: [{ line: 14.5, p: 0.5, median: 14 }, { line: 13.5, p: 0.5, median: 13.5 }] };
    const e = (i % 2 ? 1 : -1) * (i % 3 === 0 ? 9 : 5);
    rows.push({ id: `LOL|${i}|1`, game: 'LOL', map: 1, status: 'graded', signal: snap, close: snap, actual: { total: 27.5 + e + 0.5, teams: [14 + e, 13.5 + 0.5] } });
  }
  const few = T.fitted(rows.slice(0, 20));
  assert.deepEqual(few.LOL, { teamSd: 6, n: 20, source: 'assumed' });
  const f = T.fitted(rows);
  assert.equal(f.LOL.source, 'fitted');
  assert.ok(f.LOL.teamSd > 3 && f.LOL.teamSd < 15);
  assert.equal(f.DOTA.source, 'assumed');
  assert.equal(f.CS2.kappa, 35);
  const sb = T.scoreboard([...rows, { game: 'LOL', status: 'not played' }, { game: 'LOL', status: 'open' }]);
  assert.equal(sb.LOL.maps, 60);
  assert.equal(sb.LOL.notPlayed, 1);
  assert.equal(sb.LOL.open, 1);
  assert.equal(sb.LOL.total.n, 60);
  assert.ok(sb.LOL.overShare >= 0 && sb.LOL.overShare <= 100);
  assert.equal(sb.LOL.pinOverShare, 50);
  assert.equal(sb.LOL.teams.n, 120);
});

test('fitKappa: recovers a tighter or looser spread of rounds', () => {
  // draw totals from the model at kappa 12 and at 150; the fit should land on the right side of 35
  const draw = (kappa, n, seed) => {
    const opt = { ...roundmodel.DEFAULTS, kappa: { ...roundmodel.DEFAULTS.kappa, CS2: kappa } };
    const d = roundmodel.rounds(0.5, 'CS2', opt);
    let s = seed; const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    const out = [];
    for (let i = 0; i < n; i++) { let u = rnd(), acc = 0; for (const [a, b, p] of d) { acc += p; if (u <= acc) { out.push({ q0: 0.5, total: a + b }); break; } } }
    return out;
  };
  assert.ok(T.fitKappa(draw(12, 400, 7), 'CS2') < 35);
  assert.ok(T.fitKappa(draw(150, 400, 11), 'CS2') > 35);
});

test('sources: bo3.gg rounds by map, OpenDota kills with sides swapped, lolesports team kills', () => {
  const bo3 = [{ slug: 'a-vs-b', status: 'finished', start_date: '2026-10-14T22:10:00Z', games: [
    { number: 1, winner_clan_name: 'JOGA DE TERNO', loser_clan_name: 'A NATA', winner_clan_score: 13, loser_clan_score: 6 },
    { number: 2, winner_clan_name: 'A NATA', loser_clan_name: 'JOGA DE TERNO', winner_clan_score: 16, loser_clan_score: 14 },
    { number: 3, winner_clan_name: null, loser_clan_name: null, winner_clan_score: null, loser_clan_score: null }] }];
  const f = T.bo3Found(bo3, ['A Nata', 'Joga de Terno'], Date.parse('2026-10-14T22:00:00Z'));
  assert.deepEqual(f.maps, { 1: { teams: [13, 6] }, 2: { teams: [14, 16] } });
  assert.deepEqual(f.played, [1, 2]);
  assert.deepEqual(T.alignFound({ teams: ['A Nata', 'Joga de Terno'], start: '2026-10-14T22:00:00Z' }, f).maps[2], { total: 30, teams: [16, 14] });

  const s = 1792011743;
  const od = [
    { match_id: 2, series_id: 9, series_type: 1, start_time: s + 3000, radiant_name: 'The Bot^$', dire_name: 'Pibbles Corp.', radiant_team_id: 2, radiant_score: 30, dire_score: 12, radiant_win: true },
    { match_id: 1, series_id: 9, series_type: 1, start_time: s, radiant_name: 'Pibbles Corp.', dire_name: 'The Bot^$', radiant_team_id: 1, radiant_score: 25, dire_score: 20, radiant_win: true },
  ];
  const d = T.dotaFound(od, ['Pibbles Corp.', 'The Bot^$'], s * 1000);
  assert.deepEqual(d.maps, { 1: { teams: [25, 20] }, 2: { teams: [12, 30] } });
  assert.equal(d.complete, false, '1-1 in a Bo3');

  const event = { id: 'e1', match: { strategy: { count: 5 }, teams: [{ id: 'A', name: 'Anubis Gaming', code: 'ANB', result: { gameWins: 1 } }, { id: 'S', name: 'Solary', code: 'SLY', result: { gameWins: 3 } }],
    games: [{ number: 1, id: 'g1', state: 'completed' }, { number: 2, id: 'g2', state: 'completed' }, { number: 5, id: 'g5', state: 'unneeded' }] } };
  const win = (blue, red, bk, rk) => ({ gameMetadata: { blueTeamMetadata: { esportsTeamId: blue }, redTeamMetadata: { esportsTeamId: red } }, frames: [{ gameState: 'finished', blueTeam: { totalKills: bk }, redTeam: { totalKills: rk } }] });
  const l = T.loleFound(event, new Map([['g1', win('A', 'S', 18, 24)], ['g2', win('S', 'A', 20, 9)]]));
  assert.deepEqual(l.maps, { 1: { teams: [18, 24] }, 2: { teams: [9, 20] } });
  assert.equal(l.complete, true);
  assert.deepEqual(l.played, [1, 2]);
  assert.equal(T.orient(['SLY', 'ANB'], l.codes), 'flip');
});

test('kill models take the fitted spread when given one', () => {
  const ctx = { game: 'CS2', kpr: 0.7, qs: [0.5, 0.5] };
  const base = roundmodel.sideProb(ctx, 30.5, 'OVER');
  const wide = roundmodel.sideProb({ ...ctx, kappa: 10 }, 30.5, 'OVER');
  assert.notEqual(base, wide);
  assert.equal(roundmodel.sideProb({ ...ctx, kappa: 35 }, 30.5, 'OVER'), base, 'kappa 35 is the default');
  const a = sharemodel.shareProb(4.5, 5.5, 'OVER', { game: 'LOL', share: 0.3, maps: 2 });
  const b = sharemodel.shareProb(4.5, 3.5, 'OVER', { game: 'LOL', share: 0.3, maps: 2 });
  const c = sharemodel.shareProb(4.5, 3.5, 'OVER', { game: 'LOL', share: 0.3, maps: 2, o: { teamSd: 10 } });
  assert.notEqual(a, null);
  assert.ok(c < b, 'a wider team total spreads the player more: less of an over at a line under his mean');
});

test('Valorant grader: an app tag the results list doesn\'t carry is found through the match title', async () => {
  const http = fakeHttp([[/results\/\?page=2/, ''], [/results/, RESULTS], [/vlr\.gg\/754741$/, G2T1]]);
  const grade = createValGrader(http, { pause: 0, now: () => Date.parse('2026-10-12T00:00:00Z') });
  // "T1" names the list's T1 anyway; a tag like "TONE" would not, the title's G2 side does
  const page = G2T1.replace(/title="T1"/g, 'title="TONE"').replace(/>T1</g, '>TONE<').replace(/ovw-player-tag ge-text-light">T1/g, 'ovw-player-tag ge-text-light">TONE');
  const http2 = fakeHttp([[/results\/\?page=2/, ''], [/results/, RESULTS], [/vlr\.gg\/754741$/, page]]);
  const grade2 = createValGrader(http2, { pause: 0, now: () => Date.parse('2026-10-12T00:00:00Z') });
  const r = await grade2({ player: 'stax', team: 'TONE', matchTitle: 'G2 Esports vs TONE', stat: 'kills', startTime: '2026-10-11T07:00:00Z' });
  assert.ok(r?.maps, JSON.stringify(r));
  assert.equal(await grade({ player: 'stax', team: 'TONE', stat: 'kills', startTime: '2026-10-11T07:00:00Z' }), null, 'no title: nothing to find it by');
});
