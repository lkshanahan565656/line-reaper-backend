// NBA player-prop model (nbamodel.js) and its live data layer (nbadata.js):
// ESPN box → compact game, history, projections, the count distributions and
// P(over) at a line, the NBA MODEL section and the record's legs.
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../nbamodel');
const D = require('../nbadata');

const DAY = 86400e3;
const T0 = Date.parse('2026-01-01T00:00:00Z');

// an ESPN summary as the API sends it (keys + stats arrays)
const KEYS = ['minutes', 'points', 'fieldGoalsMade-fieldGoalsAttempted', 'threePointFieldGoalsMade-threePointFieldGoalsAttempted', 'freeThrowsMade-freeThrowsAttempted',
  'rebounds', 'assists', 'turnovers', 'steals', 'blocks', 'offensiveRebounds', 'defensiveRebounds', 'fouls', 'plusMinus'];
function ath(name, id, s, { starter = true, dnp = false } = {}) {
  if (dnp) return { athlete: { displayName: name, id }, starter: false, didNotPlay: true, stats: [] };
  return { athlete: { displayName: name, id }, starter, stats: [String(s.min), String(s.pts), `${s.fgm}-${s.fga}`, `${s.tpm}-${s.tpa}`, `${s.ftm}-${s.fta}`,
    String(s.reb), String(s.ast), String(s.tov), String(s.stl), String(s.blk), String(s.oreb), String(s.reb - s.oreb), '2', '+3'] };
}
function summary(id, t, home, away, homeAth, awayAth, pick = null) {
  return {
    id,
    comp: { date: new Date(t).toISOString(), competitors: [{ homeAway: 'home', team: { abbreviation: home }, score: '110' }, { homeAway: 'away', team: { abbreviation: away }, score: '104' }] },
    players: [{ team: { abbreviation: home }, statistics: [{ keys: KEYS, athletes: homeAth }] }, { team: { abbreviation: away }, statistics: [{ keys: KEYS, athletes: awayAth }] }],
    pickcenter: pick,
  };
}
// a 5-man team whose first player scores `pts` in `min` minutes
function team(prefix, pts = 20, min = 34) {
  const base = { fgm: 8, fga: 17, tpm: 2, tpa: 6, ftm: 4, fta: 5, reb: 6, ast: 4, tov: 2, stl: 1, blk: 1, oreb: 1 };
  return [0, 1, 2, 3, 4].map(i => ath(`${prefix} Player${i}`, `${prefix}${i}`, { ...base, min: i === 0 ? min : 36, pts: i === 0 ? pts : 16 }));
}
function season(n = 30, { pts = 24, min = 34 } = {}) {
  const games = [];
  for (let i = 0; i < n; i++) {
    const t = T0 + i * 2 * DAY;
    games.push(M.compactGame(summary(`g${i}`, t, i % 2 ? 'BOS' : 'NY', i % 2 ? 'NY' : 'BOS', team(i % 2 ? 'Bos' : 'Nyk', i % 2 ? pts : 18, min), team(i % 2 ? 'Nyk' : 'Bos', i % 2 ? 18 : pts, min),
      [{ details: 'BOS -4.5', overUnder: 224.5 }])));
  }
  return games;
}

test('an ESPN box becomes a compact game: stats, starters, DNPs, spread and total', () => {
  const s = summary('401', T0, 'BOS', 'NY', [...team('Bos'), ath('Bench Guy', 'b1', {}, { dnp: true })], team('Nyk'), [{ details: 'NY -3.5', overUnder: 221.5 }]);
  const g = M.compactGame(s);
  assert.equal(g.home, 'BOS');
  assert.equal(g.away, 'NY');
  assert.equal(g.total, 221.5);
  assert.equal(g.spread, 3.5);   // the away team is favoured: home +3.5
  assert.equal(g.players.length, 10);
  const p = g.players.find(x => x.name === 'Bos Player0');
  assert.deepEqual([p.min, p.points, p.threes, p.rebounds, p.assists, p.steals, p.blocks, p.turnovers, p.fga, p.fta, p.oreb], [34, 20, 2, 6, 4, 1, 1, 2, 17, 5, 1]);
  assert.equal(p.aid, 'Bos0');
  assert.deepEqual(g.dnp.BOS, ['benchguy']);
  assert.equal(M.spreadOf([{ details: 'EVEN', overUnder: 220 }], 'BOS', 'NY').spread, 0);
  assert.equal(M.spreadOf([{ details: 'BOS -7', overUnder: 100 }], 'BOS', 'NY').total, null);   // a nonsense total is dropped
});

