// esresearch.js: the pure parts of the esports prop research pages. Every
// number is counted from the inputs; nothing is projected.
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../esresearch');

// test fixtures (made up for the tests, not real results)
const lolRows = [
  // a Bo3 that went 2-1, newest
  { Link: 'Faker', Team: 'T1', Kills: '4', Deaths: '1', Assists: '7', Champion: 'Azir', Win: 'Yes', Team1: 'T1', Team2: 'Gen.G', MatchId: 'M3', GameN: '1', DateTime: '2026-10-20 10:00:00', Tournament: 'Worlds 2026' },
  { Link: 'Faker', Team: 'T1', Kills: '2', Deaths: '3', Assists: '5', Champion: 'Orianna', Win: 'No', Team1: 'Gen.G', Team2: 'T1', MatchId: 'M3', GameN: '2', DateTime: '2026-10-20 11:00:00', Tournament: 'Worlds 2026' },
  { Link: 'Faker', Team: 'T1', Kills: '6', Deaths: '0', Assists: '4', Champion: 'Ahri', Win: 'Yes', Team1: 'T1', Team2: 'Gen.G', MatchId: 'M3', GameN: '3', DateTime: '2026-10-20 12:00:00', Tournament: 'Worlds 2026' },
  // a 2-0
  { Link: 'Faker', Team: 'T1', Kills: '5', Deaths: '2', Assists: '6', Champion: 'Sylas', Win: 'Yes', Team1: 'T1', Team2: 'BLG', MatchId: 'M2', GameN: '1', DateTime: '2026-10-15 10:00:00', Tournament: 'Worlds 2026' },
  { Link: 'Faker', Team: 'T1', Kills: '3', Deaths: '1', Assists: '8', Champion: 'Taliyah', Win: 'Yes', Team1: 'BLG', Team2: 'T1', MatchId: 'M2', GameN: '2', DateTime: '2026-10-15 11:00:00', Tournament: 'Worlds 2026' },
  // a 0-2 against Gen.G
  { Link: 'Faker', Team: 'T1', Kills: '1', Deaths: '4', Assists: '2', Champion: 'Azir', Win: 'No', Team1: 'Gen.G', Team2: 'T1', MatchId: 'M1', GameN: '1', DateTime: '2026-10-10 10:00:00', Tournament: 'LCK' },
  { Link: 'Faker', Team: 'T1', Kills: '2', Deaths: '5', Assists: '1', Champion: 'Corki', Win: 'No', Team1: 'T1', Team2: 'Gen.G', MatchId: 'M1', GameN: '2', DateTime: '2026-10-10 11:00:00', Tournament: 'LCK' },
  // another player by the same name, on another team
  { Link: 'Faker (Other Person)', Team: 'Amateur Five', Kills: '20', Deaths: '0', Assists: '0', Champion: 'Zed', Win: 'Yes', Team1: 'Amateur Five', Team2: 'X', MatchId: 'Z1', GameN: '1', DateTime: '2026-10-25 10:00:00', Tournament: 'Minor' },
];

test('lolMaps: the player on the board\'s team, each map with its opponent and result', () => {
  const { maps, link, links } = R.lolMaps(lolRows.map(r => ({ title: r })), 'T1');
  assert.equal(link, 'Faker');
  assert.equal(links.length, 2);
  assert.equal(maps.length, 7);
  assert.deepEqual(maps[0], { mid: 'M3', n: 3, t: Date.parse('2026-10-20T12:00:00Z'), team: 'T1', opp: 'Gen.G', win: true, k: 6, d: 0, a: 4, champ: 'Ahri', league: 'Worlds 2026' });
  assert.equal(maps.find(m => m.mid === 'M2' && m.n === 2).opp, 'BLG');
  // without a team: the one who played last
  assert.equal(R.lolMaps(lolRows, '').link, 'Faker (Other Person)');
});

test('lolQuery refuses names Cargo would read as SQL', () => {
  assert.match(R.lolQuery('Faker').where, /SP\.Link = 'Faker' OR SP\.Link LIKE 'Faker \(%'/);
  assert.equal(R.lolQuery("x' OR 1=1 --"), null);
  assert.equal(R.lolQuery(''), null);
});

