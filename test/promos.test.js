const test = require('node:test');
const assert = require('node:assert');
const PR = require('../promos');
const P = require('../pickem');
const SP = require('../sportprops');

const FUTURE = new Date(Date.now() + 6 * 3600e3).toISOString();
const PP_BE = SP.FIXED.prizepicks.grade.be;

test('PrizePicks: goblins, demons and promos are kept as promo legs and left off the standard board', () => {
  const data = {
    included: [{ type: 'new_player', id: 'p1', attributes: { display_name: 'Cam Ward', team: 'TEN', league: 'NFL' } }, { type: 'league', id: '9', attributes: { name: 'NFL' } }],
    data: [
      { id: 'a', attributes: { line_score: 220.5, odds_type: 'standard', stat_type: 'Pass Yards', status: 'pre_game', start_time: FUTURE }, relationships: { new_player: { data: { id: 'p1' } }, league: { data: { id: '9' } } } },
      { id: 'b', attributes: { line_score: 180.5, odds_type: 'goblin', stat_type: 'Pass Yards', status: 'pre_game', start_time: FUTURE }, relationships: { new_player: { data: { id: 'p1' } }, league: { data: { id: '9' } } } },
      { id: 'c', attributes: { line_score: 260.5, odds_type: 'demon', stat_type: 'Pass Yards', status: 'pre_game', start_time: FUTURE }, relationships: { new_player: { data: { id: 'p1' } }, league: { data: { id: '9' } } } },
      { id: 'd', attributes: { line_score: 27.5, odds_type: 'standard', is_promo: true, flash_sale_line_score: 0.5, discount_name: 'free_square', discount_percentage: 98, allowed_wager_types: 'over', stat_type: 'Pass Attempts', status: 'pre_game', start_time: FUTURE }, relationships: { new_player: { data: { id: 'p1' } }, league: { data: { id: '9' } } } },
    ],
  };
  const std = P.parsePrizePicksPayload(data).lines;
  assert.deepStrictEqual(std.map(l => l.line), [220.5]);
  const promos = P.parsePrizePicksPromos(data);
  assert.deepStrictEqual(promos.map(l => [l.type, l.side, l.line, l.mult]), [['goblin', 'Over', 180.5, null], ['demon', 'Over', 260.5, null], ['promo', 'Over', 0.5, 1]]);
  const promo = promos.find(l => l.type === 'promo');
  assert.strictEqual(promo.baseLine, 27.5);
  assert.match(promo.note, /free square, 98% off/);
});

test('Sleeper: a non-normal line is a promo leg per side, never a board line', () => {
  const players = { nba: { 7: { first_name: 'Jalen', last_name: 'Brunson', team: 'NYK' } } };
  const row = (line_type) => ({ sport: 'nba', subject_type: 'player', outcome_type: 'over_under', subject_id: '7', wager_type: 'points', status: 'active', game_status: 'pre_game', line_type,
    options: [{ outcome: 'over', outcome_value: 20.5, payout_multiplier: '2.4', status: 'active' }, { outcome: 'under', outcome_value: 20.5, payout_multiplier: '1.5', status: 'active' }] });
  const rows = [row('normal'), row('boosted')];
  assert.strictEqual(P.parseSleeperLines(rows, players, { sports: true }).length, 1);
  const legs = P.parseSleeperPromos(rows, players);
  assert.deepStrictEqual(legs.map(l => [l.type, l.side, l.mult, l.market]), [['boosted', 'Over', 2.4, 'Points'], ['boosted', 'Under', 1.5, 'Points']]);
});

