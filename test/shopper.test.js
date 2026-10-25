const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../oddsengine');
const S = require('../oddsschema');
const P = require('../oddsproviders');
const R = require('../oddsrank');
const SH = require('../shopper');

const NOW = Date.parse('2026-10-25T15:00:00Z');
const START = '2026-10-25T20:00:00Z';
const READ = new Date(NOW - 60e3).toISOString();
const close = (a, b, eps = 1e-4) => assert.ok(Math.abs(a - b) <= eps, `${a} vs ${b}`);

// ── engine ──
test('devig: every method returns chances that sum to 1, and agrees on a vig-free set', () => {
  const d = [1.91, 1.91];
  for (const m of E.DEVIG_METHODS) {
    const p = E.devig(d, m);
    close(p[0] + p[1], 1);
    close(p[0], 0.5);
  }
  // a favourite: power and Shin take more off the long shot than multiplicative
  const fav = [1.3, 3.6];
  const mult = E.devig(fav, 'multiplicative'), pow = E.devig(fav, 'power'), shin = E.devig(fav, 'shin'), add = E.devig(fav, 'additive');
  for (const p of [mult, pow, shin, add]) close(p[0] + p[1], 1);
  assert.ok(pow[1] < mult[1] && shin[1] < mult[1]);
  assert.ok(add[1] < mult[1]);
  assert.throws(() => E.devig(fav, 'nope'));
  assert.equal(E.devig([1.5], 'power'), null);
  assert.equal(E.devig([1.5, 0.9]), null);
});

test('hold, EV, Kelly and the gap between two prices', () => {
  close(E.hold([1.91, 1.91]), 0.04712);
  close(E.ev(0.55, 2), 0.1);
  close(E.evAmount(0.55, 2, 50), 5);
  close(E.kelly(0.55, 2), 0.1);
  close(E.kelly(0.55, 2, 0.25), 0.025);
  assert.equal(E.kelly(0.4, 2), 0);
  const g = E.discrepancy(2.1, 2.0);
  close(g.pts, 2.38, 0.01);
  close(g.payout, 0.05);
});

test('fees: commission on net winnings, Kalshi-style contract fees, and the included kind', () => {
  close(E.afterCommission(3, 0.02), 2.96);
  // 50c with a 0.07 fee: 0.0175 rounds up to 2c → cost 52c
  close(E.contractFee(0.5), 0.02);
  close(E.contractDecimal(0.5), 1 / 0.52);
  // Polymarket-style: unrounded coefficient
  close(E.contractFee(0.5, { rate: 0.0695, roundCents: false }), 0.017375);
  close(E.effective(2, { type: 'contract', rate: 0.07 }), 1 / 0.52);
  assert.equal(E.effective(2, { type: 'included' }), 2);
  close(E.effective(2, { type: 'commission', rate: 0.05 }), 1.95);
});

test('lays: liability, the back price a lay equals, and its EV', () => {
  assert.equal(E.layLiability(10, 3), 20);
  // laying at 3.0 with no commission = backing "not it" at 1.5
  close(E.layAsBack(3), 1.5);
  close(E.layAsBack(3, 0.02), 1 + 0.98 / 2);
  // fair 30% it wins: (0.7 × 1.5) − 1 = 0.05
  close(E.layEv(0.3, 3), 0.05);
});

test('arb: stakes that pay the same whatever wins', () => {
  const a = E.arb([2.1, 2.05], 100);
  assert.equal(a.arb, true);
  assert.ok(a.profit > 0);
  close(a.stakes[0] * 2.1, a.stakes[1] * 2.05, 0.02);
  close(a.stakes[0] + a.stakes[1], 100, 0.02);
  assert.equal(E.arb([1.91, 1.91]).arb, false);
});

