const test = require('node:test');
const assert = require('node:assert');
const R = require('../roundmodel');

test('a map of rounds sums to one and runs to overtime about a tenth of the time', () => {
  for (const game of ['CS2', 'VAL']) {
    const d = R.rounds(0.5, game);
    const tot = d.reduce((s, x) => s + x[2], 0);
    assert.ok(Math.abs(tot - 1) < 1e-3, `${game} sums to ${tot}`);
    const ot = d.filter(([a, b]) => a + b > 24).reduce((s, x) => s + x[2], 0);
    assert.ok(ot > 0.08 && ot < 0.16, `${game} overtime ${ot}`);
    assert.ok(Math.abs(R.expectedRounds(d) - 21.8) < 0.6, `${game} rounds ${R.expectedRounds(d)}`);
  }
  // CS2 overtime ends 16-x, 19-x; Valorant wins by two
  assert.ok(R.rounds(0.5, 'CS2').some(([a, b]) => a === 16 && b === 14));
  assert.ok(R.rounds(0.5, 'VAL').some(([a, b]) => a === 14 && b === 12));
  assert.ok(!R.mapRounds(0.5, 'VAL').some(([a, b]) => a === 13 && b === 12));
});

test('a stronger team means fewer rounds and wins the map more', () => {
  const even = R.rounds(0.5, 'CS2'), fav = R.rounds(0.58, 'CS2');
  assert.ok(R.expectedRounds(fav) < R.expectedRounds(even));
  assert.ok(R.ladderProb(fav, 'ml', 0) > 0.7);
  assert.ok(Math.abs(R.ladderProb(even, 'ml', 0) - 0.5) < 1e-6);
});

test('fitMap recovers q0 from a round total and handicap', () => {
  const d = R.rounds(0.56, 'CS2');
  const lad = new Map([
    ['rounds|1|total', [{ x: -21.5, p: R.ladderProb(d, 'total', -21.5) }]],
    ['rounds|1|spread', [{ x: -3.5, p: R.ladderProb(d, 'spread', -3.5) }]],
  ]);
  const f = R.fitMap(lad, 1, 'CS2');
  assert.ok(Math.abs(f.q - 0.56) < 0.006, `q ${f.q}`);
  assert.ok(f.rms < 0.5);
  assert.strictEqual(R.fitMap(lad, 2, 'CS2'), null);
  assert.ok(Math.abs(R.qFromWin(R.ladderProb(d, 'ml', 0), 'CS2') - 0.56) < 0.005);
});

test('kills: mean is kills a round × rounds, more for the favourite, sides add to one', () => {
  const even = { game: 'CS2', kpr: 0.7, qs: [0.5, 0.5] };
  const m = R.pmfMean(R.killsPmf(even));
  assert.ok(Math.abs(m - 0.7 * 2 * R.expectedRounds(R.rounds(0.5, 'CS2'))) < 0.3, `mean ${m}`);
  assert.ok(R.pmfMean(R.killsPmf({ ...even, qs: [0.56, 0.56] })) > R.pmfMean(R.killsPmf({ ...even, qs: [0.44, 0.44] })));
  const o = R.sideProb(even, 29.5, 'OVER'), u = R.sideProb(even, 29.5, 'UNDER');
  assert.ok(Math.abs(o + u - 1) < 1e-6);
  assert.ok(o > 0.45 && o < 0.6);
});

test('playerRate shrinks toward the game average and refuses thin samples', () => {
  const r = R.playerRate(0.9, 8, 'CS2');
  assert.ok(r.kpr < 0.9 && r.kpr > 0.667);
  assert.strictEqual(R.playerRate(0.9, 3, 'CS2'), null);
  assert.strictEqual(R.playerRate(3, 40, 'CS2'), null);
});

test('priceRounds clears only with a known lineup and the apps-on-Pinnacle number agreeing', () => {
  const ctx = { game: 'CS2', kpr: 0.8, qs: [0.5, 0.5] };
  const books = [{ book: 'PP', line: 29.5, evAt: p => (p / 0.5774 - 1) * 100 }];
  const p = { rounds: { ctx, pinCtx: { ...ctx, kpr: 0.78 }, lineup: 'known', mean: 34 } };
  const a = R.priceRounds(p, { books });
  assert.strictEqual(a.side, 'OVER');
  assert.ok(a.clears, JSON.stringify(a));
  assert.ok(!R.priceRounds({ rounds: { ...p.rounds, lineup: 'unknown' } }, { books }).clears);
  assert.ok(!R.priceRounds({ rounds: { ...p.rounds, pinCtx: { ...ctx, kpr: 0.6 } } }, { books }).clears);
  const play = R.roundsPlay({ ...p, sport: 'CS2', player: 'x', market: 'Maps 1-2 Kills' }, a);
  assert.strictEqual(play.bestEv, a.ev);
  assert.deepStrictEqual(play.roundsCtx, ctx);
});

test('bookRoundFairs prices BetRivers round lines off the map winner, else the match', () => {
  const lines = [{ key: 'rounds|1|total', scope: 'rounds', period: 1, type: 'total', x: -21.5 }, { key: 'rounds|2|spread', scope: 'rounds', period: 2, type: 'spread', x: -2.5 }];
  const lad = new Map([['map|1|ml', [{ x: 0, p: 0.5 }]], ['series|0|ml', [{ x: 0, p: 0.7 }]]]);
  const f = R.bookRoundFairs('CS2', lad, lines);
  assert.ok(Math.abs(f.get('rounds|1|total|-21.5').q - 0.5) < 0.01);
  // map 2 has no map price: the match at 70% read as a map, the favourite covers -2.5 more than half
  assert.ok(f.get('rounds|2|spread|-2.5').p > 0.5);
  assert.strictEqual(R.bookRoundFairs('LOL', lad, lines).size, 0);
});

test('roundsRecord counts team-maps, not rows', () => {
  const g = (team, outcome) => ({ status: 'graded', outcome, team, gameId: 1, market: 'Maps 1-2 Kills', signalSide: 'OVER', signalBook: 'PP', sport: 'CS2', profit: outcome === 'win' ? 1 : -1 });
  const rec = R.roundsRecord([g('A', 'win'), g('A', 'loss'), g('B', 'win')]);
  assert.strictEqual(rec.all.plays, 3);
  assert.strictEqual(rec.all.teamMaps, 2);
});

test('matchScale puts both teams on the game total, and needs both lineups', () => {
  const f = R.matchScale([0.8, 0.8, 0.8, 0.8, 0.8], [0.7, 0.7, 0.7, 0.7, 0.7], 'CS2');
  assert.ok(Math.abs(f * 7.5 - R.DEFAULTS.matchKpr.CS2) < 0.01);
  assert.strictEqual(R.matchScale([0.8, 0.8, 0.8, 0.8], [0.7, 0.7, 0.7, 0.7, 0.7], 'CS2'), null);
});
