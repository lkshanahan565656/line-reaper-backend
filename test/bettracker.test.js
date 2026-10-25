// The bet tracker (10-25): pick'em slips settle at the app's table from their
// legs, totals by app and sport, odds-screen bets carry a line track.
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../slips');
const B = require('../bets');

const NOW = Date.parse('2026-10-25T12:00:00Z');
const leg = (player, outcome, extra = {}) => ({ player, side: 'Over', line: 10.5, market: 'Points', sport: 'NBA', ...extra, _o: outcome });
// grades keyed the way slipView reads them
function view(slip, outs, gExtra = {}) {
  const grades = {};
  slip.legs.forEach((l, i) => {
    const o = outs[i];
    grades[S.legKey(slip, l)] = o === undefined ? undefined : o === 'void' ? { status: 'void', final: true }
      : o === 'open' ? { status: 'open' } : { status: 'graded', outcome: o, closeEv: 4, closeFair: 0.58, closeOk: true, final: true, matched: { sport: 'NBA', start: '2026-10-25T23:00:00Z', matchTitle: `G${i}` }, ...gExtra };
  });
  return S.slipView(slip, grades);
}
const mk = (app, n, o = {}) => S.makeSlip({ app, legs: Array.from({ length: n }, (_, i) => leg(`P${i}`)), now: NOW, ...o });

test('makeSlip builds a slip a board tray hands over, and refuses a bad leg', () => {
  const s = mk('prizepicks', 3, { stake: 10 });
  assert.equal(s.legs.length, 3);
  assert.equal(s.stake, 10);
  assert.equal(s.source, 'board');
  assert.equal(S.makeSlip({ app: 'prizepicks', legs: [{ player: 'x', line: 'nope', market: 'Pts' }] }), null);
  assert.equal(S.makeSlip({ app: 'fanduel', legs: [leg('a')] }), null);
});

test('a power slip pays its table when every pick hits, loses on the first miss', () => {
  const s = mk('prizepicks', 3, { stake: 10 });
  let v = view(s, ['win', 'win', 'win']);
  assert.equal(v.result, 'win'); assert.equal(v.multiple, 6); assert.equal(v.returned, 60);
  v = view(s, ['loss', 'open', 'open']);
  assert.equal(v.result, 'loss'); assert.equal(v.returned, 0);
  v = view(s, ['win', 'open', 'win']);
  assert.equal(v.result, 'open');
});

test('a voided pick drops the slip to the smaller table; under two picks it is refunded', () => {
  const s = mk('prizepicks', 3, { stake: 10 });
  let v = view(s, ['win', 'void', 'win']);
  assert.equal(v.live, 2); assert.equal(v.multiple, 3); assert.equal(v.returned, 30); assert.equal(v.result, 'win');
  v = view(mk('prizepicks', 2, { stake: 10 }), ['win', 'void']);
  assert.equal(v.result, 'void'); assert.equal(v.returned, 10);
  // a tie at the line counts like a void
  v = view(s, ['win', 'push', 'win']);
  assert.equal(v.multiple, 3);
});

test('a flex slip pays its table at the hits', () => {
  const s = mk('prizepicks', 5, { stake: 10, flex: true });
  let v = view(s, ['win', 'win', 'win', 'win', 'loss']);
  assert.equal(v.result, 'paid'); assert.equal(v.multiple, 2); assert.equal(v.returned, 20);
  v = view(s, ['win', 'win', 'loss', 'loss', 'loss']);
  assert.equal(v.result, 'loss'); assert.equal(v.returned, 0);
  v = view(s, ['win', 'win', 'win', 'loss', 'loss']);
  assert.equal(v.result, 'paid'); assert.equal(v.multiple, 0.4);
  // in MY BETS: a paid slip, profit from the dollars back
  const b = B.fromSlip(view(s, ['win', 'win', 'win', 'win', 'loss']));
  assert.equal(b.result, 'paid'); assert.equal(b.cashout, 20); assert.equal(B.profit(b), 10);
  const st = B.stats([b]);
  assert.equal(st.record, '1-0'); assert.equal(st.profit, 10);
});

