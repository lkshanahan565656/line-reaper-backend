// MY SLIPS paste reader and importer against shapes taken from public pages
// (test/fixtures/slip-formats.js names each page). TEST DATA ONLY.
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../slips');
const F = require('./fixtures/slip-formats');
const NOW = Date.parse('2026-10-27T12:00:00Z');
const legsOf = r => r.slips.flatMap(s => s.legs.map(l => `${l.player}|${l.side}|${l.line}|${l.market}`));

test('PrizePicks pick card: the "Player Pick" label is the app\'s own, not an unread line', () => {
  const r = S.importText(F.prizepicksCard.picked, { now: NOW });
  assert.deepEqual(legsOf(r), ['Devin Booker|Over|21.5|Points']);
  assert.deepEqual(r.unread, []);
});

test('a card copied off the board with both Less and More is left out and says why', () => {
  const r = S.importText(F.prizepicksCard.bothSides, { now: NOW });
  assert.deepEqual(legsOf(r), [], 'never guess the side');
  assert.equal(r.unread.length, 1);
  assert.match(r.unread[0].why, /both More and Less/);
  assert.match(r.unread[0].why, /Keep only the side you picked/);
});

test('every PrizePicks NBA stat name reads, typed or one piece a line', () => {
  for (const st of F.prizepicksNbaStats.stats) {
    assert.deepEqual(legsOf(S.importText(`PrizePicks\nJalen Brunson More 4.5 ${st}\nJosh Hart Less 4.5 ${st}`, { now: NOW })), [`Jalen Brunson|Over|4.5|${st}`, `Josh Hart|Under|4.5|${st}`], st);
    assert.deepEqual(legsOf(S.importText(`Jalen Brunson\nMore\n4.5\n${st}\nJosh Hart\nLess\n4.5\n${st}`, { now: NOW })), [`Jalen Brunson|Over|4.5|${st}`, `Josh Hart|Under|4.5|${st}`], st);
  }
});

test('Sleeper cards: "QB•DAL", "vs New York", line, stat, more/less', () => {
  const r = S.importText(F.sleeperCards.text, { now: NOW });
  assert.equal(r.app, 'sleeper');
  assert.deepEqual(legsOf(r), ['Pat Quarterback|Over|1.5|Pass TDs', 'Ray Runner|Under|39.5|Rec Yds', 'Will Receiver|Over|0.5|Anytime TDs']);
  assert.deepEqual(r.unread, []);
});

test('a share link says the picks are not in a link, never "nothing found" alone', () => {
  const r = S.importText(F.shareLink, { now: NOW });
  assert.deepEqual(r.slips, []);
  assert.equal(r.unread.length, 1);
  assert.match(r.unread[0].why, /share link/);
  assert.equal(r.unread[0].row, 1);
});

test('each unread line names what is missing, in plain words', () => {
  const why = t => S.importText(t, { now: NOW }).unread.map(u => u.why);
  assert.match(why('Josh Allen\n245.5\nPass Yards')[0], /Josh Allen: read "245.5 Pass Yards" but no More or Less/);
  assert.match(why('Josh Allen\nMore\nPass Yards\nBo Nix More 220.5 Pass Yds')[0], /Josh Allen: read "Over Pass Yards" but no line, so this pick was left out/);
  assert.match(why('Josh Allen\nBo Nix More 220.5 Pass Yds')[0], /a player's name with no pick under it/);
  assert.match(why('Bo Nix More 220.5 Pass Yds\nMore')[0], /"More" with no player above it/);
  assert.match(why('Bo Nix More 220.5 Pass Yds\n245.5 Pass Yards')[0], /a line and a stat with no player above it/);
  assert.match(why('Bo Nix More 220.5 Pass Yds\n$$$ lol ###')[0], /not a pick/);
  // parseSlips keeps its plain list of skipped lines next to the reasons
  const p = S.parseSlips('Josh Allen\nBo Nix More 220.5 Pass Yds', { now: NOW });
  assert.deepEqual(p.skipped, ['Josh Allen']);
  assert.equal(p.unread[0].text, 'Josh Allen');
});

test('SharpSports-shaped rows: bookDescription, outcome next to status, halfwin', () => {
  const r = S.importText(F.sharpsportsCsv.rowsPerBet, { now: NOW });
  assert.equal(r.kind, 'csv');
  assert.deepEqual(r.bets.map(b => [b.status, b.legs.length]), [['loss', 0], ['win', 1], ['open', 1]], 'the outcome column wins over status completed');
  assert.equal(r.bets[1].odds.toFixed(4), (1 + 100 / 115).toFixed(4), 'oddsAmerican');
  assert.equal(r.unread.length, 1);
  assert.match(r.unread[0].why, /game line/);
  assert.equal(r.unread[0].text, 'Miami Dolphins at Kansas City Chiefs - Spread - Miami Dolphins +4.5');
});

test('SharpSports-shaped leg rows: player, metricSpecial, position Over/Under, line', () => {
  const r = S.importText(F.sharpsportsCsv.rowsPerLeg, { now: NOW });
  assert.deepEqual(r.bets.map(b => [b.status, b.legs.map(l => `${l.player}|${l.side}|${l.line}|${l.market}`)]),
    [['win', ['Josh Allen|Over|245.5|Passing Yards', 'James Cook|Under|62.5|Rushing Yards']], ['loss', []]]);
  assert.equal(r.slips.length, 1);
  assert.equal(r.unread.length, 1);
  assert.equal(r.unread[0].row, 4);
  assert.match(r.unread[0].why, /the side reads "Denver Broncos"/);
});

test('a roster "Position" column is not read as the side', () => {
  const r = S.importText('Date,Player,Position,Stat,Pick,Line,Entry Fee\n2026-10-25,Josh Allen,QB,Pass Yards,More,245.5,10', { now: NOW });
  assert.deepEqual(legsOf(r), ['Josh Allen|Over|245.5|Pass Yards']);
});
