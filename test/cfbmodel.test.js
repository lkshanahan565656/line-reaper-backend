const test = require('node:test');
const assert = require('node:assert');
const M = require('../cfbmodel');
const box = require('./fixtures/cfb-box.json');
const { canonName } = require('../ev');

// a synthetic two-team league: team A's QB throws 30, B's 20; RB carries 15
function mkGame(i, { t0 = Date.parse('2025-09-06T17:00Z'), qbAtt = 30, spread = -7, total = 55 } = {}) {
  const t = t0 + i * 7 * 86400e3;
  const home = i % 2 ? 'A' : 'B';
  const P = (aid, team, o) => ({ aid, key: canonName(aid), name: aid, team, pa: 0, pc: 0, py: 0, ptd: 0, pint: 0, ra: 0, ry: 0, rtd: 0, rushlong: 0, rec: 0, recy: 0, rectd: 0, reclong: 0, fgm: 0, kp: 0, k: 0, ...o });
  return { id: `g${i}`, t, season: 2025, week: i + 1, home, away: home === 'A' ? 'B' : 'A', homeAbbr: home, awayAbbr: home === 'A' ? 'B' : 'A', homeName: home, awayName: home,
    homePts: 28, awayPts: 21, total, spread,
    players: [
      P('qbA', 'A', { pa: qbAtt, pc: 20, py: 250, ptd: 2, ra: 4, ry: 10 }), P('wrA', 'A', { rec: 6, recy: 80, reclong: 25 }), P('wr2A', 'A', { rec: 14, recy: 170, reclong: 30 }),
      P('rbA', 'A', { ra: 15, ry: 75, rtd: 1, rushlong: 20 }), P('kA', 'A', { fgm: 1, kp: 7, k: 1 }),
      P('qbB', 'B', { pa: 20, pc: 12, py: 150, ptd: 1, ra: 6, ry: 20 }), P('wrB', 'B', { rec: 12, recy: 150, reclong: 30 }), P('rbB', 'B', { ra: 20, ry: 90, rtd: 1, rushlong: 15 }),
    ] };
}

test('compactGame reads an ESPN FBS box: ids, passing/rushing/receiving/kicking, home spread', () => {
  const g = M.compactGame(box, { season: 2026, week: 3 });
  assert.ok(g && g.players.length > 10);
  assert.strictEqual(g.season, 2026);
  assert.ok(g.home && g.away && g.home !== g.away);
  const qb = g.players.find(p => p.pa >= 10);
  assert.ok(qb.aid && qb.py > 0 && qb.pc <= qb.pa);
  assert.ok(g.players.some(p => p.k === 1));
  // the pick center's home spread: favourite flag and sign agree
  const pc = box.pickcenter[0];
  assert.strictEqual(Math.sign(g.spread), pc.homeTeamOdds.favorite ? -1 : 1);
  assert.strictEqual(g.total, pc.overUnder);
});

test('spreadOf trusts the favourite flag over the sign', () => {
  assert.deepStrictEqual(M.spreadOf([{ spread: 6.5, overUnder: 50, homeTeamOdds: { favorite: true }, awayTeamOdds: { favorite: false } }]), { total: 50, spread: -6.5 });
  assert.deepStrictEqual(M.spreadOf([{ spread: -3, overUnder: 44, homeTeamOdds: { favorite: false }, awayTeamOdds: { favorite: true } }]), { total: 44, spread: 3 });
  assert.deepStrictEqual(M.spreadOf(null), { total: null, spread: null });
});

test('project uses only games before kickoff (no leakage) and needs minGames', () => {
  const games = Array.from({ length: 6 }, (_, i) => mkGame(i));
  const H = M.buildHistory(games);
  const t = games[1].t;   // only game 0 is before it
  assert.strictEqual(M.project(H, 'qbA', { t, team: 'A', opp: 'B', total: 55, spread: -7 }), null);
  const p = M.project(H, 'qbA', { t: games[5].t, team: 'A', opp: 'B', total: 55, spread: -7 });
  assert.ok(p && p.games === 5 && p.passer);
  // changing a later game's numbers never moves an earlier projection
  const games2 = games.map((g, i) => (i === 5 ? mkGame(5, { qbAtt: 60 }) : g));
  const p2 = M.project(M.buildHistory(games2), 'qbA', { t: games[5].t, team: 'A', opp: 'B', total: 55, spread: -7 });
  assert.deepStrictEqual(p2.mean, p.mean);
});