test('the count distribution: cdf sums to one, Poisson at phi 0, pushes on whole lines', () => {
  assert.ok(Math.abs(M.countCdf(400, 25, 0.06).cdf - 1) < 1e-9);
  // Poisson(2): P(X<=1) = 3 e^-2
  assert.ok(Math.abs(M.countCdf(1, 2, 0).cdf - 3 * Math.exp(-2)) < 1e-12);
  const proj = { minutes: { mean: 30, sd: 0.001 }, rate: { points: 0.5, rebounds: 0.2, assists: 0.1, threes: 0.05, steals: 0.03, blocks: 0.02, turnovers: 0.05 },
    mult: { points: 1, rebounds: 1, assists: 1, threes: 1, steals: 1, blocks: 1, turnovers: 1 } };
  const half = M.probOver(proj, 'points', 14.5);
  assert.equal(half.push, 0);
  const whole = M.probOver(proj, 'points', 15);
  assert.ok(whole.push > 0.03 && whole.push < 0.12);
  assert.ok(Math.abs(whole.over + whole.push + whole.under - 1) < 1e-9);
  // higher line, lower P(over)
  assert.ok(M.probOver(proj, 'points', 18.5).over < half.over);
  // the combo adds its parts' means
  assert.ok(Math.abs(M.expected(proj, 'pra') - 30 * 0.8) < 1e-6);
  // priceLine: a push is a void, so P(over) at a whole number leaves it out
  const pl = M.priceLine(proj, 'points', 15, { ...M.PARAMS, cal: null });
  assert.ok(Math.abs(pl.pOver - whole.over / (1 - whole.push)) < 1e-4);
  assert.equal(M.priceLine(proj, 'fantasy_score', 30), null);
});

test('projections come only from games before the tip, and follow minutes and form', () => {
  const games = season(30);
  const H = M.buildHistory(games);
  const key = 'bosplayer0';
  const t = T0 + 61 * DAY;
  const p = M.project(H, key, { t, team: 'BOS', opp: 'NY', home: true, total: 224.5, spread: -4.5, out: [] });
  assert.ok(p, 'projects a player with history');
  assert.ok(Math.abs(p.minutes.mean - 34) < 2, `minutes ${p.minutes.mean}`);
  const mean = M.expected(p, 'points');
  assert.ok(mean > 19 && mean < 27, `points ${mean}`);
  // a player with no minutes on record has no projection
  assert.equal(M.project(H, 'nobody', { t, team: 'BOS', opp: 'NY' }), null);
  // no leakage: projecting at the 10th game's tip ignores games 10 on
  const at10 = M.project(H, key, { t: games[10].t, team: 'BOS', opp: 'NY', home: true, out: [] });
  const H10 = M.buildHistory(games.slice(0, 10));
  const only10 = M.project(H10, key, { t: games[10].t, team: 'BOS', opp: 'NY', home: true, out: [] });
  assert.deepEqual(at10.rate, only10.rate);
  // a back-to-back costs minutes when the knob is on (the fit switched it off: b2b 1)
  const P = { ...M.PARAMS, b2b: 0.97 };
  const b2b = M.project(H, key, { t: games[29].t + 1 * DAY, team: 'BOS', opp: 'NY', home: true, out: [] }, P);
  const rested = M.project(H, key, { t: games[29].t + 2 * DAY, team: 'BOS', opp: 'NY', home: true, out: [] }, P);
  assert.ok(b2b.b2b && !rested.b2b && b2b.minutes.mean < rested.minutes.mean);
  // a teammate listed Out frees minutes
  const withOut = M.project(H, key, { t, team: 'BOS', opp: 'NY', home: true, out: ['bosplayer1'] }, { ...M.PARAMS, freedShare: 0.5 });
  assert.ok(withOut.minutes.mean > p.minutes.mean);
  assert.equal(withOut.outs, 1);
});

