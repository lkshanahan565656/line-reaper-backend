// Closing-line value: price-history parsing, when a market's line closes, a
// bet's CLV and the stake-weighted summary. The engine's use of these (only
// for wallets good enough, one cached call a token) is in tail.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../tail');

const NOW = Date.parse('2026-10-08T12:00:00Z');
const DAY = 86400e3, H = 3600e3, MIN = 60e3;
const near = (a, b, eps = 1e-9, msg = '') => assert.ok(Math.abs(a - b) <= eps, `${msg} ${a} ≈ ${b}`);
const iso = ms => new Date(ms).toISOString();

test('price history: every point shape and wrapper parses; junk dropped; oldest first; paging flagged', () => {
  const t0 = 1759924800;   // unix seconds
  const want = [{ t: t0 * 1000, p: 0.41 }, { t: (t0 + 300) * 1000, p: 0.42 }];
  const shapes = [
    [{ t: t0, p: 0.41 }, { t: t0 + 300, p: '0.42' }],                                                  // bare { t, p }
    { data: [{ timestamp: t0 + 300, price: 0.42 }, { timestamp: t0, price: 0.41 }] },                  // newest first
    { data: { history: [{ ts: t0 * 1000, price: '0.41' }, { ts: (t0 + 300) * 1000, price: 0.42 }] } }, // ms, nested
    { history: [[t0, 0.41], [String(t0 + 300), '0.42']] },                                             // [t, p]
    { data: [[iso(t0 * 1000), 0.41], [t0 + 300, 0.42]], pagination: { has_more: false, next_cursor: null } },
  ];
  for (const payload of shapes) {
    const r = T.parsePriceHistory(payload);
    assert.deepEqual(r, { points: want, truncated: false }, JSON.stringify(payload).slice(0, 70));
  }
  const junk = [{ t: t0, p: 1.5 }, { t: null, p: 0.4 }, { p: 0.4 }, 'x', null, [t0], { t: t0 + 600, p: 0.5 }, { t: t0 + 600, p: 0.5 }, { t: t0 + 900, p: 0 }];
  assert.deepEqual(T.parsePriceHistory(junk).points, [{ t: (t0 + 600) * 1000, p: 0.5 }, { t: (t0 + 900) * 1000, p: 0 }], 'a settled 0 is a price');
  // the live v2 shape: the last point of a settled market is its resolution, not a trade
  const live = { data: [{ timestamp: t0, price: 0.41, resolution_seconds: 300 }, { timestamp: t0 + 300, price: 0.42, resolution_seconds: 300 }, { timestamp: t0 + 600, price: 0, resolution_seconds: 0 }],
    pagination: { limit: 1000, offset: 0, has_more: false, next_cursor: null } };
  assert.deepEqual(T.parsePriceHistory(live), { points: want, truncated: false });
  assert.equal(T.parsePriceHistory({ data: want, pagination: { has_more: true, next_cursor: 'abc' } }).truncated, true);
  assert.equal(T.parsePriceHistory({ data: { history: want, pagination: { has_more: true, next_cursor: 'abc' } } }).truncated, true);
  assert.deepEqual(T.parsePriceHistory({ data: null }), { points: [], truncated: false });
  assert.deepEqual(T.parsePriceHistory({ error: 'rate limited' }), { points: [], truncated: false });
  assert.throws(() => T.parsePriceHistory({ error: 'rate limited' }, { strict: true }), /prices history: unexpected response/);
  assert.throws(() => T.parsePriceHistory('<html>', { strict: true }), /\(string\)/);
});

