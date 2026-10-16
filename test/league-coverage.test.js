const test = require('node:test');
const assert = require('node:assert');
const pinextra = require('../pinextra');
const kxextra = require('../kxextra');
const pinprops = require('../pinprops');
const propsBoard = require('../propsboard');
const sportProps = require('../sportprops');

const NOW = Date.parse('2026-10-15T03:00:00Z');
const START = '2026-10-15T04:30:00Z';

// Svitolina v Guo as Pinnacle's guest feed lists it (2026-10-15)
const tennisMu = [
  { id: 1, type: 'matchup', units: 'Sets', bestOfX: 3, startTime: START, parentId: null,
    participants: [{ alignment: 'home', name: 'Elina Svitolina' }, { alignment: 'away', name: 'Hanyu Guo' }] },
  { id: 2, type: 'matchup', units: 'Games', startTime: START, parentId: 1,
    participants: [{ alignment: 'home', name: 'Elina Svitolina (Games)' }, { alignment: 'away', name: 'Hanyu Guo (Games)' }] },
  { id: 3, type: 'matchup', units: 'Sets', bestOfX: 3, startTime: START, parentId: null,
    participants: [{ alignment: 'home', name: 'Harrison C / Skupski N' }, { alignment: 'away', name: 'Schnaitter J / Wallner M' }] },
];
const ou = (points, o, u) => [{ designation: 'over', points, price: o }, { designation: 'under', points, price: u }];
const tennisMk = [
  { matchupId: 2, type: 'total', period: 0, prices: ou(18, -106, -106) },
  { matchupId: 2, type: 'total', period: 0, prices: ou(18.5, 113, -130) },
  { matchupId: 2, type: 'total', period: 1, prices: ou(8.5, -124, 106) },
  { matchupId: 2, type: 'team_total', period: 0, side: 'home', prices: ou(12.5, 172, -200) },
  { matchupId: 2, type: 'team_total', period: 0, side: 'away', prices: ou(6.5, 113, -134) },
  { matchupId: 2, type: 'spread', period: 0, prices: [{ designation: 'home', points: -6.5, price: -108 }, { designation: 'away', points: 6.5, price: -104 }] },
  { matchupId: 1, type: 'moneyline', period: 0, prices: [{ designation: 'home', price: -902 }, { designation: 'away', price: 665 }] },
  { matchupId: 1, type: 'spread', period: 0, prices: [{ designation: 'home', points: -1.5, price: -273 }, { designation: 'away', points: 1.5, price: 237 }] },
  { matchupId: 1, type: 'total', period: 0, prices: ou(2.5, 317, -374) },
  { matchupId: 3, type: 'total', period: 0, prices: ou(2.5, 200, -250) },
];

test('Pinnacle tennis markets become per-player pick\'em quotes, alternates included', () => {
  const qs = pinextra.parseTennis(tennisMu, tennisMk, NOW);
  const get = (who, mkey, line) => qs.find(q => q.key === `TENNIS|${who}|${mkey}` && q.line === line);
  assert.ok(get('elinasvitolina', 'games_played', 18) && get('hanyuguo', 'games_played', 18.5));
  assert.strictEqual(get('hanyuguo', 'games_played', 18).pOver, 0.5);
  assert.ok(get('elinasvitolina', '1st_set_games_played', 8.5).pOver > 0.5);
  assert.ok(get('elinasvitolina', 'games_won', 12.5).pOver < 0.4);
  assert.ok(!get('elinasvitolina', 'games_won', 6.5) && get('hanyuguo', 'games_won', 6.5));
  // moneyline → sets won over 1.5; +1.5 sets → sets won over 0.5 for the underdog
  assert.ok(get('elinasvitolina', 'sets_won', 1.5).pOver > 0.85);
  const guoSet = get('hanyuguo', 'sets_won', 0.5).pOver;
  assert.ok(guoSet > 0.2 && guoSet < 0.35, `${guoSet}`);
  assert.ok(get('hanyuguo', 'sets_played', 2.5).pOver < 0.3);
  // the games handicap isn't a pick'em stat; doubles never match a player
  assert.ok(!qs.some(q => q.mkey === 'spread' || /skupski/.test(q.key)));
});

