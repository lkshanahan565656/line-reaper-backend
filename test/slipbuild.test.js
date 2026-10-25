const test = require('node:test');
const assert = require('node:assert/strict');
const { autoSlips, bookLeg, priceOn } = require('../slipbuild');

// a board pick priced on the books given: { PP: { prob }, UD: { prob, mult, line }, SL: { prob, mult } }
let n = 0;
function pick(books, extra = {}) {
  n++;
  const ev = (b, be) => b ? +((b.prob / be - 1) * 100).toFixed(2) : null;
  const pricing = { line: 20.5, side: 'OVER', meanPerMap: null, k: null, stat: 'kills', scenarios: [{ maps: 2, weight: 1 }], shift: 0, books: {} };
  for (const [k, b] of Object.entries(books)) pricing.books[k] = { line: b.line ?? 20.5, shift: 0, prob: b.prob, mult: b.mult ?? null };
  return {
    player: `p${n}`, team: `t${n}`, gameId: `g${n}`, sport: 'CS2', market: 'Kills', side: 'OVER', startTime: '',
    ppEv: ev(books.PP, 0.5622), udEv: books.UD ? +((books.UD.prob * (books.UD.mult || 1) / 0.5623 - 1) * 100).toFixed(2) : null,
    sleeperEv: books.SL ? +((books.SL.prob * books.SL.mult - 1) * 100).toFixed(2) : null,
    pricing, ...extra,
  };
}

test('bookLeg reads the leg at that book\'s own line and skips books that do not carry it', () => {
  const p = pick({ PP: { prob: 0.6 }, UD: { prob: 0.57, line: 21.5, mult: 1 } });
  assert.equal(bookLeg(p, 'PP').line, 20.5);
  assert.equal(bookLeg(p, 'UD').line, 21.5);
  assert.equal(bookLeg(p, 'UD').prob, 0.57);
  assert.equal(bookLeg(p, 'SL'), null);
  p.pricing.books.UD.decimal = true;
  assert.equal(bookLeg(p, 'UD'), null);
});

test('Sleeper slips pay the product of the leg multipliers', () => {
  const legs = [{ prob: 0.6, mult: 1.8 }, { prob: 0.55, mult: 2 }];
  const [r] = priceOn('SL', legs);
  assert.equal(r.table, 'sleeper');
  assert.ok(Math.abs(r.ev - (0.6 * 0.55 * 3.6 - 1) * 100) < 0.01);
});

test('a boosted Underdog leg scales standard and keeps the entry out of flex', () => {
  const legs = [{ prob: 0.6, mult: 1 }, { prob: 0.6, mult: 0.9 }, { prob: 0.6, mult: 1 }];
  const tables = priceOn('UD', legs).map(r => r.table);
  assert.deepEqual(tables, ['underdog_standard']);
  const [r] = priceOn('UD', legs);
  assert.ok(Math.abs(r.ev - (0.216 * 6.5 * 0.9 - 1) * 100) < 0.01);
  assert.ok(priceOn('UD', legs.map(l => ({ ...l, mult: 1 }))).some(x => x.table === 'underdog_flex'));
});

test('builds the best +EV slip per book, one pick per player, best first', () => {
  const picks = [
    pick({ PP: { prob: 0.64 } }), pick({ PP: { prob: 0.62 } }), pick({ PP: { prob: 0.61 } }),
    pick({ PP: { prob: 0.6 } }), pick({ PP: { prob: 0.5 } }),
    pick({ SL: { prob: 0.6, mult: 1.8 } }), pick({ SL: { prob: 0.58, mult: 1.85 } }),
  ];
  picks.push({ ...picks[0], market: 'Headshots' });   // same player twice
  const r = autoSlips(picks);
  const pp = r.slips.find(s => s.book === 'PP');
  assert.equal(pp.status, 'plus');
  assert.ok(pp.ev > 0);
  assert.equal(new Set(pp.picks.map(l => l.player)).size, pp.picks.length);
  assert.ok(!pp.picks.some(l => l.prob === 50));
  const sl = r.slips.find(s => s.book === 'SL');
  assert.equal(sl.legs, 2);
  assert.ok(Math.abs(sl.paysAll - 3.33) < 0.01);
  assert.ok(r.slips[0].ev >= r.slips[r.slips.length - 1].ev);
  assert.equal(r.pool.PP.legs, 5);   // the 50% leg is below the floor; the repeat player is in the pool
});

test('with no +EV slip the closest one is kept and marked near; far ones are dropped', () => {
  const near = autoSlips([pick({ SL: { prob: 0.55, mult: 1.8 } }), pick({ SL: { prob: 0.55, mult: 1.8 } })]);
  assert.equal(near.slips.length, 1);
  assert.equal(near.slips[0].status, 'near');
  assert.ok(near.slips[0].ev < 0 && near.slips[0].ev > -5);
  const far = autoSlips([pick({ SL: { prob: 0.52, mult: 1.8 } }), pick({ SL: { prob: 0.52, mult: 1.8 } })]);
  assert.equal(far.slips.length, 0);
});

