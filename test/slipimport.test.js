// MY SLIPS imports from more trackers and apps: the file's format from its
// header (or name), every leg mapped to player / stat / line / side, every row
// either read or listed with the reason, and the per-import summary.
// The files below are test fixtures built from each format's column names,
// not anyone's real bets.
const test = require('node:test');
const assert = require('node:assert');
const S = require('../slips');

const NOW = Date.parse('2026-10-26T12:00:00Z');

const JUICE = `Date,Sportsbook,Bet Type,Sport,Description,Odds,Risk,To Win,Result
2026-10-19T17:00:00Z,PrizePicks,Parlay,NFL,"Josh Allen Over 245.5 Pass Yds | James Cook Under 62.5 Rush Yds",+500,10,50,Won
2026-10-19T17:05:00Z,FanDuel,Straight,NFL,Bills -3.5 (-110),-110,22,20,Lost
2026-10-20T00:10:00Z,Underdog Fantasy,Parlay,NBA,"LeBron James Higher 25.5 Points | Anthony Davis Lower 11.5 Rebounds",+250,5,12.5,Lost`;

const BETTORIQ = `Placed,Book,Type,League,Selection,Odds,Stake,Payout,Status,CLV
10/21/2026 7:00 PM,Sleeper,Parlay,NHL,"Connor McDavid Over 1.5 Points; Leon Draisaitl Over 3.5 Shots",+180,10,28,Won,2.1%
10/22/2026 7:00 PM,Sleeper,Parlay,NHL,just a note with no pick,+180,10,0,Lost,`;

const PP_LEGS = `Entry ID,Date,Game Type,Entry Fee,Payout,Status,League,Player,Stat Type,Line,Pick
A1,2026-10-25T16:30:00Z,Power Play,10,60,Won,NFL,Josh Allen,Pass Yards,245.5,More
A1,2026-10-25T16:30:00Z,Power Play,10,60,Won,NFL,Stefon Diggs,Receiving Yards,64.5,Less
A1,2026-10-25T16:30:00Z,Power Play,10,60,Won,NFL,Bo Nix,Pass Yards,220.5,More
A2,2026-10-25T18:00:00Z,Flex Play,5,0,Lost,NBA,LeBron James,Points,25.5,More
A2,2026-10-25T18:00:00Z,Flex Play,5,0,Lost,NBA,Anthony Davis,Rebounds,,Less
A2,2026-10-25T18:00:00Z,Flex Play,5,0,Lost,NBA,Luka Doncic,Assists,8.5,Less`;

test('the format comes from the file name, Pikkit\'s own header, or one app on every row', () => {
  assert.strictEqual(S.detectImport(JUICE, 'juicereel-bets.csv').format, 'juicereel');
  assert.strictEqual(S.detectImport(JUICE, 'juicereel-bets.csv').label, 'Juice Reel CSV');
  // no name and several books: a tracker CSV, read by column name, no guess at which tracker
  assert.strictEqual(S.detectImport(JUICE, 'export.csv').format, 'csv');
  assert.strictEqual(S.detectImport(BETTORIQ, 'BettorIQ_history.csv').format, 'bettoriq');
  assert.strictEqual(S.detectImport('bet_id,sportsbook,type,status,odds,closing_line,amount,profit,time_placed,bet_info\n1,PrizePicks,parlay,SETTLED_WIN,+260,+240,10,26,2026-10-01,A Over 1.5 Hits').format, 'pikkit');
  // every row on one app: that app's own file
  const d = S.detectImport('Date,Book,Description,Stake,Status\n2026-10-20,Underdog,A Higher 1.5 Hits,5,Won\n2026-10-21,Underdog Fantasy,B Lower 2.5 Hits,5,Lost');
  assert.deepStrictEqual([d.kind, d.format, d.app], ['csv', 'underdog', 'underdog']);
  // copied text
  assert.deepStrictEqual(S.detectImport('Underdog\n3 Picks · $10 entry\nJosh Allen\nHigher 245.5 Passing Yards').format, 'underdog');
  assert.strictEqual(S.detectImport('Josh Allen\nHigher 245.5 Passing Yards').app, 'underdog');
  assert.strictEqual(S.detectImport('Josh Allen Over 245.5 Pass Yds').kind, 'text');
});