test('Pinnacle total rounds become Fight Time minutes for both fighters', () => {
  const mu = [{ id: 9, type: 'matchup', startTime: '2026-10-17T22:00:00Z', participants: [{ name: 'Steven Koslow' }, { name: 'Chad Anheliger' }] }];
  const mk = [{ matchupId: 9, type: 'total', period: 0, prices: ou(1.5, -191, 155) }];
  const qs = pinextra.parseMma(mu, mk, NOW);
  assert.deepStrictEqual(qs.map(q => [q.key, q.line]), [['MMA|stevenkoslow|fight_time', 7.5], ['MMA|chadanheliger|fight_time', 7.5]]);
  assert.ok(qs[0].pOver > 0.6 && qs[0].pOver < 0.66);
});

const mkt = (title, yes, bid, ask, extra = {}) => ({ title, yes_sub_title: yes, yes_bid_dollars: String(bid), yes_ask_dollars: String(ask), status: 'active', expected_expiration_time: '2026-10-18T00:00:00Z', ...extra });

test('Kalshi UFC method, round and distance markets price knockouts, finishes, round finishes and fight time', () => {
  const t = 'Cody Chovancek vs Soyoung You';
  const events = [
    { series: 'KXUFCMOV', ev: { title: `${t}: Method of Victory`, markets: [
      mkt('Cody Chovancek wins by KO/TKO/DQ?', 'Cody Chovancek by KO/TKO/DQ', 0.30, 0.33),
      mkt('Cody Chovancek wins by Submission?', 'Cody Chovancek by Submission', 0.10, 0.12),
      mkt('Soyoung You wins by KO/TKO/DQ?', 'Soyoung You by KO/TKO/DQ', 0.02, 0.38),   // wide: not a price
    ] } },
    { series: 'KXUFCVICROUND', ev: { title: 'Cody Chovancek vs. Soyoung You: Round of Victory', markets: [mkt('Will ... Round 1', 'Cody Chovancek to win in Round 1', 0.18, 0.21)] } },
    { series: 'KXUFCDISTANCE', ev: { title: `${t}: Go the Distance`, markets: [mkt('Fight goes the distance?', 'Fight goes the distance', 0.50, 0.54)] } },
    { series: 'KXUFCDISTANCE', ev: { title: 'Mike Malott vs Joaquin Buckley: Go the Distance', markets: [mkt('Fight goes the distance?', 'Fight goes the distance', 0.40, 0.44)] } },
    { series: 'KXUFCVICROUND', ev: { title: 'Mike Malott vs. Joaquin Buckley: Round of Victory', markets: [mkt('x', 'Mike Malott to win in Round 5', 0, 0.1)] } },
  ];
  const qs = kxextra.quotesFromEvents(events, kxextra.DEFAULTS, NOW);
  const get = (k, line) => qs.find(q => q.key === k && (line == null || q.line === line));
  assert.strictEqual(get('MMA|codychovancek|knockouts').pOver, 0.315);
  assert.strictEqual(get('MMA|codychovancek|finishes').pOver, 0.425);
  assert.ok(!get('MMA|soyoungyou|knockouts'));
  assert.strictEqual(get('MMA|codychovancek|1st_round_finish').pOver, 0.195);
  assert.strictEqual(get('MMA|soyoungyou|fight_time', 14.99).pOver, 0.52);
  // a fight with round 4 and 5 markets is a five-rounder: the distance is 25 minutes
  assert.ok(get('MMA|mikemalott|fight_time', 24.99) && !get('MMA|mikemalott|fight_time', 14.99));
});

test('Kalshi NASCAR top-N prices Finishing Position at N + 0.5 for that race only', () => {
  const ev = { title: 'NASCAR Freeway Insurance 500: Top 5 Finishers', markets: [
    mkt('Cup Series: Brad Keselowski to finish in the top 5', 'Brad Keselowski', 0.13, 0.14, { expected_expiration_time: '2026-10-19T01:00:00Z' })] };
  const qs = kxextra.quotesFromEvents([{ series: 'KXNASCARTOP5', ev }], kxextra.DEFAULTS, NOW);
  assert.strictEqual(qs[0].key, 'MOTORSPORTS|bradkeselowski|finishing_position');
  assert.strictEqual(qs[0].line, 5.5);
  assert.strictEqual(qs[0].pOver, 0.865);
  const idx = kxextra.indexQuotes(qs);
  const row = { key: qs[0].key, startTime: '2026-10-18T19:00:00Z' };
  assert.ok(kxextra.quoteAt(idx, row, 5.5));
  assert.strictEqual(kxextra.quoteAt(idx, row, 10.5), null);
  // a truck race two days earlier is a different event
  assert.strictEqual(kxextra.quoteAt(idx, { ...row, startTime: '2026-10-16T23:00:00Z' }, 5.5), null);
});

