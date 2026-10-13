const test = require('node:test');
const assert = require('node:assert/strict');

const E = require('../escal');
const C = require('../context');
const S = require('../slip');

const row = (sport, stat, side, outcome, prob = 57, extra = {}) => ({
  status: 'graded', sport, stat, signalSide: side, outcome, signalProb: prob, profit: outcome === 'win' ? 0.78 : -1, ...extra,
});

test('calibration: a bucket that went 0-5 at 57% loses about 8 points; an on-par bucket barely moves', () => {
  const rows = [
    ...Array.from({ length: 5 }, () => row('CS', 'kills', 'OVER', 'loss')),
    ...Array.from({ length: 6 }, (_, i) => row('CS', 'headshots', 'UNDER', i < 4 ? 'win' : 'loss', 60)),
    row('CS', 'kills', 'OVER', 'push'), { ...row('CS', 'kills', 'OVER', 'loss'), status: 'void' },
  ];
  const c = E.calibrate(rows);
  const b = c.bucket('CS', 'kills', 'OVER');
  assert.equal(b.n, 5, 'pushes and voids do not count');
  assert.equal(b.wins, 0);
  // (0 + 30·0.57)/35 − 0.57
  assert.ok(Math.abs(c.shift('CS', 'kills', 'OVER') - ((30 * 0.57) / 35 - 0.57)) < 1e-4);
  assert.ok(c.shift('CS', 'kills', 'OVER') < -0.08 && c.shift('CS', 'kills', 'OVER') > -0.09);
  assert.ok(Math.abs(c.shift('CS', 'headshots', 'UNDER')) < 0.02, '4-2 at 60% is about on par');
  assert.equal(c.shift('LOL', 'kills', 'OVER'), 0, 'no record, no shift');
});

test('calibration measures against the raw model probability, so it cannot feed on itself', () => {
  const rows = Array.from({ length: 10 }, () => row('CS', 'kills', 'UNDER', 'loss', 50, { rawProb: 60 }));
  const c = E.calibrate(rows);
  assert.equal(c.bucket('CS', 'kills', 'UNDER').predicted, 0.6);
});

test('calibration shift is capped and the adjusted probability stays inside 1..99', () => {
  const rows = Array.from({ length: 200 }, () => row('CS', 'kills', 'OVER', 'loss', 60));
  const c = E.calibrate(rows, { maxShift: 0.12 });
  assert.equal(c.shift('CS', 'kills', 'OVER'), -0.12);
  assert.equal(E.adjustPct(60, -0.12), 48);
  assert.equal(E.adjustPct(5, -0.12), 1);
  assert.equal(E.adjustPct(55, 0), 55);
});

test('slips re-price a calibrated leg with the same shift in every scenario', () => {
  const leg = { line: 27.5, side: 'OVER', meanPerMap: 14.5, k: 3.4, stat: 'kills' };
  const plain = S.legProbIn(leg, 2);
  assert.ok(Math.abs(S.legProbIn({ ...leg, shift: -0.08 }, 2) - (plain - 0.08)) < 1e-12);
});

test('matchContext: with no ratings, a player\'s usual map win rate is the baseline for his kill factor', () => {
  const book = C.createOddsBook();
  book.set({ sport: 'CS2', teamA: 'Underdogs', teamB: 'Giants', pA: 0.3 });
  const at50 = C.matchContext({ sport: 'CS2', team: 'Underdogs', opponent: 'Giants', maps: [1, 2] }, { oddsBook: book });
  const used = C.matchContext({ sport: 'CS2', team: 'Underdogs', opponent: 'Giants', maps: [1, 2], usual: 0.6 }, { oddsBook: book });
  assert.equal(at50.pTypical, 0.5);
  assert.equal(used.pTypical, 0.6);
  assert.ok(used.factor < at50.factor, 'a team that usually wins 60% of maps is further below its norm tonight');
});

const B = require('../esboard');
test('esports limit bid: the highest cent above the best bid that still clears the edge after the maker fee', () => {
  const o = B.DEFAULTS;
  // Kalshi 24/28 with the fair at 36.5: take is +24% already, so test the plan on a pricier ask
  const plan = B.bidPlan({ bid: 0.24, ask: 0.40, edge: undefined }, 0.365, 'kalshi', o);
  assert.ok(plan, 'a plan exists');
  assert.ok(plan.price >= 0.25 && plan.price <= 0.39);
  assert.ok(plan.ev >= o.edgeMin);
  // one cent higher would not clear it
  const fee = p => 0.25 * o.kalshiFeeRate * p * (1 - p);
  const up = Math.round((plan.price + 0.01) * 100) / 100;
  assert.ok(up >= 0.40 || (0.365 - (up + fee(up))) / (up + fee(up)) < o.edgeMin || 0.365 - (up + fee(up)) < o.minEdgeCents);
  // a one-cent book has no room, a take edge needs no bid, a fair under the bid gets none
  assert.equal(B.bidPlan({ bid: 0.30, ask: 0.31 }, 0.365, 'kalshi', o), null);
  assert.equal(B.bidPlan({ bid: 0.24, ask: 0.28, edge: true }, 0.365, 'kalshi', o), null);
  assert.equal(B.bidPlan({ bid: 0.40, ask: 0.46 }, 0.39, 'kalshi', o), null);
});

test('Best Plays shows a limit bid as half a take, under esports edges', () => {
  const { bestPlays } = require('../bestplays');
  const NOW = Date.parse('2026-10-12T12:00:00Z');
  const m = { id: 'CS2:a-b', game: 'CS2', label: 'A vs B', teams: ['A', 'B'], start: new Date(NOW + 3600e3).toISOString(), edges: [], links: { kalshi: 'https://kalshi.com/x' }, markets: [],
    bids: [{ market: 'match', kind: 'match', outcome: 'B', venue: 'kalshi', price: 0.33, cost: 0.3337, fair: 0.365, ev: 0.0938, ask: 0.40, bid: 0.30 }] };
  const row = bestPlays({ matches: [m] }, { now: NOW }).rows.find(r => r.id.startsWith('bid:'));
  assert.ok(row);
  assert.equal(row.kind, 'esportsEdge');
  assert.match(row.bet, /^Bid 33c on B/);
  assert.ok(row.units > 0 && row.units <= 0.5);
});
