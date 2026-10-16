const test = require('node:test');
const assert = require('node:assert');
const ba = require('../bookarbs');
const { createBookArbTracker, checkLeg } = require('../bookarbtrack');

const NOW = Date.parse('2026-10-14T20:00:00Z');
const START = '2026-10-15T00:20:00Z';
const pin = {
  key: 'pinnacle', markets: [
    { key: 'h2h', outcomes: [{ name: 'Chiefs', price: -150 }, { name: 'Raiders', price: 130 }] },
    { key: 'spreads', outcomes: [{ name: 'Chiefs', price: -105, point: -3.5 }, { name: 'Raiders', price: -105, point: 3.5 }, { name: 'Chiefs', price: 120, point: -6.5 }, { name: 'Raiders', price: -140, point: 6.5 }] },
    { key: 'totals', outcomes: [{ name: 'Over', price: -105, point: 44.5 }, { name: 'Under', price: -105, point: 44.5 }, { name: 'Over', price: 115, point: 47.5 }, { name: 'Under', price: -135, point: 47.5 }] },
  ],
};
function game(fd = [], br = [], extra = {}) {
  return { id: 'pin-777', commence_time: START, home_team: 'Chiefs', away_team: 'Raiders',
    bookmakers: [pin, { key: 'fanduel', markets: fd, ...(extra.fd || {}) }, { key: 'betrivers', markets: br, ...(extra.br || {}) }] };
}
const run = (games, more = {}) => ba.find(ba.collect({ gamesBySport: { nfl: games }, now: NOW, ...more }), { now: NOW });

test('two books on opposite sides of the same total under $1 is an arb', () => {
  const g = game([{ key: 'totals', outcomes: [{ name: 'Over', price: 110, point: 44.5 }, { name: 'Under', price: -130, point: 44.5 }] }],
    [{ key: 'totals', outcomes: [{ name: 'Over', price: -130, point: 44.5 }, { name: 'Under', price: 105, point: 44.5 }] }]);
  const { arbs } = run([g]);
  assert.strictEqual(arbs.length, 1);
  const a = arbs[0];
  assert.strictEqual(a.type, 'arb');
  assert.strictEqual(a.pair, 'betrivers+fanduel');
  assert.deepStrictEqual(a.legs.map(l => l.pick), ['Over 44.5', 'Under 44.5']);
  assert.ok(Math.abs(a.totalCost - (1 / 2.1 + 1 / 2.05)) < 1e-3);
  assert.ok(a.profitPct > 3 && a.profitPct < 4);
  assert.strictEqual(a.window, null);
  // stake split: each leg's share pays the same
  assert.ok(Math.abs(a.legs[0].pct / 100 * 2.1 - a.legs[1].pct / 100 * 2.05) < 0.01);
});

test('spreads: home -3.5 and away +3.5 are the two sides of one line; a wider pair is a middle', () => {
  const g = game([{ key: 'spreads', outcomes: [{ name: 'Chiefs', price: 100, point: -3.5 }, { name: 'Raiders', price: -120, point: 3.5 }] }],
    [{ key: 'spreads', outcomes: [{ name: 'Chiefs', price: -120, point: -3.5 }, { name: 'Raiders', price: 104, point: 3.5 }] }]);
  const { arbs } = run([g]);
  assert.strictEqual(arbs.length, 1);
  assert.deepStrictEqual(arbs[0].legs.map(l => `${l.venue} ${l.pick}`), ['fanduel Chiefs -3.5', 'betrivers Raiders +3.5']);
  assert.strictEqual(arbs[0].low, 3.5);
  assert.strictEqual(arbs[0].high, 3.5);
});

test('a middle across alternate totals: priced on Pinnacle, worst case is the miss', () => {
  // FD alternate over 41.5 and BR under 47.5: both pay on 42 to 47
  const g = game([], [{ key: 'totals', outcomes: [{ name: 'Under', price: -105, point: 47.5 }, { name: 'Over', price: -115, point: 47.5 }] }],
    { fd: { altLines: [{ kind: 'totals', name: 'Over', point: 41.5, price: -140 }] } });
  const { middles } = run([g]);
  assert.strictEqual(middles.length, 1);
  const m = middles[0];
  assert.strictEqual(m.type, 'middle');
  assert.deepStrictEqual(m.window, { lo: 42, hi: 47 });
  assert.ok(m.hitProb > 0.1 && m.hitProb < 0.4, `hit ${m.hitProb}`);
  assert.ok(m.missPct < 0);
  assert.ok(m.hitPct > 80);
  assert.ok(m.evPct >= 1);
});