test('nbadata: injury list, schedule and abbreviations', () => {
  const outs = D.outsOf({ injuries: [{ team: { abbreviation: 'GS' }, injuries: [
    { athlete: { displayName: 'Stephen Curry' }, status: 'Out' }, { athlete: { displayName: 'Al Horford' }, status: 'Day-To-Day' }, { athlete: { displayName: 'Jimmy Butler III' }, status: 'Doubtful' }] }] });
  assert.deepEqual([...outs.get('GS')].sort(), ['jimmybutler', 'stephencurry']);
  assert.equal(D.fixAbbr('GSW'), 'GS');
  assert.equal(D.fixAbbr('UTA'), 'UTAH');
  assert.equal(D.fixAbbr('BOS'), 'BOS');
  const s = D.scheduleOf({ id: '9', date: '2026-10-26T23:30Z', season: { type: 2 }, competitions: [{ status: { type: { completed: false } }, odds: [{ details: 'BOS -6.5', overUnder: 226.5 }],
    competitors: [{ homeAway: 'home', team: { abbreviation: 'BOS', displayName: 'Boston Celtics' } }, { homeAway: 'away', team: { abbreviation: 'NY', displayName: 'New York Knicks' } }] }] });
  assert.deepEqual([s.home, s.away, s.spread, s.total, s.done], ['BOS', 'NY', -6.5, 226.5, false]);
  assert.ok(D.teamMatches('NY', 'New York Knicks', 'Knicks'));
  assert.ok(D.teamMatches('NY', 'New York Knicks', 'NYK'));
  assert.ok(!D.teamMatches('NY', 'New York Knicks', 'Boston Celtics'));
});