test('the apps\' names for one tennis, fight or soccer stat share a key', () => {
  const k = (m, s) => propsBoard.sportMarketKey(m, s);
  assert.strictEqual(k('Total Games', 'TENNIS'), k('Games Played', 'TENNIS'));
  assert.strictEqual(k('Total Games Won', 'TENNIS'), k('Games Won', 'TENNIS'));
  assert.strictEqual(k('1st Set Total Games', 'TENNIS'), '1st_set_games_played');
  assert.strictEqual(k('Fight Time (Mins)', 'MMA'), k('Fight Time', 'MMA'));
  assert.strictEqual(k('Knockout Win', 'MMA'), 'knockouts');
  assert.strictEqual(k('Shots', 'SOCCER'), 'shots_attempted');
  assert.strictEqual(k('Shots', 'NHL'), 'shots');
  const rows = propsBoard.buildRows([
    { book: 'prizepicks', sport: 'TENNIS', player: 'Elina Svitolina', market: 'Total Games', line: 18.5, startTime: START },
    { book: 'underdog', sport: 'TENNIS', player: 'Elina Svitolina', market: 'Games Played', line: 18.5, startTime: START, overMultiplier: 1.05, underMultiplier: 0.94 },
  ], { now: NOW });
  assert.strictEqual(rows.length, 1);
});

test('quoteFor takes the Pinnacle line nearest the apps\', and an exact stat is priced only at a line a source sits on', () => {
  const qs = pinextra.parseTennis(tennisMu, tennisMk, NOW);
  const idx = pinprops.indexProps(qs);
  const row = { key: 'TENNIS|elinasvitolina|games_played', sport: 'TENNIS', mkey: 'games_played', startTime: '2026-10-15T04:00:00Z', books: { underdog: { line: 18.5 } } };
  assert.strictEqual(pinprops.quoteFor(idx, row).line, 18.5);
  assert.strictEqual(pinprops.quotesForGame(idx, row).length, 2);
  const set = { key: 'TENNIS|elinasvitolina|1st_set_games_played', sport: 'TENNIS', mkey: '1st_set_games_played', startTime: START, books: {} };
  const pin = pinprops.quotesForGame(idx, set);
  assert.ok(sportProps.fairFor(set, 'underdog', 8.5, { pin }));
  assert.strictEqual(sportProps.fairFor(set, 'underdog', 9.5, { pin }), null);
  // a count stat still reads another line off the curve
  assert.ok(sportProps.fairFor(row, 'prizepicks', 19.5, { pin: pinprops.quotesForGame(idx, row) }));
});

test('coverage counts each app leg by what prices it and marks stats nothing sharp lists', () => {
  const rows = [
    { sport: 'NFL', mkey: 'rec_yds', market: 'Receiving Yards', nBooks: 2, pinnacle: { line: 50.5 }, books: { underdog: { line: 50.5 }, prizepicks: { line: 49.5 } } },
    { sport: 'MMA', mkey: 'knockouts', market: 'Knockouts', nBooks: 1, books: { underdog: { line: 0.5, fair: 31.5 } } },
    { sport: 'MMA', mkey: 'significant_strikes', market: 'Significant Strikes', nBooks: 2, books: { underdog: { line: 33.5 }, prizepicks: { line: 33.5 } } },
    { sport: 'NHL', mkey: 'shots_on_goal', market: 'Shots On Goal', nBooks: 1, sharpBooks: ['fanduel'], books: { underdog: { line: 2.5 } } },
    { sport: 'CS', esports: true, mkey: 'k', books: { underdog: { line: 30 } } },
  ];
  const c = propsBoard.coverage(rows);
  assert.deepStrictEqual(c.total, { legs: 6, sharp: 3, pinnacle: 2, kalshi: 1, books: 1, apps: 2, none: 0, bookFair: 0, bookCons: 0 });
  assert.strictEqual(c.leagues.MMA.sharp, 1);
  assert.strictEqual(c.byApp.prizepicks.MMA.apps, 1);
  assert.strictEqual(c.markets.find(m => m.mkey === 'significant_strikes').never, true);
  assert.strictEqual(c.markets.find(m => m.mkey === 'knockouts').never, false);
  assert.ok(!c.leagues.CS);
});
