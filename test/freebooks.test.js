const test = require('node:test');
const assert = require('node:assert');
const fb = require('../freebooks');
const ev = require('../ev');

const NOW = Date.parse('2026-10-14T12:00:00Z');
const runner = (type, name, odds, handicap = 0) => ({ result: { type }, runnerName: name, runnerStatus: 'ACTIVE', handicap, winRunnerOdds: { americanDisplayOdds: { americanOddsInt: odds } } });
const fdPage = {
  attachments: {
    events: { 1: { eventId: 1, name: 'Milwaukee Brewers (R Gasser) @ Los Angeles Dodgers (B Snell)', openDate: '2026-10-15T00:00:00.000Z' },
      2: { eventId: 2, name: 'Old @ Game', openDate: '2026-10-14T10:00:00.000Z' } },
    markets: {
      a: { eventId: 1, marketType: 'MONEY_LINE', marketStatus: 'OPEN', inPlay: false, runners: [runner('AWAY', 'Brewers', 150), runner('HOME', 'Dodgers', -178)] },
      b: { eventId: 1, marketType: 'MATCH_HANDICAP_(2-WAY)', marketStatus: 'OPEN', runners: [runner('AWAY', 'Brewers', -150, 1.5), runner('HOME', 'Dodgers', 125, -1.5)] },
      c: { eventId: 1, marketType: 'TOTAL_POINTS_(OVER/UNDER)', marketStatus: 'OPEN', runners: [runner('OVER', 'Over', -104, 7.5), runner('UNDER', 'Under', -118, 7.5)] },
      d: { eventId: 1, marketType: 'TO_HIT_A_HOME_RUN', marketStatus: 'OPEN', runners: [runner('X', 'x', 300)] },
      e: { eventId: 2, marketType: 'MONEY_LINE', marketStatus: 'OPEN', runners: [runner('AWAY', 'Old', 100), runner('HOME', 'Game', -120)] },
    },
  },
};
const kbEvent = {
  events: [{ id: 9, englishName: 'Los Angeles Dodgers - Milwaukee Brewers', start: '2026-10-15T00:05:00Z', state: 'NOT_STARTED' }],
  betOffers: [
    { criterion: { englishLabel: 'Moneyline - Including Extra Innings' }, outcomes: [{ type: 'OT_ONE', oddsAmerican: '-170', status: 'OPEN' }, { type: 'OT_TWO', oddsAmerican: '160', status: 'OPEN' }] },
    { criterion: { englishLabel: 'Run Line - Including Extra Innings' }, outcomes: [{ type: 'OT_ONE', line: -1500, oddsAmerican: '130', status: 'OPEN' }, { type: 'OT_TWO', line: 1500, oddsAmerican: '-155', status: 'OPEN' }] },
    { criterion: { englishLabel: 'Total Runs - Including Extra Innings' }, outcomes: [{ type: 'OT_OVER', line: 7500, oddsAmerican: '-110', status: 'OPEN' }, { type: 'OT_UNDER', line: 7500, oddsAmerican: '-110', status: 'OPEN' }] },
    { criterion: { englishLabel: 'Total Runs - Inning 1' }, outcomes: [{ type: 'OT_OVER', line: 500, oddsAmerican: '120', status: 'OPEN' }, { type: 'OT_UNDER', line: 500, oddsAmerican: '-150', status: 'OPEN' }] },
  ],
};
const pinGame = { id: 77, sport: 'baseball', league: 'MLB', home: 'Los Angeles Dodgers', away: 'Milwaukee Brewers', start: '2026-10-15T00:00:00.000Z',
  ml: { home: 0.6, away: 0.4, raw: [-155, 140] }, spreads: [{ home: -1.5, pHome: 0.42, raw: [135, -150] }], totals: [{ line: 7.5, pOver: 0.49, raw: [-105, -105] }] };

test('parseFanDuel: full-game lines of games not started, pitchers out of the names', () => {
  const g = fb.parseFanDuel(fdPage, NOW);
  assert.equal(g.length, 1);
  assert.deepEqual([g[0].home, g[0].away], ['Los Angeles Dodgers', 'Milwaukee Brewers']);
  assert.deepEqual(g[0].h2h, [{ name: 'Milwaukee Brewers', price: 150 }, { name: 'Los Angeles Dodgers', price: -178 }]);
  assert.deepEqual(g[0].spreads.map(o => o.point), [1.5, -1.5]);
  assert.deepEqual(g[0].totals.map(o => [o.name, o.point]), [['Over', 7.5], ['Under', 7.5]]);
});

test('parseKambiEvent: home first, lines in thousandths, periods left out', () => {
  const g = fb.parseKambiEvent(kbEvent, NOW);
  assert.equal(g.home, 'Los Angeles Dodgers');
  assert.deepEqual(g.h2h, [{ name: 'Los Angeles Dodgers', price: -170 }, { name: 'Milwaukee Brewers', price: 160 }]);
  assert.deepEqual(g.spreads, [{ name: 'Los Angeles Dodgers', price: 130, point: -1.5 }, { name: 'Milwaukee Brewers', price: -155, point: 1.5 }]);
  assert.equal(g.totals.length, 2);
  assert.equal(fb.parseKambiEvent({ ...kbEvent, events: [{ ...kbEvent.events[0], state: 'STARTED' }] }, NOW), null);
});