test('nbadata: the NBA MODEL section and the record legs, from a stubbed ESPN', async () => {
  const games = season(30);
  const tip = T0 + 62 * DAY;
  const http = { get: async (url) => {
    if (url.endsWith('/scoreboard')) return { data: { events: [{ id: 'live1', date: new Date(tip).toISOString(), season: { type: 2 }, competitions: [{ status: { type: { completed: false } },
      odds: [{ details: 'BOS -4.5', overUnder: 224.5 }],
      competitors: [{ homeAway: 'home', team: { abbreviation: 'BOS', displayName: 'Boston Celtics' } }, { homeAway: 'away', team: { abbreviation: 'NY', displayName: 'New York Knicks' } }] }] }] } };
    if (url.endsWith('/injuries')) return { data: { injuries: [{ team: { abbreviation: 'BOS' }, injuries: [{ athlete: { displayName: 'Bos Player4' }, status: 'Out' }] }] } };
    throw new Error(`unexpected ${url}`);
  } };
  // raw probabilities (no calibration) so the toy season's numbers read plainly
  const RAW = { ...M.PARAMS, cal: null };
  const nm = D.createNbaModel({ http, seed: games, now: () => tip - 3 * 3600e3, params: RAW });
  await nm.refresh();
  assert.equal(nm.status().schedule, 1);
  assert.equal(nm.status().teamsWithOuts, 1);
  const start = new Date(tip).toISOString();
  const rows = [
    { key: 'NBA|bosplayer0|points', sport: 'NBA', player: 'Bos Player0', team: 'BOS', mkey: 'points', market: 'Points', startTime: start,
      books: { prizepicks: { line: 8.5 }, underdog: { line: 23.5, over: 1, under: 1 }, pick6: { line: 8.5, over: 1, under: 1 } } },
    // listed Out: no projection, no leg
    { key: 'NBA|bosplayer4|points', sport: 'NBA', player: 'Bos Player4', team: 'BOS', mkey: 'points', market: 'Points', startTime: start, books: { prizepicks: { line: 15.5 } } },
    // a stat the model doesn't price
    { key: 'NBA|bosplayer0|fantasy_score', sport: 'NBA', player: 'Bos Player0', team: 'BOS', mkey: 'fantasy_score', startTime: start, books: { prizepicks: { line: 40.5 } } },
    { key: 'NFL|x|pass_yds', sport: 'NFL', player: 'X', mkey: 'pass_yds', startTime: start, books: { prizepicks: { line: 240.5 } } },
  ];
  const sec = nm.section(rows, { pinAt: r => (r.player === 'Bos Player0' ? { line: 22.5, pOver: 0.52 } : null) });
  assert.equal(sec.length, 1);
  const r = sec[0];
  assert.equal(r.team, 'BOS');
  assert.equal(r.opp, 'NY');
  assert.equal(r.total, 224.5);
  assert.equal(r.teammatesOut, 1);
  assert.ok(r.apps.prizepicks.pOver > 0.85, 'a line far under the projection reads Over');
  assert.equal(r.apps.prizepicks.side, 'Over');
  assert.equal(r.pinnacle.line, 22.5);
  assert.ok(r.pinnacle.model > 0 && r.pinnacle.model < 1);
  // the record logs PrizePicks and Pick6 sides at 58%+, research kinds of their own
  const all = nm.plays(rows);
  const legs = all.filter(l => l.kind === 'nba-model' || l.kind === 'p6-nba-model');
  assert.deepEqual(legs.map(l => l.kind).sort(), ['nba-model', 'p6-nba-model']);
  // the same lines sit far under the projection: far-from-projection legs too (farlines.js), research, side toward the projection
  const far = all.filter(l => /far-nba$/.test(l.kind));
  assert.deepEqual(far.map(l => l.kind).sort(), ['far-nba', 'p6-far-nba']);
  assert.ok(far.every(l => l.research && l.play.side === 'Over' && l.play.farD >= 1 && l.play.modelVersion === D.MODEL_VERSION));
  // the section saw Pinnacle at 22.5 (toward our projection): the cell is far but marked stale, so the row isn't a far row
  assert.ok(r.apps.prizepicks.far === true && r.apps.prizepicks.d >= 1 && r.apps.prizepicks.pinAgree === 'toward');
  assert.equal(r.far, false);
  assert.ok(nm.section([rows[0]]).every(x => x.far && x.farD >= 1));
  // with Pinnacle's line sitting toward our projection (22.5 above the app's 8.5, model Over), it's the stale play: no far leg
  const stale = nm.plays(rows, { pinAt: () => ({ line: 22.5, pOver: 0.5 }) }).filter(l => /far-nba$/.test(l.kind));
  assert.equal(stale.length, 0);
  // Pinnacle on the same number: logged, with the agreement kept
  const same = nm.plays([rows[0]], { pinAt: () => ({ line: 8.5, pOver: 0.5 }) }).filter(l => l.kind === 'far-nba');
  assert.equal(same.length, 1);
  assert.equal(same[0].play.pinAgree, 'same');
  assert.ok(legs.every(l => l.research && l.play.side === 'Over' && l.play.fair >= D.PICK_MIN && l.play.mult === 1 && l.play.modelVersion === D.MODEL_VERSION));
  // each app's payout for the model's side, and the best one
  assert.ok(r.apps.prizepicks.breakEven > 0.55 && r.apps.prizepicks.ev > 0);
  assert.ok(r.bestPay && Number.isFinite(r.bestPay.ev));
  assert.equal(r.version, D.MODEL_VERSION);
  // Underdog: logged on value at its real multiplier (a line far under the projection is worth it)
  const udLegs = nm.plays([{ ...rows[0], books: { underdog: { line: 8.5, over: 1, under: 1 } } }]);
  assert.deepEqual(udLegs.map(l => l.kind).sort(), ['ud-far-nba', 'ud-nba-model']);
  assert.ok(udLegs[0].play.ev >= D.UD_EV_MIN * 100);
  // a Pick6 side at a multiplier other than 1x is another table: not logged
  const boosted = nm.plays([{ ...rows[0], books: { pick6: { line: 8.5, over: 1.5, under: 1 } } }]);
  // (neither the model's leg nor the far leg)
  assert.equal(boosted.length, 0);
  // the close is the model's own P(over)
  assert.ok(nm.fairAt(rows[0], 8.5) > 0.85);
  // a game that already started logs nothing
  const late = D.createNbaModel({ http, seed: games, now: () => tip + 3600e3, params: RAW });
  await late.refresh();
  assert.equal(late.plays(rows).length, 0);
});