test('a Juice Reel file: bets with legs become slips, a game line is listed, not dropped', () => {
  const r = S.importText(JUICE, { now: NOW, name: 'juicereel-bets.csv', id: 'imJ' });
  assert.strictEqual(r.bets.length, 3);
  assert.strictEqual(r.rows, 3);
  assert.deepStrictEqual(r.slips.map(s => [s.app, s.legs.length, s.source, s.format, s.importId, s.result]),
    [['prizepicks', 2, 'import', 'juicereel', 'imJ', 'win'], ['underdog', 2, 'import', 'juicereel', 'imJ', 'loss']]);
  // no id column: ids from the row's content, the same on a second import, different across rows
  assert.ok(r.slips.every(s => /^jr-r[0-9a-z]+$/.test(s.id)) && r.slips[0].id !== r.slips[1].id);
  assert.deepStrictEqual(S.importText(JUICE, { now: NOW, name: 'juicereel-bets.csv' }).slips.map(s => s.id), r.slips.map(s => s.id));
  assert.deepStrictEqual(r.slips[1].legs.map(l => [l.player, l.side, l.line, l.market, l.sport]), [['LeBron James', 'Over', 25.5, 'Points', 'NBA'], ['Anthony Davis', 'Under', 11.5, 'Rebounds', 'NBA']]);
  assert.strictEqual(r.unread.length, 1);
  assert.strictEqual(r.unread[0].row, 3);
  assert.match(r.unread[0].why, /game line/);
  // the profit is the file's own: Risk 10 To Win 50 Won
  assert.strictEqual(r.bets[0].profit, 40);
  assert.strictEqual(r.bets[1].profit, -22);
});

test('a Bettor IQ file reads US dates and semicolon legs; a row with no pick says so', () => {
  const r = S.importText(BETTORIQ, { now: NOW, name: 'BettorIQ_history.csv' });
  assert.strictEqual(r.slips.length, 1);
  assert.strictEqual(r.slips[0].app, 'sleeper');
  assert.deepStrictEqual(r.slips[0].legs.map(l => [l.player, l.line, l.sport]), [['Connor McDavid', 1.5, 'NHL'], ['Leon Draisaitl', 3.5, 'NHL']]);
  assert.ok(Date.parse(r.slips[0].placedAt) > Date.parse('2026-10-21T00:00:00Z'));
  assert.deepStrictEqual(r.unread.map(u => [u.row, u.why]), [[3, "couldn't read a player, side, line and stat"]]);
});

test('an app history file with one row per leg: legs grouped by entry, More/Less column read as the side', () => {
  const d = S.detectImport(PP_LEGS, 'prizepicks-entries.csv');
  assert.strictEqual(d.format, 'prizepicks');
  const r = S.importText(PP_LEGS, { now: NOW, name: 'prizepicks-entries.csv' });
  assert.strictEqual(r.bets.length, 2);
  const [a, b] = r.slips;
  assert.deepStrictEqual([a.id, a.app, a.legs.length, a.stake, a.result, a.flex], ['pp-A1', 'prizepicks', 3, 10, 'win', false]);
  assert.deepStrictEqual(a.legs.map(l => [l.player, l.side, l.line, l.market, l.sport]), [
    ['Josh Allen', 'Over', 245.5, 'Pass Yards', 'NFL'], ['Stefon Diggs', 'Under', 64.5, 'Receiving Yards', 'NFL'], ['Bo Nix', 'Over', 220.5, 'Pass Yards', 'NFL']]);
  assert.strictEqual(b.flex, true);
  assert.strictEqual(b.legs.length, 2);
  // the leg with no line is listed by its row, not dropped
  assert.deepStrictEqual(r.unread.map(u => [u.row, u.why]), [[6, 'no line on this row']]);
  // a won power play pays the file's payout: 60 back on 10
  assert.strictEqual(r.bets[0].profit, 50);
});