test('blendFair: weighted fair with how far the sources sit apart', () => {
  const b = E.blendFair([{ id: 'pinnacle', decimals: [1.8, 2.1], weight: 1 }, { id: 'matchbook', decimals: [1.85, 2.15], weight: 0.6 }]);
  assert.equal(b.n, 2);
  close(b.fair[0] + b.fair[1], 1);
  assert.ok(b.spreadPts[0] > 0);
  assert.equal(E.blendFair([{ id: 'x', decimals: [1.8] }]), null);
});

test('modelEdge: EV at the model chance and at the low end of its range', () => {
  const m = E.modelEdge({ p: 0.6, lo: 0.52, hi: 0.68 }, 1.8);
  close(m.ev, 0.08);
  close(m.evLow, -0.064);
  assert.equal(m.clearsAtLow, false);
});

// ── schema ──
test('odds formats round-trip through decimal', () => {
  close(S.toDecimal(-110, 'american'), 1.90909);
  close(S.toDecimal(150, 'american'), 2.5);
  close(S.toDecimal('5/2', 'fractional'), 3.5);
  close(S.toDecimal(0.4, 'probability'), 2.5);
  close(S.toDecimal(-0.5, 'malay'), 3);
  close(S.toDecimal(-2, 'indonesian'), 1.5);
  assert.equal(S.toDecimal(50, 'american'), null);
  assert.equal(S.fromDecimal(2.5, 'american'), 150);
  assert.equal(S.fromDecimal(1.5, 'american'), -200);
  assert.equal(S.fromDecimal(3.5, 'fractional'), '5/2');
  assert.equal(S.fromDecimal(1.5, 'indonesian'), -2);
  assert.equal(S.formatOdds(2.5, 'american'), '+150');
  assert.equal(S.formatOdds(2.5, 'probability'), '40.0%');
  for (const f of S.FORMATS) if (f !== 'fractional') close(S.toDecimal(S.fromDecimal(2.37, f), f), 2.37, 0.01);
});

test('quotes: makeQuote fills provider facts; validateQuote names what is wrong', () => {
  const q = S.makeQuote({ providerId: 'kalshi', eventId: 'pin-1', marketType: 'spread', selectionName: 'A -3.5', side: 'home', line: -3.5, decimal: 1.95, startUtc: START });
  assert.equal(q.providerName, 'Kalshi');
  assert.equal(q.providerType, 'prediction_market');
  assert.equal(q.commission.type, 'included');
  assert.equal(q.provenance.access, 'direct');
  assert.equal(q.maxStake, null);
  assert.ok(S.validateQuote(q).ok);
  const bad = S.validateQuote({ providerId: 'madeup', eventId: '', marketType: 'spread', decimal: 0.9 });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some(e => /unknown provider/.test(e)));
  assert.ok(bad.errors.some(e => /line missing/.test(e)));
  assert.equal(S.provider('kalshi').texas, true);
  assert.equal(S.provider('fanduel').texas, false);
  assert.equal(S.provider('draftkings').access, 'second_hand');
  assert.equal(S.freshness(60e3), 'live');
  assert.equal(S.freshness(5 * 60e3), 'recent');
  assert.equal(S.freshness(5 * 60e3, { access: 'second_hand' }), 'recent');
  assert.equal(S.freshness(7 * 60e3, { access: 'second_hand' }), 'stale');
  assert.equal(S.freshness(null), 'unknown');
});

