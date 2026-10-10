const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../tail');
const { createMemoryStore } = require('../evtrack');

const NOW = Date.parse('2026-10-08T12:00:00Z');
const DAY = 86400e3;
const W = n => `0x${String(n).padStart(40, '0')}`;
const near = (a, b, eps = 1e-6, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg || ''} ${a} ≈ ${b}`);

// one settled position, data API v2 /v2/positions shape (numbers partly as
// strings). CLOSED by default; REDEEMABLE / REDEEMABLE_LOST were never claimed,
// so all their P&L is still unrealized. fee: entry fees, part of what it cost.
// As the live API has it: avg_price carries the fees, total_pnl is net of
// them, and a claimed position's entry cost is 0, so its total_cost_usdc is
// the fees alone.
let seq = 0;
function closed({ wallet = W(1), p = 0.5, stake = 1000, fee = 0, won, status = 'CLOSED', title = 'Will Smith win the Ohio Senate election?', eventSlug = 'ohio-senate', cond, idx = 0, at = NOW - DAY } = {}) {
  const shares = stake / p;
  cond = cond || `0xcond${++seq}`;
  const pnl = (won ? shares - stake : -stake) - fee;
  const claimed = status === 'CLOSED';
  return {
    proxy_wallet: wallet, token_id: `${cond}-t${idx}`, condition_id: cond, avg_price: String((stake + fee) / shares), total_size: shares, current_size: claimed ? 0 : shares,
    entry_cost_usdc: claimed ? 0 : stake, entry_fees_usdc: fee, total_cost_usdc: String(claimed ? fee : stake + fee),
    realized_pnl: claimed ? pnl : 0, unrealized_pnl: claimed ? 0 : pnl, total_pnl: pnl, current_price: won ? 1 : 0, status,
    redeemable: !claimed, title, slug: `${eventSlug}-m`, event_slug: eventSlug, outcome: idx ? 'No' : 'Yes', outcome_index: idx,
    end_date: new Date(at).toISOString(), first_entry_at: new Date(at - 2 * DAY).toISOString(),
    last_event_at: claimed ? Math.floor(at / 1000) : new Date(at - 2 * DAY).toISOString(),
  };
}
const STATES = ['Ohio', 'Texas', 'Iowa', 'Maine'];
// 120 bets at 50¢ on 120 races, 80 won (claimed) and 40 lost (never claimed:
// REDEEMABLE_LOST): ROI 33%, z 3.65, last claimed a day and an hour ago
const politicsElite = (wallet = W(1)) => Array.from({ length: 120 }, (_, i) => closed({
  wallet, won: i % 3 !== 0, status: i % 3 !== 0 ? 'CLOSED' : 'REDEEMABLE_LOST', title: `Will candidate ${i} win the ${STATES[i % 4]} Senate election?`,
  eventSlug: `senate-race-${i}`, at: NOW - (i % 100) * DAY - 3600e3,
}));
// measured closing lines: n bets that beat the close by `clv` (25: enough to count)
const clvs = (n = 25, clv = 0.05, category = 'politics') => Array.from({ length: n }, (_, i) => ({ asset: `clv-${category}-${i}`, category, risked: 1000, clv }));
// 60 NBA bets at 50¢, 20 won
const sportsBad = (wallet = W(1)) => Array.from({ length: 60 }, (_, i) => closed({
  wallet, won: i % 3 === 0, title: `Lakers vs. Celtics (game ${i})`, eventSlug: `nba-lal-bos-2026-09-${i}`, at: NOW - (i % 50) * DAY - 7200e3,
}));

test('category classifier: keywords, slugs, tags', () => {
  const cases = [
    ['Will the Fed cut rates in December?', 'econ'],
    ['Will Bitcoin reach $150,000 by December 31?', 'crypto'],
    ['Who will win the 2028 Democratic presidential nomination?', 'politics'],
    ['Oscars 2027: Best Picture winner', 'culture'],
    ['Will Taylor Swift and Travis Kelce get engaged?', 'culture'],
    ['Lakers vs. Warriors', 'sports'],
    ['Spread: Celtics (-5.5)', 'sports'],
    ['UFC 310: Pantoja vs. Asakura', 'sports'],
    ['Trump vs. Harris', 'politics'],              // a name outweighs "vs."
    ['Will $TRUMP coin hit $10?', 'crypto'],       // tie goes to crypto
    ['S&P 500 above 6000 on Friday?', 'econ'],
    ['Russia x Ukraine ceasefire in 2026?', 'politics'],
    ['The Game Awards: Game of the Year', 'culture'],
    ['Highest temperature in London on Oct 8?', 'other'],
    ['Montréal Canadiens vs Bruins', 'sports'],
    ['', 'other'],
  ];
  for (const [title, cat] of cases) assert.equal(T.classify(title), cat, title);
  assert.equal(T.classify({ title: 'DAL @ SAS', eventSlug: 'nba-dal-sas-2026-10-08' }), 'sports', 'slug when the title says nothing');
  assert.equal(T.classify({ tags: [{ label: 'Pop Culture', slug: 'pop-culture' }], title: 'Will Trump attend the Met Gala?' }), 'culture', 'tags first');
  assert.equal(T.classify({ category: 'Crypto', question: 'Will Tesla stock close higher?' }), 'crypto');
  assert.equal(T.classify({ events: [{ category: 'Sports' }], question: 'Who wins?' }), 'sports');
  assert.equal(T.classify(null), 'other');
  assert.ok(T.CATEGORIES.includes(T.classify('anything')));
});

test('parsers are tolerant: v2 snake_case and v1 camelCase, wrapped arrays, numbers as strings, missing fields', () => {
  const at = Date.parse('2025-10-08T12:00:00Z');
  const rows = T.parseClosedPositions({ data: [
    { proxy_wallet: '0xABC', token_id: 7, condition_id: '0xc', avg_price: '0.2525', total_size: '400', total_cost_usdc: '1', entry_fees_usdc: '1',
      realized_pnl: '299', total_pnl: '299', current_price: '1', status: 'CLOSED', title: 'Bitcoin above 100k?', event_slug: 'btc',
      last_event_at: '2025-10-08T12:00:00Z', first_entry_at: 1759500000 },
    { avgPrice: '0.6', totalBought: 100, curPrice: null, realizedPnl: -60, title: 'Lakers vs. Celtics', timestamp: 1759924800000 },   // v1: closed
    { avgPrice: '0.5', totalBought: 100, curPrice: 0 },          // no P&L given: (cur − p) × shares
    { avg_price: '0', total_size: 100, total_pnl: 5 },           // no price
    { avg_price: '0.5', total_size: 'n/a', total_pnl: 5 },       // no shares, no cost
    { avg_price: '0.5', total_size: 10 },                        // nothing to score
    { avg_price: '0.5', total_size: 10, total_pnl: 1, status: 'OPEN' },   // not settled
    null, 'junk',
  ], pagination: { limit: 500, offset: 0, has_more: false, next_cursor: null } });
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], {
    wallet: '0xabc', conditionId: '0xc', asset: '7', outcome: null, outcomeIndex: null, title: 'Bitcoin above 100k?', slug: '', eventSlug: 'btc',
    status: 'CLOSED', price: 0.2525, risked: 101, pnl: 299, fees: 1, exit: 1, won: true, at, endAt: null, enteredAt: 1759500000000, activeAt: at,
    category: 'crypto', source: 'closed',
  });
  assert.equal(rows[1].at, 1759924800000, 'unix ms');
  assert.equal(rows[1].status, 'CLOSED', 'a v1 closed-positions row');
  assert.equal(rows[1].risked, 60, 'no cost given: avg price × size');
  assert.equal(rows[1].won, false, 'no current price: won = pnl > 0');
  assert.equal(rows[1].category, 'sports');
  assert.equal(rows[2].pnl, -50);
  assert.deepEqual(T.parseClosedPositions(null), []);
  assert.deepEqual(T.parseClosedPositions({ data: null }), []);
  assert.deepEqual(T.parseOpenPositions('garbage'), []);

  const open = T.parseOpenPositions({ data: [{ proxy_wallet: '0xAB', token_id: '55', condition_id: '0xo', current_size: '300', avg_price: '0.4', total_size: 300,
    entry_cost_usdc: 117.5, entry_fees_usdc: '2.5', current_price: '0.45', current_value: 135, unrealized_pnl: '15', realized_pnl: 0, total_pnl: 15,
    status: 'OPEN', end_date: '2026-11-04', event_slug: 'x-race', last_event_at: '2026-10-07T00:00:00Z', first_entry_at: '2026-10-01T00:00:00Z' }] });
  assert.deepEqual([open[0].asset, open[0].size, open[0].price, open[0].cost, open[0].cashPnl, open[0].totalPnl, open[0].eventSlug, open[0].activeAt],
    ['55', 300, 0.4, 120, 15, 15, 'x-race', Date.parse('2026-10-07T00:00:00Z')]);
  assert.deepEqual(T.markOpen(open[0]), { risked: 120, pnl: 15 }, 'avg price × shares: the fees are in the average');

  const lb = T.parseLeaderboard({ data: [
    { rank: '1', user_id: '0xAA', user_name: 'Oracle', pnl: '1234.5', volume: '99', x_username: 'orc', verified: true, profile_image: 'o.png' },
    { rank: '2', wallet: '0xBB', amount: '10', name: 'old' },                         // v1 names still read
    { proxyWallet: '0xcc', userName: 'mid', vol: 5, verifiedBadge: true },
    { user_name: 'no wallet' },
  ], pagination: { has_more: false } });
  assert.deepEqual(lb.map(r => [r.wallet, r.name, r.pnl, r.vol, r.rank, r.verified, r.xUsername]),
    [['0xaa', 'Oracle', 1234.5, 99, 1, true, 'orc'], ['0xbb', 'old', 10, null, 2, false, null], ['0xcc', 'mid', null, 5, null, true, null]]);
  assert.equal(T.parseLeaderboard([{ proxyWallet: '0xcc', pseudonym: 'Shy-Owl' }])[0].name, 'Shy-Owl');
});

test('trades: fills of one order merge, timestamps in s or ms, junk dropped, parse is idempotent', () => {
  const raw = [
    { proxy_wallet: '0xA', side: 'buy', token_id: 'tok', condition_id: '0xc', size: '1000', price: '0.40', timestamp: 1759924800, transaction_hash: '0xt', pseudonym: 'Owl',
      event_slug: 'x-race', outcome: 'Yes', outcome_index: 0, title: 'Will X win?', slug: 'will-x-win', bio: '', profile_image: '' },
    { proxyWallet: '0xA', side: 'BUY', asset: 'tok', conditionId: '0xc', size: 500, price: 0.43, timestamp: 1759924800, transactionHash: '0xt' },   // v1 fill of the same order
    { proxy_wallet: '0xA', side: 'BUY', token_id: 'tok', size: 0, price: 0.4, transaction_hash: '0xz' },
    { proxy_wallet: '0xA', side: 'BUY', token_id: 'tok', size: 10, price: 1.2, transaction_hash: '0xy' },
    { side: 'BUY', token_id: 'tok', size: 10, price: 0.5 },
  ];
  const [t, ...rest] = T.parseTrades({ data: raw, pagination: { has_more: false } });
  assert.equal(rest.length, 0);
  assert.equal(t.key, '0xt:tok:0xa');
  assert.equal(t.size, 1500);
  near(t.notional, 615);
  assert.equal(t.price, 0.41, 'notional-weighted average fill');
  assert.equal(t.at, 1759924800000);
  assert.equal(t.side, 'BUY');
  assert.equal(t.name, 'Owl');
  assert.deepEqual([t.conditionId, t.eventSlug, t.outcomeIndex, t.txHash], ['0xc', 'x-race', 0, '0xt']);
  assert.deepEqual(T.parseTrades([t]), [t], 'parsed trades parse to themselves');
});

test('gamma market: asks per outcome, last prices, resolution', () => {
  const m = T.parseGammaMarket({
    id: 12, conditionId: '0xm', question: 'Will X win?', outcomes: '["Yes","No"]', outcomePrices: '["0.405","0.595"]',
    clobTokenIds: '["111","222"]', bestBid: '0.40', bestAsk: '0.41', lastTradePrice: '0.41', endDate: '2026-11-04T00:00:00Z',
    active: true, closed: false, events: [{ slug: 'x-race', title: 'X race', category: 'Politics' }],
  });
  assert.equal(m.eventSlug, 'x-race');
  assert.equal(m.category, 'Politics');
  assert.equal(T.askFor(m, { asset: '111' }), 0.41, 'first outcome: bestAsk');
  assert.equal(T.askFor(m, { asset: '222' }), 0.6, 'second outcome: 1 − bestBid');
  assert.equal(T.askFor(m, { outcomeIndex: 1 }), 0.6);
  assert.equal(T.askFor(m, { outcome: 'no' }), 0.6);
  assert.equal(T.askFor(m, { asset: '999' }), null);
  assert.equal(T.priceOf(m, { asset: '222' }), 0.59);
  assert.equal(T.askFor({ ...m, bestAsk: null, bestBid: null }, { asset: '222' }), null, 'no book: no price (a mid is not an ask)');
  assert.equal(T.askFor({ ...m, bestAsk: null }, { asset: '111' }), null);
  assert.equal(T.resolutionOf(m), null);
  assert.deepEqual(T.resolutionOf({ ...m, closed: true, prices: [0, 1] }), { winner: 1 });
  assert.deepEqual(T.resolutionOf({ ...m, closed: true, prices: [0.5, 0.5] }), { void: true });
  assert.equal(T.resolutionOf({ ...m, closed: true, prices: [0.7, 0.3] }), null, 'closed but not settled yet');
  assert.deepEqual(T.resolutionOf({ ...m, closed: false, resolution: 'resolved', prices: [1, 0] }), { winner: 0 });
  // closed is not settled while the UMA answer is proposed or disputed
  assert.equal(T.resolutionOf({ ...m, closed: true, resolution: 'proposed', prices: [0.505, 0.495] }), null);
  assert.equal(T.resolutionOf({ ...m, closed: true, resolution: 'disputed', prices: [0.995, 0.005] }), null);
  assert.deepEqual(T.resolutionOf({ ...m, closed: true, resolution: 'resolved', prices: [0.995, 0.005] }), { winner: 0 });
  // closed with no status: only the exact settlement prices count
  assert.equal(T.resolutionOf({ ...m, closed: true, prices: [0.995, 0.005] }), null);
  assert.equal(T.resolutionOf({ ...m, closed: true, prices: [0.505, 0.495] }), null);
  assert.equal(T.parseGammaMarket({ acceptingOrders: false }).acceptingOrders, false);
  assert.equal(T.parseGammaMarket(null), null);
  assert.deepEqual(T.parseGammaMarkets({ markets: [{ conditionId: 'a' }] }).map(x => x.conditionId), ['a']);
});

test('luck test and shrunk edge: exact numbers', () => {
  // +100 on $100 at 50¢ (var 100²·0.5/0.5 = 10,000) and +200 on $50 at 20¢ (var 50²·0.8/0.2 = 10,000)
  const s = T.scoreWallet({ wallet: W(3), closed: [closed({ p: 0.5, stake: 100, won: true, eventSlug: 'e1' }), closed({ p: 0.2, stake: 50, won: true, eventSlug: 'e2' })] }, { now: NOW });
  assert.equal(s.pnl, 300);
  assert.equal(s.risked, 150);
  assert.equal(s.z, round2(300 / Math.sqrt(20000)), 'two events: independent');
  // the same two bets on one event move together: sds add (100 + 100), then square
  const one = T.scoreWallet({ wallet: W(3), closed: [closed({ p: 0.5, stake: 100, won: true, eventSlug: 'e1' }), closed({ p: 0.2, stake: 50, won: true, eventSlug: 'e1' })] }, { now: NOW });
  assert.equal(one.z, 1.5);
  assert.equal(one.events, 1);
  near(s.edge, (300 / (150 + 20000)) * 0.5, 1e-6, 'Σpnl / (Σrisked + $20k) × 0.5');
  const loser = T.scoreWallet({ wallet: W(3), closed: [closed({ p: 0.25, stake: 100, won: false })] }, { now: NOW });
  assert.equal(loser.z, round2(-100 / Math.sqrt(100 ** 2 * 0.75 / 0.25)));
  assert.equal(loser.concentration, null);
  assert.ok(loser.reasons.includes('no winning bets'));
  const s2 = T.scoreWallet({ wallet: W(3), closed: [closed({ p: 0.5, stake: 100, won: true })] }, { now: NOW, priorRisk: 900, regression: 1 });
  assert.equal(s2.edge, 0.1, 'prior and regression are options');
});
function round2(x) { return Math.round(x * 100) / 100; }

// stats exactly on every A threshold
const aStats = (o = {}) => ({ n: 100, events: 30, risked: 50000, roi: 0.08, z: 3, concentration: 0.35, twoSided: 0.3, lastAt: NOW - 30 * DAY, recentRoi: -0.0999, clvN: 15, clv: 0.02, ...o });
const bStats = (o = {}) => ({ n: 50, events: 15, risked: 20000, roi: 0.04, z: 2, concentration: 0.4, twoSided: 0.3, lastAt: NOW - 45 * DAY, recentRoi: -0.5, clvN: 15, clv: 0.005, ...o });

test('grade A boundaries: each threshold met exactly passes, a hair past it drops to B', () => {
  const a = T.gradeStats(aStats(), {}, NOW);
  assert.equal(a.grade, 'A');
  assert.equal(a.label, 'elite');
  assert.deepEqual(a.reasons, []);
  assert.deepEqual(a.whyNotA, []);
  // [code, a hair past the line, a clear miss, its reason]
  const misses = [
    ['n', { n: 99 }, { n: 64 }, 'only 64 resolved bets (need 100)'],
    ['events', { events: 29 }, { events: 21 }, 'only 21 distinct events (need 30)'],
    ['risked', { risked: 49999.99 }, { risked: 41234 }, 'only $41,234 risked (need $50,000)'],
    ['roi', { roi: 0.0799999 }, { roi: 0.065 }, 'ROI 6.5% (need 8%)'],
    ['z', { z: 2.999999 }, { z: 2.44 }, 'z-score 2.4: profit could be luck (need 3)'],
    ['concentration', { concentration: 0.350001 }, { concentration: 0.38 }, '38% of profit from one event (max 35%)'],
    ['active', { lastAt: NOW - 30 * DAY - 1 }, { lastAt: NOW - 31 * DAY }, 'inactive 31 days (need a bet in the last 30)'],
    ['recentRoi', { recentRoi: -0.1 }, { recentRoi: -0.25 }, 'last 30 days ROI -25% (must be above -10%)'],
    ['clv', { clv: 0.0199999 }, { clv: 0.012 }, 'closing-line value +1.2% over 15 bets (need +2%)'],
    ['clv', { clvN: 14 }, { clvN: 0, clv: null }, 'closing-line value not measured yet'],
  ];
  for (const [code, hair, clear, text] of misses) {
    for (const o of [hair, clear]) {
      const g = T.gradeStats(aStats(o), {}, NOW);
      assert.equal(g.grade, 'B', `${code} ${JSON.stringify(o)}`);
      assert.equal(g.label, 'sharp');
      assert.deepEqual(g.failedA, [code], code);
      assert.deepEqual(g.reasons, [], 'B is tailable: no reasons');
    }
    assert.deepEqual(T.gradeStats(aStats(clear), {}, NOW).whyNotA, [text], code);
  }
  // a near miss never prints as the threshold it missed
  assert.deepEqual(T.gradeStats(aStats({ roi: 0.0799 }), {}, NOW).whyNotA, ['ROI 7.99% (need 8%)']);
  assert.deepEqual(T.gradeStats(aStats({ z: 2.996 }), {}, NOW).whyNotA, ['z-score 2.996: profit could be luck (need 3)']);
  assert.deepEqual(T.gradeStats(aStats({ risked: 49999.99 }), {}, NOW).whyNotA, ['only $49,999 risked (need $50,000)']);
  assert.deepEqual(T.gradeStats(aStats({ concentration: 0.351 }), {}, NOW).whyNotA, ['35.1% of profit from one event (max 35%)']);
  assert.deepEqual(T.gradeStats(aStats({ concentration: 0.5, concentrationBy: 'day' }), {}, NOW).whyNotA, ["50% of profit from one day's markets (max 35%)"]);
  assert.equal(T.gradeStats(aStats({ recentRoi: -0.1 + 1e-6 }), {}, NOW).grade, 'A', 'just above -10% is fine');
  assert.equal(T.gradeStats(aStats({ recentRoi: null }), {}, NOW).grade, 'A', 'no recent bets is not a slump');
  assert.equal(T.gradeStats(aStats({ roi: 4000 / 50000 }), {}, NOW).grade, 'A', 'float ROI on the line');
  // without 15 measured closing lines a wallet is at most B, however good the rest
  const unmeasured = T.gradeStats(aStats({ clvN: undefined, clv: undefined, roi: 0.4, z: 9 }), {}, NOW);
  assert.deepEqual([unmeasured.grade, unmeasured.whyNotA], ['B', ['closing-line value not measured yet']]);
  assert.deepEqual(T.gradeStats(aStats({ clvN: 40, clv: 0.031 }), {}, NOW).grade, 'A');
  assert.deepEqual(T.gradeStats(aStats({ clv: 0.0199 }), {}, NOW).whyNotA, ['closing-line value +1.99% over 15 bets (need +2%)']);
});

test('grade B boundaries: met exactly passes, a hair past fails with the reason', () => {
  const b = T.gradeStats(bStats(), {}, NOW);
  assert.equal(b.grade, 'B');
  assert.ok(b.whyNotA.length > 0, 'and says why it is not A');
  const misses = [
    ['n', { n: 49 }, { n: 31 }, 'only 31 resolved bets (need 50)'],
    ['events', { events: 14 }, { events: 9 }, 'only 9 distinct events (need 15)'],
    ['risked', { risked: 19999.99 }, { risked: 12400 }, 'only $12,400 risked (need $20,000)'],
    ['roi', { roi: 0.0399999 }, { roi: 0.021 }, 'ROI 2.1% (need 4%)'],
    ['z', { z: 1.999999 }, { z: 1.4 }, 'z-score 1.4: profit could be luck (need 2)'],
    ['concentration', { concentration: 0.400001 }, { concentration: 0.62 }, '62% of profit from one event (max 40%)'],
    ['active', { lastAt: NOW - 45 * DAY - 1 }, { lastAt: NOW - 52 * DAY }, 'inactive 52 days (need a bet in the last 45)'],
    ['twoSided', { twoSided: 0.300001 }, { twoSided: 0.45 }, 'market maker: held both sides in 45% of markets (max 30%)'],
    ['clv', { clv: 0.0049999 }, { clv: -0.008, clvN: 22 }, 'closing-line value -0.8% over 22 bets (need +0.5%)'],
  ];
  for (const [code, hair, clear, text] of misses) {
    for (const o of [hair, clear]) {
      const g = T.gradeStats(bStats(o), {}, NOW);
      assert.equal(g.grade, null, `${code} ${JSON.stringify(o)}`);
      assert.equal(g.label, null);
      assert.deepEqual(g.failed, [code], code);
    }
    assert.deepEqual(T.gradeStats(bStats(clear), {}, NOW).reasons, [text], code);
  }
  assert.equal(T.gradeStats(bStats({ twoSided: 0.31 }), {}, NOW).marketMaker, true);
  assert.equal(T.gradeStats(aStats({ twoSided: 0.31 }), {}, NOW).grade, null, 'market makers are out at every tier');
  assert.deepEqual(T.gradeStats(bStats({ lastAt: null }), {}, NOW).reasons, ['no dated bets']);
  assert.deepEqual(T.gradeStats(bStats({ z: null }), {}, NOW).failed, ['z']);
  // B needs no closing line, and a bad one only counts once 15 are measured
  assert.equal(T.gradeStats(bStats({ clvN: 0, clv: null }), {}, NOW).grade, 'B');
  assert.equal(T.gradeStats(bStats({ clvN: 14, clv: -0.3 }), {}, NOW).grade, 'B');
  assert.equal(T.gradeStats(bStats({ clvN: 15, clv: -0.3 }), {}, NOW).grade, null);
});

test('every threshold is an option; env vars map onto them', () => {
  assert.equal(T.gradeStats(aStats(), { grades: { A: { minZ: 3.5 } } }, NOW).grade, 'B');
  assert.equal(T.gradeStats(aStats({ z: 2.5 }), { grades: { A: { minZ: 2.5 } } }, NOW).grade, 'A');
  assert.equal(T.gradeStats(bStats({ twoSided: 0.31 }), { maxTwoSided: 0.35 }, NOW).grade, 'B');
  const env = { TAIL_A_MIN_Z: '2.5', TAIL_MIN_TRADE: '1000', TAIL_B_MIN_ROI: '5', TAIL_A_MIN_RECENT_ROI: '-15', TAIL_PRIOR_RISK: 'lots', TAIL_MAX_TWO_SIDED: '0.25', TAIL_B_CAP_UNITS: '',
    TAIL_CLV_SAMPLE: '40', TAIL_CLV_MIN_N: '20', TAIL_A_MIN_CLV: '3', TAIL_B_MIN_CLV: '0.01' };
  assert.deepEqual(T.optionsFromEnv(env), {
    grades: { A: { minZ: 2.5, minRecentRoi: -0.15, minClv: 0.03 }, B: { minRoi: 0.05, minClv: 0.01 } }, minTrade: 1000, maxTwoSided: 0.25, clvSample: 40, clvMinN: 20,
  });
  assert.equal(T.resolveOptions({}).clvSample, 25, 'TAIL_CLV_SAMPLE defaults to 25');
  assert.equal(T.gradeStats(aStats({ clvN: 19 }), { clvMinN: 20 }, NOW).grade, 'B', 'clvMinN (TAIL_CLV_MIN_N)');
  const o = T.resolveOptions(T.optionsFromEnv(env));
  assert.equal(o.grades.A.minZ, 2.5);
  assert.equal(o.grades.A.minN, 100, 'untouched thresholds keep their defaults');
  assert.equal(o.grades.B.capUnits, 1);
  assert.equal(o.priorRisk, 20000);
  assert.deepEqual(T.resolveOptions(o), o, 'resolving twice changes nothing');
});

test('an elite politics wallet grades A, with stats and a category breakdown', () => {
  const s = T.scoreWallet({ wallet: W(1).toUpperCase().replace('0X', '0x'), name: 'Oracle', closed: politicsElite(), clv: clvs(25, 0.05) }, { now: NOW });
  assert.equal(s.wallet, W(1), 'wallets are lower-cased');
  assert.equal(s.grade, 'A');
  assert.equal(s.label, 'elite');
  assert.equal(s.tailable, true);
  assert.deepEqual(s.reasons, []);
  assert.equal(s.n, 120);
  assert.equal(s.events, 120);
  assert.equal(s.risked, 120000);
  assert.equal(s.pnl, 40000);
  assert.equal(s.roi, 0.3333);
  assert.equal(s.winRate, 0.6667);
  assert.equal(s.avgEntry, 0.5);
  assert.equal(s.z, round2(40000 / Math.sqrt(120 * 1000 ** 2)));
  assert.ok(s.concentration < 0.035, `the best day's races (two on one day: $2,000) are a sliver of the winnings: ${s.concentration}`);
  assert.equal(s.concentrationBy, 'day');
  assert.equal(s.twoSided, 0);
  assert.equal(s.lastAt, new Date(NOW - 3600e3).toISOString());
  assert.equal(s.activeDays, 100);
  assert.equal(s.recentN, 50, 'bets from the last 30 days');
  near(s.edge, (40000 / 140000) * 0.5);
  assert.equal(s.url, `https://polymarket.com/profile/${W(1)}`);
  assert.deepEqual([s.clv, s.clvN, s.clvHitRate], [0.05, 25, 1]);
  assert.equal(s.clvSamples.length, 25);
  assert.deepEqual(Object.keys(s.categories), ['politics']);
  assert.equal(s.categories.politics.grade, 'A');
  assert.equal(s.categories.politics.n, 120);
  assert.deepEqual([s.categories.politics.clvN, s.categories.politics.clvScope], [25, 'category']);
  // the same record with no closing lines measured: B, and why not A
  const unmeasured = T.scoreWallet({ wallet: W(1), closed: politicsElite() }, { now: NOW });
  assert.equal(unmeasured.grade, 'B');
  assert.deepEqual(unmeasured.whyNotA, ['closing-line value not measured yet']);
  assert.deepEqual(unmeasured.failedA, ['clv']);
  assert.equal(unmeasured.categories.politics.grade, 'B');
  assert.equal(unmeasured.clvSamples, undefined);
  assert.equal(unmeasured.clvN, 0);
});