test('Underdog and Sleeper history copied as text: name above the pick, entries without blank lines', () => {
  const ud = `Underdog
3 Picks · $10 entry · Paid out $65.00
Oct 19, 2026, 12:58 PM
Josh Allen
QB - BUF
Higher 245.5 Passing Yards
Final: 263
James Cook
Lower 62.5 Rushing Yards
Ja'Marr Chase
Higher 70.5 Receiving Yards
2 Picks · $5 entry
Lost
Oct 18, 2026, 7:10 PM
LeBron James
Higher 25.5 Points
Nikola Jokic
Lower 12.5 Rebounds
Who knows`;
  const r = S.importText(ud, { now: NOW });
  assert.strictEqual(r.format, 'underdog');
  assert.strictEqual(r.slips.length, 2);
  const [a, b] = r.slips;
  assert.deepStrictEqual([a.app, a.stake, a.payout, a.result, a.legs.length, a.source, a.timed], ['underdog', 10, 65, 'win', 3, 'import', true]);
  assert.deepStrictEqual(a.legs.map(l => [l.player, l.side, l.line, l.market]), [
    ['Josh Allen', 'Over', 245.5, 'Passing Yards'], ['James Cook', 'Under', 62.5, 'Rushing Yards'], ["Ja'Marr Chase", 'Over', 70.5, 'Receiving Yards']]);
  assert.deepStrictEqual([b.stake, b.result, b.legs.length], [5, 'loss', 2]);
  assert.strictEqual(new Date(b.placedAt).getDate(), 18);
  // the name left with no pick under it is listed
  assert.deepStrictEqual(r.unread.map(u => [u.row, u.text]), [[19, 'Who knows']]);
  assert.match(r.unread[0].why, /no pick under it/);

  const sl = `Sleeper Picks
$10 · 2 picks · Won $30
Oct 20, 2026, 8:15 PM
Connor McDavid Over 1.5 Points
Auston Matthews Under 3.5 Shots NHL`;
  const s2 = S.importText(sl, { now: NOW });
  assert.strictEqual(s2.format, 'sleeper');
  assert.deepStrictEqual(s2.slips.map(s => [s.app, s.stake, s.payout, s.result, s.legs.length]), [['sleeper', 10, 30, 'win', 2]]);
  assert.strictEqual(s2.unread.length, 0);
});

test('PrizePicks copied text: More/Less under the name, the play type starts a new entry', () => {
  const pp = `6x Power Play · $10 → $60
Won $60.00
Oct 19, 2026, 12:58 PM
Josh Allen
BUF - QB
vs MIA Sun 12:00pm
More 245.5 Pass Yards
Goblin
James Cook
Less 62.5 Rush Yards
3-Pick Flex Play $5 entry
Lost
LeBron James
25.5 Points More`;
  const r = S.importText(pp, { now: NOW });
  assert.strictEqual(r.slips.length, 2);
  assert.deepStrictEqual(r.slips.map(s => [s.app, s.stake, s.mult, s.flex, s.result, s.legs.length]), [['prizepicks', 10, 6, false, 'win', 2], ['prizepicks', 5, null, true, 'loss', 1]]);
  assert.deepStrictEqual(r.slips[1].legs[0], { player: 'LeBron James', side: 'Over', line: 25.5, market: 'Points', sport: null });
  assert.strictEqual(r.unread.length, 0);
  // the slip with no time shown is graded as a guess, the others at their own time
  assert.strictEqual(r.slips[1].timed, false);
});