test('mergeGames + ev.screen: the books score against Pinnacle in one market', () => {
  const games = fb.mergeGames('mlb', [pinGame], [...fb.parseFanDuel(fdPage, NOW), fb.parseKambiEvent(kbEvent, NOW)]);
  assert.deepEqual(games[0].bookmakers.map(b => b.key), ['pinnacle', 'fanduel', 'betrivers']);
  const rows = ev.screen({ feeds: [{ sport: 'mlb', games }], now: NOW, minEv: -100 });
  const fd = rows.find(r => r.book === 'fanduel' && r.market === 'h2h' && r.side === 'Milwaukee Brewers');
  assert.equal(fd.source, 'sharp');
  assert.deepEqual(fd.sharpBooks, ['pinnacle']);
  assert.ok(fd.ev > 0);   // +150 against Pinnacle's +140 / -155 with the vig out
  const br = rows.find(r => r.book === 'betrivers' && r.market === 'spreads' && /Dodgers/.test(r.side));
  assert.ok(br && br.ev < 0);
});

test('bookmakerFor: a game whose teams do not both land is left out', () => {
  assert.equal(fb.bookmakerFor({ book: 'fanduel', home: 'New York Yankees', away: 'Boston Red Sox', h2h: [{ name: 'x', price: 100 }], spreads: [], totals: [] }, pinGame), null);
});

test('player props: FanDuel and Kambi parse, Pinnacle joins, ev.screen prices them', () => {
  const hr = (type, name, odds, handicap) => ({ ...runner(type, name, odds, handicap), runnerStatus: 'ACTIVE' });
  const fdEv = { attachments: { markets: {
    p: { bettingType: 'MOVING_HANDICAP', marketStatus: 'OPEN', marketName: 'Shohei Ohtani - Total Bases', runners: [hr('OVER', 'Shohei Ohtani Over', 120, 1.5), hr('UNDER', 'Shohei Ohtani Under', -150, 1.5)] },
    q: { bettingType: 'MOVING_HANDICAP', marketStatus: 'OPEN', marketName: 'Shohei Ohtani - 1st Inning Hits', runners: [hr('OVER', 'Shohei Ohtani Over', 300, 0.5), hr('UNDER', 'Shohei Ohtani Under', -500, 0.5)] },
    r: { bettingType: 'MOVING_HANDICAP', marketStatus: 'OPEN', marketName: 'Freddy Peralta - Total Receptions', runners: [hr('OVER', 'Freddy Peralta Over', -110, 3.5), hr('UNDER', 'Freddy Peralta Under', -110, 3.5)] },
  } } };
  const fd = fb.parseFanDuelProps(fdEv);
  assert.deepEqual(fd.map(p => [p.player, p.mkey, p.line]), [['Shohei Ohtani', 'total_bases', 1.5], ['Freddy Peralta', 'receptions', 3.5]]);
  const kb = fb.kambiProps({ betOffers: [
    { criterion: { englishLabel: 'Total Bases by the Player - Including Extra Innings' }, outcomes: [
      { type: 'OT_OVER', participant: 'Ohtani, Shohei', line: 1500, oddsAmerican: '105', status: 'OPEN' },
      { type: 'OT_UNDER', participant: 'Ohtani, Shohei', line: 1500, oddsAmerican: '-135', status: 'OPEN' }] },
    { criterion: { englishLabel: 'Total Hits by the Player - Inning 1' }, outcomes: [
      { type: 'OT_OVER', participant: 'Ohtani, Shohei', line: 500, oddsAmerican: '300', status: 'OPEN' },
      { type: 'OT_UNDER', participant: 'Ohtani, Shohei', line: 500, oddsAmerican: '-500', status: 'OPEN' }] },
  ] });
  assert.deepEqual(kb, [{ player: 'Shohei Ohtani', mkey: 'total_bases', line: 1.5, over: 105, under: -135 }]);
  const fdGame = { ...fb.parseFanDuel(fdPage, NOW)[0], props: fd };
  const kbGame = { ...fb.parseKambiEvent(kbEvent, NOW), props: kb };
  const pinProps = [
    { sport: 'MLB', player: 'Shohei Ohtani', mkey: 'total_bases', line: 1.5, over: 110, under: -130, start: '2026-10-15T00:00:00.000Z' },
    { sport: 'MLB', player: 'Shohei Ohtani', mkey: 'total_bases', line: 1.5, over: 110, under: -130, start: '2026-10-18T00:00:00.000Z' },   // another game
    { sport: 'MLB', player: 'Aaron Judge', mkey: 'total_bases', line: 1.5, over: 110, under: -130, start: '2026-10-15T00:00:00.000Z' },     // no book prices him
  ];
  const games = fb.mergeGames('mlb', [pinGame], [fdGame, kbGame], { pinProps });
  const pinTb = games[0].bookmakers[0].markets.find(m => m.key === 'total_bases');
  assert.equal(pinTb.outcomes.length, 2);
  const rows = ev.screen({ feeds: [{ sport: 'mlb', games }], now: NOW, minEv: -100 });
  const over = rows.find(r => r.book === 'fanduel' && r.player === 'Shohei Ohtani' && r.side === 'Over');
  assert.equal(over.source, 'sharp');
  assert.ok(over.ev > 0);   // +120 against Pinnacle's +110 / -130
  assert.ok(rows.find(r => r.book === 'betrivers' && r.player === 'Shohei Ohtani' && r.side === 'Over').ev < 0);
  assert.ok(!rows.some(r => r.player === 'Freddy Peralta'));   // no Pinnacle price, no fair
});