test('closing price: a game closes at its start; anything else when the outcome got out, or at its end', () => {
  const start = NOW - 2 * DAY;
  const pts = list => list.map(([mins, p]) => ({ t: start + mins * MIN, p }));
  // a game: the last price before the start, never an in-play one
  const game = pts([[-600, 0.40], [-300, 0.44], [-5, 0.46], [0, 0.47], [30, 0.80], [120, 0.99]]);
  assert.deepEqual(T.closingPrice(game, { closeAt: start }), { price: 0.46, at: start - 5 * MIN, cut: start });
  assert.deepEqual(T.closingPrice([...game].reverse(), { closeAt: start }).price, 0.46, 'order does not matter');
  // and it has to be close to the start
  assert.equal(T.closingPrice(pts([[-48 * 60, 0.4]]), { closeAt: start, maxGapMs: 24 * H }), null);
  assert.equal(T.closingPrice(pts([[-23 * 60, 0.4]]), { closeAt: start, maxGapMs: 24 * H }).price, 0.4);
  // anything else: the last price before it first reached 97¢+ ...
  const fed = pts([[0, 0.55], [60, 0.6], [120, 0.62], [180, 0.975], [240, 0.9], [300, 0.999]]);
  assert.deepEqual(T.closingPrice(fed, { closeAt: start + DAY, freeze: true }), { price: 0.62, at: start + 120 * MIN, cut: start + 180 * MIN });
  // ... or 3¢-
  assert.equal(T.closingPrice(pts([[0, 0.3], [60, 0.2], [120, 0.03], [180, 0]]), { closeAt: start + DAY, freeze: true }).price, 0.2);
  // ... or its end, when it never got out
  const drift = pts([[0, 0.5], [60, 0.52], [25 * 60, 0.6]]);
  assert.deepEqual(T.closingPrice(drift, { closeAt: start + DAY, freeze: true }), { price: 0.52, at: start + 60 * MIN, cut: start + DAY });
  // already out when the window opens: no closing line
  assert.equal(T.closingPrice(pts([[0, 0.98], [60, 0.4]]), { closeAt: start + DAY, freeze: true }), null);
  // a cut-off series that never got out can't say what came after it; one that got out inside it can
  assert.equal(T.closingPrice(pts([[0, 0.5]]), { closeAt: start + DAY, freeze: true, truncated: true }), null);
  assert.equal(T.closingPrice(fed, { closeAt: start + DAY, freeze: true, truncated: true }).price, 0.62);
  assert.equal(T.closingPrice([], { closeAt: start }), null);
  assert.equal(T.closingPrice(null, { closeAt: start }), null);
});

test('closing window: a game ends at Gamma\'s start; a game with no start has none; others end at their close, end date or now', () => {
  const span = Math.min(7 * DAY, 1000 * 300e3);   // 7 days of 5-minute buckets is 2,016: cut to the 1,000 one call returns
  const kickoff = Date.parse('2026-10-06T23:30:00Z');
  const pos = { asset: 'tok', price: 0.4, category: 'sports', title: 'Lakers vs. Celtics', endAt: NOW - DAY };
  const game = T.parseGammaMarket({ conditionId: 'c', question: 'Lakers vs. Celtics', gameStartTime: '2026-10-06T23:30:00Z', endDate: '2026-10-07T04:00:00Z' });
  assert.deepEqual(T.clvWindow(pos, game, { now: NOW }), { start: kickoff - span, end: kickoff, rule: 'game' });
  assert.equal(T.clvWindow(pos, null, { now: NOW }), null, 'no market: its start is unknown, and in-play prices are not a close');
  assert.equal(T.clvWindow(pos, T.parseGammaMarket({ question: 'Lakers vs. Celtics' }), { now: NOW }), null, 'a head-to-head with no start time');
  assert.equal(T.clvWindow(pos, T.parseGammaMarket({ question: 'Lakers -4.5', sportsMarketType: 'spreads' }), { now: NOW }), null);
  // a season-long sports future has no game: it closes like anything else
  const finals = T.parseGammaMarket({ question: 'Will the Lakers win the 2026 NBA Finals?', closedTime: '2026-06-20 02:10:00+00' });
  assert.deepEqual(T.clvWindow({ ...pos, title: 'NBA Champion' }, finals, { now: NOW }), { start: Date.parse('2026-06-20T02:10:00Z') - span, end: Date.parse('2026-06-20T02:10:00Z'), rule: 'freeze' });
  // other markets: the earliest of the market's close time, its end date and now
  const pol = { asset: 'p', price: 0.5, category: 'politics', endAt: NOW - 3 * DAY };
  assert.equal(T.clvWindow(pol, null, { now: NOW }).end, NOW - 3 * DAY);
  assert.equal(T.clvWindow({ ...pol, endAt: NOW + 30 * DAY }, null, { now: NOW }).end, NOW, 'resolved early, no close time known');
  assert.equal(T.clvWindow({ ...pol, endAt: NOW + 30 * DAY }, T.parseGammaMarket({ closedTime: iso(NOW - 5 * DAY) }), { now: NOW }).end, NOW - 5 * DAY);
  assert.equal(T.clvWindow({ ...pol, endAt: null }, T.parseGammaMarket({ endDate: iso(NOW - 2 * DAY) }), { now: NOW }).end, NOW - 2 * DAY, 'the market\'s end date');
  assert.equal(T.clvWindow({ price: 0.5 }, null, { now: NOW }), null, 'no token');
  assert.equal(T.clvWindow(pos, T.parseGammaMarket({ gameStartTime: iso(NOW + H) }), { now: NOW }), null, 'not started yet');
  const short = T.clvWindow(pol, null, { now: NOW, opts: { clvWindowDays: 1 } });
  assert.equal(short.end - short.start, DAY);
});