test('a lucky one-hit wallet: great ROI and z, but one bet is the profit → not tailable', () => {
  const rows = Array.from({ length: 119 }, (_, i) => closed({ wallet: W(4), stake: 500, won: i % 2 === 0, eventSlug: `race-${i % 40}`, at: NOW - (i % 60) * DAY - 3600e3 }));
  rows.push(closed({ wallet: W(4), p: 0.04, stake: 4000, won: true, eventSlug: 'race-0', at: NOW - 2 * DAY }));   // a 24-to-1 shot for $96k
  const s = T.scoreWallet({ wallet: W(4), closed: rows }, { now: NOW });
  assert.equal(s.pnl, 96500);
  assert.ok(s.z > 3, `z ${s.z} alone would call it skill`);
  assert.ok(s.roi > 1);
  // race-0 (the longshot plus three 50¢ winners) against the 19 other winning races of 3 × $500
  assert.equal(s.concentration, round4(97500 / (97500 + 19 * 1500)));
  assert.equal(s.concentrationBy, 'event');
  assert.equal(s.grade, null);
  assert.deepEqual(s.failed, ['concentration']);
  assert.deepEqual(s.reasons, ['77% of profit from one event (max 40%)']);
});
function round4(x) { return Math.round(x * 1e4) / 1e4; }

test('a market maker (both sides of 40% of markets) is excluded however good its record', () => {
  const rows = [];
  for (let i = 0; i < 100; i++) {
    const cond = `0xmm${i}`, eventSlug = `mm-${i}`, at = NOW - (i % 30) * DAY - 3600e3;
    rows.push(closed({ wallet: W(5), cond, won: i % 3 !== 0, eventSlug, at }));
    if (i < 40) rows.push(closed({ wallet: W(5), cond, idx: 1, p: 0.45, stake: 100, won: i % 3 === 0, eventSlug, at }));
  }
  const s = T.scoreWallet({ wallet: W(5), closed: rows }, { now: NOW });
  assert.equal(s.twoSided, 0.4);
  assert.equal(s.marketMaker, true);
  assert.equal(s.grade, null);
  assert.ok(s.failed.includes('twoSided'));
  assert.ok(s.reasons.includes('market maker: held both sides in 40% of markets (max 30%)'));
  assert.ok(!s.failed.includes('z') && !s.failed.includes('roi'), 'it would otherwise pass');
  assert.equal(s.categories.politics.grade, null, 'and is out in every category');
});

test('two-sided evidence comes from closed, open and traded positions; mixed ids never fake it', () => {
  assert.equal(T.twoSidedShare([{ conditionId: 'c', asset: 'a1' }, { conditionId: 'c', asset: 'a2' }]).share, 1);
  assert.equal(T.twoSidedShare([{ conditionId: 'c', asset: 'a1', outcomeIndex: 0 }, { conditionId: 'c', outcomeIndex: 0, outcome: 'Yes' }]).share, 0);
  assert.equal(T.twoSidedShare([{ conditionId: 'c', asset: 'a1' }, { conditionId: 'c', outcomeIndex: 1 }]).share, 0, 'different id kinds are not compared');
  assert.deepEqual(T.twoSidedShare([{ conditionId: 'c', outcome: 'Yes' }, { conditionId: 'c', outcome: 'no' }, { conditionId: 'd', outcome: 'Yes' }]), { markets: 2, twoSidedMarkets: 1, share: 0.5 });
  const c0 = closed({ wallet: W(6), cond: '0xq', idx: 0, won: true });
  const s = T.scoreWallet({
    wallet: W(6), closed: [c0],
    open: [{ proxyWallet: W(6), conditionId: '0xq', asset: '0xq-t1', outcomeIndex: 1, outcome: 'No', size: 100, avgPrice: 0.5, curPrice: 0.5 }],
    trades: [{ proxyWallet: W(6), side: 'BUY', conditionId: '0xr', asset: 'r1', outcomeIndex: 0, size: 10, price: 0.5, timestamp: NOW / 1000, transactionHash: '0x1' },
      { proxyWallet: W(6), side: 'BUY', conditionId: '0xr', asset: 'r2', outcomeIndex: 1, size: 10, price: 0.5, timestamp: NOW / 1000, transactionHash: '0x2' }],
  }, { now: NOW });
  assert.equal(s.twoSided, 1, 'held YES (closed) and NO (open) in one market, both sides traded in another');
  assert.equal(s.lastAt, new Date(NOW).toISOString(), 'trades count as activity');
});