test('exchange legs: a Kalshi spread contract against a book, fee in', () => {
  const g = game([{ key: 'spreads', outcomes: [{ name: 'Chiefs', price: 105, point: -3.5 }, { name: 'Raiders', price: -125, point: 3.5 }] }]);
  const row = { exchange: 'kalshi', tradable: true, id: 'KXNFLSPREAD-X-KC3', yesAsk: 0.47, noAsk: 0.62, url: 'https://kalshi.com/x' };
  const exchangeRows = new Map([['kalshi:x', { row, game: { id: '777' }, yes: '777|spread|-3.5|home', no: '777|spread|-3.5|away' }]]);
  const { arbs } = run([g], { exchangeRows });
  // FD Chiefs -3.5 at +105 (0.4878) + Kalshi NO (Raiders +3.5) at 0.62 + fee: over $1, no arb
  assert.strictEqual(arbs.length, 0);
  row.noAsk = 0.48;   // 0.48 + 0.0175 fee; with 0.4878 = 0.985
  const { arbs: again } = run([g], { exchangeRows });
  assert.strictEqual(again.length, 1);
  const k = again[0].legs.find(l => l.venue === 'kalshi');
  assert.strictEqual(k.side, 'no');
  assert.strictEqual(k.pick, 'Raiders +3.5');
  assert.strictEqual(k.cost, 0.4975);
  assert.strictEqual(again[0].pair, 'fanduel+kalshi');
});

test('Kalshi prop rungs: YES is the over, NO (1 − bid) the under, matched to the books\' player', () => {
  const g = game([{ key: 'player_reception_yds', outcomes: [{ name: 'Over', description: 'Travis Kelce', point: 59.5, price: 110 }, { name: 'Under', description: 'Travis Kelce', point: 59.5, price: -140 }] }]);
  const rungs = new Map([['KXNFLRECYDS-X-60', { ticker: 'KXNFLRECYDS-X-60', league: 'NFL', player: 'Travis Kelce', mkey: 'player_reception_yds', line: 59.5, start: START, yesBid: 0.5, yesAsk: 0.52 }]]);
  const { arbs } = run([g], { kalshiRungs: rungs, leagueOf: () => 'NFL' });
  assert.strictEqual(arbs.length, 1);
  const k = arbs[0].legs.find(l => l.venue === 'kalshi');
  assert.strictEqual(k.price, 0.5);
  assert.strictEqual(k.side, 'no');
  assert.deepStrictEqual(arbs[0].warnings, ['inactive']);
});

test('one book against itself, and exchange against exchange, are never paired', () => {
  const g = game([{ key: 'totals', outcomes: [{ name: 'Over', price: 120, point: 44.5 }, { name: 'Under', price: 120, point: 44.5 }] }]);
  assert.strictEqual(run([g]).arbs.length, 0);
});

test('a "locked" return past maxArbPct is a bad match, not shown', () => {
  const g = game([{ key: 'totals', outcomes: [{ name: 'Over', price: 200, point: 44.5 }] }], [{ key: 'totals', outcomes: [{ name: 'Under', price: 150, point: 44.5 }] }]);
  const out = run([g]);
  assert.strictEqual(out.arbs.length, 0);
  assert.strictEqual(out.counts.tooGood, 1);
});

test('fillable: contracts at the price, and walking up while the pair stays under $1', () => {
  const row = { type: 'arb', legs: [{ venue: 'fanduel', cost: 0.4878 }, { venue: 'kalshi', price: 0.48, cost: 0.5 }] };
  const f = ba.fillable(row, row.legs[1], [[0.48, 100], [0.49, 200], [0.52, 500]]);
  assert.strictEqual(f.atPrice, 100);
  assert.strictEqual(f.contracts, 300);   // 0.49 + fee 0.0175 → 0.5075 + 0.4878 < 1; 0.52 isn't
  assert.ok(f.maxStake > 290 && f.maxStake < 300);
});

test('fill check at +2 min: both legs at the price and size, late rows dropped', async () => {
  let t = NOW;
  const tr = createBookArbTracker({ now: () => t });
  const row = { id: 'a1', type: 'arb', pair: 'fanduel+kalshi', totalCost: 0.98, profitPct: 2, legs: [
    { venue: 'fanduel', qkey: 'q1', cost: 0.48 }, { venue: 'kalshi', qkey: 'q2', cost: 0.5, marketId: 'K', side: 'no', fill: { atPrice: 150 } }] };
  await tr.record([row], new Date(NOW).toISOString());
  assert.strictEqual((await tr.due(new Date(NOW + 60e3).toISOString())).length, 0);
  const at = new Date(NOW + 130e3).toISOString();
  await tr.check(new Map([['q1', { cost: 0.47 }]]), () => 120, at);
  const s = await tr.summary();
  assert.strictEqual(s.checked, 1);
  assert.strictEqual(s.ok, 1);   // $100 needs 103 contracts; 120 rest there
  const [r] = await tr.list();
  assert.strictEqual(r.exec.cost, 0.97);
  // a second row checked too late is dropped
  await tr.record([{ ...row, id: 'a2' }], at);
  await tr.check(new Map(), () => 120, new Date(NOW + 130e3 + 7 * 60e3).toISOString());
  assert.strictEqual((await tr.summary()).late, 1);
});

test('checkLeg: a book leg gone or dearer fails; an exchange leg short of size fails', () => {
  assert.strictEqual(checkLeg({ venue: 'fanduel', cost: 0.5 }, null).reason, 'gone');
  assert.strictEqual(checkLeg({ venue: 'fanduel', cost: 0.5 }, { cost: 0.52 }).reason, 'price');
  assert.strictEqual(checkLeg({ venue: 'kalshi', cost: 0.5 }, null, { fill: 40, need: 100 }).reason, 'size');
  assert.strictEqual(checkLeg({ venue: 'kalshi', cost: 0.5 }, null, { fill: null }).ok, null);
});
