const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../tail');
const { createMemoryStore } = require('../evtrack');

const NOW = Date.parse('2026-10-08T12:00:00Z');
const DAY = 86400e3;
const W = n => `0x${String(n).padStart(40, '0')}`;
const near = (a, b, eps = 1e-6, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg || ''} ${a} ≈ ${b}`);

// one resolved position, data-API closed-positions shape (numbers partly as strings)
let seq = 0;
function closed({ wallet = W(1), p = 0.5, stake = 1000, won, title = 'Will Smith win the Ohio Senate election?', eventSlug = 'ohio-senate', cond, idx = 0, at = NOW - DAY } = {}) {
  const shares = stake / p;
  cond = cond || `0xcond${++seq}`;
  return {
    proxyWallet: wallet, asset: `${cond}-t${idx}`, conditionId: cond, avgPrice: String(p), totalBought: shares,
    realizedPnl: won ? shares - stake : -stake, curPrice: won ? 1 : 0, title, slug: `${eventSlug}-m`, eventSlug,
    outcome: idx ? 'No' : 'Yes', outcomeIndex: idx, endDate: new Date(at).toISOString(), timestamp: Math.floor(at / 1000),
  };
}
const STATES = ['Ohio', 'Texas', 'Iowa', 'Maine'];
// 120 bets at 50¢ on 120 races, 80 won: ROI 33%, z 3.65, last bet an hour ago
const politicsElite = (wallet = W(1)) => Array.from({ length: 120 }, (_, i) => closed({
  wallet, won: i % 3 !== 0, title: `Will candidate ${i} win the ${STATES[i % 4]} Senate election?`,
  eventSlug: `senate-race-${i}`, at: NOW - (i % 100) * DAY - 3600e3,
}));
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

test('parsers are tolerant: wrapped arrays, numbers as strings, missing fields', () => {
  const rows = T.parseClosedPositions({ data: [
    { proxyWallet: '0xABC', asset: 7, conditionId: '0xc', avgPrice: '0.25', totalBought: '400', realizedPnl: '300', curPrice: '1', title: 'Bitcoin above 100k?', eventSlug: 'btc', timestamp: '1759924800' },
    { avgPrice: '0.6', totalBought: 100, curPrice: null, realizedPnl: -60, title: 'Lakers vs. Celtics', timestamp: 1759924800000 },
    { avgPrice: '0.5', totalBought: 100, curPrice: 0 },          // no realizedPnl: (cur − p) × shares
    { avgPrice: '0', totalBought: 100, realizedPnl: 5 },         // no price
    { avgPrice: '0.5', totalBought: 'n/a', realizedPnl: 5 },     // no shares
    { avgPrice: '0.5', totalBought: 10 },                        // nothing to score
  ] });
  assert.equal(rows.length, 3);
  assert.deepEqual({ ...rows[0], at: null }, {
    wallet: '0xabc', conditionId: '0xc', asset: '7', outcome: null, outcomeIndex: null, title: 'Bitcoin above 100k?', slug: '', eventSlug: 'btc',
    price: 0.25, risked: 100, pnl: 300, won: true, at: null, endAt: null, category: 'crypto', source: 'closed',
  });
  assert.equal(rows[0].at, 1759924800000, 'unix seconds');
  assert.equal(rows[1].at, 1759924800000, 'unix ms');
  assert.equal(rows[1].won, false, 'no curPrice: won = pnl > 0');
  assert.equal(rows[1].category, 'sports');
  assert.equal(rows[2].pnl, -50);
  assert.deepEqual(T.parseClosedPositions(null), []);
  assert.deepEqual(T.parseOpenPositions('garbage'), []);

  const lb = T.parseLeaderboard({ data: [{ rank: '1', wallet: '0xAA', amount: '1234.5', name: 'old' }, { proxyWallet: '0xbb', userName: 'new', pnl: 10, vol: '99', verifiedBadge: true }, { userName: 'no wallet' }] });
  assert.deepEqual(lb.map(r => [r.wallet, r.name, r.pnl, r.vol, r.rank, r.verified]), [['0xaa', 'old', 1234.5, null, 1, false], ['0xbb', 'new', 10, 99, null, true]]);
  assert.equal(T.parseLeaderboard([{ proxyWallet: '0xcc', pseudonym: 'Shy-Owl' }])[0].name, 'Shy-Owl');
});

test('trades: fills of one order merge, timestamps in s or ms, junk dropped, parse is idempotent', () => {
  const raw = [
    { proxyWallet: '0xA', side: 'buy', asset: 'tok', conditionId: '0xc', size: '1000', price: '0.40', timestamp: 1759924800, transactionHash: '0xt', pseudonym: 'Owl' },
    { proxyWallet: '0xA', side: 'BUY', asset: 'tok', conditionId: '0xc', size: 500, price: 0.43, timestamp: 1759924800, transactionHash: '0xt' },
    { proxyWallet: '0xA', side: 'BUY', asset: 'tok', size: 0, price: 0.4, transactionHash: '0xz' },
    { proxyWallet: '0xA', side: 'BUY', asset: 'tok', size: 10, price: 1.2, transactionHash: '0xy' },
    { side: 'BUY', asset: 'tok', size: 10, price: 0.5 },
  ];
  const [t, ...rest] = T.parseTrades({ data: raw });
  assert.equal(rest.length, 0);
  assert.equal(t.key, '0xt:tok:0xa');
  assert.equal(t.size, 1500);
  near(t.notional, 615);
  assert.equal(t.price, 0.41, 'notional-weighted average fill');
  assert.equal(t.at, 1759924800000);
  assert.equal(t.side, 'BUY');
  assert.equal(t.name, 'Owl');
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
const aStats = (o = {}) => ({ n: 100, events: 30, risked: 50000, roi: 0.08, z: 3, concentration: 0.35, twoSided: 0.3, lastAt: NOW - 30 * DAY, recentRoi: -0.0999, ...o });
const bStats = (o = {}) => ({ n: 50, events: 15, risked: 20000, roi: 0.04, z: 2, concentration: 0.4, twoSided: 0.3, lastAt: NOW - 45 * DAY, recentRoi: -0.5, ...o });

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
});

test('every threshold is an option; env vars map onto them', () => {
  assert.equal(T.gradeStats(aStats(), { grades: { A: { minZ: 3.5 } } }, NOW).grade, 'B');
  assert.equal(T.gradeStats(aStats({ z: 2.5 }), { grades: { A: { minZ: 2.5 } } }, NOW).grade, 'A');
  assert.equal(T.gradeStats(bStats({ twoSided: 0.31 }), { maxTwoSided: 0.35 }, NOW).grade, 'B');
  const env = { TAIL_A_MIN_Z: '2.5', TAIL_MIN_TRADE: '1000', TAIL_B_MIN_ROI: '5', TAIL_A_MIN_RECENT_ROI: '-15', TAIL_PRIOR_RISK: 'lots', TAIL_MAX_TWO_SIDED: '0.25', TAIL_B_CAP_UNITS: '' };
  assert.deepEqual(T.optionsFromEnv(env), { grades: { A: { minZ: 2.5, minRecentRoi: -0.15 }, B: { minRoi: 0.05 } }, minTrade: 1000, maxTwoSided: 0.25 });
  const o = T.resolveOptions(T.optionsFromEnv(env));
  assert.equal(o.grades.A.minZ, 2.5);
  assert.equal(o.grades.A.minN, 100, 'untouched thresholds keep their defaults');
  assert.equal(o.grades.B.capUnits, 1);
  assert.equal(o.priorRisk, 20000);
  assert.deepEqual(T.resolveOptions(o), o, 'resolving twice changes nothing');
});

test('an elite politics wallet grades A, with stats and a category breakdown', () => {
  const s = T.scoreWallet({ wallet: W(1).toUpperCase().replace('0X', '0x'), name: 'Oracle', closed: politicsElite() }, { now: NOW });
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
  assert.deepEqual(Object.keys(s.categories), ['politics']);
  assert.equal(s.categories.politics.grade, 'A');
  assert.equal(s.categories.politics.n, 120);
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

test('resolved positions never redeemed still count, so hidden losers show up', () => {
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
  assert.deepEqual(r.map(x => [x.asset, x.risked, x.pnl, x.won]), [['l1', 1000, -1000, false], ['l2', 1000, -1000, false], [wins[0].asset, 1000, 1000, true]]);
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
  const s = T.scoreWallet({ wallet: W(1), closed: [...politicsElite(), ...sportsBad()] }, { now: NOW });
  assert.equal(s.categories.politics.grade, 'A');
  assert.equal(s.categories.sports.grade, null);
  assert.equal(s.categories.sports.pnl, -20000);
  assert.ok(s.categories.sports.failed.includes('roi'));
  assert.ok(s.categories.sports.reasons.includes('ROI -33.3% (need 4%)'));
  assert.equal(s.grade, null, 'the sports losses drag the whole record under the luck bar');
  assert.ok(s.failed.includes('z'));

  const politics = T.gradeFor(s, 'politics');
  assert.deepEqual({ ...politics, edge: round4(politics.edge) }, { grade: 'A', edge: round4((40000 / 140000) * 0.5), scope: 'category' });
  assert.deepEqual(T.gradeFor(s, 'sports'), { grade: null, skip: 'not graded in sports' });
  assert.deepEqual(T.gradeFor(s, 'crypto'), { grade: null, skip: 'not graded' });

  const mkt = market();
  const pol = T.tradeSignal({ trade: trade({ proxyWallet: W(1) }), trader: s, market: mkt, now: NOW });
  assert.equal(pol.signal.grade, 'A');
  assert.equal(pol.signal.category, 'politics');
  assert.equal(pol.signal.scope, 'category');
  const nba = T.tradeSignal({ trade: trade({ proxyWallet: W(1), title: 'Lakers vs. Celtics', eventSlug: 'nba-lal-bos-2026-10-08' }), trader: s, market: mkt, now: NOW });
  assert.deepEqual(nba, { signal: null, skip: 'not graded in sports' });

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

test('leaderboard: every category × period, deduped by wallet, one failure does not sink the rest', async () => {
  const http = recorder((url, p) => {
    if (p.category === 'SPORTS' && p.timePeriod === 'ALL') throw new Error('429');
    if (p.category === 'POLITICS') return [{ rank: 1, proxyWallet: '0xAA', userName: 'Oracle', pnl: p.timePeriod === 'ALL' ? 90000 : 5000, vol: 1e6 }];
    return { data: [{ rank: 3, wallet: '0xaa', amount: 1000 }, { rank: 4, wallet: '0xbb', name: 'Jock', amount: 700 }] };
  });
  const { rows, errors } = await T.fetchLeaderboard(http, { categories: ['POLITICS', 'SPORTS'], periods: ['WEEK', 'ALL'] });
  assert.deepEqual(http.calls[0], { url: 'https://data-api.polymarket.com/v1/leaderboard', params: { category: 'POLITICS', timePeriod: 'WEEK', orderBy: 'PNL', limit: 50 }, timeout: 10000 });
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
});

test('closed positions page until a short page or the cap; open positions, trades, markets', async () => {
  const all = Array.from({ length: 5 }, (_, i) => closed({ wallet: W(1), won: true, cond: `0xp${i}` }));
  const http = recorder((url, p) => {
    if (url.endsWith('/closed-positions')) return all.slice(p.offset, p.offset + p.limit);
    if (url.endsWith('/positions')) return [{ conditionId: '0xo', asset: 'o', size: 1 }];
    if (url.endsWith('/trades')) return [{ proxyWallet: '0xA', side: 'BUY', asset: 't', size: 2000, price: 0.5, timestamp: NOW / 1000, transactionHash: '0x9' }];
    if (url.endsWith('/markets')) return [{ conditionId: 'other' }, { conditionId: p.condition_ids, question: 'Q', outcomes: '["Yes","No"]' }];
    throw new Error(url);
  });
  const full = await T.fetchClosedPositions(http, W(1), { pageSize: 2, maxPages: 5 });
  assert.equal(full.rows.length, 5);
  assert.equal(full.truncated, false);
  assert.deepEqual(http.calls.map(c => c.params.offset), [0, 2, 4]);
  assert.deepEqual(http.calls[0].params, { user: W(1), limit: 2, offset: 0, sortBy: 'TIMESTAMP', sortDirection: 'DESC' });
  assert.equal(http.calls[0].url, 'https://data-api.polymarket.com/closed-positions');
  const capped = await T.fetchClosedPositions(http, W(1), { pageSize: 2, maxPages: 2 });
  assert.equal(capped.rows.length, 4);
  assert.equal(capped.truncated, true);

  http.calls.length = 0;
  assert.equal((await T.fetchOpenPositions(http, W(1))).length, 1);
  assert.deepEqual(http.calls[0], { url: 'https://data-api.polymarket.com/positions', params: { user: W(1), limit: 500, sizeThreshold: 1 }, timeout: 10000 });
  const big = await T.fetchRecentTrades(http);
  assert.equal(big[0].notional, 1000);
  assert.deepEqual(http.calls[1].params, { limit: 500, takerOnly: true, filterType: 'CASH', filterAmount: 500 });
  await T.fetchWalletTrades(http, W(1));
  assert.deepEqual(http.calls[2].params, { user: W(1), limit: 500, takerOnly: false });
  const m = await T.fetchMarket(http, '0xm');
  assert.equal(m.conditionId, '0xm');
  assert.equal((await T.fetchMarket({ async get() { return { data: [{ conditionId: '0xABC' }] }; } }, '0xabc')).conditionId, '0xABC', 'hex case does not matter');
  assert.equal(await T.fetchMarket({ async get() { return { data: [] }; } }, '0xabc'), null);
  assert.deepEqual(http.calls[3], { url: 'https://gamma-api.polymarket.com/markets', params: { condition_ids: '0xm' }, timeout: 10000 });
});

// ── engine ──
function world() {
  const w = { leaderboard: [], closed: {}, open: {}, walletTrades: {}, trades: [], markets: {}, fail: new Set() };
  w.http = recorder((url, p) => {
    if (url.endsWith('/v1/leaderboard')) return w.leaderboard;
    if (p.user && w.fail.has(p.user)) throw new Error('timeout');
    if (url.endsWith('/closed-positions')) return (w.closed[p.user] || []).slice(p.offset, p.offset + p.limit);
    if (url.endsWith('/positions')) return w.open[p.user] || [];
    if (url.endsWith('/trades')) return p.user ? w.walletTrades[p.user] || [] : w.trades;
    if (url.endsWith('/markets')) return w.markets[p.condition_ids] ? [w.markets[p.condition_ids]] : [];
    throw new Error(`unexpected ${url}`);
  });
  return w;
}
// each wallet's first closed-positions page (its 120 bets come in pages of 50)
const scoredUsers = http => http.calls.filter(c => c.url.endsWith('/closed-positions') && !c.params.offset).map(c => c.params.user);
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
  assert.equal(w.http.calls.filter(c => c.params.user === W(5)).length, 5, '3 pages of closed + open + trades per wallet');

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
  assert.equal(s1[0].currentPrice, 0.42);
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
  assert.equal(s2[0].units, units(true));

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
  assert.equal(w.http.calls.filter(c => c.url.endsWith('/markets')).length, 2, 'one lookup per market per 20 s: at NOW and at +2h');
  const st = eng.state();
  assert.equal(st.signals, 4);
  assert.equal(st.lastPollAt, new Date(t).toISOString());
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
  assert.deepEqual(userCalls.slice(-2).map(c => c.params), [{ user: W(1), limit: 50, takerOnly: false }, { user: W(2), limit: 50, takerOnly: false }], 'round robin');
});

test('traders() filters by grade and category; scores persist in a store', async () => {
  const w = world();
  w.closed[W(1)] = [...politicsElite(W(1)), ...sportsBad(W(1))];   // A in politics only
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
});

// ── review fixes ──
test('open positions count at today\'s price: selling the winners and holding the losers is not an edge', () => {
  // 260 winners sold at 60¢ (+$200 each on $1k at 50¢) are closed; 260 losers still open at 30¢ (−$400 each)
  const wins = Array.from({ length: 260 }, (_, i) => ({
    ...closed({ wallet: W(20), p: 0.5, stake: 1000, won: true, eventSlug: `race-${i}`, at: NOW - (i % 25) * DAY - 3600e3 }),
    realizedPnl: 400, curPrice: 0.6,
  }));
  const open = Array.from({ length: 260 }, (_, i) => ({
    proxyWallet: W(20), conditionId: `0xopen${i}`, asset: `open-${i}`, outcomeIndex: 0, outcome: 'Yes', size: 2000, avgPrice: 0.5,
    totalBought: 2000, initialValue: 1000, currentValue: 600, cashPnl: -400, realizedPnl: 0, curPrice: 0.3, redeemable: false,
    title: `Will candidate ${i} win in 2028?`, eventSlug: `race-2028-${i}`, endDate: '2028-11-07T00:00:00Z',
  }));
  const closedOnly = T.scoreWallet({ wallet: W(20), closed: wins }, { now: NOW });
  assert.equal(closedOnly.grade, 'A', 'on the closed book alone it looks elite');
  const s = T.scoreWallet({ wallet: W(20), closed: wins, open }, { now: NOW });
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
  const few = T.scoreWallet({ wallet: W(22), closed: [...old, ...after(29)], selectedAt: new Date(picked).toISOString() }, { now: NOW });
  assert.equal(few.forwardN, 29);
  assert.ok(few.forwardRoi < 0);
  assert.equal(few.grade, 'A', 'too few forward bets to judge');
  const s = T.scoreWallet({ wallet: W(22), closed: [...old, ...after(30)], selectedAt: picked }, { now: NOW });
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

test('closed positions: asks for 50 a page and pages by what came back, so a clamped page size is not the end', async () => {
  const all = Array.from({ length: 140 }, (_, i) => closed({ wallet: W(25), won: true, cond: `0xcl${i}` }));
  const http = recorder((url, p) => all.slice(p.offset, p.offset + Math.min(p.limit, 50)));   // the API's own cap
  const r = await T.fetchClosedPositions(http, W(25), { pageSize: 500, maxPages: 10 });
  assert.equal(r.rows.length, 140);
  assert.equal(r.truncated, false);
  assert.deepEqual(http.calls.map(c => [c.params.limit, c.params.offset]), [[50, 0], [50, 50], [50, 100]]);
  const capped = await T.fetchClosedPositions(recorder((url, p) => all.slice(p.offset, p.offset + 50)), W(25), { maxPages: 2 });
  assert.deepEqual([capped.rows.length, capped.truncated], [100, true]);
  // a tighter cap than we know of (20): the short first page is checked, then paged at its size
  const tight = recorder((url, p) => all.slice(p.offset, p.offset + Math.min(p.limit, 20)));
  const t20 = await T.fetchClosedPositions(tight, W(25), { maxPages: 10 });
  assert.deepEqual([t20.rows.length, t20.truncated], [140, false]);
  assert.deepEqual(tight.calls.map(c => c.params.offset), [0, 20, 40, 60, 80, 100, 120, 140]);
  // a small wallet: one extra (empty) page to be sure
  const few = all.slice(0, 7);
  const small = recorder((url, p) => few.slice(p.offset, p.offset + p.limit));
  assert.equal((await T.fetchClosedPositions(small, W(25))).rows.length, 7);
  assert.deepEqual(small.calls.map(c => c.params.offset), [0, 7]);
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