test("the user's own payout and result win", () => {
  const s = { ...mk('underdog', 3, { stake: 5 }), payout: 40 };
  let v = view(s, ['win', 'win', 'win']);
  assert.equal(v.returned, 40);
  v = view({ ...s, result: 'loss' }, ['win', 'win', 'win']);
  assert.equal(v.result, 'loss'); assert.equal(v.by, 'user');
  // a won slip whose pick voided paid the smaller table, not the user's full payout
  const b = B.fromSlip(view(s, ['win', 'void', 'win']));
  assert.equal(b.result, 'paid'); assert.equal(b.cashout, 17.5);
});

test('slip totals by app and sport: record, money, units, ROI and the close', () => {
  const a = view(mk('prizepicks', 2, { stake: 10 }), ['win', 'win']);
  const b = view(mk('prizepicks', 2, { stake: 10 }), ['loss', 'win']);
  const c = view(mk('underdog', 2, { stake: 20 }), ['open', 'open']);
  const rows = S.slipTotals([a, b, c], 'app', { unitUsd: 10 });
  const pp = rows.find(r => r.key === 'PrizePicks');
  assert.equal(pp.record, '1-1'); assert.equal(pp.staked, 20); assert.equal(pp.profit, 10); assert.equal(pp.units, 1); assert.equal(pp.roi, 0.5);
  assert.equal(pp.slipsClosed, 2); assert.equal(pp.legsPriced, 4); assert.equal(pp.legBeatShare, 1);
  assert.equal(rows.find(r => r.key === 'Underdog').open, 1);
  assert.equal(S.slipTotals([a, b], 'sport')[0].key, 'NBA');
  const sum = S.summary([a, b, c]);
  assert.equal(sum.settled, 2); assert.equal(sum.profit, 10); assert.equal(sum.roi, 0.5);
});

test('same-game legs are counted, so the page can say the close treats them as independent', () => {
  const s = mk('prizepicks', 3, { stake: 10 });
  const v = view(s, ['win', 'win', 'win'], { matched: { sport: 'NBA', start: '2026-10-25T23:00:00Z', matchTitle: 'LAL @ BOS' } });
  assert.equal(v.sameGame, 3);
});

test('an odds-screen side becomes a prefilled bet with a line track', () => {
  const game = { id: 'pin-1', league: 'nfl', leagueLabel: 'NFL', start: '2026-10-26T17:00:00Z', home: 'Dallas Cowboys', away: 'New York Giants' };
  const market = { key: 'spread', point: -3 };
  const side = { name: 'New York Giants', label: 'New York Giants +3', fair: 0.5, venues: [{ venue: 'kalshi', name: 'Kalshi', decimal: 2.05, best: true }, { venue: 'fanduel', name: 'FanDuel', decimal: 1.91 }] };
  const p = B.fromLine(game, market, side);
  assert.equal(p.book, 'Kalshi'); assert.equal(p.odds, 2.05); assert.equal(p.tool, 'Odds screen'); assert.equal(p.logFair, 0.5);
  assert.deepEqual(p.track, { kind: 'line', game: 'pin-1', league: 'nfl', market: 'spread', side: 'New York Giants', point: -3, start: '2026-10-26T17:00:00Z' });
  const p2 = B.fromLine(game, market, side, side.venues[1]);
  assert.equal(p2.book, 'FanDuel');
  const bet = B.make({ ...p, stake: 50 }, { now: NOW });
  assert.equal(bet.logFair, 0.5); assert.equal(bet.track.kind, 'line');
  // the server's follow: Pinnacle now, then the close and the final
  let { list } = B.applyTracked([bet], { [bet.id]: { close: { status: 'open', fair: 0.52 } } });
  assert.equal(B.clvNow(list[0]), Math.round((2.05 * 0.52 - 1) * 1e4) / 1e4);
  ({ list } = B.applyTracked(list, { [bet.id]: { close: { status: 'closed', fair: 0.55, closeOk: true, outcome: 'win' }, closeOdds: 1 / 0.55, result: 'win' } }));
  assert.equal(list[0].result, 'win'); assert.equal(list[0].settledBy, 'auto');
  assert.ok(Math.abs(B.clv(list[0]) - (2.05 * 0.55 - 1)) < 1e-3);
  assert.equal(B.clvNow(list[0]), null);
});