// ── adapters ──
const GAME = {
  id: 'pin-1', sport_key: 'nfl', commence_time: START, home_team: 'Home Hawks', away_team: 'Away Owls',
  bookmakers: [
    { key: 'pinnacle', markets: [
      { key: 'h2h', outcomes: [{ name: 'Home Hawks', price: -150 }, { name: 'Away Owls', price: 135 }] },
      { key: 'spreads', outcomes: [{ name: 'Home Hawks', price: -105, point: -3 }, { name: 'Away Owls', price: -105, point: 3 }] },
      { key: 'totals', outcomes: [{ name: 'Over', price: -110, point: 44.5 }, { name: 'Under', price: -100, point: 44.5 }] },
      { key: 'pass_yds', outcomes: [{ name: 'Over', description: 'Joe Qb', price: -115, point: 250.5 }, { name: 'Under', description: 'Joe Qb', price: -105, point: 250.5 }] },
    ] },
    { key: 'fanduel', markets: [
      { key: 'h2h', outcomes: [{ name: 'Home Hawks', price: -140 }, { name: 'Away Owls', price: 120 }] },
      { key: 'spreads', outcomes: [{ name: 'Home Hawks', price: -110, point: -3 }, { name: 'Away Owls', price: -110, point: 3 }] },
      { key: 'pass_yds', outcomes: [{ name: 'Over', description: 'Joe Qb', price: -110, point: 250.5 }, { name: 'Under', description: 'Joe Qb', price: -120, point: 250.5 }] },
    ], altLines: [{ kind: 'totals', name: 'Over', point: 44.5, price: 105 }] },
    { key: 'gemini', markets: [{ key: 'h2h', outcomes: [{ name: 'Home Hawks', price: -138, ref: { venue: 'gemini', id: 'GEMI-X', buy: 'yes' } }, { name: 'Away Owls', price: 110 }] }] },
    { key: 'draftkings', markets: [{ key: 'h2h', outcomes: [{ name: 'Home Hawks', price: -130 }, { name: 'Away Owls', price: 110 }] }] },
    { key: 'notabook', markets: [{ key: 'h2h', outcomes: [{ name: 'Home Hawks', price: 500 }, { name: 'Away Owls', price: 500 }] }] },
  ],
};
const KBETS = new Map([
  ['1|ml|home', { key: '1|ml|home', league: 'nfl', game: { id: '1', home: 'Home Hawks', away: 'Away Owls', start: START }, venues: [{ venue: 'kalshi', decimal: 1.72, implied: 0.5814, marketId: 'KX-H', side: 'yes' }] }],
  ['1|ml|away', { key: '1|ml|away', league: 'nfl', game: { id: '1', home: 'Home Hawks', away: 'Away Owls', start: START }, venues: [{ venue: 'kalshi', decimal: 2.3, implied: 0.4348, marketId: 'KX-H', side: 'no' }] }],
  ['1|spread|-3|away', { key: '1|spread|-3|away', league: 'nfl', game: { id: '1', home: 'Home Hawks', away: 'Away Owls', start: START }, venues: [{ venue: 'kalshi', decimal: 2.02, marketId: 'KX-S', side: 'no' }] }],
  ['1|total|44.5|over', { key: '1|total|44.5|over', league: 'nfl', game: { id: '1', home: 'Home Hawks', away: 'Away Owls', start: START }, venues: [{ venue: 'polymarketus', decimal: 1.9 }] }],
]);

test('fromFreeGames: every book, market, prop and alt rung becomes a quote; unknown books are skipped', () => {
  const { quotes, stats } = P.fromFreeGames({ nfl: [GAME] }, { readAt: { default: READ, draftkings: new Date(NOW - 10 * 60e3).toISOString() } });
  assert.ok(quotes.every(q => S.validateQuote(q).ok), JSON.stringify(quotes.map(S.validateQuote).filter(v => !v.ok)));
  assert.equal(quotes.filter(q => q.providerId === 'notabook').length, 0);
  assert.equal(stats.pinnacle.quotes, 8);
  const prop = quotes.find(q => q.providerId === 'fanduel' && q.marketType === 'player_prop' && q.side === 'over');
  assert.equal(prop.player, 'Joe Qb');
  assert.equal(prop.marketName, 'pass_yds');
  const alt = quotes.find(q => q.oneWay);
  assert.equal(alt.marketType, 'total');
  assert.equal(alt.line, 44.5);
  assert.equal(quotes.find(q => q.providerId === 'gemini' && q.side === 'home').sourceIds.id, 'GEMI-X');
  assert.equal(quotes.find(q => q.providerId === 'draftkings').updatedAt, new Date(NOW - 10 * 60e3).toISOString());
  const away = quotes.find(q => q.providerId === 'pinnacle' && q.marketType === 'spread' && q.side === 'away');
  assert.equal(away.line, 3);
});

