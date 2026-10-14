const test = require('node:test');
const assert = require('node:assert');
const pin = require('../pingames');

const NOW = Date.parse('2026-10-14T12:00:00Z');
const matchups = [
  { id: 1, type: 'matchup', parentId: null, startTime: '2026-10-14T23:05:00Z', league: { name: 'MLB' },
    participants: [{ alignment: 'home', name: 'New York Yankees' }, { alignment: 'away', name: 'Boston Red Sox' }] },
  { id: 2, type: 'matchup', parentId: null, startTime: '2026-10-14T19:00:00Z', league: { name: 'England - Premier League' },
    participants: [{ alignment: 'home', name: 'Arsenal' }, { alignment: 'away', name: 'Chelsea' }] },
  { id: 3, type: 'matchup', parentId: 1, startTime: '2026-10-14T23:05:00Z', participants: [{ alignment: 'home', name: 'x' }, { alignment: 'away', name: 'y' }] },
  { id: 4, type: 'matchup', parentId: null, startTime: '2026-10-14T11:00:00Z', participants: [{ alignment: 'home', name: 'Old' }, { alignment: 'away', name: 'Game' }] },
];
const markets = [
  { matchupId: 1, period: 0, type: 'moneyline', status: 'open', prices: [{ designation: 'home', price: -150 }, { designation: 'away', price: 138 }], limits: [{ type: 'maxRiskStake', amount: 5000 }] },
  { matchupId: 1, period: 0, type: 'total', status: 'open', prices: [{ designation: 'over', price: -105, points: 8.5 }, { designation: 'under', price: -105, points: 8.5 }] },
  { matchupId: 1, period: 0, type: 'spread', status: 'open', isAlternate: false, prices: [{ designation: 'home', price: 120, points: -1.5 }, { designation: 'away', price: -130, points: 1.5 }] },
  { matchupId: 1, period: 1, type: 'moneyline', status: 'open', prices: [{ designation: 'home', price: -200 }, { designation: 'away', price: 170 }] },
  { matchupId: 2, period: 0, type: 'moneyline', status: 'open', prices: [{ designation: 'home', price: 110 }, { designation: 'away', price: 260 }, { designation: 'draw', price: 250 }] },
  { matchupId: 4, period: 0, type: 'moneyline', status: 'open', prices: [{ designation: 'home', price: 110 }, { designation: 'away', price: -120 }] },
];

test('devig: two and three ways sum to 1, favourite keeps more', () => {
  const f = pin.devig([-150, 138]);
  assert.ok(Math.abs(f[0] + f[1] - 1) < 1e-6);
  assert.ok(f[0] > 0.58 && f[0] < 0.6);
  const g = pin.devig([110, 260, 250]);
  assert.ok(Math.abs(g.reduce((a, b) => a + b) - 1) < 1e-6);
  assert.equal(pin.devig([-110]), null);
});

test('parseGames: pregame full-game lines only', () => {
  const games = pin.parseGames('baseball', matchups, markets, NOW);
  assert.deepEqual(games.map(g => g.id), [1, 2]);
  const g = games[0];
  assert.ok(g.ml.home > 0.58 && g.ml.limit === 5000);
  assert.deepEqual(g.totals.map(t => [t.line, t.pOver]), [[8.5, 0.5]]);
  assert.equal(g.spreads[0].home, -1.5);
  assert.ok(games[1].ml.draw > 0.2);
});

test('matchRows: Kalshi team, total and spread rows; Polymarket US rows', () => {
  const games = pin.parseGames('baseball', matchups, markets, NOW);
  const base = { exchange: 'kalshi', gameKey: 'KXMLB|26OCT14BOSNYY', eventKey: 'kalshi:KXMLBGAME-26OCT14BOSNYY', tradable: true, startTime: null, gameDay: null, expectedExpiration: '2026-10-15T02:30:00Z' };
  const rows = [
    { ...base, id: 'A', kind: 'teams', outcomeLabel: 'New York Y', noLabel: 'Boston' },
    { ...base, id: 'B', kind: 'teams', outcomeLabel: 'Boston', noLabel: 'New York Y' },
    { ...base, id: 'C', kind: 'total', line: 8.5, eventKey: 'kalshi:KXMLBTOTAL-26OCT14BOSNYY' },
    { ...base, id: 'D', kind: 'spread', line: 1.5, lineTeam: 'New York Y' },
    { ...base, id: 'E', kind: 'spread', line: 1.5, lineTeam: 'Boston' },   // Pinnacle has no Boston −1.5
    { exchange: 'polymarketus', eventKey: 'polymarketus:epl-ars-che', id: 'P1', kind: 'yesno', outcomeLabel: 'Arsenal', game3: { teams: ['Arsenal', 'Chelsea'], pick: 0 }, startTime: '2026-10-14T19:00:00Z' },
    { exchange: 'polymarketus', eventKey: 'polymarketus:epl-ars-che', id: 'P2', kind: 'yesno', outcomeLabel: 'Draw', game3: { teams: ['Arsenal', 'Chelsea'], pick: 'draw' }, startTime: '2026-10-14T19:00:00Z' },
  ];
  const m = Object.fromEntries(pin.matchRows(rows, games).map(x => [x.row.id, x]));
  assert.ok(m.A.pYes > 0.58);
  assert.ok(Math.abs(m.A.pYes + m.B.pYes - 1) < 1e-3);
  assert.equal(m.C.pYes, 0.5);
  assert.ok(m.D.pYes > 0.4 && m.D.pYes < 0.46);
  assert.equal(m.E, undefined);
  assert.equal(m.P1.kind, 'moneyline3');
  assert.ok(m.P2.pYes > 0.25);
});

test('matchRows: a team contract with no draw does not pair with a three-way price', () => {
  const games = pin.parseGames('soccer', matchups, markets, NOW);
  const rows = [{ exchange: 'polymarketus', eventKey: 'polymarketus:x', id: 'Z', kind: 'teams', outcomeLabel: 'Arsenal', noLabel: 'Chelsea', startTime: '2026-10-14T19:00:00Z' }];
  assert.equal(pin.matchRows(rows, games).length, 0);
});
