const test = require('node:test');
const assert = require('node:assert');
const B = require('../propsboard');
const { parseSleeperLines, slimPlayers, sleeperSportKeys } = require('../pickem');
const { canonMarket } = require('../ev');

const soon = new Date(Date.now() + 3 * 3600e3).toISOString();
const ud = (o = {}) => ({ book: 'underdog', sport: 'NFL', player: 'Puka Nacua', team: 'LAR', market: 'Receiving Yards', line: 84.5, startTime: soon, matchTitle: 'LAR @ SF', overMultiplier: 1, underMultiplier: 1, overOpen: true, underOpen: true, ...o });
const pp = (o = {}) => ({ book: 'prizepicks', sport: 'NFL', player: 'Puka Nacua', team: 'LAR', market: 'Receiving Yards', line: 79.5, startTime: soon, ...o });
const sl = (o = {}) => ({ book: 'sleeper', sport: 'NFL', player: 'Puka Nacua', team: 'LAR', market: 'Receiving Yards', line: 82.5, startTime: '', overMultiplier: 1.8, underMultiplier: 1.9, overOpen: true, underOpen: true, ...o });

test('every book spells the same stat onto one key', () => {
  for (const [a, b] of [['Rush+Rec Yds', 'Rush + Rec Yards'], ['Hits+Runs+RBIs', 'Hits + Runs + RBIs'], ['Anytime TDs', 'Anytime TD'], ['Pass Completions', 'Completions'], ['Goalie Saves', 'Saves'], ['Pitching Outs', 'Pitching Outs Recorded'], ['INT', 'INTs Thrown']])
    assert.strictEqual(canonMarket(a), canonMarket(b), `${a} vs ${b}`);
  assert.strictEqual(B.sportMarketKey('1H Rec Yards'), B.sportMarketKey('1H Receiving Yards'));
  assert.notStrictEqual(B.sportMarketKey('1H Receiving Yards'), B.sportMarketKey('Receiving Yards'));
});

test('PrizePicks period leagues fold into their sport with the period on the stat', () => {
  assert.deepStrictEqual(B.boardSport('NFL1H'), { sport: 'NFL', prefix: '1H ' });
  assert.deepStrictEqual(B.boardSport('NHL1P'), { sport: 'NHL', prefix: '1P ' });
  assert.deepStrictEqual(B.boardSport('NBAP'), { sport: 'NBA', prefix: '' });
  assert.deepStrictEqual(B.boardSport('CS2'), { sport: 'CS', prefix: '' });
  assert.deepStrictEqual(B.boardSport('UCL'), { sport: 'SOCCER', prefix: '' });
  assert.strictEqual(B.normLine(pp({ sport: 'NFL1H' })).market, '1H Receiving Yards');
});

test('one row per player and stat, a cell per book; Sleeper borrows a start time', () => {
  const sls = B.borrowStarts([sl()], [ud()]);
  assert.strictEqual(sls[0].startTime, soon);
  const rows = B.buildRows([ud(), pp(), ...sls, pp({ sport: 'NFL1H', line: 40.5 }), ud({ startTime: new Date(Date.now() - 6e4).toISOString(), player: 'Started Guy' })]);
  assert.strictEqual(rows.length, 2);   // full game and first half; the started line is gone
  const r = rows.find(x => x.market === 'Receiving Yards');
  assert.deepStrictEqual(Object.keys(r.books).sort(), ['prizepicks', 'sleeper', 'underdog']);
  assert.deepStrictEqual([r.books.prizepicks.line, r.books.underdog.line, r.books.sleeper.line, r.books.sleeper.over], [79.5, 84.5, 82.5, 1.8]);
});

test('each book is priced at its own line off the Kalshi ladder; Sleeper net of vig', () => {
  const rows = B.buildRows([ud(), pp(), sl({ startTime: soon })]);
  const kalshi = new Map([['pukanacua|rec_yds|79.5', 0.62], ['pukanacua|rec_yds|84.5', 0.5], ['pukanacua|rec_yds|82.5', 0.53]]);
  const seen = [];
  const dfsEv = (p, book, mult, line, side) => { seen.push([book, side, line.underMultiplier]); return (p * (book === 'prizepicks' ? 1 / 0.5622 : mult) - 1) * 100; };
  B.priceRows(rows, { kalshi, dfsEv });
  const r = rows[0];
  assert.strictEqual(r.books.prizepicks.fair, 62);
  assert.strictEqual(r.books.prizepicks.ev.side, 'Over');
  assert.ok(Math.abs(r.books.prizepicks.ev.ev - 10.28) < 0.01);
  assert.strictEqual(r.best.book, 'prizepicks');
  assert.strictEqual(r.gap, 5);
  assert.ok(seen.some(([b, s, u]) => b === 'sleeper' && s === 'Over' && u === 1.9));
});