test('fromKalshiBets: Kalshi game contracts only, at the ask with the fee in', () => {
  const { quotes, stats } = P.fromKalshiBets(KBETS, { readAt: READ });
  assert.equal(stats.kalshi.quotes, 3);
  assert.ok(quotes.every(q => S.validateQuote(q).ok));
  const sp = quotes.find(q => q.marketType === 'spread');
  assert.equal(sp.side, 'away');
  assert.equal(sp.line, 3);
  assert.equal(sp.eventId, 'pin-1');
});

test('health: off, down, degraded, stale and ok', () => {
  const h = P.health({ stats: { pinnacle: { events: 3, quotes: 30 }, fanduel: { events: 2, quotes: 10 }, betrivers: { events: 1, quotes: 2 } },
    errors: ['fanduel nfl: 403', 'betrivers 123: timeout'], readAt: { pinnacle: READ, fanduel: READ, betrivers: new Date(NOW - 40 * 60e3).toISOString(), gemini: READ },
    enabled: { gemini: false }, now: NOW });
  const by = Object.fromEntries(h.map(x => [x.id, x]));
  assert.equal(by.pinnacle.status, 'ok');
  assert.equal(by.fanduel.status, 'degraded');
  assert.equal(by.betrivers.status, 'stale');
  assert.equal(by.gemini.status, 'off');
  assert.equal(by.kalshi.status, 'down');
});

test('createSource: retries with backoff, honours Retry-After, caches, and validates', async () => {
  let t = 0, calls = 0;
  const waits = [];
  const src = P.createSource({ id: 'x', retries: 2, backoffMs: 100, ttlMs: 1000, now: () => t, sleep: async w => { waits.push(w); t += w; },
    fetch: async () => { calls++; if (calls < 3) throw Object.assign(new Error('boom'), { code: 'ECONNRESET' }); return { ok: 1 }; } });
  assert.deepEqual(await src.get(), { ok: 1 });
  assert.deepEqual(waits, [100, 200]);
  assert.equal(src.health().status, 'ok');
  await src.get();
  assert.equal(calls, 3, 'served from cache inside the TTL');

  let n = 0;
  const limited = P.createSource({ id: 'y', retries: 1, now: () => t, sleep: async w => { waits.push(w); t += w; },
    fetch: async () => { n++; if (n === 1) throw Object.assign(new Error('429'), { response: { status: 429, headers: { 'retry-after': '2' } } }); return [1]; } });
  assert.deepEqual(await limited.get(), [1]);
  assert.equal(waits[waits.length - 1], 2000);

  const notFound = P.createSource({ id: 'z', retries: 3, sleep: async () => {}, fetch: async () => { throw Object.assign(new Error('nope'), { response: { status: 404 } }); } });
  await assert.rejects(notFound.get(), /HTTP 404/);
  assert.equal(notFound.health().calls, 1, 'a 404 is not retried');

  const invalid = P.createSource({ id: 'v', validate: p => (Array.isArray(p) ? true : 'not a list'), sleep: async () => {}, fetch: async () => ({}) });
  await assert.rejects(invalid.get(), /bad response: not a list/);

  const slow = P.createSource({ id: 's', timeoutMs: 20, retries: 0, fetch: signal => new Promise((resolve, reject) => { signal?.addEventListener('abort', () => reject(new Error('aborted'))); }) });
  await assert.rejects(slow.get(), /timed out/);

  const keyed = P.createSource({ id: 'k', retries: 0, fetch: async () => { throw new Error('GET https://api.x.com/v1?apiKey=SECRET failed'); } });
  await assert.rejects(keyed.get(), e => !/SECRET/.test(e.message));
});

