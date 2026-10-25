const test = require('node:test');
const assert = require('node:assert');
const L = require('../playerlog');
const fx = require('./fixtures/espn-box.json');

// a fixture box as ESPN's summary carries it: header competitors with home/away and scores
function summary(sport, { home = 0, scores = [100, 90] } = {}) {
  const ev = JSON.parse(JSON.stringify(fx[sport].event));
  const comp = ev.competitions[0];
  comp.competitors.forEach((c, i) => { c.homeAway = i === home ? 'home' : 'away'; c.score = String(scores[i]); });
  comp.date = ev.date;
  return { header: { id: ev.id, competitions: [comp] }, boxscore: fx[sport].box };
}

test('an ESPN summary parses into players with every stat the record grades, plus usage', () => {
  const g = L.parseGame('NBA', summary('NBA'));
  assert.ok(g && g.players.length > 5);
  const pb = g.players.find(p => p.k === 'paolobanchero');
  assert.strictEqual(pb.s.points, 24);
  assert.strictEqual(pb.s.pra, 35);
  assert.strictEqual(pb.tm, 'ORL');
  assert.strictEqual(pb.ul, 'min');
  assert.ok(pb.u > 0);
  // fantasy score: points + 1.2 reb + 1.5 ast + 3 blk + 3 stl - TO
  const s = pb.s;
  const fs = Math.round((s.points + 1.2 * s.rebounds + 1.5 * s.assists + 3 * s.blocks + 3 * s.steals - s.turnovers) * 10) / 10;
  assert.strictEqual(s.fantasy_score, fs);

  const nfl = L.parseGame('NFL', summary('NFL'));
  const allen = nfl.players.find(p => p.k === 'joshallen');
  assert.strictEqual(allen.s.pass_yds, 210);
  assert.strictEqual(allen.s.rush_yds, 121);
  assert.strictEqual(allen.ul, 'opp');
  // defenders with no offensive line don't make the log
  assert.ok(nfl.players.every(p => Object.keys(p.s).length));

  const nhl = L.parseGame('NHL', summary('NHL'));
  const sk = nhl.players.find(p => p.ul === 'toi' && p.s.shots_on_goal != null);
  assert.ok(sk && sk.u > 1 && sk.u < 40, 'time on ice in minutes');
  const mlb = L.parseGame('MLB', summary('MLB'));
  assert.ok(mlb.players.some(p => p.ul === 'pitches') && mlb.players.some(p => p.ul === 'pa'));
});

// synthetic history for the store's logic (made up for the test, never shown live)
function game(id, t, home, away, players, scores = [110, 100]) {
  return { id, t, sport: 'NBA', teams: [{ abbr: home, name: home + ' City', home: true, score: scores[0] }, { abbr: away, name: away + ' Town', home: false, score: scores[1] }], players };
}
const DAY = 86400e3;
const NOW = Date.UTC(2026, 10, 20);

test('the store keys players by athlete id: two namesakes stay apart, the row\'s team picks one', () => {
  const log = L.createPlayerLog({ now: () => NOW });
  for (let i = 0; i < 12; i++) {
    log.addGame(game(`g${i}`, NOW - (12 - i) * DAY, i % 2 ? 'AAA' : 'BBB', i % 2 ? 'BBB' : 'CCC', [
      { id: '1', k: 'johnsmith', n: 'John Smith', tm: i % 2 ? 'AAA' : 'BBB', s: { points: 10 + i }, u: 30, ul: 'min' },
    ]));
  }
  log.addGame(game('z', NOW - DAY / 2, 'ZZZ', 'YYY', [{ id: '2', k: 'johnsmith', n: 'John Smith', tm: 'ZZZ', s: { points: 2 }, u: 8, ul: 'min' }]));
  const a = log.resolve({ sport: 'NBA', player: 'John Smith', team: 'ZZZ' });
  assert.deepStrictEqual(a, { id: '2', ambiguous: false });
  const b = log.resolve({ sport: 'NBA', player: 'John Smith', team: 'BBB' });
  assert.strictEqual(b.id, '1');
  // no team at all: the most recent one, flagged
  assert.strictEqual(log.resolve({ sport: 'NBA', player: 'John Smith' }).ambiguous, true);
});