test('seriesTotals: Maps 1-2 sums both maps; Maps 1-3 counts a 2-0 on the maps played, marked short', () => {
  const { maps } = R.lolMaps(lolRows, 'T1');
  const two = R.seriesTotals(maps, 'k|1-2');
  assert.deepEqual(two.map(s => [s.mid, s.value, s.short, s.won]), [['M3', 6, false, true], ['M2', 8, false, true], ['M1', 3, false, false]]);
  const three = R.seriesTotals(maps, 'k|1-3');
  // a 2-0 either way never plays map 3: both count on the two maps played
  assert.deepEqual(three.map(s => [s.mid, s.value, s.maps, s.short]), [['M3', 12, 3, false], ['M2', 8, 2, true], ['M1', 3, 2, true]]);
  // a series missing a map that was played (a gap in the source) is left out
  assert.deepEqual(R.seriesTotals(maps.filter(m => !(m.mid === 'M3' && m.n === 2)), 'k|1-3').map(s => s.mid), ['M2', 'M1']);
  assert.deepEqual(R.seriesTotals(maps, 'ast|1').map(s => s.value), [7, 6, 2]);
  // a stat the map log doesn't carry: nothing
  assert.deepEqual(R.seriesTotals(maps, 'hs|1-2'), []);
});

test('hitRates: over, under and push in each window, newest first', () => {
  const w = R.hitRates([10, 6, 8, 8, 3, 12], 7.5, [3, 10, null]);
  assert.deepEqual(w[0], { window: 3, n: 3, full: true, over: 2, under: 1, push: 0, avg: 8, median: 8 });
  assert.equal(w[1].full, false);
  assert.equal(w[1].n, 6);
  assert.deepEqual(R.hitRates([8, 8, 9], 8, [null])[0].push, 2);
  assert.deepEqual(R.hitRates([], 7.5, [5])[0], { window: 5, n: 0, full: false, over: 0, under: 0, push: 0, avg: null, median: null });
});

test('byMapNumber: average, low and high on each map', () => {
  const { maps } = R.lolMaps(lolRows, 'T1');
  assert.deepEqual(R.byMapNumber(maps, 'k'), [{ map: 1, n: 3, avg: 3.3, min: 1, max: 5 }, { map: 2, n: 3, avg: 2.3, min: 2, max: 3 }, { map: 3, n: 1, avg: 6, min: 6, max: 6 }]);
});

test('dotaMaps: OpenDota series ids group games; games without one join by time and opponent', () => {
  const rows = [
    { match_id: 1, start_time: 1000, series_id: 77, radiant_win: true, player_slot: 1, kills: 9, deaths: 2, assists: 10, radiant_name: 'Team Spirit', dire_name: 'Tundra', league_name: 'TI' },
    { match_id: 2, start_time: 4000, series_id: 77, radiant_win: true, player_slot: 130, kills: 3, deaths: 6, assists: 8, radiant_name: 'Tundra', dire_name: 'Team Spirit', league_name: 'TI' },
    { match_id: 3, start_time: 90000, series_id: 0, radiant_win: false, player_slot: 2, kills: 5, deaths: 5, assists: 5, radiant_name: 'Team Spirit', dire_name: 'Falcons', league_name: 'Riyadh' },
    { match_id: 4, start_time: 93000, series_id: 0, radiant_win: false, player_slot: 2, kills: 7, deaths: 1, assists: 5, radiant_name: 'Team Spirit', dire_name: 'Falcons', league_name: 'Riyadh' },
  ];
  const { maps } = R.dotaMaps(rows);
  assert.equal(maps.length, 4);
  const s77 = maps.filter(m => m.mid === 's77').sort((a, b) => a.n - b.n);
  assert.deepEqual(s77.map(m => [m.n, m.team, m.opp, m.win, m.k]), [[1, 'Team Spirit', 'Tundra', true, 9], [2, 'Team Spirit', 'Tundra', false, 3]]);
  const loose = maps.filter(m => m.mid === 'm3');
  assert.deepEqual(loose.map(m => m.n).sort(), [1, 2]);
  assert.deepEqual(R.seriesTotals(maps, 'k|1-2').map(s => s.value), [12, 12]);
  assert.equal(R.dotaPlayerSql('1; DROP'), null);
  assert.match(R.dotaPlayerSql(123), /pm\.account_id = 123 /);
});

