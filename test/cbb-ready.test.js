// College basketball from the first slate (Nov 3, 2026): a dry run of the
// whole path on last season's real ESPN data: the opening day's scoreboard and
// 12 box scores (test/fixtures/cbb-2025-11-03) for the grader, and a
// mid-season Saturday (cbb-2026-01-10, 149 games) for the model, which needs
// games on file before the tip (the shipped seed is 2025-26). The app lines are
// test lines built in this file (no app posted college lines before the
// season), shaped like PrizePicks' feed: league CBB, a CBB1H line, the
// player's team as ESPN abbreviates it.
//   PrizePicks payload → props board rows → CBB model legs (cbb-model) →
//   the sports record (logged, locked at the tip) → ESPN grader → graded,
//   each result checked against the raw box score read here on its own.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const { parsePrizePicksPayload, pick6Sports } = require('../pickem');
const propsBoard = require('../propsboard');
const SG = require('../sportgrade');
const { createSportTracker } = require('../sporttrack');
const { createMemoryStore } = require('../evtrack');
const cbbdata = require('../cbbdata');
const C = require('../cbbmodel');
const { scheduleOf } = require('../nbadata');
const { kalshiLeague } = require('../exchanges');
const { canonName } = require('../ev');

const load = (day, f) => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname, 'fixtures', `cbb-${day}`, f))));
const DAYS = { 20251103: { board: load('2025-11-03', 'scoreboard.json.gz'), sums: load('2025-11-03', 'summaries.json.gz') },
  20260110: { board: load('2026-01-10', 'scoreboard.json.gz'), sums: load('2026-01-10', 'summaries.json.gz') } };
let BOARD = DAYS[20251103].board, SUMS = DAYS[20251103].sums;
const useDay = d => { BOARD = DAYS[d].board; SUMS = DAYS[d].sums; };
const ESPN = 'https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball';

// ESPN as it answered on 2026-10-26: the whole D1 slate only with groups=50
// (169 games on 2025-11-03); without it a short featured list, here none of the 12
function espnMock(calls = []) {
  return {
    async get(url, { params = {} } = {}) {
      calls.push({ url, params });
      if (url === `${ESPN}/scoreboard`) {
        const day = DAYS[params.dates];
        if (!day) return { data: { events: [] } };
        if (String(params.groups) !== '50') return { data: { events: day.board.events.filter(e => !day.sums[e.id]).slice(0, 19) } };
        return { data: day.board };
      }
      if (url === `${ESPN}/summary`) {
        const s = Object.values(DAYS).map(d => d.sums[params.event]).find(Boolean);
        if (!s) throw Object.assign(new Error('not in fixture'), { response: { status: 404 } });
        return { data: s };
      }
      throw new Error(`unexpected ${url}`);
    },
  };
}

// a player's raw stat line from the fixture box, read without parseBox
function rawStat(gameId, name, key) {
  for (const team of SUMS[gameId].boxscore.players) {
    const g = team.statistics[0];
    const a = g.athletes.find(x => x.athlete.displayName === name);
    if (a) return Number(a.stats[g.keys.indexOf(key)]);
  }
  return null;
}

// the three heaviest-minute players on each side of each fixture game
function picksFromBoxes() {
  const out = [];
  for (const [id, s] of Object.entries(SUMS)) {
    const ev = BOARD.events.find(e => e.id === id);
    for (const team of s.boxscore.players) {
      const g = team.statistics[0];
      const mi = g.keys.indexOf('minutes');
      const top = g.athletes.filter(a => a.stats?.length && Number(a.stats[mi]) >= 20).sort((a, b) => Number(b.stats[mi]) - Number(a.stats[mi])).slice(0, 3);
      for (const a of top) out.push({ gameId: id, start: ev.date, name: a.athlete.displayName, team: team.team.abbreviation, opp: ev.competitions[0].competitors.find(c => c.team.id !== team.team.id).team.abbreviation });
    }
  }
  return out;
}

// PrizePicks' JSON:API shape (parsePrizePicksPayload): league CBB (id 20) and CBB1H (id 290)
function ppPayload(picks) {
  const data = [], included = [{ type: 'league', id: '20', attributes: { name: 'CBB' } }, { type: 'league', id: '290', attributes: { name: 'CBB1H' } }];
  picks.forEach((p, i) => {
    included.push({ type: 'new_player', id: `p${i}`, attributes: { display_name: p.name, team: p.team, league: 'CBB' } });
    const proj = (stat, line, league = '20') => data.push({ type: 'projection', id: `${i}-${stat}-${league}`, attributes: { line_score: line, stat_type: stat, odds_type: 'standard', status: 'pre_game', start_time: p.start, description: p.opp, game_id: p.gameId },
      relationships: { new_player: { data: { id: `p${i}` } }, league: { data: { id: league } } } });
    // half a point: the model's Over is near-certain, so every one is logged
    proj('Points', 0.5);
    proj('Rebounds', 0.5);
    if (i === 0) proj('Points', 5.5, '290');
  });
  return { data, included };
}

