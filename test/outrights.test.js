const test = require('node:test');
const assert = require('node:assert/strict');
const o = require('../outrights');
const fx = require('./fixtures/outrights-2026-10-25.json');
const results = require('../results');

const NOW = Date.parse('2026-10-25T17:40:00Z');
const sum = xs => xs.reduce((s, x) => s + x, 0);

test('names: surnames, middle names, suffixes and accents match; brothers do not', () => {
  assert.ok(o.sameName('Kimi Antonelli', 'Andrea Kimi Antonelli'));
  assert.ok(o.sameName('Carlos Sainz Jr.', 'Carlos Sainz'));
  assert.ok(o.sameName('Søren Kjeldsen', 'Soren Kjeldsen'));
  assert.ok(o.sameName('Verstappen', 'Max Verstappen'));
  assert.ok(!o.sameName('Rasmus Hojgaard', 'Nicolai Hojgaard'));
  // a surname shared by two runners is ambiguous: no match
  assert.equal(o.findRunner([{ name: 'Rasmus Hojgaard' }, { name: 'Nicolai Hojgaard' }], 'Hojgaard'), null);
  assert.equal(o.findRunner([{ name: 'Rasmus Hojgaard' }, { name: 'Nicolai Hojgaard' }], 'Nicolai Hojgaard').name, 'Nicolai Hojgaard');
});

test('de-vig: power and Shin hit the target, and both shrink the longshot more than the favourite', () => {
  const qs = [0.55, 0.4, 0.15, 0.08, 0.04];   // 22% over
  for (const target of [1, 0.93]) {
    const pw = o.devigPower(qs, target), sh = o.devigShin(qs, target);
    assert.ok(Math.abs(sum(pw) - target) < 1e-6);
    assert.ok(Math.abs(sum(sh) - target) < 1e-6);
    const S = sum(qs);
    // proportional would keep q/S; both give the favourite more and the longshot less
    assert.ok(pw[0] > qs[0] / S * target && pw[4] < qs[4] / S * target);
    assert.ok(sh[0] > qs[0] / S * target && sh[4] < qs[4] / S * target);
  }
  // two-way, even prices: 50/50 each way
  const [p] = o.devigShin([0.5238, 0.5238]);
  assert.ok(Math.abs(p - 0.5) < 1e-6);
  // fairsOf keeps the lower fair for a Yes and the lower No
  const f = o.fairsOf([{ name: 'A', american: -113 }, { name: 'B', american: 110 }, { name: 'C', american: 1395 }]);
  for (const r of f) {
    assert.equal(r.fairYes, Math.min(r.power, r.shin));
    assert.equal(r.fairNo, Math.round((1 - Math.max(r.power, r.shin)) * 1e4) / 1e4);
  }
});

test('Pinnacle: the race winner, driver head-to-heads and golf Top N Yes/No grouped a tournament', () => {
  const f1 = o.parsePinLeague('f1', fx.pinF1.matchups, fx.pinF1.markets, NOW);
  const w = f1.find(m => m.type === 'winner');
  assert.equal(w.title, 'US Grand Prix Winner');
  assert.ok(w.runners.length >= 8 && w.runners.some(r => r.name === 'Max Verstappen'));
  assert.equal(w.limit, 500);
  assert.ok(o.overround(w.runners) > 0.2, 'Pinnacle\'s F1 winner book carries a 20%+ margin');
  const h = f1.filter(m => m.type === 'h2h');
  assert.equal(h.length, 2);
  assert.ok(h.every(m => m.runners.length === 2 && m.scope === 'event'));
  // after the cutoff nothing is left
  assert.equal(o.parsePinLeague('f1', fx.pinF1.matchups, fx.pinF1.markets, Date.parse('2026-10-25T20:00:01Z')).length, 0);
  const golf = o.parsePinLeague('golf', fx.pinGolf.matchups, fx.pinGolf.markets, Date.parse('2026-10-21T12:00:00Z'));
  assert.equal(golf.length, 1);
  assert.equal(golf[0].type, 'top30');
  assert.ok(golf[0].twoWay && golf[0].runners.length === 3 && golf[0].runners.every(r => r.american != null && r.no != null));
});

test('Kalshi and Polymarket US futures parse to runners with buy prices (NO at 1 − the bid on Polymarket US)', () => {
  const k = o.parseKalshiEvent(fx.kalshiEvent);
  assert.equal(k.type, 'winner'); assert.equal(k.sport, 'f1'); assert.equal(k.runners.length, 22);
  const ver = k.runners.find(r => r.name === 'Max Verstappen');
  assert.equal(ver.yesAsk, 0.51); assert.equal(ver.noAsk, 0.51); assert.ok(ver.yesAskSize > 0 && ver.noAskSize > 0);
  const p = o.parsePmusEvent(fx.pmusEvent, 'f1');
  assert.equal(p.type, 'winner'); assert.equal(p.venue, 'polymarketus');
  const pv = p.runners.find(r => r.name === 'Max Verstappen');
  assert.equal(pv.yesAsk, 0.549); assert.equal(pv.noAsk, Math.round((1 - 0.492) * 1e4) / 1e4); assert.equal(pv.feeRate, 0.0695);
  assert.equal(o.pmusTypeOf('f1-mcusgp-2026-10-25-top3', 'f1').type, 'top3');
  assert.equal(o.pmusTypeOf('f1-mcusgp-2026-10-25-cons', 'f1'), null);
  assert.equal(o.pmusTypeOf('pga-vidamexi-2026-10-29-r1l', 'golf'), null);
});

