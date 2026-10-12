const test = require('node:test');
const assert = require('node:assert/strict');
const { bestPlays, kellyUnits, DEFAULTS } = require('../bestplays');
const { scoreboard } = require('../results');

const NOW = Date.parse('2026-10-12T12:00:00Z');
const iso = dt => new Date(NOW + dt).toISOString();

const sig = (id, o = {}) => ({
  id, type: 'entry', wallet: `w${id}`, asset: `a${id}`, grade: 'A', category: 'sports', market: `Market ${id}`, outcome: 'Yes',
  theirPrice: 0.5, q: 0.58, at: iso(-10 * 60e3), seenAt: iso(-10 * 60e3), units: 1, reason: null, blocked: null, isConsensus: false,
  venue: { key: 'kalshi', name: 'Kalshi', buy: 'YES Team', price: 0.52, fee: 0.01, cost: 0.53, units: 1, maxPrice: 0.55, url: 'https://kalshi.com/x' },
  ...o,
});
const tailRec = (i, o) => ({ id: `t${i}`, status: 'settled', recordedAt: iso(-86400e3), grade: 'A', category: 'sports', venue: 'Kalshi', units: 1, ...o });

test('quarter Kelly on a contract: (p - c) / (1 - c), rounded down to a quarter unit, capped', () => {
  // p .60, c .50: f = .2, ¼ × .2 × 100 = 5u → capped at 1
  assert.equal(kellyUnits(0.6, 0.5, 1, DEFAULTS), 1);
  // p .52, c .50: f = .04 → 1u
  assert.equal(kellyUnits(0.52, 0.5, 2, DEFAULTS), 1);
  // p .505, c .50: f = .01 → 0.25u
  assert.equal(kellyUnits(0.505, 0.5, 2, DEFAULTS), 0.25);
  assert.equal(kellyUnits(0.5, 0.5, 2, DEFAULTS), 0);
});

test('Sharp Tail entries: sized, fresh, not sold, not started', () => {
  const signals = [
    sig('ok'),
    sig('old', { seenAt: iso(-3 * 3600e3), at: iso(-3 * 3600e3) }),
    sig('ran', { units: 0, reason: "price ran, don't chase", venue: { ...sig('x').venue, units: 0 } }),
    sig('started', { gameStartTime: iso(-60e3) }),
    sig('sold'),
    { id: 'exit', type: 'exit', wallet: 'wsold', asset: 'asold', at: iso(-60e3) },
    sig('novenue', { venue: null }),
  ];
  const { rows } = bestPlays({ signals }, { now: NOW });
  assert.deepEqual(rows.map(r => r.id), ['tail:ok']);
  const r = rows[0];
  assert.equal(r.venue, 'Kalshi');
  assert.equal(r.units, 1);
  assert.equal(r.maxPrice, 0.55);
  // q / all-in cost − 1
  assert.equal(r.ev, Math.round((0.58 / 0.53 - 1) * 1e4) / 1e4);
  assert.equal(r.verdict, 'early');
});