test('closed sides are never priced, and free viewers get lines without prices', () => {
  const rows = B.buildRows([ud({ underOpen: false, underMultiplier: null })]);
  B.priceRows(rows, { kalshi: new Map([['pukanacua|rec_yds|84.5', 0.3]]), dfsEv: (p, b, m) => (p * m - 1) * 100 });
  assert.strictEqual(rows[0].books.underdog.ev.side, 'Over');
  const red = B.redactRow(rows[0]);
  assert.strictEqual(red.books.underdog.ev, undefined);
  assert.strictEqual(red.books.underdog.fair, undefined);
  assert.deepStrictEqual(red.best, { locked: true });
});

test('esports rows take the model pick for each book', () => {
  const es = { book: 'underdog', sport: 'CS', player: 'donk', market: 'Kills on Maps 1+2', line: 38.5, startTime: soon, overMultiplier: 1, underMultiplier: 1 };
  const esKey = (s, m) => (/kills/i.test(m) ? 'k|1-2' : m);
  const rows = B.buildRows([es, { ...es, book: 'prizepicks', sport: 'CS2', market: 'MAPS 1-2 Kills' }], { esKey });
  assert.strictEqual(rows.length, 1);
  B.priceRows(rows, { esPicks: new Map([[rows[0].key, { side: 'OVER', prob: 60, ppEv: 6.7, udEv: 4.1, modelPred: 41.2 }]]) });
  assert.deepStrictEqual(rows[0].books.prizepicks.ev, { side: 'Over', ev: 6.7 });
  assert.strictEqual(rows[0].best.book, 'prizepicks');
  assert.strictEqual(rows[0].model.proj, 41.2);
});

test('query: sport, book, two-plus books, search and sort', () => {
  const rows = B.buildRows([ud(), pp(), ud({ player: 'Josh Allen', market: 'Pass Yards', line: 250.5 }), ud({ sport: 'NHL', player: 'Adam Fox', market: 'Shots on Goal', line: 1.5 })]);
  B.priceRows(rows, {});
  assert.strictEqual(B.queryRows(rows, { sport: 'NFL' }).length, 2);
  assert.strictEqual(B.queryRows(rows, { book: 'prizepicks' }).length, 1);
  assert.strictEqual(B.queryRows(rows, { multi: true })[0].player, 'Puka Nacua');
  assert.strictEqual(B.queryRows(rows, { q: 'allen' }).length, 1);
  assert.strictEqual(B.queryRows(rows, { sort: 'gap' })[0].gap, 5);
  assert.deepStrictEqual(B.counts(rows).books, { underdog: 3, prizepicks: 1, sleeper: 0 });
});

test('Sleeper sports lines parse with the sport and wording the other books use', () => {
  const opt = (outcome, mult) => ({ status: 'active', outcome, outcome_value: 1.5, payout_multiplier: String(mult), subject_team: 'NYR' });
  const rows = [
    { status: 'active', sport: 'nhl', subject_id: '7', subject_type: 'player', outcome_type: 'over_under', game_status: 'pre_game', wager_type: 'shots', options: [opt('over', 1.7), opt('under', 2.0)] },
    { status: 'active', sport: 'clubsoccer:epl', subject_id: '9', subject_type: 'player', outcome_type: 'over_under', game_status: 'pre_game', wager_type: 'shots', options: [opt('over', 1.7), opt('under', 2.0)] },
  ];
  const players = { nhl: slimPlayers({ 7: { first_name: 'Adam', last_name: 'Fox', team: 'NYR', age: 28, fantasy_positions: ['D'] } }), 'clubsoccer:epl': slimPlayers({ 9: { first_name: 'Bukayo', last_name: 'Saka', team: '1' } }) };
  assert.deepStrictEqual(Object.keys(players.nhl[7]).sort(), ['first_name', 'last_name', 'team']);
  assert.strictEqual(parseSleeperLines(rows, players).length, 0);   // esports only by default
  const lines = parseSleeperLines(rows, players, { sports: true });
  assert.deepStrictEqual(lines.map(l => [l.sport, l.player, l.market]), [['NHL', 'Adam Fox', 'Shots on Goal'], ['SOCCER', 'Bukayo Saka', 'Shots']]);
  assert.deepStrictEqual(sleeperSportKeys(rows), ['nhl', 'clubsoccer:epl']);
});