test('the shipped seed and parameters load', () => {
  const seed = D.loadSeed();
  assert.ok(seed.length > 1000, `seed games ${seed.length}`);
  assert.ok(seed.every(g => g.id && Number.isFinite(g.t) && g.players.length));
  for (const s of M.BASE) assert.ok(M.PARAMS.phi[s] > 0 && M.PARAMS.rateK[s] > 0);
});

test('v2: positions, injury absences, calibration and the by-position opponent', () => {
  assert.equal(M.posOf({ position: { abbreviation: 'PG' } }), 'G');
  assert.equal(M.posOf({ position: { abbreviation: 'SF' } }), 'F');
  assert.equal(M.posOf({ position: { abbreviation: 'C' } }), 'C');
  assert.equal(M.posOf({ position: { abbreviation: 'G-F' } }), 'G');
  assert.equal(M.posOf({}), null);
  assert.ok(M.isOutReason('LEFT ANKLE SPRAIN'));
  assert.ok(M.isOutReason('REST'));
  assert.ok(!M.isOutReason("COACH'S DECISION"));
  assert.ok(!M.isOutReason('DID NOT DRESS'));
  assert.ok(!M.isOutReason(''));
  // a box DNP with an injury reason goes on that game's Out list; a coach's decision doesn't
  const hurt = { ...ath('Hurt Guy', 'h1', {}, { dnp: true }), reason: 'RIGHT KNEE SORENESS' };
  const benched = { ...ath('Bench Guy', 'b1', {}, { dnp: true }), reason: "COACH'S DECISION" };
  const g = M.compactGame(summary('402', T0, 'BOS', 'NY', [...team('Bos'), hurt, benched], team('Nyk')));
  assert.deepEqual(g.inj.BOS, ['hurtguy']);
  assert.deepEqual(g.dnp.BOS.sort(), ['benchguy', 'hurtguy']);
  // calibration: v1 params pass through; a slope under 1 pulls toward 50%
  assert.equal(M.calibrate(0.7, 'points', { ...M.PARAMS, cal: null }), 0.7);
  const P = { ...M.PARAMS, cal: { a: 0, b: 0.5, stat: { points: [-0.1, 0.5] } } };
  const c = M.calibrate(0.7, 'rebounds', P);
  assert.ok(c > 0.5 && c < 0.7);
  assert.ok(M.calibrate(0.7, 'points', P) < c);   // the per-stat shift leans Under
  // past the fitted range the raw slope carries on: a line far off the projection stays far off
  const G = { ...M.PARAMS, cal: { a: 0, b: 0.1, range: 1.5, stat: {} } };
  assert.ok(M.calibrate(0.99, 'points', G) > 0.9);
  assert.ok(M.calibrate(0.6, 'points', G) < 0.52);
  assert.ok(M.calibrate(0.995, 'points', G) > M.calibrate(0.9, 'points', G));
  // the by-position opponent factor runs when positions are on file
  const games = season(30);
  const H = M.buildHistory(games);
  const pr = M.project(H, 'bosplayer0', { t: T0 + 61 * DAY, team: 'BOS', opp: 'NY', home: true, out: [] }, { ...M.PARAMS, posWeight: 1 });
  assert.ok(pr && Number.isFinite(pr.mult.points));
});

test('v2: each app priced at its real payout, Underdog legs logged on value', () => {
  // PrizePicks 3-pick Power break-even 55.03%
  const pp = D.payoutFor('prizepicks', 'Over', 0.6, { line: 20.5 });
  assert.ok(Math.abs(pp.breakEven - 0.5503) < 0.001);
  assert.ok(Math.abs(pp.ev - (0.6 / 0.5503 - 1)) < 0.002);
  // Underdog at a 1.08x Over multiplier pays more than its standard leg
  const std = D.payoutFor('underdog', 'Over', 0.6, { line: 20.5 });
  const up = D.payoutFor('underdog', 'Over', 0.6, { line: 20.5, over: 1.08, under: 0.92 });
  assert.ok(up.decimal > std.decimal && up.ev > std.ev);
  assert.equal(D.MODEL_VERSION, 'v2');
  assert.ok(D.VERSION_NOTE.includes('never reset'));
});