test('board: both exchanges matched to Pinnacle\'s race, fees in, Kalshi sized from its top level', () => {
  const pins = o.parsePinLeague('f1', fx.pinF1.matchups, fx.pinF1.markets, NOW);
  const exch = [o.parseKalshiEvent(fx.kalshiEvent), o.parsePmusEvent(fx.pmusEvent, 'f1')];
  const b = o.boardOf({ pins, exch });
  assert.ok(b.some(x => x.venue === 'kalshi') && b.some(x => x.venue === 'polymarketus'));
  for (const x of b) {
    assert.ok(x.cost > x.price, 'the fee is in');
    assert.equal(x.ev, Math.round((x.fair / x.cost - 1) * 1e4) / 1e4);
  }
  // Kalshi's runners Pinnacle doesn't list are held back from the field
  const kv = b.find(x => x.venue === 'kalshi' && x.runner === 'Max Verstappen' && x.buy === 'no');
  assert.ok(kv.missing > 0 && kv.missing <= o.MAX_MISSING);
  assert.equal(kv.sized, 'top');
  assert.ok(kv.tiers[50].full && kv.tiers[50].contracts > 0);
  // Polymarket US has no sizes until its book is read
  const pv = b.find(x => x.venue === 'polymarketus' && x.runner === 'Max Verstappen' && x.buy === 'no');
  assert.equal(pv.tiers, null);
  // a read book sizes it
  const b2 = o.boardOf({ pins, exch, books: new Map([[pv.sideKey, [[0.508, 30], [0.52, 1000]]]]) });
  const pv2 = b2.find(x => x.sideKey === pv.sideKey);
  assert.equal(pv2.sized, 'book');
  assert.ok(pv2.tiers[50].full && pv2.tiers[50].cost > 0.508);
  // nothing matched a week off
  const far = { ...exch[0], end: '2026-11-02T02:00:00Z' };
  assert.equal(o.boardOf({ pins, exch: [far] }).length, 0);
});

test('flag rule: $50 full at the edge, fair 2%+, Pinnacle fresh, 2 min to 7 days out, never season', () => {
  const x = { family: 'outright', season: false, fair: 0.5, cutoff: '2026-10-25T20:00:00Z', tiers: { 50: { full: true, ev: 0.031, cost: 0.485, contracts: 100 } } };
  assert.ok(o.flagOf(x, NOW, NOW - 60e3));
  assert.equal(o.flagOf(x, NOW, NOW - 6 * 60e3), null, 'stale Pinnacle');
  assert.equal(o.flagOf({ ...x, tiers: { 50: { full: true, ev: 0.029 } } }, NOW, NOW), null, 'under the edge');
  assert.equal(o.flagOf({ ...x, tiers: { 50: { full: false, ev: 0.05 } } }, NOW, NOW), null, 'the book does not hold $50');
  assert.equal(o.flagOf({ ...x, fair: 0.015 }, NOW, NOW), null, 'longshot under 2%');
  assert.equal(o.flagOf({ ...x, season: true }, NOW, NOW), null);
  assert.equal(o.flagOf(x, Date.parse('2026-10-25T19:59:00Z'), Date.parse('2026-10-25T19:59:00Z')), null, 'inside 2 min');
  assert.ok(o.flagOf({ ...x, family: 'h2h', tiers: { 50: { full: true, ev: 0.021 } } }, NOW, NOW), 'head-to-heads at 2%');
});

function memStore() { const m = new Map(); return { all: async () => [...m.values()].map(x => JSON.parse(JSON.stringify(x))), put: async b => { m.set(b.id, JSON.parse(JSON.stringify(b))); }, m }; }