test('v1 open rows that resolved but were never redeemed still count, so hidden losers show up', () => {
  const wins = [closed({ wallet: W(7), won: true, cond: '0xw1' }), closed({ wallet: W(7), won: true, cond: '0xw2' })];
  const open = [
    { proxyWallet: W(7), conditionId: '0xl1', asset: 'l1', outcomeIndex: 0, size: '2000', avgPrice: '0.5', totalBought: '2000', initialValue: 1000, currentValue: 0, cashPnl: '-1000', realizedPnl: 0, curPrice: 0, redeemable: true, title: 'Will Smith win?', endDate: '2026-10-01' },
    { proxyWallet: W(7), conditionId: '0xl2', asset: 'l2', outcomeIndex: 1, size: 2000, avgPrice: 0.5, curPrice: '0', redeemable: 'true', title: 'Will Jones win?' },
    { proxyWallet: W(7), conditionId: '0xo1', asset: 'o1', outcomeIndex: 0, size: 100, avgPrice: 0.3, curPrice: 0.35, currentValue: 35, redeemable: false },
    { ...wins[0], size: 2000, realizedPnl: 0, redeemable: true, curPrice: 1 },   // also listed as closed: not double counted
  ];
  const s = T.scoreWallet({ wallet: W(7), closed: wins, open }, { now: NOW });
  assert.equal(s.n, 4);
  assert.equal(s.pnl, 0, '+1000 +1000 −1000 −1000');
  assert.equal(s.winRate, 0.5);
  assert.equal(s.openPositions, 1);
  assert.equal(s.openValue, 35);
  const r = T.resolvedFromOpen(T.parseOpenPositions(open));
  assert.deepEqual(r.map(x => [x.asset, x.risked, x.pnl, x.won]), [['l1', 1000, -1000, false], ['l2', 1000, -1000, false], [wins[0].token_id, 1000, 1000, true]]);
});

test('v2: never-claimed losers (REDEEMABLE_LOST) and winners (REDEEMABLE) count; fees are dollars risked', () => {
  // three claimed winners (+$1,000 each), three losers nobody claimed, one winner nobody claimed
  const rows = [
    ...[1, 2, 3].map(i => closed({ wallet: W(30), won: true, cond: `0xcw${i}` })),
    ...[1, 2, 3].map(i => closed({ wallet: W(30), won: false, status: 'REDEEMABLE_LOST', cond: `0xcl${i}` })),
    closed({ wallet: W(30), won: true, status: 'REDEEMABLE', cond: '0xcr' }),
  ];
  const s = T.scoreWallet({ wallet: W(30), closed: rows }, { now: NOW });
  assert.deepEqual([s.n, s.pnl, s.risked, s.winRate], [7, 1000, 7000, round4(4 / 7)], 'the hidden losers are in');
  const claimedOnly = T.scoreWallet({ wallet: W(30), closed: rows.filter(r => r.status === 'CLOSED') }, { now: NOW });
  assert.deepEqual([claimedOnly.n, claimedOnly.roi], [3, 1], 'what a closed-only read would have claimed');
  const parsed = T.parseClosedPositions(rows, { now: NOW });
  assert.deepEqual(parsed.map(p => p.source), ['closed', 'closed', 'closed', 'lost', 'lost', 'lost', 'redeemable']);
  assert.deepEqual(parsed.map(p => p.won), [true, true, true, false, false, false, true]);
  // with no total P&L, an unclaimed loser is worth $0 a share (its realized P&L is 0: it never sold), an unclaimed winner $1
  const strip = r => { const x = { ...r }; delete x.total_pnl; delete x.unrealized_pnl; return x; };
  assert.equal(T.parseClosedPositions([strip(rows[3])])[0].pnl, -1000, 'not break-even');
  assert.equal(T.parseClosedPositions([strip(rows[6])])[0].pnl, 1000);
  // a token listed twice (under two statuses, or on two pages while the list moved) counts once
  assert.equal(T.scoreWallet({ wallet: W(30), closed: [...rows, { ...rows[0] }, { ...rows[3], status: 'CLOSED' }] }, { now: NOW }).n, 7);

  // dollars risked: avg price (fees in) × shares bought; a closed row's total_cost_usdc is only its fees
  const feeRow = closed({ wallet: W(30), won: true, stake: 1000, fee: 12.5, cond: '0xfee' });
  assert.equal(Number(feeRow.total_cost_usdc), 12.5, 'the fixture is shaped like the live API');
  const [withFee] = T.parseClosedPositions([feeRow]);
  assert.deepEqual([round4(withFee.risked), withFee.pnl, withFee.fees], [1012.5, 987.5, 12.5]);
  const noShares = { ...feeRow, entry_cost_usdc: 1000, total_cost_usdc: '1012.5' };
  delete noShares.total_size;
  assert.equal(T.parseClosedPositions([noShares])[0].risked, 1012.5, 'no share count: the stated cost');
  const fs = T.scoreWallet({ wallet: W(30), closed: [feeRow] }, { now: NOW });
  assert.equal(fs.roi, round4(987.5 / 1012.5), 'ROI after fees');

  // a live row (a LoL handicap bet, 2026-10-07): fills of $1,230.36 at 68¢ plus
  // $8.31 of fees on 1,820.46 shares. Its total_cost_usdc is the fees alone;
  // read as the stake it made a 47% win look like 7,000%.
  const live = {
    proxy_wallet: W(30), token_id: '207279', condition_id: '0x83b5', current_size: 0, avg_price: 0.6804, entry_cost_usdc: 0, entry_fees_usdc: 8.30842,
    total_cost_usdc: 8.30842, current_price: 1, current_value: 0, total_size: 1820.4562, realized_pnl: 581.7941, unrealized_pnl: 0, total_pnl: 581.7941,
    percent_realized_pnl: 46.9695, status: 'CLOSED', title: 'Game Handicap: CPD (-1.5) vs Fuego (+1.5)', slug: 'lol-cpd-fue-2026-10-06-game-handicap-away-1pt5',
    event_slug: 'lol-cpd-fue-2026-10-06', outcome: 'Cupid Esports', outcome_index: 0, end_date: '2026-10-07', last_event_at: 1791340091, first_entry_at: 1791247547,
  };
  const [lr] = T.parseClosedPositions([live], { now: NOW });
  assert.equal(Math.round(lr.risked * 100) / 100, 1238.64);
  assert.equal(Math.round((lr.pnl / lr.risked) * 1e4) / 100, 46.97, "the API's own percent_realized_pnl");

  // an unclaimed loser is dated by its market's end, unless that end is still to come (it resolved early)
  const early = { ...closed({ wallet: W(30), won: false, status: 'REDEEMABLE_LOST', at: NOW + 30 * DAY }), first_entry_at: new Date(NOW - 5 * DAY).toISOString() };
  const [e] = T.parseClosedPositions([early], { now: NOW });
  assert.deepEqual([e.at, e.endAt, e.activeAt], [null, NOW + 30 * DAY, NOW - 5 * DAY], 'its own move was the entry');
});

test('recent form is the last 30 days only', () => {
  const rows = [
    closed({ wallet: W(8), won: true, at: NOW - 100 * DAY }), closed({ wallet: W(8), won: true, at: NOW - 40 * DAY }),
    closed({ wallet: W(8), won: false, at: NOW - 10 * DAY }), closed({ wallet: W(8), won: true, p: 0.25, stake: 100, at: NOW - 5 * DAY }),
  ];
  const s = T.scoreWallet({ wallet: W(8), closed: rows }, { now: NOW });
  assert.equal(s.recentN, 2);
  assert.equal(s.recentRoi, round4((-1000 + 300) / 1100));
  assert.equal(s.roi, round4(1300 / 3100));
});

test('elite in politics, bad in sports: graded per category, sports trades are not tailed', () => {
  const s = T.scoreWallet({ wallet: W(1), closed: [...politicsElite(), ...sportsBad()], clv: clvs(25, 0.05) }, { now: NOW });
  assert.equal(s.categories.politics.grade, 'A');
  assert.equal(s.categories.sports.grade, null);
  assert.equal(s.categories.sports.pnl, -20000);
  assert.ok(s.categories.sports.failed.includes('roi'));
  assert.ok(s.categories.sports.reasons.includes('ROI -33.3% (need 4%)'));
  // the sports losses drag the whole record under the luck bar, but it's in
  // profit and its bets beat the close by 5%: B by its closing lines
  assert.deepEqual([s.grade, s.via], ['B', 'clv']);
  assert.equal(s.categories.politics.via, 'record');
  const noPath = T.scoreWallet({ wallet: W(1), closed: [...politicsElite(), ...sportsBad()], clv: clvs(25, 0.05) }, { now: NOW, clvPath: 0 });
  assert.equal(noPath.grade, null, 'without the closing-line path: not graded overall');
  assert.deepEqual(noPath.failed, ['z']);

  const politics = T.gradeFor(s, 'politics');
  assert.deepEqual({ ...politics, edge: round4(politics.edge) }, { grade: 'A', edge: round4((40000 / 140000) * 0.5), scope: 'category' });
  assert.deepEqual(T.gradeFor(s, 'sports'), { grade: null, skip: 'no edge in sports (ROI -33.3% over 60 bets)' });
  assert.equal(T.gradeFor(s, 'crypto').grade, 'B', 'no crypto record: the overall grade');
  assert.deepEqual(T.gradeFor(noPath, 'sports'), { grade: null, skip: 'not graded in sports' });
  assert.deepEqual(T.gradeFor(noPath, 'crypto'), { grade: null, skip: 'not graded' });

  const mkt = market();
  const pol = T.tradeSignal({ trade: trade({ proxyWallet: W(1) }), trader: s, market: mkt, now: NOW });
  assert.equal(pol.signal.grade, 'A');
  assert.equal(pol.signal.category, 'politics');
  assert.equal(pol.signal.scope, 'category');
  const nba = T.tradeSignal({ trade: trade({ proxyWallet: W(1), title: 'Lakers vs. Celtics', eventSlug: 'nba-lal-bos-2026-10-08' }), trader: s, market: mkt, now: NOW });
  assert.deepEqual(nba, { signal: null, skip: 'no edge in sports (ROI -33.3% over 60 bets)' });

  // graded overall, but a real losing record in one category blocks it there
  const overallA = { wallet: W(2), grade: 'A', edge: 0.05, categories: { sports: { grade: null, n: 25, pnl: -2000, roi: -0.08 }, crypto: { grade: null, n: 10, pnl: -500, roi: -0.05 } } };
  assert.deepEqual(T.gradeFor(overallA, 'sports'), { grade: null, skip: 'no edge in sports (ROI -8% over 25 bets)' });
  assert.deepEqual(T.gradeFor(overallA, 'crypto'), { grade: 'A', edge: 0.05, scope: 'overall' }, 'too few bets to judge: overall grade');
  assert.deepEqual(T.gradeFor(overallA, 'politics'), { grade: 'A', edge: 0.05, scope: 'overall' });
});

// ── signals ──
// avgEntry 0.40 = the trade's price, so there q is exactly p × (1 + edge)
const trader = (o = {}) => ({ wallet: W(9), name: 'sharpie', grade: 'A', edge: 0.05, avgEntry: 0.4, categories: {}, ...o });
const market = (o = {}) => T.parseGammaMarket({
  conditionId: '0xm1', question: 'Will X win the Ohio Senate election?', outcomes: '["Yes","No"]', outcomePrices: '["0.405","0.595"]',
  clobTokenIds: '["tok-yes","tok-no"]', bestBid: '0.40', bestAsk: '0.41', lastTradePrice: '0.41', endDate: '2026-11-04T00:00:00Z',
  active: true, closed: false, events: [{ slug: 'ohio-senate' }], ...o,
});
const trade = (o = {}) => T.parseTrades([{
  proxyWallet: W(9), side: 'BUY', asset: 'tok-yes', conditionId: '0xm1', size: 2000, price: 0.40, timestamp: Math.floor((NOW - 60e3) / 1000),
  title: 'Will X win the Ohio Senate election?', slug: 'will-x-win', eventSlug: 'ohio-senate', outcome: 'Yes', outcomeIndex: 0,
  name: 'sharpie', transactionHash: '0xtx1', ...o,
}])[0];
const sig = (o = {}) => T.tradeSignal({ trade: trade(o.trade), trader: trader(o.trader), market: o.market === null ? null : market(o.market), consensus: o.consensus, now: NOW, opts: o.opts }).signal;

test('signal: Kelly at the CURRENT price, quarter Kelly in units of 1% bankroll', () => {
  const s = sig();
  // q = 0.40 × 1.05 = 0.42; we can buy at 0.41 → f = 0.01 / 0.59
  assert.equal(s.type, 'entry');
  assert.equal(s.id, `0xtx1:tok-yes:${W(9)}`);
  assert.equal(s.prob, 0.42);
  assert.equal(s.currentPrice, 0.41);
  assert.equal(s.slippage, 0.01);
  assert.equal(s.kelly, round4(0.01 / 0.59));
  assert.equal(s.units, round2(0.25 * (0.01 / 0.59) * 100));
  assert.equal(s.units, 0.42, 'at their 0.40 it would have been 0.83u');
  assert.equal(s.reason, null);
  assert.deepEqual(
    { wallet: s.wallet, name: s.name, grade: s.grade, category: s.category, market: s.market, eventSlug: s.eventSlug, conditionId: s.conditionId, outcome: s.outcome, theirPrice: s.theirPrice, theirNotional: s.theirNotional, edge: s.edge, cap: s.cap, consensus: s.consensus, isConsensus: s.isConsensus, at: s.at, url: s.url },
    { wallet: W(9), name: 'sharpie', grade: 'A', category: 'politics', market: 'Will X win the Ohio Senate election?', eventSlug: 'ohio-senate', conditionId: '0xm1', outcome: 'Yes', theirPrice: 0.4, theirNotional: 800, edge: 0.05, cap: 2, consensus: [W(9)], isConsensus: false, at: new Date(NOW - 60e3).toISOString(), url: 'https://polymarket.com/event/ohio-senate' },
  );
  // the NO side is priced off the first outcome's bid: 1 − 0.42
  const no = sig({ trade: { asset: 'tok-no', outcome: 'No', outcomeIndex: 1, price: 0.58 }, market: { bestBid: '0.42', bestAsk: '0.43' } });
  assert.equal(no.currentPrice, 0.58);
  const qNo = T.trueProb(0.58, 0.05, 0.4);
  assert.equal(no.prob, round4(qNo));
  assert.equal(no.units, round2(25 * ((qNo - 0.58) / 0.42)));
});

test('the edge is an ROI at the wallet\'s usual price, carried to other prices as a shift in the odds', () => {
  near(T.trueProb(0.4, 0.05, 0.4), 0.42, 1e-12, 'at its average entry: p × (1 + edge)');
  near(T.trueProb(0.5, 0.1, 0.5), 0.55, 1e-12);
  // a 95¢ favourite can't return more than 5%: the same skill is worth far less there
  const fav = T.trueProb(0.95, 0.0577, 0.5);
  assert.ok(fav > 0.95 && fav < 0.96, String(fav));
  assert.ok(T.trueProb(0.1, 0.0577, 0.5) / 0.1 - 1 > 0.0577, 'a longshot gains a bit more than the average ROI');
  assert.equal(T.trueProb(0, 0.1), null);
  // the reviewer's case: an A wallet with a 5.8% edge, buying favourites a cent or two under our price
  const run = (p, c) => T.tradeSignal({ trade: trade({ price: p, size: 5000 }), trader: trader({ edge: 0.0577, avgEntry: 0.5 }), market: market({ bestAsk: String(c), bestBid: String(c - 0.01) }), now: NOW }).signal;
  assert.equal(run(0.93, 0.94).units, 0, 'q 0.937 < 0.94: no edge left');
  assert.equal(run(0.96, 0.98).units, 0);
  assert.ok(run(0.8, 0.81).units < 1.1, 'no longer the 2u cap');
  assert.ok(run(0.3, 0.31).units > 0.5, 'and a 30¢ shot is no longer starved');
});

