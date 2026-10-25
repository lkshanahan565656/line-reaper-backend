const test = require('node:test');
const assert = require('node:assert');
const B = require('../propsboard');
const pin = require('../pinprops');
const fb = require('../freebooks');
const sg = require('../sportgrade');
const sp = require('../sportprops');
const fx = require('./fixtures/espn-box.json');

test('the apps\' NBA stat names meet on one key', () => {
  // Underdog "Regular Season ..." and PrizePicks NBASZN "Season ..." are the same season-long line
  assert.strictEqual(B.sportMarketKey('Regular Season Points Per Game', 'NBA'), B.sportMarketKey('Season Points Per Game', 'NBA'));
  assert.strictEqual(B.sportMarketKey('Double-Double', 'NBA'), 'double_double');
  assert.strictEqual(B.sportMarketKey('Double Double', 'NBA'), 'double_double');
  assert.strictEqual(B.sportMarketKey('3-PT Made', 'NBA'), 'threes');
  assert.strictEqual(B.sportMarketKey('Blks+Stls', 'NBA'), 'stocks');
  assert.strictEqual(B.sportMarketKey('FG Attempted', 'NBA'), 'fga');
  assert.strictEqual(B.sportMarketKey('Offensive Rebounds', 'NBA'), 'off_rebounds');
  assert.strictEqual(B.sportMarketKey('Personal Fouls', 'NBA'), 'fouls');
  // football's field goals stay football's
  assert.strictEqual(B.sportMarketKey('FG Made', 'NFL'), 'fg_made');
  assert.strictEqual(B.sportMarketKey('FG Made', 'NBA'), 'fgm');
});

test('Pinnacle NBA stat wording: pluses, ampersands and the long names read alike', () => {
  const k = d => pin.parseDescription(`Jayson Tatum Total ${d}`).mkey;
  assert.strictEqual(k('Pts & Rebs & Asts'), 'pra');
  assert.strictEqual(k('Pts + Rebs + Asts'), 'pra');
  assert.strictEqual(k('Points & Rebounds'), 'pts_rebs');
  assert.strictEqual(k('Pts & Asts'), 'pts_asts');
  assert.strictEqual(k('Rebs + Asts'), 'rebs_asts');
  assert.strictEqual(k('Steals & Blocks'), 'stocks');
  assert.strictEqual(k('Turnovers'), 'turnovers');
  assert.strictEqual(k('Threes Made'), 'threes');
  assert.ok(pin.LEAGUES.NBA && pin.LEAGUES.CBB);
});

test('FanDuel NBA rungs ("To Score 20+ Points", "To Record 6+ Rebounds", "3+ Made Threes") read as overs at N - 0.5', () => {
  const runner = (name, odds) => ({ runnerName: name, runnerStatus: 'ACTIVE', winRunnerOdds: { americanDisplayOdds: { americanOddsInt: odds } } });
  const mk = (type, runners) => ({ marketType: type, marketName: type, bettingType: 'ODDS', marketStatus: 'OPEN', inPlay: false, runners });
  const page = { attachments: { markets: {
    a: mk('TO_SCORE_20+_POINTS', [runner('Jalen Brunson', -440), runner('Josh Hart', 300)]),
    b: mk('TO_RECORD_6+_REBOUNDS', [runner('Josh Hart', -150)]),
    c: mk('TO_RECORD_4+_ASSISTS', [runner('Jalen Brunson', -200)]),
    d: mk('3+_MADE_THREES', [runner('Jayson Tatum', -138)]),
    e: mk('1ST_QUARTER_WINNER', [runner('Detroit Pistons', 110)]),
  } } };
  const { ladders } = fb.parseFanDuelLadders(page);
  const by = (p, m) => ladders.find(l => l.player === p && l.mkey === m);
  assert.strictEqual(by('Jalen Brunson', 'points').line, 19.5);
  assert.strictEqual(by('Josh Hart', 'points').price, 300);
  assert.strictEqual(by('Josh Hart', 'rebounds').line, 5.5);
  assert.strictEqual(by('Jalen Brunson', 'assists').line, 3.5);
  assert.strictEqual(by('Jayson Tatum', 'threes').line, 2.5);
  assert.strictEqual(ladders.length, 5);
});

test('NBA box scores grade the extra stats the apps post, and a double-double reads 0.5', () => {
  const pb = sg.parseBox(fx.NBA.box).get('paolobanchero').groups;   // 24 pts, 8 reb, 3 ast, 10-13 FG, 2-3 3P, 2-2 FT, 1 oreb, 7 dreb
  const v = m => sg.statValue('NBA', m, pb);
  assert.strictEqual(v('fgm'), 10);
  assert.strictEqual(v('fga'), 13);
  assert.strictEqual(v('threes_att'), 3);
  assert.strictEqual(v('fta'), 2);
  assert.strictEqual(v('off_rebounds'), 1);
  assert.strictEqual(v('def_rebounds'), 7);
  assert.strictEqual(v('fouls'), 0);
  assert.strictEqual(v('double_double'), 0);   // 24 points only
  const dd = { basketball: { minutes: '30', points: '22', rebounds: '11', assists: '4', steals: '1', blocks: '0', turnovers: '2' } };
  assert.strictEqual(sg.statValue('NBA', 'double_double', dd), 1);
  assert.strictEqual(sg.statValue('NBA', 'triple_double', dd), 0);
  const gradeDD = { sport: 'NBA', player: 'X', mkey: 'double_double', signalLine: 0.5, signalSide: 'Over' };
  const players = new Map([['x', { groups: dd }]]);
  assert.strictEqual(sg.gradeLeg(gradeDD, players).outcome, 'win');
  assert.ok(['double_double', 'triple_double', 'fga', 'off_rebounds'].every(m => sg.canGrade({ sport: 'NBA', mkey: m })));
});