test('hit rates at each app line: last 5/10/20, season, home/away and vs tonight\'s opponent', () => {
  const log = L.createPlayerLog({ now: () => NOW });
  // 12 games this season (points 10..21), home every other game, vs CCC on the even ones
  for (let i = 0; i < 12; i++) {
    const home = i % 2 === 0;
    log.addGame(game(`g${i}`, NOW - (12 - i) * DAY, home ? 'AAA' : (i % 4 === 1 ? 'CCC' : 'DDD'), home ? (i % 4 === 0 ? 'CCC' : 'DDD') : 'AAA', [
      { id: '7', k: 'pat', n: 'Pat', tm: 'AAA', s: { points: 10 + i }, u: 20 + i, ul: 'min' },
    ]));
  }
  // one from last season (before Oct 1)
  log.addGame(game('old', Date.UTC(2026, 3, 1), 'AAA', 'CCC', [{ id: '7', k: 'pat', n: 'Pat', tm: 'AAA', s: { points: 40 }, u: 36, ul: 'min' }]));
  const row = { key: 'NBA|pat|points', sport: 'NBA', player: 'Pat', team: 'AAA', mkey: 'points', market: 'Points', matchTitle: 'CCC @ AAA',
    books: { prizepicks: { line: 15.5 }, underdog: { line: 16.5 } }, startTime: new Date(NOW + 3600e3).toISOString() };
  const p = log.page(row);
  assert.strictEqual(p.games, 13);
  assert.strictEqual(p.seasonGames, 12);
  assert.deepStrictEqual(p.lines, [15.5, 16.5]);
  assert.strictEqual(p.opponent, 'CCC');
  assert.strictEqual(p.homeTonight, true);
  const h = p.hits[0];
  // last 5: 17..21 all over 15.5
  assert.deepStrictEqual([h.l5.over, h.l5.under, h.l5.pct], [5, 0, 100]);
  // last 10: 12..21 → 16..21 over (6), 12..15 under (4)
  assert.deepStrictEqual([h.l10.over, h.l10.n], [6, 10]);
  // season leaves out last season's 40
  assert.deepStrictEqual([h.season.over, h.season.n], [6, 12]);
  assert.strictEqual(h.home.n + h.away.n, 12);
  // vs CCC: this season's even games plus last season's 40
  assert.ok(h.vs.n >= 4);
  assert.strictEqual(p.log[0].v, 21);
  assert.strictEqual(p.log[p.log.length - 1].season, 'prev');
  assert.strictEqual(p.usage.kind, 'min');
  assert.strictEqual(p.usage.l5, 29);
  // the board's two columns at one line, cached
  const bh = log.boardHits(row, 15.5);
  assert.deepStrictEqual(bh, { l10: 60, l10n: 10, szn: 50, sznN: 12, games: 13 });
  assert.strictEqual(log.boardHits(row, 15.5), bh);
  // pushes on a whole number line are counted apart and left out of the %
  const t = log.tally([3, 4, 4, 5], 4);
  assert.deepStrictEqual(t, { over: 1, under: 1, push: 2, n: 4, pct: 50 });
  // a stat the box score doesn't carry
  assert.strictEqual(log.page({ ...row, mkey: '1q|points' }).unsupported, true);
});

test('refresh reads scoreboards newest day first, skips preseason, and marks finished days', async () => {
  const sum = summary('NBA');
  const calls = [];
  const http = { get: async (url, { params }) => {
    calls.push(url.split('/').pop() + ':' + (params.dates || params.event));
    if (url.endsWith('/scoreboard')) {
      if (params.dates === '20261119') return { data: { events: [{ id: 'A', date: '2026-11-19T23:00Z', status: { type: { completed: true } }, season: { type: 2 } },
        { id: 'P', date: '2026-11-19T20:00Z', status: { type: { completed: true } }, season: { type: 1 } }] } };
      return { data: { events: [] } };
    }
    return { data: sum };
  } };
  const log = L.createPlayerLog({ http, gapMs: 0, now: () => NOW, wanted: () => new Set(['NBA']), maxPerRun: 30 });
  const r = await log.refresh();
  assert.strictEqual(r.NBA.added, 1);
  assert.strictEqual(calls[0], 'scoreboard:20261119');
  assert.ok(!calls.includes('summary:P'), 'preseason not read');
  assert.ok(log.status().games === 1);
  // the second run lists only today and yesterday again (older days were final)
  calls.length = 0;
  await log.refresh();
  assert.ok(calls.filter(c => c.startsWith('scoreboard')).length <= 3 + 30, 'bounded');
  assert.ok(!calls.includes('summary:A'), 'a game is read once');
});