test('signal: units cap at 2u for A and 1u for B; a favourite is never priced near certain', () => {
  // edge 0.2 at 40¢ is q 0.48; at 80¢ the same odds shift is q 0.847: f = 0.047 / 0.2 → 5.9u raw
  const fav = { trade: { price: 0.8, size: 1000 }, market: { bestAsk: '0.80', bestBid: '0.79' }, trader: { edge: 0.2 } };
  assert.equal(sig(fav).kelly, round4((T.trueProb(0.8, 0.2, 0.4) - 0.8) / 0.2));
  assert.equal(sig(fav).units, 2);
  assert.equal(sig({ ...fav, trader: { edge: 0.2, grade: 'B' } }).units, 1);
  assert.equal(sig({ ...fav, opts: { grades: { A: { capUnits: 1.5 } } } }).units, 1.5);
  const lock = sig({ trade: { price: 0.97, size: 1000 }, market: { bestAsk: '0.97', bestBid: '0.96' } });
  assert.equal(lock.prob, round4(T.trueProb(0.97, 0.05, 0.4)));
  assert.ok(lock.prob < 0.975, `0.99 was p × 1.05 clamped; now ${lock.prob}`);
  assert.equal(sig({ ...fav, opts: { maxProb: 0.82 } }).prob, 0.82, 'maxProb still bounds it');
});

test('signal: consensus (2+ graded wallets, same side) boosts ×1.5, still capped at 3u', () => {
  const plain = sig({ consensus: [W(10)] });
  assert.equal(plain.isConsensus, true);
  assert.deepEqual(plain.consensus, [W(9), W(10)]);
  assert.equal(plain.units, round2(0.25 * (0.01 / 0.59) * 100 * 1.5));
  assert.equal(sig({ consensus: [W(9)] }).isConsensus, false, 'its own earlier buy is not a second opinion');
  const fav = { trade: { price: 0.8, size: 1000 }, market: { bestAsk: '0.80', bestBid: '0.79' }, consensus: [W(10)], trader: { edge: 0.2 } };
  assert.equal(sig(fav).units, 3, 'A: 2u × 1.5');
  assert.equal(sig(fav).cap, 3);
  assert.equal(sig({ ...fav, trader: { edge: 0.2, grade: 'B' } }).units, 1.5, 'B: 1u × 1.5');
  assert.equal(sig({ ...fav, trader: { edge: 0.2, grade: 'B' } }).cap, 1.5);
  assert.equal(sig({ ...fav, opts: { maxUnits: 2.5 } }).units, 2.5, 'never above maxUnits');
});

test('signal: the price ran → 0u, don\'t chase', () => {
  const big = { trader: { edge: 0.2 } };   // q = 0.48
  const at3c = sig({ ...big, market: { bestAsk: '0.43' } });
  assert.equal(at3c.slippage, 0.03);
  assert.equal(at3c.units, 2, 'exactly 3¢ of slippage is still a bet');
  const past = sig({ ...big, market: { bestAsk: '0.4301' } });
  assert.equal(past.units, 0);
  assert.equal(past.reason, "price ran, don't chase");
  const gone = sig({ market: { bestAsk: '0.42' } });   // q = 0.42 = c → f = 0
  assert.equal(gone.kelly, 0);
  assert.equal(gone.units, 0);
  assert.equal(gone.reason, "price ran, don't chase");
  const noQuote = sig({ market: null });
  assert.equal(noQuote.units, 0);
  assert.equal(noQuote.currentPrice, null);
  assert.match(noQuote.reason, /no live price/);
  const empty = sig({ market: { bestAsk: '1', bestBid: '0', outcomePrices: '["1","0"]' } });
  assert.equal(empty.units, 0, 'no ask to buy at');
});

test('signal: skips small trades, closing markets, stale and ungraded; SELLs are exits', () => {
  const run = (o = {}) => T.tradeSignal({ trade: trade(o.trade), trader: o.trader === null ? null : trader(o.trader), market: market(o.market), now: NOW });
  assert.deepEqual(run({ trade: { size: 1249 } }), { signal: null, skip: 'under $500' }, '$499.60');
  assert.ok(run({ trade: { size: 1250 } }).signal, '$500 exactly counts');
  assert.deepEqual(run({ market: { endDate: new Date(NOW + 14 * 60e3).toISOString() } }), { signal: null, skip: 'market resolves within 15 min' });
  assert.ok(run({ market: { endDate: new Date(NOW + 16 * 60e3).toISOString() } }).signal);
  assert.deepEqual(run({ market: { closed: true } }), { signal: null, skip: 'market closed' });
  assert.deepEqual(run({ trade: { timestamp: Math.floor((NOW - 2 * 3600e3) / 1000) } }), { signal: null, skip: 'stale trade' });
  assert.deepEqual(run({ trader: { grade: null } }), { signal: null, skip: 'not graded' });
  assert.deepEqual(run({ trader: null }), { signal: null, skip: 'not graded' });
  const exit = run({ trade: { side: 'SELL', price: 0.55 } }).signal;
  assert.equal(exit.type, 'exit');
  assert.equal(exit.theirPrice, 0.55);
  assert.equal(exit.units, undefined, 'exits are not sized');
  assert.equal(run({ trade: { side: 'SELL', size: 100 } }).skip, 'under $500');
});

// ── fetchers ──
function recorder(handler) {
  const calls = [];
  return { calls, async get(url, opts = {}) { calls.push({ url, ...opts }); return { data: await handler(url, opts.params || {}) }; } };
}
// a v2 list page: { data, pagination } with an opaque cursor (here the offset)
function page(rows, p) {
  const off = p.cursor ? Number(String(p.cursor).slice(1)) : 0, lim = Number(p.limit || 100);
  const more = off + lim < rows.length;
  return { data: rows.slice(off, off + lim), pagination: { limit: lim, offset: off, has_more: more, next_cursor: more ? `c${off + lim}` : null } };
}

test('leaderboard (v2): every category × period, lowercase params, deduped by wallet, one failure does not sink the rest', async () => {
  const http = recorder((url, p) => {
    if (p.category === 'sports' && p.time_period === 'all') throw new Error('429');
    if (p.category === 'politics') return { data: [{ rank: 1, user_id: '0xAA', user_name: 'Oracle', pnl: p.time_period === 'all' ? 90000 : 5000, volume: 1e6 }], pagination: { limit: 50, offset: 0, has_more: false, next_cursor: null } };
    return { data: [{ rank: 3, user_id: '0xaa', pnl: 1000 }, { rank: 4, user_id: '0xbb', user_name: 'Jock', pnl: 700 }] };
  });
  const { rows, errors } = await T.fetchLeaderboard(http, { categories: ['POLITICS', 'SPORTS'], periods: ['WEEK', 'ALL'] });
  assert.deepEqual(http.calls[0], { url: 'https://data-api.polymarket.com/v2/leaderboard', params: { category: 'politics', time_period: 'week', sort_by: 'PNL', limit: 50 }, timeout: 10000 });
  assert.equal(http.calls.length, 4);
  assert.deepEqual(errors, [{ key: 'SPORTS:ALL', message: '429' }]);
  assert.equal(rows.length, 2);
  const aa = rows.find(r => r.wallet === '0xaa');
  assert.deepEqual(aa.sources, ['POLITICS:WEEK', 'POLITICS:ALL', 'SPORTS:WEEK']);
  assert.equal(aa.pnl, 90000);
  assert.equal(aa.rank, 1);
  assert.equal(aa.name, 'Oracle');
  http.calls.length = 0;
  await T.fetchLeaderboard(http);
  assert.equal(http.calls.length, T.LEADERBOARD_CATEGORIES.length * T.LEADERBOARD_PERIODS.length);
  assert.ok(http.calls.some(c => c.params.category === 'esports'), 'esports has its own board');
  assert.ok(http.calls.every(c => c.url.includes('/v2/')), 'v1 is retired');
});

test('v2 lists follow next_cursor to the end or the page cap (truncated); settled = CLOSED + REDEEMABLE + REDEEMABLE_LOST', async () => {
  const all = [
    ...Array.from({ length: 5 }, (_, i) => closed({ wallet: W(1), won: true, cond: `0xp${i}`, at: NOW - i * DAY })),
    closed({ wallet: W(1), won: true, status: 'REDEEMABLE', cond: '0xpr' }),
    closed({ wallet: W(1), won: false, status: 'REDEEMABLE_LOST', cond: '0xpl' }),
  ];
  const http = recorder((url, p) => {
    if (url.endsWith('/v2/positions')) {
      if (p.status === 'OPEN') return page([{ condition_id: '0xo', token_id: 'o', current_size: 1, avg_price: 0.5 }], p);
      // the API's rows may leave out their status: the list they came from says it
      return page(all.filter(r => r.status === p.status).map(({ status, ...r }) => r), p);
    }
    if (url.endsWith('/v2/trades')) return { data: [{ proxy_wallet: '0xA', side: 'BUY', token_id: 't', size: 2000, price: 0.5, timestamp: NOW / 1000, transaction_hash: '0x9' }], pagination: { has_more: false } };
    if (url.endsWith('/markets')) return [{ conditionId: 'other' }, { conditionId: p.condition_ids, question: 'Q', outcomes: '["Yes","No"]' }];
    throw new Error(url);
  });
  const full = await T.fetchSettledPositions(http, W(1), { pageSize: 2, maxPages: 5 });
  assert.equal(full.rows.length, 7);
  assert.equal(full.truncated, false);
  assert.deepEqual(full.counts, { CLOSED: 5, REDEEMABLE: 1, REDEEMABLE_LOST: 1 });
  assert.deepEqual(full.rows.map(r => r.status), ['CLOSED', 'CLOSED', 'CLOSED', 'CLOSED', 'CLOSED', 'REDEEMABLE', 'REDEEMABLE_LOST']);
  assert.deepEqual(http.calls.map(c => [c.params.status, c.params.cursor]),
    [['CLOSED', undefined], ['CLOSED', 'c2'], ['CLOSED', 'c4'], ['REDEEMABLE', undefined], ['REDEEMABLE_LOST', undefined]]);
  assert.deepEqual(http.calls[0], {
    url: 'https://data-api.polymarket.com/v2/positions', timeout: 10000,
    params: { user: W(1), status: 'CLOSED', limit: 2, sort_by: 'TIMESTAMP', sort_direction: 'DESC' },
  }, 'newest first: CLOSED would otherwise sort by realized P&L and keep only the winners; no include_archived (a 400 on CLOSED)');
  assert.deepEqual(http.calls.filter(c => c.params.include_archived).map(c => c.params.status), ['REDEEMABLE', 'REDEEMABLE_LOST'], 'archived unclaimed positions count');
  assert.equal(T.scoreWallet({ wallet: W(1), closed: full.rows }, { now: NOW }).n, 7);

  http.calls.length = 0;
  const capped = await T.fetchSettledPositions(http, W(1), { pageSize: 2, maxPages: 2 });
  assert.equal(capped.truncated, true, 'pages were left');
  assert.equal(capped.counts.CLOSED, 4);
  assert.equal(http.calls.filter(c => c.params.status === 'CLOSED').length, 2);
  assert.equal((await T.fetchSettledPositions(http, W(1), { pageSize: 5000 })).rows.length, 7);
  assert.equal(http.calls.at(-1).params.limit, 1000, 'never more than the API serves');

  // the API turning include_archived down (400) costs a retry, not the wallet
  const picky = recorder((url, p) => {
    if (p.include_archived) throw Object.assign(new Error('Request failed with status code 400'), { response: { status: 400 } });
    return page(all.filter(r => r.status === p.status), p);
  });
  assert.equal((await T.fetchSettledPositions(picky, W(1))).rows.length, 7);
  assert.deepEqual(picky.calls.map(c => [c.params.status, !!c.params.include_archived]),
    [['CLOSED', false], ['REDEEMABLE', true], ['REDEEMABLE', false], ['REDEEMABLE_LOST', true], ['REDEEMABLE_LOST', false]]);
  const down = recorder(() => { throw Object.assign(new Error('Request failed with status code 500'), { response: { status: 500 } }); });
  await assert.rejects(T.fetchSettledPositions(down, W(1)), /500/, 'other failures still fail');

  http.calls.length = 0;
  const open = await T.fetchOpenPositions(http, W(1));
  assert.deepEqual([open.rows.length, open.truncated], [1, false]);
  assert.deepEqual(http.calls[0].params, { user: W(1), status: 'OPEN', limit: 500, sort_by: 'TIMESTAMP', sort_direction: 'DESC' });
  const big = await T.fetchRecentTrades(http);
  assert.equal(big[0].notional, 1000);
  assert.deepEqual(http.calls[1], { url: 'https://data-api.polymarket.com/v2/trades', params: { limit: 500, taker_only: true, filter_type: 'CASH', filter_amount: 500 }, timeout: 10000 },
    'CASH always (the default is TOKENS)');
  await T.fetchWalletTrades(http, W(1));
  assert.deepEqual(http.calls[2].params, { user: W(1), limit: 500, taker_only: false });
  const m = await T.fetchMarket(http, '0xm');
  assert.equal(m.conditionId, '0xm');
  assert.equal((await T.fetchMarket({ async get() { return { data: [{ conditionId: '0xABC' }] }; } }, '0xabc')).conditionId, '0xABC', 'hex case does not matter');
  assert.equal(await T.fetchMarket({ async get() { return { data: [] }; } }, '0xabc'), null);
  assert.deepEqual(http.calls[3], { url: 'https://gamma-api.polymarket.com/markets', params: { condition_ids: '0xm' }, timeout: 10000 });
});

test('fetchPaged: has_more false or a null cursor ends it, a stuck cursor is truncated, { data: null } is an empty page', async () => {
  const run = async (pages, maxPages = 5) => {
    const http = recorder((url, p) => pages[p.cursor || 'start']);
    return { ...(await T.fetchPaged(http, 'https://data-api.polymarket.com/v2/x', { user: 'u' }, { maxPages })), calls: http.calls.map(c => c.params.cursor ?? null) };
  };
  assert.deepEqual(await run({ start: { data: [1, 2], pagination: { has_more: true, next_cursor: 'b' } }, b: { data: [3], pagination: { has_more: false, next_cursor: 'zzz' } } }),
    { rows: [1, 2, 3], truncated: false, pages: 2, calls: [null, 'b'] });
  assert.deepEqual(await run({ start: { data: [1], pagination: { has_more: true, next_cursor: 'a' } }, a: { data: [2], pagination: { has_more: true, next_cursor: 'a' } } }),
    { rows: [1, 2], truncated: true, pages: 2, calls: [null, 'a'] }, 'the same cursor again: stop, and say so');
  assert.deepEqual(await run({ start: { data: null } }), { rows: [], truncated: false, pages: 1, calls: [null] });
  assert.deepEqual(await run({ start: { data: [1], pagination: { has_more: true, next_cursor: 'n' } }, n: { data: [], pagination: { has_more: true, next_cursor: 'm' } } }),
    { rows: [1], truncated: false, pages: 2, calls: [null, 'n'] }, 'an empty page ends it');
  const capped = await run({ start: { data: [1], pagination: { has_more: true, next_cursor: 'n' } } }, 1);
  assert.deepEqual([capped.rows, capped.truncated], [[1], true]);
  await assert.rejects(T.fetchPaged(recorder(() => ({ error: 'rate limited' })), 'u', {}, { what: 'stuff' }), /stuff: unexpected response/);
});

test('a capped settled list cuts the others to the same stretch of time, so capped winners never sit beside every loser ever', async () => {
  // six claimed winners 1-6 days ago; losers nobody claimed 2, 5 and 8 days ago
  const won = [1, 2, 3, 4, 5, 6].map(d => closed({ wallet: W(2), won: true, cond: `0xw${d}`, at: NOW - d * DAY }));
  const lost = [2, 5, 8].map(d => closed({ wallet: W(2), won: false, status: 'REDEEMABLE_LOST', cond: `0xl${d}`, at: NOW - d * DAY }));
  const http = recorder((url, p) => page([...won, ...lost].filter(r => r.status === p.status), p));
  const r = await T.fetchSettledPositions(http, W(2), { pageSize: 2, maxPages: 2 });
  assert.equal(r.truncated, true);
  // the closed list reached back to 4 days ago (its last_event_at); unclaimed rows sort by their entry (2 days before)
  assert.deepEqual(r.counts, { CLOSED: 4, REDEEMABLE: 0, REDEEMABLE_LOST: 1 });
  assert.deepEqual(r.rows.filter(x => x.status === 'REDEEMABLE_LOST').map(x => x.condition_id), ['0xl2']);
  const whole = await T.fetchSettledPositions(http, W(2), { pageSize: 10 });
  assert.deepEqual([whole.truncated, whole.rows.length], [false, 9], 'nothing capped, nothing cut');
});