test('Pick6: Gimme Pick, Stat Slice, Power Up and one-sided alt ladders, each with its own multiplier', () => {
  const home = { pickCardsResponse: {
    pickSixMarketById: { 68: { name: 'Points', propositionNameById: { 1: 'More', 2: 'Less' } } },
    entityInfoByDkId: { 5: { fullName: 'Victor Wembanyama' } },
    competitionById: { 9: { name: 'SAS @ DAL', startTime: FUTURE, compId: 9, entityCompByDkId: { 5: { teamId: 1 } } } },
    displayTeamById: { 1: { name: 'SAS' } },
    promotionalPickConfigurationsByPromotionTypeId: { 2: { promotionalPickType: 'Gimme Pick', maxNumberOfPromotionalPicks: 1, minimumRequiredNumOfPicks: 3 } },
    pickCardByPickableId: { 1: { entities: [{ dkId: 5, compIds: [9] }], activePickableMarkets: [
      { promoPickTypeId: 1, pickSixMarketId: 68, targetValue: 24.5, activeSelections: [{ statLinePropositionId: 1, standingsMultiplier: 1 }, { statLinePropositionId: 2, standingsMultiplier: 0.9 }] },
      { promoPickTypeId: 1, pickSixMarketId: 68, targetValue: 19.5, activeSelections: [{ statLinePropositionId: 1, standingsMultiplier: 0.5 }] },
      { promoPickTypeId: 2, pickSixMarketId: 68, targetValue: 10.5, activeSelections: [{ statLinePropositionId: 1, standingsMultiplier: 1 }] },
      { promoPickTypeId: 4, pickSixMarketId: 68, targetValue: 24.5, isPaused: true, activeSelections: [{ statLinePropositionId: 1, standingsMultiplier: 1.5 }] },
    ] } },
  } };
  assert.strictEqual(P.parsePick6Board(home, 'NBA').length, 1);
  const legs = P.parsePick6Promos(home, 'NBA');
  assert.deepStrictEqual(legs.map(l => [l.type, l.side, l.line, l.mult]), [['alt', 'Over', 19.5, 0.5], ['gimme', 'Over', 10.5, 1]]);
  assert.strictEqual(legs[1].note, '1 per entry, 3+ picks');
});

test('required hit rate is each leg at its own payout', () => {
  assert.ok(Math.abs(PR.requiredRate({ book: 'prizepicks', mult: 1, side: 'Over' }) - PP_BE) < 1e-9);
  assert.strictEqual(PR.requiredRate({ book: 'prizepicks', mult: null, side: 'Over' }), null);   // goblin: payout unpublished
  assert.ok(Math.abs(PR.requiredRate({ book: 'sleeper', mult: 2.5, side: 'Over' }) - 0.4) < 1e-9);
  // Underdog boost regime: 56.23% / m; decimal regime: 1 / m
  assert.ok(Math.abs(PR.requiredRate({ book: 'underdog', mult: 1.1, otherMult: 0.9, side: 'Over', line: 5.5 }) - 0.5623 / 1.1) < 1e-6);
  assert.ok(Math.abs(PR.requiredRate({ book: 'underdog', mult: 3, otherMult: null, side: 'Over', line: 5.5 }) - 1 / 3) < 1e-6);
  // Pick6 0.5x alt: needs more than 100%, it can't pay
  const p6 = PR.requiredRate({ book: 'pick6', mult: 0.5, side: 'Over' });
  assert.ok(p6 > 1);
});

test('sharp price: Pinnacle at the exact number first, then the books at it, then the curve within the shift cap', () => {
  const q = [{ book: 'pinnacle', line: 24.5, pOver: 0.5 }, { book: 'fanduel', line: 20.5, pOver: 0.8 }, { book: 'betrivers', line: 20.5, pOver: 0.78 }];
  assert.deepStrictEqual(PR.sharpAt(q, 'points', 'NBA', 24.5), { p: 0.5, books: ['pinnacle'], exact: true, from: 24.5 });
  const books = PR.sharpAt(q, 'points', 'NBA', 20.5);
  assert.strictEqual(books.exact, true);
  assert.deepStrictEqual(books.books, ['fanduel', 'betrivers']);
  assert.ok(Math.abs(books.p - 0.79) < 1e-9);
  const curve = PR.sharpAt(q, 'points', 'NBA', 23.5);
  assert.strictEqual(curve.exact, false);
  assert.deepStrictEqual(curve.books, ['pinnacle']);
  assert.ok(curve.p > 0.5 && curve.p < 0.6);
  // a line far off Pinnacle's (a 0.5 free square vs 24.5): no curve guess
  assert.strictEqual(PR.sharpAt([{ book: 'pinnacle', line: 24.5, pOver: 0.5 }], 'points', 'NBA', 0.5), null);
});

