// The weekly record digest (digest.js): built from the same strict record as
// RESULTS and the sales page, per kind and venue, with the week's graded games,
// the move toward the 50 bar and what became proven or started losing.
const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../digest');
const claims = require('../claims');

const WEEK = '2026-10-19';                  // Monday
const W0 = Date.parse(`${WEEK}T00:00:00Z`);
// one closed main line per game: CLV in percent, a 50% close at 2.1
const evRow = (i, { book = 'fanduel', start, clv = 3, win = i % 2 === 0 } = {}) => ({
  id: `${book}-${i}`, group: `g${book}${i}`, side: 'A', book, sport: 'nfl', event: `A${i} @ B${i}`, market: 'h2h', status: 'closed', closeOk: true,
  flaggedAt: new Date(Date.parse(start) - 3 * 3600e3).toISOString(), start, decimal: 2.1, clv: clv + (i % 3) * 0.2, closeFair: 50, outcome: win ? 'win' : 'loss',
});
const at = (dayFrom, i) => new Date(dayFrom + i * 3600e3 * 5).toISOString();

function lists() {
  const ev = [];
  // FanDuel: 40 graded before the week, 15 in it, all well ahead of the close → proven this week
  for (let i = 0; i < 40; i++) ev.push(evRow(i, { start: at(W0 - 20 * 86400e3, i) }));
  for (let i = 40; i < 55; i++) ev.push(evRow(i, { start: at(W0 + 86400e3, i - 40) }));
  // Kalshi-style losing book (BetRivers here): 20 graded in the week, all behind the close
  for (let i = 0; i < 20; i++) ev.push(evRow(i, { book: 'betrivers', clv: -4, start: at(W0 + 2 * 86400e3, i) }));
  // a game next week does not count in this one
  ev.push(evRow(99, { start: new Date(W0 + 8 * 86400e3).toISOString() }));
  return { ev, alt: [], stale: [], esports: [], props: [], bigMoney: [] };
}

test('weeks run Monday 00:00 UTC to Monday, and the send is Monday 13:00 UTC for the week just ended', () => {
  assert.equal(D.weekId(Date.parse('2026-10-25T23:59:00Z')), '2026-10-19', 'Sunday night is still the week of the 19th');
  assert.equal(D.weekId(Date.parse('2026-10-26T00:00:00Z')), '2026-10-26');
  assert.equal(D.dueWeek(Date.parse('2026-10-26T13:00:00Z')), '2026-10-19');
  assert.equal(new Date(D.sendAt('2026-10-19')).toISOString(), '2026-10-26T13:00:00.000Z');
  assert.equal(D.weekName('2026-10-19'), 'Oct 19 to 25');
  assert.equal(D.weekName('2026-10-26'), 'Oct 26 to Nov 1');
  assert.ok(D.validWeek('2026-10-19'));
  assert.ok(!D.validWeek('2026-10-20'), 'a Tuesday is not a week');
  assert.ok(!D.validWeek('../etc'));
});

test('per kind and venue: the week, the move toward 50, all time, and what became proven or started losing', () => {
  const d = D.build({ lists: lists(), week: WEEK, now: Date.parse('2026-10-26T13:00:00Z') });
  assert.equal(d.partial, false);
  const fd = d.rows.find(r => r.book === 'fanduel'), br = d.rows.find(r => r.book === 'betrivers');
  assert.equal(fd.week.graded, 15);
  assert.deepEqual([fd.bar.before, fd.bar.after, fd.bar.target], [40, 55, 50]);
  assert.equal(fd.labelBefore, 'building', '40 of 50, ahead of the close');
  assert.equal(fd.all.label, 'proven');
  assert.equal(fd.change, 'newly proven');
  assert.equal(fd.bar.move, 'toward');
  assert.equal(br.week.graded, 20);
  assert.equal(br.all.label, 'losing to the close');
  assert.equal(br.change, 'newly losing to the close');
  assert.equal(d.summary.graded, 35, 'the game next week is not in it');
  assert.deepEqual(d.summary.newlyProven, ['Main lines vs the sharp fair · FanDuel']);
  assert.deepEqual(d.summary.newlyFailed, ['Main lines vs the sharp fair · BetRivers']);
  assert.equal(d.summary.proven.length, 1);
  // the same label RESULTS gives the same record as of the week's end
  const rec = claims.publicRecord({ board: require('../closeboard').scoreboard(D.cut(lists(), 0, W0 + D.WEEK)) });
  assert.equal(rec.rows.find(r => r.book === 'fanduel').label, fd.all.label);
  // the tags are the record's own, unchanged
  assert.deepEqual(d.labels, rec.labels);
  // a 28-27 record with units that don't clear chance is not a profit
  assert.equal(fd.all.profitShown, false);
  assert.equal(fd.week.profitShown, false);
  assert.equal(d.summary.proven[0].units, null, 'no units said where no profit is shown');
});