// ── ranking ──
test('rank: confidence factors are named, second-hand copies never rank, proven only from the tracker', () => {
  const base = { ev: 0.04, fairSource: 'pinnacle', freshness: 'live', access: 'direct', provider: 'kalshi' };
  const r = R.rank(base);
  assert.equal(r.label, 'lead');
  close(r.confidence, 0.95);
  assert.equal(R.rank({ ...base, proven: new Set(['kalshi']) }).label, 'proven');
  assert.equal(R.rank({ ...base, access: 'second_hand' }).actionable, false);
  assert.equal(R.rank({ ...base, freshness: 'stale' }).actionable, false);
  const big = R.rank({ ...base, ev: 0.2 });
  assert.ok(big.reasons.some(x => /mismatched/.test(x.why)));
  assert.ok(R.rank({ ...base, oneWay: true }).confidence < r.confidence);
  assert.ok(R.rank({ ...base, liquidity: 20, stake: 100 }).confidence < r.confidence);
  const all = R.rankAll([{ ...base, key: 'a', ev: 0.02 }, { ...base, key: 'b', ev: 0.05 }, { ...base, key: 'c', ev: 0.06, access: 'second_hand' }]);
  assert.deepEqual(all.map(x => x.key), ['b', 'a']);
});

// ── shopper ──
function quotesAll() {
  return [...P.fromFreeGames({ nfl: [GAME] }, { readAt: READ }).quotes, ...P.fromKalshiBets(KBETS, { readAt: READ }).quotes];
}
test('build: one row per market at one number, best and second best after fees, fair from Pinnacle', () => {
  const v = SH.build(quotesAll(), { now: NOW });
  const ml = v.markets.find(m => m.marketType === 'moneyline');
  assert.equal(ml.fair.source, 'pinnacle');
  const home = ml.sides.find(s => s.side === 'home');
  // DraftKings' copy (−130) is the best price; Gemini (−138) next. The copy
  // can be best on the board but never ranks as an opportunity
  assert.equal(home.best.provider, 'draftkings');
  assert.equal(home.best.secondHand, true);
  assert.equal(home.second.provider, 'gemini');
  assert.ok(!v.opportunities.some(o => o.provider === 'draftkings'));
  // Pinnacle is a column, never the best
  assert.ok(home.prices.some(c => c.provider === 'pinnacle' && c.ref && !c.best));
  const away = ml.sides.find(s => s.side === 'away');
  assert.equal(away.best.provider, 'kalshi');
  const fairAway = E.devig([E.r4(S.toDecimal(-150, 'american')), 2.35], 'power')[1];
  close(away.fair, fairAway, 1e-3);
  close(away.best.ev, fairAway * 2.3 - 1, 1e-3);
  close(away.best.evAmount, (fairAway * 2.3 - 1) * 100, 0.1);
  // the spread joins Kalshi's away +3 with the books' at the same number
  const sp = v.markets.find(m => m.marketType === 'spread');
  assert.equal(sp.line, -3);
  assert.equal(sp.sides.find(s => s.side === 'away').best.provider, 'kalshi');
  // the alt Over rung sits beside Pinnacle's 44.5
  const tot = v.markets.find(m => m.marketType === 'total');
  assert.equal(tot.sides.find(s => s.side === 'over').best.provider, 'fanduel');
  assert.equal(tot.sides.find(s => s.side === 'over').best.oneWay, true);
  // the prop
  const pr = v.markets.find(m => m.marketType === 'player_prop');
  assert.equal(pr.player, 'Joe Qb');
  assert.ok(pr.fair);
  assert.ok(v.counts.markets >= 4);
  assert.ok(v.opportunities.every(o => o.rank.score > 0 && o.access === 'direct'));
});

