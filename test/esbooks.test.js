const test = require('node:test');
const assert = require('node:assert/strict');
const es = require('../esbooks');

const NOW = Date.parse('2026-10-14T19:30:00Z');
// Pinnacle lists Karmine Corp at home; BetRivers lists Cloud9 first, 5 hours off
const pinMatchups = [
  { id: 1, type: 'matchup', units: 'Regular', league: { name: 'League of Legends - World Championship Play-In' }, startTime: '2026-10-15T23:00:00Z',
    participants: [{ alignment: 'home', name: 'Karmine Corp' }, { alignment: 'away', name: 'Cloud9' }] },
  { id: 2, type: 'matchup', parentId: 1, units: 'Kills', league: { name: 'League of Legends - World Championship Play-In' }, startTime: '2026-10-15T23:00:00Z',
    participants: [{ alignment: 'home', name: 'Karmine Corp (Kills)' }, { alignment: 'away', name: 'Cloud9 (Kills)' }] },
];
const mk = (matchupId, period, type, prices, extra = {}) => ({ matchupId, period, type, status: 'open', limits: [{ amount: extra.limit ?? 1250 }], prices, ...extra });
const pinMarkets = [
  mk(1, 0, 'moneyline', [{ designation: 'home', price: -200 }, { designation: 'away', price: 170 }]),
  mk(1, 0, 'spread', [{ designation: 'home', points: -1.5, price: 105 }, { designation: 'away', points: 1.5, price: -125 }]),
  mk(1, 1, 'moneyline', [{ designation: 'home', price: -150 }, { designation: 'away', price: 130 }], { limit: 625 }),
  mk(2, 1, 'total', [{ designation: 'over', points: 28.5, price: -110 }, { designation: 'under', points: 28.5, price: -110 }], { limit: 300 }),
  mk(2, 1, 'total', [{ designation: 'over', points: 30.5, price: 140 }, { designation: 'under', points: 30.5, price: -160 }], { limit: 300 }),
  mk(2, 1, 'spread', [{ designation: 'home', points: -4.5, price: -105 }, { designation: 'away', points: 4.5, price: -115 }], { limit: 475 }),
  mk(2, 1, 'team_total', [{ designation: 'over', points: 15.5, price: -110 }, { designation: 'under', points: 15.5, price: -110 }], { side: 'away', limit: 300 }),
  mk(2, 1, 'moneyline', [{ designation: 'home', price: -150 }, { designation: 'away', price: 130 }]),   // most kills: not a BetRivers line
  mk(1, 26, 'moneyline', [{ designation: 'home', price: -150 }, { designation: 'away', price: 130 }]),  // a special, skipped
];
const oc = (type, odds, line) => ({ type, oddsAmerican: String(odds), status: 'OPEN', ...(line != null ? { line } : {}) });
const bo = (label, outcomes) => ({ criterion: { englishLabel: label }, outcomes });
const kambi = {
  events: [{ id: 99, englishName: 'Cloud9 - Karmine Corp', start: '2026-10-15T18:00:00Z', state: 'NOT_STARTED', path: [{ englishName: 'Esports' }, { englishName: 'League of Legends' }, { englishName: 'World Championship' }] }],
  betOffers: [
    bo('Match Odds', [oc('OT_ONE', 200), oc('OT_TWO', -275)]),
    bo('Map Handicap', [oc('OT_ONE', -110, 1500), oc('OT_TWO', -120, -1500)]),
    bo('Map 1', [oc('OT_ONE', 123), oc('OT_TWO', -175)]),
    bo('Map 1 - Total Kills', [oc('OT_OVER', -103, 29500), oc('OT_UNDER', -137, 29500)]),
    bo('Map 1 - Total Kills', [oc('OT_OVER', 116, 34500), oc('OT_UNDER', -162, 34500)]),
    bo('Map 1 - Team Kills Handicap', [oc('OT_ONE', 120, 4500), oc('OT_TWO', -160, -4500)]),
    bo('Map 1 - Team Kills Handicap', [oc('OT_ONE', 200, -2500), oc('OT_TWO', -300, 2500)]),
    bo('Map 1 - Total Kills by Cloud9', [oc('OT_OVER', 110, 15500), oc('OT_UNDER', -150, 15500)]),
    bo('Map 1 - Total Kills by the Player', [oc('OT_OVER', 110, 4500), oc('OT_UNDER', -150, 4500)]),
    bo('Map 1 - First Blood', [oc('OT_ONE', -110), oc('OT_TWO', -110)]),
  ],
};

test('parsePinnacle: main and kill ladders, specials and most-kills skipped', () => {
  const [m] = es.parsePinnacle(pinMatchups, pinMarkets);
  assert.deepEqual(m.teams, ['Karmine Corp', 'Cloud9']);
  assert.equal(m.game, 'LOL');
  assert.deepEqual([...m.ladders.keys()].sort(), ['kills|1|spread', 'kills|1|total', 'kills|1|tt|1', 'map|1|ml', 'series|0|ml', 'series|0|spread']);
  assert.deepEqual(m.ladders.get('kills|1|total').map(q => q.x).sort((a, b) => a - b), [-30.5, -28.5]);
  assert.ok(Math.abs(m.ladders.get('kills|1|total').find(q => q.x === -28.5).p - 0.5) < 1e-9);
});