// ── engine ──
// a 5-minute price series over the requested window, at one price
const flatHistory = (p, price) => {
  const points = [];
  for (let t = p.start; t < p.end && points.length < 1000; t += 300) points.push({ t, p: price });
  return { data: { history: points } };
};
function world() {
  const w = { leaderboard: [], closed: {}, open: {}, walletTrades: {}, trades: [], markets: {}, books: {}, history: {}, closeFor: () => 0.53, fail: new Set() };
  w.http = recorder((url, p) => {
    if (url.endsWith('/v2/leaderboard')) return page(w.leaderboard, p);
    if (p.user && w.fail.has(p.user)) throw new Error('timeout');
    if (url.endsWith('/v2/positions')) {
      if (p.status === 'OPEN') return page(w.open[p.user] || [], p);
      return page((w.closed[p.user] || []).filter(r => (r.status || 'CLOSED') === p.status), p);
    }
    if (url.endsWith('/v2/trades')) return page(p.user ? w.walletTrades[p.user] || [] : w.trades, p);
    if (url.endsWith('/v2/prices-history')) {
      const h = w.history[p.token_id];
      if (h instanceof Error) throw h;
      return typeof h === 'function' ? h(p) : h ?? flatHistory(p, w.closeFor(p.token_id));
    }
    if (url.endsWith('/markets')) return w.markets[p.condition_ids] ? [w.markets[p.condition_ids]] : [];
    if (url.endsWith('/book')) { if (w.books[p.token_id]) return w.books[p.token_id]; throw new Error('no book'); }
    throw new Error(`unexpected ${url}`);
  });
  return w;
}
// each wallet's first settled read (its CLOSED list, first page)
const scoredUsers = http => http.calls.filter(c => c.url.endsWith('/v2/positions') && c.params.status === 'CLOSED' && !c.params.cursor).map(c => c.params.user);
const historyCalls = http => http.calls.filter(c => c.url.endsWith('/v2/prices-history'));
const gammaMarket = (o = {}) => ({
  conditionId: '0xm1', question: 'Will X win the Ohio Senate election?', outcomes: '["Yes","No"]', outcomePrices: '["0.415","0.585"]',
  clobTokenIds: '["tok-yes","tok-no"]', bestBid: '0.41', bestAsk: '0.42', lastTradePrice: '0.42', endDate: '2026-11-04T00:00:00Z',
  active: true, closed: false, events: [{ slug: 'ohio-senate' }], ...o,
});
const rawTrade = (wallet, o = {}) => ({
  proxyWallet: wallet, side: 'BUY', asset: 'tok-yes', conditionId: '0xm1', size: 2000, price: 0.40, timestamp: Math.floor((NOW - 60e3) / 1000),
  title: 'Will X win the Ohio Senate election?', slug: 'will-x-win', eventSlug: 'ohio-senate', outcome: 'Yes', outcomeIndex: 0,
  transactionHash: `0xtx-${wallet.slice(-2)}`, ...o,
});

test('scoreBatch is rate-limited: a few wallets per call, never overlapping, stale ones rescored', async () => {
  const w = world();
  w.leaderboard = [1, 2, 3, 4, 5].map(i => ({ proxyWallet: W(i), userName: `u${i}`, pnl: 1000 * i }));
  for (let i = 1; i <= 5; i++) w.closed[W(i)] = politicsElite(W(i));
  let t = NOW;
  const eng = T.createTailEngine({ http: w.http, now: () => t, opts: { batchSize: 2 }, log: {} });
  assert.deepEqual(await eng.refreshCandidates({ categories: ['POLITICS'], periods: ['ALL'] }), { added: 5, total: 5, errors: [] });

  const first = await eng.scoreBatch();
  assert.equal(first.scored, 2);
  assert.deepEqual(first.wallets, [W(5), W(4)], 'biggest leaderboard PnL first');
  assert.deepEqual(scoredUsers(w.http), [W(5), W(4)], 'only those two wallets were fetched');
  assert.equal(first.pending, 3);
  assert.equal(w.http.calls.filter(c => c.params.user === W(5)).length, 5, 'CLOSED, REDEEMABLE, REDEEMABLE_LOST, open and trades per wallet');
  assert.equal(historyCalls(w.http).length, 2 * 25, 'and 25 closing lines for each of the two (both pass B without them)');

  const [a, b] = await Promise.all([eng.scoreBatch(), eng.scoreBatch()]);
  assert.equal(a.scored, 2);
  assert.equal(b.busy, true, 'an overlapping cron tick does nothing');
  assert.equal((await eng.scoreBatch()).scored, 1);
  assert.equal((await eng.scoreBatch()).scored, 0, 'all fresh');
  assert.equal(scoredUsers(w.http).length, 5);
  assert.equal(eng.state().graded.A, 5);

  t += 12 * 3600e3;
  assert.deepEqual((await eng.scoreBatch()).wallets.length, 2, 'stale scores come back round');
  // graded wallets due a rescore go before anyone new
  eng.addCandidate(W(7), { sources: ['POLITICS:DAY'], pnl: 1e6 });
  assert.deepEqual((await eng.scoreBatch(4)).wallets, [W(3), W(4), W(5), W(7)]);

  // a failing wallet waits before it is retried
  eng.addCandidate(W(6));
  w.fail.add(W(6));
  w.http.calls.length = 0;
  const failed = await eng.scoreBatch(1);
  assert.equal(failed.scored, 0);
  assert.equal(eng.state().errors.at(-1).message, 'score 0x…: timeout', 'wallets are masked in the public health log');
  w.fail.delete(W(6));
  assert.ok(!(await eng.scoreBatch(1)).wallets.includes(W(6)), 'not retried right away');
  t += 31 * 60e3;
  assert.ok((await eng.scoreBatch(10)).wallets.includes(W(6)));
});

test('pollTrades: signals, dedup across polls, consensus boost, SELL exits, new wallets queued', async () => {
  const w = world();
  w.leaderboard = [{ proxyWallet: W(1) }, { proxyWallet: W(2) }];
  w.closed[W(1)] = politicsElite(W(1));
  w.closed[W(2)] = politicsElite(W(2));
  w.markets['0xm1'] = gammaMarket();
  let t = NOW;
  const eng = T.createTailEngine({ http: w.http, now: () => t, opts: { watchPerPoll: 0 }, log: {} });
  await eng.refreshCandidates({ categories: ['OVERALL'], periods: ['ALL'] });
  await eng.scoreBatch(5);
  assert.equal(eng.trader(W(1)).grade, 'A');

  // W1 buys at 0.40 (two fills of one order); the ask is now 0.42
  w.trades = [rawTrade(W(1), { size: 1500 }), rawTrade(W(1), { size: 500 }), rawTrade(W(77), { size: 15000, transactionHash: '0xnew' }),
    rawTrade(W(78), { size: 5000, transactionHash: '0xpunt' })];
  const s1 = await eng.pollTrades();
  assert.equal(s1.length, 1);
  const edge = (40000 / 140000) * 0.5, q = T.trueProb(0.4, edge, 0.5);   // its bets were all at 50¢
  const units = cons => round2(Math.min(Math.min(25 * (q - 0.42) / 0.58, 2) * (cons ? 1.5 : 1), 3));
  assert.equal(s1[0].theirNotional, 800, 'fills merged');
  assert.deepEqual([s1[0].currentPrice, s1[0].priceSource], [0.42, 'gamma'], 'no book to read: a fresh Gamma price');
  assert.ok(w.http.calls.some(c => c.url === 'https://clob.polymarket.com/book' && c.params.token_id === 'tok-yes'), 'the bought token\'s book was asked for');
  assert.equal(s1[0].prob, round4(q));
  assert.equal(s1[0].units, units(false));
  assert.equal(s1[0].isConsensus, false);
  assert.equal(eng.state().candidates, 3, 'the unknown $6,000 trader is queued; a one-off $2,000 punter is not');

  assert.deepEqual(await eng.pollTrades(), [], 'the same trades on the next poll are not signals again');

  // a second graded wallet buys the same side two hours later
  t += 2 * 3600e3;
  w.trades = [rawTrade(W(2), { timestamp: Math.floor((t - 30e3) / 1000) }), ...w.trades];
  const s2 = await eng.pollTrades();
  assert.equal(s2.length, 1);
  assert.deepEqual(s2[0].consensus, [W(2), W(1)]);
  assert.equal(s2[0].isConsensus, true);
  assert.equal(s2[0].target, units(true), 'consensus sizes it up...');
  assert.deepEqual([s2[0].eventKey, s2[0].eventUnits, s2[0].units], ['ohio-senate', units(false), round2(3 - units(false))],
    '...but followers already have W1\'s units on this event: 3u in all');

  // W1 sells out: an exit, and its vote no longer counts
  w.trades = [rawTrade(W(1), { side: 'SELL', price: 0.47, size: 2000, transactionHash: '0xsell', timestamp: Math.floor(t / 1000) }), ...w.trades];
  const s3 = await eng.pollTrades();
  assert.deepEqual(s3.map(s => [s.type, s.wallet, s.theirPrice]), [['exit', W(1), 0.47]]);
  w.trades = [rawTrade(W(2), { transactionHash: '0xagain', timestamp: Math.floor(t / 1000) })];
  assert.equal((await eng.pollTrades())[0].isConsensus, false, 'only W2 holds it now');

  // the queued wallet is scored next, ahead of the stale leaderboard ones
  w.closed[W(77)] = sportsBad(W(77));
  assert.deepEqual((await eng.scoreBatch(1)).wallets, [W(77)]);

  assert.equal(eng.signals().length, 4);
  assert.equal(eng.signals()[0].wallet, W(2), 'newest first');
  assert.equal(eng.signals({ type: 'exit' }).length, 1);
  assert.equal(eng.signals({ limit: 2 }).length, 2);
  assert.equal(w.http.calls.filter(c => c.url.endsWith('/markets') && c.params.condition_ids === '0xm1').length, 2, 'one lookup per market per 20 s: at NOW and at +2h');
  const st = eng.state();
  assert.equal(st.signals, 4);
  assert.equal(st.lastPollAt, new Date(t).toISOString());
});

test('pollTrades: sharps on both sides of one market are not tailed twice; a hedge is not a pick; one game takes 3u at most', async () => {
  const w = world();
  for (const i of [1, 2, 3]) w.closed[W(i)] = politicsElite(W(i));
  w.markets['0xm1'] = gammaMarket();
  w.markets['0xm2'] = gammaMarket({ conditionId: '0xm2', question: 'Will X win the Ohio Senate election by 10+?', clobTokenIds: '["tok2-yes","tok2-no"]' });
  let t = NOW;
  const eng = T.createTailEngine({ http: w.http, now: () => t, opts: { watchPerPoll: 0 }, log: {} });
  for (const i of [1, 2, 3]) eng.addCandidate(W(i));
  await eng.scoreBatch(5);
  const told = [];
  const route = s => { told.push([s.wallet, s.asset, s.units]); return s.units; };
  const at = () => Math.floor((t - 30e3) / 1000);

  w.trades = [rawTrade(W(1), { timestamp: at() })];
  const [a] = await eng.pollTrades({ route });
  assert.ok(a.units > 0 && a.blocked === null && a.against.length === 0);

  // W2 takes the other side an hour later: split one against one, nothing staked
  t += 3600e3;
  w.trades = [rawTrade(W(2), { asset: 'tok-no', outcome: 'No', outcomeIndex: 1, price: 0.58, transactionHash: '0xno', timestamp: at() })];
  w.markets['0xm1'] = gammaMarket({ bestAsk: '0.42', outcomePrices: '["0.41","0.59"]' });
  const [b] = await eng.pollTrades({ route });
  assert.deepEqual([b.blocked, b.units, b.against], ['split', 0, [W(1)]]);
  assert.match(b.reason, /graded sharps split: 1 on the other side/);

  // a third sharp joins W1's side: two against one, so it's a pick again (inside what's left of the cap)
  t += 600e3;
  w.trades = [rawTrade(W(3), { transactionHash: '0xthird', timestamp: at() })];
  const [c] = await eng.pollTrades({ route });
  assert.deepEqual([c.blocked, c.against, c.isConsensus], [null, [W(2)], true]);
  assert.equal(c.eventUnits, a.units);
  assert.equal(c.units, Math.round(Math.min(c.target, 3 - a.units) * 100) / 100);

  // W1 buys the other side of its own bet: a hedge
  t += 600e3;
  w.trades = [rawTrade(W(1), { asset: 'tok-no', outcome: 'No', outcomeIndex: 1, price: 0.58, transactionHash: '0xhedge', timestamp: at() })];
  const [d] = await eng.pollTrades({ route });
  assert.equal(d.blocked, 'split');
  assert.match(d.reason, /hedge/);

  // another market on the same race: the event is full
  t += 600e3;
  w.trades = [rawTrade(W(2), { conditionId: '0xm2', asset: 'tok2-yes', title: 'Will X win the Ohio Senate election by 10+?', transactionHash: '0xm2buy', timestamp: at() })];
  const [e] = await eng.pollTrades({ route });
  assert.equal(e.eventKey, 'ohio-senate');
  assert.equal(e.eventUnits, 3);
  assert.deepEqual([e.units, e.eventRoom], [0, 0]);
  assert.match(e.reason, /already 3u on this event \(max 3u\)/);
  assert.equal(Math.round(told.reduce((x, r) => x + r[2], 0) * 100) / 100, 3, 'followers were told 3u in all');

  // a day later the cap has room again
  t += 25 * 3600e3;
  w.trades = [rawTrade(W(2), { conditionId: '0xm2', asset: 'tok2-yes', title: 'Will X win the Ohio Senate election by 10+?', transactionHash: '0xm2later', timestamp: at() })];
  const [f] = await eng.pollTrades({ route });
  assert.ok(f.units > 0 && f.eventUnits === 0);
  // TAIL_MAX_EVENT_UNITS=0 turns the cap off
  assert.equal(T.optionsFromEnv({ TAIL_MAX_EVENT_UNITS: '0' }).maxEventUnits, 0);
});

test('pollTrades: stale trades count for consensus but signal nothing; graded wallets\' own maker trades are read', async () => {
  const w = world();
  w.closed[W(1)] = politicsElite(W(1));
  w.closed[W(2)] = politicsElite(W(2));
  w.markets['0xm1'] = gammaMarket();
  const t = NOW;
  const eng = T.createTailEngine({ http: w.http, now: () => t, opts: { watchPerPoll: 1 }, log: {} });
  eng.addCandidate(W(1));
  eng.addCandidate(W(2));
  await eng.scoreBatch(2);
  w.trades = [rawTrade(W(1), { timestamp: Math.floor((t - 5 * 3600e3) / 1000) })];   // 5h ago
  w.walletTrades[W(1)] = [];
  w.walletTrades[W(2)] = [rawTrade(W(2), { transactionHash: '0xmaker' })];
  const out = await eng.pollTrades();
  assert.deepEqual(out.map(s => s.wallet), [], 'W1 polled first: its old trade is history');
  const again = await eng.pollTrades();
  assert.deepEqual(again.map(s => [s.wallet, s.isConsensus]), [[W(2), true]], 'W2 found via its own trades, and W1\'s earlier buy backs it');
  const userCalls = w.http.calls.filter(c => c.url.endsWith('/trades') && c.params.user);
  assert.deepEqual(userCalls.slice(-2).map(c => c.params), [{ user: W(1), limit: 50, taker_only: false }, { user: W(2), limit: 50, taker_only: false }], 'round robin');
});

test('ingest: live-feed trades signal at once, share the poll\'s dedup, and skip small trades by unknown wallets', async () => {
  const w = world();
  w.closed[W(1)] = politicsElite(W(1));
  w.markets['0xm1'] = gammaMarket();
  const t = NOW;
  const eng = T.createTailEngine({ http: w.http, now: () => t, opts: { watchPerPoll: 0 }, log: {} });
  eng.addCandidate(W(1));
  await eng.scoreBatch(1);
  const live = T.parseTrades([rawTrade(W(1), { timestamp: Math.floor((t - 2e3) / 1000) }), rawTrade(W(80), { size: 50, transactionHash: '0xsmall' }),
    rawTrade(W(81), { size: 15000, transactionHash: '0xwhale' })]);
  const routed = [];
  const out = await eng.ingest(live, { route: s => { routed.push(s.id); return s.units; } });
  assert.deepEqual(out.map(s => [s.wallet, s.via, s.lagMs]), [[W(1), 'stream', 2000]], 'seconds after the fill');
  assert.deepEqual(routed, [out[0].id]);
  assert.equal(eng.state().candidates, 2, 'the $6,000 stranger is queued');
  assert.equal(eng.state().seenTrades, 2, 'a $20 trade by a stranger is not even remembered');
  assert.equal(eng.state().lastStreamAt, new Date(t).toISOString());
  // the next poll reads the same trade: not a second signal
  w.trades = [rawTrade(W(1), { timestamp: Math.floor((t - 2e3) / 1000) })];
  assert.deepEqual(await eng.pollTrades(), []);
  // a poll and a stream batch at once judge one after the other
  w.trades = [rawTrade(W(1), { transactionHash: '0xboth' })];
  const [a, b2] = await Promise.all([eng.pollTrades(), eng.ingest(T.parseTrades([rawTrade(W(1), { transactionHash: '0xboth' })]))]);
  assert.equal(a.length + b2.length, 1, 'one signal for one trade');
  assert.deepEqual(await eng.ingest([]), []);
  assert.deepEqual(await eng.ingest(null), []);
});