test('build: Texas keeps the exchanges as the only places to bet; filters narrow the board', () => {
  const tx = SH.build(quotesAll(), { now: NOW, state: 'TX' });
  for (const m of tx.markets) for (const s of m.sides) if (s.best) assert.ok(['kalshi', 'gemini', 'polymarketus'].includes(s.best.provider), s.best.provider);
  // a Texas board still shows the reference column
  assert.ok(tx.markets[0].sides[0].prices.some(c => c.provider === 'pinnacle'));
  const props = SH.build(quotesAll(), { now: NOW, marketTypes: ['player_prop'] });
  assert.ok(props.markets.every(m => m.marketType === 'player_prop'));
  assert.equal(SH.build(quotesAll(), { now: NOW, q: 'nobody' }).markets.length, 0);
  assert.equal(SH.build(quotesAll(), { now: NOW, toMs: NOW + 3600e3 }).markets.length, 0);
  const noKalshi = SH.build(quotesAll(), { now: NOW, exclude: ['kalshi'] });
  assert.ok(noKalshi.markets.every(m => m.sides.every(s => s.prices.every(c => c.provider !== 'kalshi'))));
  const big = SH.build(quotesAll(), { now: NOW, minEv: 0.5 });
  assert.equal(big.opportunities.length, 0);
  // stale prices can't be best
  const old = SH.build(P.fromFreeGames({ nfl: [GAME] }, { readAt: new Date(NOW - 3600e3).toISOString() }).quotes, { now: NOW });
  assert.ok(old.markets.every(m => m.sides.every(s => !s.best)) || old.markets.length === 0);
});

test('build: an arb at the best prices comes with its stakes; free viewers get prices only', () => {
  const g = JSON.parse(JSON.stringify(GAME));
  g.bookmakers = g.bookmakers.filter(b => b.key !== 'draftkings');   // an arb leg on a copy is never listed
  g.bookmakers.find(b => b.key === 'fanduel').markets[0].outcomes[1].price = 175;   // away +175 vs home −138 at Gemini
  const v = SH.build(P.fromFreeGames({ nfl: [g] }, { readAt: READ }).quotes, { now: NOW });
  const ml = v.markets.find(m => m.marketType === 'moneyline');
  assert.ok(ml.arb, `hold ${ml.hold}`);
  assert.equal(v.arbs.length, 1);
  close(ml.arb.stakes.home + ml.arb.stakes.away, 100, 0.02);
  const free = SH.stripPro(v);
  assert.equal(free.opportunities.length, 0);
  assert.equal(free.arbs.length, 0);
  assert.ok(free.markets.every(m => m.sides.every(s => s.fair == null && s.prices.every(c => c.ev == null))));
  assert.ok(free.markets[0].sides[0].prices.length > 0);
});

test('build: no sharp line and fewer than 4 books means no fair and no EV', () => {
  const g = JSON.parse(JSON.stringify(GAME));
  g.bookmakers = g.bookmakers.filter(b => b.key !== 'pinnacle');
  const v = SH.build(P.fromFreeGames({ nfl: [g] }, { readAt: READ }).quotes, { now: NOW });
  assert.ok(v.markets.every(m => m.fair == null && m.sides.every(s => s.best == null || s.best.ev == null)));
  assert.equal(v.opportunities.length, 0);
});