test('FanDuel two-way ODDS props (line in the runner) and Kambi NHL shots and assists Yes/No', () => {
  const fb = require('../freebooks');
  const fd = { attachments: { markets: {
    a: { bettingType: 'ODDS', marketStatus: 'OPEN', marketName: 'Blake Snell Outs Recorded', runners: [
      { runnerName: 'Blake Snell Over 14.5', runnerStatus: 'ACTIVE', winRunnerOdds: { americanDisplayOdds: { americanOdds: -172 } } },
      { runnerName: 'Blake Snell Under 14.5', runnerStatus: 'ACTIVE', winRunnerOdds: { americanDisplayOdds: { americanOdds: 126 } } }] },
    b: { bettingType: 'ODDS', marketStatus: 'OPEN', marketName: '1+ Points', runners: [
      { runnerName: 'Nick Suzuki', runnerStatus: 'ACTIVE', winRunnerOdds: { americanDisplayOdds: { americanOdds: -250 } } },
      { runnerName: 'Lane Hutson', runnerStatus: 'ACTIVE', winRunnerOdds: { americanDisplayOdds: { americanOdds: -240 } } }] },
  } } };
  assert.deepEqual(fb.parseFanDuelProps(fd), [{ player: 'Blake Snell', mkey: 'pitcher_outs', line: 14.5, over: -172, under: 126 }]);
  const kb = { betOffers: [
    { criterion: { englishLabel: "Player's shots on goal - Including Overtime" }, outcomes: [
      { type: 'OT_OVER', status: 'OPEN', participant: 'Kyrou, Jordan', line: 1500, oddsAmerican: '-157' },
      { type: 'OT_UNDER', status: 'OPEN', participant: 'Kyrou, Jordan', line: 1500, oddsAmerican: '120' }] },
    { criterion: { englishLabel: 'Player to record at least 1 assists - Including Overtime' }, outcomes: [
      { type: 'OT_YES', status: 'OPEN', participant: 'Dylan Strome', line: 1000, oddsAmerican: '110' },
      { type: 'OT_NO', status: 'OPEN', participant: 'Dylan Strome', line: 1000, oddsAmerican: '-159' }] },
    { criterion: { englishLabel: 'Player to score at least 1 points - Including Overtime' }, outcomes: [
      { type: 'OT_YES', status: 'OPEN', participant: 'Dylan Strome', line: 1000, oddsAmerican: '-152' }] },
    { criterion: { englishLabel: 'Player To score at least 1 Power Play Points -  Including Overtime' }, outcomes: [
      { type: 'OT_YES', status: 'OPEN', participant: 'Cole Caufield', line: 1000, oddsAmerican: '195' },
      { type: 'OT_NO', status: 'OPEN', participant: 'Cole Caufield', line: 1000, oddsAmerican: '-286' }] },
  ] };
  assert.deepEqual(fb.kambiProps(kb), [
    { player: 'Jordan Kyrou', mkey: 'shots_on_goal', line: 1.5, over: -157, under: 120 },
    { player: 'Dylan Strome', mkey: 'assists', line: 0.5, over: 110, under: -159 },
  ]);
});

test('parseKambiEvent: a second-half total "including overtime" is not the game total', () => {
  const ev = { events: [{ englishName: 'Denver Broncos - Seattle Seahawks', state: 'NOT_STARTED', start: new Date(NOW + 3600e3).toISOString() }], betOffers: [
    { criterion: { englishLabel: 'Total Points - Including Overtime' }, outcomes: [{ type: 'OT_OVER', line: 43500, oddsAmerican: '-110', status: 'OPEN' }, { type: 'OT_UNDER', line: 43500, oddsAmerican: '-110', status: 'OPEN' }] },
    { criterion: { englishLabel: 'Total Points - 2nd Half - Including Overtime' }, outcomes: [{ type: 'OT_OVER', line: 19500, oddsAmerican: '-120', status: 'OPEN' }, { type: 'OT_UNDER', line: 19500, oddsAmerican: '-105', status: 'OPEN' }] },
  ] };
  const g = fb.parseKambiEvent(ev, NOW);
  assert.deepEqual(g.totals.map(t => t.point), [43.5, 43.5]);
});