test('a double-double is priced only at a source\'s own line', () => {
  assert.ok(sp.EXACT.has('double_double') && sp.EXACT.has('triple_double'));
});

test('Sleeper\'s spelled-out NBA combos meet the other apps\' keys, so Pinnacle can price them (opening night, 10-21)', () => {
  const k = m => B.sportMarketKey(m, 'NBA');
  assert.strictEqual(k('Points And Rebounds'), 'pts_rebs');
  assert.strictEqual(k('Points And Assists'), 'pts_asts');
  assert.strictEqual(k('Rebounds And Assists'), 'rebs_asts');
  assert.strictEqual(k('Blocks And Steals'), 'stocks');
  assert.strictEqual(k('Blocks + Steals'), 'stocks');
  // a first-quarter line keeps its period, so it never meets a full-game price
  assert.strictEqual(k('First Qtr Points'), '1q|points');
  assert.strictEqual(k('Points'), 'points');
  // men's college basketball under the names an app may use in November
  for (const n of ['NCAAM', 'NCAAMB', 'NCAA Basketball']) assert.strictEqual(B.boardSport(n).sport, 'CBB');
  assert.strictEqual(B.boardSport('NCAAM1H').prefix, '1H ');
});

test('FanDuel NBA combo rungs and the double-double markets read as overs', () => {
  const runner = (name, odds) => ({ runnerName: name, runnerStatus: 'ACTIVE', winRunnerOdds: { americanDisplayOdds: { americanOddsInt: odds } } });
  const mk = (type, runners) => ({ marketType: type, marketName: type, bettingType: 'ODDS', marketStatus: 'OPEN', inPlay: false, runners });
  const { ladders } = fb.parseFanDuelLadders({ attachments: { markets: {
    a: mk('TO_RECORD_40+_PTS_+_REB_+_AST', [runner('Anthony Edwards', 132)]),
    b: mk('TO_RECORD_25+_REB_+_AST', [runner('Josh Hart', 100)]),
    c: mk('TO_RECORD_20+_PTS_+_AST', [runner('Jalen Brunson', -110)]),
    d: mk('TO_RECORD_50+_PTS_+_REB', [runner('Karl-Anthony Towns', 900)]),
    e: mk('TO_RECORD_A_DOUBLE_DOUBLE', [runner('Bam Adebayo', 112)]),
    f: mk('TO_RECORD_A_TRIPLE_DOUBLE', [runner('Nikola Jokic', 150)]),
  } } });
  const by = (p, m) => ladders.find(l => l.player === p && l.mkey === m);
  assert.strictEqual(by('Anthony Edwards', 'pra').line, 39.5);
  assert.strictEqual(by('Josh Hart', 'rebs_asts').line, 24.5);
  assert.strictEqual(by('Jalen Brunson', 'pts_asts').line, 19.5);
  assert.strictEqual(by('Karl-Anthony Towns', 'pts_rebs').price, 900);
  assert.strictEqual(by('Bam Adebayo', 'double_double').line, 0.5);
  assert.strictEqual(by('Nikola Jokic', 'triple_double').line, 0.5);
  assert.strictEqual(ladders.length, 6);
});

test('fantasy score and double-double rows say no sharp market lists them; PrizePicks rows carry the opponent', () => {
  const t = Date.now() + 36e5;
  const iso = new Date(t).toISOString();
  const rows = B.buildRows([
    { book: 'prizepicks', sport: 'NBA', player: 'Zion Williamson', team: 'NOP', opponent: 'IND', matchTitle: 'IND', market: 'Fantasy Score', line: 38.5, startTime: iso },
    { book: 'prizepicks', sport: 'NBA', player: 'Zion Williamson', team: 'NOP', opponent: 'IND', matchTitle: 'IND', market: 'Points', line: 22.5, startTime: iso },
    { book: 'pick6', sport: 'NBA', player: 'Bam Adebayo', team: 'MIA', market: 'To Record a Double Double', line: 0.5, startTime: iso },
  ], { now: Date.now() });
  const by = m => rows.find(r => r.market === m);
  assert.strictEqual(by('Fantasy Score').noSharp, true);
  assert.strictEqual(by('To Record a Double Double').noSharp, true);
  assert.ok(!by('Points').noSharp);
  assert.strictEqual(by('Points').opponent, 'IND');
});