test('tracker: one flag a side, followed to Pinnacle\'s close, settled on Kalshi (and a Polymarket US flag on its Kalshi twin)', async () => {
  let t = NOW;
  const calls = [];
  const http = { get: async url => { calls.push(url); return { data: { market: { result: /VER$/.test(url) ? 'no' : 'no', status: 'finalized' } } }; } };
  const store = memStore();
  const tr = o.createOutrightsTracker({ store, http, now: () => t });
  const pins = o.parsePinLeague('f1', fx.pinF1.matchups, fx.pinF1.markets, NOW);
  const exch = [o.parseKalshiEvent(fx.kalshiEvent), o.parsePmusEvent(fx.pmusEvent, 'f1')];
  const pv = o.boardOf({ pins, exch }).find(x => x.venue === 'polymarketus' && x.runner === 'Max Verstappen' && x.buy === 'no');
  const books = new Map([[pv.sideKey, [[0.508, 1000]]]]);
  await tr.scan({ pins, pinReadAt: t, exch, books });
  const flags = await store.all();
  assert.ok(flags.length >= 1);
  const k = flags.find(b => b.venue === 'kalshi' && b.runner === 'Max Verstappen' && b.buy === 'no');
  assert.ok(k, 'Kalshi Verstappen NO clears +3% at $50 on this read');
  assert.ok(k.evAtFlag >= 0.03 && k.cost > 0.51 && k.fairAtFlag > k.cost);
  for (const b of flags) assert.ok(b.evAtFlag >= o.EDGE[b.family] && b.fairAtFlag >= o.MIN_FAIR);
  // again: no second flag on the same side
  t += 2 * 60e3;
  await tr.scan({ pins, pinReadAt: t, exch, books });
  assert.equal((await store.all()).length, flags.length);
  // a read 12 min before the cutoff, then past it: closed on that read, CLV graded
  t = Date.parse('2026-10-25T19:48:00Z');
  await tr.scan({ pins, pinReadAt: t, exch, books });
  t = Date.parse('2026-10-25T20:01:00Z');
  await tr.scan({ pins: [], pinReadAt: t, exch: [], books: new Map() });
  const closed = await store.all();
  assert.ok(closed.every(b => b.status === 'closed'));
  const kc = closed.find(b => b.id === k.id);
  assert.ok(kc.closeFair > 0 && kc.clv != null && !kc.fairs);
  // settled from Kalshi
  t = Date.parse('2026-10-25T23:00:00Z');
  const r = await tr.settle();
  assert.equal(r.settled, closed.length);
  const ks = (await store.all()).find(b => b.id === k.id);
  assert.equal(ks.status, 'settled'); assert.equal(ks.outcome, 'win'); assert.ok(ks.profit > 0.8);
  const pm = (await store.all()).find(b => b.venue === 'polymarketus');
  if (pm) { assert.equal(pm.settledVia, 'kalshi twin'); assert.ok(calls.some(u => u.includes(pm.kalshiTwin))); }
  // summary per sport
  const s = o.summarize(await store.all());
  assert.equal(s.graded, closed.length); assert.equal(s.verdict, 'lead');
});

test('a close older than 20 min before the cutoff is no close', async () => {
  let t = NOW;
  const store = memStore();
  const tr = o.createOutrightsTracker({ store, http: { get: async () => ({}) }, now: () => t });
  const pins = o.parsePinLeague('f1', fx.pinF1.matchups, fx.pinF1.markets, NOW);
  await tr.scan({ pins, pinReadAt: t, exch: [o.parseKalshiEvent(fx.kalshiEvent)] });
  t = Date.parse('2026-10-25T20:00:30Z');
  await tr.scan({ pins: [], pinReadAt: 0, exch: [] });
  const rows = await store.all();
  assert.ok(rows.length && rows.every(b => b.closeMissing && b.closeFair == null && b.clv == null));
});

test('verdict: 50 graded at CLV t 2+ passes the record; CLV under 0 fails; results 1.5 sd short fail', () => {
  const mk = (clv, i) => ({ sport: 'f1', status: 'settled', cost: 0.5, closeFair: 0.5 * (1 + clv), clv, outcome: i % 2 ? 'win' : 'loss', profit: i % 2 ? 1 : -1 });
  assert.equal(o.summarize(Array.from({ length: 50 }, (_, i) => mk(0.03 + (i % 5) * 0.01, i))).verdict, 'passes the record');
  assert.equal(o.summarize(Array.from({ length: 50 }, (_, i) => mk(-0.02 + (i % 3) * 0.005, i))).verdict, 'fail');
  assert.equal(o.summarize(Array.from({ length: 50 }, (_, i) => ({ ...mk(0.05, i), outcome: 'loss', profit: -1 }))).verdict, 'fail');
  assert.equal(o.summarize(Array.from({ length: 49 }, (_, i) => mk(0.05, i))).verdict, 'lead');
});

test('Results: exchange outrights are judged one sport on one exchange, never pooled', () => {
  const rows = Array.from({ length: 60 }, (_, i) => ({ sport: 'f1', venue: 'kalshi', type: 'winner', pinMarket: `m${i}`, cutoff: '2026-11-01T20:00:00Z', flaggedAt: '2026-10-30T00:00:00Z',
    status: 'settled', cost: 0.5, closeFair: 0.53 + (i % 4) * 0.005, clv: 0.06 + (i % 4) * 0.01, outcome: i % 2 ? 'win' : 'loss', profit: i % 2 ? 1 : -1 }));
  const sb = results.scoreboard({ exchangeOutrights: rows });
  const src = sb.sources.exchangeOutrights;
  assert.ok(src, 'the source is on the scoreboard');
  assert.notEqual(src.overall.verdict, 'proven');
});