test('share x team volume: the QB takes all of his team pass attempts; combos add parts', () => {
  const games = Array.from({ length: 6 }, (_, i) => mkGame(i));
  const H = M.buildHistory(games);
  const o = { ...M.PARAMS, teamK: 0, oppK: 0 };
  const p = M.project(H, 'qbA', { t: games[5].t + 86400e3, team: 'A', opp: 'B' }, o);
  // B allows 30 attempts a game against a league average of 25: 30 x 30/25
  assert.ok(Math.abs(p.mean.pass_att - 36) < 1e-6, p.mean.pass_att);
  assert.ok(Math.abs(p.mean.pass_rush_yds - (p.mean.pass_yds + p.mean.rush_yds)) < 1e-9);
  const wr = M.project(H, 'wrA', { t: games[5].t + 86400e3, team: 'A', opp: 'B' }, o);
  // 6 of 40 team catches → 30% of the projected completions
  assert.ok(Math.abs(wr.mean.receptions - 0.3 * p.mean.pass_comp) < 1e-6);
});

test('script: a bigger implied total raises volume when alpha > 0; a lean moves pass vs rush', () => {
  const games = Array.from({ length: 6 }, (_, i) => mkGame(i));
  const H = M.buildHistory(games);
  const o = { ...M.PARAMS, script: { ...M.PARAMS.script, pass: { alpha: 1, beta: 0.2, delta: 0 }, rush: { alpha: 1, beta: -0.2, delta: 0 } } };
  const at = (total, spread) => M.project(H, 'qbA', { t: games[5].t + 86400e3, team: 'A', opp: 'B', total, spread }, o).mean;
  assert.ok(at(70, -7).pass_yds > at(45, -7).pass_yds);
  // as an underdog (spread +7) he throws more and runs less than as a favourite
  assert.ok(at(55, 7).pass_att / at(55, -7).pass_att > 1);
  assert.ok(at(55, 7).rush_att < at(55, -7).rush_att);
});

test('fitDist + probOver: calibrated on its own sample and monotone in the line', () => {
  const rows = [];
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (let i = 0; i < 3000; i++) { const mean = 40 + 60 * rnd(); rows.push({ stat: 'rec_yds', mean, actual: Math.max(0, mean * (0.2 + 1.6 * rnd())) }); }
  const dist = M.fitDist(rows);
  assert.ok(dist.rec_yds.length >= 2);
  const o = { ...M.PARAMS, dist };
  const proj = { mean: { rec_yds: 70 } };
  const ps = [20, 50, 70, 90, 120].map(l => M.probOver(proj, 'rec_yds', l, o));
  for (let i = 1; i < ps.length; i++) assert.ok(ps[i] <= ps[i - 1]);
  // uniform(0.2, 1.8) x mean: P(over the mean) is 1/2
  assert.ok(Math.abs(M.probOver(proj, 'rec_yds', 70, o) - 0.5) < 0.05);
  const pr = M.priceLine(proj, 'rec_yds', 90, o);
  assert.strictEqual(pr.side, 'Under');
  assert.ok(pr.pSide > 0.5);
  assert.ok(Math.abs(M.median(proj, 'rec_yds', o) - 70) < 5);
});

test('tailAbove: point masses (zero games) count at-or-below', () => {
  const q = [0, 0, 0, 0.5, 1, 1.5, 2];
  assert.strictEqual(M.tailAbove(q, -1), 1);
  assert.ok(Math.abs(M.tailAbove(q, 0) - 4 / 6) < 1e-9);
  assert.strictEqual(M.tailAbove(q, 3), 0);
});

test('aidFor: a name is one player on the given teams, else null', () => {
  const H = M.buildHistory([mkGame(0), mkGame(1)]);
  assert.strictEqual(M.aidFor(H, 'qbA', ['A', 'B']), 'qbA');
  assert.strictEqual(M.aidFor(H, 'qbA', ['C']), null);
  assert.strictEqual(M.aidFor(H, 'nobody'), null);
});