test('the NBA and CFB models\' histories plug in as the log for their league', () => {
  const H = { players: new Map([['luka', [{ t: NOW - DAY, gid: 'x', team: 'LAL', opp: 'GS', home: true, min: 36.2, points: 30, rebounds: 8, assists: 9, threes: 4, steals: 1, blocks: 0, turnovers: 4 }]]]) };
  const log = L.createPlayerLog({ now: () => NOW });
  L.attachNbaModel(log, { history: () => H });
  const row = { key: 'k', sport: 'NBA', player: 'Luka', team: 'LAL', mkey: 'pra', market: 'PRA', matchTitle: 'GSW @ LAL', books: { prizepicks: { line: 45.5 } } };
  const p = log.page(row);
  assert.strictEqual(p.source, 'model');
  assert.strictEqual(p.log[0].v, 47);
  assert.strictEqual(p.log[0].u, 36.2);
  // the apps' GSW is ESPN's GS
  assert.strictEqual(p.hits[0].vs.n, 1);
  const C = { players: new Map([['99', [{ t: NOW - DAY, team: 'TEX', opp: 'OU', pa: 30, pc: 20, py: 250, ptd: 2, pint: 1, ra: 5, ry: 20, rtd: 0, rushlong: 9 }]]]), names: new Map([['arch', new Set(['99'])]]) };
  L.attachCfbModel(log, { history: () => C });
  const cp = log.page({ key: 'c', sport: 'CFB', player: 'Arch', team: 'TEX', mkey: 'pass_rush_yds', market: 'Pass+Rush Yds', books: { underdog: { line: 260.5 } } });
  assert.strictEqual(cp.log[0].v, 270);
  assert.strictEqual(cp.log[0].u, 35);
});

test('esports logs come from graded record legs, one per match and stat', () => {
  const rows = [
    { status: 'graded', result: 18, player: 'Faker', sport: 'LOL', market: 'MAPS 1-2 Kills', startTime: '2026-10-20T10:00:00Z', team: 'T1', matchTitle: 'T1 vs GEN' },
    { status: 'graded', result: 18, player: 'Faker', sport: 'LOL', market: 'MAPS 1-2 Kills', startTime: '2026-10-20T10:01:00Z', team: 'T1', matchTitle: 'T1 vs GEN' },
    { status: 'open', result: null, player: 'Faker', sport: 'LOL', market: 'MAPS 1-2 Kills', startTime: '2026-10-27T10:00:00Z' },
  ];
  const idx = L.esportsIndex(rows, { key: m => m.toLowerCase().replace(/\s+/g, '_') });
  const list = idx.get('LOL|faker|maps_1-2_kills');
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].oppName, 'GEN');
  const log = L.createPlayerLog({ now: () => NOW });
  log.setEsports(idx);
  const p = log.page({ key: 'e', sport: 'LOL', esports: true, player: 'Faker', mkey: 'maps_1-2_kills', books: { prizepicks: { line: 16.5 } }, team: 'T1', matchTitle: 'T1 vs GEN' });
  assert.strictEqual(p.source, 'esports-record');
  assert.strictEqual(p.hits[0].season.over, 1);
});

test('season starts roll over at the right month', () => {
  assert.strictEqual(new Date(L.seasonStart('NBA', Date.UTC(2027, 1, 1))).toISOString().slice(0, 10), '2026-10-01');
  assert.strictEqual(new Date(L.seasonStart('NFL', Date.UTC(2026, 9, 25))).toISOString().slice(0, 10), '2026-08-25');
  assert.strictEqual(new Date(L.seasonStart('NFL', Date.UTC(2027, 0, 10))).toISOString().slice(0, 10), '2026-08-25');
  assert.strictEqual(L.seasonStart('GOLF'), null);
});
