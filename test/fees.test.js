const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('../fees');
const C = require('../calc');
const SH = require('../shopper');
const P = require('../oddsproviders');
const X = require('../xsize');
const BM = require('../bigmoney');
const KM = require('../kmaker');
const OR = require('../outrights');
const D = require('../depthfill');
const EX = require('../exchanges');

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} vs ${b}`);

test('every schedule says where it came from and how sure we are', () => {
  for (const [id, s] of Object.entries(F.SCHEDULES)) {
    assert.ok(['verified', 'recorded', 'unverified'].includes(s.status), id);
    assert.ok(s.summary && s.checked, id);
    if (s.kind === 'exchange') assert.ok(s.source, `${id} cites a source`);
  }
  assert.equal(F.SCHEDULES.kalshi.status, 'verified');
  assert.match(F.SCHEDULES.kalshi.source, /kalshi\.com/);
  assert.equal(F.SCHEDULES.gemini.status, 'verified');
  // no page from Polymarket US itself could be read: said so, not invented
  assert.equal(F.SCHEDULES.polymarketus.status, 'unverified');
  // PrizePicks does not publish goblin and demon payouts: said, never priced
  assert.match(F.SCHEDULES.prizepicks.unpublished, /goblin and demon/i);
  assert.equal(F.SCHEDULES.sleeper.status, 'unverified');
  assert.match(F.SCHEDULES.kalshi.maker.freeOn, /NHL spreads and totals/);
  const foot = F.footnote();
  assert.equal(foot.length, Object.keys(F.SCHEDULES).length);
  assert.ok(foot.find(f => f.id === 'prizepicks').breakeven.breakeven > 0.5);
});

test('exchange fees: Kalshi rounds up per order, Polymarket US does not; a contract is priced on 100', () => {
  assert.equal(F.orderFee('kalshi', 0.5, 1), 0.02);           // 1.75c rounds up to 2c on one contract
  assert.equal(F.orderFee('kalshi', 0.5, 100), 1.75);
  close(F.contractFee('kalshi', 0.5), 0.0175);
  close(F.orderFee('polymarketus', 0.5, 1), 0.0695 * 0.25);
  close(F.contractFee('polymarketus', 0.4, { rate: 0.05 }), 0.05 * 0.24);  // the market's own coefficient wins
  assert.equal(F.allInCost('kalshi', 0.47), 0.4875);
  assert.equal(F.orderFee('kalshi', 1.2, 10), 0);
  assert.equal(F.allInCost('kalshi', 0), null);
  // maker: a quarter of the taker rate
  close(F.contractFee('kalshi', 0.5, { maker: true }), 0.0044);
  // the listed price back from a cost
  for (const p of [0.05, 0.31, 0.5, 0.77, 0.95]) close(F.priceFromCost('polymarketus', F.allInCost('polymarketus', p)), p, 1e-4);
});

test('the old copies of the Kalshi formula now read the same module (exchanges, depthfill, calc, kmaker)', () => {
  for (const p of [0.03, 0.12, 0.33, 0.5, 0.61, 0.88, 0.97]) for (const n of [1, 7, 100, 333]) {
    assert.equal(EX.kalshiFee(p, n), F.orderFee('kalshi', p, n));
    assert.equal(D.feeOf(n, p, D.VENUES.kalshi), F.orderFee('kalshi', p, n));
    // the TOOLS calculator keeps its own copy so it works before /fees.js loads: equal
    assert.equal(C.kalshiFee(p, n), F.orderFee('kalshi', p, n));
  }
  close(KM.makerFee(0.5), F.contractFee('kalshi', 0.5, { maker: true }));
  assert.equal(KM.MAKER_RATE, F.SCHEDULES.kalshi.maker.rate);
  assert.equal(D.VENUES.polymarketus.rate, F.SCHEDULES.polymarketus.taker.rate);
});

test('after fees: exchange cost, book implied, pick\'em break-even, unknown commission left raw', () => {
  const k = F.afterFee({ venue: 'kalshi', price: 0.5 });
  assert.equal(k.implied, 0.5175);
  assert.equal(k.fee, 0.0175);
  // a screen's price that already has the fee in: implied is the cost, fee backed out
  const k2 = F.afterFee({ venue: 'kalshi', decimal: 1 / 0.5175 });
  assert.equal(k2.implied, 0.5175);
  close(k2.listed, 0.5, 1e-4);
  const fd = F.afterFee({ venue: 'fanduel', decimal: 1.909 });
  assert.equal(fd.implied, 0.5238);
  assert.equal(fd.fee, 0);
  const mb = F.afterFee({ venue: 'matchbook', decimal: 2.1 });
  assert.equal(mb.implied, null);
  assert.equal(mb.raw, 0.4762);
  // PrizePicks 3-pick Power pays 6x: break-even per leg is 6^(-1/3)
  const pp = F.afterFee({ venue: 'prizepicks' });
  close(pp.breakeven, 6 ** (-1 / 3), 1e-4);
  assert.match(pp.basis, /Power 3-pick/);
  close(F.legBreakeven('pick6', { n: 5 }).breakeven, C.pickemSlip('pick6', 5).breakeven, 1e-9);
  close(F.afterFee({ venue: 'sleeper' }).breakeven, 1 / 1.78, 1e-4);
  assert.ok(F.pickemTable('underdog').length >= 9);
});

// ── the screen and the record agree ──
// The Exchange Shopper's "above fair" EV on a Kalshi price and the CLV an
// exchange record stores for a bet at that price, closed at the same fair,
// must be the same number: both are fees.edge(fair, the all-in cost).
const START = '2026-10-25T17:00:00.000Z';
const NOW = Date.parse(START) - 3 * 3600e3;
const HOME = 'New Orleans Saints', AWAY = 'Pittsburgh Steelers';
function shopperEv(noAsk, pinHome, pinAway) {
  const cost = BM.exchangeCost({ exchange: 'kalshi' }, noAsk);
  // as bigmoney.gameIndex hands Kalshi's price to the shopper
  const bets = new Map([['1|ml|away', { key: '1|ml|away', league: 'nfl', game: { id: '1', home: HOME, away: AWAY, start: START },
    venues: [{ venue: 'kalshi', implied: cost, decimal: Math.round(1e4 / cost) / 1e4, price: noAsk, marketId: 'KX', side: 'no' }] }]]);
  const game = { id: 'pin-1', sport_key: 'nfl', commence_time: START, home_team: HOME, away_team: AWAY,
    bookmakers: [{ key: 'pinnacle', markets: [{ key: 'h2h', outcomes: [{ name: HOME, price: pinHome }, { name: AWAY, price: pinAway }] }] }] };
  const read = new Date(NOW - 30e3).toISOString();
  const quotes = [...P.fromFreeGames({ nfl: [game] }, { readAt: read }).quotes, ...P.fromKalshiBets(bets, { readAt: read }).quotes];
  const v = SH.build(quotes, { now: NOW });
  const away = v.markets.find(m => m.marketType === 'moneyline').sides.find(s => s.side === 'away');
  const cell = away.prices.find(p => p.provider === 'kalshi');
  return { fair: away.fair, cost, ev: cell.ev, implied: cell.implied };
}
test('Exchange Shopper above-fair EV equals the record\'s CLV at the same fair (Kalshi)', () => {
  let n = 0;
  for (const noAsk of [0.31, 0.38, 0.42, 0.47, 0.55]) for (const [ph, pa] of [[-150, 135], [-120, 105], [110, -125]]) {
    const s = shopperEv(noAsk, ph, pa);
    assert.ok(s.fair > 0 && s.fair < 1 && s.ev != null);
    // the screen shows the all-in cost as its after-fee implied chance
    assert.equal(s.implied, F.allInCost('kalshi', noAsk));
    assert.equal(s.cost, F.allInCost('kalshi', noAsk));
    const want = F.edge(s.fair, s.cost);
    assert.equal(s.ev, want);
    // the size record's flag EV (xsize.sidesOf: Kalshi row, Pinnacle fair the same)
    const pg = { id: 1, home: HOME, away: AWAY, start: START, ml: { home: 1 - s.fair, away: s.fair, limit: 5000 }, spreads: [], totals: [] };
    const krow = { exchange: 'kalshi', id: 'KXNFLGAME-26OCT25PITNO-NO', gameKey: 'NFL-PITNO', eventKey: 'kalshi:KXNFLGAME-26OCT25PITNO', kind: 'teams',
      outcomeLabel: 'New Orleans', noLabel: 'Pittsburgh', yesAsk: 0.99 - noAsk, noAsk, startTime: START, tradable: true };
    const side = X.sidesOf({ games: { nfl: [{ id: 'pin-1', home_team: HOME, away_team: AWAY, commence_time: START, bookmakers: [] }] }, pinGames: [pg], kalshiRows: [krow] }).find(x => x.market === 'h2h' && x.side === AWAY);
    assert.equal(side.cost, s.cost);
    assert.equal(side.ev, s.ev);
    // a closed bid or flag at that cost, closed at that fair: the CLV the record stores
    assert.equal(KM.grade({ closeFair: s.fair, cost: s.cost }).clv, s.ev);
    assert.equal(OR.grade({ closeFair: s.fair, cost: s.cost }).clv, s.ev);
    n++;
  }
  assert.equal(n, 15);
});

test('pick\'em multipliers: Sleeper pays the pick, Underdog and Pick6 scale the slip', () => {
  close(F.legBreakeven('sleeper', { multiplier: 2 }).breakeven, 0.5, 1e-9);
  const std = F.legBreakeven('underdog').breakeven;
  close(F.legBreakeven('underdog', { multiplier: 1.1 }).breakeven, Math.round(std / 1.1 * 1e4) / 1e4, 1e-9);
  assert.equal(F.legBreakeven('underdog', { multiplier: 1 }).breakeven, std);
  // check the scaling on a real slip: a 3-pick Pick6 with one leg at 0.9x breaks even
  // exactly when that leg hits at q / 0.9 and the others at q
  const q = F.legBreakeven('pick6').breakeven, p = F.legBreakeven('pick6', { multiplier: 0.9 }).breakeven;
  close(p * q * q * 6 * 0.9, 1, 1e-3);
});

test('TOOLS exchange calculator charges each venue the fees.js schedule', () => {
  for (const p of [0.07, 0.45, 0.55, 0.91]) for (const n of [1, 10, 100]) {
    close(C.exchangeBuy(p, n, 'kalshi').fee, F.orderFee('kalshi', p, n));
    close(C.exchangeBuy(p, n, 'gemini').fee, F.orderFee('gemini', p, n));
    close(C.exchangeBuy(p, n, 'kalshi_maker').fee, F.orderFee('kalshi', p, n, { maker: true }));
    close(C.exchangeBuy(p, n, 'polymarketus').fee, F.orderFee('polymarketus', p, n), 1e-12);
    // per contract on 100: the all-in cost the screens show
    if (n === 100) close(C.exchangeBuy(p, n, 'kalshi').perContract, F.allInCost('kalshi', p), 1e-9);
  }
});