test('the apps\' college basketball names all land on CBB, halves apart', () => {
  for (const s of ['CBB', 'NCAAB', 'NCAAM', 'NCAAMB', 'COLLEGE BASKETBALL']) assert.equal(propsBoard.boardSport(s).sport, 'CBB', s);
  assert.deepEqual(propsBoard.boardSport('CBB1H'), { sport: 'CBB', prefix: '1H ' });
  assert.equal(propsBoard.sportMarketKey('1H Points', 'CBB'), '1h|points');
  // Kalshi's men's college series (KXNCAAMBGAME) is the board's ncaab
  assert.equal(kalshiLeague('KXNCAAMBGAME-26NOV03DUKETEX-DUKE'), 'ncaab');
  assert.equal(kalshiLeague('KXNCAAWBGAME-26NOV01VILLND'), null);
  assert.equal(kalshiLeague('KXNCAAFGAME-26NOV01'), 'ncaaf');
  // a Pick6 pill under any of DraftKings' names
  const sp = pick6Sports({ carouselPills: [{ label: 'CBB', sportLeagueKey: 'x', sportLeaguePillData: {} }] });
  assert.equal(sp[0].label, 'CBB');
});

test('ESPN dates: an 11pm Eastern tip in standard time is filed on its own day', () => {
  // UAPB at Washington, 2025-11-04T04:00Z, sits on ESPN's 2025-11-03 board
  assert.ok(SG.espnDays(Date.parse('2025-11-04T04:00Z')).includes('20251103'));
  assert.ok(SG.espnDays(Date.parse('2025-11-04T00:00Z')).includes('20251103'));
  // a summer 10:30pm ET tip (02:30Z) still reads its own date first
  assert.equal(SG.espnDays(Date.parse('2026-07-01T02:30Z'))[0], '20260630');
});

test('the grader reads the whole D1 slate and finds the player in the right game', async () => {
  const calls = [];
  const g = SG.createSportsGrader({ http: espnMock(calls) });
  const [p] = picksFromBoxes();
  const pts = rawStat(p.gameId, p.name, 'points');
  const r = await g.grade({ sport: 'CBB', player: p.name, team: p.team, matchTitle: '', mkey: 'points', signalLine: pts - 0.5, signalSide: 'Over', startTime: p.start });
  assert.equal(r.outcome, 'win');
  assert.equal(r.result, pts);
  assert.equal(r.eventId, p.gameId);
  assert.ok(calls.some(c => c.url.endsWith('/scoreboard') && c.params.groups === 50), 'asked for the whole division');
  // two schools in the same window whose names hold each other: the box that lists the player wins
  const kansas = { ...BOARD.events.find(e => e.id === p.gameId) };
  const decoy = { ...kansas, id: 'decoy', competitions: [{ competitors: kansas.competitions[0].competitors.map(c => ({ ...c, team: { ...c.team, id: `x${c.team.id}` } })) }] };
  const http = espnMock();
  const base = http.get;
  http.get = async (url, o) => (url.endsWith('/scoreboard') && o.params.dates === '20251103' ? { data: { events: [decoy, ...BOARD.events] } }
    : url.endsWith('/summary') && o.params.event === 'decoy' ? { data: { boxscore: { players: [] } } } : base(url, o));
  const r2 = await SG.createSportsGrader({ http }).grade({ sport: 'CBB', player: p.name, team: p.team, mkey: 'points', signalLine: pts + 0.5, signalSide: 'Over', startTime: p.start });
  assert.equal(r2.outcome, 'loss');
  assert.equal(r2.eventId, p.gameId);
});