test('lines view: prop filter, and bettable counts only open sides on a sharp price', () => {
  const cell = (ev, extra = {}) => ({ line: 20.5, over: 1, under: 1, overOpen: true, underOpen: true, ...(ev ? { ev } : {}), ...extra });
  const rows = [
    { key: 'a', market: 'Points', player: 'A', team: '', matchTitle: '', esports: false, books: { underdog: cell({ side: 'Over', ev: 5, consensus: true }) } },
    { key: 'b', market: 'Points', player: 'B', team: '', matchTitle: '', esports: false, books: { underdog: cell({ side: 'Over', ev: 9 }) } },   // Kalshi alone
    { key: 'c', market: 'Rebounds', player: 'C', team: '', matchTitle: '', esports: false, books: { underdog: cell({ side: 'Under', ev: 4, consensus: true }, { underOpen: false }) } },
    { key: 'd', market: 'Kills', player: 'D', team: '', matchTitle: '', esports: true, books: { underdog: cell({ side: 'Under', ev: 3 }) } },
    { key: 'e', market: 'Points', player: 'E', team: '', matchTitle: '', esports: false, books: { prizepicks: cell({ side: 'Over', ev: 7, consensus: true }) } },
  ];
  const f = B.lineFacets(rows, 'underdog', 2);
  assert.equal(f.bettable, 2);
  assert.deepEqual(f.markets, [{ market: 'Points', n: 2 }, { market: 'Rebounds', n: 1 }, { market: 'Kills', n: 1 }]);
  assert.deepEqual(B.queryRows(rows, { book: 'underdog', market: 'Points' }).map(r => r.key), ['b', 'a']);
});

test('esports rows our head-to-head model prices take its fair; green (bettable) only where Pinnacle agrees', () => {
  const es = { book: 'underdog', sport: 'CS', player: 'donk', market: 'Kills on Maps 1+2', line: 38.5, startTime: soon, overMultiplier: 1, underMultiplier: 1, overOpen: true, underOpen: true };
  const esKey = (s, m) => (/kills/i.test(m) ? 'k|1-2' : m);
  const rows = B.buildRows([es, { ...es, book: 'prizepicks', sport: 'CS2', market: 'MAPS 1-2 Kills' }], { esKey });
  const pick = { side: 'OVER', prob: 60, ppEv: 6.7, udEv: 4.1, modelPred: 41.2,
    h2h: { mean: 42.1, share: 0.26, teamKills: 75.2, opp: 'cs:vitality', own: 40.3, scenarios: [{ maps: 2, weight: 1 }],
      priced: { book: 'PP', side: 'OVER', ev: 5.2, prob: 58.7, cells: { PP: { side: 'OVER', ev: 5.2, prob: 58.7, clears: false }, UD: { side: 'OVER', ev: 3.1, prob: 57.9, clears: true, sharp: { src: 'pin', prob: 57, ev: 2.4 } } } } } };
  B.priceRows(rows, { esPicks: new Map([[rows[0].key, pick]]) });
  const r = rows[0];
  assert.strictEqual(r.model.proj, 42.1);
  assert.strictEqual(r.model.h2h.share, 26);
  assert.deepStrictEqual(r.books.prizepicks.ev, { side: 'Over', ev: 5.2, fair: 58.7, h2h: true, clears: false, sharp: null });
  assert.strictEqual(r.books.underdog.ev.sharp, 57);
  assert.strictEqual(r.best.source, 'h2h');
  assert.strictEqual(r.best.clears, false);   // the best EV is the model alone
  assert.equal(B.lineFacets(rows, 'prizepicks', 2).bettable, 0);
  assert.equal(B.lineFacets(rows, 'underdog', 2).bettable, 1);
});
