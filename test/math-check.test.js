// Independent checks of the betting math: every formula is recomputed here
// from first principles (brute force or a textbook identity) and compared.
const test = require('node:test');
const assert = require('node:assert/strict');
const ev = require('../ev');
const dist = require('../dist');
const slip = require('../slip');
const ctx = require('../context');
const { verdictOf, score } = require('../results');
const { createTracker } = require('../tracker');

const close = (a, b, tol = 1e-9, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} ${a} vs ${b}`);

test('odds conversions round-trip and match the textbook values', () => {
  close(ev.americanToDecimal(-110), 1 + 100 / 110);
  close(ev.americanToDecimal(150), 2.5);
  assert.equal(ev.decimalToAmerican(2.5), 150);
  assert.equal(ev.decimalToAmerican(1 + 100 / 110), -110);
  assert.equal(ev.probToAmerican(0.5), 100);
  close(ctx.americanToProb(-110), 110 / 210);
});

test('devig: -110/-110 is 50/50 and the power method keeps every side and sums to 1', () => {
  const d = ev.americanToDecimal(-110);
  for (const m of ['power', 'multiplicative']) {
    const p = ev.devig([d, d], m);
    close(p[0], 0.5, 1e-9, m);
  }
  // -200 / +170: multiplicative is the implied share; power shades the longshot
  const a = ev.americanToDecimal(-200), b = ev.americanToDecimal(170);
  const ia = 1 / a, ib = 1 / b;
  const mult = ev.devig([a, b], 'multiplicative');
  close(mult[0], ia / (ia + ib));
  const pow = ev.devig([a, b], 'power');
  close(pow[0] + pow[1], 1);
  // the power k solves ia^k + ib^k = 1
  const k = Math.log(pow[0]) / Math.log(ia);
  close(ia ** k + ib ** k, 1, 1e-6);
  assert.ok(pow[1] < mult[1], 'power takes more vig off the longshot');
  close(ctx.devig(-200, 170), ia / (ia + ib));
});

test('EV and Kelly on the screener match p·d − 1 and (p·d − 1)/(d − 1)', () => {
  const games = [{ home_team: 'H', away_team: 'A', commence_time: '2099-01-01T00:00:00Z', bookmakers: [
    { key: 'pinnacle', markets: [{ key: 'h2h', outcomes: [{ name: 'H', price: -120 }, { name: 'A', price: 110 }] }] },
    { key: 'fanduel', markets: [{ key: 'h2h', outcomes: [{ name: 'H', price: -105 }, { name: 'A', price: -115 }] }] },
  ] }];
  const rows = ev.screen({ feeds: [{ games, sport: 'nba' }], minEv: -100, now: 0 });
  const row = rows.find(r => r.book === 'fanduel' && r.side === 'H');
  const fair = ev.devig([ev.americanToDecimal(-120), ev.americanToDecimal(110)], 'power')[0];
  const d = ev.americanToDecimal(-105);
  close(row.ev, Math.round((fair * d - 1) * 1e4) / 100, 0.006);
  close(row.kelly, Math.round(((fair * d - 1) / (d - 1)) * 0.25 * 1e4) / 100, 0.006);
});

test('negative binomial: pmf sums to 1 with mean m and variance k·m', () => {
  for (const [m, k] of [[2.5, 2], [6, 1.5], [12, 4]]) {
    let s = 0, mu = 0, m2 = 0;
    for (let n = 0; n < 2000; n++) { const p = dist.nbPmf(n, m, k); s += p; mu += n * p; m2 += n * n * p; }
    close(s, 1, 1e-9, 'sum');
    close(mu, m, 1e-6, 'mean');
    close(m2 - mu * mu, k * m, 1e-5, 'var');
  }
});

test('series math: map-to-series matches brute force over every map sequence', () => {
  // walk every map sequence until one side reaches the target
  const brute = (p, bo) => {
    const need = Math.ceil(bo / 2);
    const go = (a, b) => (a === need ? 1 : b === need ? 0 : p * go(a + 1, b) + (1 - p) * go(a, b + 1));
    return go(0, 0);
  };
  for (const bo of [3, 5]) for (const p of [0.3, 0.5, 0.62]) {
    close(ctx.mapToSeriesProb(p, bo), brute(p, bo), 1e-12);
    close(ctx.seriesToMapProb(ctx.mapToSeriesProb(p, bo), bo), p, 1e-9);
  }
  // P(map 3 played in a Bo3) = 2p(1 − p)
  close(ctx.pMapPlayed(3, 0.7, 3), 2 * 0.7 * 0.3, 1e-12);
});

test('a joint never leaves its Fréchet bounds', () => {
  // two 80% legs must land together at least 60% of the time
  close(slip.adjustJoint(0.8, 0.8, -1), 0.6, 1e-12);
  close(slip.adjustJoint(0.3, 0.4, 1), 0.3, 1e-12);
});

test('best slips never put the same player in an entry twice', () => {
  const leg = (player, prob, stat, ev) => ({ player, team: 'T1', gameId: 'g1', prob, stat, side: 'OVER', ev });
  const pool = [leg('Alpha', 0.62, 'kills', 10), leg('Alpha', 0.61, 'headshots', 9), leg('Bravo', 0.58, 'kills', 4), leg('Charlie', 0.57, 'kills', 3)];
  for (const s of slip.bestSlips(pool, { maxLegs: 3 })) {
    const names = s.picks.map(p => p.player);
    assert.equal(new Set(names).size, names.length, names.join(','));
  }
});

test('a verdict counts only the bets that carry the number it judges', () => {
  // 25 records, but a closing price on only 3: three bets of CLV evidence is not proof
  const bets = Array.from({ length: 25 }, (_, i) => ({ profit: null, staked: 0, clv: i < 3 ? 0.05 + i * 0.001 : null }));
  const s = score(bets);
  assert.equal(s.clvN, 3);
  assert.equal(s.verdict, 'early');
  // 20 closing prices clearly beating the close is
  const good = Array.from({ length: 20 }, (_, i) => ({ profit: null, staked: 0, clv: 0.03 + (i % 5) * 0.002 }));
  assert.equal(score(good).verdict, 'proven');
  assert.equal(verdictOf({ n: 30, graded: 30, roi: -0.1, roiT: -1, avgClv: 0.02, clvN: 2, clvT: null }), 'avoid', 'too little CLV, so ROI leads');
});

test('pick ROI and breakeven leave pushes out: a push refunds the stake', async () => {
  const rows = new Map();
  const store = { async init() {}, async all() { return [...rows.values()]; }, async put(r) { rows.set(r.id, r); } };
  const t = createTracker({ store });
  const base = { status: 'graded', signalDecimal: 1 / 0.5622, signalEv: 5, clv: null };
  rows.set('a', { ...base, id: 'a', outcome: 'win', profit: 1 / 0.5622 - 1 });
  rows.set('b', { ...base, id: 'b', outcome: 'loss', profit: -1 });
  rows.set('c', { ...base, id: 'c', outcome: 'push', profit: 0 });
  const s = await t.summary();
  close(s.overall.roi, (1 / 0.5622 - 2) / 2, 1e-9);
  close(s.overall.breakeven, 0.5622, 1e-9);
});

test('a team\'s usual price is read on the same calibrated scale as tonight\'s', () => {
  const games = [];
  for (let i = 0; i < 40; i++) games.push({ a: 'Strong', b: i % 2 ? 'Weak' : 'Mid', aWon: true, t: i });
  for (let i = 0; i < 20; i++) games.push({ a: 'Mid', b: 'Weak', aWon: i % 3 !== 0, t: 100 + i });
  const elo = ctx.buildElo(games);
  const raw = elo.typical('Strong');
  elo.scale = 0.4;
  const cal = elo.typical('Strong');
  assert.ok(cal < raw && cal > 0.5, `${cal} vs ${raw}`);
  // an even matchup against itself reads exactly the usual price at scale 1
  elo.scale = 1;
  close(elo.typical('Strong'), raw);
});
