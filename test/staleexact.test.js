const test = require('node:test');
const assert = require('node:assert/strict');
const X = require('../staleexact');
const closeBoard = require('../closeboard');

const START = '2026-10-25T17:00:00Z';
const PP = 1 / 0.5503;
let n = 0;
// a stale leg as the props record keeps it
function leg({ book = 'prizepicks', side = 'Under', line = 50.5, pinFlag = line, pinClose = line, fair = 0.58, outcome = 'win', status = 'graded', kind = 'stale-single', start = START, player = `P${n++}`, mkey = 'rec_yds', dec = PP, execOk = true, matchTitle = 'BUF @ KC', sport = 'NFL' } = {}) {
  const pinExact = status === 'open' ? undefined : pinClose === line;
  return { id: `${player}|${mkey}|${book}|${kind}`, kind, book, sport, player, mkey, market: 'Receiving Yards', matchTitle, start, signalAt: '2026-10-25T15:00:00Z', signalSide: side, signalLine: line,
    signalDecimal: dec, signalPinLine: pinFlag, closePinLine: pinClose, closePinFair: fair, closePinEv: pinExact ? Math.round((fair * dec - 1) * 1e4) / 100 : null,
    pinExact, status, outcome: status === 'graded' ? outcome : undefined, execOk };
}

test('the check counts live legs at Pinnacle\'s number apart from the backfit, one per player stat', () => {
  const legs = [
    leg({ player: 'A', outcome: 'win' }),
    leg({ player: 'A', kind: 'stale', outcome: 'win' }),          // the same bet flagged confirmed too
    leg({ player: 'B', outcome: 'loss', side: 'Over' }),
    leg({ player: 'C', pinFlag: 51.5 }),                           // Pinnacle elsewhere at the flag: our curve, not this kind
    leg({ player: 'D', pinClose: 52.5, outcome: 'loss' }),         // Pinnacle left the number before the start
    leg({ player: 'E', status: 'open' }),
    leg({ player: 'F', start: '2026-10-20T17:00:00Z' }),           // a backfit game
    { ...leg({ player: 'G' }), kind: 'sharp' },                    // another kind
  ];
  const r = X.report(legs, { now: Date.parse('2026-10-25T23:00:00Z') });
  assert.equal(r.live.added, 4, 'A, B, D, E');
  assert.equal(r.live.open, 1);
  assert.equal(r.live.exact, 2);
  assert.equal(r.live.left, 1);
  const pp = r.live.books.prizepicks;
  assert.equal(pp.graded, 2);
  assert.equal(pp.wins, 1);
  assert.equal(pp.breakEven, 55);
  assert.equal(pp.units, Math.round((PP - 2) * 100) / 100);
  assert.equal(pp.verdict, 'too early');
  assert.equal(pp.sides.Under.wins, 1);
  assert.equal(pp.sides.Over.losses, 1);
  assert.equal(pp.leftResults.losses, 1, 'the leg Pinnacle left is shown with its result');
  assert.equal(r.live.days.length, 1);
  assert.equal(r.live.days[0].day, '2026-10-25');
  assert.equal(r.backfit.books.prizepicks.w, 67);
  assert.equal(r.open, undefined, 'open legs only with Pro');
  assert.equal(X.report(legs, { showOpen: true }).open.length, 1);
});

test('the verdict at 50: CLV t 2+, results not 1.5 sd under the close, and profit shown', () => {
  // 60 legs at a +6% raw close that win 58%: pass
  const good = Array.from({ length: 60 }, (_, i) => leg({ player: `W${i}`, fair: 0.58 + (i % 5) * 0.002, outcome: i % 50 < 29 ? 'win' : 'loss' }));
  const g = X.report(good).live.books.prizepicks;
  assert.equal(g.graded, 60);
  assert.ok(g.clvT >= 2, `t ${g.clvT}`);
  assert.equal(g.verdict, 'pass', g.why);
  // the same close, but they win 45%: under break-even and short of the close
  const bad = Array.from({ length: 60 }, (_, i) => leg({ player: `L${i}`, fair: 0.58 + (i % 5) * 0.002, outcome: i % 20 < 9 ? 'win' : 'loss' }));
  const b = X.report(bad).live.books.prizepicks;
  assert.equal(b.verdict, 'fail');
  assert.match(b.why, /no profit/);
  assert.match(b.why, /under the close/);
  assert.ok(b.zVsBreakEven < 0);
});

test('each app on its own; a match stat both players share is one bet', () => {
  const legs = [
    leg({ book: 'underdog', player: 'Sinner', mkey: 'games_played', sport: 'TENNIS', matchTitle: 'Sinner vs Alcaraz', line: 38.5, dec: 1.78 }),
    leg({ book: 'underdog', player: 'Alcaraz', mkey: 'games_played', sport: 'TENNIS', matchTitle: 'Sinner vs Alcaraz', line: 38.5, dec: 1.78 }),
    leg({ book: 'pick6', player: 'Q', kind: 'p6-stale-single', dec: 1.817 }),
  ];
  const r = X.report(legs);
  assert.equal(r.live.books.underdog.graded, 1);
  assert.equal(r.live.books.underdog.breakEven, 56.2);
  assert.equal(r.live.books.pick6.graded, 1);
  assert.equal(r.live.sports.TENNIS.graded, 1);
  // the scoreboard clusters it the same way, and scores Pick6's exact legs on their own row
  const board = closeBoard.scoreboard({ props: legs.map(b => ({ ...b, closeOk: true, closeEv: 3, closeFair: 0.57 })) });
  assert.equal(board.rows.find(r => r.kind === 'props-stale-exact' && r.book === 'underdog').graded, 1);
  assert.equal(board.rows.find(r => r.kind === 'props-stale-exact' && r.book === 'pick6').graded, 1);
  const p6 = board.rows.find(r => r.kind === 'props-p6-stale-single');
  assert.ok(p6, 'Pick6 stale legs have a row');
  assert.match(p6.note, /Never proven/);
});