test('buildPromos prices each leg at its payout; a PrizePicks goblin shows the multiplier it would need', () => {
  const row = { key: 'NBA|victorwembanyama|points', sport: 'NBA', player: 'Victor Wembanyama', mkey: 'points', market: 'Points', startTime: FUTURE, books: {} };
  const legs = [
    { book: 'prizepicks', type: 'goblin', side: 'Over', mult: null, line: 24.5, sport: 'NBA', player: 'Victor Wembanyama', market: 'Points', startTime: FUTURE },
    { book: 'sleeper', type: 'boosted', side: 'Over', mult: 2.2, line: 24.5, sport: 'NBA', player: 'Victor Wembanyama', market: 'Points', startTime: '' },
    { book: 'pick6', type: 'gimme', side: 'Over', mult: 1, line: 30.5, sport: 'NBA', player: 'Nobody Here', market: 'Points', startTime: FUTURE },
  ];
  const out = PR.buildPromos(legs, { rowFor: l => (l.player === row.player ? row : null), quotesFor: () => [{ book: 'pinnacle', line: 24.5, pOver: 0.6 }] });
  const sl = out.find(p => p.app === 'sleeper'), gob = out.find(p => p.type === 'goblin'), p6 = out.find(p => p.app === 'pick6');
  assert.strictEqual(sl.fair, 0.6);
  assert.ok(Math.abs(sl.req - 1 / 2.2) < 1e-4);
  assert.ok(Math.abs(sl.ev - (0.6 * 2.2 - 1) * 100) < 0.11);
  assert.strictEqual(sl.kind, 'promo-sl-boosted');
  assert.strictEqual(gob.req, null);
  assert.strictEqual(gob.ev, null);
  assert.ok(Math.abs(gob.beMult - PP_BE / 0.6) < 1e-3);
  assert.strictEqual(p6.fair, null);   // no board row: unpriced, still listed
  assert.strictEqual(out[0], sl);       // known payout with EV first
  const c = PR.promoCounts(out);
  assert.strictEqual(c.total, 3);
  assert.strictEqual(c.priced, 2);
  assert.strictEqual(c.plusEv, 1);
});

test('recordLegs: priced legs only, on a synthetic row holding the promo line in its app cell', () => {
  const row = { key: 'NBA|victorwembanyama|points', sport: 'NBA', player: 'Victor Wembanyama', mkey: 'points', market: 'Points', startTime: FUTURE, books: {} };
  const out = PR.buildPromos([
    { book: 'underdog', type: 'discount', side: 'Over', mult: 1, otherMult: 1, line: 18.5, baseLine: 24.5, sport: 'NBA', player: 'Victor Wembanyama', market: 'Points', startTime: FUTURE },
    { book: 'pick6', type: 'gimme', side: 'Over', mult: 1, line: 30.5, sport: 'NBA', player: 'Nobody', market: 'Points', startTime: FUTURE },
  ], { rowFor: l => (l.player === row.player ? row : null), quotesFor: () => [{ book: 'pinnacle', line: 24.5, pOver: 0.5 }], o: { ...PR.OPTS, maxShiftPts: 40 } });
  const legs = PR.recordLegs(out, { boardRow: k => (k === row.key ? row : null) });
  assert.strictEqual(legs.length, 1);
  assert.strictEqual(legs[0].kind, 'promo-ud-discount');
  assert.strictEqual(legs[0].row.books.underdog.line, 18.5);
  assert.strictEqual(legs[0].row.books.underdog.underOpen, false);
  assert.strictEqual(PR.baseKeyOf(legs[0].row.key), row.key);
  assert.ok(Math.abs(legs[0].play.decimal - 1 / 0.5623) < 1e-3);
});

test('recordSummary: known payouts graded vs their required rate with the 50 bar; goblins only vs the sharp fair', () => {
  const leg = (kind, outcome, dec, fair) => ({ kind, status: 'graded', outcome, signalDecimal: dec, signalFair: fair, signalAt: '2026-10-25T00:00:00Z' });
  const legs = [...Array(30)].map((_, i) => leg('promo-sl-boosted', i % 2 ? 'win' : 'loss', 2.2, 0.5))
    .concat([...Array(10)].map((_, i) => leg('promo-pp-goblin', i < 7 ? 'win' : 'loss', 1.817, 0.7)))
    .concat([{ kind: 'promo-sl-boosted', status: 'open' }]);
  const s = PR.recordSummary(legs);
  const sl = s.slices.find(x => x.kind === 'promo-sl-boosted'), gob = s.slices.find(x => x.kind === 'promo-pp-goblin');
  assert.strictEqual(sl.n, 30);
  assert.strictEqual(sl.open, 1);
  assert.strictEqual(sl.bar, '30 of 50 graded');
  assert.ok(sl.units > 0);
  assert.strictEqual(gob.units, null);
  assert.strictEqual(gob.vs, 'sharp fair');
  assert.ok(Math.abs(gob.be - 0.7) < 1e-9);
});

test('free tier: no fair, EV or needed multiplier', () => {
  const r = PR.redactPromo({ fair: 0.6, ev: 5, beMult: 0.9, fairBooks: ['pinnacle'], req: 0.55 });
  assert.strictEqual(r.fair, null);
  assert.strictEqual(r.ev, null);
  assert.strictEqual(r.beMult, null);
  assert.strictEqual(r.req, 0.55);
});