test('a pasted slip still reads as before', () => {
  const { slips, skipped } = S.parseSlips('PrizePicks $10 to win $60\nJosh Allen Over 245.5 Pass Yds\nStefon Diggs o64.5 rec yds', { now: NOW });
  assert.strictEqual(slips.length, 1);
  assert.strictEqual(slips[0].legs.length, 2);
  assert.strictEqual(slips[0].result, undefined);
  assert.deepStrictEqual(skipped, []);
});

test('the per-import summary: matched, with a close, CLV, record, units and every unmatched row', () => {
  const r = S.importText(PP_LEGS, { now: NOW, name: 'prizepicks-entries.csv' });
  const [a, b] = r.slips;
  const g = (p, extra = {}) => ({ status: 'graded', closeFair: p, closeEv: (p / 0.5622 - 1) * 100, closeOk: true, outcome: 'win', matched: { start: '2026-10-25T17:00:00Z', sport: 'NFL' }, ...extra });
  const grades = {
    [S.legKey(a, a.legs[0])]: g(0.6, { raw: { source: 'pinnacle', ev: 4, ok: true } }),
    [S.legKey(a, a.legs[1])]: g(0.55, { outcome: 'win' }),
    [S.legKey(a, a.legs[2])]: { status: 'nohistory', reason: 'before' },
    [S.legKey(b, b.legs[0])]: { status: 'graded', outcome: 'loss', closeEv: null, matched: { start: '2026-10-25T23:00:00Z', sport: 'NBA' } },
    // b.legs[1] not answered yet
  };
  const views = r.slips.map(s => S.slipView(s, grades));
  const sum = S.importSummary(r, views, { unitUsd: 5, reasons: { before: 'the game started before this leg reached us' } });
  assert.strictEqual(sum.rows, 6);
  assert.strictEqual(sum.bets, 2);
  assert.strictEqual(sum.legs, 5);
  assert.strictEqual(sum.checked, 4);
  assert.strictEqual(sum.matched, 3);
  assert.strictEqual(sum.waiting, 1);
  assert.strictEqual(sum.withClose, 2);
  assert.strictEqual(sum.pinN, 1);
  assert.strictEqual(sum.pinEv, 4);
  // the file's own results: one win (+50), one loss (-5)
  assert.deepStrictEqual([sum.record, sum.recordBy, sum.staked, sum.profit, sum.units], ['1-1', 'file', 15, 45, 9]);
  assert.deepStrictEqual(sum.unmatched.map(u => [u.stage, u.row, u.why]), [
    ['read', 6, 'no line on this row'], ['match', null, 'the game started before this leg reached us']]);
  assert.match(sum.unmatched[1].text, /^Bo Nix Over 220.5 Pass Yards/);
  // the file's result and profit settle its slips, beside our own
  assert.deepStrictEqual([views[0].by, views[0].result, views[0].returned], ['import', 'win', 60]);
  // the user's own mark wins over the file's
  assert.deepStrictEqual([S.slipView({ ...a, result: 'loss', resultBy: 'user' }, grades).by], ['user']);
});

test('copied text with no results: the record comes from the slips our box scores settle', () => {
  const r = S.importText('Underdog\n$10 entry\n10/25 1:00pm\nA Guy Higher 1.5 Hits\nB Guy Higher 0.5 Runs', { now: NOW });
  const s = r.slips[0];
  const grades = Object.fromEntries(s.legs.map(l => [S.legKey(s, l), { status: 'graded', outcome: 'win', closeEv: 2, closeFair: 0.57, closeOk: true }]));
  const sum = S.importSummary(r, [S.slipView(s, grades)], { unitUsd: 10 });
  assert.deepStrictEqual([sum.record, sum.recordBy, sum.staked, sum.profit, sum.units], ['1-0', 'slips', 10, 25, 2.5]);
  // the request carries the slip's own time when the text showed one
  assert.strictEqual(S.gradeRequest([s])[0].betAtExact, true);
});