test('parseKambiEsports: the lines it prices, keyed by its own team order', () => {
  const g = es.parseKambiEsports(kambi, NOW);
  assert.equal(g.game, 'LOL');
  assert.deepEqual(g.teams, ['Cloud9', 'Karmine Corp']);
  const keys = g.lines.map(l => `${l.key}@${l.x}`).sort();
  assert.deepEqual(keys, ['kills|1|spread@-2.5', 'kills|1|spread@4.5', 'kills|1|total@-29.5', 'kills|1|total@-34.5', 'kills|1|tt|0@-15.5', 'map|1|ml@0', 'series|0|ml@0', 'series|0|spread@1.5']);
  assert.equal(es.parseKambiEsports({ ...kambi, events: [{ ...kambi.events[0], state: 'STARTED' }] }, NOW), null);
});

test('screen: flips Pinnacle to the book, reads only between its lines, and needs Kalshi to clear', () => {
  const books = [es.parseKambiEsports(kambi, NOW)];
  const pin = es.parsePinnacle(pinMatchups, pinMarkets);
  const fairs = new Map(), costs = new Map();
  const { rows, matched } = es.screen({ books, pin, now: NOW, fairs, costs, o: { minEv: -100, maxEv: 100 } });
  assert.equal(matched.length, 1);
  const at = (market, side) => rows.find(r => r.marketLabel === market && r.side === side);
  // Pinnacle's start, not Kambi's
  assert.equal(at('Match', 'Cloud9').start, '2026-10-15T23:00:00.000Z');
  // Cloud9 is Pinnacle's away team: its no-vig match price is 1 − KC's
  const kc = es.parsePinnacle(pinMatchups, pinMarkets)[0].ladders.get('series|0|ml')[0].p;
  assert.ok(Math.abs(at('Match', 'Cloud9').fairProb - Math.round((1 - kc) * 1e4) / 100) < 0.011);
  // Cloud9 +1.5 maps is KC −1.5's other side
  assert.ok(at('Map handicap', 'Cloud9 +1.5').fairProb > 50);
  // 29.5 sits between Pinnacle's 28.5 and 30.5: priced, not exact
  const u = at('Map 1 total kills', 'Under 29.5');
  assert.ok(u && u.sources[0].exact === false && u.fairProb > 50 && u.fairProb < 62);
  // 34.5 is past Pinnacle's last line: not priced at all
  assert.equal(rows.find(r => r.marketLabel === 'Map 1 total kills' && r.point === 34.5), undefined);
  // Cloud9 +4.5 kills is Pinnacle's KC −4.5 seen from the away side, exact
  const c9 = at('Map 1 kill handicap', 'Cloud9 +4.5');
  assert.ok(c9.sources[0].exact && c9.pinLimit === 475);
  // the team total follows Cloud9 across the flip (Pinnacle's away side)
  assert.ok(at('Map 1 team kills', 'Cloud9 Over 15.5').sources[0].exact);
  // nothing clears on Pinnacle alone, and every side is in fairs and costs
  assert.equal(rows.filter(r => r.clears).length, 0);
  assert.ok(rows.every(r => r.source === 'esbook-single' && fairs.has(`${r.group}|${r.side}`) && costs.has(`${r.group}|${r.side}|betrivers`)));
});

test('screen: a match line clears when Pinnacle and Kalshi agree and BetRivers beats them', () => {
  const books = [es.parseKambiEsports(kambi, NOW)];
  const pin = es.parsePinnacle(pinMatchups, pinMarkets);
  // Kalshi's board lists Cloud9 first; its mid sits by Pinnacle's
  const p = 1 - pin[0].ladders.get('series|0|ml')[0].p;
  const board = [{ game: 'LOL', teams: ['Cloud9', 'Karmine Corp'], start: '2026-10-15T23:00:00Z', markets: [
    { key: 'match', kind: 'match', outcomes: [{ name: 'Cloud9', quotes: { kalshi: { bid: p - 0.01, ask: p + 0.01 } } }, { name: 'Karmine Corp', quotes: {} }] },
    { key: 'spread:1:1.5', kind: 'spread', team: 1, line: -1.5, outcomes: [{ name: 'Karmine Corp -1.5', quotes: { kalshi: { bid: 0.2, ask: 0.5 } } }, { name: 'x', quotes: {} }] },
  ] }];
  const kalshi = es.kalshiLadders(board);
  assert.deepEqual([...kalshi[0].ladders.keys()], ['series|0|ml']);   // the 30¢-wide spread is left out
  const { rows } = es.screen({ books, pin, kalshi, now: NOW });
  const c9 = rows.find(r => r.marketLabel === 'Match' && r.side === 'Cloud9');
  assert.ok(c9, 'Cloud9 +200 beats a ~36% fair');
  assert.equal(c9.clears, true);
  assert.equal(c9.source, 'esbook');
  assert.deepEqual(c9.sharpBooks, ['pinnacle', 'kalshi']);
  // Kalshi far off Pinnacle: shown, not cleared
  const far = es.kalshiLadders([{ ...board[0], markets: [{ ...board[0].markets[0], outcomes: [{ name: 'Cloud9', quotes: { kalshi: { bid: p + 0.09, ask: p + 0.11 } } }, { name: 'Karmine Corp', quotes: {} }] }] }]);
  const r2 = es.screen({ books, pin, kalshi: far, now: NOW }).rows.find(r => r.marketLabel === 'Match' && r.side === 'Cloud9');
  assert.equal(r2.clears, false);
  assert.equal(r2.agree, false);
});