test('a bet\'s CLV is (close − entry) / entry on the token held; bought after the line stopped counting, it has none', () => {
  const close = { price: 0.46, at: NOW - 5 * MIN, cut: NOW, rule: 'game' };
  const pos = { asset: 'tok', conditionId: 'c', category: 'sports', title: 'Lakers vs. Celtics', price: 0.4, risked: 1000, enteredAt: NOW - DAY };
  const x = T.clvOf(pos, close);
  near(x.clv, 0.15);
  assert.deepEqual({ ...x, clv: null }, {
    asset: 'tok', conditionId: 'c', category: 'sports', title: 'Lakers vs. Celtics', risked: 1000, entry: 0.4, close: 0.46,
    closeAt: iso(NOW - 5 * MIN), cutAt: iso(NOW), rule: 'game', clv: null,
  });
  near(T.clvOf({ ...pos, price: 0.5 }, close).clv, -0.08, 1e-9, 'the close went against it');
  assert.equal(T.clvOf({ ...pos, enteredAt: NOW + MIN }, close), null, 'bought in play');
  assert.ok(T.clvOf({ ...pos, enteredAt: null }, close), 'no entry time: taken as before');
  assert.equal(T.clvOf(pos, null), null);
  assert.equal(T.clvOf({ ...pos, price: 1 }, close), null);
});

test('CLV summary: stake-weighted average, share that beat the close, n; the most recent bets are sampled', () => {
  const s = T.clvStats([{ clv: 0.1, risked: 3000 }, { clv: -0.1, risked: 1000 }, { clv: 0.02, risked: 1000 }, { clv: NaN, risked: 5 }, null]);
  near(s.avg, (300 - 100 + 20) / 5000);
  assert.deepEqual({ n: s.n, hitRate: s.hitRate }, { n: 3, hitRate: 2 / 3 });
  near(T.clvStats([{ clv: 0.1 }, { clv: 0 }]).avg, 0.05, 1e-12, 'no stakes: a plain mean');
  assert.deepEqual(T.clvStats([]), { n: 0, avg: null, hitRate: null });
  assert.deepEqual(T.clvStats(null), { n: 0, avg: null, hitRate: null });

  const resolved = [
    { asset: 'a', price: 0.5, at: NOW - 3 * DAY }, { asset: 'b', price: 0.5, at: null, endAt: NOW - DAY }, { asset: 'c', price: 0.5, at: NOW - 2 * DAY },
    { asset: 'a', price: 0.5, at: NOW - 9 * DAY }, { asset: null, price: 0.5, at: NOW }, { asset: 'd', price: 1, at: NOW }, { asset: 'e', price: 0.3, at: NOW - 30 * DAY },
  ];
  assert.deepEqual(T.clvCandidates(resolved, 3).map(p => p.asset), ['b', 'c', 'a'], 'newest first, one per token, only priced bets with a token');
  assert.deepEqual(T.clvCandidates(resolved, 10).map(p => p.asset), ['b', 'c', 'a', 'e']);
  assert.equal(T.DEFAULTS.clvSample, 25);
});