// one live v2 position
const openPos = (wallet, { cond = '0xboard', idx = 0, shares, p, cur = p, title = 'Will Smith win the Ohio Senate election?', sold = 0 } = {}) => ({
  proxy_wallet: wallet, token_id: `${cond}-t${idx}`, condition_id: cond, current_size: shares, total_size: shares + sold, avg_price: String(p),
  total_cost_usdc: String((shares + sold) * p), current_price: cur, status: 'OPEN', title, slug: 'ohio-m', event_slug: 'ohio-senate',
  outcome: idx ? 'No' : 'Yes', outcome_index: idx, end_date: '2026-11-04T00:00:00Z', first_entry_at: new Date(NOW - 5 * DAY).toISOString(),
});

test('holdingsOf: what is still held, biggest first; settled and nearly settled ones are left out', () => {
  const rows = T.parseOpenPositions([
    openPos(W(1), { shares: 5000, p: 0.4, sold: 5000 }),            // half sold: $2,000 still in
    openPos(W(1), { cond: '0xb', shares: 100, p: 0.5 }),
    openPos(W(1), { cond: '0xc', shares: 1000, p: 0.9, cur: 0.99 }),   // all but won
    openPos(W(1), { cond: '0xd', shares: 0, p: 0.5 }),
  ]);
  const h = T.holdingsOf(rows);
  assert.deepEqual(h.map(x => [x.conditionId, x.cost, x.price, x.size]), [['0xboard', 2000, 0.4, 5000], ['0xb', 50, 0.5, 100]]);
  assert.equal(h[0].category, 'politics');
  assert.equal(T.holdingsOf(rows, { max: 1 }).length, 1);
});

test('the Sharp Board: graded wallets\' positions by market, the side with the most sharp weight first, kept live by their trades', async () => {
  const w = world();
  for (const i of [1, 2, 3]) w.closed[W(i)] = politicsElite(W(i));
  w.open[W(1)] = [openPos(W(1), { shares: 5000, p: 0.4, cur: 0.38 }), openPos(W(1), { cond: '0xsmall', shares: 100, p: 0.5 })];
  w.open[W(2)] = [openPos(W(2), { shares: 2500, p: 0.4, cur: 0.38 })];
  w.open[W(3)] = [openPos(W(3), { idx: 1, shares: 1000, p: 0.6, cur: 0.62 })];
  w.closed[W(9)] = sportsBad(W(9));
  w.open[W(9)] = [openPos(W(9), { shares: 90000, p: 0.4 })];   // not graded: doesn't count
  let t = NOW;
  const eng = T.createTailEngine({ http: w.http, now: () => t, opts: { watchPerPoll: 0 }, log: {} });
  for (const i of [1, 2, 3, 9]) eng.addCandidate(W(i));
  await eng.scoreBatch(4);
  assert.equal(eng.trader(W(1)).grade, 'A');
  assert.equal(eng.trader(W(9)).holdings, undefined, 'an ungraded wallet keeps no book');

  const [row, ...rest] = eng.sharpBoard();
  assert.equal(rest.length, 0, 'a $50 position is under the $100 floor');
  assert.equal(row.conditionId, '0xboard');
  assert.equal(row.category, 'politics');
  assert.equal(row.wallets, 3);
  assert.deepEqual([row.lead.outcome, row.lead.wallets, row.lead.A, row.lead.B, row.lead.cost, row.lead.avgEntry, row.lead.price, row.lead.belowEntry],
    ['Yes', 2, 2, 0, 3000, 0.4, 0.38, true]);
  assert.deepEqual(row.lead.list.map(x => [x.wallet, x.cost]), [[W(1), 2000], [W(2), 1000]], 'biggest first');
  assert.deepEqual(row.against, { wallets: 1, cost: 600 });
  assert.equal(row.agreement, Math.round((3000 / 3600) * 1e4) / 1e4);
  assert.deepEqual(eng.sharpBoard({ category: 'sports' }), []);
  assert.deepEqual(eng.sharpBoard({ minWallets: 3 }), []);

  // a trade from before the score is already in it; later ones move the book
  await eng.ingest(T.parseTrades([rawTrade(W(2), { conditionId: '0xboard', asset: '0xboard-t0', side: 'SELL', size: 2500, price: 0.38, transactionHash: '0xold' })]));
  assert.equal(eng.sharpBoard()[0].lead.wallets, 2);
  t += 60e3;
  await eng.ingest(T.parseTrades([rawTrade(W(2), { conditionId: '0xboard', asset: '0xboard-t0', side: 'SELL', size: 2500, price: 0.38, transactionHash: '0xout', timestamp: Math.floor(t / 1000) })]));
  const after = eng.sharpBoard()[0];
  assert.deepEqual([after.lead.outcome, after.lead.wallets, after.lead.cost], ['Yes', 1, 2000], 'W2 sold out');
  await eng.ingest(T.parseTrades([rawTrade(W(3), { conditionId: '0xboard', asset: '0xboard-t1', outcome: 'No', outcomeIndex: 1, size: 5000, price: 0.62, transactionHash: '0xmore', timestamp: Math.floor(t / 1000) })]));
  const flipped = eng.sharpBoard()[0];
  assert.deepEqual([flipped.lead.outcome, flipped.lead.cost, flipped.against.wallets], ['No', 3700, 1], 'W3 doubled down: No leads on money, both A');
  await eng.ingest(T.parseTrades([rawTrade(W(1), { conditionId: '0xnew', asset: '0xnew-t0', title: 'Will Jones win the Iowa Senate election?', size: 1000, price: 0.3, transactionHash: '0xnew', timestamp: Math.floor(t / 1000) })]));
  assert.ok(eng.sharpBoard().some(r => r.conditionId === '0xnew' && r.lead.cost === 300), 'a new position shows up at once');
});

test('second chances: one alert when a held side gets back to the sharps\' entry, not every scan; book prices only', () => {
  const row = (o = {}, lead = {}) => ({ conditionId: '0xb', title: 'Will Smith win?', category: 'politics', against: { wallets: 0, cost: 0 }, agreement: 1, ...o,
    lead: { asset: 't0', outcome: 'Yes', wallets: 2, A: 1, B: 1, cost: 3000, avgEntry: 0.4, price: 0.42, priceSource: 'book', belowEntry: false, list: [], ...lead } });
  const below = (lead = {}, o = {}) => row(o, { price: 0.39, belowEntry: true, ...lead });
  let st = new Map(), r;
  r = T.boardAlerts([below()], st, { now: NOW, prime: true });
  assert.deepEqual(r.alerts, [], 'the first scan only learns');
  st = r.state;
  r = T.boardAlerts([below()], st, { now: NOW + 60e3 });
  assert.deepEqual(r.alerts, [], 'already there when we started: not news');
  r = T.boardAlerts([row()], r.state, { now: NOW + 120e3 });
  r = T.boardAlerts([below()], r.state, { now: NOW + 180e3 });
  assert.equal(r.alerts.length, 1, 'back under their entry');
  assert.deepEqual([r.alerts[0].type, r.alerts[0].outcome, r.alerts[0].avgEntry, r.alerts[0].price, r.alerts[0].wallets], ['entry-price', 'Yes', 0.4, 0.39, 2]);
  r = T.boardAlerts([below()], r.state, { now: NOW + 240e3 });
  assert.deepEqual(r.alerts, [], 'still there: no repeat');
  r = T.boardAlerts([row()], r.state, { now: NOW + 300e3 });
  r = T.boardAlerts([below()], r.state, { now: NOW + 360e3 });
  assert.deepEqual(r.alerts, [], 'bounced inside the cooldown: quiet');
  r = T.boardAlerts([], r.state, { now: NOW + 400e3 });
  assert.ok(r.state.has('0xb|t0'), 'off the board, the cooldown is kept');
  r = T.boardAlerts([below()], r.state, { now: NOW + 7 * 3600e3 });
  assert.equal(r.alerts.length, 1, 'after the cooldown it can fire again');
  const fresh = new Map([['0xb|t0', { below: false, alertedAt: null }]]);
  assert.deepEqual(T.boardAlerts([below({ priceSource: 'gamma' })], fresh, { now: NOW }).alerts, [], 'a Gamma price can be weeks old: no alert on it');
  assert.deepEqual(T.boardAlerts([below({ wallets: 1, A: 0, B: 1 })], fresh, { now: NOW }).alerts, [], 'one B sharp is not enough');
  assert.equal(T.boardAlerts([below({ wallets: 1, A: 1, B: 0 })], fresh, { now: NOW }).alerts.length, 1, 'one A is');
});

test('traders() filters by grade and category; scores persist in a store', async () => {
  const w = world();
  w.closed[W(1)] = [...politicsElite(W(1)), ...sportsBad(W(1))];   // A in politics only
  // Gamma has the games' start times, so their closing lines are measured too
  for (const r of w.closed[W(1)].filter(x => /Lakers/.test(x.title))) w.markets[r.condition_id] = { conditionId: r.condition_id, question: r.title, gameStartTime: r.end_date };
  w.closed[W(2)] = politicsElite(W(2));                            // A overall
  w.closed[W(3)] = sportsBad(W(3));                                // nothing
  const store = createMemoryStore();
  const eng = T.createTailEngine({ http: w.http, store, now: () => NOW, log: {} });
  for (const i of [1, 2, 3]) eng.addCandidate(W(i));
  await eng.scoreBatch(3);
  assert.deepEqual(eng.traders({ grade: 'A' }).map(t => t.wallet), [W(2)]);
  assert.deepEqual(eng.traders({ category: 'politics', grade: 'A' }).map(t => t.wallet).sort(), [W(1), W(2)]);
  assert.deepEqual(eng.traders({ category: 'sports' }).map(t => t.wallet).sort(), [W(1), W(3)]);
  assert.equal(eng.traders({ category: 'sports', grade: 'graded' }).length, 0);
  assert.deepEqual(eng.traders().map(t => t.wallet), [W(2), W(1), W(3)], 'A first, then by edge');
  assert.equal(eng.trader(W(3)).grade, null);
  assert.ok(eng.trader(W(3)).reasons.length > 0, 'with the reasons why not');
  assert.equal(eng.trader('0xnobody'), null);
  assert.equal(eng.state().graded.anyCategory, 2);
  assert.equal(eng.settings().grades.A.minZ, 3);

  const reborn = T.createTailEngine({ http: w.http, store, now: () => NOW + 60e3, log: {} });
  await reborn.ready();
  assert.equal(reborn.trader(W(2)).grade, 'A', 'loaded without refetching');
  w.http.calls.length = 0;
  assert.equal((await reborn.scoreBatch()).scored, 0, 'loaded scores are fresh');
  assert.equal(w.http.calls.length, 0);

  // a score from before the stake fix (round 1 or 2): not graded until it's rescored, and due now
  const old = { ...(await store.all()).find(d => d.wallet === W(2)) };
  delete old.rulesVersion;
  old.categories = { politics: { ...old.categories.politics, grade: 'A' } };
  const oldStore = createMemoryStore();
  await oldStore.init();
  await oldStore.put(old);
  await oldStore.put({ ...old, wallet: W(4), id: W(4), rulesVersion: 2 });
  await oldStore.put({ ...old, wallet: W(5), id: W(5), rulesVersion: 3 });
  const later = T.createTailEngine({ http: w.http, store: oldStore, now: () => NOW + 60e3, log: {} });
  await later.ready();
  for (const wallet of [W(2), W(4), W(5)]) {
    const hidden = later.trader(wallet);
    assert.deepEqual([hidden.grade, hidden.tailable, hidden.categories.politics.grade, hidden.staleRules], [null, false, null, true]);
    assert.match(hidden.reasons[0], wallet === W(5) ? /round trips/ : /stake fix/);
  }
  assert.equal(later.traders({ grade: 'graded' }).length, 0, 'none listed as graded');
  assert.equal((await later.scoreBatch()).scored >= 1, true, 'rescored straight away');
  assert.equal(later.trader(W(2)).grade, 'A', 'and graded by the current rules');
  assert.equal(later.trader(W(2)).rulesVersion, T.RULES_VERSION);

  // a score from after the stake fix but other rules: A capped at B until the rescore
  const cap = T.capStale({ ...later.trader(W(2)), rulesVersion: T.RULES_VERSION + 0.5 });
  assert.deepEqual([cap.grade, cap.tailable], ['B', true]);
  assert.match(cap.whyNotA[0], /older rules/);
});

test('engine: closing lines only for wallets that pass B without them; one price-history call a token, shared and cached; Gamma looked up once', async () => {
  const w = world();
  w.closed[W(1)] = politicsElite(W(1));
  w.closed[W(2)] = w.closed[W(1)].map(r => ({ ...r, proxy_wallet: W(2) }));   // the same bets as W1 (a copy-trader)
  w.closed[W(3)] = sportsBad(W(3));                                           // hopeless
  const store = createMemoryStore();
  let t = NOW;
  const eng = T.createTailEngine({ http: w.http, store, now: () => t, log: {} });
  for (const i of [1, 2, 3]) eng.addCandidate(W(i));

  await eng.scoreBatch(1);
  const calls = historyCalls(w.http);
  assert.equal(calls.length, 25, 'TAIL_CLV_SAMPLE: the 25 most recent settled bets');
  assert.equal(new Set(calls.map(c => c.params.token_id)).size, 25);
  const newest = T.clvCandidates(T.resolvedPositions(w.closed[W(1)], [], NOW).resolved, 25);
  assert.deepEqual(calls.map(c => c.params.token_id).sort(), newest.map(p => p.asset).sort());
  // a politics market with no Gamma record closes at its end date: 5-minute buckets up to it
  const first = calls[0].params, pos = newest.find(p => p.asset === first.token_id);
  assert.deepEqual(Object.keys(first).sort(), ['bucket_seconds', 'end', 'limit', 'start', 'token_id']);
  assert.deepEqual([first.bucket_seconds, first.limit, first.end, first.end - first.start], [300, 1000, Math.ceil(pos.endAt / 1000), 300000]);
  assert.equal(w.http.calls.filter(c => c.url.endsWith('/markets')).length, 25, 'one Gamma lookup a market (game start, close time)');
  const a = eng.trader(W(1));
  assert.deepEqual([a.grade, a.clvN, a.clv, a.clvHitRate], ['A', 25, 0.06, 1], 'closes at 53¢ on 50¢ bets: +6%');
  assert.equal(a.clvSamples.length, 25);

  await eng.scoreBatch(2);
  assert.equal(historyCalls(w.http).length, 25, 'W2\'s tokens are W1\'s (cached), and W3 is not worth a request');
  assert.equal(w.http.calls.filter(c => c.url.endsWith('/markets')).length, 25);
  assert.deepEqual([eng.trader(W(2)).grade, eng.trader(W(2)).clvN], ['A', 25]);
  assert.deepEqual([eng.trader(W(3)).grade, eng.trader(W(3)).clvN], [null, 0]);
  assert.equal(eng.state().clvCached, 25);

  // rescoring later costs nothing more
  t += 12 * 3600e3;
  assert.equal((await eng.scoreBatch(3)).scored, 3);
  assert.equal(historyCalls(w.http).length, 25);

  // a restart starts from the stored closes, not from scratch
  const reborn = T.createTailEngine({ http: w.http, store, now: () => t + 13 * 3600e3, log: {} });
  await reborn.ready();
  assert.equal(reborn.state().clvCached, 25);
  await reborn.scoreBatch(3);
  assert.equal(historyCalls(w.http).length, 25);
  assert.equal(reborn.trader(W(1)).grade, 'A');

  // a failed price read leaves that bet out, isn't remembered, and is tried again next time
  w.closed[W(4)] = politicsElite(W(4));
  const flaky = w.closed[W(4)][0].token_id;   // its most recent bet
  w.history[flaky] = new Error('502');
  eng.addCandidate(W(4));
  t += 60e3;
  await eng.scoreBatch(1);
  assert.equal(eng.trader(W(4)).clvN, 24);
  assert.match(eng.state().errors.at(-1).message, /^clv 0x…: 1 of 25 lookups failed \(502\)$/);
  delete w.history[flaky];
  t += 12 * 3600e3;
  const before = historyCalls(w.http).length;
  await eng.scoreBatch(4);
  assert.deepEqual(historyCalls(w.http).slice(before).map(c => c.params.token_id), [flaky], 'only the one that failed');
  assert.equal(eng.trader(W(4)).clvN, 25);
});