const board = [
  { key: 'LOL|faker|k|1-2|a', sport: 'LOL', esports: true, player: 'Faker', team: 'T1', mkey: 'k|1-2', market: 'Kills on Maps 1+2', startTime: '2026-10-29T10:00:00Z', matchTitle: 'T1 vs Gen.G',
    books: { underdog: { line: 7.5, overOpen: true, underOpen: true }, prizepicks: { line: 7.5 }, sleeper: { line: 8, overOpen: true, underOpen: false } } },
  { key: 'LOL|faker|ast|1-2|a', sport: 'LOL', esports: true, player: 'Faker', team: 'T1', mkey: 'ast|1-2', market: 'Assists on Maps 1+2', startTime: '2026-10-29T10:00:00Z', matchTitle: 'T1 vs Gen.G', books: { underdog: { line: 11.5 } } },
  { key: 'NBA|lebron|pts', sport: 'NBA', esports: false, player: 'LeBron James', mkey: 'pts', books: { underdog: { line: 25.5 } } },
];

test('boardPlayers: one entry per esports player, each market with every app\'s line', () => {
  const ps = R.boardPlayers(board);
  assert.equal(ps.length, 1);
  const p = ps[0];
  assert.equal(p.key, 'LOL|faker');
  assert.equal(p.opponent, 'Gen.G');
  assert.deepEqual(p.markets.map(m => m.mkey), ['k|1-2', 'ast|1-2']);
  assert.deepEqual(p.markets[0].lines, [{ app: 'PP', line: 7.5, overOpen: true, underOpen: true }, { app: 'UD', line: 7.5, overOpen: true, underOpen: true }, { app: 'SL', line: 8, overOpen: true, underOpen: false }]);
  assert.deepEqual(R.currentLines(p.markets[0]), [{ line: 7.5, apps: ['PP', 'UD'] }, { line: 8, apps: ['SL'] }]);
});

const recRows = [
  { sport: 'LOL', player: 'Faker', team: 'T1', matchTitle: 'T1 vs Gen.G', market: 'Kills on Maps 1+2', startTime: '2026-10-20T10:00:00Z', status: 'graded', result: 6, signalBook: 'UD', signalLine: 7.5, closeLine: 6.5, signalLines: { UD: 7.5, PP: 7.5 }, closeLines: { UD: 6.5, PP: 7 } },
  // the same match in a second record: lines join, one entry
  { sport: 'LOL', player: 'Faker', team: 'T1', matchTitle: 'T1 vs Gen.G', market: 'MAPS 1-2 Kills', startTime: '2026-10-20T10:05:00Z', status: 'graded', result: 6, appKey: 'SL', signalBook: 'SL', signalLine: 8, closeLine: 8 },
  { sport: 'LOL', player: 'Faker', team: 'T1', matchTitle: 'BLG vs T1', market: 'Kills on Maps 1+2', startTime: '2026-10-15T10:00:00Z', status: 'graded', result: 8, signalLines: { UD: 6.5 }, closeLines: { UD: 6.5 } },
  { sport: 'LOL', player: 'Faker', team: 'T1', matchTitle: 'T1 vs HLE', market: 'Kills on Maps 1+2', startTime: '2026-10-12T10:00:00Z', status: 'locked', result: null, signalLines: { UD: 7 }, closeLines: { UD: 7 } },
  { sport: 'CS', player: 'ZywOo', team: 'Vitality', matchTitle: 'Vitality vs MOUZ', market: 'Kills on Maps 1+2', startTime: '2026-10-21T10:00:00Z', status: 'graded', result: 41, signalLines: { UD: 38.5 }, closeLines: { UD: 39.5 } },
  { sport: 'CS', player: 'ZywOo', team: 'Vitality', matchTitle: 'Vitality vs G2', market: 'Kills on Maps 1+2', startTime: '2026-10-19T10:00:00Z', status: 'graded', result: 33, note: null, signalLines: { PP: 38 }, closeLines: { PP: 38 } },
  { sport: 'NBA', player: 'x', market: 'Points', startTime: '2026-10-19T10:00:00Z', status: 'graded', result: 3 },
];