test('the results decide: avoid play types drop out, proven ones rank first', () => {
  const recs = [
    // A grade sports: proven on CLV
    ...Array.from({ length: 22 }, (_, i) => tailRec(i, { grade: 'A', category: 'sports', profit: i % 2 ? 0.9 : -1, clv: 0.05 + (i % 4) * 0.01 })),
    // B grade politics: losing to the close
    ...Array.from({ length: 10 }, (_, i) => tailRec(100 + i, { grade: 'B', category: 'politics', profit: -1, clv: -0.04 - (i % 2) * 0.01 })),
  ];
  const { plays } = scoreboard({ tail: recs });
  const signals = [
    sig('proven', { q: 0.55 }),
    sig('bad', { grade: 'B', category: 'politics', q: 0.9 }),
    // B grade is losing as a whole, whatever the category
    sig('bcrypto', { grade: 'B', category: 'crypto', q: 0.7 }),
    // A grade is proven, so a new category still ranks in the proven tier, by edge
    sig('acrypto', { category: 'crypto', q: 0.6 }),
  ];
  const out = bestPlays({ signals, plays }, { now: NOW });
  assert.deepEqual(out.rows.map(r => r.id), ['tail:acrypto', 'tail:proven']);
  assert.equal(out.rows[1].verdict, 'proven');
  assert.match(out.rows[1].why.join(' '), /proven \(Sharp Tail: A grade · sports/);
  assert.equal(out.dropped.length, 2);
  assert.deepEqual(out.dropped.map(d => d.play), ['B grade', 'B grade']);
});

test('esports edges are sized by quarter Kelly; arbs rank with the proven tier', () => {
  const matches = [{
    id: 'm1', game: 'CS2', label: 'NaVi vs G2', teams: ['NaVi', 'G2'], start: iso(3600e3), live: false, links: { kalshi: 'https://kalshi.com/m1' },
    markets: [{ key: 'match', kind: 'match' }],
    edges: [{ market: 'match', kind: 'match', outcome: 'NaVi', venue: 'kalshi', cost: 0.5, fair: 0.53, ev: 0.06 }],
    arbs: [{ market: 'match', legs: [{ venue: 'kalshi', outcome: 'NaVi', cost: 0.48 }, { venue: 'polymarket', outcome: 'G2', cost: 0.5 }], profitPct: 0.0204, tight: true }],
  }, {
    id: 'm2', game: 'CS2', label: 'Live one', teams: ['A', 'B'], start: iso(-60e3), live: true, links: {}, markets: [],
    edges: [{ market: 'match', kind: 'match', outcome: 'A', venue: 'kalshi', cost: 0.4, fair: 0.5, ev: 0.25 }], arbs: [],
  }];
  const arbs = [{ id: 'x1', title: 'Chiefs vs Bills', category: 'sports', profitPct: 1.5, totalCost: 0.985, legs: [{ venue: 'kalshi', venueTitle: 'Kalshi', pick: 'Chiefs' }, { venue: 'fanduel', venueTitle: 'FanDuel', pick: 'Bills' }], stakes: { legs: [{ pct: 51 }, { pct: 49 }] } }];
  const out = bestPlays({ matches, arbs }, { now: NOW });
  assert.deepEqual(out.rows.map(r => r.kind), ['arb', 'arb', 'esportsEdge']);
  // xarb's profitPct is in percent, the board's is a fraction: both end as a fraction
  assert.equal(out.rows[0].ev, 0.0204);
  assert.equal(out.rows[1].ev, 0.015);
  assert.match(out.rows[1].bet, /Kalshi: Chiefs \(51% of stake\)/);
  const edge = out.rows[2];
  // f = .03 / .5 = .06 → ¼ × 6 = 1.5u, capped at 1u until proven
  assert.equal(edge.units, 1);
  assert.equal(edge.venue, 'Kalshi');
  assert.equal(out.counts.esportsEdge, 1);
});

test('esports props: 1u, need 2% EV and a future start, avoid types drop', () => {
  const pick = (player, o = {}) => ({ sport: 'CS2', player, team: 'T', market: 'Maps 1-2 Kills', ppLine: 30.5, udLine: 31, side: 'OVER', prob: 60.1, modelPred: 33.2, bestEv: 5, bestBook: 'PP', startTime: iso(3600e3), ...o });
  const picks = [pick('good'), pick('thin', { bestEv: 1 }), pick('gone', { startTime: iso(-60e3) }), pick('ud', { bestBook: 'UD', bestEv: 8 }), pick('locked', { locked: true })];
  const out = bestPlays({ picks }, { now: NOW });
  assert.deepEqual(out.rows.map(r => r.title), ['ud (T)', 'good (T)']);
  assert.equal(out.rows[0].venue, 'Underdog');
  assert.match(out.rows[0].bet, /More than 31 /);
  assert.equal(out.rows[1].units, 1);
  // a losing stat-side play type drops
  const bad = Array.from({ length: 10 }, (_, i) => ({ id: `p${i}`, status: 'graded', startTime: iso(-86400e3), sport: 'CS', stat: 'kills', signalSide: 'OVER', outcome: 'loss', profit: -1 }));
  const { plays } = scoreboard({ esportsPicks: bad });
  assert.equal(bestPlays({ picks, plays }, { now: NOW }).rows.length, 0);
});

test('sports props read like a bet: Kalshi-matched markets get plain names', () => {
  const { bestPlays } = require('../bestplays');
  const start = new Date(Date.now() + 3600e3).toISOString();
  const row = (market, point, side) => ({ dfs: true, ev: 4, start, book: 'underdog', sharpBooks: ['kalshi_props'], group: `g|${market}`, side, point, market, sport: 'NFL', player: 'Davante Adams', fairProb: 58 });
  const out = bestPlays({ props: [row('anytime_td', 0.5, 'Over'), row('rush_rec_yds', 59.5, 'Under')] });
  const bets = out.rows.filter(r => r.kind === 'sportsProp').map(r => r.bet).sort();
  assert.deepEqual(bets, ['Less than 59.5 rush + rec yards', 'Scores a touchdown']);
});

test('sportsbook lines: fresh, above fair, not started, sized by quarter Kelly and named by book', () => {
  const line = (id, o = {}) => ({
    group: `g${id}|h2h`, sport: 'nfl', event: 'Bills @ Jets', start: iso(3 * 3600e3), market: 'h2h', player: null, point: null,
    side: 'Bills', book: 'draftkings', price: 120, decimal: 2.2, fairProb: 47.5, fairPrice: 111, ev: 4.5, source: 'sharp',
    sharpBooks: ['pinnacle'], books: 6, updated: iso(-10 * 60e3), ...o,
  });
  const lines = [
    line('ok'),
    line('tot', { market: 'totals', side: 'Over', point: 44.5, book: 'fanduel', ev: 3 }),
    line('thin', { ev: 1 }),
    line('wild', { ev: 25 }),
    line('stale', { updated: iso(-2 * 3600e3) }),
    line('started', { start: iso(-60e3) }),
    line('dfs', { dfs: true }),
    line('prop', { player: 'Josh Allen' }),
    line('fewbooks', { source: 'consensus', sharpBooks: [], books: 2 }),
  ];
  const { rows, counts } = bestPlays({ lines }, { now: NOW });
  assert.deepEqual(rows.map(r => r.id), ['line:gok|h2h|Bills|draftkings', 'line:gtot|h2h|Over|fanduel']);
  assert.equal(counts.bookLine, 2);
  const [r, t] = rows;
  assert.equal(r.venue, 'DraftKings');
  assert.equal(r.american, 120);
  assert.equal(r.bet, 'Bills');
  assert.equal(r.ev, 0.045);
  // p .475 at decimal 2.2: f = (.475 - 1/2.2) / (1 - 1/2.2) ≈ .0375 → ¼ × 3.75 = 0.75u
  assert.equal(r.units, 0.75);
  assert.match(r.why[0], /fair \+111 \(47.5%\) from Pinnacle, DraftKings pays \+120/);
  assert.equal(t.bet, 'Over 44.5');
  assert.equal(t.label, 'NFL total');
});