// ── prop line history ──
test('line history: prop markets keep fair and venue prices over time, both sides', () => {
  const H = SH.createLineHistory({ minGapMs: 60e3, heartbeatMs: 600e3, maxSeries: 2 });
  const view = (key, fair, fd, start = START) => ({ key, marketType: 'player_prop', event: 'A @ B', league: 'nba', start, player: 'Jay Doe', marketName: 'points', line: 24.5,
    sides: [{ side: 'over', fair, prices: [{ provider: 'pinnacle', effective: 1.91 }, { provider: 'fanduel', effective: fd }] },
      { side: 'under', fair: fair == null ? null : 1 - fair, prices: [{ provider: 'pinnacle', effective: 1.91 }, { provider: 'fanduel', effective: 1.8 }] }] });
  assert.equal(H.observe([view('p1', 0.5, 2.0)], NOW), 1);
  assert.equal(H.observe([view('p1', 0.5, 2.0)], NOW + 120e3), 0, 'nothing moved, inside the heartbeat');
  assert.equal(H.observe([view('p1', 0.52, 2.0)], NOW + 30e3), 0, 'moved, but inside the gap');
  assert.equal(H.observe([view('p1', 0.52, 2.05)], NOW + 180e3), 1);
  assert.equal(H.observe([view('p1', 0.52, 2.05)], NOW + 900e3), 1, 'heartbeat');
  const h = H.forMarket('p1');
  assert.equal(h.series.length, 2);
  const [over, under] = h.series;
  assert.equal(over.label, 'Over 24.5');
  assert.deepEqual(over.pts[0], [NOW, 24.5, 0.5, { pinnacle: -110, fanduel: 100 }]);
  assert.equal(over.pts[1][3].fanduel, 105);
  close(under.pts[1][2], 0.48);
  assert.equal(under.pts[0][3].fanduel, -125);
  // game lines are not kept here, nor a prop with one venue and no fair
  H.observe([{ ...view('g1', 0.5, 2), marketType: 'total' }, { ...view('p2', null, 2), sides: view('p2', null, 2).sides.map(s => ({ ...s, prices: s.prices.slice(1) })) }], NOW);
  assert.equal(H.has('g1'), false); assert.equal(H.has('p2'), false);
  // full: a sooner market pushes out the latest one; a later one is skipped
  H.observe([view('p3', 0.5, 2, '2026-10-25T18:00:00Z')], NOW);
  H.observe([view('p4', 0.5, 2, '2026-10-26T18:00:00Z')], NOW);
  assert.equal(H.size(), 2); assert.ok(H.has('p3') && H.has('p1') && !H.has('p4'));
  // dropped hours after the start; dump and load round-trip
  const H2 = SH.createLineHistory();
  H2.load(H.dump());
  assert.equal(H2.forMarket('p1').series[0].pts.length, 3);
  H2.prune(Date.parse(START) + 7 * 3600e3);
  assert.equal(H2.has('p1'), false);
});

test('shopper league filter takes one league or a list (favorites)', () => {
  const mk = (lg, ev) => [S.makeQuote({ providerId: 'pinnacle', eventId: ev, sport: 'x', league: lg, home: 'H', away: 'A', marketType: 'moneyline', side: 'home', selectionName: 'H', decimal: 1.9, startUtc: START, updatedAt: READ }),
    S.makeQuote({ providerId: 'pinnacle', eventId: ev, sport: 'x', league: lg, home: 'H', away: 'A', marketType: 'moneyline', side: 'away', selectionName: 'A', decimal: 2.0, startUtc: START, updatedAt: READ }),
    S.makeQuote({ providerId: 'fanduel', eventId: ev, sport: 'x', league: lg, home: 'H', away: 'A', marketType: 'moneyline', side: 'home', selectionName: 'H', decimal: 1.95, startUtc: START, updatedAt: READ }),
    S.makeQuote({ providerId: 'fanduel', eventId: ev, sport: 'x', league: lg, home: 'H', away: 'A', marketType: 'moneyline', side: 'away', selectionName: 'A', decimal: 1.9, startUtc: START, updatedAt: READ })];
  const qs = [...mk('nfl', 'e1'), ...mk('nba', 'e2'), ...mk('nhl', 'e3')];
  const leagues = o => new Set(SH.build(qs, { now: NOW, ...o }).markets.map(m => m.league));
  assert.deepEqual([...leagues({ league: 'nba' })], ['nba']);
  assert.deepEqual([...leagues({ league: 'nfl,nhl' })].sort(), ['nfl', 'nhl']);
  assert.deepEqual([...leagues({ league: ['nba', 'nhl'] })].sort(), ['nba', 'nhl']);
  assert.equal(leagues({}).size, 3);
});