test('dry run: PrizePicks CBB lines → model legs → record → graded off the real box scores', async t => {
  useDay(20260110);
  const picks = picksFromBoxes();
  assert.ok(picks.length >= 60, `${picks.length} players`);
  const t0 = Date.parse('2026-01-10T12:00:00Z');
  let clock = t0;
  // 1. the PrizePicks read
  const { lines } = parsePrizePicksPayload(ppPayload(picks));
  assert.equal(lines.length, picks.length * 2 + 1);
  assert.ok(lines.every(l => l.sport === 'CBB' || l.sport === 'CBB1H'));
  // 2. the props board
  const rows = propsBoard.buildRows(lines.map(propsBoard.normLine), { now: t0 });
  assert.ok(rows.every(r => r.sport === 'CBB'));
  assert.ok(rows.some(r => r.mkey === '1h|points'), 'the half stays its own row');
  assert.equal(rows.filter(r => r.mkey === 'points').length, picks.length);
  // 3. the CBB model, its schedule as its own refresh reads it (the 2025-26 seed has
  // these games; the projection uses only games before each tip)
  const model = cbbdata.createCbbModel({ http: espnMock(), now: () => clock });
  model.state.schedule = BOARD.events.map(ev => scheduleOf({ ...ev, status: { type: { completed: false } } }, cbbdata.CBB.schedOpts)).filter(Boolean);
  model.state.refreshedAt = new Date(t0).toISOString();
  const section = model.section(rows);
  const flagged = model.plays(rows);
  const byKind = flagged.reduce((a, f) => ((a[f.kind] = (a[f.kind] || 0) + 1), a), {});
  // every player matched his own school's game, and the confident legs are research kinds of their own
  assert.ok(section.length >= picks.length * 2 * 0.9, `${section.length} of ${picks.length * 2} priced`);
  for (const s of section.slice(0, 40)) {
    const p = picks.find(x => canonName(x.name) === canonName(s.player));
    assert.equal(s.team, p.team, `${s.player} on ${s.team}`);
    assert.equal(s.version, cbbdata.MODEL_VERSION);
  }
  assert.ok(byKind['cbb-model'] >= picks.length, JSON.stringify(byKind));
  assert.ok(flagged.every(f => f.research === true && f.play.book === 'prizepicks'));
  // 4. the record: logged before the tip, locked at it, graded 3.5 hours on
  const calls = [];
  const grader = SG.createSportsGrader({ http: espnMock(calls), now: () => clock });
  const tracker = createSportTracker({ store: createMemoryStore(), grader: { grade: b => grader.grade(b), canGrade: SG.canGrade }, now: () => clock, log: { warn() {} } });
  await tracker.record({ rows, flagged, fairAt: (row, book, line) => model.fairAt(row, line), updated: { prizepicks: new Date(t0).toISOString() } });
  assert.equal((await tracker.list({ kind: 'cbb-model', limit: 1000 })).length, flagged.filter(f => f.kind === 'cbb-model').length, 'every leg logged');
  // the server reads every two minutes; here every 20 until the last tip, each read re-pricing the close
  const fairAt = (row, book, line) => model.fairAt(row, line);
  for (clock = t0 + 20 * 60e3; clock <= Date.parse('2026-01-11T07:00:00Z'); clock += 20 * 60e3) await tracker.record({ rows, flagged: [], fairAt, updated: {} });
  clock = Date.parse('2026-01-11T12:00:00Z');
  let graded = 0;
  for (let i = 0; i < 5; i++) graded += (await tracker.grade({ max: 200, retryMs: 0 })).graded;
  const legs = await tracker.list({ kind: 'cbb-model', limit: 1000 });
  assert.equal(graded, legs.length, 'every logged leg graded');
  assert.ok(legs.length >= picks.length);
  for (const b of legs) {
    assert.equal(b.status, 'graded');
    const p = picks.find(x => canonName(x.name) === canonName(b.player));
    assert.equal(b.eventId, p.gameId);
    const v = rawStat(p.gameId, p.name, b.mkey === 'points' ? 'points' : 'rebounds');
    assert.equal(b.result, v, `${b.player} ${b.mkey}`);
    assert.equal(b.outcome, v === b.signalLine ? 'push' : (v > b.signalLine) === (b.signalSide === 'Over') ? 'win' : 'loss');
    // the model's own number at the tip is the leg's close
    assert.ok(b.closeFair > 0.5 && b.closeOk === true);
  }
  const won = legs.filter(b => b.outcome === 'win').length;
  t.diagnostic(`${picks.length} players, ${lines.length} PrizePicks lines, ${rows.length} board rows, ${section.length} priced, ${JSON.stringify(byKind)} logged, ${legs.length} cbb-model graded (${won} won), every result equal to the raw box`);
  // the grader only asked ESPN for the whole slate
  assert.ok(calls.filter(c => c.url.endsWith('/scoreboard')).every(c => c.params.groups === 50));
  useDay(20251103);
});

test('a transfer is projected for his new school even when his old one plays that night', () => {
  const model = cbbdata.createCbbModel({ http: espnMock(), now: () => Date.parse('2025-11-03T15:00:00Z') });
  const H = model.history();
  // a player whose last game on file is with one school, listed by the app on another
  const [key, games] = [...H.players.entries()].find(([, g]) => g.length >= 20 && g[g.length - 1].min >= 25);
  const last = games[games.length - 1];
  const tip = Date.parse('2025-11-04T00:00:00Z');
  model.state.schedule = [
    { id: 'old', t: tip, home: last.team, away: '999001', done: false, total: null, spread: null, homeName: 'Old School Owls', awayName: 'Foe A', homeAbbr: 'OLD', awayAbbr: 'FOA', homeAlt: ['Old School'], awayAlt: [] },
    { id: 'new', t: tip + 1800e3, home: '999002', away: '999003', done: false, total: null, spread: null, homeName: 'New State Hawks', awayName: 'Foe B', homeAbbr: 'NEW', awayAbbr: 'FOB', homeAlt: ['New State'], awayAlt: [] },
  ];
  model.state.refreshedAt = new Date().toISOString();
  const row = { key: `CBB|${key}|points`, sport: 'CBB', player: last.name, mkey: 'points', startTime: new Date(tip).toISOString(), books: {} };
  assert.equal(model.projectionFor({ ...row, team: 'NEW' }).game?.id, 'new', 'the app names his new school');
  assert.equal(model.projectionFor({ ...row, team: 'New State' }).game?.id, 'new', 'by its short name too');
  assert.equal(model.projectionFor({ ...row, team: '' }).game?.id, 'old', 'no school named: his last team on file');
  assert.ok(C.teamOf({ id: 150 }) === '150');
});