test('buildRecordIndex: one entry per player, market and match, lines joined across records', () => {
  const { players, entries } = R.buildRecordIndex(recRows);
  assert.equal(entries, 5);
  const f = players.get('LOL|faker');
  assert.equal(f.length, 3);
  assert.deepEqual(f[0].first, { UD: 7.5, PP: 7.5, SL: 8 });
  assert.deepEqual(f[0].last, { UD: 6.5, PP: 7, SL: 8 });
  assert.equal(f[0].opponent, 'Gen.G');
  assert.equal(f[2].result, null);
});

test('research: LoL hit rate from the map log, splits, and the line history from our records', () => {
  const bp = R.boardPlayers(board)[0];
  const records = R.buildRecordIndex(recRows).players.get('LOL|faker');
  const log = { status: 'ok', source: 'Leaguepedia', at: Date.parse('2026-10-28T12:00:00Z'), ...R.lolMaps(lolRows, 'T1') };
  const d = R.research({ game: 'LOL', player: 'Faker', board: bp, records, log, now: Date.parse('2026-10-28T12:00:00Z') });
  assert.equal(d.market, 'k|1-2');
  assert.equal(d.hitFrom, 'maps');
  const at75 = d.hit.find(h => h.line === 7.5);
  assert.deepEqual(at75.apps, ['PP', 'UD']);
  // series totals 6, 8, 3 against 7.5
  assert.deepEqual(at75.windows.find(w => w.window == null), { window: null, n: 3, full: true, over: 1, under: 2, push: 0, avg: 5.7, median: 6 });
  const vsGen = at75.splits.find(s => s.label === 'vs Gen.G');
  assert.equal(vsGen.n, 2);
  assert.equal(vsGen.over, 0);
  assert.equal(at75.splits.find(s => s.label === 'Series his team won').n, 2);
  assert.equal(d.records.length, 3);
  // each app's last line against his result: UD 6.5 → 6 under, 6.5 → 8 over
  assert.deepEqual(d.vsPosted.find(v => v.app === 'UD'), { app: 'UD', n: 2, over: 1, under: 1, push: 0 });
  assert.match(d.note, /Research, not a bet/);
  // the assists market reads the same map log
  const a = R.research({ game: 'LOL', player: 'Faker', board: bp, records, log, mkey: 'ast|1-2' });
  assert.deepEqual(a.series.map(s => s.value), [12, 14, 3]);
});

test('research: CS2 uses our records only, and says so', () => {
  const records = R.buildRecordIndex(recRows).players.get('CS|zywoo');
  const d = R.research({ game: 'CS', player: 'ZywOo', records, now: Date.parse('2026-10-28T12:00:00Z') });
  assert.equal(d.source.maps, null);
  assert.match(d.source.note, /no free per-map stats source/);
  assert.equal(d.lines.length, 0, 'not on the board: no current line');
  assert.deepEqual(d.markets.map(m => [m.mkey, m.recordOnly]), [['k|1-2', true]]);
  assert.equal(d.records.length, 2);
  // with a current line, the hit rate comes from the graded records
  const withLine = R.research({ game: 'CS', player: 'ZywOo', records, board: { player: 'ZywOo', markets: [{ mkey: 'k|1-2', label: 'Kills, Maps 1-2', lines: [{ app: 'UD', line: 37.5 }] }] }, now: Date.parse('2026-10-28T12:00:00Z') });
  assert.equal(withLine.hitFrom, 'records');
  assert.deepEqual(withLine.hit[0].windows.find(w => w.window == null).over, 1);
});