test('engine: a game\'s closing line is its last price before the start Gamma gives, not an in-play one', async () => {
  const w = world();
  // 120 NBA bets at 50¢, 80 won; Gamma knows every game's tip-off
  const rows = Array.from({ length: 120 }, (_, i) => closed({
    wallet: W(40), won: i % 3 !== 0, title: `Lakers vs. Celtics (game ${i})`, eventSlug: `nba-g-${i}`, at: NOW - (i % 100) * DAY - 3 * 3600e3,
  }));
  w.closed[W(40)] = rows;
  for (const r of rows) w.markets[r.condition_id] = { conditionId: r.condition_id, question: r.title, gameStartTime: new Date(Date.parse(r.end_date) - 3 * 3600e3).toISOString() };
  // 48¢ before tip-off, 90¢ once the game is on
  w.closeFor = null;
  for (const r of rows) {
    const tip = Date.parse(r.end_date) - 3 * 3600e3;
    w.history[r.token_id] = p => ({ data: [{ t: p.start, p: 0.45 }, { t: Math.floor(tip / 1000) - 600, p: 0.48 }, { t: Math.floor(tip / 1000) + 600, p: 0.9 }] });
  }
  const eng = T.createTailEngine({ http: w.http, now: () => NOW, log: {} });
  eng.addCandidate(W(40));
  await eng.scoreBatch(1);
  const tr = eng.trader(W(40));
  assert.equal(tr.clvN, 25);
  near(tr.clv, -0.04, 1e-9, 'bought at 50¢, closed at 48¢');
  assert.ok(tr.clvSamples.every(x => x.rule === 'game' && x.close === 0.48));
  assert.equal(tr.grade, null, 'it keeps paying more than the close: not tailable, whatever its profit');
  assert.deepEqual(tr.failed, ['clv']);
  const call = historyCalls(w.http)[0].params;
  const row = rows.find(r => r.token_id === call.token_id);
  assert.equal(call.end, Math.ceil((Date.parse(row.end_date) - 3 * 3600e3) / 1000), 'the window ends at tip-off');
});

test('engine: a live bettor (most sampled game bets bought after tip-off) is not graded, however good its record', async () => {
  const w = world();
  // 120 NBA bets at 50¢, 80 won, every one first bought 10 minutes after tip-off
  const rows = Array.from({ length: 120 }, (_, i) => {
    const r = closed({ wallet: W(41), won: i % 3 !== 0, title: `Lakers vs. Celtics (game ${i})`, eventSlug: `nba-l-${i}`, at: NOW - (i % 100) * DAY - 3 * 3600e3 });
    const tip = Date.parse(r.end_date) - 3 * 3600e3;
    return { ...r, first_entry_at: new Date(tip + 10 * 60e3).toISOString() };
  });
  w.closed[W(41)] = rows;
  for (const r of rows) w.markets[r.condition_id] = { conditionId: r.condition_id, question: r.title, gameStartTime: new Date(Date.parse(r.end_date) - 3 * 3600e3).toISOString() };
  const eng = T.createTailEngine({ http: w.http, now: () => NOW, log: {} });
  eng.addCandidate(W(41));
  await eng.scoreBatch(1);
  const tr = eng.trader(W(41));
  assert.deepEqual([tr.inPlayGames, tr.inPlayShare, tr.clvN], [25, 1, 0], 'no closing line for a live bet');
  assert.equal(tr.grade, null);
  assert.deepEqual(tr.failed, ['inPlay']);
  assert.match(tr.reasons[0], /live bettor: 100% of 25 sampled game bets came after the start/);
  assert.equal(tr.categories.sports.grade, null);

  // the same record bought before tip-off, beating a 53¢ close: A
  const pre = rows.map(r => ({ ...r, proxy_wallet: W(42), first_entry_at: new Date(Date.parse(r.end_date) - 2 * DAY).toISOString() }));
  w.closed[W(42)] = pre;
  eng.addCandidate(W(42));
  await eng.scoreBatch(1);
  const ok = eng.trader(W(42));
  assert.deepEqual([ok.grade, ok.inPlayShare, ok.clvN], ['A', 0, 25]);
});

test('scoreWallet: the in-play share only judges sports, and needs 8 sampled games', () => {
  const both = [...politicsElite(W(43)), ...Array.from({ length: 120 }, (_, i) => closed({
    wallet: W(43), won: i % 3 !== 0, title: `Lakers vs. Celtics (game ${i})`, eventSlug: `nba-x-${i}`, at: NOW - (i % 100) * DAY - 3 * 3600e3,
  }))];
  const live = T.scoreWallet({ wallet: W(43), closed: both, play: { games: 10, inPlay: 8 } }, { now: NOW });
  assert.equal(live.grade, null, 'overall: its record is mostly live sports');
  assert.equal(live.categories.sports.grade, null);
  assert.deepEqual(live.categories.sports.failed, ['inPlay']);
  assert.equal(live.categories.politics.grade, 'B', 'its politics bets still grade');
  assert.equal(T.gradeFor(live, 'politics').grade, 'B');
  assert.equal(T.gradeFor(live, 'sports').grade, null);
  const few = T.scoreWallet({ wallet: W(43), closed: both, play: { games: 7, inPlay: 7 } }, { now: NOW });
  assert.deepEqual([few.inPlayShare, few.grade], [null, 'B'], '7 games: too few to judge');
  const half = T.scoreWallet({ wallet: W(43), closed: both, play: { games: 10, inPlay: 5 } }, { now: NOW });
  assert.deepEqual([half.inPlayShare, half.grade], [0.5, 'B'], 'half is allowed');
  const env = T.optionsFromEnv({ TAIL_MAX_IN_PLAY: '80' });
  assert.equal(env.maxInPlay, 0.8);
  assert.equal(T.scoreWallet({ wallet: W(43), closed: both, play: { games: 10, inPlay: 8 } }, { now: NOW, ...env }).grade, 'B', 'TAIL_MAX_IN_PLAY=80');
});

// A split/merge round trip as v2 lists it (a live row, 2026-10-09): 650
// shares "bought" at 1¢ and out at 99¢ weeks before the game was played.
const trip = (wallet, i, { endDays = 14, outAt = NOW - (i % 40) * DAY - 3600e3 } = {}) => ({
  proxy_wallet: wallet, token_id: `trip${i}-t0`, condition_id: `0xtrip${i}`, avg_price: 0.0101, total_size: 650, current_size: 0,
  entry_cost_usdc: 0, entry_fees_usdc: 0, total_cost_usdc: 0, realized_pnl: 636.935, unrealized_pnl: 0, total_pnl: 636.935, current_price: 0.5,
  status: 'CLOSED', title: `2H Spread: Cardinals (-7.5) week ${i}`, slug: `nfl-den-ari-${i}-2h-spread`, event_slug: `nfl-den-ari-${i}`,
  outcome: 'Cardinals', outcome_index: 0, end_date: new Date(outAt + endDays * DAY).toISOString().slice(0, 10),
  first_entry_at: Math.floor((outAt - 600e3) / 1000), last_event_at: Math.floor(outAt / 1000),
});

test('round trips: bought for a few cents and out near $1 a day before the market ends is not a bet', () => {
  const o = T.resolveOptions();
  const [row] = T.parseClosedPositions([trip(W(60), 1)], { now: NOW });
  assert.equal(row.exit, 0.99, '(pnl + stake) ÷ shares');
  assert.equal(T.isRoundTrip(row, o), true);
  const not = x => assert.equal(T.isRoundTrip(T.parseClosedPositions([x], { now: NOW })[0], o), false);
  not(trip(W(60), 2, { endDays: 0.5 }));                                        // out on game day: could be a live win
  not({ ...trip(W(60), 3), status: 'REDEEMABLE' });                             // paid out at settlement
  not({ ...trip(W(60), 4), avg_price: 0.3, realized_pnl: 448.5, total_pnl: 448.5 });   // 30¢ sold at 99¢: a trade
  not({ ...trip(W(60), 5), realized_pnl: 300, total_pnl: 300 });                // 1¢ out at 47¢
  const env = T.optionsFromEnv({ TAIL_MAX_ROUND_TRIPS: '25', TAIL_ROUND_TRIP_ENTRY: '3' });
  assert.deepEqual([env.maxRoundTrips, env.roundTripEntry], [0.25, 0.03]);
});

test('scoreWallet: round trips are left out of the record, and a wallet full of them is a market maker', () => {
  // 60 real NBA bets at 50¢, 20 won (ROI −33%), plus 60 round trips worth +$637 each on a $6.57 stake
  const real = sportsBad(W(61));
  const rows = [...real, ...Array.from({ length: 60 }, (_, i) => trip(W(61), i))];
  const before = T.scoreWallet({ wallet: W(61), closed: rows }, { now: NOW, roundTripEntry: 0 });
  assert.equal(before.roi > 0.25, true, 'counted as bets, they turn a losing record into a sharp one');
  const s = T.scoreWallet({ wallet: W(61), closed: rows }, { now: NOW });
  assert.deepEqual([s.n, s.roundTrips, s.roundTripShare, s.roi], [60, 60, 0.5, -0.3333]);
  assert.deepEqual([s.grade, s.tailable, s.marketMaker], [null, false, true]);
  assert.equal(s.failed.includes('roundTrips'), true);
  assert.match(s.reasons.find(r => /round trips/.test(r)), /^market maker: 60 settled positions \(50%\) were split\/merge round trips/);
  assert.equal(s.categories.sports.failed.includes('roundTrips'), true, 'out in every category');

  // a few among many real bets: left out, no flag
  const elite = politicsElite(W(62));
  const few = T.scoreWallet({ wallet: W(62), closed: [...elite, ...Array.from({ length: 4 }, (_, i) => trip(W(62), i))], clv: clvs() }, { now: NOW });
  const clean = T.scoreWallet({ wallet: W(62), closed: elite, clv: clvs() }, { now: NOW });
  assert.deepEqual([few.n, few.roundTrips, few.marketMaker, few.failed.includes('roundTrips')], [120, 4, false, false]);
  assert.deepEqual([few.grade, few.roi, few.z], [clean.grade, clean.roi, clean.z], 'graded on its real bets alone');
});

// ── review fixes ──
test('open positions count at today\'s price: selling the winners and holding the losers is not an edge', () => {
  // 260 winners sold at 60¢ (+$200 each on $1k at 50¢) are closed; 260 losers still open at 30¢ (−$400 each)
  const wins = Array.from({ length: 260 }, (_, i) => ({
    ...closed({ wallet: W(20), p: 0.5, stake: 1000, won: true, eventSlug: `race-${i}`, at: NOW - (i % 25) * DAY - 3600e3 }),
    realized_pnl: 400, total_pnl: 400, current_price: 0.6,
  }));
  // v2 open rows (status OPEN)
  const open = Array.from({ length: 260 }, (_, i) => ({
    proxy_wallet: W(20), condition_id: `0xopen${i}`, token_id: `open-${i}`, outcome_index: 0, outcome: 'Yes', current_size: '2000', avg_price: '0.5',
    total_size: 2000, total_cost_usdc: '1000', current_value: 600, unrealized_pnl: -400, realized_pnl: 0, total_pnl: '-400', current_price: 0.3,
    status: 'OPEN', redeemable: false, title: `Will candidate ${i} win in 2028?`, event_slug: `race-2028-${i}`, end_date: '2028-11-07T00:00:00Z',
  }));
  const closedOnly = T.scoreWallet({ wallet: W(20), closed: wins, clv: clvs() }, { now: NOW });
  assert.equal(closedOnly.grade, 'A', 'on the closed book alone it looks elite');
  const s = T.scoreWallet({ wallet: W(20), closed: wins, open, clv: clvs() }, { now: NOW });
  assert.equal(s.openN, 260);
  assert.equal(s.openPnl, -104000);
  assert.equal(s.openRisked, 260000);
  assert.equal(s.roi, 0, '+$104k realized, −$104k unrealized');
  assert.equal(s.resolvedRoi, 0.4);
  assert.equal(s.edge, 0);
  assert.equal(s.grade, null);
  assert.ok(s.failed.includes('roi'));
  assert.equal(s.z, closedOnly.z, 'the luck test stays on resolved bets');
  const m = T.markOpen(T.parseOpenPositions([{ conditionId: 'c', avgPrice: 0.4, size: 100, curPrice: 0.5 }])[0]);
  assert.equal(m.risked, 40);
  near(m.pnl, 10, 1e-9, 'no cash P&L given: size × (now − entry)');
});

test('one thesis spread over many markets is one bet: same-day markets in a category share the concentration cap', () => {
  // "Republicans win": 120 state markets in 40 event slugs, all election night, all won at 55¢
  const night = Date.parse('2026-11-04T05:00:00Z');
  const rows = Array.from({ length: 120 }, (_, i) => closed({
    wallet: W(21), p: 0.55, stake: 550, won: true, title: `Will the Republican win the ${STATES[i % 4]} Senate race (seat ${i})?`,
    eventSlug: `senate-2026-${i % 40}`, at: night,
  }));
  const s = T.scoreWallet({ wallet: W(21), closed: rows }, { now: night + 2 * DAY });
  assert.equal(s.events, 40);
  assert.ok(s.z < 6, `events, not markets, are the independent bets: z ${s.z} (was 9.9 counting markets)`);
  assert.equal(s.concentration, 1);
  assert.equal(s.concentrationBy, 'day');
  assert.equal(s.grade, null);
  assert.ok(s.reasons.includes("100% of profit from one day's markets (max 40%)"), JSON.stringify(s.reasons));
});

test('forward record: once 30 bets resolve after the wallet was picked, losing money there ungrades it', () => {
  const picked = NOW - 20 * DAY;
  const old = Array.from({ length: 120 }, (_, i) => closed({ wallet: W(22), won: i % 3 !== 0, eventSlug: `old-${i}`, at: picked - (i % 90) * DAY - 3600e3 }));
  const after = n => Array.from({ length: n }, (_, i) => closed({ wallet: W(22), p: 0.5, stake: 300, won: i % 3 === 0, eventSlug: `new-${i}`, at: picked + (i % 19) * DAY + 3600e3 }));
  const few = T.scoreWallet({ wallet: W(22), closed: [...old, ...after(29)], selectedAt: new Date(picked).toISOString(), clv: clvs() }, { now: NOW });
  assert.equal(few.forwardN, 29);
  assert.ok(few.forwardRoi < 0);
  assert.equal(few.grade, 'A', 'too few forward bets to judge');
  const s = T.scoreWallet({ wallet: W(22), closed: [...old, ...after(30)], selectedAt: picked, clv: clvs() }, { now: NOW });
  assert.equal(s.forwardN, 30);
  assert.equal(s.grade, null);
  assert.deepEqual(s.failed, ['forward']);
  assert.deepEqual(s.reasons, [`lost money since it was picked: ROI ${Math.round(s.forwardRoi * 1000) / 10}% over 30 bets`]);
  assert.equal(s.selectedAt, new Date(picked).toISOString());
  assert.equal(T.scoreWallet({ wallet: W(22), closed: [...old, ...after(30)] }, { now: NOW }).forwardN, null, 'no pick date: no forward record');
});

test('an ungraded category with a real sample and no edge of its own is not tailed on the overall grade', () => {
  const pol = politicsElite(W(23));
  // 80 sports bets at 50¢, ROI +2.5%
  const sports = Array.from({ length: 80 }, (_, i) => closed({ wallet: W(23), won: i < 41, title: `Lakers vs. Celtics (game ${i})`, eventSlug: `nba-g-${i}`, at: NOW - (i % 50) * DAY - 7200e3 }));
  const s = T.scoreWallet({ wallet: W(23), closed: [...pol, ...sports] }, { now: NOW });
  assert.equal(s.grade, 'B');
  assert.equal(s.categories.sports.grade, null);
  assert.equal(s.categories.sports.roi, 0.025);
  assert.deepEqual(T.gradeFor(s, 'sports'), { grade: null, skip: 'no edge in sports (ROI 2.5% over 80 bets)' });
  const lakers = T.tradeSignal({ trade: trade({ proxyWallet: W(23), title: 'Lakers vs. Celtics', eventSlug: 'nba-lal-bos-2026-10-08', size: 5000 }), trader: s, market: market(), now: NOW });
  assert.deepEqual(lakers, { signal: null, skip: 'no edge in sports (ROI 2.5% over 80 bets)' });
  // a small sample: tailed on the overall grade, its edge pulled toward what that sample shows
  const thin = { wallet: W(2), grade: 'A', edge: 0.1, categories: { crypto: { grade: null, n: 8, pnl: -2000, risked: 8000, roi: -0.25 } } };
  const c = T.gradeFor(thin, 'crypto');
  assert.equal(c.scope, 'overall');
  near(c.edge, ((-2000 + 20000 * 0.2) / (8000 + 20000)) * 0.5, 1e-12);
  assert.ok(c.edge < 0.1);
  assert.equal(T.gradeFor({ ...thin, categories: { crypto: { n: 8, pnl: 5000, risked: 8000, roi: 0.6 } } }, 'crypto').edge, 0.1, 'never above the overall edge');
  assert.equal(T.gradeFor({ ...thin, categories: { crypto: { n: 8, pnl: -8000, risked: 8000, roi: -1 } } }, 'crypto').grade, null, 'pulled to no edge: skipped');
});