test('an entry always has two teams, and started matches drop out', () => {
  const a = pick({ PP: { prob: 0.66 } }, { team: 'NaVi' });
  const b = pick({ PP: { prob: 0.65 } }, { team: 'NaVi' });
  const c = pick({ PP: { prob: 0.6 } }, { team: 'G2' });
  const r = autoSlips([a, b, c]);
  for (const s of r.books.PP) assert.ok(new Set(s.picks.map(l => l.team)).size >= 2);
  const started = autoSlips([a, { ...c, startTime: new Date(Date.now() - 60000).toISOString() }]);
  assert.equal(started.pool.PP.legs, 1);
  assert.equal(started.slips.length, 0);
});

test('the size played is the one that grows a bankroll fastest, not the longest', () => {
  const picks = [0.68, 0.6, 0.58, 0.58, 0.56, 0.556].map(p => pick({ PP: { prob: p } }));
  const r = autoSlips(picks);
  const pp = r.books.PP;
  const longest = pp.reduce((a, b) => (b.ev > a.ev ? b : a));
  assert.ok(longest.legs > pp[0].legs);       // EV alone would pick the long one
  assert.ok(pp[0].growth >= longest.growth);
  assert.equal(r.slips[0].legs, pp[0].legs);
});

test('a hand-built slip is priced on each book that carries every leg, at its own lines', () => {
  const { priceOnBooks } = require('../slipbuild');
  const a = pick({ PP: { prob: 0.6 }, UD: { prob: 0.58, line: 21.5, mult: 1 } });
  const b = pick({ PP: { prob: 0.62 }, SL: { prob: 0.6, mult: 1.8 } });
  const r = priceOnBooks([a, b]);
  assert.equal(r.PP.legs, 2);
  assert.ok(Math.abs(r.PP.ev - (0.6 * 0.62 * 3 - 1) * 100) < 0.01);
  assert.equal(r.UD, null);      // b isn't on Underdog
  assert.equal(r.SL, null);      // a isn't on Sleeper
  assert.equal(priceOnBooks([a, null]).PP, null);
  assert.equal(priceOnBooks([a, { ...a, market: 'Headshots' }]).PP, null);   // one player twice
});

// the Lines table's fair on a pick (server attachLinesFair)
function linesFair(p, books, marketOk = true) {
  p.pricing.lines = { books, marketOk };
  return p;
}

test('a leg is priced at the Lines table\'s model fair, on the side it leans, not the consensus side', () => {
  const p = linesFair(pick({ PP: { prob: 0.6 } }), {
    PP: { src: 'h2h', line: 20.5, side: 'UNDER', clears: true, sides: { UNDER: { prob: 0.61, ev: 8.4 }, OVER: { prob: 0.39, ev: -30.7 } } },
  });
  const l = bookLeg(p, 'PP');
  assert.equal(l.side, 'UNDER');
  assert.equal(l.prob, 0.61);
  assert.equal(l.ev, 8.4);
  assert.equal(l.fair, 'h2h');
  // the person's own side (the slip bar) is priced at the same fair
  assert.equal(bookLeg(p, 'PP', { side: 'OVER' }).prob, 0.39);
});

test('a model-only lean (not green on the Lines table) is no leg for an auto slip, but a hand-built slip still prices it', () => {
  const p = linesFair(pick({ PP: { prob: 0.6 } }), {
    PP: { src: 'h2h', line: 20.5, side: 'UNDER', clears: false, sides: { UNDER: { prob: 0.66, ev: 17 } } },
  });
  assert.equal(bookLeg(p, 'PP', { bettable: true }), null);
  assert.equal(bookLeg(p, 'PP').side, 'UNDER');
  const others = [pick({ PP: { prob: 0.62 } }), pick({ PP: { prob: 0.61 } })];
  const r = autoSlips([p, ...others]);
  assert.ok(!r.slips.some(s => s.picks.some(l => l.player === p.player)));
});

test('a row kill share or rounds took shows no market price, so a book it skipped gets no leg', () => {
  const p = linesFair(pick({ PP: { prob: 0.6 }, UD: { prob: 0.6, mult: 1 } }), {
    PP: { src: 'share', line: 20.5, side: 'OVER', clears: true, sides: { OVER: { prob: 0.6, ev: 6.7 } } },
  }, false);
  assert.ok(bookLeg(p, 'PP'));
  assert.equal(bookLeg(p, 'UD'), null);
});

test('a best slip takes one leg a match; same-match lineups are left to match stacks', () => {
  const a = [pick({ PP: { prob: 0.64 } }), pick({ PP: { prob: 0.63 } }), pick({ PP: { prob: 0.62 } })];
  for (const p of a) p.gameId = 'same';
  const b = [pick({ PP: { prob: 0.6 } }), pick({ PP: { prob: 0.59 } })];
  const pp = autoSlips([...a, ...b]).slips.find(s => s.book === 'PP');
  const games = pp.picks.map(l => l.gameId);
  assert.equal(new Set(games).size, games.length);
  assert.ok(!pp.correlated);
});

test('a model leg keeps its series pricing but hits as often as the fair says', () => {
  const { slipHitsDistribution } = require('../slip');
  const p = pick({ PP: { prob: 0.55 } });
  Object.assign(p.pricing, { meanPerMap: 10, k: 1.2, scenarios: [{ maps: 2, weight: 0.6 }, { maps: 3, weight: 0.4 }] });
  linesFair(p, { PP: { src: 'rounds', line: 20.5, side: 'OVER', clears: true, sides: { OVER: { prob: 0.62, ev: 10 } } } });
  const l = bookLeg(p, 'PP');
  assert.ok(Math.abs(slipHitsDistribution([l])[1] - 0.62) < 0.005);
});