test('pages: labelled research, no dead links, escaped names', () => {
  const bp = R.boardPlayers(board)[0];
  const records = R.buildRecordIndex(recRows).players.get('LOL|faker');
  const log = { status: 'ok', source: 'Leaguepedia', at: Date.now(), ...R.lolMaps(lolRows, 'T1') };
  const d = R.research({ game: 'LOL', player: 'Faker', board: bp, records, log });
  const html = R.playerPage(d);
  assert.match(html, /RESEARCH · NOT A BET/);
  assert.match(html, /Hit rate against the current line/);
  assert.match(html, /Leaguepedia \(Faker\)/);
  assert.match(html, /<svg/);
  assert.doesNotMatch(html, /href="#"/);
  const idx = R.indexPage({ players: [bp], counts: { 'LOL|faker': 3 } });
  assert.match(idx, /RESEARCH · NOT A BET/);
  assert.match(idx, /3 in our records/);
  assert.match(idx, />LOL 1<\/a>/);
  assert.match(idx, /href="\/esports\/research\/LOL\/Faker"/);
  const evil = R.indexPage({ players: [{ ...bp, player: '<script>x</script>' }], counts: {} });
  assert.doesNotMatch(evil, /<script>x/);
  const err = R.playerPage(R.research({ game: 'LOL', player: 'Faker', board: bp, records, log: { status: 'error', error: 'HTTP 429', maps: [] } }));
  assert.match(err, /lolesports\.com and Leaguepedia didn't answer \(HTTP 429\)/);
  assert.match(err, /Each value is his graded result on this market in our records/);
});

test('createMapLogs: one read per player, cached, failures kept briefly, queue refuses past its cap', async () => {
  let t = 0, calls = 0;
  const logs = R.createMapLogs({ now: () => t, sleep: async () => {}, gapMs: { LOL: 0 }, maxQueue: 2, failTtlMs: 100, okTtlMs: 1000,
    fetchers: { LOL: async p => { calls++; if (p === 'bad') throw Object.assign(new Error('x'), { response: { status: 429 } }); return { maps: [{ mid: 'a', n: 1, t: 1, k: 3 }], link: p }; } } });
  const [a, b] = await Promise.all([logs.get('LOL', 'Faker'), logs.get('LOL', 'faker')]);
  assert.equal(a.status, 'ok');
  assert.equal(a, b);
  assert.equal(calls, 1);
  await logs.get('LOL', 'Faker');
  assert.equal(calls, 1);
  const bad = await logs.get('LOL', 'bad');
  assert.deepEqual([bad.status, bad.error], ['error', 'HTTP 429']);
  await logs.get('LOL', 'bad');
  assert.equal(calls, 2);
  t = 200;
  await logs.get('LOL', 'bad');
  assert.equal(calls, 3, 'a failure is read again after its short wait');
  assert.equal((await logs.get('CS', 'x')).status, 'unsupported');
  const many = await Promise.all(['p1', 'p2', 'p3', 'p4'].map(p => logs.get('LOL', p)));
  assert.equal(many.filter(x => x.status === 'busy').length, 2);
  assert.equal(logs.stats().refused, 2);
});

test('lolesports: a team\'s last matches, each finished game\'s lines, the player found by his tag', async () => {
  const sched = { data: { schedule: { events: [
    { type: 'match', state: 'completed', startTime: '2026-10-20T10:00:00Z', league: { name: 'Worlds' }, match: { id: 'E2', teams: [{ name: 'T1', code: 'T1', result: { outcome: 'win' } }, { name: 'Gen.G', code: 'GEN', result: { outcome: 'loss' } }] } },
    { type: 'match', state: 'completed', startTime: '2026-10-18T10:00:00Z', league: { name: 'Worlds' }, match: { id: 'E9', teams: [{ name: 'BLG', code: 'BLG' }, { name: 'TES', code: 'TES' }] } },
    { type: 'match', state: 'unstarted', startTime: '2026-10-29T10:00:00Z', league: { name: 'Worlds' }, match: { id: 'E3', teams: [{ name: 'T1', code: 'T1' }, { name: 'KOI', code: 'KOI' }] } },
  ], pages: {} } } };
  const frame = (k1, k2) => ({ gameMetadata: { blueTeamMetadata: { participantMetadata: [{ participantId: 1, summonerName: 'T1 Faker', championId: 'Azir' }] }, redTeamMetadata: { participantMetadata: [{ participantId: 6, summonerName: 'GEN Chovy', championId: 'Ahri' }] } },
    frames: [{ gameState: 'finished', blueTeam: { participants: [{ participantId: 1, kills: k1, deaths: 1, assists: 6 }] }, redTeam: { participants: [{ participantId: 6, kills: k2, deaths: 3, assists: 2 }] } }] });
  const calls = [];
  const http = { get: async (url, { params }) => {
    calls.push(url);
    if (url.endsWith('/getSchedule')) return { data: sched };
    if (url.endsWith('/getEventDetails')) return { data: { data: { event: { match: { games: [{ id: 'G1', number: 1, state: 'completed' }, { id: 'G2', number: 2, state: 'completed' }, { id: 'G3', number: 3, state: 'unneeded' }] } } } } };
    if (url.endsWith('/G1')) return { data: frame(4, 2) };
    if (url.endsWith('/G2')) return { data: frame(5, 1) };
    throw new Error('unexpected ' + url + JSON.stringify(params));
  } };
  const log = R.createLolesportsLog(http, { LOLE_API: 'https://api', LOLE_FEED: 'https://feed', LOLE_HEADERS: { 'User-Agent': 'x' } }, { pause: 0, sleep: async () => {} });
  const { maps } = await log('Faker', 'T1');
  assert.deepEqual(maps.map(m => [m.n, m.opp, m.k, m.a, m.champ, m.sw, m.league]), [[2, 'Gen.G', 5, 6, 'Azir', true, 'Worlds'], [1, 'Gen.G', 4, 6, 'Azir', true, 'Worlds']]);
  assert.deepEqual(R.seriesTotals(maps, 'k|1-2').map(s => [s.value, s.won]), [[9, true]]);
  // the opponent's player from the same games, no new game reads
  const n = calls.length;
  const chovy = await log('Chovy', 'Gen.G');
  assert.deepEqual(chovy.maps.map(m => m.k), [1, 2]);
  assert.equal(calls.filter((u, i) => i >= n && /\/G\d$/.test(u)).length, 0);
  assert.equal(R.loleNameIs('BLG knight', 'knight'), true);
  assert.equal(R.loleNameIs('Faker', 'Fak'), false);
});

test('lolChain: the next source when the first has nothing, the error only when all fail', async () => {
  const ok = R.lolChain(['A', async () => ({ maps: [] })], ['B', async () => ({ maps: [{ mid: 'x', n: 1 }] })]);
  assert.equal((await ok('p', 't')).source, 'B');
  const bad = R.lolChain(['A', async () => ({ maps: [] })], ['B', async () => { throw new Error('rate limit'); }]);
  await assert.rejects(bad('p', 't'), /rate limit/);
});

test('fetchDotaMaps: his own match list when the explorer has none of his games, and the page says so', async () => {
  const http = { get: async url => {
    if (url.endsWith('/explorer')) return { data: { rows: [] } };
    if (url.endsWith('/players/42/matches')) return { data: [{ match_id: 9, start_time: 5000, player_slot: 1, radiant_win: true, kills: 11, deaths: 2, assists: 9 }, { match_id: 8, start_time: 1000, player_slot: 1, radiant_win: false, kills: 4, deaths: 6, assists: 3 }] };
    throw new Error(url);
  } };
  const r = await R.fetchDotaMaps(http, 42);
  assert.deepEqual(r.maps.map(m => [m.mid, m.n, m.k]), [['m8', 2, 11], ['m8', 1, 4]]);
  assert.match(r.note, /names no teams/);
  const d = R.research({ game: 'DOTA', player: 'Yatoro', board: { player: 'Yatoro', markets: [{ mkey: 'k|1-2', label: 'Kills, Maps 1-2', lines: [{ app: 'UD', line: 14.5 }] }] }, log: { status: 'ok', source: 'OpenDota', at: Date.now(), ...r } });
  assert.deepEqual(d.series.map(s => s.value), [15]);
  assert.match(R.playerPage(d), /names no teams/);
});

test('buildRecordIndex: a code and a full name on the same day are one match', () => {
  const rows = [
    { sport: 'LOL', player: 'Quid', team: 'Team Liquid', matchTitle: "Team Liquid vs Anyone's Legend", market: 'Kills on Maps 1+2', startTime: '2026-10-26T10:00:00Z', status: 'graded', result: 3, signalLines: { UD: 6.5 }, closeLines: { UD: 6.5 } },
    { sport: 'LOL', player: 'Quid', team: 'TL', opponent: 'AL', market: 'MAPS 1-2 Kills', startTime: '2026-10-26T10:00:00Z', status: 'graded', result: 3, signalLines: { PP: 6 }, closeLines: { PP: 6 } },
  ];
  const f = R.buildRecordIndex(rows).players.get('LOL|quid');
  assert.equal(f.length, 1);
  assert.deepEqual(f[0].last, { UD: 6.5, PP: 6 });
});