test('a market that resolved early is not recent activity; activity is the wallet\'s own trades and closes', () => {
  const stale = Array.from({ length: 120 }, (_, i) => closed({ wallet: W(24), won: i % 3 !== 0, eventSlug: `r-${i}`, at: NOW - 200 * DAY - i * 3600e3 }));
  const early = { proxyWallet: W(24), conditionId: '0xearly', asset: 'early', outcomeIndex: 0, size: 2000, avgPrice: 0.5, totalBought: 2000, cashPnl: 1000, realizedPnl: 0,
    curPrice: 1, redeemable: true, title: 'Will it happen by Dec 31?', eventSlug: 'by-dec-31', endDate: '2026-12-31T00:00:00Z' };
  const s = T.scoreWallet({ wallet: W(24), closed: stale, open: [early] }, { now: NOW });
  assert.equal(s.n, 121, 'the redeemable winner counts as resolved');
  assert.equal(s.lastAt, new Date(NOW - 200 * DAY).toISOString(), 'not 2026-12-31');
  assert.equal(s.recentN, 0, 'and not recent form');
  assert.ok(s.failed.includes('active'));
  assert.equal(T.resolvedFromOpen(T.parseOpenPositions([early]), NOW)[0].at, null);
  assert.equal(T.resolvedFromOpen(T.parseOpenPositions([early]), Date.parse('2027-01-02'))[0].at, Date.parse('2026-12-31T00:00:00Z'));
});

test('env units: percent keys read 1 as 1%, the chase limit 1 as 1¢, factors 1 as 1.0', () => {
  assert.deepEqual(T.optionsFromEnv({ TAIL_CHASE_MAX: '1', TAIL_B_MIN_ROI: '1', TAIL_A_MIN_RECENT_ROI: '-1', TAIL_REGRESSION: '1', TAIL_KELLY_FRACTION: '25', TAIL_A_MAX_CONCENTRATION: '0.5' }),
    { grades: { A: { minRecentRoi: -0.01, maxConcentration: 0.5 }, B: { minRoi: 0.01 } }, chaseMax: 0.01, regression: 1, kellyFraction: 0.25 });
  assert.equal(T.optionsFromEnv({ TAIL_CHASE_MAX: '0.03' }).chaseMax, 0.03);
});

test('a 200 that is not a list is a failed fetch: the last good score stays', async () => {
  const bad = { async get() { return { data: { error: 'rate limited' } }; } };
  await assert.rejects(T.fetchClosedPositions(bad, W(1)), /closed positions: unexpected response/);
  await assert.rejects(T.fetchOpenPositions({ async get() { return { data: '<html>' }; } }, W(1)), /positions: unexpected response \(string\)/);
  await assert.rejects(T.fetchMarket(bad, '0xm'), /markets: unexpected response/);
  const lb = await T.fetchLeaderboard(bad, { categories: ['OVERALL'], periods: ['ALL'] });
  assert.equal(lb.errors.length, 1);

  const w = world();
  w.closed[W(1)] = politicsElite(W(1));
  let t = NOW;
  const eng = T.createTailEngine({ http: w.http, now: () => t, log: {} });
  eng.addCandidate(W(1), { sources: ['OVERALL:ALL'] });
  await eng.scoreBatch(1);
  assert.equal(eng.trader(W(1)).grade, 'A');
  // twelve hours on, the history comes back nearly empty: a bad read, not a new record
  t += 12 * 3600e3;
  w.closed[W(1)] = politicsElite(W(1)).slice(0, 10);
  assert.equal((await eng.scoreBatch(1)).scored, 0);
  assert.equal(eng.trader(W(1)).grade, 'A');
  assert.match(eng.state().errors.at(-1).message, /only 10 resolved bets came back \(had 120\)/);
});

test('scaling into one position over several orders tops the tail up; it is not four full bets', async () => {
  const w = world();
  w.closed[W(1)] = politicsElite(W(1));
  w.markets['0xm1'] = gammaMarket({ bestAsk: '0.41', bestBid: '0.40' });
  let t = NOW;
  const eng = T.createTailEngine({ http: w.http, now: () => t, opts: { watchPerPoll: 0, priorRisk: 200000 }, log: {} });
  eng.addCandidate(W(1));
  await eng.scoreBatch(1);
  const out = [];
  for (const [i, price] of [0.4, 0.402, 0.404, 0.406].entries()) {
    t += 60e3;
    w.trades = [rawTrade(W(1), { price, size: 3000, transactionHash: `0xscale${i}`, timestamp: Math.floor((t - 10e3) / 1000) })];
    out.push(...await eng.pollTrades());
  }
  assert.equal(out.length, 4);
  assert.equal(out[0].topUp, false);
  assert.equal(out[0].parentId, null);
  assert.ok(out.slice(1).every(s => s.topUp && s.parentId === out[0].id));
  // each one sizes the position at the latest Kelly target; together they stake that target, not the sum
  for (let i = 1; i < 4; i++) assert.equal(out[i].units, round2(Math.max(0, out[i].target - Math.max(...out.slice(0, i).map(s => s.target)))));
  const staked = out.reduce((a, s) => a + s.units, 0);
  assert.ok(Math.abs(staked - Math.max(...out.map(s => s.target))) < 0.02, `${staked} staked for a ${Math.max(...out.map(s => s.target))}u position`);
  // selling out ends it: the next buy is a fresh tail
  t += 60e3;
  w.trades = [rawTrade(W(1), { side: 'SELL', price: 0.45, size: 12000, transactionHash: '0xout', timestamp: Math.floor((t - 5e3) / 1000) })];
  await eng.pollTrades();
  t += 60e3;
  w.trades = [rawTrade(W(1), { price: 0.4, size: 3000, transactionHash: '0xback', timestamp: Math.floor((t - 5e3) / 1000) })];
  assert.equal((await eng.pollTrades())[0].topUp, false);

  // routed: a top-up counts what the venue was told, even when Polymarket's own size was 0u
  const told = [];
  const route = s => { told.push(s); return s.topUp ? 0.5 : 1.75; };
  const sellOut = async tag => {
    t += 60e3;
    w.trades = [rawTrade(W(1), { side: 'SELL', price: 0.45, size: 12000, transactionHash: `0xout-${tag}`, timestamp: Math.floor((t - 5e3) / 1000) })];
    await eng.pollTrades({ route });
  };
  await sellOut('v');
  t += 60e3;
  w.trades = [rawTrade(W(1), { price: 0.4, size: 3000, transactionHash: '0xv1', timestamp: Math.floor((t - 5e3) / 1000) })];
  const [v1] = await eng.pollTrades({ route });
  assert.deepEqual([v1.topUp, v1.priorUnits], [false, 0]);
  t += 60e3;
  w.trades = [
    rawTrade(W(1), { price: 0.4, size: 3000, transactionHash: '0xv2', timestamp: Math.floor((t - 8e3) / 1000) }),
    rawTrade(W(1), { price: 0.4, size: 3000, transactionHash: '0xv3', timestamp: Math.floor((t - 5e3) / 1000) }),
  ];
  const [v2, v3] = await eng.pollTrades({ route });
  assert.deepEqual([v2.topUp, v2.parentId, v2.priorUnits], [true, v1.id, 1.75], 'the venue\'s 1.75u, not Polymarket\'s target');
  assert.deepEqual([v3.parentId, v3.priorUnits], [v1.id, 2.25], 'routed in the same poll: it sees the first top-up');
  assert.equal(told.length, 3);
  // a venue that was told nothing, with nothing before: the next buy is fresh
  await sellOut('w');
  t += 60e3;
  w.trades = [rawTrade(W(1), { price: 0.4, size: 3000, transactionHash: '0xw1', timestamp: Math.floor((t - 5e3) / 1000) })];
  await eng.pollTrades({ route: () => 0 });
  t += 60e3;
  w.trades = [rawTrade(W(1), { price: 0.4, size: 3000, transactionHash: '0xw2', timestamp: Math.floor((t - 5e3) / 1000) })];
  assert.equal((await eng.pollTrades({ route: () => 0 }))[0].topUp, false);
});

test('scoreBatch keeps scoring until its time box runs out, then leaves the rest for the next run', async () => {
  const w = world();
  const ids = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  for (const i of ids) w.closed[W(i)] = sportsBad(W(i));
  let t = NOW;
  const slow = { calls: w.http.calls, get: async (url, cfg) => { t += 4e3; return w.http.get(url, cfg); } };   // 4s a request
  const eng = T.createTailEngine({ http: slow, now: () => t, log: {} });
  for (const i of ids) eng.addCandidate(W(i));
  const r = await eng.scoreBatch();
  assert.equal(r.scored, 4, 'four at once, then the time box stops new ones');
  assert.deepEqual(r.wallets, ids.slice(0, 4).map(W), 'reported in queue order');
  assert.equal(r.pending, ids.length - 4);
  t += 60e3;
  assert.equal((await eng.scoreBatch()).scored, 4);
  // one at a time when asked
  const one = T.createTailEngine({ http: slow, now: () => t, opts: { scoreConcurrency: 1 }, log: {} });
  for (const i of ids) one.addCandidate(W(i));
  assert.equal((await one.scoreBatch()).scored, 3, '20-second wallets start until 40 seconds have passed');
});

test('memory: untailable scores shrink to a summary and only leaderboard ones are stored; the oldest are evicted past the cap', async () => {
  const w = world();
  w.closed[W(1)] = politicsElite(W(1));
  for (const i of [2, 3, 4, 5]) w.closed[W(i)] = sportsBad(W(i));
  const store = createMemoryStore();
  let t = NOW;
  const eng = T.createTailEngine({ http: w.http, store, now: () => t, opts: { maxTraders: 3 }, log: {} });
  eng.addCandidate(W(1), { sources: ['OVERALL:ALL'] });
  eng.addCandidate(W(2), { sources: ['SPORTS:WEEK'] });
  for (const i of [3, 4, 5]) eng.addCandidate(W(i), { sources: ['trade'], fromTrade: true });
  for (let i = 0; i < 5; i++) { t += 1000; await eng.scoreBatch(1); }
  assert.equal(eng.trader(W(1)).compact, undefined, 'graded: the full score');
  assert.equal(eng.trader(W(1)).grade, 'A');
  const stored = await store.all();
  assert.deepEqual(stored.map(x => x.wallet).sort(), [W(1), W(2)], 'trade-sourced also-rans are not written');
  assert.equal(stored.find(x => x.wallet === W(2)).compact, true);
  assert.ok(eng.state().scored <= 3, 'capped');
  assert.equal(eng.trader(W(3)), null, 'the oldest summary went first');
  assert.equal(eng.state().candidates, 4, 'and left the queue');
  assert.ok(eng.traders().every(x => x.reasons), 'summaries still list their reasons');
});

// 60 bets at 50¢ on 60 races, 32 won: ROI 6.7% but z 0.5 (could be luck)
const modest = (wallet = W(1)) => Array.from({ length: 60 }, (_, i) => closed({
  wallet, won: i < 32, title: `Will candidate ${i} win the ${STATES[i % 4]} Senate election?`, eventSlug: `race-m-${i}`, at: NOW - (i % 40) * DAY - 3600e3,
}));

test('the closing line\'s way to B: in profit, failing only luck or ROI, and beating the close by 3%+ on 55%+ of 15+ bets', () => {
  const none = T.scoreWallet({ wallet: W(50), closed: modest(W(50)) }, { now: NOW });
  assert.deepEqual([none.grade, none.failed], [null, ['z']], 'no closing lines measured: not graded');
  const good = T.scoreWallet({ wallet: W(50), closed: modest(W(50)), clv: clvs(25, 0.04) }, { now: NOW });
  assert.deepEqual([good.grade, good.via, good.label], ['B', 'clv', 'sharp']);
  assert.deepEqual([good.categories.politics.grade, good.categories.politics.via], ['B', 'clv']);
  // sized on the larger of the two shrunk edges: P&L 4,000 / (60,000 + 20,000) × 0.5 vs 4% × 25/50 × 0.5
  assert.equal(round4(good.edge), round4(Math.max((4000 / 80000) * 0.5, 0.04 * 0.5 * 0.5)));
  const clvOnly = T.scoreWallet({ wallet: W(50), closed: modest(W(50)), clv: clvs(25, 0.12) }, { now: NOW });
  assert.equal(round4(clvOnly.edge), round4(0.12 * 0.5 * 0.5), 'a big closing-line edge outweighs a small P&L one');
  assert.ok(T.tradeSignal({ trade: trade({ proxyWallet: W(50) }), trader: good, market: market(), now: NOW }).signal.units > 0, 'it tails');

  const weak = T.scoreWallet({ wallet: W(50), closed: modest(W(50)), clv: clvs(25, 0.02) }, { now: NOW });
  assert.equal(weak.grade, null, '+2% is not enough');
  const mixed = [...clvs(12, 0.08), ...clvs(13, -0.01).map((x, i) => ({ ...x, asset: `neg-${i}` }))];
  const coin = T.scoreWallet({ wallet: W(50), closed: modest(W(50)), clv: mixed }, { now: NOW });
  assert.ok(coin.clv >= 0.03 && coin.clvHitRate < 0.55 && coin.grade === null, 'a few big beats, mostly not: under the hit rate');
  const few = T.scoreWallet({ wallet: W(50), closed: modest(W(50)), clv: clvs(14, 0.1) }, { now: NOW });
  assert.equal(few.grade, null, '14 measured bets: too few');
  // losing money, or failing anything else (here: too few bets), the closing lines can't save it
  const losing = modest(W(51)).map((r, i) => (i < 32 && i >= 25 ? closed({ wallet: W(51), won: false, eventSlug: `race-l-${i}`, title: r.title, at: NOW - DAY }) : r));
  assert.equal(T.scoreWallet({ wallet: W(51), closed: losing, clv: clvs(25, 0.1) }, { now: NOW }).grade, null);
  assert.equal(T.scoreWallet({ wallet: W(50), closed: modest(W(50)).slice(0, 40), clv: clvs(25, 0.1) }, { now: NOW }).grade, null);
  // switched off, or a stricter bar from the environment
  assert.equal(T.scoreWallet({ wallet: W(50), closed: modest(W(50)), clv: clvs(25, 0.04) }, { now: NOW, clvPath: 0 }).grade, null);
  const env = T.optionsFromEnv({ TAIL_CLV_PATH_MIN: '5', TAIL_CLV_PATH_HIT_RATE: '60' });
  assert.deepEqual([env.clvPathMin, env.clvPathHitRate], [0.05, 0.6]);
  assert.equal(T.scoreWallet({ wallet: W(50), closed: modest(W(50)), clv: clvs(25, 0.04) }, { now: NOW, ...env }).grade, null);
});

test('engine: closing lines are measured for a wallet they could grade, not for a hopeless one', async () => {
  const w = world();
  w.closed[W(52)] = modest(W(52));
  w.closed[W(53)] = sportsBad(W(53));
  const eng = T.createTailEngine({ http: w.http, now: () => NOW, log: {} });
  eng.addCandidate(W(52));
  eng.addCandidate(W(53));
  await eng.scoreBatch(5);
  const tr = eng.trader(W(52));
  assert.deepEqual([tr.grade, tr.via, tr.clvN], ['B', 'clv', 25], 'bought at 50¢, closed at 53¢');
  const asked = new Set(historyCalls(w.http).map(c => c.params.token_id));
  const mine = new Set(w.closed[W(52)].map(r => r.token_id));
  assert.equal([...asked].filter(x => mine.has(x)).length, 25, 'its 25 most recent bets');
  assert.ok(!w.closed[W(53)].some(r => asked.has(r.token_id)), 'a losing record costs no closing-line calls');
  assert.equal(eng.trader(W(53)).grade, null);
  assert.equal(eng.traders({ grade: 'B' }).length, 1);
});