test('scoreWallet: CLV in the stats, at most B without 15 measured, A needs +2%, B fails under +0.5% once measured; a category uses its own once it has 15', () => {
  const W = '0x' + 'a'.repeat(40);
  let k = 0;
  // 120 resolved bets at 50¢, 80 won: passes every round-1 A gate
  const rows = Array.from({ length: 120 }, (_, i) => {
    const at = NOW - (i % 100) * DAY - H, cond = `0xk${++k}`, won = i % 3 !== 0, sports = i % 4 === 0;
    return {
      proxy_wallet: W, token_id: `${cond}-t0`, condition_id: cond, avg_price: '0.5', total_size: 2000, total_cost_usdc: 1000, total_pnl: won ? 1000 : -1000,
      current_price: won ? 1 : 0, status: won ? 'CLOSED' : 'REDEEMABLE_LOST', title: sports ? `Lakers vs. Celtics (${i})` : `Will candidate ${i} win the Senate election?`,
      event_slug: `race-${i}`, end_date: iso(at), last_event_at: Math.floor(at / 1000), first_entry_at: iso(at - DAY),
    };
  });
  const samples = (n, clv, category = 'politics') => Array.from({ length: n }, (_, i) => ({ asset: `s-${category}-${i}`, category, risked: 1000 + i, clv }));
  const score = clv => T.scoreWallet({ wallet: W, closed: rows, clv }, { now: NOW });

  const none = score(undefined);
  assert.deepEqual([none.grade, none.whyNotA, none.clv, none.clvN, none.clvHitRate], ['B', ['closing-line value not measured yet'], null, 0, null]);
  const few = score(samples(14, 0.1));
  assert.deepEqual([few.grade, few.whyNotA, few.clvN], ['B', ['closing-line value not measured yet'], 14], '14 is not enough, however good');
  const good = score(samples(15, 0.02));
  assert.deepEqual([good.grade, good.clv, good.clvN, good.clvHitRate], ['A', 0.02, 15, 1]);
  const meh = score(samples(20, 0.012));
  assert.deepEqual([meh.grade, meh.whyNotA], ['B', ['closing-line value +1.2% over 20 bets (need +2%)']]);
  const bad = score(samples(20, -0.01));
  assert.equal(bad.grade, null, 'it keeps losing to the close: the profit is luck');
  assert.deepEqual(bad.reasons, ['closing-line value -1% over 20 bets (need +0.5%)']);
  assert.deepEqual(bad.failed, ['clv']);
  // stake-weighted: one big bet that beat the close and many small that didn't
  const mixed = score([...samples(10, -0.01).map(x => ({ ...x, risked: 100 })), ...samples(10, 0.05, 'sports').map(x => ({ ...x, risked: 5000 }))]);
  near(mixed.clv, round4((10 * 100 * -0.01 + 10 * 5000 * 0.05) / (10 * 100 + 10 * 5000)), 1e-4);
  assert.equal(mixed.clvHitRate, 0.5);
  assert.equal(mixed.grade, 'A');
  // a category with 15+ of its own is graded on them; one with fewer on the wallet's
  const split = score([...samples(16, -0.02, 'sports'), ...samples(20, 0.06)]);
  assert.deepEqual([split.categories.sports.clvScope, split.categories.sports.clvN, split.categories.sports.clv], ['category', 16, -0.02]);
  assert.ok(split.categories.sports.failed.includes('clv'), JSON.stringify(split.categories.sports.reasons));
  assert.deepEqual([split.categories.politics.clvScope, split.categories.politics.clvN], ['category', 20]);
  const thin = score([...samples(5, -0.02, 'sports'), ...samples(20, 0.06)]);
  assert.deepEqual([thin.categories.sports.clvScope, thin.categories.sports.clvN], ['wallet', 25]);
});
function round4(x) { return Math.round(x * 1e4) / 1e4; }