test('the week so far is partial and counts only games already started', () => {
  const now = W0 + 1.5 * 86400e3;
  const d = D.build({ lists: lists(), week: null, now });
  assert.equal(d.week, WEEK);
  assert.equal(d.partial, true);
  assert.ok(d.rows.every(r => r.week.graded <= 15));
  assert.equal(d.rows.find(r => r.book === 'betrivers'), undefined, 'BetRivers games start on day 3');
});

test('the push says the week, what is proven, what changed, and links the share page; no sizing or advice', () => {
  const d = D.build({ lists: lists(), week: WEEK, now: Date.parse('2026-10-26T13:00:00Z') });
  const txt = D.pushText(d, { origin: 'https://example.test' });
  const lines = txt.split('\n');
  assert.match(lines[0], /^Week of Oct 19 to 25: 35 games graded across 2 kinds and venues\.$/);
  assert.match(lines[1], /^Proven: Main lines vs the sharp fair · FanDuel \(55 graded, CLV \+/);
  assert.match(lines[2], /Newly proven: Main lines vs the sharp fair · FanDuel\. Newly losing to the close: Main lines vs the sharp fair · BetRivers\./);
  assert.equal(lines[3], 'https://example.test/digest/2026-10-19');
  assert.doesNotMatch(txt, /\bbet (this|now)|stake|kelly|\$\d|units?\b/i);
  const n = require('../push').toNotification(txt, 'Weekly record');
  assert.equal(n.url, 'https://example.test/digest/2026-10-19');
  assert.equal(n.title, 'Weekly record');
  const empty = D.build({ lists: {}, week: WEEK, now: Date.parse('2026-10-26T13:00:00Z') });
  assert.match(D.pushText(empty), /0 games graded[\s\S]*Proven: nothing yet\.[\s\S]*Newly proven: none/);
});

test('the share page claims proven only where the record does, escapes text, and says frozen or rebuilt', () => {
  const d = D.build({ lists: lists(), week: WEEK, now: Date.parse('2026-10-26T13:00:00Z') });
  const html = D.renderPage(d, { origin: 'https://example.test', frozen: true, sentAt: '2026-10-26T13:00:05Z' });
  assert.match(html, /Week of Oct 19 to 25/);
  assert.match(html, /Published 2026-10-26 13:00 UTC and frozen/);
  assert.match(html, /NEWLY PROVEN/);
  assert.match(html, /profit not shown yet/);
  assert.match(html, /LOSING TO THE CLOSE/);
  assert.match(html, /<link rel="canonical" href="https:\/\/example.test\/digest\/2026-10-19">/);
  assert.equal((html.match(/class="lab" style="color:#34d399">PROVEN</g) || []).length, 1, "one PROVEN label, the FanDuel row");
  assert.doesNotMatch(html, /guaranteed|risk[- ]free|undefined|NaN/i);
  const evil = { ...d, rows: [{ ...d.rows[0], kindLabel: '<script>x</script>' }] };
  assert.doesNotMatch(D.renderPage(evil), /<script>x/);
  assert.match(D.renderPage(d, { frozen: false }), /Rebuilt from the record/);
});
